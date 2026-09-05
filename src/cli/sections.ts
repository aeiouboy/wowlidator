/**
 * Data sections — the scheduler's answer to "may these two cases run at the
 * same time?" (docs/parallel-run-spec.md, 2026-08-28).
 *
 * The old rule was binary: any case that writes anything runs with nothing
 * else in flight, which near-serialises a writer-heavy catalog. The section
 * rule keeps the safety and returns the parallelism: each case carries the
 * set of DATA SECTIONS it touches, derived from evidence already in the flow
 * — the tables its DB steps name (expanded to their FK-connected component,
 * because a writer to `benefit_plan` moves `benefit_enrollment`'s joins too)
 * and the route families its gotos visit. Two writers may share the pool iff
 * their sections are disjoint and neither deletes.
 *
 * Every judgment call leans the safe direction, the `isAuthField` rule:
 * - a writer whose only footprint is prose (a workflow goal) has NO sections
 *   and stays globally exclusive, exactly as today;
 * - a case that deletes is globally exclusive whatever its sections — on a
 *   replica where deletes are permanent, a mis-drawn boundary must never cost
 *   another lane its fixture;
 * - a global surface (dashboard, home, notifications) is the reserved section
 *   `*`, which intersects everything.
 *
 * Pure functions only — the scheduler in `case-plan.ts`/`run-cases.ts` is the
 * consumer, and `tests/sections.test.ts` pins every rule at the unit tier.
 *
 * **Superseded as the dispatch rule (2026-08-31).** Measured on be100-rip,
 * every case in the catalog ends on one route, so every writer carried the
 * same section, no writer pair was compatible, and a 12-lane pool produced
 * three verdicts in twelve minutes. The flag is drawn around a whole flow;
 * the conflict lives in a handful of its steps. `data-locks.ts` moves the
 * serialisation inside the run — nothing is flagged, and a case holds a
 * section only from the step that changes it to the last step that needs the
 * change to hold. The section VOCABULARY here (`routeSectionOf`,
 * `expandSections`, `GLOBAL_SECTION`) is what that module locks on, and the
 * case-level rule below is still what `WOWLIDATOR_DATA_LOCKS=off` restores
 * and what the interference detector (`windowsInterfere`) reads.
 */

import type { Flow, FlowStep } from '../engine/runner.js';
import { caseWrites } from './case-plan.js';

/** The reserved section that intersects every other. */
export const GLOBAL_SECTION = '*';

/** Route heads that are global surfaces, not a data family of their own. */
const GLOBAL_ROUTE_HEADS = new Set(['', 'dashboard', 'home', 'overview', 'notifications', 'search']);

/** `WOWLIDATOR_SECTIONS=off` restores the binary writer lock. */
export function sectionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['WOWLIDATOR_SECTIONS'] ?? '').trim().toLowerCase() !== 'off';
}

export interface CaseScheduleMeta {
  /** Section keys this case touches. Empty + writes = globally exclusive. */
  sections: readonly string[];
  writes: boolean;
  /** A delete anywhere makes the case globally exclusive regardless of sections. */
  deletes: boolean;
}

function flatten(list: readonly FlowStep[]): FlowStep[] {
  return list.flatMap((step) =>
    step.action === 'when' ? [step, ...flatten(step.then), ...flatten(step.else ?? [])] : [step],
  );
}

/**
 * Delete talk in a workflow goal — the one prose read, and it only ever
 * NARROWS. Word-bounded in English; the Thai alternation (`ลบ` delete,
 * `นำออก` remove) sits outside the `\b` because Thai has no ASCII word
 * boundaries (CG-16: a "ลบ Plan" goal read as a reader and shared the pool
 * with the case counting that plan).
 */
const DELETE_VERB = /\b(delet(e|es|ing)|remov(e|es|ing)|purg(e|es|ing)|drop(s|ping)?)\b|ลบ|นำออก/iu;

/** The `/en/admin/benefits/plans` → `route:admin/benefits` family key, or `*`. */
export function routeSectionOf(url: string): string | null {
  let path: string;
  try {
    path = new URL(url, 'http://x').pathname;
  } catch {
    return null;
  }
  const parts = path.split('/').filter((p) => p !== '');
  // A leading two-letter (or xx-XX) segment is a locale, not a place — and so
  // is one sitting right behind a single base-path segment. Measured live
  // (humi, 2026-09-05): every page of `/humi/th/...` folded into one section
  // `route:humi/th`, the sign-in page included, so every writer in the suite
  // queued behind every other for 20-26% of its lane time.
  const LOCALE = /^[a-z]{2}(-[A-Za-z]{2})?$/;
  if (parts.length > 0 && LOCALE.test(parts[0]!)) parts.shift();
  else if (parts.length > 1 && LOCALE.test(parts[1]!)) parts.splice(0, 2);
  const head = (parts[0] ?? '').toLowerCase();
  if (GLOBAL_ROUTE_HEADS.has(head)) return GLOBAL_SECTION;
  // Login pages are preparation, not a data section — every case visits one.
  if (/(login|signin|sign-in|auth)/.test(head)) return null;
  return `route:${parts.slice(0, 2).join('/').toLowerCase()}`;
}

/**
 * The sections one case touches, before FK expansion. Tables come from the DB
 * steps' own `table` fields; routes from every goto. Prose contributes
 * nothing — a workflow goal names no section, which for a writer means
 * "unknown", which means exclusive.
 */
