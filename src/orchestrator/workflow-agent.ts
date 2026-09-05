/**
 * Multi-page workflow agent.
 *
 * The deterministic runner can only click selectors it was told about. When a
 * goal sits behind unknown interstitials — a consent screen, a wizard, a
 * redirect chain that varies by tenant — the agent temporarily takes the
 * browser, drives it observe→decide→act until the goal is met, and hands
 * control back so the rest of the flow returns to the free fast path.
 *
 * The loop lives here rather than in the SDK tool runner on purpose: every
 * turn has to be budgeted, origin-checked, and screenshot-able against live
 * browser state, and keeping the model behind a one-decision-per-turn
 * interface is what lets the whole thing be tested without a network.
 */

import { createHash } from 'node:crypto';

import type { LanguageModel } from 'ai';
import type { Locator, Page } from 'playwright';
import { z } from 'zod';

import { lenientObject } from '../providers/model-output.js';

import { SELECTOR_SYNTAX_RULES, captureAxNodes } from '../healer/jit-healer.js';
import { performSignOut } from '../engine/sign-in.js';
import {
  CONSENT_ACCEPT_NAME,
  CONSENT_GATE_URL_PATTERN,
  acceptConsentGateAnywhere,
  consentGateShowing,
} from '../engine/consent-gate.js';
import { revealHidden } from '../engine/reveal.js';
import { approach, humanClick, humanFill, humanKeys, humanScrollBy, humanScrollTo } from '../engine/humanize.js';
import { ListboxOptionMissingError, selectFromListbox } from '../engine/listbox.js';
import { isoDateOf } from '../engine/dates.js';
import { scopeUrl, type CacheManager } from '../cache/cache-manager.js';
import type { AxNode } from '../healer/jit-healer.js';
import {
  decisionKey,
  focusTree,
  formGaps,
  formatFormGaps,
  goalAlreadyShowing,
  listboxCannotOffer,
  menuNodeScore,
  menuPathOf,
  multiPersonaGoal,
  multiPersonaSummary,
  renderTree,
  repeatedToggleClick,
  activationKey,
  reactivation,
  reactivationAdvanced,
  sameOptions,
  selectorGrounded,
  selectorName,
  unscopedDestructiveClick,
  type MenuSegment,
  type Reactivation,
} from './agent-guards.js';
import { normaliseAgentSelector } from '../engine/selector.js';
import {
  LlmFactory,
  generateStructuredForModel,
  type ModelSource,
} from '../providers/llm-factory.js';
import type { AgentAction, AgentRecord } from '../engine/proof-bundle.js';
import {
  anyValueAppears,
  atGoalDestination,
  describeOutcomes,
  destinationReached,
  differentPage,
  foldValue,
  goalCitedValues,
  goalDestination,
  goalOutcomes,
  outcomesShown,
  urlMoveNote,
  valueAppearsAnywhere,
  wanderedOffPage,
  wizardStepHint,
} from './goal-evidence.js';
import { DETERMINISM_RULES, procedure } from '../providers/prompt-discipline.js';

// 8 until 2026-08-24, then 12, then unbounded (2026-08-24): every fixed number
// priced some honest long journey wrong — a Create Plan goal is legitimately
// ~12–15 actions, and 17 workflow steps died as "gave up after 8 turns"
// mid-form with every action correct. The loop's own logic is the judge now:
// finish/fail, arriving at the goal's destination, a stall (a page-changing
// action repeated on an unchanged page, or AGENT_NO_PROGRESS_TURNS consecutive
// turns in which nothing advanced — see below), and a model failure each end it, and none of
// them can end a journey that is actually advancing. WOWLIDATOR_AGENT_MAX_STEPS
// (or `maxSteps`) reinstates a hard turn ceiling for whoever wants one.
//
// "Unbounded" turned out to have a gap the loop's own judges do not cover
// (2026-09-02, HIR-EC-010, live): a leg that keeps landing genuinely OK
// clicks on a succession of WRONG controls never trips the no-progress judge
// (every one of those turns is real progress by that judge's own rule) and
// never repeats one selector often enough to trip the toggle-circling guard
// either — 101 turns, ~27 minutes, on one goal whose value did not exist on
// the page. `AGENT_VALUE_HUNT_TURNS` and `AGENT_FAIL_FAST_MAX_STEPS` are the
// targeted fixes for that shape. This default stays a BACKSTOP for the legs
// neither of those reaches — a goal `goalCitedValue` cannot parse, or a case
// with no pre-run risk verdict (a hand-authored flow, `go`/`generate`) — sized
// well above the ~12–15 actions an honest long journey needs, so it is a
// dead-loop guard, not a second ceiling competing with the judges above.
export const DEFAULT_AGENT_MAX_STEPS = envMaxSteps() ?? 60;

/**
 * Consecutive turns in which nothing ADVANCED before the loop stops itself.
 *
 * This is the judge that replaced the turn ceiling for the one shape the other
 * stops cannot see: a model inventing a NEW failing action every turn (the
 * repeat guard only catches the same one twice). A turn advances when an
 * action that can change the page — click, fill, press, hover, goto — lands;
 * a turn spent only on `wait` or `scroll` (see IDLE_ACTIONS) or on failures
 * does not, however many of them succeeded. A twenty-action journey whose
 * every turn lands never meets it, which is exactly what a fixed ceiling got
 * wrong.
 *
 * Five, not three (2026-08-25). Measured on be100 the day after the ceiling
 * went: 10 of 22 error runs ended here, most of them on a dropdown leg where
 * the option's role was guessed three ways (option, menuitem, text) at 1.5 s
 * a miss — four seconds of evidence is not "the page cannot do this", it is
 * the ordinary cost of finding out how a widget is built. Three was tuned
 * for an 8 s miss; the fast-fail made it four times stricter than intended.
 */
export const AGENT_NO_PROGRESS_TURNS = 5;
/**
 * Fewer turns than a stall when EVERY action so far has been a look. Three
 * scrolls that changed nothing say the page has no more to show; two more
 * would only say it again, at a model call each.
 */
export const AGENT_LOOK_ONLY_TURNS = 3;
/**
 * The gap the no-progress judge cannot see (2026-09-02, be100 HIR-EC-010,
 * live): a `set Employee Group to "G - Internship"` goal against an app whose
 * control only offers "1"/"2" — the agent OBSERVED that at turn one, then
 * spent 100 more turns opening a different wrong subsection each time.
 * `AGENT_NO_PROGRESS_TURNS` never caught it, because every one of those turns
 * landed an OK click on a NEW control — genuine progress by that judge's own
 * rule, just never toward anything the page can satisfy. This is a second,
 * narrower judge for the one shape the first cannot cover: a goal that names
 * a concrete value (`goalCitedValue`, the `set X to Y` parse `goalOutcome`
 * already does) which has not appeared in ANY tree this leg has observed —
 * not paired with its control, unlike `outcomeShown`; anywhere at all — after
 * this many turns. Generous on purpose: a value that is genuinely a few
 * navigations away must still be reached, so this fires only once the no-
 * progress judge's own patience (`AGENT_NO_PROGRESS_TURNS`) has already been
 * exceeded once over. A truncated tree on ANY turn withdraws the judge for
 * the rest of the leg — absence from a truncated tree is not absence from the
 * page, and a leg that size was never this guard's target.
 */
export const AGENT_VALUE_HUNT_TURNS = 8;
/**
 * The turn ceiling `failFastRunOptions` (`run-cases.ts`) hands a case the
 * pre-run risk judge already flagged, via `RunOptions.maxSteps`. A fail-fast
 * verdict already means "a near-certain fail is a fact retries only
 * re-prove" for the RUN as a whole (no healer, no reconstruction, no
 * repair) — this is the same reasoning applied to the one agent shot such a
 * case still gets, which was otherwise unbounded and, live (HIR-EC-010,
 * 2026-09-02), ran 101 turns on one already-flagged goal. Generous enough
 * for a genuine multi-page journey (the comment on `DEFAULT_AGENT_MAX_STEPS`
 * prices one at ~12–15 actions); tight enough that a leg circling a value
 * that structurally does not exist stops paying for it quickly.
 */
export const AGENT_FAIL_FAST_MAX_STEPS = 15;
/**
 * The no-progress ceiling when the early-give-up toggle is OFF
 * (`WOWLIDATOR_AGENT_EARLY_STOP=off` / `--no-agent-early-stop`). "Off" must
 * not mean "loop forever" — with `maxSteps` unbounded by default, a leg that
 * can never find its control would spend model calls without end — so it
 * means "try much harder before giving up, still bounded." The look-only
 * soft handoff is also lifted to this number, so nothing stops early. A hard
 * `maxSteps` still wins when one is set.
 */
export const AGENT_NO_PROGRESS_OFF_TURNS = 25;
/**
 * How many turns a leg may spend OFF the page its step began on — on
 * another origin or path, short of any destination the goal names
 * (`wanderedOffPage`) — moving the page again or only clicking, before the
 * loop ends it as a wander. Live (HIR-EC-002, 2026-09-03 13:00): steps 16
 * and 19 each left /en/admin/hire/draft for /en/requests and kept going,
 * and every goto or click onto a fresh page was progress by the no-progress
 * judge's rule, so nothing but DEFAULT_AGENT_MAX_STEPS ended them — 903 s
 * of a 1,377 s case at ~7 s a turn. A journey to a named destination is
 * two to four page moves; eight is well past any honest one. A turn off the
 * page that lands a FIRST-TIME form entry (fill, type, selectOption, check)
 * does not spend the allowance — "open the form and fill it" legitimately
 * lives off its start page for fifteen turns — and a return to the start
 * page resets it. A consent redirect is cleared by the gate rung and never
 * counted. Lifted to AGENT_NO_PROGRESS_OFF_TURNS when early-stop is off,
 * like the other two judges.
 */
export const AGENT_OFF_PAGE_TURNS = 8;

/**
 * Whether the agent's early-give-up judges (look-only at 3, no-progress at 5)
 * are on. On by default; `WOWLIDATOR_AGENT_EARLY_STOP=off` turns them off
 * process-wide, and `--no-agent-early-stop` / the panel toggle per run. Off
 * raises both to `AGENT_NO_PROGRESS_OFF_TURNS`, so the agent keeps trying far
 * longer before conceding a leg — slower and more thorough, the trade the
 * person is making by turning it off.
 */
export function agentEarlyStopDefault(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['WOWLIDATOR_AGENT_EARLY_STOP']?.trim().toLowerCase() !== 'off';
}

/**
 * Actions that look again rather than act: they can never change the
 * application's state, so repeating one is never a STALL in the sense the
 * repeat guard exists for (the same fill into the same field, four times).
 * They are also never PROGRESS — a turn spent only on them counts toward
 * AGENT_NO_PROGRESS_TURNS. Measured (be100, 2026-08-25): seven runs ended
 * as `stalled: repeated "scroll "` or `repeated "wait "` — the model asked
 * to look again, was told it already had, asked once more, and the run was
 * recorded as a harness error with the goal's control on screen.
 */
export const IDLE_ACTIONS: ReadonlySet<string> = new Set(['wait', 'scroll', 'read', 'save']);
/**
 * How many times per leg an ok `scroll`/`wait` that CHANGED the full tree is
 * credited as progress (OA-10, 2026-09-03). A lazily-rendered employee list
 * (87k rows on humi, 20 more per scroll) needs more than five looks, and the
 * prompt already tells the model "a page whose tree did not change after a
 * scroll is finished" — the loop just never measured it. Bounded at three
 * no-progress budgets so an infinite feed still ends the leg.
 */
export const AGENT_TREE_CHANGE_CREDITS = AGENT_NO_PROGRESS_TURNS * 3;
/**
 * The actions that actually ENGAGE a control the goal is about — the thing a
 * leg is trying to reach. A leg that never lands one of these has found
 * nothing to act on, whatever else it did (scrolled, reloaded, missed): the
 * broadened reading/unreachable handoff keys on this, so a leg that only ever
 * missed its clicks ends as fast as one that only scrolled, instead of paying
 * the full stall budget at 1.5 s a miss. `goto` is deliberately NOT here — a
 * page reload is not engaging a control (see the visited-URL rule below).
 */
export const INTERACTION_ACTIONS: ReadonlySet<string> = new Set([
  'click',
  'fill',
  'press',
  'hover',
  'check',
  'uncheck',
  'type',
  'paste',
  'selectOption',
  // Ending the session engages the app's own sign-out control (OA-15): it is
  // a page-changing act, never a look, and never available to a reveal or
  // read-only run.
  'signOut',
]);
/**
 * The interactions that put a value INTO a control rather than open or
 * follow one — the work a form page is visited for. A first-time one of
 * these off the step's page does not spend AGENT_OFF_PAGE_TURNS.
 */
export const FORM_ENTRY_ACTIONS: ReadonlySet<string> = new Set([
  'fill',
  'type',
  'paste',
  'selectOption',
  'check',
  'uncheck',
]);
/** Everything a `readOnly` run may do: look, look again, and answer. */
export const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set([...IDLE_ACTIONS, 'finish', 'fail']);
/**
 * What a `reveal` run may do: everything read-only, plus the actions that
 * bring an EXISTING control into reach — open a menu, follow a link, tick a
 * box or pick a dropdown option that gates the section the target is in.
 * Never `fill` and never `type`, and never `dbCount`.
 *
 * The distinction is the one this codebase has always drawn between preparing
 * a page and performing a step, and it matters most for an ASSERTION: a claim
 * an agent *typed* into existence proves nothing, so the repair pass offered
 * to an assertion may set a control's state but must not write the asserted
 * text into a field. `dbCount` is excluded for a second reason as well — it is
 * a backend action, and a run with backend testing off must not reach the
 * database by any route.
 */
export const REVEAL_ACTIONS: ReadonlySet<string> = new Set([
  ...READ_ONLY_ACTIONS,
  'click',
  'check',
  'uncheck',
  'selectOption',
  'press',
  'hover',
  'goto',
]);
/**
 * What a `wait` is worth on a page whose network is ALREADY quiet. The idle
 * wait returns at once there, and a wait that does nothing costs a model
 * turn to do nothing; a page still hydrating, or a dropdown still animating
 * its options in, is exactly what the model asked to wait for. Paid only
 * when the idle wait had nothing to wait on, so a settled page is not taxed
 * on every wait (the 2026-08-24 concern) — only on the one that would
 * otherwise be a no-op.
 */
export const WAIT_SETTLE_MS = 750;
/**
 * The beat a look (scroll/wait) is given before the progress judge asks
 * whether it rendered more (OA-10): a scroll listener fires on the NEXT
 * frame, after `scrollBy` returned — measured ~50 ms — and an immediate
 * capture would read the tree before the rows it triggered exist.
 */
export const LOOK_SETTLE_MS = 100;

