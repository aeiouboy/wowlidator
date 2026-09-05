/**
 * Step-level data locks — parallelism without flagging whole flows
 * (2026-08-31, replacing the case-level rule of docs/parallel-run-spec.md §2.2).
 *
 * **What changed and why.** The section rule asked one question per CASE —
 * "does this flow write, and where?" — and answered it before the flow ran a
 * step. Measured on be100-rip (2026-08-31): every case in the catalog ends up
 * on `/en/admin/benefits/plans`, so every writer carried the same section,
 * `compatibleCases` was false for every writer pair, and a 12-lane pool
 * produced three verdicts in twelve minutes. The flag was drawn around the
 * whole flow, but the conflict lives in a handful of steps: a case spends most
 * of its wall clock signing in and navigating — work that conflicts with
 * nothing — and only its middle actually touches the data.
 *
 * So nothing is flagged any more. Every case is dispatched the moment a lane
 * is free, and the serialisation moves INSIDE the run: a case takes the lock
 * on a data section when it reaches the first step that changes that data, and
 * gives it back at the last step that still needs that change to hold. Sign-in,
 * navigation, reads and the tail run in parallel across every lane; only the
 * change-and-verify span is exclusive, and only against the sections it names.
 *
 * Three properties this design holds on to, each the reason for a rule below:
 *
 * - **Deadlock-free by construction.** Overlapping windows are merged into
 *   maximal, non-overlapping intervals whose sections are unioned, so a lane
 *   never asks for a lock while holding one. No hold-and-wait, no cycle.
 * - **The safe direction stays safe.** A change whose location is unknown, and
 *   a delete anywhere, take the reserved section `*`, which intersects every
 *   other — the same conservatism `isGloballyExclusive` had, narrowed from the
 *   whole case to the span that actually needs it.
 * - **Sign-in is not a data change.** A password typed on a login page moves no
 *   application data. Every flow does it, and treating it as the start of a
 *   window would serialise the one thing every lane can safely share.
 *
 * `WOWLIDATOR_DATA_LOCKS=off` restores case-level flagging (`sections.ts`).
 * Pure functions plus one small lock; `tests/data-locks.test.ts` pins the rules
 * at the unit tier, since nothing here needs a browser or a model.
 */

import type { Flow, FlowStep } from '../engine/runner.js';
import { GLOBAL_SECTION, routeSectionOf, expandSections } from './sections.js';

/** `WOWLIDATOR_DATA_LOCKS=off` restores the case-level writer flag. */
export function dataLocksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['WOWLIDATOR_DATA_LOCKS'] ?? '').trim().toLowerCase() !== 'off';
}

/** Actions that put a value into the page — where a data change begins. */
// `upload` is an input: a bulk-import CSV changes the table under test just
// as a keyed field does (BE PL_10_*, RU_09_* — 44 import cases).
const INPUT_ACTIONS = new Set(['fill', 'type', 'selectOption', 'check', 'uncheck', 'fillEach', 'fillRetry', 'upload']);

/** Actions that assert something, and therefore still NEED a change to hold. */
const ASSERTION_PREFIX = /^(expect|snapshot$)/;

const READ_ONLY_VERBS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Change talk in a workflow goal — the only prose read here. The English
 * half is word-bounded; the Thai half (CG-16) is a bare alternation, since
 * `\b` never matches around Thai and a goal like "สร้าง Plan แล้วบันทึก"
 * opened no window at all — the case ran unlocked beside the reader counting
 * the same table. `บันทึกค่า`/`บันทึกว่า` (record the value shown) and
 * `เพิ่มเติม` (additional) are excluded, the same two OA-13 excludes.
 */