export function caseScheduleMeta(flow: Flow): CaseScheduleMeta {
  const steps = flatten([...(flow.setup ?? []), ...flow.steps, ...(flow.teardown ?? [])]);
  const sections = new Set<string>();
  let deletes = false;
  for (const step of steps) {
    const table = (step as { table?: unknown }).table;
    if (typeof table === 'string' && table !== '') sections.add(`table:${table.toLowerCase()}`);
    if (step.action === 'goto') {
      const key = routeSectionOf((step as { url: string }).url);
      if (key !== null) sections.add(key);
    }
    if (step.action === 'request') {
      const method = ((step as { method?: string }).method ?? 'GET').toUpperCase();
      if (method === 'DELETE') deletes = true;
    }
    if (step.action === 'workflow' && DELETE_VERB.test((step as { goal: string }).goal)) deletes = true;
  }
  return { sections: [...sections], writes: caseWrites(flow), deletes };
}

/**
 * FK pairs from an indexed project graph: every `references` edge between two
 * `table:` nodes, as lower-cased table names. The caller that holds a graph
 * passes these once; without a graph the closure is the identity, which only
 * means fewer pairs run together — never a wrong pair.
 */
export function fkPairsFromGraph(graph: {
  edges: readonly { from: string; to: string; kind: string }[];
}): [string, string][] {
  const pairs: [string, string][] = [];
  for (const edge of graph.edges) {
    if (edge.kind !== 'references') continue;
    if (!edge.from.startsWith('table:') || !edge.to.startsWith('table:')) continue;
    pairs.push([edge.from.slice(6).toLowerCase(), edge.to.slice(6).toLowerCase()]);
  }
  return pairs;
}

/**
 * Expand table sections to their FK-connected component: a section is the
 * whole join family, not a single table (defect #2 of the spec). Union-find
 * over the pairs; the component is named by its lexicographically-first
 * member so two cases in one family always derive the same key.
 */
export function expandSections(
  sections: readonly string[],
  fkPairs: readonly (readonly [string, string])[],
): string[] {
  if (fkPairs.length === 0) return [...sections];
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  for (const [a, b] of fkPairs) {
    if (parent.get(a) === undefined) parent.set(a, a);
    if (parent.get(b) === undefined) parent.set(b, b);
    union(a, b);
  }
  return sections.map((key) => {
    if (!key.startsWith('table:')) return key;
    const table = key.slice(6);
    return parent.has(table) ? `table:${find(table)}` : key;
  });
}

/** Globally exclusive: a writer with no evidence of WHERE it writes, or one that deletes. */
export function isGloballyExclusive(meta: CaseScheduleMeta): boolean {
  if (!meta.writes) return false;
  if (meta.deletes) return true;
  const real = meta.sections.filter((s) => s !== GLOBAL_SECTION);
  return real.length === 0 || meta.sections.includes(GLOBAL_SECTION);
}

/**
 * May these two cases be in flight together? The spec's §2.2 table:
 * reader∥reader always; anything involving a writer needs disjoint sections;
 * `*` intersects everything.
 */
export function compatibleCases(a: CaseScheduleMeta, b: CaseScheduleMeta): boolean {
  if (!a.writes && !b.writes) return true;
  if (isGloballyExclusive(a) || isGloballyExclusive(b)) return false;
  const setA = new Set(a.sections);
  if (setA.has(GLOBAL_SECTION) || b.sections.includes(GLOBAL_SECTION)) return false;
  return !b.sections.some((s) => setA.has(s));
}

/**
 * Did another case's write plausibly interfere with this outcome? True when
 * the other case writes, the windows overlapped, and the sections intersect
 * (`*` on either side intersects). The detector's math, pure so it is
 * testable without a browser.
 */
export function windowsInterfere(
  mine: { meta: CaseScheduleMeta; startedMs: number; endedMs: number },
  other: { meta: CaseScheduleMeta; startedMs: number; endedMs: number },
): boolean {
  if (!other.meta.writes) return false;
  if (other.endedMs < mine.startedMs || other.startedMs > mine.endedMs) return false;
  const mineSet = new Set(mine.meta.sections);
  if (mineSet.size === 0 || other.meta.sections.length === 0) return true; // unknown = cannot exclude
  if (mineSet.has(GLOBAL_SECTION) || other.meta.sections.includes(GLOBAL_SECTION)) return true;
  return other.meta.sections.some((s) => mineSet.has(s));
}

/**
 * Cross-representation aliasing — the gap job-2 exposed (2026-08-28): one
 * PL_06 flow carried only `route:admin/benefits` (its DB check was dropped in
 * narrowing) and a sibling only `table:benefit_management.benefit_plan`; the
 * two write THE SAME page, but disjoint-looking keys would have let them
 * co-run, and the interference detector (same intersection math) would not
 * have caught it. The evidence that a route and a table are one section is a
 * case that carries BOTH: from then on the two keys are aliases for every
 * comparison. Deterministic, accumulated as cases are seen, and it only ever
 * NARROWS — aliasing can only turn "allowed" into "serialised".
 */
export function sectionAliaser(): {
  note(meta: CaseScheduleMeta): void;
  canon(sections: readonly string[]): string[];
} {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: string, b: string): void => {
    if (parent.get(a) === undefined) parent.set(a, a);
    if (parent.get(b) === undefined) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  return {
    note(meta: CaseScheduleMeta): void {
      const routes = meta.sections.filter((s) => s.startsWith('route:'));
      const tables = meta.sections.filter((s) => s.startsWith('table:'));
      for (const r of routes) for (const t of tables) union(r, t);
    },
    canon(sections: readonly string[]): string[] {
      return sections.map((s) => (parent.has(s) ? find(s) : s));
    },
  };
}