function envMaxSteps(): number | null {
  const raw = process.env['WOWLIDATOR_AGENT_MAX_STEPS'];
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
export const DEFAULT_AGENT_MAX_NODES = 60;
/**
 * The prompt's node budget for a FORM-shaped goal (OA-3, 2026-09-03): three
 * or more `set X = Y` outcomes, or wording about every required/mandatory/
 * asterisked field. A hire form's tree is well over sixty nodes, and the
 * focused tree cut the very controls the goal named. Applies only when the
 * instance runs on the default budget — a caller that set its own keeps it.
 */
export const FORM_AGENT_MAX_NODES = 120;
/** How much of a `read`/`save` observation rides the record (OA-14; was 120 on the history line only). */
export const READ_OBSERVATION_CHARS = 600;
/** The DONE ledger's size cap in the prompt (OA-7). */
export const DONE_LEDGER_CHARS = 700;
/** Per-action timeout while the agent holds the browser. */
export const DEFAULT_AGENT_ACTION_TIMEOUT_MS = 5_000;
/**
 * The most a post-navigation settle is worth. An app that polls or holds a
 * websocket never reaches `networkidle`, so an uncapped (or generously capped)
 * idle wait doesn't buy hydration — it buys the full timeout, on every
 * navigation, forever. Two seconds covers the quiet-page case; a page still
 * hydrating past that shows up as an unchanged tree next turn, which the
 * stall guard already knows how to read.
 */
export const NETWORK_SETTLE_MS = 2_000;
/** How long a selector gets to match ANYTHING before the action is refused as a miss. */
export const TARGET_ATTACH_MS = 1_500;

/**
 * What the agent may do with the browser.
 *
 * `press`, `scroll` and `wait` were added because they are what a *stuck* page
 * actually needs, and none of them can change data. A control below the fold,
 * a listbox that only opens on Enter, and a page that has not finished
 * hydrating are the three states a click-and-fill vocabulary cannot get out
 * of — it can only keep clicking things that are not there yet. Nothing
 * destructive belongs in this list: the agent's whole safety argument is that
 * its vocabulary cannot express a purchase or a delete except through a
 * `click` the goal explicitly asked for.
 */
export const AGENT_ACTIONS = [
  'click',
  'fill',
  // Deliberate form interaction — the same vocabulary the generator and the
  // engine already have, so the agent drives a form the way a human tester
  // does instead of click-and-guess. `check`/`uncheck` set a checkbox, radio
  // or ARIA toggle and confirm the state changed; `selectOption` picks by
  // visible label from a native <select> OR a custom listbox; `type` fires a
  // real keydown per character for autocomplete / typeahead / masked fields
  // that `fill`'s one assignment cannot wake; `paste` inserts the whole value
  // at the caret as a paste does, which is the only way into a control that
  // refuses both an assignment and per-key input — a date picker, a masked
  // field, a rich editor (ec10 HIR-EC-001, 2026-09-02: `Select date` took
  // neither). None is destructive: the safety
  // argument is unchanged — the vocabulary still cannot express a purchase or
  // a delete except through a `click` the goal explicitly named.
  'check',
  'uncheck',
  'selectOption',
  'type',
  'paste',
  'press',
  'hover',
  'scroll',
  'wait',
  'goto',
  // Read-only database validation — a SELECT count through the run's own
  // grounded, read-only session (`RunOptions.dbProbe`), so a goal like
  // "verify the number in the box matches the database" is answerable with
  // observed evidence instead of the model's word. It cannot write, which
  // keeps the vocabulary's safety argument intact.
  'dbCount',
  // Read a control's CURRENT state — name, value, checked, expanded,
  // disabled — from the live tree, into the history, at $0 and with no
  // side effect. Audit 2026-08-28: the agent had no way to know whether
  // "Country" or "Rows per page" had taken, so it clicked again to find
  // out, and the repeat guard stalled the leg. Looking is cheaper than
  // re-acting, and an observation in the record is evidence a claim is not.
  'read',
  // Remember a value the page shows, under a name later steps can use as
  // `{{name}}` (OA-8, 2026-09-03). ~200 rows say "บันทึก Employee ID ที่ระบบ
  // สร้าง" and then search by it two cases later; the generated id appears
  // on a page no authoring-time tree ever saw, so `saveText` could not be
  // grounded by the author — only the agent standing on that page can read
  // it. Idle: never progress, never a stall, and allowed to a read-only run,
  // because reading a value changes nothing.
  'save',
  // End the current session through the app's own sign-out control (OA-15):
  // the only way a goal that continues as another person can proceed. An
  // interaction, never a look; excluded from the reveal and read-only sets.
  'signOut',
  'finish',
  'fail',
] as const;
export type AgentActionKind = (typeof AGENT_ACTIONS)[number];

/** One further action the model is confident follows — same flat shape, no reasoning. */
const PlanStepSchema = lenientObject({
  action: z.enum(AGENT_ACTIONS),
  selector: z.string().describe('Selector, as for the main action. Empty otherwise.'),
  value: z.string().describe('Value or key name. Empty otherwise.'),
  url: z.string().describe('Absolute URL for goto. Empty otherwise.'),
});

/** How many follow-up actions one decision may carry. Each is re-verified live. */
export const AGENT_PLAN_AHEAD = 2;

const DecisionSchema = lenientObject({
  action: z.enum(AGENT_ACTIONS),
  selector: z
    .string()
    .describe(
      'Playwright selector for click/fill/type/paste/check/uncheck/selectOption/press/hover/read/save, or the element to scroll into view. ' +
        'For dbCount: the database table name (schema-qualified if shown that way). Empty otherwise.',
    ),
  value: z
    .string()
    .describe(
      'Text for fill/type/paste, the option\'s VISIBLE LABEL for selectOption, key name for press (Enter, Escape, Tab, ArrowDown), ' +
        'the VARIABLE NAME for save. check/uncheck/signOut take no value. ' +
        'For dbCount: the where clause as "column=value, column2=value2" equality pairs, or empty to count the whole table. Empty otherwise.',
    ),
  url: z.string().describe('Absolute URL for goto. Empty otherwise.'),
  reasoning: z.string().describe('One sentence: why this action moves toward the goal.'),
  next: z
    .array(PlanStepSchema)
    .describe(
      `Up to ${AGENT_PLAN_AHEAD} further actions you are CERTAIN follow, in order, each naming a control that is in the tree NOW (e.g. fill the email, then click Next). Empty when the next action depends on what appears.`,
    ),
});

export interface PlanStep {
  action: AgentActionKind;
  selector: string;
  value: string;
  url: string;
}

export interface AgentObservation {
  goal: string;
  url: string;
  axTree: string;
  /** The test case this step serves — see `RunOptions.caseContext`. */
  caseContext?: string | undefined;
  /** What has been tried so far, and how it went. */
  history: string[];
  /**
   * `REQUIRED AND STILL EMPTY (N): …` — the required controls the full tree
   * shows unfilled (OA-6), rendered right after the tree. A separate field,
   * never tree text: settlement and the value-hunt judge read the tree.
   */
  formGaps?: string | undefined;
  /**
   * `DONE so far (N actions): fill Bank="Kasikorn" · …` — the ok interactions
   * of the whole leg, one entry per control, in place of the elision line
   * (OA-7). Built from `actions`, never from history strings.
   */
  ledger?: string | undefined;
  stepsRemaining: number;
  /**
   * Why the model's previous answer for THIS turn was refused, when it was —
   * the healer's `rejected` seam applied to the agent. Present only on a
   * re-ask within one turn; the loop never re-asks twice.
   */
  feedback?: string | undefined;
}

export interface AgentDecision {
  action: AgentActionKind;
  selector: string;
  value: string;
  url: string;
  reasoning: string;
  /** Follow-ups the model planned; executed only while each still grounds in the live tree. */
  next?: PlanStep[] | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

/**
 * Where a solved goal is remembered, so the next case with the same goal on
 * the same page replays it without a model turn. Backed by the healed-selector
 * cache in a run (`cacheAgentMemory`); anything with get/set in a test.
 */
export interface AgentMemory {
  get(key: string): PlanStep[] | undefined;
  set(key: string, steps: PlanStep[], model: string): void;
  forget(key: string): void;
}

/**
 * `${origin+path} :: workflow :: ${goal}` — the goal's wording, whitespace-folded
 * — and, when the run has one, the persona the leg ran as.
 *
 * The persona belongs in the key for the reason `#deadResolutions` is already
 * keyed by it in the runner: *an employee's 403 page and the manager's real
 * page share a URL and nothing else*. A case that changes hands mid-way asks
 * the same question twice from the same address — "open Team > Probation
 * Reviews and open the case" as the manager, then as the HRBP — and without
 * the persona here the second leg replays the first one's recorded journey on
 * the second person's browser, at zero model turns, and reports success.
 *
 * Only the LABEL is ever passed. It never reaches a prompt; it exists solely
 * to keep two people's memories apart. A run with no personas passes nothing
 * and its keys are byte-identical to before, so no existing cache entry is
 * orphaned.
 */
export function replayKey(startUrl: string, goal: string, persona?: string | undefined): string {
  const base = `${scopeUrl(startUrl)} :: workflow :: ${goal.replace(/\s+/g, ' ').trim()}`;
  return persona === undefined || persona === '' ? base : `${base} :: as ${persona}`;
}

/**
 * The healed-selector cache as agent memory. The entry's `healed` field
 * carries the JSON action list and `strategy` marks it, so the file's merge-
 * on-flush, hit counting and `wowlidator cache` tooling all apply unchanged,
 * and a replay that fails is deleted the way a stale heal is.
 */
export function cacheAgentMemory(cache: CacheManager): AgentMemory {
  return {
    get(key) {
      const entry = cache.get(key);
      if (!entry || entry.strategy !== 'workflow-replay') return undefined;
      try {
        const steps = JSON.parse(entry.healed) as PlanStep[];
        return Array.isArray(steps) ? steps : undefined;
      } catch {
        return undefined;
      }
    },
    set(key, steps, model) {
      const [url = '', goal = ''] = key.split(' :: workflow :: ');
      cache.set({
        key,
        original: goal,
        healed: JSON.stringify(steps),
        strategy: 'workflow-replay',
        url,
        confidence: 1,
        reasoning: `${steps.length} action(s) that reached this goal, recorded for replay`,
        model,
      });
    },
    forget(key) {
      cache.delete(key);
    },
  };
}

/** Words that say HOW to get somewhere — a goal with none may be met by going there. */
const ROUTE_WORDS = /\b(via|through|menu|sidebar|side bar|nav|breadcrumb|tab|click|press|tile|card|link|button|by)\b/i;

/** Pluggable policy. One decision per call — the loop belongs to the agent. */
export interface AgentModel {
  readonly id: string;
  decide(observation: AgentObservation): Promise<AgentDecision>;
}

const SYSTEM_PROMPT = `You are driving a real web browser to reach a stated goal, one action at a time.

Each turn you see the current URL, the page's accessibility tree, and what you have already tried. Choose exactly one action:
- click  — press a control. Put a Playwright selector in "selector".
- fill   — set a field's value in one go. Selector plus "value". Right for an
           ordinary text/email/number field.
- type   — type into a field key by key, firing real keyboard events. Selector
           plus "value". Use INSTEAD of fill only for a field that reacts per
           keystroke: autocomplete, typeahead, a masked input.
- paste  — insert the whole value at once, as a paste does. Selector plus
           "value". The last way into a control that refuses both fill and
           type: a date field, a masked input, a rich editor. A DATE goes in as
           YYYY-MM-DD; a read-only date display is redirected to the real date
           input beside it for you, so name the field by its label and paste
           the ISO date.
- check / uncheck — tick or untick a checkbox, radio, or ARIA toggle. Selector
           only, no value. Prefer these over click when the point is the
           resulting state — they confirm it actually changed.
- selectOption — choose from a dropdown. The option's VISIBLE LABEL in "value",
           the dropdown control itself in "selector". Works on a native select
           and a custom listbox alike — never fill a dropdown, and never click
           it open to guess at its items: this one action opens it and picks.
- press  — send a key. Key name in "value" (Enter, Escape, Tab, ArrowDown).
           Optional "selector" focuses that element first. Use for a listbox or
           menu that only opens on a keypress, or to dismiss an overlay.
- hover  — move mouse pointer over a control. Selector in "selector". Use to open
           hover-activated flyout menus or reveal hidden sub-menus.
- scroll — bring something into view. Selector of the element to scroll to, or
           empty to scroll down one screen. The tree already lists elements
           that are off-screen, so scroll only for a control the tree shows
           and a click could not reach, or a list that renders rows lazily.
           Scrolling a page whose tree did not change afterwards is finished:
           do not scroll it again.
- wait   — let the page settle for a moment and look again. Use once, when the
           tree looks half-built or right after an action that starts a load.
           If the tree is the same after a wait, waiting longer will not
           change it: act on what is there, or call fail and say why.
- goto   — navigate directly. Absolute URL in "url".
- read   — report a control's CURRENT state (its value, whether it is checked,
           expanded, disabled) without touching it. Selector in "selector".
           Use it to learn whether a choice has taken BEFORE deciding to click
           again, and before you finish: a finish is checked against what the
           page shows, not against what you did. When the goal says record /
           บันทึกค่า / note what the system shows, read each named control,
           then finish quoting the observed values — they ride into the record.
- save   — remember a value the page shows for later steps. Selector of the
           node showing the value; the VARIABLE NAME in "value" — the goal
           tells you the name ("save the generated Employee ID as
           EMPLOYEE_ID"). Later steps use it as {{EMPLOYEE_ID}}.
- signOut — end the current session through the app's own sign-out control,
           when the goal says to continue as another person; the sign-in
           form then appears. No selector, no value.
- finish — the goal is met. Explain how you know in "reasoning", quoting the
           tree line that shows the end state — never "the click succeeded".
- fail   — the goal cannot be reached from here. Explain why.

${SELECTOR_SYNTAX_RULES}

${DETERMINISM_RULES}

${procedure('EACH TURN', [
  'Is the goal already met? Compare the current URL and the tree against the goal\'s own words. If the goal names a destination path and the URL is on it, or the tree shows the state the goal describes, call finish NOW — nothing else.',
  'Read the history. Every action marked "ok" is DONE: a fill that succeeded put its value in the field, a click that succeeded pressed the control. Never repeat an ok action with the same selector and value unless the tree shows the page has been reset since. Never repeat a FAILED action unchanged — change the selector or the route.',
  'Find the first part of the goal, in the goal\'s own order, that the history does not yet show as done. That part is your next action, and only that part.',
  'If the last action changed the URL (history says "now at" a different page), and the tree looks half-built or empty, use wait once before acting on the new page.',
  'Take the smallest action that advances that part: one fill, one click, one press, as "action".',
  `Then, in "next", list up to ${AGENT_PLAN_AHEAD} further actions ONLY if you are certain they follow and their controls are in THIS tree already (fill email → click Next; fill password → click Sign in). Each is verified against the live page before it runs and stops at the first that no longer fits. Leave "next" empty when the next step depends on what the page will show.`,
])}

SIGN-IN, when the goal asks for it:
- A sign-in may take two screens: an identity field and a Next / Continue
  button first, and only THEN a password field. Fill the identity, click Next,
  wait if needed, fill the password (a nameless textbox on the password screen
  is the password; input[type="password"] addresses it), click Sign in. Once
  each — a second fill of the same field with the same value is never right.
- If the URL leaves the sign-in page after the submit click, the sign-in TOOK.
  Do not go back and fill anything again. Continue with the next part of the
  goal, or finish if that was the goal.
- A consent / terms page after sign-in: click its accept control ONLY if the
  goal asks you to accept, or the goal cannot be reached without it. Say which
  in "reasoning".

WHAT THE LOOP WILL REFUSE (so answer the way it accepts, the first time):
- A destructive click (Delete, Remove…) that does not name the row the goal
  is about. When the goal names an identifier, scope the click to it
  (role=row[name="<id>" i] >> role=button[name="Delete" i]); never
  "the first Delete button" — that acts on whatever row comes first, and
  is refused every time, not re-asked.
- A selector whose name is not in the tree. Every role name and text you
  quote must be copied from a node above — the tree is the whole evidence,
  and a name that is not in it is a guess that will be sent back to you.
- An action you already did, on a page that has not changed since. "ok" in
  the history means done. Do the NEXT thing, or finish. (A repeated wait or
  scroll is let through once you insist, but it is a turn that advances
  nothing — several in a row end the run.)
- A finish when the goal names a destination and the URL is not on it. Reach
  it first; if it cannot be reached, call fail and say what stands in the way.
- A goto to any origin but the application's own.

Rules:
- Do not repeat an action that already failed — read the history and try a different route.
- Do not take destructive actions: no delete, no purchase, no irreversible submit, unless the goal explicitly asks for it.
- Call finish as soon as the goal is satisfied. Do not keep exploring, do not "double-check" by acting again.
- If the tree shows you are already where the goal describes, call finish immediately.
- Budget is the harness's concern, never yours: choose the single most useful
  next action. Call fail only when the PAGE makes the goal impossible — the
  control does not exist anywhere reachable, the account is refused, the page
  is an error — and say which in "reasoning".
- When the tree says it is TRUNCATED, absence from it is not absence from the
  page: scroll or navigate toward where the goal's control would be before
  concluding it is missing.
- A dropdown the tree lists as a BUTTON with a value (button "Gender"
  value="Select Gender") is a custom select: selectOption on
  role=button[name="Gender" i] — never role=combobox, which is not in the
  tree. Its value= is the CURRENT selection: when it already shows the option
  the goal wants, that part of the goal is done — do not select it again.
- A field the goal names that is NOT in the tree may sit inside a collapsed
  section: the tree shows the section's header (button "Personal
  Information*") with an "Expand" button beside it, or an "Expand all". Act on
  the field by its label anyway (selectOption role=button[name="Gender" i]) —
  the harness opens the section for you — or click the section's own header
  first. Never conclude the field is missing while a section is collapsed.
- A tree line ending in "readonly" is a DISPLAY, not an input: writing into it
  changes nothing. Its real input is beside it, named by the field's label
  (textbox "Hire Date" next to textbox "Select date" readonly) — fill or paste
  into THAT, and give a date input its value as YYYY-MM-DD. A date field shown
  as a BUTTON (button "Start Date" that opens a calendar dialog) is a picker:
  click it, then use the dialog's month/year controls and click the day button
  (its name is the day number); paste YYYY-MM-DD instead only if the dialog
  offers a textbox.
- When the goal says every required / mandatory / asterisked field (ครบ,
  ดอกจัน): work down the REQUIRED AND STILL EMPTY list under the tree, one
  control per turn, with a plausible value for its label (a name, a phone, a
  13-digit ID, an amount, the first option of a dropdown). Finish when that
  list is empty and the values the goal names are shown.
- To find one row in a long table, use the table's search or filter textbox
  (fill it, then wait) or the pager BEFORE scrolling. Scroll only when rows
  render lazily and each scroll shows new rows; the history says when a look
  rendered more.
- On a wizard (Step N of M / ขั้นตอนที่ N จาก M), fill the CURRENT step's fields
  the goal names, then click Next/ถัดไป; do not re-open section headers to
  find a field that belongs to the next step. A goal that says "stay on
  /path" is satisfied on any step of that path (?step=2 is the same page).
- Every "set X = Y" the goal names is checked on the page when you finish: a
  finish is refused naming the pairs the page does not show. Set each one,
  and read a dropdown's value= before you finish.`;

export function buildUserPrompt(observation: AgentObservation): string {
  // The budget is deliberately NOT shown. It is the one input that changes
  // every turn with nothing on the page changing, and the documented cause of
  // a premature `fail` ("only 3 actions remain, making it impossible"). The
  // loop owns the budget; the model owns the next action.
  //
  // ORDER IS THE TOKEN BILL. Each turn is a fresh single-shot call, so the
  // only discount available is a provider's implicit prompt cache, which
  // bills the longest byte-identical PREFIX at cache rates. The prompt is
  // therefore ordered stable-first: goal and case card (never change), then
  // the tree (changes only when the page does — on be100 the tree was ~3.3k
  // of every turn's ~3.8k input tokens, resent 560 times), and only then the
  // parts that change every turn: URL, history, feedback. History before the
  // tree — the old order — moved the first differing byte in front of the
  // tree on every single turn, so the dominant repeated bytes never cached.
  const lines = [`GOAL: ${observation.goal}`];
  if (observation.caseContext) {
    lines.push(
      '',
      'THE TEST CASE THIS STEP SERVES (context for judgment — the GOAL above is still the only thing to do):',
      observation.caseContext,
    );
  }
  lines.push('', 'Accessibility tree:', observation.axTree);
  // The form's state, summarised (OA-6): between the tree and the URL, so the
  // stable-first ordering holds — it changes only when the page does.
  if (observation.formGaps) lines.push(observation.formGaps);
  lines.push('', `Current URL: ${observation.url}`);
  if (observation.history.length > 0) {
    // Late turns do not need the verbatim log of every early action — the last
    // few carry the state that matters, and a capped list keeps turn N from
    // paying for turns 1…N-1 twice over. Eight is enough for the guards that
    // read history through the model's eyes (a repeat, a stall) to still see
    // their evidence.
    const MAX_HISTORY_LINES = 8;
    const history = observation.history;
    lines.push('', 'What you have tried:');
    if (history.length > MAX_HISTORY_LINES) {
      // The elided actions used to vanish into a count, and on a 30-field
      // form the model refilled what it could no longer see (OA-7, HIR-EC-002
      // leg 12: 18 turns, section headers re-opened, dropdowns re-picked).
      // The ledger names every control already done, once, in the line the
      // count occupied.
      lines.push(`  - ${observation.ledger ?? `(${history.length - MAX_HISTORY_LINES} earlier action(s) elided)`}`);
    }
    for (const entry of history.slice(-MAX_HISTORY_LINES)) lines.push(`  - ${entry}`);
  }
  // Feedback stays last: the re-ask then shares a byte-identical prefix with
  // the turn's first ask, and recency favours the correction.
  if (observation.feedback) {
    lines.push('', `Your previous answer for this turn was REFUSED: ${observation.feedback}`);
  }
  return lines.join('\n');
}

export interface LlmAgentModelOptions {
  /** A concrete AI SDK model. Omit to resolve the `agent` role from config. */
  model?: LanguageModel | undefined;
  id?: string | undefined;
  maxOutputTokens?: number | undefined;
  maxRetries?: number | undefined;
  factory?: LlmFactory | undefined;
}

/**
 * One structured decision per turn. Deliberately a small output — the agent
 * loop, not the model, owns budgeting and safety, so a weaker free model is
 * enough here as long as it can pick an action from the tree in front of it.
 */
export class LlmAgentModel implements AgentModel {
  readonly id: string;

  readonly #source: ModelSource;
  readonly #maxOutputTokens: number;
  readonly #maxRetries: number;

  constructor(options: LlmAgentModelOptions = {}) {
    if (options.model) {
      this.#source = { model: options.model };
      this.id = options.id ?? 'custom:agent';
      this.#maxRetries = options.maxRetries ?? 2;
    } else {
      const factory = options.factory ?? new LlmFactory();
      this.#source = { factory, role: 'agent' };
      this.id = options.id ?? factory.forRole('agent').id;
      this.#maxRetries = options.maxRetries ?? factory.maxRetries;
    }
    this.#maxOutputTokens = options.maxOutputTokens ?? 2048;
  }

  async decide(observation: AgentObservation): Promise<AgentDecision> {
    const { object, inputTokens, outputTokens } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      schema: DecisionSchema,
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(observation),
      maxOutputTokens: this.#maxOutputTokens,
      maxRetries: this.#maxRetries,
    });

    return {
      action: object.action,
      // The model is reading names out of the AX tree we gave it, and copies
      // its notation back as readily as it copies its case — `region "X"` as
      // a selector is a guaranteed miss and a turn burned. See
      // `normaliseAgentSelector` in `src/engine/selector.ts`.
      selector: normaliseAgentSelector(object.selector),
      value: object.value,
      url: object.url,
      reasoning: object.reasoning,
      next: (object.next ?? []).slice(0, AGENT_PLAN_AHEAD).map((step) => ({
        action: step.action,
        selector: normaliseAgentSelector(step.selector),
        value: step.value,
        url: step.url,
      })),
      inputTokens,
      outputTokens,
    };
  }
}