const WRITE_VERB =
  /\b(creat(e|es|ing)|add(s|ing)?|edit(s|ing)?|updat(e|es|ing)|chang(e|es|ing)|sav(e|es|ing)|submit(s|ting)?|insert(s|ing)?|delet(e|es|ing)|remov(e|es|ing)|cancel(s|ling|ing)?)\b|สร้าง|เพิ่ม(?!เติม)|บันทึก(?!ค่า|ว่า)|อนุมัติ|ปฏิเสธ|ยื่น|ส่ง(?:คำขอ|อนุมัติ)?|ลบ|แก้ไข|นำเข้า|นำออก|ยกเลิก/iu;
const DELETE_VERB = /\b(delet(e|es|ing)|remov(e|es|ing)|purg(e|es|ing)|drop(s|ping)?)\b|ลบ|นำออก/iu;

/** Sentinel for "the page we are on is a sign-in screen", which owns no data. */
const LOGIN = Symbol('login');

/** One exclusive span of a flow: hold `sections` from `from` until `to` ends. */
export interface DataWindow {
  /** The step at which the lock is taken, by object identity. */
  from: FlowStep;
  /** The last step that needs the lock; it is released after this one runs. */
  to: FlowStep;
  sections: string[];
  /** The wildcard came only from an agent leg whose live route was unknowable before it ran. */
  deferred: boolean;
}

/** Every step a run will execute, in order, with `when` branches inlined. */
function flatten(list: readonly FlowStep[]): FlowStep[] {
  return list.flatMap((step) =>
    step.action === 'when' ? [step, ...flatten(step.then), ...flatten(step.else ?? [])] : [step],
  );
}

function urlOf(step: FlowStep): string | null {
  const url = (step as { url?: unknown }).url;
  if (typeof url === 'string' && url !== '') return url;
  const path = (step as { path?: unknown }).path;
  return typeof path === 'string' && path !== '' ? path : null;
}

/** Does this step change stored application data? */
function mutates(step: FlowStep): boolean {
  if (INPUT_ACTIONS.has(step.action)) return true;
  if (step.action === 'request') {
    return !READ_ONLY_VERBS.has(((step as { method?: string }).method ?? 'GET').toUpperCase());
  }
  if (step.action === 'workflow') return WRITE_VERB.test((step as { goal: string }).goal);
  // A bare `click` is ambiguous — a submit and a sort look identical from here.
  // It never OPENS a window (that would put every navigation click in one);
  // inside a window it is covered already, because the window spans to the
  // last step on the section.
  return false;
}

/** Does this step still need an earlier change to hold — an assertion or a wait? */
function reads(step: FlowStep): boolean {
  return ASSERTION_PREFIX.test(step.action) || step.action === 'waitFor' || step.action === 'dbSnapshot';
}

function deletes(step: FlowStep): boolean {
  if (step.action === 'request') return ((step as { method?: string }).method ?? 'GET').toUpperCase() === 'DELETE';
  if (step.action === 'workflow') return DELETE_VERB.test((step as { goal: string }).goal);
  return false;
}

/**
 * The sections a step touches, given where the run currently is.
 *
 * A `table:` names its own section outright. Everything else belongs to the
 * page it happens on — which is why the walk carries the last `goto` forward:
 * the steps that edit a plan carry no URL of their own, and the route they are
 * on is the only evidence of which data they move.
 */
function touched(step: FlowStep, place: string | typeof LOGIN | null): string[] {
  const out = new Set<string>();
  const table = (step as { table?: unknown }).table;
  if (typeof table === 'string' && table !== '') out.add(`table:${table.toLowerCase()}`);
  const own = urlOf(step) === null ? null : routeSectionOf(urlOf(step)!);
  if (own !== null) out.add(own);
  else if (typeof place === 'string') out.add(place);
  return [...out];
}

/**
 * The exclusive span of one flow: from the first step that changes data to the
 * last step that still needs that change to hold.
 *
 * One span, not several, and the reason is the deadlock rule at the top of this
 * file: a lane that acquires once and releases once can never be holding a lock
 * while it waits for another, so no cycle can form. Splitting a flow into
 * several spans would buy a little more overlap and buy back hold-and-wait,
 * which is the one bug a test scheduler must not have.
 *
 * Both ends are earned, and that is where the parallelism comes from:
 * - the span **starts late** — sign-in and the navigation to the page are
 *   before the first change, and every lane does them at once;
 * - the span **ends early** — at the last check or change, so a trailing
 *   close/screenshot/goto is not holding the section anyone else is waiting on;
 * - a teardown that puts the row back is a change, so it is inside the span:
 *   releasing before the restore would show another lane the dirty state.
 *
 * The sections held are the union of everything touched between those two
 * points, which is what makes a route and a table that belong to the same
 * change one lock rather than two that miss each other.
 */
export function dataWindows(
  flow: Flow,
  fkPairs: readonly (readonly [string, string])[] = [],
  env: NodeJS.ProcessEnv = process.env,
): DataWindow[] {
  const steps = flatten([...(flow.setup ?? []), ...flow.steps, ...(flow.teardown ?? [])]);
  // Where the run is, carried forward from the last `goto`: the steps that
  // edit a plan carry no URL of their own, and the route they are on is the
  // only evidence of which data they move.
  let place: string | typeof LOGIN | null = null;
  const places: (string | typeof LOGIN | null)[] = [];
  for (const step of steps) {
    if (step.action === 'goto') {
      // `routeSectionOf` returns null only for a sign-in URL: preparation, not
      // a place that owns data.
      place = routeSectionOf(urlOf(step) ?? '') ?? LOGIN;
    } else if (step.action === 'workflow') {
      // **A workflow leg moves the run, and its own script says where.** The
      // catalog's shape is `goto /en/login` … `workflow "menu path → Benefit
      // Plans"`, and reading only `goto` steps left every later step still
      // marked as standing on the sign-in page — which would have excused
      // every change in the flow as a credential and locked nothing at all.
      // The leg's replay script carries the URLs it settled on; failing that
      // the place is simply unknown, which is `*` for anything that changes
      // data there — the safe direction, and the same answer the case-level
      // rule gave a prose-only writer.
      const script = (step as { script?: readonly FlowStep[] | undefined }).script ?? [];
      const visited = script
        .filter((inner) => inner.action === 'goto')
        .map((inner) => routeSectionOf(urlOf(inner) ?? ''))
        .filter((key): key is string => key !== null);
      place = visited.length > 0 ? visited[visited.length - 1]! : null;
    }
    places.push(place);
  }

  let from = -1;
  let to = -1;
  // Two different reasons to reach for `*`, kept apart: a change whose place
  // is unknown (which better evidence may narrow) and a delete (which nothing
  // may narrow — on a replica it is permanent).
  let unknownPlace = false;
  let deleting = false;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    const changes = mutates(step);
    // A change on a sign-in page is a credential, not application data — the
    // one shape every lane performs and none of them conflict over.
    if (changes && places[index] === LOGIN) continue;
    if (changes) {
      if (from === -1) from = index;
      to = index;
      const here = touched(step, places[index]!);
      // No evidence of WHERE this writes, or a delete — which on a replica is
      // permanent, so a mis-drawn boundary would cost another lane its
      // fixture. `*` intersects everything, for the length of this span only.
      if (here.length === 0) unknownPlace = true;
      if (deletes(step)) deleting = true;
      continue;
    }
    // A check after the change still needs it to hold; a check before it is
    // nobody's business.
    if (from !== -1 && reads(step)) to = index;
  }
  if (from === -1) return [];

  const sections = new Set<string>();
  for (let index = from; index <= to; index += 1) {
    for (const section of touched(steps[index]!, places[index]!)) sections.add(section);
  }
  // Last resort before `*`: a flow whose changes happened somewhere unnamed,
  // but which visits exactly ONE data route anywhere in its length, changed
  // that route's data — there is nowhere else it could have been. One route
  // only, because two make it a guess, and a guess here costs another lane
  // its fixture.
  if (unknownPlace && sections.size === 0) {
    const named = new Set<string>();
    for (const step of steps) {
      const script = (step as { script?: readonly FlowStep[] | undefined }).script ?? [];
      for (const inner of [step, ...script]) {
        const key = urlOf(inner) === null ? null : routeSectionOf(urlOf(inner)!);
        if (key !== null && key !== GLOBAL_SECTION) named.add(key);
      }
    }
    if (named.size === 1) {
      for (const section of named) sections.add(section);
      unknownPlace = false;
    }
  }
  const deferred = unknownPlace && !deleting && !sections.has(GLOBAL_SECTION) &&
    (env['WOWLIDATOR_DATA_LOCK_DEFER'] ?? '').trim().toLowerCase() !== 'off';
  if (unknownPlace || deleting || sections.size === 0) sections.add(GLOBAL_SECTION);

  return [
    {
      from: steps[from]!,
      to: steps[to]!,
      sections: [...new Set(expandSections([...sections], fkPairs))].sort(),
      deferred,
    },
  ];
}