export interface WorkflowAgentOptions {
  model: AgentModel;
  /**
   * Optional hard ceiling on model turns. Unbounded by default — the loop's
   * own logic decides when to stop (finish/fail, destination reached, stall,
   * no-progress, model failure). Set this (or WOWLIDATOR_AGENT_MAX_STEPS) to
   * cap it anyway, e.g. the capture pilot's deliberately short leash.
   */
  maxSteps?: number | undefined;
  /**
   * Whether the early-give-up judges (look-only at 3, no-progress at 5) fire.
   * Defaults to `agentEarlyStopDefault()` (env). Off raises both ceilings to
   * `AGENT_NO_PROGRESS_OFF_TURNS` — the agent keeps trying much longer.
   */
  earlyStop?: boolean | undefined;
  maxAxNodes?: number | undefined;
  actionTimeoutMs?: number | undefined;
  /**
   * Origins the agent may navigate to. Defaults to the origin it started on,
   * so a confused agent cannot wander onto the public internet.
   */
  allowedOrigins?: string[] | undefined;
  /** Called after every action, for screenshot capture. */
  onAction?: ((page: Page, action: AgentAction) => Promise<void>) | undefined;
  /**
   * Perform like a person — pointer travel, hover, typing pace — for the
   * film (`engine/humanize.ts`). Same performer as the runner's steps, so an
   * agent leg looks like the steps around it. Off unless asked; the runner
   * passes its own setting per run (`RunOptions.humanize`).
   */
  humanize?: boolean | undefined;
  /** Remembered solutions; see `AgentMemory`. A run passes the cache-backed one per call. */
  memory?: AgentMemory | undefined;
}

export interface RunOptions {
  memory?: AgentMemory | undefined;
  /**
   * A per-call turn ceiling, tighter than the instance's own `maxSteps`
   * (`WorkflowAgentOptions.maxSteps` / `DEFAULT_AGENT_MAX_STEPS`) — never
   * looser: the effective cap is `Math.min` of the two. For a caller that
   * knows THIS leg has already spent its retry budget (a pre-run fail-fast
   * risk verdict — `run-cases.ts`'s `failFastRunOptions`) and wants a
   * shorter leash on the one shot it still gets, without lowering every
   * other leg's instance-wide budget.
   */
  maxSteps?: number | undefined;
  /**
   * Look, never touch. Every action that could change the application —
   * click, fill, press, hover, goto, dbCount — is refused before it runs;
   * only `wait`, `scroll`, `finish` and `fail` are left.
   *
   * The rung this exists for asks the agent a READING question ("where on
   * this page is the value for that label?") and verifies the answer
   * deterministically afterwards. The ladder's standing rule is that an
   * assertion is never offered the agent, because "a claim it made true
   * proves nothing" — and that rule is about ACTING. Forbidding action
   * structurally is what makes a reading question safe to ask of an
   * assertion, rather than a promise in a prompt a model may quietly break.
   */
  readOnly?: boolean | undefined;
  /**
   * Which actions this run may take at all. `readOnly: true` is the strictest
   * form (`READ_ONLY_ACTIONS`) and wins over this; `REVEAL_ACTIONS` is the
   * healing pass offered to an assertion — it may open, focus and navigate to
   * what already exists, but never type. Absent means the full vocabulary.
   */
  allowedActions?: ReadonlySet<string> | undefined;
  /**
   * The test case this workflow step serves — claim, expected output, persona
   * — a compact card stamped on the flow at authoring (`Flow.caseContext`).
   * Context, never instructions: the goal stays the only thing the agent
   * pursues, but a model that knows the claim stops rediscovering what the
   * spec already states (measured on be100: turns spent proving a filter
   * absent that the sheet's own note says was removed).
   */
  caseContext?: string | undefined;
  /**
   * A deterministic script recorded on the flow's own `workflow` step by an
   * earlier successful run (see `withWorkflowScripts`). Tried after the
   * cache-backed memory and before any model turn, under the same replay
   * rules: every selector must still ground in the live tree, and a named
   * destination must actually be reached. Unlike memory, the script travels
   * in the flow file — it survives a cleared cache and a different machine.
   */
  script?: readonly PlanStep[] | undefined;
  /**
   * Read-only database access for the `dbCount` action: count the rows of
   * `table` matching the `where` equalities, through the run's own grounded
   * read-only session (the runner wires this to its `DbActions`). Throws
   * with a human-readable reason on grounding or availability problems —
   * the message goes into the agent's history as the action's failure.
   * Absent when no database is configured, and `dbCount` then fails with
   * advice to verify through the page instead.
   */
  dbProbe?: AgentDbProbe | undefined;
  /**
   * The persona LABEL this leg runs as, when the run has personas at all.
   *
   * It is used for exactly one thing — scoping the replay memory's key (see
   * `replayKey`) — and for nothing else. It is never put in a prompt, never
   * offered to the model, and carries no email and no password: the agent has
   * no sign-in verb and no credentials by design, and this must not become the
   * hole in that. Absent on a single-persona run, which keeps its cache keys
   * exactly as they were.
   */
  persona?: string | undefined;
  /**
   * Where a `save` action puts the value it read (OA-8): the runner wires
   * this to its `VariableStore.set`, so later steps interpolate `{{name}}`.
   * Absent on a run with no store — the action still records what it read
   * (the history line and the observation), it just has nowhere to keep it.
   */
  saveVariable?: ((name: string, value: string) => void) | undefined;
  /** Perform like a person for this run; overrides the constructor's `humanize`. */
  humanize?: boolean | undefined;
}

/** See `RunOptions.dbProbe`. The observed count is evidence; a thrown message is the failure. */
export type AgentDbProbe = (table: string, where: Record<string, string>) => Promise<number>;

/** `"status=ACTIVE, type=HR"` → `{ status: 'ACTIVE', type: 'HR' }`. */
export function parseWherePairs(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of value.split(',')) {
    const trimmed = pair.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) throw new Error(`dbCount where must be "column=value" pairs — could not read ${JSON.stringify(trimmed)}`);
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/**
 * The replayable part of an agent journey: the actions that succeeded, minus
 * the model's own `finish`/`fail` (a replay re-proves arrival against the
 * page, not against a claim) and `wait` (it waits on state that replay
 * timing won't reproduce). The single writer for both persistence paths —
 * `AgentMemory` entries and the flow file's `script` field.
 */
export function scriptOf(actions: readonly AgentAction[]): PlanStep[] {
  return actions
    .filter((a) => a.ok && a.action !== 'finish' && a.action !== 'fail' && a.action !== 'wait')
    .map((a) => ({
      action: a.action as AgentActionKind,
      selector: a.selector ?? '',
      value: a.value ?? '',
      // For a goto the recorded url is where it landed, which is the target.
      url: a.action === 'goto' ? a.url : '',
    }));
}

/**
 * What a `read` or `save` saw, kept on the record (OA-14). ~250 sheet lines
 * say "ให้รันจริงแล้วบันทึกค่าที่ระบบแสดง" — the observed value IS the
 * deliverable, and it used to ride one history line and vanish. `text` is
 * the control's text/value with its state facts, capped at
 * `READ_OBSERVATION_CHARS`.
 */
export interface AgentObservationRecord {
  selector: string;
  text: string;
  url: string;
}

/**
 * `AgentAction` plus what a `read`/`save` observed. Structural on purpose:
 * `AgentAction` lives in `engine/proof-bundle.ts` (the reporter's), and this
 * compiles whether or not that interface has gained the field yet — the
 * value is on the record either way.
 */
export interface ObservedAgentAction extends AgentAction {
  observed?: string | undefined;
}

export interface WorkflowResult extends AgentRecord {
  /** Every `read`/`save` observation of the leg, in order — see `AgentObservationRecord`. */
  observations?: AgentObservationRecord[] | undefined;
}

/**
 * `DONE so far (12 actions): fill Bank="Kasikorn" · selectOption
 * Currency="THB" · check Probation Exemption · click Next(x2) …` — the ok
 * interactions of the leg so far, one entry per control (the last value
 * wins; repeated activations are counted), password-shaped values masked,
 * capped at `DONE_LEDGER_CHARS`. Built from the actions, never from history
 * strings, so it survives the history cap that made a 40-field form refill
 * itself (OA-7). Null when nothing has been done.
 */
export function doneLedger(actions: readonly AgentAction[], cap = DONE_LEDGER_CHARS): string | null {
  const done = actions.filter((a) => a.ok && INTERACTION_ACTIONS.has(a.action));
  if (done.length === 0) return null;
  const entries = new Map<string, { label: string; count: number }>();
  for (const a of done) {
    const selector = a.selector ?? '';
    const name = selectorName(selector) ?? selector;
    const key = `${a.action} ${selector}`;
    const value =
      a.value === null || a.value === ''
        ? ''
        : /password|passwd|pwd/i.test(selector)
          ? `•••• (${a.value.length} chars)`
          : JSON.stringify(a.value);
    const label = `${a.action}${name ? ` ${name}` : ''}${value ? `=${value}` : ''}`;
    entries.set(key, { label, count: (entries.get(key)?.count ?? 0) + 1 });
  }
  const parts = [...entries.values()].map((e) => (e.count > 1 ? `${e.label}(x${e.count})` : e.label));
  const text = `DONE so far (${done.length} actions): ${parts.join(' · ')}`;
  return text.length > cap ? `${text.slice(0, cap - 1)}…` : text;
}

/** One line of a full rendered tree, hashed — the progress judge's "did the look show more?" (OA-10). */
function treeKeyOf(nodes: readonly AxNode[]): string {
  return createHash('sha1').update(renderTree(nodes, nodes.length)).digest('hex');
}

/** The goals whose prompt tree earns the larger budget — see `FORM_AGENT_MAX_NODES`. */
const FORM_GOAL = /required|mandatory|ครบ|every field|all fields|ดอกจัน/iu;

/**
 * Is the control an outcome names on this page at all — every word of it on
 * one line of the rendered tree, the same reading `outcomeShown` makes? An
 * outcome whose control is nowhere cannot be judged on this page; see the
 * finish settlement in `run()`.
 */