/* --------------------------------------------------------------- the lock */

function intersects(a: readonly string[], b: ReadonlySet<string>): boolean {
  if (b.size === 0 || a.length === 0) return false;
  if (b.has(GLOBAL_SECTION) || a.includes(GLOBAL_SECTION)) return true;
  return a.some((s) => b.has(s));
}

/**
 * A fair multi-section lock, one per suite run.
 *
 * A waiter is granted when none of its sections is held. Waiters are scanned
 * in arrival order and a waiter that cannot be granted RESERVES its sections
 * against everyone behind it — so a long queue of `*` cannot be jumped
 * forever, and a compatible case behind a blocked one still goes now. That
 * scan is the fix for the head-of-line blocking the case-level queue had,
 * where one un-dispatchable case stalled every compatible case after it.
 */
interface Waiter {
  sections: readonly string[];
  grant: () => void;
}

export class SectionLocks {
  readonly #held = new Set<string>();
  #waiters: Waiter[] = [];

  get heldSections(): string[] {
    return [...this.#held];
  }

  async acquire(sections: readonly string[]): Promise<void> {
    if (sections.length === 0) return;
    if (this.#waiters.length === 0 && !intersects(sections, this.#held)) {
      for (const section of sections) this.#held.add(section);
      return;
    }
    await new Promise<void>((resolve) => {
      this.#waiters.push({ sections, grant: resolve });
    });
  }

  /** Acquire immediately or decline without joining the fair waiter queue. */
  tryAcquire(sections: readonly string[]): boolean {
    if (sections.length === 0) return true;
    if (this.#waiters.length > 0 || intersects(sections, this.#held)) return false;
    for (const section of sections) this.#held.add(section);
    return true;
  }

  release(sections: readonly string[]): void {
    for (const section of sections) this.#held.delete(section);
    this.#pump();
  }

  #pump(): void {
    const reserved = new Set<string>();
    const remaining: Waiter[] = [];
    for (const waiter of this.#waiters) {
      if (!intersects(waiter.sections, this.#held) && !intersects(waiter.sections, reserved)) {
        for (const section of waiter.sections) this.#held.add(section);
        waiter.grant();
        continue;
      }
      for (const section of waiter.sections) reserved.add(section);
      remaining.push(waiter);
    }
    this.#waiters = remaining;
  }
}

/* --------------------------------------------------------------- the gate */

/**
 * What the runner consults around every step. `before` may block; `after`
 * never does. `releaseAll` is the run's own finally — a flow that dies
 * mid-window must not take the section down with it.
 */
export interface DataGate {
  before(step: FlowStep, url?: string): Promise<void>;
  lockNow(url: string | undefined, why: string): Promise<void>;
  after(step: FlowStep): void;
  releaseAll(): void;
}

export interface DataGateOptions {
  fkPairs?: readonly (readonly [string, string])[] | undefined;
  /** Told when a lock is waited for, taken and given back — for the lane log. */
  onLog?: ((line: string) => void) | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

/**
 * Build the gate for one flow, or null when the flow changes nothing — a
 * reader never touches the lock table at all.
 */
export function dataGateFor(flow: Flow, locks: SectionLocks, options: DataGateOptions = {}): DataGate | null {
  const fkPairs = options.fkPairs ?? [];
  const windows = dataWindows(flow, fkPairs, options.env ?? process.env);
  if (windows.length === 0) return null;
  const starts = new Map<FlowStep, DataWindow>();
  const ends = new Map<FlowStep, DataWindow>();
  for (const window of windows) {
    starts.set(window.from, window);
    ends.set(window.to, window);
  }
  const held = new Map<DataWindow, Set<string>>();
  const openDeferred = new Set<DataWindow>();
  const log = options.onLog;

  const release = (window: DataWindow): void => {
    const sections = held.get(window);
    if (sections !== undefined) {
      held.delete(window);
      locks.release([...sections]);
      log?.(`data lock: released ${[...sections].join(' ')}`);
    }
    openDeferred.delete(window);
  };

  const deferredWindow = (): DataWindow | undefined =>
    [...openDeferred].find((window) => window.deferred);

  const lockNow = async (url: string | undefined, why: string): Promise<void> => {
    const window = deferredWindow();
    if (window === undefined) return;
    const route = routeSectionOf(url ?? '') ?? GLOBAL_SECTION;
    const known = window.sections.filter((section) => section !== GLOBAL_SECTION);
    const wanted = [...new Set(expandSections([...known, route], fkPairs))].sort();
    const current = held.get(window);
    if (current === undefined) {
      const waited = Date.now();
      await locks.acquire(wanted);
      held.set(window, new Set(wanted));
      const ms = Date.now() - waited;
      log?.(
        `data lock: took ${wanted.join(' ')} at ${why} on ${url ?? '(unknown URL)'}` +
        `${ms > 250 ? ` after waiting ${(ms / 1000).toFixed(1)}s` : ''}`,
      );
      return;
    }
    if (current.has(GLOBAL_SECTION) || current.has(route)) return;
    const extra = wanted.filter((section) => !current.has(section));
    if (locks.tryAcquire(extra)) {
      for (const section of extra) current.add(section);
      log?.(`data lock: also took ${route}`);
      return;
    }
    log?.(
      `data lock: ${route} is held by another lane — continuing; the interference detector reports any overlap`,
    );
  };

  return {
    async before(step: FlowStep, url?: string): Promise<void> {
      const window = starts.get(step);
      if (window !== undefined && window.deferred && !openDeferred.has(window)) {
        openDeferred.add(window);
        log?.('data lock: place unknown — locking at the first write, not now');
      }
      const active = window ?? deferredWindow();
      if (active?.deferred && mutates(step) && step.action !== 'workflow') {
        await lockNow(url, describeStep(step));
      }
      if (window === undefined || window.deferred || held.has(window)) return;
      const waited = Date.now();
      await locks.acquire(window.sections);
      held.set(window, new Set(window.sections));
      const ms = Date.now() - waited;
      log?.(`data lock: took ${window.sections.join(' ')}${ms > 250 ? ` after waiting ${(ms / 1000).toFixed(1)}s` : ''}`);
    },
    lockNow,
    after(step: FlowStep): void {
      const window = ends.get(step);
      if (window === undefined) return;
      release(window);
    },
    releaseAll(): void {
      for (const window of [...new Set([...held.keys(), ...openDeferred])]) release(window);
    },
  };
}

function describeStep(step: FlowStep): string {
  const selector = (step as { selector?: string }).selector;
  return selector === undefined || selector === '' ? step.action : `${step.action} ${JSON.stringify(selector)}`;
}