function controlOnPage(control: string, tree: string): boolean {
  const words = control.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (words.length === 0) return false;
  return tree.split('\n').some((line) => {
    const l = line.toLowerCase();
    return words.every((w) => l.includes(w));
  });
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

const AGENT_LOCALE_SEGMENT = /^[a-z]{2}([-_][a-z0-9]{2,4})?$/i;

export function deploymentAwareAgentUrl(targetUrl: string, currentUrl: string): string {
  try {
    const target = new URL(targetUrl);
    const current = new URL(currentUrl);
    if (target.origin !== current.origin) return targetUrl;

    const targetSegments = target.pathname.split('/').filter(Boolean);
    const currentSegments = current.pathname.split('/').filter(Boolean);
    const targetLocaleIndex = targetSegments.findIndex((segment) => AGENT_LOCALE_SEGMENT.test(segment));
    const currentLocaleIndex = currentSegments.findIndex((segment) => AGENT_LOCALE_SEGMENT.test(segment));
    if (targetLocaleIndex !== 0 || currentLocaleIndex <= 0) return targetUrl;

    target.pathname = `/${[
      ...currentSegments.slice(0, currentLocaleIndex),
      ...targetSegments,
    ].join('/')}`;
    return target.toString();
  } catch {
    return targetUrl;
  }
}

/** Every origin an absolute URL in the goal's text points at. */
function originsNamedIn(goal: string): string[] {
  const out: string[] = [];
  for (const match of goal.matchAll(/\bhttps?:\/\/[^\s"'<>()\]]+/gi)) {
    const origin = originOf(match[0].replace(/[.,;:!?)\]'"]+$/, ''));
    if (origin !== null && !out.includes(origin)) out.push(origin);
  }
  return out;
}

export class WorkflowAgent {
  readonly model: AgentModel;

  readonly #maxSteps: number;
  /** No-progress ceiling: 5 with early-stop on, AGENT_NO_PROGRESS_OFF_TURNS off. */
  readonly #noProgressTurns: number;
  /** Look-only soft-handoff turns: 3 with early-stop on, the same ceiling off. */
  readonly #lookOnlyTurns: number;
  /** Off-page allowance: AGENT_OFF_PAGE_TURNS with early-stop on, the same ceiling off. */
  readonly #offPageTurns: number;
  readonly #maxAxNodes: number;
  readonly #actionTimeoutMs: number;
  /** Perform like a person for this run; see `WorkflowAgentOptions.humanize`. */
  #humanize: boolean;
  readonly #allowedOrigins: string[] | undefined;
  readonly #onAction: ((page: Page, action: AgentAction) => Promise<void>) | undefined;
  readonly #memory: AgentMemory | undefined;

  constructor(options: WorkflowAgentOptions) {
    this.model = options.model;
    this.#maxSteps = options.maxSteps ?? DEFAULT_AGENT_MAX_STEPS;
    const earlyStop = options.earlyStop ?? agentEarlyStopDefault();
    this.#noProgressTurns = earlyStop ? AGENT_NO_PROGRESS_TURNS : AGENT_NO_PROGRESS_OFF_TURNS;
    this.#lookOnlyTurns = earlyStop ? AGENT_LOOK_ONLY_TURNS : AGENT_NO_PROGRESS_OFF_TURNS;
    this.#offPageTurns = earlyStop ? AGENT_OFF_PAGE_TURNS : AGENT_NO_PROGRESS_OFF_TURNS;
    this.#maxAxNodes = options.maxAxNodes ?? DEFAULT_AGENT_MAX_NODES;
    this.#actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_AGENT_ACTION_TIMEOUT_MS;
    this.#allowedOrigins = options.allowedOrigins;
    this.#onAction = options.onAction;
    this.#memory = options.memory;
    this.#humanize = options.humanize ?? false;
  }

  /**
   * Drive `page` until `goal` is met or the budget runs out. Always resolves —
   * failure is reported in the record, never thrown, so the run can continue
   * and the report can show what the agent tried.
   */
  async run(page: Page, goal: string, runOptions: RunOptions = {}): Promise<WorkflowResult> {
    const startedMs = Date.now();
    if (runOptions.humanize !== undefined) this.#humanize = runOptions.humanize;
    // Reset here, not at declaration: the agent is one instance shared across
    // every workflow step of a run, and a flag that stuck from a PRIOR step's
    // goal would mark every step after a looked-only one the same way,
    // whether or not it was.
    this.#lookedOnly = false;
    this.#settledBy = null;
    const memory = runOptions.memory ?? this.#memory;
    // What this run may do at all: `readOnly` is the strictest form, an
    // explicit set is the middle ground (the reveal pass), absent is the full
    // vocabulary. Enforced before a decision is acted on, so a restriction is
    // a guarantee rather than a line in a prompt.
    const allowedActions: ReadonlySet<string> | null =
      runOptions.readOnly === true ? READ_ONLY_ACTIONS : (runOptions.allowedActions ?? null);
    this.#dbProbe = runOptions.dbProbe ?? null;
    this.#saveVariable = runOptions.saveVariable ?? null;
    this.#goal = goal;
    this.#lastTree = null;
    this.#lastObserved = null;
    this.#observations = [];
    // The prompt's node budget for THIS goal (OA-3): a form-shaped goal gets
    // the larger one, because the focused tree was cutting the very controls
    // it named. The full tree is captured every turn regardless; only what
    // the model is SHOWN is budgeted.
    const maxNodes =
      goalOutcomes(goal).length >= 3 || FORM_GOAL.test(goal)
        ? Math.max(this.#maxAxNodes, FORM_AGENT_MAX_NODES)
        : this.#maxAxNodes;
    // A per-call ceiling can only LOWER the instance's own budget, never
    // raise it — `runOptions.maxSteps` exists for a caller that knows this
    // particular leg has already spent its retry budget (a fail-fast risk
    // verdict, `run-cases.ts`'s `failFastRunOptions`) and wants a tighter
    // leash on the one shot it still gets, not for widening a leash someone
    // else set deliberately.
    const effectiveMaxSteps =
      runOptions.maxSteps !== undefined ? Math.min(this.#maxSteps, runOptions.maxSteps) : this.#maxSteps;
    const actions: AgentAction[] = [];
    const history: string[] = [];
    // The origins the agent may navigate to: the caller's list, else the page
    // it started on, else whatever origin the GOAL itself names. An empty
    // list used to mean "anywhere" by way of a short-circuit (`allowed.length
    // > 0 && …`) — a page on about:blank let a confused agent leave for the
    // public internet. Empty now means no goto at all, which is the safe
    // reading of "nobody said where".
    const allowed =
      this.#allowedOrigins ??
      [originOf(page.url()), ...originsNamedIn(goal)].filter((o): o is string => !!o);
    // Where the step began, for the one check that can end the budget early.
    // Read once: every later comparison is against the state the goal was
    // handed, not against the previous turn.
    const startUrl = page.url();

    let turns = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let success = false;
    let summary = 'agent stopped without reaching the goal';
    // Consecutive turns in which nothing succeeded. The stop that replaced the
    // turn ceiling: reset by any ok action, so it can only end a loop that is
    // demonstrably not advancing.
    let turnsWithoutProgress = 0;
    // One informed refusal of a finish the live tree contradicts (S1).
    let finishRefusedForState = false;

    // What has been DONE and not undone: the key of every ok action, cleared
    // whenever the URL moves (a new page is a new state, and the same click
    // may be right again there).
    const doneHere = new Set<string>();
    // Ok activations (click or press) per selector for the WHOLE run, never
    // cleared: the guard for a control the agent keeps toggling or stepping
    // through, which resets both `doneHere` (the tree changes each time) and
    // the per-URL state (see `repeatedToggleClick`).
    const okClicks = new Map<string, number>();
    // Interstitials this loop has already cleared-and-returned from — once
    // per distinct accept, so a gate that will not stay cleared becomes a
    // recorded stall rather than a loop (spec F2's guard).
    const interstitialReturns = new Set<string>();
    // Whether the agent has done anything BEYOND clearing gates. An accept
    // that fires before any real work is an obstacle in front of the step's
    // own page (PL_02_05's shape — return to it); one that fires after the
    // agent already advanced is a gate ON THE WAY somewhere (the
    // two-interstitials journey — returning would destroy the progress).
    let progressMade = false;
    // Whether any action that ENGAGES a control ever landed (INTERACTION_ACTIONS).
    // A leg that never does has found nothing the goal names — the broadened
    // reading/unreachable handoff below keys on this. PL_07_03 (2026-08-27):
    // three legs hunting a filter combobox that is not in the tree, every
    // click a 1.5 s miss, never one ok interaction — 77 s of stall for a leg
    // the following assertion answers in 2 s.
    let interactedEver = false;
    // URLs this leg has already been on. A `goto` back to one of them is a
    // reload, not forward progress, and must not reset the no-progress judge —
    // the measured legs reloaded the plans page repeatedly to "get a clean
    // tree", buying five fresh turns each time and never converging.
    const visitedUrls = new Set<string>([startUrl]);
    let lastUrlSeen = startUrl;
    // Selectors already activated (ok) on each URL this leg, and what kind
    // of activation each recorded action was (`reactivation`): a repeat on
    // the same page is progress only if the tree changed, and text typed
    // again into the same field never is — ec09 leg [14]'s section headers,
    // the job-2 Position picker's search box (2026-09-03).
    const activatedHere = new Set<string>();
    const reactivations = new Map<number, Reactivation>();
    // Turns spent off the step's page short of anything the goal names
    // (`wanderedOffPage`), reset on returning — the HIR-EC-002 wander.
    let offPageTurns = 0;
    // Where the agent is going: the step's page until a goto asks for
    // another. A gate cleared mid-run returns here, never to the app's home.
    let intendedUrl = startUrl;
    const destination = goalDestination(goal);

    // **One session cannot be two people** (OA-15). A goal that names a
    // second persona — "submit as employee, then the manager approves"
    // (ML_01_06, PRB manager→HRBP→HR admin, consent admin↔employee) — has
    // one credential pair, one sign-out, and a finish rule that judges one
    // page; the agent either stalls on the sign-in form or is refused a
    // finish, at model turns each, to learn what the wording already said.
    // Refused up front as a SUMMARY (never a throw — `run()` never throws)
    // whose `multi-persona goal:` prefix is the protocol `run-cases` reads as
    // an authoring refusal, not a failed step. A read-only look is exempt:
    // it acts as nobody.
    const personas = runOptions.readOnly === true ? null : multiPersonaGoal(goal);
    if (personas !== null) {
      history.push(`(the goal names ${personas.join(' and ')}; one session cannot be both — refused before the first turn)`);
      return this.#result(goal, false, multiPersonaSummary(personas), actions, 0, startedMs, 0, 0, effectiveMaxSteps);
    }

    // ---- Zero-call rungs, in cost order, before any model turn ----------
    //
    // Measured across 81 workflow steps: 3.8 model turns each, ~3,350 input
    // tokens a turn — the single largest token sink in a run and the role
    // that trips a per-minute quota first. Most of those turns were spent
    // on legs that need no judgment at all: a goal this run (or an earlier
    // one) already solved on this page, a consent gate standing in front of
    // the page, a link in the tree that points exactly where the goal ends.
    // Each is handled here deterministically and recorded as an action, so
    // the model is asked only for the part that genuinely needs it.
    const key = /^https?:/.test(startUrl) ? replayKey(startUrl, goal, runOptions.persona) : null;
    const remembered = key !== null && memory ? memory.get(key) : undefined;
    if (remembered && remembered.length > 0) {
      const replayed = await this.#replay(page, remembered, allowed, actions, history, startUrl, goal);
      if (replayed === null) {
        summary = `replayed ${remembered.length} recorded action(s) from an earlier run that reached this goal — no model turn spent`;
        return this.#result(goal, true, summary, actions, 0, startedMs, 0, 0, effectiveMaxSteps);
      }
      memory?.forget(key as string);
      history.push(`(a remembered solution was replayed and failed at action ${replayed + 1}; asking the model)`);
    }
    // The flow file's own recorded script — the same rung with a different
    // home. Skipped when it is byte-identical to the memory that just failed:
    // replaying the same steps twice teaches nothing and spends a page load.
    const script = runOptions.script;
    if (
      script &&
      script.length > 0 &&
      JSON.stringify(script) !== JSON.stringify(remembered ?? null)
    ) {
      const replayed = await this.#replay(page, script, allowed, actions, history, startUrl, goal);
      if (replayed === null) {
        this.#remember(key, memory, actions);
        summary = `replayed ${script.length} scripted action(s) recorded on the flow itself — no model turn spent`;
        return this.#result(goal, true, summary, actions, 0, startedMs, 0, 0, effectiveMaxSteps);
      }
      history.push(`(the flow's recorded script failed at action ${replayed + 1}; asking the model)`);
    }
    // **The state the goal describes is already showing.** The cheapest rung
    // of all: no model call, no action, no turn. Measured (be100,
    // 2026-08-26) six of ten agent runs in one pass ended after one or two
    // turns having found the dialog the goal asked for already open — the
    // authored step before them had opened it. Asking the tree first turns
    // that whole leg into a lookup.
    const showing = goalAlreadyShowing(goal, await captureAxNodes(page, Number.MAX_SAFE_INTEGER));
    if (showing !== null) {
      history.push(`(the goal's own surface "${showing}" is already showing; nothing to do)`);
      return this.#result(
        goal,
        true,
        `"${showing}" is already open — the state this goal describes was reached before the leg began, so no model turn was spent`,
        actions,
        0,
        startedMs,
        0,
        0,
        effectiveMaxSteps,
      );
    }

    const preflight = await this.#preflight(
      page,
      goal,
      startUrl,
      destination,
      allowed,
      actions,
      history,
      allowedActions === null || allowedActions.has('click'),
    );
    if (preflight !== null) {
      this.#remember(key, memory, actions);
      return this.#result(goal, true, preflight, actions, 0, startedMs, 0, 0, effectiveMaxSteps);
    }
    progressMade = actions.some((a) => a.ok && a.action !== 'wait' && a.action !== 'scroll' && !/consent gate/.test(a.reasoning));

    // The rendered tree the last turn saw. "Already done" holds only while
    // the page is UNCHANGED — the guard's own stated rule — and the URL is
    // too coarse a proxy for that: picking one entry of a multi-select leaves
    // the URL alone while the page visibly moves on, and re-opening the same
    // dropdown for the next entry is then the RIGHT action. Measured (be100
    // PL_03_17, live): a Company multi-select needing three picks was refused
    // as a stall on its second open. A fill into a field whose value the tree
    // cannot show (a password) changes nothing here, so PB_03_01's repeated
    // password fills stay refused.
    let lastTreeSeen: string | null = null;

    // See `AGENT_VALUE_HUNT_TURNS`: EVERY value a `set X to Y` goal names
    // (OA-4), and whether any of them has shown up in a tree this leg has
    // looked at. A key-in leg naming five fields spends its early turns on
    // the first two, and a judge watching one value would have ended it
    // while it was working — so the judge fires only when NONE has appeared.
    // Judged against the FULL tree (OA-3), which is never truncated, so the
    // old "a cut tree withdraws the judge" clause has nothing left to guard.
    const huntedValues = goalCitedValues(goal);
    let huntedValueSeen = false;
    // OA-10: the full tree's hash at the top of the turn, and how many looks
    // have been credited as progress for changing it.
    let treeKey: string | null = null;
    let treeChangeCredits = 0;

    for (;;) {
      // A configured ceiling still holds (the capture pilot's short leash,
      // WOWLIDATOR_AGENT_MAX_STEPS); the default is no ceiling at all, and
      // then only the logic below — finish/fail, arrival, a stall, no
      // progress, a model failure — ends the loop.
      if (turns >= effectiveMaxSteps) {
        summary = `agent gave up after ${turns} turns without reaching the goal`;
        break;
      }
      turns += 1;

      // A gate the session steered the agent into since the last turn is
      // cleared here, on the URL's say-so alone (the content check every
      // turn would cost a locator pass on pages that have no gate); the
      // preflight keeps the content-based detection for the page a gate
      // renders in place on.
      if (CONSENT_GATE_URL_PATTERN.test(page.url())) {
        // Where to go once the gate is cleared: the page a goto asked for
        // and was redirected away from; the step's own page when nothing
        // has been done yet; nowhere — stay where the accept lands — when
        // the gate stands on the way of a journey already under way.
        const returnTo = intendedUrl !== startUrl ? intendedUrl : progressMade ? null : startUrl;
        const gate = await this.#clearConsentGate(page, goal, startUrl, returnTo, actions, history, `on turn ${turns}`);
        if (gate === 'arrived') {
          success = true;
          summary = `reached ${page.url()}, the destination the goal names, after clearing a consent gate on turn ${turns}`;
          break;
        }
      }
      if (page.url() !== lastUrlSeen) {
        doneHere.clear();
        lastUrlSeen = page.url();
      }
      // Where this turn begins, once any gate is cleared: the off-page
      // judge measures the turn's own move against it.
      const turnUrl = page.url();
      // Goal-focused: the nodes the goal names survive the budget cut. The
      // FULL tree is rendered too (bytes, never tokens — it is not sent to
      // the model): the judges and the wizard hint read it (OA-3, OA-11).
      const all = await captureAxNodes(page, Number.MAX_SAFE_INTEGER);
      const fullTree = renderTree(all, all.length);
      this.#lastTree = fullTree;
      treeKey = createHash('sha1').update(fullTree).digest('hex');
      const axTree = renderTree(focusTree(all, goal, maxNodes), all.length);
      if (lastTreeSeen !== null && axTree !== lastTreeSeen) doneHere.clear();
      lastTreeSeen = axTree;
      // The required controls still empty (OA-6) — a separate observation
      // field, so settlement and the value hunt never read it as tree text.
      const gapsLine = formatFormGaps(formGaps(all));
      // What has been DONE across the whole leg (OA-7), for the prompt's
      // elision slot — built from the actions, so the history cap cannot
      // hide a filled field from the model.
      const ledger = doneLedger(actions);

      // The value-hunt guard: a goal naming concrete values none of which
      // has shown up ANYWHERE after several turns is evidence the values are
      // not reachable from here, however many still-successful clicks keep
      // landing on other controls. See `AGENT_VALUE_HUNT_TURNS`.
      if (huntedValues.length > 0 && !huntedValueSeen && anyValueAppears(huntedValues, fullTree)) {
        huntedValueSeen = true;
      }
      if (huntedValues.length > 0 && !huntedValueSeen && turns > AGENT_VALUE_HUNT_TURNS) {
        const named =
          huntedValues.length === 1
            ? `value ${JSON.stringify(huntedValues[0])}`
            : `values ${huntedValues.map((v) => JSON.stringify(v)).join(', ')}`;
        summary =
          `agent gave up: the goal's ${named} never appeared on any of the ` +
          `${turns} page state(s) this leg observed — it may not exist on this journey, rather than merely ` +
          'being hard to reach';
        break;
      }

      // One decision per turn, with at most ONE informed re-ask when the
      // first answer is one the loop can see is wasted: a selector that names
      // nothing in the tree, an ok action repeated on an unchanged page, a
      // finish that the goal's own destination contradicts. The re-ask is
      // the whole value — it is the first ask that knows what was wrong.
      let decision: AgentDecision | null = null;
      let feedback: string | undefined;
      let refusedTurn = false;
      for (let ask = 0; ask < 2 && decision === null; ask += 1) {
        let candidate: AgentDecision;
        try {
          candidate = await this.model.decide({
            goal,
            url: page.url(),
            axTree,
            ...(runOptions.caseContext === undefined ? {} : { caseContext: runOptions.caseContext }),
            ...(gapsLine === null ? {} : { formGaps: gapsLine }),
            // Snapshot: the agent keeps mutating `history`, and an observation
            // handed to the model must not change under it after the fact.
            history: [...history],
            ...(ledger === null ? {} : { ledger }),
            stepsRemaining: effectiveMaxSteps - turns,
            ...(feedback === undefined ? {} : { feedback }),
          });
        } catch (error) {
          summary = `agent model failed: ${describe(error)}`;
          return this.#result(goal, false, summary, actions, turns, startedMs, inputTokens, outputTokens, effectiveMaxSteps);
        }
        inputTokens += candidate.inputTokens ?? 0;
        outputTokens += candidate.outputTokens ?? 0;

        const refusal =
          (allowedActions !== null && !allowedActions.has(candidate.action)
            ? `"${candidate.action}" is not available to this run — it may only ` +
              `${[...allowedActions].filter((one) => one !== 'finish' && one !== 'fail').join(', ')}. ` +
              'Use one of those, or answer now with finish or fail'
            : null) ??
          this.#refuse(candidate, axTree, doneHere, okClicks, destination, page.url(), ask, goal);
        if (refusal === null) {
          decision = candidate;
        } else if (ask === 0) {
          feedback = refusal;
          history.push(`(refused before acting: ${refusal})`);
        } else {
          // Refused twice. The cheapest honest outcome for each kind: a
          // repeated action is a STALL, not a turn worth spending; an
          // ungrounded selector or a contradicted finish falls through to act
          // and fail fast, which is evidence the model can read next turn.
          if (refusal.startsWith('stalled')) {
            summary = `agent ${refusal}`;
            actions.push(this.#record(actions.length, candidate, page.url(), false, 0, refusal));
            return this.#result(goal, false, summary, actions, turns, startedMs, inputTokens, outputTokens, effectiveMaxSteps);
          }
          if (refusal.startsWith('destructive') || refusal.startsWith('circling')) {
            // Never acted on, however the model insists: recorded as a
            // failed action so the report shows what was refused and why,
            // and the turn counts as no progress — the run goes on, because
            // the right row may still be found (or `fail` said honestly).
            // `circling` (the same selector clicked or pressed past
            // TOGGLE_CLICK_LIMIT) shares the shape: acting would spend the
            // turn re-learning what three earlier activations already proved.
            actions.push(this.#record(actions.length, candidate, page.url(), false, 0, refusal));
            history.push(`${candidate.action} ${candidate.selector} — REFUSED: ${refusal}`);
            refusedTurn = true;
            break;
          }
          if (candidate.action === 'finish') {
            // An unverified finish is recorded as one — never as success.
            summary = `agent claimed finish, but ${refusal}`;
            actions.push(this.#record(actions.length, candidate, page.url(), false, 0, refusal));
            return this.#result(goal, false, summary, actions, turns, startedMs, inputTokens, outputTokens, effectiveMaxSteps);
          }
          decision = candidate;
        }
      }
      if (decision === null) {
        if (refusedTurn) {
          turnsWithoutProgress += 1;
          if (turnsWithoutProgress >= this.#noProgressTurns) {
            summary =
              `agent stalled: nothing advanced in ${turnsWithoutProgress} consecutive turns` +
              ` (last refusal: ${actions[actions.length - 1]?.error ?? ''})`;
            break;
          }
        }
        continue;
      }

      if (decision.action === 'finish') {
        // **A finish is accepted on the page's word, not the model's.** When
        // the goal names an end state (`goalOutcome`), the live tree is
        // re-read and must show it. A miss is refused ONCE with what the tree
        // actually shows; a second insistence is recorded as a claimed
        // finish that the page contradicts — the same shape as the
        // contradicted-destination rule. A goal naming no state falls
        // through, and the record says the success rests on the claim.
        // A readOnly run cannot act, so refusing its finish to make it "set"
        // the state is a turn burnt by construction — and its finish IS the
        // answer (the triage look's verdict travels in it). Found live: the
        // triage look's goal text parses as an outcome, the settlement
        // refused the verdict once, and every fail verdict cost two model
        // calls instead of one.
        //
        // EVERY `set X = Y` the goal names must be shown (OA-4), and it is
        // judged against the FULL live tree (OA-3): the focused 60-node tree
        // was always marked truncated at settlement, so on any page bigger
        // than the budget the check declined and the finish rode the claim.
        // The full tree costs bytes, never tokens — it is not sent anywhere.
        //
        // An outcome whose CONTROL is nowhere on this page — not one of its
        // words on any line, nor its value anywhere — cannot be judged here
        // and is left out of the settlement: a pair the parser read out of
        // prose ("then stop:\n- If the page…" is `stop = "- If the page"` to
        // it — the capture pilot's own goal), or a field that lives on the
        // page a submit leads to. A control that IS on the page and shows
        // another value stays a refusal. When nothing is judgeable the
        // record says so and the finish rides the claim, visibly.
        const named = runOptions.readOnly === true ? [] : goalOutcomes(goal);
        const liveTree = named.length === 0 ? '' : await this.#fullTree(page);
        const outcomes = named.filter((o) => controlOnPage(o.control, liveTree) || valueAppearsAnywhere(o.value, liveTree));
        const settled = outcomes.length === 0 ? null : outcomesShown(outcomes, liveTree);
        if (named.length > 0 && outcomes.length === 0) {
          this.#settledBy = {
            rule: 'agent-claim',
            evidence: `${decision.reasoning.slice(0, 200)} (none of the goal's named controls — ${named.map((o) => o.control).join(', ')} — is on this page, so the pairs could not be judged here)`,
          };
        } else if (outcomes.length > 0 && settled !== null) {
          if (settled.missing.length > 0) {
            const missing = describeOutcomes(settled.missing);
            if (!finishRefusedForState) {
              finishRefusedForState = true;
              const reason =
                `the page does not show ${missing} — no node in the current tree shows ${settled.missing.length === 1 ? 'that pair' : 'those pairs'}; ` +
                'read the control (action "read") and set it, or call fail and say what the page shows instead';
              history.push(`(refused finish: ${reason})`);
              actions.push(this.#record(actions.length, decision, page.url(), false, 0, reason));
              turnsWithoutProgress += 1;
              continue;
            }
            summary = `agent claimed finish, but the page does not show ${missing}`;
            actions.push(this.#record(actions.length, decision, page.url(), false, 0, summary));
            return this.#result(goal, false, summary, actions, turns, startedMs, inputTokens, outputTokens, effectiveMaxSteps);
          }
          this.#settledBy = { rule: 'observed-state', evidence: settled.shown.map((s) => s.line).join(' | ') };
        } else {
          this.#settledBy = { rule: 'agent-claim', evidence: decision.reasoning.slice(0, 200) };
        }
        success = true;
        summary = decision.reasoning;
        actions.push(this.#record(actions.length, decision, page.url(), true, 0));
        break;
      }

      if (decision.action === 'fail') {
        summary = `agent reported the goal is unreachable: ${decision.reasoning}`;
        actions.push(this.#record(actions.length, decision, page.url(), false, 0));
        break;
      }

      // The decision plus whatever it planned after itself. A follow-up is
      // executed only while it still grounds in the LIVE tree and is not
      // already done — the page after the first action is not the page the
      // plan was written on — and the first follow-up that fails or no longer
      // grounds hands control back to the model. Follow-ups cost no turn.
      const queue: AgentDecision[] = [
        decision,
        ...(decision.next ?? []).map((step) => ({ ...step, reasoning: `planned after: ${decision.reasoning}` })),
      ];
      const turnStart = actions.length;
      let arrived = false;
      // The page's own enumeration ended the leg — see `cannotOffer` below.
      let stopped = false;
      for (let q = 0; q < queue.length && !arrived; q += 1) {
        const current = queue[q]!;
        if (q > 0) {
          if (current.action === 'finish' || current.action === 'fail') break;
          const liveTree = renderTree(
            focusTree(await captureAxNodes(page, Number.MAX_SAFE_INTEGER), goal, this.#maxAxNodes),
            0,
          );
          if (current.selector !== '' && selectorGrounded(current.selector, liveTree) === false) {
            history.push(`(planned ${current.action} ${current.selector} skipped: not in the tree after the previous action)`);
            break;
          }
          if (doneHere.has(decisionKey(current))) break;
          if (page.url() !== lastUrlSeen) {
            doneHere.clear();
            lastUrlSeen = page.url();
          }
        }

        const actionStarted = Date.now();
        const urlBefore = page.url();
        let ok = true;
        let error: string | undefined;
        // **An enumerated list that lacks the goal's value is evidence**
        // (`listboxCannotOffer`, 2026-09-03, ec09 HIR-EC-009 leg [23]). A
        // `selectOption` that opened the goal's control, read its WHOLE list
        // and found the goal's own value on none of its options has observed
        // what the page can offer. The pick is retried once at $0 after the
        // page settles — a list still loading is not a list without the
        // option (the same control offered "F — DVT" three minutes later in
        // the same run) — and a second, identical enumeration ends the leg
        // without another model turn: the page's state is the verdict, and
        // the flow's next assertion carries it.
        let cannotOffer: { control: string; value: string; shown: string[] } | null = null;

        try {
          await this.#act(page, current, allowed);
        } catch (caught) {
          ok = false;
          error = describe(caught);
          const missing =
            caught instanceof ListboxOptionMissingError && !caught.filtered
              ? listboxCannotOffer(current, caught.shown, goal)
              : null;
          if (missing !== null) {
            await page.waitForLoadState('networkidle', { timeout: NETWORK_SETTLE_MS }).catch(() => undefined);
            await page.waitForTimeout(WAIT_SETTLE_MS).catch(() => undefined);
            try {
              await this.#act(page, current, allowed);
              ok = true;
              error = undefined;
            } catch (again) {
              error = describe(again);
              if (again instanceof ListboxOptionMissingError && !again.filtered && sameOptions(again.shown, missing.shown)) {
                cannotOffer = missing;
              }
            }
          }
        }

        const record = this.#record(
          actions.length,
          current,
          page.url(),
          ok,
          Date.now() - actionStarted,
          error,
          this.#takeObserved(),
        );
        actions.push(record);
        // What the model needs to not repeat itself: WHICH value went into
        // WHICH field, and whether the page moved. Without the value, four
        // password fills read as four identical "fill role=textbox — ok" lines
        // and the model cannot tell it already typed the thing (PB_03_01,
        // live). A password-shaped value is masked to its length — the model
        // knows what it typed; the record must not.
        const target = current.selector || current.url;
        const typed =
          current.action === 'fill' && current.value !== ''
            ? ` = ${/password|passwd|pwd/i.test(current.selector) ? `•••• (${current.value.length} chars)` : JSON.stringify(current.value)}`
            : '';
        // "still on the page, now at ?step=2" for a query-only change (OA-9):
        // told "moved …/hire → …/hire?step=2" the model reasons as if it left
        // the page and clicks back to where the field was not.
        const moved = urlMoveNote(urlBefore, page.url());
        const note = this.#lastTargetNote === null ? '' : ` (${this.#lastTargetNote})`;
        this.#lastTargetNote = null;
        history.push(
          ok
            ? `${current.action} ${target}${typed} — ok${note}, ${moved}${q > 0 ? ' (planned)' : ''}`
            : `${current.action} ${target}${typed} — FAILED: ${error ?? ''}`,
        );

        if (ok && page.url() === urlBefore) doneHere.add(decisionKey(current));
        // What kind of activation this was, judged BEFORE it is recorded
        // as one: the same selector on the page it was taken on. A miss
        // activated nothing and records nothing.
        if (ok) {
          const kind = reactivation(current, urlBefore, activatedHere);
          if (kind !== null) {
            reactivations.set(record.index, kind);
            activatedHere.add(activationKey(urlBefore, current.selector));
          }
        }
        // `press` counts here too (2026-09-02): a targeted press (a selector
        // given, as opposed to a bare key sent to whatever has focus)
        // activates its control exactly as a click does, and a model that
        // reaches for `press` on a stepper it keeps hammering must not
        // escape the same circling guard a `click` would trip — see
        // `repeatedToggleClick` for the incident this closes (HIR-EC-009).
        if (
          ok &&
          (current.action === 'click' || current.action === 'press') &&
          current.selector.trim() !== ''
        ) {
          const sel = current.selector.trim();
          okClicks.set(sel, (okClicks.get(sel) ?? 0) + 1);
        }
        if (ok && current.action === 'goto' && !CONSENT_GATE_URL_PATTERN.test(current.url)) intendedUrl = current.url;
        if (ok && INTERACTION_ACTIONS.has(current.action)) interactedEver = true;

        // **An interstitial cleared mid-goal returns to the step's own page**
        // (docs/consent-gate-recovery-spec.md, F2). Accepting a consent gate
        // dumps the agent on the app's home landing; left to judgment, the
        // model re-navigates by menu label and lands on the wrong page —
        // measured: the one run that returned to the step's starting URL passed
        // (PL_02_06) and the two that guessed went red. So when the goal names
        // no destination of its own, an accept-shaped click that navigated away
        // from the page the step began on is followed by a deterministic return
        // to that page — no model turn spent, at most once per distinct accept.
        const acceptShaped =
          current.action === 'click' && CONSENT_ACCEPT_NAME.test(selectorName(current.selector) ?? '');
        if (
          ok &&
          !progressMade &&
          destination === null &&
          acceptShaped &&
          page.url() !== startUrl &&
          /^https?:/.test(startUrl) &&
          !interstitialReturns.has(decisionKey(current))
        ) {
          interstitialReturns.add(decisionKey(current));
          await page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
          await page.waitForLoadState('networkidle', { timeout: NETWORK_SETTLE_MS }).catch(() => undefined);
          history.push(`(cleared an interstitial — returned to the goal's page ${startUrl})`);
        }
        // Anything beyond clearing a gate, waiting, or scrolling is forward
        // progress: after it, an accept-shaped click is a gate met ALONG the
        // journey, and the loop must not undo the journey to get behind it.
        if (ok && !acceptShaped && current.action !== 'wait' && current.action !== 'scroll') {
          progressMade = true;
        }

        if (this.#onAction) await this.#onAction(page, record);

        // **Arriving is finishing.** If the goal names a destination and the page
        // has just reached it, the goal is met in the only part of it a machine
        // can check, and there is nothing left to spend turns on.
        //
        // Without this the agent keeps deciding after the thing was done, and it
        // does not merely waste the budget — it exhausts it and then reports
        // failure. Live (PB_03_01, 2026-08-19): a login that had already
        // succeeded at turn 5 was followed by three more password fills into a
        // field the agent could not read back, and the step was recorded as
        // "gave up after 8 turns" from the destination page itself. 37 seconds,
        // a reconstruction model call, a `high` defect against a working
        // application, and a run reported `error`.
        //
        // Only the destination rule is consulted here; see `goalEvidence` for
        // why the sign-in rule is a post-hoc verdict and never a mid-flight stop.
        if (ok && destinationReached(goal, startUrl, page.url())) {
          success = true;
          summary = `reached ${page.url()}, the destination the goal names, after ${turns} turn(s)`;
          arrived = true;
        }
        if (cannotOffer !== null) {
          const listed = cannotOffer.shown
            .slice(0, 8)
            .map((o) => JSON.stringify(o))
            .join(', ');
          summary =
            `agent stopped: the goal's ${cannotOffer.control} = ${JSON.stringify(cannotOffer.value)} is not among the ` +
            `${cannotOffer.shown.length} option(s) the control offers (${listed}${cannotOffer.shown.length > 8 ? ', …' : ''}) — ` +
            `enumerated twice, ${WAIT_SETTLE_MS} ms apart, so the page cannot satisfy this pair`;
          stopped = true;
        }
        if (!ok) break;
      }
      if (arrived || stopped) break;

      // The no-progress judge. A turn in which an action that can change
      // the page landed resets it; a turn in which nothing did — every action
      // failed, the only decision fell through a refusal and missed, or the
      // turn was spent looking again (a wait, a scroll: IDLE_ACTIONS) —
      // brings the stop closer. This is what lets the loop run unbounded: a
      // journey that keeps landing actions keeps going, and one that keeps
      // missing, or keeps looking, ends on evidence rather than on a turn
      // number.
      // A turn advances when it lands an ok action that ENGAGES a control, or
      // a `goto` that reached a URL this leg had not seen. A `goto` back to a
      // page already visited is a reload — not progress — and no longer buys
      // five fresh turns (PL_07_03: the plans page reloaded turn after turn).
      // And an ok activation of a control ALREADY activated on this page
      // this leg is progress only if the page changed after it; text typed
      // again into the same field never is (`reactivation`, 2026-09-03:
      // ec09 leg [14]'s section headers, the job-2 Position picker). The
      // tree is re-read for that case only, and the credit shares
      // AGENT_TREE_CHANGE_CREDITS with the looks below, so a control that
      // toggles forever still ends the leg.
      const turnActions = actions.slice(turnStart);
      let repeatedActivation = false;
      let advanced = turnActions.some((a) => {
        if (!a.ok || IDLE_ACTIONS.has(a.action)) return false;
        if (a.action !== 'goto') {
          const kind = reactivations.get(a.index) ?? null;
          if (reactivationAdvanced(kind, false)) return true;
          if (kind === 'repeat') repeatedActivation = true;
          return false;
        }
        const url = page.url();
        if (visitedUrls.has(url)) return false;
        visitedUrls.add(url);
        return true;
      });
      if (!advanced && repeatedActivation && treeKey !== null && treeChangeCredits < AGENT_TREE_CHANGE_CREDITS) {
        await page.waitForLoadState('networkidle', { timeout: NETWORK_SETTLE_MS }).catch(() => undefined);
        if (treeKeyOf(await captureAxNodes(page, Number.MAX_SAFE_INTEGER)) !== treeKey) {
          advanced = true;
          treeChangeCredits += 1;
        }
      }
      if (!advanced && turnActions.some((a) => a.ok && reactivations.has(a.index))) {
        history.push(
          '(that control was already activated on this page this leg — activating it again is not progress; ' +
            'act on something the goal still needs, or call fail)',
        );
      }
      // **A leg off its page, short of anything the goal names, has a small
      // allowance** (`AGENT_OFF_PAGE_TURNS`; the HIR-EC-002 wander). A turn
      // counts when it moved the page again or only clicked; a first-time
      // form entry off the page is the work a page is visited for and is
      // free. A consent redirect is the gate rung's to clear, never a
      // wander; returning to the step's page resets the allowance.
      const turnEndUrl = page.url();
      if (!CONSENT_GATE_URL_PATTERN.test(turnEndUrl)) {
        if (!wanderedOffPage(goal, startUrl, turnEndUrl)) {
          offPageTurns = 0;
        } else {
          const formEntry = turnActions.some(
            (a) => a.ok && reactivations.get(a.index) === 'first' && FORM_ENTRY_ACTIONS.has(a.action),
          );
          if (differentPage(turnUrl, turnEndUrl) || !formEntry) offPageTurns += 1;
          if (offPageTurns >= this.#offPageTurns) {
            summary =
              `agent wandered: left the step's page ${startUrl} and spent ${offPageTurns} turn(s) elsewhere ` +
              `(now at ${turnEndUrl}) without reaching ${destination === null ? 'anything the goal names' : `the goal's destination ${destination}`}` +
              ' — each move onto a fresh page counted as progress, so this allowance ended the leg';
            break;
          }
        }
      }
      // **A look that showed more is progress, a bounded number of times**
      // (OA-10). A lazily-rendered table appends rows on every scroll, and a
      // page still hydrating fills in after a wait: the FULL tree's hash
      // differs from the one this turn began on. Measured against the same
      // capture the next turn would make, one extra CDP read on idle turns
      // only, and never past AGENT_TREE_CHANGE_CREDITS — an infinite feed
      // still ends the leg. A look that changed nothing stays what it was:
      // a turn that advanced nothing.
      if (!advanced && treeKey !== null && treeChangeCredits < AGENT_TREE_CHANGE_CREDITS) {
        const looks = actions.slice(turnStart);
        const onlyLooked = looks.length > 0 && looks.every((a) => a.ok && (a.action === 'scroll' || a.action === 'wait'));
        if (onlyLooked) {
          // What a scroll renders arrives AFTER the scroll: the rows a lazy
          // list fetches land on network idle (immediate on a quiet page),
          // and even a purely client-side append runs on the next frame —
          // measured, a scroll listener fired ~50 ms after `scrollBy`
          // returned, past an immediate capture. One settle and one beat.
          await page.waitForLoadState('networkidle', { timeout: NETWORK_SETTLE_MS }).catch(() => undefined);
          await page.waitForTimeout(LOOK_SETTLE_MS).catch(() => undefined);
          if (treeKeyOf(await captureAxNodes(page, Number.MAX_SAFE_INTEGER)) !== treeKey) {
            advanced = true;
            treeChangeCredits += 1;
            history.push('(the page rendered more after that look — keep looking only while each look shows more)');
          }
        }
      }
      if (advanced) {
        turnsWithoutProgress = 0;
      } else {
        turnsWithoutProgress += 1;
        // **A stall made only of looking is a handoff, not a failure.** When
        // EVERY action across the whole leg — not just this turn — has been
        // idle (scroll, wait), the model was never handed a real move: no
        // click, fill or press was ever attempted, ok or not. That is a fact
        // about the goal, and with a capable model it is the only way this
        // shape arises — a goal that reads as an action but is actually a
        // reading question (arithmetic over values on the page, a
        // cross-check), so the agent has nothing legitimate to press. The
        // leg ends as inconclusive-not-failed: whatever the flow asserts next
        // is the proof, exactly as `verification-deferred` treats a goal the
        // wording classifier caught up front. The whole-leg scope is
        // deliberate: a leg that landed one real action earlier and only
        // got stuck looking afterward is a different, more ordinary stall,
        // and stays on the 5-turn judge above.
        // The reading/unreachable handoff, two shapes with one meaning —
        // nothing the goal names is on the page:
        //  - PURELY looked (scroll/wait only): a reading question, as before.
        //  - Attempted to engage a control and never once succeeded (every
        //    click a miss, interleaved with scrolls and reloads): the control
        //    the goal names is not there (PL_07_03, 2026-08-27 — three legs
        //    hunting a filter combobox absent from the tree).
        // Both hand off SOFTLY at AGENT_LOOK_ONLY_TURNS: whatever the flow
        // asserts next is the proof, so a goal the agent truly could not
        // fulfil still fails — at its assertion in 2 s, not after 77 s of
        // 1.5 s misses. A leg of failed GOTOs is neither: that is navigation
        // that did not arrive, an ordinary stall on the 5-turn judge. And a
        // leg that DID engage a control earlier (`interactedEver`) is a
        // genuine mid-journey stall, also left to the 5-turn judge.
        const onlyLooked = actions.length > 0 && actions.every((a) => IDLE_ACTIONS.has(a.action));
        const missedEveryInteraction = !interactedEver && actions.some((a) => INTERACTION_ACTIONS.has(a.action));
        if ((onlyLooked || missedEveryInteraction) && turnsWithoutProgress >= this.#lookOnlyTurns) {
          summary = missedEveryInteraction
            ? `agent found nothing the goal names to act on: ${turnsWithoutProgress} turn(s) of looking and ` +
              'missed clicks with no control the goal could reach — this reads as a page that does not offer ' +
              "it, and the flow's own assertions after this step are what answer it"
            : `agent looked and found nothing to act on: ${turnsWithoutProgress} turn(s) of scrolling and ` +
              'waiting with no control the goal could name — this is a reading question, and the ' +
              "flow's own assertions after this step are what answer it";
          this.#lookedOnly = true;
          break;
        }
        if (turnsWithoutProgress >= this.#noProgressTurns) {
          const lastFailed = [...actions].reverse().find((a) => !a.ok);
          summary =
            `agent stalled: nothing advanced in ${turnsWithoutProgress} consecutive turns` +
            (lastFailed?.error === undefined ? '' : ` (last failure: ${lastFailed.error})`);
          break;
        }
      }
    }

    if (success) this.#remember(key, memory, actions);

    return this.#result(goal, success, summary, actions, turns, startedMs, inputTokens, outputTokens, effectiveMaxSteps);
  }

  /**
   * Remember what worked, for the next case with this goal on this page.
   * Only the actions that succeeded, and never the model's own finish: a
   * replay re-proves arrival against the page, not against a claim.
   */
  #remember(key: string | null, memory: AgentMemory | undefined, actions: readonly AgentAction[]): void {
    if (key === null || !memory) return;
    const steps = scriptOf(actions);
    if (steps.length > 0) memory.set(key, steps, this.model.id);
  }

  /**
   * Re-run a remembered solution. Returns null when every action succeeded
   * and the goal's evidence holds; else the index of the action that failed.
   * Each selector must still ground in the live tree — a page that changed
   * under a remembered selector is exactly the case that must fall through
   * to the model rather than click something else.
   */
  async #replay(
    page: Page,
    steps: readonly PlanStep[],
    allowed: string[],
    actions: AgentAction[],
    history: string[],
    startUrl: string,
    goal: string,
  ): Promise<number | null> {
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i]!;
      const decision: AgentDecision = { ...step, reasoning: 'replayed from an earlier run that reached this goal' };
      if (step.selector !== '') {
        const tree = renderTree(focusTree(await captureAxNodes(page, Number.MAX_SAFE_INTEGER), goal, this.#maxAxNodes), 0);
        if (selectorGrounded(step.selector, tree) === false) {
          actions.push(this.#record(actions.length, decision, page.url(), false, 0, 'not in the tree on this run'));
          return i;
        }
      }
      const started = Date.now();
      try {
        await this.#act(page, decision, allowed);
      } catch (error) {
        actions.push(this.#record(actions.length, decision, page.url(), false, Date.now() - started, describe(error)));
        return i;
      }
      const record = this.#record(actions.length, decision, page.url(), true, Date.now() - started, undefined, this.#takeObserved());
      actions.push(record);
      history.push(`${step.action} ${step.selector || step.url} — ok (replayed)`);
      if (this.#onAction) await this.#onAction(page, record);
      if (destinationReached(goal, startUrl, page.url())) return null;
    }
    // No destination to check against: the replay stands on every action
    // having succeeded, as the original run's finish did. The caller's
    // post-hoc `goalEvidence` still judges the page afterwards.
    return goalDestination(goal) === null ? null : steps.length;
  }

  /**
   * A consent gate standing where the agent is: accept it, and go back to
   * the page the agent meant to be on. The zero-call rung that used to live
   * only in the preflight — measured the day after (be100, 2026-08-25), the
   * gate showed up MID-run too: a goto to the plans page was redirected to
   * /en/consent because the session had not accepted yet (the preflight's
   * 5 s poll had found no accept control on a page still hydrating under an
   * eight-way run), and the model then scrolled, waited, and reported the
   * plans controls missing — from the consent page. Three runs, all errors,
   * all with the accept control on screen by the second turn.
   *
   * `returnTo` is where the agent was going — the step's own page, or the
   * page the last goto asked for — and is where it is returned to unless the
   * goal's destination has been reached on the way. `null` means stay where
   * the accept landed: a gate met after real progress, on the way somewhere,
   * is a gate ON the journey (the two-interstitials shape), and going back to
   * the start would undo the journey to get behind it. Returns what happened
   * so the caller can stop if arriving was the whole goal.
   */
  async #clearConsentGate(
    page: Page,
    goal: string,
    startUrl: string,
    returnTo: string | null,
    actions: AgentAction[],
    history: string[],
    when: string,
  ): Promise<'none' | 'cleared' | 'arrived'> {
    // On a consent URL the gate is checked against the HYDRATED page: measured
    // (be100 PL_06_17), the step began on /en/consent while the page was still
    // a shell, the probe saw no accept control, and the model then spent two
    // of its turns on a wait and a click this rung exists to make free.
    // Polled for the gate itself rather than `networkidle` (2026-08-24): the
    // idle wait held its full 5 s on any page that keeps talking, and even
    // then only re-checked once — this ends the moment the accept control
    // renders, which on the measured page is well under a second.
    if (CONSENT_GATE_URL_PATTERN.test(page.url()) && (await consentGateShowing(page)) === null) {
      const gateDeadline = Date.now() + 5_000;
      while (Date.now() < gateDeadline && (await consentGateShowing(page)) === null) {
        await page.waitForTimeout(250);
      }
    }
    if ((await consentGateShowing(page)) === null) return 'none';
    const started = Date.now();
    const accepted = await acceptConsentGateAnywhere(page).catch(() => false);
    const decision: AgentDecision = {
      action: 'click',
      selector: 'role=button[name="Accept" i]',
      value: '',
      url: '',
      reasoning: `consent gate in front of the page, cleared ${when} without asking the model`,
    };
    actions.push(this.#record(actions.length, decision, page.url(), accepted, Date.now() - started));
    if (!accepted) return 'none';
    history.push(`(cleared a consent gate ${when})`);
    if (returnTo !== null && page.url() !== returnTo && /^https?:/.test(returnTo) && !destinationReached(goal, startUrl, page.url())) {
      await page.goto(returnTo, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await page.waitForLoadState('networkidle', { timeout: NETWORK_SETTLE_MS }).catch(() => undefined);
      history.push(`(returned to ${returnTo === startUrl ? "the goal's page" : 'the page the goto asked for'} ${returnTo})`);
    }
    return destinationReached(goal, startUrl, page.url()) ? 'arrived' : 'cleared';
  }

  /**
   * What can be done for the goal with no model at all, on the page as it
   * stands. Returns a success summary when the goal is thereby met, else
   * null — with whatever was done (a gate cleared) left on `actions` and
   * `history` for the model's first turn to read.
   */
  async #preflight(
    page: Page,
    goal: string,
    startUrl: string,
    destination: string | null,
    allowed: string[],
    actions: AgentAction[],
    history: string[],
    mayClick = true,
  ): Promise<string | null> {
    // A consent gate in front of the page: accept it (the goal cannot be
    // reached through it), and come back to the page the step began on.
    //
    // On a consent URL the gate is checked against the HYDRATED page: measured
    // (be100 PL_06_17), the step began on /en/consent while the page was still
    // a shell, the probe saw no accept control, and the model then spent two
    // of its turns on a wait and a click this rung exists to make free.
    // Polled for the gate itself rather than `networkidle` (2026-08-24): the
    // idle wait held its full 5 s on any page that keeps talking, and even
    // then only re-checked once — this ends the moment the accept control
    // renders, which on the measured page is well under a second.
    const gate = await this.#clearConsentGate(page, goal, startUrl, startUrl, actions, history, 'before the first turn');
    if (gate === 'arrived') {
      return `reached ${page.url()}, the destination the goal names, after clearing a consent gate — no model turn spent`;
    }
    if (destination !== null && atGoalDestination(page.url(), destination)) return null; // nothing to do; the loop's rules decide

    // A link in the tree that points exactly where the goal ends IS the
    // route the goal describes, so it is clicked as written — the one thing
    // the tree says with no judgment involved.
    const nodes = destination === null ? [] : await captureAxNodes(page, Number.MAX_SAFE_INTEGER);
    const link =
      destination === null
        ? undefined
        : nodes.find((n: AxNode) => n.role === 'link' && n.url !== '' && n.name !== '' && atGoalDestination(n.url, destination));
    if (link && mayClick) {
      const decision: AgentDecision = {
        action: 'click',
        selector: normaliseAgentSelector(`role=link[name=${JSON.stringify(link.name)}]`),
        value: '',
        url: '',
        reasoning: `the tree shows a link to ${destination}, the goal's destination`,
      };
      const started = Date.now();
      let ok = true;
      let error: string | undefined;
      try {
        await this.#act(page, decision, allowed);
      } catch (caught) {
        ok = false;
        error = describe(caught);
      }
      const record = this.#record(actions.length, decision, page.url(), ok, Date.now() - started, error);
      actions.push(record);
      if (this.#onAction) await this.#onAction(page, record);
      history.push(ok ? `click ${decision.selector} — ok (link to the destination)` : `click ${decision.selector} — FAILED: ${error ?? ''}`);
      if (ok && destinationReached(goal, startUrl, page.url())) {
        return `reached ${page.url()} by the link the tree showed to it — no model turn spent`;
      }
    }

    // A goal that names the menu path level by level is a literal, and a
    // literal is a $0 rung (OA-2): walk it. The model takes over from
    // wherever the walk stopped, with the partial path in the history.
    const path = mayClick ? menuPathOf(goal) : null;
    if (path !== null) {
      const walked = await this.#walkMenuPath(page, path, allowed, actions, history, goal, startUrl);
      if (walked !== null) return walked;
    }
    if (destination === null) return null;

    // A goal that names WHERE but not HOW may be met by going there. One that
    // names a route ("via the sidebar") is about the route, and a goto would
    // pass it without exercising what it describes — so that is left to the
    // model, and the summary says which of the two happened.
    if (!ROUTE_WORDS.test(goal)) {
      const origin = originOf(startUrl);
      if (origin !== null && allowed.includes(origin)) {
        const url = /^https?:/.test(destination) ? destination : `${origin}${destination}`;
        const decision: AgentDecision = {
          action: 'goto',
          selector: '',
          value: '',
          url,
          reasoning: 'the goal names a destination and no route to it; navigated directly',
        };
        const started = Date.now();
        let ok = true;
        let error: string | undefined;
        try {
          await this.#act(page, decision, allowed);
        } catch (caught) {
          ok = false;
          error = describe(caught);
        }
        const record = this.#record(actions.length, decision, page.url(), ok, Date.now() - started, error);
        actions.push(record);
        if (this.#onAction) await this.#onAction(page, record);
        history.push(ok ? `goto ${url} — ok (direct)` : `goto ${url} — FAILED: ${error ?? ''}`);
        if (ok && destinationReached(goal, startUrl, page.url())) {
          return `reached ${page.url()} by direct navigation (the goal named no route) — no model turn spent`;
        }
      }
    }
    return null;
  }

  #result(
    goal: string,
    success: boolean,
    summary: string,
    actions: AgentAction[],
    turns: number,
    startedMs: number,
    inputTokens: number,
    outputTokens: number,
    effectiveMaxSteps: number,
  ): WorkflowResult {
    return {
      goal,
      model: this.model.id,
      success,
      summary,
      actions,
      turns,
      // JSON has no Infinity: an unbounded run records null, and every reader
      // treats null as "no ceiling was set". Records the CALL's effective
      // ceiling, not just the instance's — a fail-fast leg's tighter
      // `runOptions.maxSteps` override belongs on its own record, or a
      // reader would see "gave up after 12 turns" against a reported budget
      // of the instance's much larger (or unbounded) default.
      maxSteps: Number.isFinite(effectiveMaxSteps) ? effectiveMaxSteps : null,
      latencyMs: Date.now() - startedMs,
      inputTokens,
      outputTokens,
      ...(this.#lookedOnly ? { lookedOnly: true } : {}),
      ...(success && this.#settledBy !== null ? { settledBy: this.#settledBy.rule, settledEvidence: this.#settledBy.evidence } : {}),
      ...(this.#observations.length > 0 ? { observations: [...this.#observations] } : {}),
    };
  }

  /** The whole live tree, rendered with no truncation marker — for the judges, never the model. */
  async #fullTree(page: Page): Promise<string> {
    const nodes = await captureAxNodes(page, Number.MAX_SAFE_INTEGER);
    return renderTree(nodes, nodes.length);
  }

  /** The observation the last `read`/`save` left, consumed once into its record. */
  #takeObserved(): string | undefined {
    const observed = this.#lastObserved;
    this.#lastObserved = null;
    return observed ?? undefined;
  }

  /**
   * Walk the menu path the goal names — "EC > Hire & Onboard (New Hire)",
   * "1. HR 2. Benefits Admin 3. Benefit Plans" — by clicking the tab, button,
   * link, menuitem or treeitem whose name answers each segment, at $0 (OA-2).
   * Every case's first leg is this walk, and each level cost a model turn
   * because ROUTE_WORDS keeps the goto rung off any goal that names a route.
   * Exact names win over containing ones ("HR" over "HR Analytics"); an
   * already-open section trigger is not clicked again (a second click folds
   * it); the walk stops at the first segment the tree does not show and hands
   * the model the partial path in the history. Returns the arrived summary
   * when the last click lands on the goal's destination, else null.
   */
  async #walkMenuPath(
    page: Page,
    path: readonly MenuSegment[],
    allowed: string[],
    actions: AgentAction[],
    history: string[],
    goal: string,
    startUrl: string,
  ): Promise<string | null> {
    const MENU_ROLES = new Set(['tab', 'button', 'link', 'menuitem', 'treeitem']);
    for (let i = 0; i < path.length; i += 1) {
      const segment = path[i]!;
      const nodes = await captureAxNodes(page, Number.MAX_SAFE_INTEGER);
      let best: { node: AxNode; score: 1 | 2 } | null = null;
      for (const node of nodes) {
        if (!MENU_ROLES.has(node.role) || node.name === '') continue;
        const score = menuNodeScore(segment, node.name);
        if (score === 0) continue;
        if (best === null || score > best.score) best = { node, score };
        if (best.score === 2) break;
      }
      if (best === null) {
        history.push(`(menu path: "${segment.name}" is not in the tree after ${i} level(s); asking the model)`);
        return null;
      }
      const selector = normaliseAgentSelector(`role=${best.node.role}[name=${JSON.stringify(best.node.name)}]`);
      if (best.node.role !== 'link') {
        const expanded = await page
          .locator(selector)
          .first()
          .getAttribute('aria-expanded', { timeout: 500 })
          .catch(() => null);
        if (expanded === 'true') {
          history.push(`(menu path segment ${i + 1} of ${path.length}: "${best.node.name}" is already open)`);
          continue;
        }
      }
      const decision: AgentDecision = {
        action: 'click',
        selector,
        value: '',
        url: '',
        reasoning: `menu path segment ${i + 1} of ${path.length}: "${segment.name}"`,
      };
      const started = Date.now();
      let ok = true;
      let error: string | undefined;
      try {
        await this.#act(page, decision, allowed);
      } catch (caught) {
        ok = false;
        error = describe(caught);
      }
      const record = this.#record(actions.length, decision, page.url(), ok, Date.now() - started, error);
      actions.push(record);
      if (this.#onAction) await this.#onAction(page, record);
      history.push(ok ? `click ${selector} — ok (menu path)` : `click ${selector} — FAILED: ${error ?? ''}`);
      if (!ok) return null;
      await page.waitForLoadState('networkidle', { timeout: NETWORK_SETTLE_MS }).catch(() => undefined);
      if (destinationReached(goal, startUrl, page.url())) {
        return `reached ${page.url()} by walking the menu path ${path.map((s) => s.name).join(' > ')} — no model turn spent`;
      }
    }
    return null;
  }

  /**
   * Why a decision should not be acted on as it stands, or null.
   *
   * Three checks, each the structural form of a rule the prompt already
   * states — so a model that follows the prompt never meets them, and a model
   * that does not pays one re-ask instead of a wasted turn:
   * - a selector whose accessible name is in no node of the tree (the tree is
   *   the evidence; a name not in it is a guess that costs 8 s to disprove);
   * - an ok action repeated with nothing changed since (the live PB_03_01
   *   loop: four password fills into a field already filled) — for a
   *   page-changing action; a repeated wait or scroll is told once and then
   *   let through as a turn that advances nothing (IDLE_ACTIONS);
   * - a `finish` while the goal's own destination has not been reached (the
   *   one hole the post-hoc evidence check could not close: it only ran on
   *   failures, so a false finish sailed through as success).
   */
  #refuse(
    decision: AgentDecision,
    axTree: string,
    doneHere: ReadonlySet<string>,
    okClicks: ReadonlyMap<string, number>,
    destination: string | null,
    currentUrl: string,
    ask: number,
    goal: string,
  ): string | null {
    if (decision.action === 'finish') {
      if (destination !== null && !atGoalDestination(currentUrl, destination)) {
        return `the goal ends on ${destination} and the page is on ${currentUrl} — continue toward it, or call fail and say why`;
      }
      return null;
    }
    if (decision.action === 'fail') return null;
    // A delete aimed at "whatever row comes first" is refused before any
    // grounding question: the control exists, and that is the problem.
    const destructive = unscopedDestructiveClick(decision, goal);
    if (destructive !== null) return destructive;
    // A control clicked past TOGGLE_CLICK_LIMIT this run is a toggle being
    // thrashed (PL_03_02's 38-turn dropdown), whatever the tree did since.
    const circling = repeatedToggleClick(decision, okClicks);
    if (circling !== null) return circling;
    // `scroll` is in this list (2026-08-25): scrolling to a name the tree
    // does not show waited the full action timeout, three turns running, on
    // every "bring row PL_03_… into view" leg whose row was not rendered.
    if (
      decision.action === 'click' ||
      decision.action === 'fill' ||
      decision.action === 'hover' ||
      decision.action === 'press' ||
      decision.action === 'scroll' ||
      decision.action === 'save'
    ) {
      if (decision.selector !== '' && selectorGrounded(decision.selector, axTree) === false) {
        return `"${decision.selector}" names a control that is not in the accessibility tree; take the role and name verbatim from the tree`;
      }
    }
    if (doneHere.has(decisionKey(decision))) {
      const what = `${decision.action} ${decision.selector || decision.url}`;
      if (IDLE_ACTIONS.has(decision.action)) {
        // Looking again is never a stall — but it is never progress either,
        // and the model is told so once. The second ask is let through: the
        // turn it spends counts toward AGENT_NO_PROGRESS_TURNS, which is the
        // honest price of insisting, rather than the run's end.
        return ask === 0
          ? `you already did "${what}" and the tree has not changed since — the tree lists off-screen elements too, so ${decision.action === 'wait' ? 'waiting' : 'scrolling'} again will not reveal more; act on a control the tree shows, or call fail and say what is missing`
          : null;
      }
      return ask === 0
        ? `you already did "${what}" with this value and the page has not changed since — it is done; choose the next part of the goal, or finish`
        : `stalled: repeated "${what}" after being told it was already done`;
    }
    return null;
  }

  async #act(page: Page, decision: AgentDecision, allowed: string[]): Promise<void> {
    switch (decision.action) {
      case 'click':
        if (!decision.selector) throw new Error('click decision carried no selector');
        await this.#target(page, decision.selector);
        await humanClick(page, page.locator(decision.selector).first(), this.#actionTimeoutMs, { enabled: this.#humanize });
        break;

      case 'fill': {
        if (!decision.selector) throw new Error('fill decision carried no selector');
        await this.#target(page, decision.selector);
        const dateInput = await this.#writable(page, decision.selector);
        if (dateInput !== null) {
          await this.#writeDate(dateInput, decision.value);
          break;
        }
        const field = page.locator(decision.selector).first();
        await humanFill(page, field, decision.value, this.#actionTimeoutMs, { enabled: this.#humanize });
        // **A fill the framework reverts is the quietest false negative in
        // the loop.** A controlled React input that has not finished
        // hydrating takes the value, then resets it on its next render — the
        // action reports ok, the submit sends an empty field, validation
        // fires, and the run blames the application (the credential path
        // learned this as `fillsLostToHydration`; this is the same fact for
        // every OTHER form the agent drives, e.g. the Create Plan modal).
        // One $0 read-back catches it; one re-fill after a settle fixes it;
        // a field that STILL disagrees throws, so the model is told the
        // truth instead of planning on a value that is not there. Password
        // fields are exempt — they often read back empty by design.
        if (decision.value !== '' && !/password/i.test(decision.selector)) {
          const readBack = await field.inputValue({ timeout: 1_000 }).catch(() => null);
          if (readBack !== null && readBack !== decision.value) {
            await page.waitForLoadState('networkidle', { timeout: NETWORK_SETTLE_MS }).catch(() => undefined);
            await field.fill(decision.value, { timeout: this.#actionTimeoutMs });
            const second = await field.inputValue({ timeout: 1_000 }).catch(() => null);
            if (second !== null && second !== decision.value) {
              throw new Error(
                `the field did not keep the typed value (holds ${JSON.stringify(second.slice(0, 40))}) — ` +
                  'it may be read-only, masked, or controlled by the page; try another way to set it',
              );
            }
          }
        }
        break;
      }

      case 'check':
      case 'uncheck': {
        if (!decision.selector) throw new Error(`${decision.action} decision carried no selector`);
        await this.#target(page, decision.selector);
        const box = page.locator(decision.selector).first();
        const want = decision.action === 'check';
        try {
          // Native checkbox/radio — Playwright verifies the resulting state.
          await box.setChecked(want, { timeout: this.#actionTimeoutMs });
        } catch (error) {
          // A styled toggle: read aria-checked/aria-pressed, click only if it
          // differs, re-read to confirm. A control that exposes no state at
          // all is left with the original error — clicking it blind is how a
          // "toggle" silently does the wrong thing.
          const read = (): Promise<boolean | null> =>
            box
              .evaluate((el) => {
                const a = el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed');
                return a === null ? null : a === 'true';
              })
              .catch(() => null);
          const before = await read();
          if (before === null) throw error;
          if (before !== want) {
            await box.click({ timeout: this.#actionTimeoutMs });
            const after = await read();
            if (after !== want) {
              throw new Error(
                `clicked ${JSON.stringify(decision.selector)} but it still reports ` +
                  `${after === null ? 'no state' : after ? 'checked' : 'unchecked'} — try another control`,
              );
            }
          }
        }
        break;
      }

      case 'selectOption': {
        if (!decision.selector) throw new Error('selectOption decision carried no selector');
        if (!decision.value) throw new Error('selectOption decision carried no option label (put it in value)');
        await this.#target(page, decision.selector);
        const control = page.locator(decision.selector).first();
        const tag = await control
          .evaluate((el) => ((el as unknown as { tagName?: string }).tagName ?? '').toLowerCase(), undefined, { timeout: TARGET_ATTACH_MS })
          .catch(() => '');
        if (tag === 'select') {
          try {
            // Native <select> — by visible label, then by value/text as a
            // fallback for a label that is really the option's value attribute.
            await control.selectOption({ label: decision.value }, { timeout: this.#actionTimeoutMs });
          } catch (nativeError) {
            try {
              await control.selectOption(decision.value, { timeout: 1_000 });
            } catch {
              throw new Error(
                `could not choose ${JSON.stringify(decision.value)} in the <select> ${JSON.stringify(decision.selector)} — ` +
                  `no option with that label or value (${describe(nativeError)})`,
              );
            }
          }
          break;
        }
        // A custom listbox/combobox (OA-1): the engine's own procedure —
        // open only when not already `aria-expanded` (a second click on an
        // open trigger closes it), type the value's stable head into the
        // popup's search box when one is offered (a Position list of 87k
        // rows is never scanned by name), match whole name → whole word →
        // code half → label half, never substring ("Male" is not "Female",
        // "New Hire" is not every "Re-hire"), and on a miss close the list
        // and name the options actually seen, so the next turn and the
        // report know what the list offered. The read-back is recorded, not
        // required: a trigger whose text is its label (not its value) is a
        // shape this loop meets, and the next turn's tree shows the pick.
        const picked = await selectFromListbox(page, control, decision.value, {
          timeout: this.#actionTimeoutMs,
          readBack: 'record',
        });
        const notes: string[] = [];
        if (picked.typed !== undefined) notes.push(`typed ${JSON.stringify(picked.typed)} into the list search`);
        notes.push(
          `picked ${picked.picked.map((p) => JSON.stringify(p)).join(', ')}` +
            (picked.matchedBy === 'whole' ? '' : ` by its ${picked.matchedBy}`),
        );
        if (picked.readBack !== null) {
          notes.push(
            picked.confirmed
              ? `the control now shows ${JSON.stringify(picked.readBack.slice(0, 80))}`
              : `the control shows ${JSON.stringify(picked.readBack.slice(0, 80))} — read it before relying on the pick`,
          );
        }
        this.#note(notes.join('; '));
        break;
      }

      case 'paste': {
        // **The last way in.** A control that refuses `fill` (one assignment)
        // and `type` (a keydown per character) usually has a listener that
        // rejects both — a date picker that only accepts its own calendar, a
        // masked input, a contenteditable. `insertText` delivers the whole
        // string at the caret through the same input path a real paste uses,
        // which those controls do accept.
        //
        // Focus first and clear what is there, so a paste replaces rather than
        // appends. Both are best-effort: a control that cannot be cleared is
        // still worth pasting into, and the read-back the caller does is what
        // decides whether it took.
        if (!decision.selector) throw new Error('paste decision carried no selector');
        await this.#target(page, decision.selector);
        const dateInput = await this.#writable(page, decision.selector);
        if (dateInput !== null) {
          await this.#writeDate(dateInput, decision.value);
          break;
        }
        const target = page.locator(decision.selector).first();
        await target.click({ timeout: this.#actionTimeoutMs }).catch(() => undefined);
        await target.fill('', { timeout: this.#actionTimeoutMs }).catch(async () => {
          // Not a fillable control: select everything and let the insert replace it.
          await page.keyboard.press('ControlOrMeta+a').catch(() => undefined);
        });
        await page.keyboard.insertText(decision.value);
        break;
      }

      case 'type': {
        if (!decision.selector) throw new Error('type decision carried no selector');
        await this.#target(page, decision.selector);
        const dateInput = await this.#writable(page, decision.selector);
        if (dateInput !== null) {
          await this.#writeDate(dateInput, decision.value);
          break;
        }
        const field = page.locator(decision.selector).first();
        // Focus and clear the way a user would, then type key by key so a
        // field that reacts per keystroke (autocomplete, typeahead, masked
        // input) actually wakes. No read-back guard: such a field routinely
        // transforms what it holds, and that is the point of using `type`.
        await humanClick(page, field, this.#actionTimeoutMs, { enabled: this.#humanize });
        await field.fill('', { timeout: this.#actionTimeoutMs }).catch(() => undefined);
        await humanKeys(
          page,
          field,
          decision.value,
          25,
          Math.max(this.#actionTimeoutMs, decision.value.length * 25 + 1_000),
          { enabled: this.#humanize },
        );
        break;
      }

      case 'press': {
        if (!decision.value) throw new Error('press decision carried no key');
        if (decision.selector) {
          await page
            .locator(decision.selector)
            .first()
            .press(decision.value, { timeout: this.#actionTimeoutMs });
        } else {
          await page.keyboard.press(decision.value);
        }
        break;
      }

      case 'hover':
        if (!decision.selector) throw new Error('hover decision carried no selector');
        await this.#target(page, decision.selector);
        if (this.#humanize) await approach(page, page.locator(decision.selector).first(), this.#actionTimeoutMs);
        await page
          .locator(decision.selector)
          .first()
          .hover({ timeout: this.#actionTimeoutMs });
        break;

      case 'scroll':
        if (decision.selector) {
          // The attach check first, as for a click: a row a virtualised
          // table has not rendered is "no element matches" in 1.5 s, not a
          // 5 s scrollIntoViewIfNeeded timeout the next turn cannot read.
          await this.#target(page, decision.selector);
          await humanScrollTo(page.locator(decision.selector).first(), this.#actionTimeoutMs, { enabled: this.#humanize });
          await page
            .locator(decision.selector)
            .first()
            .scrollIntoViewIfNeeded({ timeout: this.#actionTimeoutMs });
        } else {
          // A string, not a function, on purpose: esbuild rewrites a *named*
          // one into `__name(fn, …)`, which does not exist in the page. See
          // the note in `engine/evidence.ts`. Smooth when humanised.
          await humanScrollBy(page, { enabled: this.#humanize });
        }
        break;

      case 'wait': {
        // Event-driven first: the wait ends the moment the network goes
        // quiet. When it was quiet ALREADY — the idle wait returned at once —
        // the model asked for time the network cannot measure (hydration, a
        // menu animating open), and that is paid as one short settle. A flat
        // sleep after every wait was removed 2026-08-24 for taxing settled
        // pages; this taxes only the wait that would otherwise do nothing.
        const started = Date.now();
        await page
          .waitForLoadState('networkidle', { timeout: this.#actionTimeoutMs })
          .catch(() => undefined);
        if (Date.now() - started < 100) await page.waitForTimeout(WAIT_SETTLE_MS).catch(() => undefined);
        break;
      }

      case 'goto': {
        if (!decision.url) throw new Error('goto decision carried no url');
        decision.url = deploymentAwareAgentUrl(decision.url, page.url());
        const target = originOf(decision.url);
        if (target === null || !allowed.includes(target)) {
          throw new Error(
            `refusing to navigate off-origin to ${decision.url} (allowed: ${allowed.join(', ') || 'none'})`,
          );
        }
        await page.goto(decision.url, {
          waitUntil: 'domcontentloaded',
          timeout: this.#actionTimeoutMs,
        });
        break;
      }

      case 'read': {
        if (!decision.selector) throw new Error('read decision carried no selector');
        await this.#target(page, decision.selector);
        const loc = page.locator(decision.selector).first();
        const observed = await this.#observe(loc);
        // The observation is the deliverable of a record-what-the-system-
        // shows leg (OA-14): it rides the history line for the model AND the
        // action's own record for the report, at the full cap rather than
        // the 120 characters the line alone used to carry.
        this.#lastObserved = observed;
        this.#observations.push({ selector: decision.selector, text: observed, url: page.url() });
        this.#note(`observed ${observed}`);
        break;
      }

      case 'save': {
        // Remember a value the page shows (OA-8): the node's input value or
        // text, a leading "<label>:" stripped when the label is the control's
        // own name or a word of the goal ("Employee ID: 20001234" → the id),
        // handed to the run's variable store under the name the model chose.
        if (!decision.selector) throw new Error('save decision carried no selector');
        const name = decision.value.trim();
        if (name === '') throw new Error('save decision carried no variable name (put it in value)');
        await this.#target(page, decision.selector);
        const loc = page.locator(decision.selector).first();
        let text = (await loc.inputValue({ timeout: 500 }).catch(() => '')).trim();
        if (text === '') {
          text = await loc
            .evaluate((el) => (el as unknown as { innerText?: string; textContent?: string | null }).innerText ?? (el as unknown as { textContent?: string | null }).textContent ?? '')
            .catch(() => '');
        }
        text = text.replace(/\s+/g, ' ').trim();
        const labelled = /^([^:：]{1,60}?)\s*[:：]\s*(\S.*)$/u.exec(text);
        if (labelled) {
          const label = foldValue(labelled[1] as string);
          const own = selectorName(decision.selector);
          if ((own !== null && foldValue(own) === label) || (label !== '' && foldValue(this.#goal).includes(label))) {
            text = (labelled[2] as string).trim();
          }
        }
        if (text === '') throw new Error(`"${decision.selector}" shows no text or value to save — read the tree for the node that shows it`);
        if (this.#saveVariable !== null) this.#saveVariable(name, text);
        const shown = text.length > READ_OBSERVATION_CHARS ? `${text.slice(0, READ_OBSERVATION_CHARS - 1)}…` : text;
        this.#lastObserved = `${name} = ${JSON.stringify(shown)}`;
        this.#observations.push({ selector: decision.selector, text: this.#lastObserved, url: page.url() });
        this.#note(`saved ${name} = ${JSON.stringify(shown.slice(0, 120))}${this.#saveVariable === null ? ' — no variable store on this run, recorded only' : ''}`);
        break;
      }

      case 'signOut': {
        // The app's own sign-out control, the same way the engine's signOut
        // step does it (OA-15) — never a storage wipe, which tests nothing
        // and leaves a cookie-backed session alive.
        const out = await performSignOut(page);
        if (!out.ok) throw new Error(out.reason);
        this.#note(`signed out via ${out.via}, now at ${out.landedUrl}`);
        break;
      }

      case 'dbCount': {
        if (!decision.selector) throw new Error('dbCount decision carried no table (name it in selector)');
        if (this.#dbProbe === null) {
          throw new Error(
            'no database is configured for this run — do not retry dbCount; verify through the page instead',
          );
        }
        // The observed number rides the history line as the action's note —
        // the model reasons from what the database actually said, and the
        // record shows the evidence, never just the claim.
        const count = await this.#dbProbe(decision.selector, parseWherePairs(decision.value));
        this.#lastTargetNote = `observed ${count} row(s)`;
        break;
      }

      default:
        throw new Error(`unhandled agent action: ${decision.action}`);
    }

    // Interstitials frequently need a beat to settle before the next observation.
    await page.waitForLoadState('domcontentloaded', { timeout: this.#actionTimeoutMs }).catch(() => undefined);
  }

  /**
   * Fail fast, and specifically, when a selector matches nothing.
   *
   * A click on a selector that resolves to nothing waits the full action
   * timeout (8 s) to say "not found" — and the model's wrong guesses are the
   * ordinary case, not the exception. Waiting one short window for the
   * element to ATTACH, and naming the count, turns that into a 1.5 s answer
   * the next turn can act on: "no element matches" is a different fact from
   * "found, could not be clicked", and "4 matched, acted on the first" is the
   * hint to narrow with >> nth=N.
   */
  async #target(page: Page, selector: string): Promise<void> {
    const locator = page.locator(selector);
    try {
      await locator.first().waitFor({ state: 'attached', timeout: TARGET_ATTACH_MS });
    } catch {
      // Out of the tree is not the same as off the page: a control folded
      // inside a collapsed section matches once hidden elements are counted,
      // and the section's disclosure is the click a person makes (ec10
      // HIR-EC-002: Gender inside the collapsed "Personal Information" card
      // stalled the agent for five turns). See `engine/reveal.ts`.
      const revealed = await revealHidden(page, selector).catch(() => null);
      if (revealed === null || !revealed.revealed) {
        // A control on wizard step 2 is not in the DOM on step 1 at all, so
        // the reveal cannot find it either; the tree the loop last rendered
        // says whether this is a wizard, and the miss says so (OA-11 —
        // HIR-EC-002 leg 12 spent 18 turns re-opening section headers
        // before Next was tried).
        const hint = this.#lastTree === null ? null : wizardStepHint(this.#lastTree);
        throw new Error(
          `no element matches "${selector}" (waited ${TARGET_ATTACH_MS} ms)` +
            (revealed === null ? '' : ` — expanded "${revealed.disclosures.join(', ')}" and it stayed hidden`) +
            (hint === null ? '' : ` — ${hint}`),
        );
      }
      this.#lastTargetNote = `inside a collapsed section — expanded "${revealed.disclosures.join(', ')}" to reach it`;
      return;
    }
    const count = await locator.count().catch(() => 1);
    if (count > 1) this.#lastTargetNote = `${count} matched, acted on the first`;
  }

  /**
   * Refuse, in one turn and in words the next turn can act on, to write into a
   * field that cannot take a value.
   *
   * Live (ec10_2 HIR-EC-002, 2026-09-02): the agent pasted a date into
   * `textbox "Select date"` and the action reported ✓ — a read-only input
   * silently ignores inserted text, so the field still showed the pinned
   * today and the model, told nothing, went on to guess `spinbutton "Day Day"`
   * and `[aria-label="Hire Date"]`. A success that teaches nothing is the
   * worst outcome a turn can have. The page's own shape is named in the
   * error, because it is the same shape every time: the input the label
   * points at sits beside the display.
   */
  async #writable(page: Page, selector: string): Promise<Locator | null> {
    const state = await page
      .locator(selector)
      .first()
      .evaluate(
        (el) => {
          const node = el as unknown as {
            readOnly?: boolean;
            disabled?: boolean;
            isContentEditable?: boolean;
            tagName?: string;
            getAttribute?: (n: string) => string | null;
          };
          const tag = (node.tagName ?? '').toLowerCase();
          const label = node.getAttribute?.('aria-label') ?? node.getAttribute?.('placeholder') ?? '';
          return {
            readOnly: node.readOnly === true || node.getAttribute?.('aria-readonly') === 'true',
            disabled: node.disabled === true || node.getAttribute?.('aria-disabled') === 'true',
            editable: tag === 'input' || tag === 'textarea' || tag === 'select' || node.isContentEditable === true,
            label,
          };
        },
        undefined,
        { timeout: TARGET_ATTACH_MS },
      )
      .catch(() => null);
    if (state === null) return null;
    if (state.readOnly) {
      // The one deterministic thing (OA-5): humi's date picker is a readOnly
      // display ("Select date") with a transparent `input[type=date]` drawn
      // over it, in the same container. When that input is there, the write
      // goes to it — as ISO — instead of a turn spent on advice.
      const beside = await this.#dateInputBeside(page, selector);
      if (beside !== null) {
        this.#note('read-only display — wrote to the date input beside it');
        return beside;
      }
      throw new Error(
        `"${selector}" is a READ-ONLY field — a display, not the input; writing into it changes nothing. ` +
          `The real input is usually beside it and named by the field's LABEL: try ` +
          `role=textbox[name="<the label, e.g. Hire Date>" i], or read the tree for a sibling input without ` +
          `readonly. A date input takes YYYY-MM-DD.`,
      );
    }
    if (state.disabled) {
      throw new Error(`"${selector}" is DISABLED — nothing can be entered until whatever enables it is done first.`);
    }
    if (!state.editable) {
      throw new Error(
        `"${selector}" is not an input, textarea, select or editable region — it cannot take typed text. ` +
          'If it is a dropdown, use selectOption; if it opens a picker, click it and act on what opens.',
      );
    }
    return null;
  }

  /** Set by `#target` for the history line of the action that follows. */
  #lastTargetNote: string | null = null;
  /** What the last `read`/`save` observed, consumed into its record by `#takeObserved`. */
  #lastObserved: string | null = null;
  /** Every observation of the leg, in order — see `WorkflowResult.observations`. */
  #observations: AgentObservationRecord[] = [];
  /** The full rendered tree the loop last showed the judges — the wizard hint reads it. */
  #lastTree: string | null = null;
  /** The goal of the leg in progress — `save` strips a label the goal names. */
  #goal = '';
  /** This run's variable sink, when the runner provided one (`RunOptions.saveVariable`). */
  #saveVariable: ((name: string, value: string) => void) | null = null;

  /** Append to the history note of the action in progress — `#target` may already have left one. */
  #note(text: string): void {
    this.#lastTargetNote = this.#lastTargetNote === null ? text : `${this.#lastTargetNote}; ${text}`;
  }

  /**
   * A control's current state, in one line: its text (or value), checked /
   * expanded / haspopup, disabled, readonly, required, and the label that
   * names it — capped at `READ_OBSERVATION_CHARS`.
   */
  async #observe(loc: Locator): Promise<string> {
    const [name, value, checked, expanded, haspopup, disabled, flags] = await Promise.all([
      loc.evaluate((el) => (el as unknown as { innerText?: string }).innerText?.trim() ?? '').catch(() => ''),
      loc.inputValue({ timeout: 500 }).catch(() => ''),
      loc.getAttribute('aria-checked').catch(() => null),
      loc.getAttribute('aria-expanded').catch(() => null),
      loc.getAttribute('aria-haspopup').catch(() => null),
      loc.isDisabled({ timeout: 500 }).catch(() => false),
      // A read-only field is the fact that decides whether writing here can
      // ever work; a required one is a fact the finish is held to.
      loc
        .evaluate((el) => {
          const node = el as unknown as {
            readOnly?: boolean;
            required?: boolean;
            id?: string;
            getAttribute(n: string): string | null;
            labels?: ArrayLike<{ textContent: string | null }>;
          };
          const labels = node.labels;
          const label = labels && labels.length > 0 ? (labels[0]?.textContent ?? '').trim() : node.getAttribute('aria-label') ?? '';
          return {
            readonly: node.readOnly === true || node.getAttribute('aria-readonly') === 'true',
            required: node.required === true || node.getAttribute('aria-required') === 'true',
            label,
          };
        })
        .catch(() => ({ readonly: false, required: false, label: '' })),
    ]);
    const cap = (s: string): string => (s.length > READ_OBSERVATION_CHARS ? `${s.slice(0, READ_OBSERVATION_CHARS - 1)}…` : s);
    const facts = [
      name ? `text ${JSON.stringify(cap(name.replace(/\s+/g, ' ')))}` : '',
      value ? `value ${JSON.stringify(cap(value))}` : '',
      flags.label && flags.label !== name ? `label ${JSON.stringify(flags.label.slice(0, 80))}` : '',
      checked !== null ? `checked=${checked}` : '',
      expanded !== null ? `expanded=${expanded}` : '',
      haspopup !== null && haspopup !== 'false' ? `haspopup=${haspopup}` : '',
      flags.required ? 'required' : '',
      disabled ? 'DISABLED' : '',
      flags.readonly ? 'READONLY — a display; the input the label points at is beside it' : '',
    ].filter(Boolean);
    return facts.length ? facts.join(', ') : 'an element with no readable state';
  }

  /**
   * The `input[type=date]` in the read-only display's own container (one or
   * two levels up), or null. Two levels, never further: a date input three
   * fieldsets away belongs to another field.
   */
  async #dateInputBeside(page: Page, selector: string): Promise<Locator | null> {
    const display = page.locator(selector).first();
    for (const up of ['xpath=..', 'xpath=../..']) {
      const input = display.locator(up).locator('input[type="date"]').first();
      if ((await input.count().catch(() => 0)) > 0) return input;
    }
    return null;
  }

  /**
   * Write a date into a `type=date` input as ISO, converting what the model
   * gave (`15/09/2027`, `1 Sep 2027`, a Buddhist-era `2570`) through
   * `isoDateOf`; the read-back must hold it, or the turn is told the truth.
   */
  async #writeDate(input: Locator, value: string): Promise<void> {
    const iso = isoDateOf(value) ?? isoDateOf(value, 'th');
    if (iso === null) {
      throw new Error(`${JSON.stringify(value)} is not a date this harness can write into a date input — give it as YYYY-MM-DD`);
    }
    await input.fill(iso, { timeout: this.#actionTimeoutMs });
    const held = await input.inputValue({ timeout: 1_000 }).catch(() => null);
    if (held !== null && held !== iso) {
      throw new Error(`the date input did not keep ${iso} (holds ${JSON.stringify(held)}) — the page may constrain the date; read the field's bounds`);
    }
    this.#note(`wrote ${iso}${iso === value.trim() ? '' : ` for ${JSON.stringify(value)}`}`);
  }
  /**
   * Set when the loop ended because every action taken was a look — see the
   * no-progress judge. Reset at the top of `run()`; read into the RESULT
   * (`WorkflowResult.lookedOnly`), never off the instance directly, because
   * one agent instance answers many workflow steps across a run.
   */
  #lookedOnly = false;
  /**
   * How a successful finish was settled: `observed-state` (the harness
   * re-read the goal's end state off the live tree) or `agent-claim` (the
   * goal named no checkable state and the model's word stands — visible in
   * the record so an all-claim run is never mistaken for a proved one).
   */
  #settledBy: { rule: 'observed-state' | 'agent-claim'; evidence: string } | null = null;
  /** This run's read-only DB access, when the runner provided one. */
  #dbProbe: AgentDbProbe | null = null;

  #record(
    index: number,
    decision: AgentDecision,
    url: string,
    ok: boolean,
    durationMs: number,
    error?: string,
    observed?: string,
  ): ObservedAgentAction {
    return {
      index,
      action: decision.action,
      selector: decision.selector === '' ? null : decision.selector,
      value: decision.value === '' ? null : decision.value,
      url,
      reasoning: decision.reasoning,
      ok,
      error,
      durationMs,
      // The instant the action landed: the moment the run's film keeps for
      // it once the idle around it is dropped (`ProofBundleBuilder.videoMoments`).
      finishedAt: new Date().toISOString(),
      ...(observed === undefined ? {} : { observed }),
    };
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message;
  return String(error);
}
