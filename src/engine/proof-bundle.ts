/**
 * Proof bundles: the structured, machine-readable record of a run.
 *
 * Every step records not just pass/fail but *how* its selector resolved —
 * `fast` (execution plane, free), `cache` (a prior repair, free), or `jit`
 * (a control-plane call that cost tokens). That breakdown is what makes the
 * bundle useful to an MCP client deciding whether a suite is drifting.
 */

import { randomUUID } from 'node:crypto';
import {
  describeAgentAction,
  observedEvidence,
  stepKindFacts,
  stepTarget,
} from '../reporter/step-facts.js';
import type { PolaritySource, TestPolarity } from './polarity.js';

import type { RequestRecord } from '../api/api-client.js';
import type { NetworkCall } from '../api/network-observer.js';
import type { DbCheckRecord } from '../db/db-actions.js';
import type { CoverageReport } from '../coverage/ax-coverage.js';
import type { RunTrend } from '../history/run-history.js';
import type { SnapshotResult } from '../visual/baseline.js';
import { VIDEO_ACTION_LEAD_MS, leadOf, type ActionMoment, type VideoRecording } from './video.js';
import { mapToCondensed } from './webm.js';
import { STEP_ACTION_WIDTH, STEP_DURATION_WIDTH, STEP_INDEX_WIDTH } from '../log-format.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * `failed` — an assertion the test made did not hold.
 * `error`  — the step blew up for a reason that is not an assertion (a thrown
 *            exception, a navigation that never landed, bad interpolation).
 * `dead-end` — every rung of the escalation ladder was spent and the selector
 *            still could not be resolved; there is nothing left to try.
 */
export type StepStatus = 'passed' | 'failed' | 'error' | 'dead-end';
export type RunStatus =
  | 'passed'
  | 'passed-with-issues'
  /**
   * proved-? — the claim's SHAPE held and only its wording did not, closely
   * enough that a machine must not rule. Every broken step is a failed
   * assertion whose recorded `actual` is a near-miss of its `expected`
   * ("Create Plan" vs a dialog titled "Create Benefit Plan"), and whether
   * that is a spec violation or an authoring paraphrase is a human call. The
   * run awaits confirmation (`ProofBundle.review`); until it arrives it is
   * NOT a pass anywhere — `isPassing` says no — and not a product failure
   * either.
   */
  | 'needs-review'
  | 'failed'
  | 'error'
  | 'dead-end';

/**
 * Did the run's claims hold?
 *
 * `passed` and `passed-with-issues` both answer yes. The second is the run
 * whose **assertions all held** while one or more of its *actions* did not —
 * a click that dead-ended on a consent gate and was then made redundant by a
 * later step, an agent leg that gave up after the page had already arrived.
 * Measured (BE_Test2.csv, 2026-08-19 18:16): PL_02_03 dead-ended at step 3
 * clicking "Create Plan", then clicked the same control at step 6, passed,
 * and passed both of its assertions — and was reported `dead-end`, with its
 * film cut at step 1. The claim the row makes was proved; the flow's path to
 * it was not clean. Those are two different facts and the verdict now says
 * both.
 *
 * Every consumer that asks "did it pass" — exit code, trend, quarantine,
 * suite index, the panel's filters — asks through this predicate, so the
 * qualified pass is a pass everywhere and an issue everywhere, never one or
 * the other by accident.
 */
/**
 * The actions whose outcome IS a claim — the same set `classifyStepFailure`
 * files as `failed` rather than `error`, restated here because this module
 * cannot import the runner (the runner imports it).
 */
function isAssertionAction(action: string): boolean {
  return (
    action.startsWith('expect') ||
    action === 'snapshot' ||
    action === 'fillEach' ||
    action === 'fillRetry'
  );
}

/**
 * The two families every non-pass verdict is SHOWN as (2026-08-27).
 *
 * The machine statuses stay — exit codes, resume ledgers, quarantine and the
 * repair loop all key off them — but three words for two meanings confused
 * every reader: `failed` (an assertion contradicted), `dead-end` (a selector
 * exhausted the ladder) and `error` (a harness fault) wore three tags where
 * the question a person asks has two answers. Surveyed over this
 * workspace's 51 bundles: every `dead-end` was "could not resolve <control>"
 * — the page not offering what the case expected, which is the SUBJECT
 * failing the expectation, same family as a contradicted assertion; every
 * run-level `error` traced to a harness fact (a provider refusing the call,
 * an agent stall, a grounding refusal) — `classifyStepFailure` already
 * draws exactly this line per step.
 *
 * - `test-failed` (red): the test subject did not meet the case's
 *   expectation — a contradicted assertion, a dead-ended control or content
 *   the flow needed, a review resolved as failed.
 * - `system-error` (amber): the harness or its models broke internally —
 *   no verdict about the application was delivered.
 * - `review`: proved-? awaiting a human; deliberately NEITHER family — it is
 *   a pending pass-shaped result, and painting it amber would misfile it.
 */
export type VerdictFamily = 'passed' | 'test-failed' | 'system-error' | 'review';

export function verdictFamily(status: RunStatus | string): VerdictFamily {
  if (isPassing(status)) return 'passed';
  if (status === 'needs-review') return 'review';
  if (status === 'error') return 'system-error';
  // failed, dead-end — and any future subject-side status — read red.
  return 'test-failed';
}

/** The tag a person sees, with the machine status kept for the parenthesis. */
export function familyLabel(status: RunStatus | string): string {
  const family = verdictFamily(status);
  if (family === 'test-failed') return status === 'failed' ? 'test-failed' : `test-failed (${status})`;
  if (family === 'system-error') return 'system error';
  return status === 'passed-with-issues' ? 'passed**' : String(status);
}

export function isPassing(status: RunStatus | string): boolean {
  return status === 'passed' || status === 'passed-with-issues';
}

/**
 * The status a consumer should act on: a human ruling on a `needs-review`
 * run outranks the machine's deferral. Everything that displays or scores a
 * bundle should ask this, not `bundle.status`, once reviews exist.
 */
export function effectiveStatus(bundle: {
  status: RunStatus | string;
  review?: { verdict: 'proved' | 'failed'; at?: string | undefined } | undefined;
}): RunStatus | string {
  if (bundle.status === 'needs-review' && bundle.review !== undefined) {
    return bundle.review.verdict === 'proved' ? 'passed' : 'failed';
  }
  return bundle.status;
}

/**
 * Should a failed comparison be JUDGED rather than scored failed on the spot?
 *
 * The history of the threshold is the point of the function. It began as a
 * ≥50%-word-overlap near-miss detector — only comparisons that close reached
 * the review layer, and everything below flat-failed. Broadened 2026-08-24 at
 * the person's request: after the deterministic comparison has read the
 * actual, any mismatch that is not accurate (≥90% / containment territory
 * passes or proves trivially anyway) goes to the agent judge to rule on —
 * the wording call belongs to a reader of both strings, not to a token
 * ratio, and the false failures this suite produced were precisely the
 * mismatches the ratio flat-failed ("Reimbursement by HR" against a page
 * that renders "การเบิกจ่ายโดย HR" scores 0% and was never shown to anything
 * that could read Thai).
 *
 * What still refuses to soften are facts, not wording:
 * - **Purely numeric expectations are never judged**: 119 days against a
 *   promised 120 is the catalog's own documented defect (PB_01_01), and
 *   softening a number is how an instrument teaches people to ignore it.
 * - **A numeric token inside the expectation must appear in the actual** —
 *   "120 days" against "119 days remaining" is a defect about the number,
 *   however well the words overlap.
 * - **Identical strings do not fail** — that is a bug elsewhere, not a
 *   wording call — and an empty side says nothing worth judging.
 */
export function nearMiss(expected: unknown, actual: unknown): boolean {
  const e = typeof expected === 'string' ? expected : JSON.stringify(expected) ?? '';
  const a = typeof actual === 'string' ? actual : JSON.stringify(actual) ?? '';
  if (e === '' || a === '') return false;
  const el = e.toLowerCase().trim();
  const al = a.toLowerCase().trim();
  if (el === al) return false; // identical strings do not fail — this is not a near-miss, it is a bug elsewhere
  const tokens = el.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  if (tokens.every((t) => /^\p{N}+$/u.test(t))) return false;
  // A numeric token is exact or nothing: "120 days" against "119 days
  // remaining" is a defect about the number, however well the words overlap.
  const hayAll = ` ${al} `;
  if (tokens.some((t) => /^\p{N}+$/u.test(t) && !hayAll.includes(` ${t} `) && !hayAll.includes(t))) {
    return false;
  }
  // Every other wording mismatch is the judge's to rule on.
  return true;
}

/**
 * Actions that speak HTTP directly instead of driving the page.
 *
 * One definition, two users: `isBrowserFree()` in the runner decides whether a
 * flow needs a browser at all, and the summary uses it to split a run's result
 * into a frontend and a backend half. Two lists would drift, and the drift
 * would be silent — a step counted as UI in one place and API in the other.
 */
export const API_STEP_ACTIONS: ReadonlySet<string> = new Set([
  'request',
  'expectStatus',
  'expectJson',
  'expectHeader',
]);

/** Actions that speak SQL (read-only) instead of driving the page. */
export const DB_STEP_ACTIONS: ReadonlySet<string> = new Set([
  'dbSnapshot',
  'expectDbRow',
  'expectDbDelta',
  'expectDbUnchanged',
  'expectDbCalled',
]);

/**
 * The one flat `API_STEP_ACTIONS` used to do nine jobs at once; these two sets
 * split them along the line that actually divides the new actions.
 *
 * `BROWSER_FREE_ACTIONS` — steps that never touch the page: they need no
 * browser (`isBrowserFree`), interpolate their own fields (`interpolateStep`
 * skips them), and get no screenshot, no video offset and no caption, because
 * nothing about them happened on screen.
 *
 * `BACKEND_TIER_ACTIONS` — steps whose *findings* belong to the backend half
 * of the report: everything browser-free, plus `expectCalls`, which needs the
 * live network observer (so it is emphatically not browser-free — a flow of
 * API steps plus one `expectCalls` dispatched without a browser would have no
 * traffic to assert on) but whose subject is HTTP the page made.
 */
/**
 * Agent actions that put nothing on screen — a look, a note, or the loop's
 * own verdict — and so mark no moment in the film (`videoMoments`).
 */
export const AGENT_LOOK_ACTIONS: ReadonlySet<string> = new Set(['wait', 'read', 'save', 'finish', 'fail']);

export const BROWSER_FREE_ACTIONS: ReadonlySet<string> = new Set([
  ...API_STEP_ACTIONS,
  ...DB_STEP_ACTIONS,
]);

export const BACKEND_TIER_ACTIONS: ReadonlySet<string> = new Set([
  ...BROWSER_FREE_ACTIONS,
  'expectCalls',
]);

/**
 * How an authored step announces that a backend check would prove it better.
 *
 * A prefix on `intent` rather than a field of its own on every step shape:
 * the authoring schema is one flat object shared by twenty-odd actions, and a
 * marker the model writes into prose it is already writing costs nothing to
 * add and nothing to narrow. It is lifted off the intent when the step is
 * recorded, so the stored intent reads as the author's plain sentence and the
 * hint stands on its own field.
 */
export const BACKEND_HINT_PREFIX = /^\s*backend could prove this:\s*/i;

/** Split an intent into its plain sentence and the backend hint it carries, or null. */
export function backendHintOf(
  intent: string | undefined,
): { intent: string; hint: string } | null {
  if (intent === undefined) return null;
  const match = BACKEND_HINT_PREFIX.exec(intent);
  if (match === null) return null;
  const hint = intent.slice(match[0].length).trim();
  if (hint === '') return null;
  return { intent: hint, hint };
}

/** How a selector was resolved for a step. */
export type ResolutionSource =
  | 'fast'
  | 'case'
  | 'narrow'
  /**
   * The author's selector matched a control folded inside a collapsed
   * section; the section's disclosure was clicked and the same selector
   * resolved. Free and deterministic; see `engine/reveal.ts`.
   */
  | 'reveal'
  /**
   * The author's selector resolved but a fixed or sticky bar intercepted the
   * pointer; the target was scrolled to the middle of the viewport and the
   * same selector acted. Free and deterministic.
   */
  | 'scroll'
  /**
   * The author's selector resolved and only its TEXT missed, and the claim
   * held against its container instead — a label whose value sits beside it.
   * Free and deterministic; see `ancestorSelectors` in `engine/runner.ts`.
   */
  | 'kin'
  /**
   * The agent was asked the assertion's own question — read-only, so it could
   * not act — named the element holding the answer, and the harness re-ran
   * the author's comparison against it. The agent's answer is checked, never
   * believed. See `#agentReread` in `engine/runner.ts`.
   */
  | 'agent-read'
  /**
   * The author's own selector, given one more window at the healed timeout —
   * free, and the last deterministic rung before a model is paid. Exists for
   * content that renders after the fast-path budget (a hydrating detail
   * page): the step passes honestly, and a timing defect still says the page
   * is slower than the budget.
   */
  | 'late'
  | 'cache'
  | 'jit'
  | 'dialog'
  /**
   * The step only resolved after the workflow agent was let loose on the page
   * to make the control reachable — a menu opened, something scrolled into
   * view, a load waited out. The most expensive rung there is, and the only
   * one that *acts* on the application before the step runs.
   */
  | 'agent';

export interface HealRecord {
  /** Selector the healer replaced. */
  from: string;
  /** Selector the healer produced. */
  to: string;
  strategy: string;
  confidence: number;
  reasoning: string;
  model: string;
  /** Wall-clock cost of the control-plane round trip, in ms. */
  latencyMs: number;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

/**
 * Record of an unexpected dialog dismissed automatically before a step could
 * proceed. Named `DialogRecord`, not `InterstitialRecord` — "interstitial"
 * already means something else in this codebase (an unknown *page* the
 * workflow agent navigates through, see `orchestrator/workflow-agent.ts`);
 * this is a blocking dialog on the *current* page.
 */
export interface DialogRecord {
  /** Best-effort label for the dialog that was blocking the step. */
  name: string;
  /** Accessible text of the button clicked to dismiss it. */
  button: string;
}

/** Outcome of one attempt inside a data-driven `fillRetry` step. */
export interface DataRetryAttempt {
  attempt: number;
  kind: string;
  value: string;
  /** True once the failure indicator was no longer present after this attempt. */
  succeeded: boolean;
}

/** Record of a `fillRetry` step's regenerate-and-retry loop. */
export interface DataRetryRecord {
  kind: string;
  attempts: DataRetryAttempt[];
  succeeded: boolean;
  /** Set only when the `custom` kind escalated to a model. */
  model?: string | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

/** One action taken by the workflow agent while it held the browser. */
export interface AgentAction {
  index: number;
  action: string;
  selector: string | null;
  value: string | null;
  url: string;
  reasoning: string;
  ok: boolean;
  error?: string | undefined;
  durationMs: number;
  /**
   * When the action landed, ISO — the moment the film keeps for it (since
   * 2026-09-04). Absent on records written before the field existed.
   */
  finishedAt?: string | undefined;
  /**
   * What a `read` (or a `save`) actually read off the page — the agent's
   * evidence, not its claim. 179 rows of the QA workbook ask for a value to
   * be RECORDED rather than asserted ("ยังไม่มีคำตอบ ให้บันทึกค่าที่ระบบแสดงจริง"),
   * and without this the observation existed only inside the turn that made it.
   */
  observed?: string | undefined;
  /**
   * The typed outcome (2026-09-05, Phase B of the commerce-agents research):
   * `ok`, `failed`, or `blocked` — an action the HARNESS withheld on a
   * policy, provenance or approval rule, never acted on. `ok`/`error` stay as
   * they were for every reader that predates this; a blocked action is
   * `ok: false` with the reason in `error` AND this record, so nothing has
   * to parse a message to learn that no verdict about the application was
   * produced. Absent on records written before the field existed.
   */
  outcome?: ActionOutcome | undefined;
  /**
   * What the list showed when a `selectOption` missed (task C3, 2026-09-05)
   * — see `AgentListboxFacts`. Set only on an action whose act threw a
   * `ListboxOptionMissingError`; absent otherwise and on older records.
   */
  listbox?: AgentListboxFacts | undefined;
}

/**
 * The categories of page mutation a run's policy governs. Read off the
 * accessible name of the control a click lands on (`mutationCategoryOf` in
 * `src/orchestrator/mutation-policy.ts`): `delete` for the destructive
 * verbs, `approve` for approve/reject, `submit` for a form's commit. Every
 * other action is ordinary and is never gated.
 */
export type MutationCategory = 'submit' | 'delete' | 'approve';

/**
 * Why the harness held an action.
 *  - `capability` — the run's mutation policy denies (or does not allow) the category;
 *  - `provenance` — the target was never observed in this session, or is not in the latest snapshot;
 *  - `approval` — an irreversible action with no host approval and no pre-approved manifest entry;
 *  - `guardrail` — a deterministic loop guard (an unscoped destructive click, a circling control).
 */
export type BlockedReason = 'capability' | 'provenance' | 'approval' | 'guardrail';

/** The machine-readable rule behind a `blocked` outcome. */
export type BlockedRule =
  | 'policy-deny'
  | 'policy-allow-list'
  | 'target-never-observed'
  | 'target-not-in-latest-snapshot'
  | 'approval-missing'
  | 'approval-refused'
  | 'destructive-unscoped'
  | 'circling';

/** What the provenance ledger knew when a mutation was gated. */
export interface ProvenanceFacts {
  /** The identifiers the gate looked for — the row/record the selector scopes to. */
  targets: string[];
  /** Those observed at some point this session, from harness-captured page state. */
  observedThisSession: string[];
  /** Those present in the latest observed snapshot. */
  inLatestSnapshot: string[];
  /** When and where the latest snapshot was taken; null when nothing was observed yet. */
  latestSnapshotAt: string | null;
  latestSnapshotUrl: string | null;
}

export interface BlockedOutcome {
  kind: 'blocked';
  reason: BlockedReason;
  rule: BlockedRule;
  message: string;
  category: MutationCategory | 'ordinary';
  /** The identifier the gate was about, when it was about one. */
  target: string | null;
  /** Where the run's mutation policy came from (`env`, `cli`, `panel`, …), or null when none was configured. */
  policySource: string | null;
  provenance?: ProvenanceFacts | undefined;
}

/**
 * One action's outcome as a discriminated union. `blocked` is the lane the
 * research asked for: a held call is neither an application failure nor a
 * harness crash, and every consumer that scores a run must be able to tell
 * it apart without reading prose.
 */
export type ActionOutcome =
  | { kind: 'ok' }
  | BlockedOutcome
  | { kind: 'failed'; message: string };

/**
 * Why a workflow leg ENDED (2026-09-05, task C3) — the loop's own stop, typed,
 * so no reader has to parse `summary` to learn whether the PAGE, the HARNESS
 * or the MODEL ended the leg. The runner classes a failed leg by that source
 * (`agentLegFailure` in `engine/runner.ts`); the loop sets the value at every
 * place it already stopped, and changes nothing about WHEN it stops.
 *
 * - Page evidence: `arrived` — the goal's destination (or the state it
 *   describes) was reached, judged on the page, including the zero-call rungs
 *   (a replayed journey, a link the tree showed, a state already showing);
 *   `cannot-offer` — a control the goal names was opened and its WHOLE option
 *   list read twice, identically, after a settle, and the goal's value was on
 *   none of them (`ListboxOptionMissingError`, `listboxCannotOffer`).
 * - Harness limits: `budget` (the turn ceiling), `stalled` (an ok action
 *   repeated on an unchanged page after being told so), `no-progress` (nothing
 *   advanced for the judge's count of turns — the look-only handoff included;
 *   `lookedOnly` tells the two apart), `value-hunt`, `wandered`, `model-error`
 *   (the provider could not answer), `blocked` (a mutation, guardrail or
 *   authoring hold — see `blocked`; an authoring refusal has no hold record).
 * - The model's own account: `finish` (accepted; `settledBy` says whether the
 *   page or the claim settled it), `fail` (the model said the goal is
 *   unreachable — a CLAIM, carried with what the page showed in
 *   `unreachable`), `contradicted` (a finish the page refuted).
 *
 * Absent on records written before the field existed.
 */
export const AGENT_ENDED_BY = [
  'finish',
  'arrived',
  'fail',
  'budget',
  'stalled',
  'no-progress',
  'value-hunt',
  'cannot-offer',
  'wandered',
  'blocked',
  'model-error',
  'contradicted',
] as const;
export type AgentEndedBy = (typeof AGENT_ENDED_BY)[number];

/**
 * What a listbox showed when a `selectOption` missed — copied off the
 * `ListboxOptionMissingError` the act threw, BEFORE the error is flattened to
 * the action's `error` string. Harness observation, not the model's word: the
 * engine opened the control and read its options itself.
 */
export interface AgentListboxFacts {
  /** The trigger's own label when the list opened — the page's name for the control. */
  trigger: string;
  /** The option the goal asked for. */
  value: string;
  /** How many options the list showed. */
  shownCount: number;
  /** The first (at most eight) options, verbatim. */
  shownHead: string[];
  /** Was `shown` narrowed by a typed search head? A filtered list says nothing about what it hid. */
  filtered: boolean;
  /** The search head the list's own empty row answered, or null. */
  searchedEmpty: string | null;
}

/**
 * The model's `fail`, kept beside what the page showed at that moment.
 *
 * `claim` is the model's own reasoning — a CLAIM about the application,
 * never evidence of anything; it is recorded so a reader can weigh it against
 * `urlAfter` and `headingsAfter`, which the harness read off the page itself.
 */
export interface AgentUnreachableClaim {
  /** The model's reasoning for `fail`, verbatim (secrets masked). A claim, not a finding. */
  claim: string;
  /** Where the page was when the model gave up — read by the harness. */
  urlAfter: string;
  /** The headings the accessibility tree showed then (at most eight) — read by the harness. */
  headingsAfter: string[];
}

/**
 * What the agent judged, chose, and did when a step met something the flow
 * does not describe.
 *
 * The rung above this one (`modal.ts`) is deliberately ARIA-only, and the
 * overlay rung needs Playwright to name a pointer-interception. Neither can
 * see the shape that actually stopped a run: PB_01_01 against localhost:3000
 * met a full-page PDPA consent screen — "Accept and continue" — that is
 * neither a `role="dialog"` nor an interceptor. In that run the click only
 * existed because a person had written it into the flow; with nobody
 * anticipating it the run dies on "could not resolve" and files defects about
 * a feature it never reached.
 *
 * So the agent is asked to look and choose, and what it chose is kept here.
 * The separation is the point: `observed`/`decided`/`because` are the agent's
 * own words — claims — while `actions` are what it actually did and
 * `resolved` is whether the author's own selector then worked. Only the last
 * of those is evidence, and the report must never present the first three as
 * anything else.
 */
export interface StepDecision {
  /** What the agent judged was in the way, in its own words. Empty when it saw nothing. */
  observed: string;
  /** What it chose to do — including choosing to do nothing. */
  decided: string;
  /** Its stated reason. */
  because: string;
  /** What it actually did. Claims are not evidence; these are the acts. */
  actions: AgentAction[];
  /** Whether the author's own selector resolved afterwards. THE evidence. */
  resolved: boolean;
  model: string;
}

/** Record of a multi-page navigation the agent completed on the runner's behalf. */
export interface AgentRecord {
  goal: string;
  model: string;
  success: boolean;
  summary: string;
  actions: AgentAction[];
  /**
   * Every value the agent read, gathered for the step's evidence — see
   * `AgentAction.observed`. The runner copies these onto `detail.observed`
   * so the report and the Excel export can show them as observations.
   */
  observations?: { selector: string; text: string; url: string }[] | undefined;
  /** Model turns consumed out of the step budget. */
  turns: number;
  /** The configured turn ceiling, or null when the run was unbounded and the
   *  loop's own logic (arrival, stall, no-progress) was the only judge. */
  maxSteps: number | null;
  latencyMs: number;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  /**
   * The loop ended because every action it took was a look (scroll, wait) —
   * it never had a page control the goal could name. Set by
   * `WorkflowAgent#lookedOnly`; consumed in `engine/runner.ts` the same way
   * as `verificationOnlyGoal`, because it is structural evidence of the same
   * fact `verificationOnlyGoal` tries to read out of the goal's WORDING in
   * advance: a goal that is a reading question, which an agent cannot answer
   * by acting. Runtime evidence catches the shapes the classifier cannot —
   * an ambiguous goal, or one with no verify verb at all that still turned
   * out to have nothing to click.
   */
  lookedOnly?: boolean | undefined;
  /**
   * How a SUCCESSFUL finish was settled (2026-08-28, S1 of the agent-flaw
   * audit): `observed-state` — the harness re-read the goal's end state off
   * the live tree and `settledEvidence` is the line that showed it;
   * `agent-claim` — the goal named no checkable state and the model's word
   * stands, with its reasoning as the evidence. Absent on a failure or a
   * zero-call rung. Audit finding: 20 of 22 agent legs on passed cases were
   * settled by the claim alone, invisibly; now the record says which.
   */
  settledBy?: 'observed-state' | 'agent-claim' | undefined;
  settledEvidence?: string | undefined;
  /**
   * Set when the leg ENDED on a held action: the mutation policy denied the
   * category, the target's provenance could not be established, or an
   * irreversible action had no approval. The run's verdict treats it as
   * "no application verdict" — the page was never asked — and files no
   * defect. Guardrail holds are terminal for the same reason: the withheld
   * action established nothing about the application.
   */
  blocked?: BlockedOutcome | undefined;
  /**
   * The tactic skills the loop chose for this leg (Phase C, 2026-09-05 —
   * `src/orchestrator/agent-skills.ts`), so a report can say which guidance
   * the model was sent. Absent when none applied or on older records.
   */
  skills?: string[] | undefined;
  /**
   * Input tokens the provider reported as served from its prompt cache,
   * summed over the leg's turns — the measure of whether the stable-first
   * prompt order is paying. Absent when the provider does not say.
   */
  cachedInputTokens?: number | undefined;
  /**
   * Why the leg ended — see `AgentEndedBy`. The typed form of the stop the
   * `summary` narrates, so the runner, the exit contract and a report can
   * class a failure by the SOURCE of its evidence without parsing prose.
   * Absent on records written before the field existed.
   */
  endedBy?: AgentEndedBy | undefined;
  /**
   * Present only when `endedBy === 'fail'`: the model's own account of why
   * the goal is unreachable (`claim` — a claim, never evidence) beside what
   * the harness read off the page at that moment. See `AgentUnreachableClaim`.
   */
  unreachable?: AgentUnreachableClaim | undefined;
}

export type DefectSeverity = 'high' | 'medium' | 'low';
/**
 * `backend` is deliberately its own category rather than a flavour of
 * `functional`: it routes to a different team and calls for a different fix.
 * A functional defect says the test and the app disagree; a backend defect
 * says a request the page made did not succeed, which no amount of selector
 * work will repair.
 */
export type DefectCategory =
  | 'functional'
  | 'usability'
  | 'accessibility'
  | 'backend'
  /**
   * The page answered with an authorization failure — an Access Denied
   * surface, a 401/403 document. Its own category for the same reason
   * `backend` is: it routes to a different conversation (who is signed in,
   * what may they see) and no amount of selector work will fix it.
   */
  | 'authorization';

/** A usability or functional problem, from static analysis or from a failing step. */
export interface Defect {
  id: string;
  severity: DefectSeverity;
  category: DefectCategory;
  title: string;
  detail: string;
  /** Where the model or runner says the problem lives. */
  selector?: string | undefined;
  /** Index of the step that surfaced it, when it came from a run. */
  stepIndex?: number | undefined;
  source: 'generator' | 'runtime';
  /**
   * How many identical findings this one stands for. Repeated identical
   * failures (same title, selector, category, source) cluster into one defect
   * at recording time — eleven copies of "Step failed: fill role=textbox"
   * read as eleven problems when they are one problem hit eleven times.
   * Absent means 1.
   */
  occurrences?: number | undefined;
  /** Every step that surfaced this defect, when it clustered. First one is `stepIndex`. */
  stepIndexes?: number[] | undefined;
}

export interface ProofStep {
  index: number;
  action: string;
  /** The author's plain-language description of this step, verbatim from `FlowStep.intent`. */
  intent?: string | undefined;
  /**
   * Who the step ran as — the persona label a `signIn` established on the
   * session the step drove — and on which Chrome (its CDP endpoint), once a
   * run spans more than one person (multi-browser personas). Stamped by the
   * builder from `setActor`, so the report can say "manager, browser 9223"
   * beside the step rather than leaving the reader to reconstruct it.
   */
  persona?: string | undefined;
  browser?: string | undefined;
  /**
   * What a backend check would have proved about this step, when the run's
   * backend toggle was off and the claim deserved one.
   *
   * The author writes it as an `intent` beginning `backend could prove this:`
   * (see `BACKEND_HINT_PREFIX`), and it is lifted here — at the one recording
   * choke point, so every action carries it the same way. Never a defect and
   * never a verdict: the visual check really did pass, and this says a
   * stronger proof exists that this run chose not to take.
   */
  backendHint?: string | undefined;
  /**
   * Set when this step is the reason a run is `needs-review`: the assertion
   * failed on a near-miss of wording, and this is the proof of the unsure
   * part — expected vs actual, in one line, for the human who must rule.
   */
  unsure?: string | undefined;
  selector: string | null;
  /** The selector that actually resolved — differs from `selector` when healed. */
  resolvedSelector: string | null;
  resolution: ResolutionSource | null;
  status: StepStatus;
  startedAt: string;
  durationMs: number;
  url: string | null;
  detail?: Record<string, unknown> | undefined;
  heal?: HealRecord | undefined;
  /** Populated when an unexpected dialog was dismissed before this step could retry. */
  dialog?: DialogRecord | undefined;
  agent?: AgentRecord | undefined;
  /**
   * The step was held by the harness before any mutation: its `workflow`
   * leg ended on a policy, provenance or approval rule (`AgentRecord.blocked`,
   * lifted here so a reader of the step never has to open the agent record).
   * Status is `error` — the system family — and no defect is filed: nothing
   * about the application was established either way.
   */
  blocked?: BlockedOutcome | undefined;
  /**
   * What the agent decided when this step met an interaction the flow does not
   * describe — recorded whether it acted, acted in vain, or declined. A
   * decision not to act is exactly the fact a later reader needs; dropping it
   * makes "the agent was consulted and saw nothing" indistinguishable from
   * "the agent was never tried".
   */
  decision?: StepDecision | undefined;
  /** Visual-regression result, when this step was a `snapshot`. */
  snapshot?: SnapshotResult | undefined;
  /** Per-value outcomes, when this step was a data-driven `fillEach`. */
  dataCases?: DataCaseResult[] | undefined;
  /** Populated when this step was a data-driven `fillRetry`. */
  dataRetry?: DataRetryRecord | undefined;
  /**
   * HTTP calls the page made while this step was running.
   *
   * Only attached when they are actually evidence — the step failed, or one of
   * the calls failed — because a busy SPA issues dozens per interaction and
   * recording them all would bury the report in noise it cannot act on.
   */
  network?: NetworkCall[] | undefined;
  /**
   * The call this step made, when it was a `request` step.
   *
   * Distinct from `network` on purpose: that is traffic the *page* generated
   * and wowlidator merely watched, this is a call the *test* made deliberately.
   */
  request?: RequestRecord | undefined;
  /**
   * The database check this step made, when it was a DB step. Singular, like
   * `request`: the check the *test* performed, redacted before it got here.
   */
  db?: DbCheckRecord | undefined;
  /**
   * What this step acted on or checked, read from the live element at the
   * moment of the step (2026-09-02): the selector that resolved, the
   * element's role and accessible name (or tag and text) and where it sat on
   * the page. The screenshot draws a red rectangle around exactly this box.
   * Absent for a step with no element — a navigation, an HTTP step, an
   * absence assertion — and for a step whose element could not be read in
   * time; never a reason for a step to fail. See `engine/target.ts`.
   */
  target?: StepTarget | undefined;
  /**
   * What this backend step did to the tables under test, against the run's
   * database BASELINE (the snapshot taken before the run — see
   * `src/db/baseline.ts`), one entry per baseline table. Compared to the
   * baseline, not to the previous step, so a reader sees the cumulative
   * state the run has put the data in. Evidence, never a verdict: an
   * unchanged table is recorded too, and a probe that failed leaves
   * `dbProbeError` instead. Only on HTTP and DB steps, only when a baseline
   * exists for the run.
   */
  dbChanges?: StepDbChange[] | undefined;
  dbProbeError?: string | undefined;
  /**
   * Base64 JPEG, embedded directly into the HTML report.
   *
   * With video recording on this is a *failure* still only: the run is already
   * on film, so a frame per step would be the same evidence twice at several
   * times the size. What a still adds over a frame is resolution — a failure
   * is the one thing someone zooms into to read an error message or check a
   * border — so that is the one place it is still captured.
   */
  screenshot?: string | undefined;
  /**
   * Where this step begins in the run's recording, in ms from the first frame.
   *
   * This is what makes one video per-step evidence rather than a single long
   * clip nobody scrubs: the report seeks to it. Absent when nothing was
   * recorded, and absent for a step that never touched the page.
   */
  videoOffsetMs?: number | undefined;
  error?: string | undefined;
  /**
   * What the page was showing when this step failed — up to a few
   * heading/landmark lines from the AX tree that was already captured for the
   * heal attempt. This is how "the page said Access Denied" becomes
   * first-class evidence instead of a substring of a rejected repair. Failed
   * steps only; never a fresh capture.
   */
  pageContext?: string[] | undefined;
  /**
   * Repair candidates the healer proposed and the run refused, with why.
   * A rejected proposal is what the model *saw on the page* — frequently the
   * diagnosis itself — so it is kept as data, not just as a trace substring.
   */
  rejectedHeals?: RejectedHeal[] | undefined;
  /**
   * Set when this step failed after an earlier step in the run had already
   * failed: its failure may be a consequence, not an independent finding.
   */
  downstream?: boolean | undefined;
  /**
   * This failure was followed by a successful in-run reconstruction of the
   * same step, so it is an *attempt*, not the step's outcome. Superseded
   * steps stay listed — the report shows what was tried — but count toward
   * nothing: not the pass/fail tallies, not the run status, not the trend's
   * failure signatures.
   */
  superseded?: boolean | undefined;
  /** Set on a step that ran as an in-run reconstruction of a failed one. */
  reconstruction?: ReconstructionRecord | undefined;
}

/** One baseline table's state after a backend step — see `ProofStep.dbChanges`. */
export interface StepDbChange {
  table: string;
  baselineRows: number;
  rows: number;
  /** Content hash differs from the baseline's. */
  changed: boolean;
  inserted?: number | undefined;
  deleted?: number | undefined;
  updated?: number | undefined;
  /** Up to `DIFF_SAMPLE_MAX` changed rows, keyed on the primary key, every cell redacted. */
  sample?: { kind: 'inserted' | 'deleted' | 'updated'; key: string; row: Record<string, string> }[] | undefined;
}

/** What the bundle records about the run's database baseline — names and a time, never values. */
export interface DbBaselineSummary {
  tables: string[];
  takenAt: string;
}

/** One line per changed table — what `formatStepLine` and the reports print. */
export function describeDbChanges(changes: readonly StepDbChange[] | undefined): string[] {
  if (changes === undefined) return [];
  return changes
    .filter((c) => c.changed)
    .map((c) => {
      const parts: string[] = [];
      if (c.inserted) parts.push(`+${c.inserted} inserted`);
      if (c.deleted) parts.push(`−${c.deleted} deleted`);
      if (c.updated) parts.push(`~${c.updated} updated`);
      const delta = parts.length > 0 ? parts.join(', ') : `${c.baselineRows} → ${c.rows} rows`;
      return `db ${c.table}: ${delta} vs baseline`;
    });
}

/** The element a step acted on or checked — see `ProofStep.target`. */
export interface StepTarget {
  /** The selector that resolved to it (the healed one, when healed). */
  selector: string;
  /** Lower-case tag name. */
  tag?: string | undefined;
  /** ARIA role, explicit or implied by the tag. */
  role?: string | undefined;
  /** Accessible name — aria-label, label, alt, title, placeholder or text. */
  name?: string | undefined;
  /** Visible text when it differs from the name, trimmed. */
  text?: string | undefined;
  /** Document-coordinate CSS px at capture time; the red rectangle's box. */
  box?: { x: number; y: number; width: number; height: number } | undefined;
}

/**
 * One line naming a target: `button "Sign in" · 120×40 at (30,200)`. The
 * same wording in the CLI, the reports, the workbook and the panel.
 */
export function describeTarget(target: StepTarget | undefined): string | null {
  if (target === undefined) return null;
  const what = target.role ?? target.tag ?? 'element';
  const label = target.name ?? target.text;
  const parts = [label === undefined ? what : `${what} ${JSON.stringify(label)}`];
  if (target.box) {
    parts.push(`${target.box.width}×${target.box.height} at (${target.box.x},${target.box.y})`);
  }
  return parts.join(' · ');
}

/**
 * Where an input step's value came from, when authoring had to find or invent
 * it — read off `detail.valueSource` (`generator/value-resolution.ts`). One
 * wording for the CLI, both HTML reports, the Excel export and wowUI. Null
 * when the sheet stated the value itself.
 */
export function describeValueSource(step: { detail?: Record<string, unknown> | undefined }): string | null {
  const raw = step.detail?.['valueSource'];
  if (typeof raw !== 'object' || raw === null) return null;
  const source = raw as { kind?: unknown; detail?: unknown };
  if (typeof source.kind !== 'string') return null;
  const detail = typeof source.detail === 'string' ? source.detail : '';
  if (source.kind === 'generated') return `generated — ${detail || 'a stand-in the author invented'}`;
  return `from ${source.kind}${detail ? `: ${detail}` : ''}`;
}

/** True when the step typed a value the author invented rather than one the sheet stated. */
export function valueWasGenerated(step: { detail?: Record<string, unknown> | undefined }): boolean {
  const raw = step.detail?.['valueSource'] as { kind?: unknown } | undefined;
  return typeof raw === 'object' && raw !== null && raw.kind === 'generated';
}

/** What an in-run reconstruction did to a failed step, kept as evidence. */
export interface ReconstructionRecord {
  /** Which try finally held (1 = the original, so this is ≥ 2). */
  attempt: number;
  /** The step as the flow wrote it, JSON-encoded. */
  from: string;
  /** The step as reconstructed, JSON-encoded. Equal to `from` for an assertion. */
  to: string;
  /** Steps inserted before the retry (dismissals, waits, missed preconditions). */
  inserted: number;
  reasoning: string;
  model: string;
}

/** A repair candidate the run refused, kept because it is evidence. */
export interface RejectedHeal {
  proposed: string;
  confidence: number;
  reasoning: string;
  rejectedBecause: string;
}

/** Outcome of one value in a data-driven step. */
export interface DataCaseResult {
  label: string;
  value: string;
  ok: boolean;
  error?: string | undefined;
}

/**
 * One side of a run's result — the UI half or the HTTP half.
 *
 * Separated because a mixed flow's headline pass/fail cannot answer the
 * question anyone actually asks when it goes red: *which side is broken?* A
 * failed `expectVisible` and a failed `expectStatus` route to different people,
 * and rolling them into one number hides that. `frontend.defects +
 * backend.defects` always equals `defects`.
 */
export interface TierSummary {
  /** Steps belonging to this side. */
  steps: number;
  passed: number;
  failed: number;
  /** Defects attributed to this side — `backend` category, or everything else. */
  defects: number;
}

export interface ProofSummary {
  totalSteps: number;
  passed: number;
  failed: number;
  /** Steps that drove the page. */
  frontend: TierSummary;
  /**
   * Steps that called the API directly (`request`/`expectStatus`/…).
   *
   * Deliberately *not* the same thing as the `network*` counters: those are
   * traffic the page made on its own, observed passively. This is HTTP the
   * test itself performed and asserted on.
   */
  backend: TierSummary;
  fastPath: number;
  /**
   * Steps that only resolved once the accessible name was matched
   * case-insensitively — free and deterministic, but it means the flow's
   * selector and the page disagree about case. See `src/engine/selector.ts`.
   */
  caseRetries: number;
  cacheHits: number;
  jitHeals: number;
  /** Steps that only succeeded after an unexpected dialog was dismissed. */
  dialogsDismissed: number;
  /** Steps handed to the multi-page workflow agent. */
  agentTakeovers: number;
  /** Visual snapshots compared, and how many drifted. */
  visualChecks: number;
  visualFailures: number;
  /** `fillRetry` steps that needed more than one attempt. */
  dataRetries: number;
  /** `request` steps the test itself made. */
  apiRequests: number;
  /** Of those, ones that never got a response (transport failure). */
  apiFailures: number;
  /** Database checks the test itself made (snapshots included). */
  dbChecks: number;
  /** Of those, ones that did not pass. */
  dbFailures: number;
  /** HTTP calls the page made, as observed over CDP. */
  networkCalls: number;
  /** Of those, ones that failed hard enough to explain a broken step. */
  networkFailures: number;
  /** Steps that suppressed a JIT heal because a request had already failed. */
  backendBlocked: number;
  /**
   * Heal attempts that never got an answer because the *provider* failed —
   * rate limit, transport, unparseable response. Counted apart from
   * `jitHeals` because a rung the machinery could not climb says nothing
   * about the page, and conflating the two blames the app for an outage.
   */
  healUnavailable: number;
  /**
   * Calls that fell out of the observer's ring buffer. Reported rather than
   * swallowed — a truncated capture reads exactly like a quiet page otherwise.
   */
  networkDropped: number;
  /** Total ms spent inside control-plane calls (healer + agent). */
  healLatencyMs: number;
  agentLatencyMs: number;
  inputTokens: number;
  /**
   * What THIS run spent on a session-billed provider (the Claude CLI), when
   * one was used. Absent otherwise, so a run on an API-key provider carries
   * nothing it cannot substantiate.
   *
   * Its own field rather than folded into `inputTokens`, because it answers
   * a different question: the token counters say how much work the control
   * plane did, and this says what the person's session was charged for it —
   * the number they can check against their own account.
   */
  session?:
    | {
        provider: string;
        calls: number;
        costUsd: number;
        inputTokens: number;
        cachedInputTokens: number;
        outputTokens: number;
        wallMs: number;
        /**
         * The same spend split by the role that asked — authoring
         * (`generator`), repair (`healer`), the agent, data. Only roles that
         * actually called appear; absent on bundles from before 2026-08-27.
         */
        byRole?:
          | Record<
              string,
              {
                calls: number;
                costUsd: number;
                inputTokens: number;
                cachedInputTokens: number;
                outputTokens: number;
              }
            >
          | undefined;
        /**
         * Where the account's 5-hour session window stood around this run,
         * when the quota endpoint answered: the percent used at start and at
         * end, so a cost figure is never read without its "and how much of
         * my session was that" half. Absent when quota was unreadable.
         */
        quota?:
          | {
              beforePercent: number;
              afterPercent: number;
              resetsAt: string | null;
            }
          | undefined;
      }
    | undefined;
  outputTokens: number;
  defects: number;
}

/** Where a flow came from, when it wasn't hand-written. */
export interface GenerationProvenance {
  model: string;
  /**
   * When the authoring pass that produced this case ran.
   *
   * Identical across every case of one pass and different for the next one,
   * which is what makes it the identity of a *batch*: running the same catalog
   * twice produces two values, so the two runs of a case never collapse into
   * one group. wowUI groups the run list on exactly this.
   */
  generatedAt: string;
  sourceUrl: string;
  kind: string;
  rationale: string;
  /**
   * The sheet's own recorded outcome for this case (`Actual Result`,
   * normalised): what a person found when they last ran it by hand. This is
   * the ground truth wowUI's accuracy compares a run's verdict against —
   * Positive/Negative says what the case means to prove, only this says how
   * the application actually behaved. Absent when the sheet recorded nothing
   * (blank, Cancelled, Pending) or the source was not a test-case table.
   */
  knownResult?: 'passed' | 'failed' | 'blocked' | undefined;
  /**
   * The sheet's own id for this case when the catalog had to qualify it
   * (`BE:PL_03_01` for a `PL_03_01` that two sheets share; `TSH_01_01#6` for
   * a repeat) — what the report and wowUI show as the case's chip. Absent
   * when `caseId` is the sheet's spelling already (CG-04, 2026-09-03).
   */
  sheetCaseId?: string | undefined;
  /** The workbook sheet and category the row came from (CG-11). */
  sheet?: string | undefined;
  category?: string | undefined;
  /**
   * The row's Expected column is wholly record-only ("= ? OQ-HIR-nn … ให้รัน
   * จริงแล้วบันทึกค่าที่ระบบแสดง") — the run captures, a person judges (CG-09).
   */
  recordOnly?: boolean | undefined;
  /**
   * The document this was authored from — a catalog's file name.
   *
   * `sourceUrl` is the *page* the flow was grounded against, which for a
   * catalog run is the same login screen for every case of every catalog, so
   * it cannot name what a reader is actually looking at. Absent for anything
   * not authored from a document.
   */
  source?: string | undefined;
  /**
   * The sheet's scenario this case belongs to (`<scenarioId> <title>`), and
   * the row's own test-case title. Per case, not per pass — wowUI groups a
   * catalog's cases by scenario and shows the title beside the case id.
   * Absent for anything not authored from a test-case table.
   */
  scenario?: string | undefined;
  caseTitle?: string | undefined;
  /**
   * The catalog run's unique key: `<catalog name, slugged>@<generatedAt>`,
   * minted when the run is initialised and reused verbatim by every resume of
   * it (the ledger stores it; `cmdCatalog` reads it back). It is the pass
   * identity made legible — the stamp above stays the grouping key, since
   * bundles written before this field existed carry only the stamp, and the
   * key embeds it, so the two group identically. Absent for anything not run
   * as a catalog.
   */
  runKey?: string | undefined;
}

/** What `error-diagnosis.ts` concluded about a SYSTEM ERROR after the run — see there. */
export interface ErrorDiagnosis {
  /** Which layer broke: test-catalog | generator | agent | environment | application. */
  origin: string;
  /** 0–1. */
  confidence: number;
  reasoning: string;
  /** A concrete fix when one is available; null is the honest empty. */
  fix: string | null;
  /** True when a person can act on the fix now. */
  actionable: boolean;
  /** Facts computed from the run and handed to the model as evidence. */
  signals: string[];
  model: string;
  at: string;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

/** What `dead-end-risk.ts` decided about a case before it ran — see there. */
export interface DeadEndRisk {
  /** 0–1: how likely the run ends dead-end / error rather than a verdict. */
  likelihood: number;
  /**
   * 0–1: how likely the run ends in a GENUINE FAIL — the application
   * contradicting the claim (a sheet row recorded Failed, a note citing a
   * defect, documents that say the app does not satisfy it). A near-certain
   * fail is a fact retries only re-prove, so past the threshold it fail-fasts
   * exactly like a dead-end (asked for 2026-08-28). Absent on records from
   * before the second dimension existed.
   */
  failLikelihood?: number | undefined;
  /** The line it was judged against (0–1). */
  threshold: number;
  verdict: 'run' | 'fail-fast';
  reasons: string[];
  /** What the flow needs that no evidence shows exists. */
  missing: string[];
  /** Facts computed from the code and handed to the model as evidence. */
  signals: string[];
  model: string;
  at: string;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

/** A persona's own recording — see `ProofBundle.videos`. */
export interface PersonaVideo {
  persona: string;
  /** The Chrome it was filmed on; null when unknown. */
  browser: string | null;
  video: VideoRecording;
}

export interface ProofBundle {
  /**
   * Marked known-flaky by `--quarantine-flaky`: the result is reported in full
   * but must not be counted as a failure by anything downstream. Absent means
   * "not quarantined" — silence about flakiness is the failure mode
   * `src/history/` exists to prevent, so this is never set automatically.
   */
  quarantined?: boolean | undefined;
  runId: string;
  name: string;
  /**
   * The name the run was recorded under, when a person renamed it in wowUI.
   * Kept so anything keyed on the original — the flow file lookup, history
   * lines written before the rename — can still be matched; set once, on the
   * first rename, and never overwritten by later renames.
   */
  renamedFrom?: string | undefined;
  /**
   * A needs-review whose every disputed expected value comes verbatim from
   * the case's own sheet wording — the page renders the same fact under
   * different words or design. This is a SPEC QUESTION for BA triage
   * (deliberate design vs the sheet), not a machine-decidable defect.
   * Stamped by `runFlow`; EN-2 audit: 29 of 31 genuine QA fails were this
   * class, and a binary pass/fail hid every one.
   */
  specQuestion?: boolean | undefined;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /**
   * When the CASE's work began — set by the suite loop at case pickup, so it
   * covers what `durationMs` (this one flow attempt) cannot: the session
   * bootstrap, every earlier repair attempt, the investigation between them.
   * Absent on a standalone `runFlow` (there, `startedAt` is the whole story).
   * Added 2026-08-27: a repaired case's displayed time was the LAST attempt
   * only, reading far shorter than the wall clock a person watched.
   */
  caseStartedAt?: string | undefined;
  /** `caseStartedAt` → this bundle's finish. The number a stopwatch agrees with. */
  caseDurationMs?: number | undefined;
  cdpUrl: string | null;
  cachePath: string | null;
  healerModel: string | null;
  summary: ProofSummary;
  steps: ProofStep[];
  defects: Defect[];
  /**
   * The run on film, when recording was on.
   *
   * One recording per run rather than one per step, because that is what the
   * browser produces and because the interesting thing about a video is
   * precisely the part between two steps. `ProofStep.videoOffsetMs` is how a
   * step addresses its own moment in it.
   */
  video?: VideoRecording | undefined;
  /**
   * The other people's films, when the run gave each persona its own Chrome:
   * one recording per persona session opened by a `signIn`, beside the
   * primary in `video`. Steps address theirs by `persona` + `videoOffsetMs`.
   */
  videos?: PersonaVideo[] | undefined;
  /** UI coverage measured against the AX tree at the end of the run. */
  coverage?: CoverageReport | undefined;
  /** How this run compares to previous runs of the same flow. */
  trend?: RunTrend | undefined;
  /**
   * Variables the run saved, masked by name before they got here — see
   * `VariableStore.snapshotForReport`. A DB check keyed on `{{orderId}}` is
   * only auditable if the report can say what `orderId` was.
   */
  variables?: Record<string, string> | undefined;
  /**
   * Decisions the harness took about THIS run that a reader should know and
   * that are not findings — "started from an empty session because the flow
   * signs in itself". One line each, plain words.
   */
  notes?: string[] | undefined;
  generatedBy?: GenerationProvenance | undefined;
  /**
   * Whether this test MEANS to prove acceptance or refusal. A negative test's
   * green run says "the application refused it, as required" — read without
   * this label, the same green says the opposite. `polaritySource` says
   * whether the catalog stated it or the harness inferred it, because a
   * stated column is the author's word and an inference is only a reading.
   */
  polarity?: TestPolarity | undefined;
  polaritySource?: PolaritySource | undefined;
  /**
   * A human's ruling on a `needs-review` run, written back into the bundle
   * file by the panel (or by hand). `proved` means the near-miss wording is
   * acceptable and the claims count as held; `failed` means it is a real
   * mismatch. The original status is never rewritten — the ruling sits
   * beside it, so what the machine said and what the person decided are both
   * on the record.
   */
  review?:
    | {
        verdict: 'proved' | 'failed';
        at: string;
        /**
         * Who ruled. Absent = a human (wowUI's Confirm buttons). A model
         * ruling (`src/engine/review-judge.ts`) carries its model label here
         * plus its confidence and reasoning — and a human may REPLACE a model
         * ruling in the panel; never the reverse.
         */
        by?: string | undefined;
        confidence?: number | undefined;
        reasoning?: string | undefined;
      }
    | undefined;
  error?: string | undefined;
  /**
   * The pre-run dead-end risk the suite loop judged this case at, when it did
   * (`src/generator/dead-end-risk.ts`). `fail-fast` means the run happened ONCE
   * with no healer, no agent, no reconstruction and no repair loop — the
   * verdict is real, only the retries were withheld. Absent when the
   * assessment is off, the model could not be resolved, or the flow was
   * hand-written.
   */
  risk?: DeadEndRisk | undefined;
  /**
   * Filled only when `status` is `error` and the diagnosis judge ran: which
   * layer the SYSTEM ERROR came from and the fix, when one exists. Never a
   * verdict and never a repair — an explanation, so a person stops re-running
   * a case whose data was never seeded. See `src/generator/error-diagnosis.ts`.
   */
  diagnosis?: ErrorDiagnosis | undefined;
  /**
   * The database baseline this run compared its backend steps against, when
   * one was taken (`src/db/baseline.ts`): which tables and when. The values
   * live in the local baseline file only.
   */
  dbBaseline?: DbBaselineSummary | undefined;
}

export interface ProofBundleBuilderOptions {
  name: string;
  cdpUrl?: string | null | undefined;
  cachePath?: string | null | undefined;
  healerModel?: string | null | undefined;
  runId?: string | undefined;
  generatedBy?: GenerationProvenance | undefined;
  /** Called synchronously right after each step is recorded — for live progress output. */
  onStep?: ((step: ProofStep) => void) | undefined;
  /** See `ProofBundle.polarity`. Stamped by `runFlow` from the flow or by inference. */
  polarity?: TestPolarity | undefined;
  polaritySource?: PolaritySource | undefined;
}

/** Accumulates steps during a run and seals them into a `ProofBundle`. */
/**
 * The lead a step's moment is owed on the film: the fixed lead plus how long
 * the step PERFORMED (`detail.performedMs`, written by a humanised action —
 * `humanize.ts`), when it says. Bounded by `leadOf` at the window.
 */
function stepLeadMs(step: Pick<ProofStep, 'detail'>): number | undefined {
  const performed = step.detail?.['performedMs'];
  return typeof performed === 'number' && Number.isFinite(performed) && performed > 0
    ? VIDEO_ACTION_LEAD_MS + performed
    : undefined;
}

export class ProofBundleBuilder {
  readonly runId: string;
  readonly name: string;
  readonly startedAt: string;

  readonly #startedMs: number;
  readonly #cdpUrl: string | null;
  readonly #cachePath: string | null;
  readonly #healerModel: string | null;
  readonly #generatedBy: GenerationProvenance | undefined;
  readonly #polarity: TestPolarity | undefined;
  readonly #polaritySource: PolaritySource | undefined;
  readonly #steps: ProofStep[] = [];
  readonly #defects: Defect[] = [];
  readonly #onStep: ((step: ProofStep) => void) | undefined;
  #coverage: CoverageReport | undefined;
  #trend: RunTrend | undefined;
  #dbBaseline: DbBaselineSummary | undefined;
  #variables: Record<string, string> | undefined;
  #notes: string[] = [];
  #errorIsTally = false;
  #video: VideoRecording | undefined;
  #videos: PersonaVideo[] = [];
  /**
   * When each recording's first frame was, by persona label — `''` for the
   * primary. A manager's step measured from the employee's first frame
   * would seek into the wrong film.
   */
  readonly #videoStartedMs = new Map<string, number>();
  /** Who steps are running as right now — see `setActor`. */
  #actor: { persona: string | undefined; browser: string | undefined } = { persona: undefined, browser: undefined };
  #error: string | undefined;
  #sessionLost = false;
  #network = { calls: 0, failures: 0, dropped: 0 };
  #backendBlocked = 0;
  #healUnavailable = 0;
  #extraInputTokens = 0;
  #extraOutputTokens = 0;
  #hasNonPass = false;

  constructor(options: ProofBundleBuilderOptions) {
    this.runId = options.runId ?? randomUUID();
    this.name = options.name;
    this.startedAt = new Date().toISOString();
    this.#startedMs = Date.now();
    this.#cdpUrl = options.cdpUrl ?? null;
    this.#cachePath = options.cachePath ?? null;
    this.#healerModel = options.healerModel ?? null;
    this.#generatedBy = options.generatedBy;
    this.#polarity = options.polarity;
    this.#polaritySource = options.polarity === undefined ? undefined : options.polaritySource;
    this.#onStep = options.onStep;
  }

  /** Append a completed step. `index` is assigned automatically. */
  addStep(step: Omit<ProofStep, 'index'>): ProofStep {
    const hint = backendHintOf(step.intent);
    const recorded: ProofStep = {
      index: this.#steps.length,
      // Who and where, from the one place that knows: the runner tells the
      // builder on every persona switch, so no call site has to.
      ...(this.#actor.persona === undefined ? {} : { persona: this.#actor.persona }),
      ...(this.#actor.browser === undefined ? {} : { browser: this.#actor.browser }),
      ...step,
      // Lifted from the intent at the one choke point every action passes
      // through: the alternative is eighteen call sites each remembering to
      // do it, which is the same reasoning as the video offset below.
      ...(hint === null ? {} : { backendHint: hint.hint, intent: hint.intent }),
      // Stamped here rather than at each `addStep` call site: every action in
      // the runner already reports `startedAt`, and there are a dozen and a
      // half of them. One derivation cannot disagree with itself.
      // Measured on the film of the session the step ran on — the actor's,
      // when the step did not name one itself. Fixed 2026-09-04: the offset
      // was derived from the bare argument, which never carries the persona
      // the builder stamps above, so every persona step was measured from
      // the PRIMARY film's first frame and seeks on a persona film were off
      // by however long after it that film began.
      ...this.#videoOffsetFor(
        step.persona === undefined && this.#actor.persona !== undefined ? { ...step, persona: this.#actor.persona } : step,
      ),
    };
    if (recorded.status !== 'passed') {
      // Marked here, at the one choke point, rather than by any caller: a
      // failure after an earlier failure may be a consequence of it, and the
      // report should be able to say so instead of presenting eleven
      // independent findings for one broken precondition.
      if (this.#hasNonPass) recorded.downstream = true;
      this.#hasNonPass = true;
    }
    this.#steps.push(recorded);
    this.#onStep?.(recorded);
    return recorded;
  }

  /**
   * Where a step sits in the recording.
   *
   * Nothing is stamped when recording is off, and nothing is stamped for a
   * step with no page to have been filmed — an HTTP step never appeared on
   * screen, so pointing at a moment in the video would invite someone to look
   * for something that was never there. Same rule that already denies those
   * steps a screenshot.
   */
  #videoOffsetFor(step: Omit<ProofStep, 'index'>): { videoOffsetMs?: number } {
    // The film of the session the step ran on: a persona's own when it has
    // one, else the primary's (the first persona binds to the primary).
    const startedMs =
      (step.persona === undefined ? undefined : this.#videoStartedMs.get(step.persona)) ??
      this.#videoStartedMs.get('');
    if (startedMs === undefined) return {};
    if (BROWSER_FREE_ACTIONS.has(step.action)) return {};
    const began = Date.parse(step.startedAt);
    if (Number.isNaN(began)) return {};
    return { videoOffsetMs: Math.max(0, began - startedMs) };
  }

  /**
   * Mark the moment a recording's first frame corresponds to, so steps can
   * be addressed against it. Once per recorded page: the primary's when it
   * is created, and a persona's (by label) when `signIn` opens its Chrome.
   */
  setVideoStart(startedMs: number, persona = ''): void {
    this.#videoStartedMs.set(persona, startedMs);
  }

  /**
   * Who the steps from here on run as. The runner calls it on every persona
   * switch; `addStep` stamps the current actor onto each step.
   */
  setActor(actor: { persona: string | null; browser: string | null }): void {
    this.#actor = { persona: actor.persona ?? undefined, browser: actor.browser ?? undefined };
  }

  /** The film a step was filmed on: its persona's own when it has one, else the primary's (`''`). */
  #filmOf(step: ProofStep): string | undefined {
    if (step.persona !== undefined && this.#videoStartedMs.has(step.persona)) return step.persona;
    return this.#videoStartedMs.has('') ? '' : undefined;
  }

  /**
   * The action moments on one film, in ms from its first frame: the instant
   * each filmed step COMPLETED (acted or asserted — its start plus its
   * duration, superseded attempts included, since they acted too), and the
   * instant each action the workflow agent took inside a `workflow` step
   * landed. What the agent only looked at (`wait`, `read`, `save`) and how
   * it ended (`finish`, `fail`) are no moment: nothing happened on screen.
   */
  videoMoments(persona = ''): number[] {
    return this.videoActionMoments(persona).map((m) => m.at);
  }

  /**
   * The same moments with the lead each is owed: a humanised step performs
   * for `detail.performedMs` (the pointer's approach, the typing — see
   * `humanize.ts`), and an agent action that landed performed for its
   * `durationMs`; the film keeps that performance ahead of the moment, on
   * top of the fixed lead. A failed action gets the fixed lead only — its
   * duration was the wait for something that was not there.
   */
  videoActionMoments(persona = ''): ActionMoment[] {
    const startedMs = this.#videoStartedMs.get(persona);
    if (startedMs === undefined) return [];
    const moments: ActionMoment[] = [];
    for (const step of this.#steps) {
      if (this.#filmOf(step) !== persona || step.videoOffsetMs === undefined) continue;
      moments.push({ at: step.videoOffsetMs + step.durationMs, leadMs: stepLeadMs(step) });
      for (const action of step.agent?.actions ?? []) {
        if (action.finishedAt === undefined || AGENT_LOOK_ACTIONS.has(action.action)) continue;
        const at = Date.parse(action.finishedAt) - startedMs;
        if (!Number.isFinite(at) || at < 0) continue;
        moments.push({ at, leadMs: action.ok ? VIDEO_ACTION_LEAD_MS + action.durationMs : undefined });
      }
    }
    return moments.sort((a, b) => a.at - b.at);
  }

  /**
   * Put a film's steps on the film's clock. A condensed recording dropped
   * the idle a step began in, so its offset moves to the start of its kept
   * moment (`VIDEO_ACTION_LEAD_MS` before it completed) — the frame a "play
   * from here" should land on.
   */
  #remapOffsets(persona: string, video: VideoRecording): void {
    const condensed = video.condensed;
    if (!condensed) return;
    for (const step of this.#steps) {
      if (this.#filmOf(step) !== persona || step.videoOffsetMs === undefined) continue;
      const moment = step.videoOffsetMs + step.durationMs;
      const lead = leadOf({ at: moment, leadMs: stepLeadMs(step) });
      step.videoOffsetMs = mapToCondensed(condensed.segments, Math.max(0, moment - lead));
    }
  }

  /** Attach a persona's own sealed recording — see `ProofBundle.videos`. */
  addPersonaVideo(persona: string, browser: string | null, video: VideoRecording): void {
    this.#remapOffsets(persona, video);
    this.#videos.push({ persona, browser, video });
  }

  /** Attach the sealed recording. Called after the recording context closes. */
  setVideo(video: VideoRecording): void {
    this.#video = video;
    this.#remapOffsets('', video);
    // The recording may end before the run did — it is deliberately cut at
    // the first failure — so any step whose offset lies at or past the end
    // loses it here. A "play from here" that seeks past the last frame is a
    // dead control pretending to be evidence. Reconciled only for a CUT
    // recording (`endsAtStep` set): an uncut film covers the whole run by
    // construction, and its *measured* duration can undershoot the last
    // step's start — a variable-frame-rate recorder writes no frames while a
    // paced page sits still — so stripping there would delete offsets the
    // film actually answers (a seek past the measured end clamps to the
    // final frame, which is exactly the state that step saw).
    const endMs = video.durationMs;
    if (endMs !== undefined && video.endsAtStep !== undefined) {
      for (const step of this.#steps) {
        if (step.videoOffsetMs !== undefined && step.videoOffsetMs >= endMs) {
          delete step.videoOffsetMs;
        }
      }
    }
  }

  /**
   * Attach a usability or functional finding to the run.
   *
   * Identical *runtime* findings cluster: same title, selector, category and
   * severity fold into one defect with an `occurrences` count and the full
   * list of step indexes. The alternative — eleven separate high-severity
   * defects for one broken login block — reads as eleven problems and buries
   * the two real ones. Generator findings never cluster; each is already a
   * distinct static observation.
   */
  addDefect(defect: Defect): void {
    if (defect.source === 'runtime') {
      const existing = this.#defects.find(
        (d) =>
          d.source === 'runtime' &&
          d.title === defect.title &&
          d.selector === defect.selector &&
          d.category === defect.category &&
          d.severity === defect.severity,
      );
      if (existing) {
        existing.occurrences = (existing.occurrences ?? 1) + 1;
        existing.stepIndexes = [
          ...(existing.stepIndexes ?? (existing.stepIndex !== undefined ? [existing.stepIndex] : [])),
          ...(defect.stepIndex !== undefined ? [defect.stepIndex] : []),
        ];
        return;
      }
    }
    this.#defects.push(defect);
  }

  addDefects(defects: readonly Defect[]): void {
    for (const defect of defects) this.addDefect(defect);
  }

  /**
   * Totals from the network observer, set once at the end of a run.
   *
   * Kept separate from `ProofStep.network` on purpose: the per-step arrays hold
   * only the calls that are evidence for a particular step, so summing them
   * would badly understate what the page actually did.
   */
  setNetworkTotals(totals: { calls: number; failures: number; dropped: number }): void {
    this.#network = { ...totals };
  }

  /** Record that a step declined to heal because a request had already failed. */
  noteBackendBlocked(): void {
    this.#backendBlocked += 1;
  }

  /** Record a heal attempt that died on the provider, not on the page. */
  noteHealUnavailable(): void {
    this.#healUnavailable += 1;
  }

  /**
   * Tokens spent by a model call that leaves no per-step record — an in-run
   * reconstruction ask, including one whose answer was `canFix: false` or was
   * refused. `summary.inputTokens`/`outputTokens` are the run's WHOLE runtime
   * model bill, and before this the reconstruction calls (the generator role,
   * measured as the second-largest sink on be100) simply vanished from it.
   * Heal, agent and data spend still arrives via their own records; this
   * counter is only for calls with nowhere else to land, so nothing is ever
   * counted twice.
   */
  noteModelSpend(inputTokens: number, outputTokens: number): void {
    this.#extraInputTokens += inputTokens;
    this.#extraOutputTokens += outputTokens;
  }

  /**
   * A later reconstruction of these failed attempts passed: mark them
   * superseded and withdraw the defects they filed. The attempts stay in the
   * step list — what was tried is evidence — but a rescued step must not
   * leave the run red, or "retry until it works" would be indistinguishable
   * from "failed" and nobody would let it run.
   */
  supersedeSteps(indexes: readonly number[]): void {
    const set = new Set(indexes);
    for (const step of this.#steps) {
      if (set.has(step.index) && step.status !== 'passed') step.superseded = true;
    }
    for (let i = this.#defects.length - 1; i >= 0; i -= 1) {
      const defect = this.#defects[i]!;
      if (defect.source !== 'runtime') continue;
      const refs = defect.stepIndexes ?? (defect.stepIndex !== undefined ? [defect.stepIndex] : []);
      const kept = refs.filter((r) => !set.has(r));
      if (kept.length === refs.length) continue;
      if (kept.length === 0) {
        this.#defects.splice(i, 1);
      } else {
        defect.stepIndexes = kept;
        defect.stepIndex = kept[0]!;
        defect.occurrences = kept.length > 1 ? kept.length : undefined;
      }
    }
  }

  /** Stamp the last recorded step as the reconstruction that finally held. */
  noteReconstruction(record: ReconstructionRecord): void {
    const last = this.#steps[this.#steps.length - 1];
    if (!last) return;
    last.reconstruction = record;
  }

  /**
   * A selector that dead-ended during the run resolved when re-checked at the
   * end: it was never absent, it was slower than the fast-path budget. The
   * defect it filed is downgraded and says so — the mirror of the timing
   * check that already runs after a successful heal.
   */
  reclassifyTimingDefect(selector: string): boolean {
    const defect = this.#defects.find(
      (d) => d.source === 'runtime' && d.selector === selector && d.severity === 'high',
    );
    if (!defect) return false;
    defect.severity = 'medium';
    defect.detail =
      `TIMING, not absence: this selector resolved when re-checked at the end of the run, ` +
      `so the control renders — slower than the fast-path budget. The step still failed ` +
      `honestly at the time it ran. Original finding: ${defect.detail}`;
    return true;
  }

  /**
   * Record which way the `when` step just added went.
   *
   * Written onto the step rather than counted in the summary: a branch is not
   * a cost or a risk, it is context for the steps that follow it, and a report
   * that says "the role was already HRBP, so the switch was skipped" explains
   * an otherwise puzzling gap in the step list.
   */
  noteBranch(matched: boolean): void {
    const last = this.#steps[this.#steps.length - 1];
    if (!last || last.action !== 'when') return;
    last.detail = { ...(last.detail ?? {}), matched, branch: matched ? 'then' : 'else' };
  }

  setCoverage(coverage: CoverageReport): void {
    this.#coverage = coverage;
  }

  /**
   * Attach the run's saved variables, already masked by name. Set once at
   * seal time; an empty snapshot is left off the bundle entirely so a run
   * that saved nothing does not grow an empty object that reads like data.
   */
  /** One plain sentence about a decision this run took. Never a verdict. */
  note(text: string): void {
    this.#notes.push(text);
  }

  setVariables(snapshot: Record<string, string>): void {
    if (Object.keys(snapshot).length > 0) this.#variables = snapshot;
  }

  setTrend(trend: RunTrend): void {
    this.#trend = trend;
  }

  /** See `ProofBundle.dbBaseline`. */
  setDbBaseline(summary: DbBaselineSummary): void {
    this.#dbBaseline = summary;
  }

  /** Selectors that actually resolved — the input to coverage measurement. */
  resolvedSelectors(): string[] {
    const touched: string[] = [];
    for (const step of this.#steps) {
      if (step.status !== 'passed') continue;
      if (step.resolvedSelector !== null) touched.push(step.resolvedSelector);
      // `fillEach` clicks its submit control once per case; that control was
      // genuinely exercised even though it is not the step's main selector.
      const submit = step.detail?.['submit'];
      if (typeof submit === 'string' && submit !== '') touched.push(submit);
    }
    return touched;
  }

  /** Record a run-level failure that isn't attributable to a single step. */
  recordRunError(error: unknown): void {
    this.#error = error instanceof Error ? error.message : String(error);
  }

  /**
   * Record the run's "completed with N issue(s)" tally. It lands on the
   * bundle's `error` field like a run error — every reader of that field
   * already expects the tally there — but it is NOT a fatal, and the verdict
   * may still be a qualified pass over it. See `StepIssuesError`.
   */
  recordIssueTally(message: string): void {
    this.#error = message;
    this.#errorIsTally = true;
  }

  /**
   * The session guard fired: this run proved nothing about the application.
   *
   * A flag rather than a defect-title match, because the verdict must not
   * depend on wording. It exists because DB_04_02 finalised **passed, 7/7**
   * while carrying the high defect "the session is not established, so
   * nothing after this point can say anything about the feature under test" —
   * the guard fired on a step whose `SessionLostError` was swallowed on a
   * path that is right to swallow it (teardown's, where the body's outcome is
   * the story), so no step failed and no run error was recorded. Whichever
   * path swallows the throw, the verdict cannot be `passed` afterwards.
   */
  noteSessionLost(): void {
    this.#sessionLost = true;
  }

  /**
   * Refine the last recorded step's non-passed status — the runner records
   * `failed` at the point of failure, and the step executor (which knows
   * *why* it failed) reclassifies it as `error` or `dead-end` right after.
   */
  reclassifyLastStep(status: StepStatus, action?: string): void {
    const last = this.#steps[this.#steps.length - 1];
    if (!last || last.status === 'passed') return;
    // When the caller says which action it just ran, only touch a matching
    // step — a failure thrown before anything was recorded (bad interpolation,
    // say) must not relabel some earlier step's failure.
    if (action !== undefined && last.action !== action) return;
    last.status = status;
  }

  /**
   * Attach a backend step's baseline comparison to the step just recorded.
   * A separate method because the probe is async and runs AFTER the step is
   * on the record — the alternative is threading a promise through every
   * `addStep` call. No-op when there is no last step.
   */
  annotateDbChanges(changes: StepDbChange[] | undefined, probeError: string | undefined): void {
    const last = this.#steps[this.#steps.length - 1];
    if (last === undefined) return;
    if (changes !== undefined) last.dbChanges = changes;
    if (probeError !== undefined) last.dbProbeError = probeError;
  }

  get steps(): readonly ProofStep[] {
    return this.#steps;
  }

  /** Seal the run and compute the summary. */
  /**
   * What a session-billed provider charged this run. Recorded by the runner
   * at the end, as a delta over the whole run — see `claudeCliUsageSince`.
   * Zero calls records nothing: a run that never asked is not a run that
   * spent nothing, it is a run the question does not apply to.
   */
  noteSessionUsage(
    provider: string,
    spent: {
      calls: number;
      costUsd: number;
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      wallMs: number;
      byRole?: NonNullable<ProofBundle['summary']['session']>['byRole'];
    },
    quota?: { beforePercent: number; afterPercent: number; resetsAt: string | null },
  ): void {
    if (spent.calls <= 0) return;
    this.#sessionUsage = { provider, ...spent, ...(quota === undefined ? {} : { quota }) };
  }

  #sessionUsage: ProofBundle['summary']['session'] = undefined;

  finish(): ProofBundle {
    const summary: ProofSummary = {
      ...(this.#sessionUsage === undefined ? {} : { session: this.#sessionUsage }),
      totalSteps: this.#steps.length,
      passed: 0,
      failed: 0,
      frontend: { steps: 0, passed: 0, failed: 0, defects: 0 },
      backend: { steps: 0, passed: 0, failed: 0, defects: 0 },
      fastPath: 0,
      caseRetries: 0,
      cacheHits: 0,
      jitHeals: 0,
      dialogsDismissed: 0,
      agentTakeovers: 0,
      visualChecks: 0,
      visualFailures: 0,
      dataRetries: 0,
      apiRequests: 0,
      apiFailures: 0,
      dbChecks: 0,
      dbFailures: 0,
      networkCalls: this.#network.calls,
      networkFailures: this.#network.failures,
      backendBlocked: this.#backendBlocked,
      healUnavailable: this.#healUnavailable,
      networkDropped: this.#network.dropped,
      healLatencyMs: 0,
      agentLatencyMs: 0,
      // Seeded with the recordless spend (reconstruction asks); the step loop
      // below adds every heal/agent/data record's own usage on top.
      inputTokens: this.#extraInputTokens,
      outputTokens: this.#extraOutputTokens,
      defects: this.#defects.length,
    };

    // Attribution, in order of how much the signal is worth:
    //
    // 1. Category `backend` wins outright. It means "no amount of selector
    //    work fixes this", and it is raised for traffic the *page* made — so
    //    it can sit on a `click` step and still belong to the API side.
    // 2. Otherwise the step's own side decides, so a malformed `request` step
    //    counts against the half of the test it lives in rather than leaking
    //    onto the UI's tally.
    // 3. A defect with no step at all (static findings from the generator) is
    //    the UI's, which is the only thing the generator looks at.
    for (const defect of this.#defects) {
      const step = defect.stepIndex === undefined ? undefined : this.#steps[defect.stepIndex];
      const isBackend =
        defect.category === 'backend' ||
        (step !== undefined && BACKEND_TIER_ACTIONS.has(step.action));
      if (isBackend) summary.backend.defects += 1;
      else summary.frontend.defects += 1;
    }

    for (const step of this.#steps) {
      // A superseded attempt is history, not an outcome: its reconstruction
      // passed in its place, so it counts toward nothing. It stays in the
      // step list, which is the transparency half of the bargain.
      if (step.superseded) continue;
      if (step.status === 'passed') summary.passed += 1;
      else summary.failed += 1;

      const tier = BACKEND_TIER_ACTIONS.has(step.action) ? summary.backend : summary.frontend;
      tier.steps += 1;
      if (step.status === 'passed') tier.passed += 1;
      else tier.failed += 1;

      switch (step.resolution) {
        case 'fast':
          summary.fastPath += 1;
          break;
        case 'case':
          summary.caseRetries += 1;
          break;
        case 'cache':
          summary.cacheHits += 1;
          break;
        case 'jit':
          summary.jitHeals += 1;
          break;
        case 'dialog':
          summary.dialogsDismissed += 1;
          break;
        default:
          break;
      }

      if (step.heal) {
        summary.healLatencyMs += step.heal.latencyMs;
        summary.inputTokens += step.heal.inputTokens ?? 0;
        summary.outputTokens += step.heal.outputTokens ?? 0;
      }

      if (step.snapshot) {
        summary.visualChecks += 1;
        if (step.snapshot.outcome === 'changed' || step.snapshot.outcome === 'size-mismatch') {
          summary.visualFailures += 1;
        }
      }

      if (step.dataRetry) {
        if (step.dataRetry.attempts.length > 1) summary.dataRetries += 1;
        summary.inputTokens += step.dataRetry.inputTokens ?? 0;
        summary.outputTokens += step.dataRetry.outputTokens ?? 0;
      }

      if (step.request) {
        summary.apiRequests += 1;
        // A non-2xx is a *result* here, not a failure — `expectStatus` is what
        // turns a status into pass/fail. Only a call that never got a response
        // at all counts as the request itself having failed.
        if (step.request.status === null) summary.apiFailures += 1;
      }

      if (step.db) {
        summary.dbChecks += 1;
        if (step.status !== 'passed') summary.dbFailures += 1;
      }

      if (step.agent) {
        summary.agentTakeovers += 1;
        summary.agentLatencyMs += step.agent.latencyMs;
        summary.inputTokens += step.agent.inputTokens ?? 0;
        summary.outputTokens += step.agent.outputTokens ?? 0;
      }
    }

    // Worst-first: an error outranks a dead end outranks an assertion failure,
    // so the headline says what actually happened, not just "failed".
    let status: RunStatus = 'passed';
    const counted = this.#steps.filter((s) => !s.superseded);
    if (counted.some((s) => s.status === 'error')) status = 'error';
    else if (counted.some((s) => s.status === 'dead-end')) status = 'dead-end';
    else if (summary.failed > 0 || this.#error !== undefined) status = 'failed';
    // **The claims held, the path did not.** When every assertion the run made
    // passed — and it made at least one — and only ACTION steps broke, the
    // row's claim was proved and the verdict says so, qualified. The broken
    // actions stay on the record as issues (their defects are untouched), and
    // the film is kept whole so a reader can see the claim being reached
    // past them. Never applied over a run-level error (a session guard, a
    // dead browser): those say the claims were asserted against the wrong
    // page, which no passing assertion can outrank.
    // An `error` step is excluded outright: it says the HARNESS could not
    // proceed (a variable that never saved, a database it could not reach, a
    // model that would not answer) — a passing assertion after one proves the
    // claim, not that the run did what it said. Only `failed`/`dead-end`
    // actions — a click that missed, a selector that never resolved — are the
    // kind of issue a held claim may be read over.
    if (
      status !== 'passed' &&
      status !== 'error' &&
      (this.#error === undefined || this.#errorIsTally)
    ) {
      const assertions = counted.filter((s) => isAssertionAction(s.action));
      const claimsHeld =
        assertions.length > 0 && assertions.every((s) => s.status === 'passed');
      if (claimsHeld) status = 'passed-with-issues';
    }
    // **A pass whose assertions include a vacuous one is unproved** (S5 of
    // the 2026-08-28 audit). PL_04_13: three `expectVisible role=combobox >>
    // nth=0` resolved a nameless element on a page with zero comboboxes and
    // passed — while the human had recorded the case Failed. A green built
    // on an assertion that cannot fail is not a verdict; it goes to a person.
    if (isPassing(status) && counted.some((s) => s.detail?.['vacuous'] !== undefined && !s.superseded)) {
      for (const s of counted) {
        if (s.detail?.['vacuous'] === undefined || s.superseded) continue;
        s.unsure = `${s.detail['vacuous']} — confirm the claim against the page, or re-author the selector to name the control`;
      }
      status = 'needs-review';
    }
    // **proved-? — every broken step is a failed assertion whose actual is a
    // near-miss of its expected.** The page produced the right SHAPE of thing
    // under wording the machine cannot rule on: whether "Create Benefit
    // Plan" satisfies a claim written "Create Plan" is a spec question, and
    // both answers are defensible. The run defers to a human instead of
    // picking one: status `needs-review`, the proof of each unsure part
    // written onto the step (`unsure`), and `ProofBundle.review` is where
    // the ruling lands. Never over an error, a dead end (the control was
    // ABSENT — nothing near about that), or a run-level fatal; a far miss
    // ("Home landing" for "Create Plan") stays failed.
    //
    // ONE dead-end shape qualifies: a step the runner stamped
    // `foundInPageText` — the exact-match instrument (`text="X"`, a role
    // name) resolved nothing, but the runner then read the live page and the
    // asserted text IS in it, inside larger text. "Absent" is disproved by
    // the page's own words, so whether an embedded rendering satisfies an
    // exact claim is the same human wording call as any other near-miss
    // (be100 PL_06_10: `text="Plan ID already exists"` dead-ended while the
    // toast held that exact sentence in a longer message).
    // `expectUrl` never defers: a URL is a mechanical destination, grounded
    // from the link's own href — "expected /orders, got /login" is a routing
    // fact, and inviting a judge to bless a wrong route is exactly the
    // softening the numeric guard refuses for numbers.
    // A step the runner stamped `verdict: 'not-found'` (EH-09, 2026-09-03)
    // failed because the application showed its own missing-page surface —
    // the heading is the evidence and there is no wording to rule on.
    const nearEligible = (s: ProofStep): boolean =>
      s.action !== 'expectUrl' &&
      s.detail?.['verdict'] !== 'not-found' &&
      (s.status === 'failed' ||
        (s.status === 'dead-end' && s.detail?.['foundInPageText'] === true));
    if (
      (status === 'failed' || status === 'dead-end') &&
      (this.#error === undefined || this.#errorIsTally)
    ) {
      const broken = counted.filter((s) => s.status !== 'passed');
      const allNearMisses =
        broken.length > 0 &&
        broken.every(
          (s) =>
            nearEligible(s) &&
            isAssertionAction(s.action) &&
            s.detail?.['expected'] !== undefined &&
            s.detail?.['actual'] !== undefined &&
            nearMiss(s.detail['expected'], s.detail['actual']),
        );
      if (allNearMisses) {
        for (const s of broken) {
          const render = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));
          s.unsure =
            `expected ${JSON.stringify(render(s.detail!['expected']))} but the page holds ` +
            `${JSON.stringify(render(s.detail!['actual']))} — the exact comparison cannot rule ` +
            'whether this satisfies the claim; the judge (or a human in the panel) decides, ' +
            'confirm proved or failed';
        }
        status = 'needs-review';
      }
    }
    // A run whose session guard fired proved nothing, whatever its steps say.
    // `error` and not `failed`: the application was never reached, so this is
    // the harness's own environment fact, not a verdict about the feature.
    if (isPassing(status) && this.#sessionLost) status = 'error';

    return {
      runId: this.runId,
      name: this.name,
      status,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - this.#startedMs,
      cdpUrl: this.#cdpUrl,
      cachePath: this.#cachePath,
      healerModel: this.#healerModel,
      summary,
      steps: this.#steps,
      defects: this.#defects,
      video: this.#video,
      ...(this.#videos.length > 0 ? { videos: [...this.#videos] } : {}),
      coverage: this.#coverage,
      trend: this.#trend,
      ...(this.#dbBaseline === undefined ? {} : { dbBaseline: this.#dbBaseline }),
      variables: this.#variables,
      ...(this.#notes.length > 0 ? { notes: [...this.#notes] } : {}),
      generatedBy: this.#generatedBy,
      polarity: this.#polarity,
      polaritySource: this.#polaritySource,
      error: this.#error,
    };
  }
}

/**
 * Whether this run's coverage number means anything.
 *
 * The inventory is captured once, at close, of the page the run *ended* on —
 * so for a multi-page journey the denominator is one page's controls while
 * the numerator drew selectors from every page the flow crossed. "1/72 (1%)"
 * on a login → navigate → detail journey is not a low score, it is a
 * category error, and printing it teaches people to ignore the instrument on
 * the runs where it is real: single-page suites, which are what `generate`
 * writes and what drift detection was built for. Measurement still happens
 * and the bundle still carries it (history's coverage trend included); only
 * the display is gated.
 */
export function meaningfulCoverage(bundle: {
  coverage?: { total: number } | undefined;
  steps: readonly { resolvedSelector: string | null; url: string | null }[];
}): boolean {
  if (!bundle.coverage || bundle.coverage.total === 0) return false;
  const pages = new Set<string>();
  for (const step of bundle.steps) {
    if (step.resolvedSelector === null || step.url === null) continue;
    try {
      const url = new URL(step.url);
      pages.add(url.origin + url.pathname);
    } catch {
      pages.add(step.url);
    }
  }
  return pages.size <= 1;
}

/** Write a bundle to `<dir>/<runId>.json` and return the absolute path. */
export async function writeProofBundle(bundle: ProofBundle, dir: string): Promise<string> {
  const target = resolve(dir);
  await mkdir(target, { recursive: true });
  const file = join(target, `${bundle.runId}.json`);
  await writeFile(file, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * One line per step, for live progress output as a run executes — as opposed
 * to `formatProofSummary`, which only exists once the whole bundle is sealed.
 * `intent` (verbatim from `FlowStep.intent`, never regenerated) is the second
 * line when present, same "explain what this step checks" reasoning as the
 * HTML report's `.step-intent`.
 */
export function formatStepLine(step: ProofStep): string {
  const mark = step.status === 'passed' ? '✓' : '✗';
  // Not `resolvedSelector ?? selector`: four wave-2 step kinds carry no
  // selector at all (`expectAnyVisible` has a list, `signIn` a persona label,
  // `upload` its files), and a bare `✗ [9] expectAnyVisible` names nothing a
  // reader can act on. `stepTarget` is the one reading every renderer shares.
  const target = stepTarget(step);
  const tag = step.resolution && step.resolution !== 'fast' ? `${step.resolution}, ` : '';
  const kind = step.status === 'error' ? '  ERROR' : step.status === 'dead-end' ? '  DEAD END' : '';
  // Columns: mark, index, action, duration, then the target — so a reader
  // scanning fifty of these compares durations down one column and reads
  // the selector after the fixed-width part. `joblog.mjs` and the panel's
  // `STEP_LINE` read the mark and `[index]` from the front; the duration
  // keeps its `(jit, 42ms)` form so the resolution source rides with it.
  const head =
    `${mark} ${`[${step.index}]`.padEnd(STEP_INDEX_WIDTH)} ${step.action.padEnd(STEP_ACTION_WIDTH)} ` +
    `(${tag}${step.durationMs}ms)`.padStart(STEP_DURATION_WIDTH) +
    (target ? `  ${target}` : '') +
    kind;
  const lines = [head.trimEnd()];
  const pad = ' '.repeat(STEP_DETAIL_INDENT);
  if (step.intent) lines.push(`${pad}${step.intent}`);
  const comparison = expectedActual(step);
  if (comparison) lines.push(`${pad}${comparison}`);
  for (const fact of stepKindFacts(step)) {
    lines.push(`${pad}${fact.label}: ${fact.value.split('\n').join(`\n${pad}  `)}`);
  }
  const described = describeTarget(step.target);
  if (described !== null) lines.push(`${pad}target: ${described}`);
  for (const seen of observedEvidence(step)) {
    lines.push(`${pad}observed ${seen.selector === null ? '' : seen.selector + ': '}${JSON.stringify(seen.text)}`);
  }
  const valueFrom = describeValueSource(step);
  if (valueFrom !== null) lines.push(`${pad}value ${valueFrom}`);
  for (const change of describeDbChanges(step.dbChanges)) lines.push(`${pad}${change}`);
  if (step.dbProbeError) lines.push(`${pad}db baseline probe failed: ${step.dbProbeError}`);
  if (step.status !== 'passed' && step.error) lines.push(`${pad}${step.error.split('\n')[0]}`);
  return lines.join('\n');
}

/** Where a step's detail lines start: under the action column of the line above. */
const STEP_DETAIL_INDENT = 2 + STEP_INDEX_WIDTH + 1;

/**
 * The "expected X, actual Y" line, when the step recorded both. Assertions
 * write these into `detail` on every outcome — a pass shows what the page
 * really held, not just that a check went green.
 */
export function expectedActual(step: ProofStep): string | null {
  const detail = step.detail;
  if (!detail || detail['expected'] === undefined) return null;
  const render = (v: unknown): string =>
    typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  const expected = render(detail['expected']);
  const actual = 'actual' in detail ? render(detail['actual']) : null;
  return actual === null ? `expected ${expected}` : `expected ${expected} · actual ${actual}`;
}

/** One line per completed agent turn, for live progress during a `workflow` step. */
export function formatAgentAction(action: AgentAction): string {
  const mark = action.ok ? '✓' : '✗';
  // `save` and `signOut` (wave 2) have no selector worth printing and a
  // meaning the raw fields do not carry; `describeAgentAction` is the same
  // reading the report uses, so the terminal and the report agree.
  const { target, note } = describeAgentAction(action);
  // Indented under the step it serves, with the same columns as a step line
  // (`agent` standing where the index would): one turn per line, duration
  // aligned, target last.
  const head =
    `  ${mark} agent ${action.action.padEnd(STEP_ACTION_WIDTH)} ` +
    `(${action.durationMs}ms)`.padStart(STEP_DURATION_WIDTH) +
    (target && target !== '—' ? `  ${target}` : '');
  const lines = [head.trimEnd()];
  const pad = ' '.repeat(STEP_DETAIL_INDENT + 2);
  if (note) lines.push(`${pad}${note}`);
  if (action.reasoning) lines.push(`${pad}${action.reasoning}`);
  return lines.join('\n');
}

/**
 * The frontend/backend split, but only when there is a split to report.
 *
 * A flow that never touches HTTP directly is already fully described by the
 * `steps` line above — printing `backend 0/0` on every UI run would be noise
 * pretending to be information.
 */
function tierLines(summary: ProofSummary): string[] {
  const { frontend, backend } = summary;
  if (backend.steps === 0 && backend.defects === 0) return [];
  const describe = (tier: TierSummary): string => {
    const defects = tier.defects > 0 ? `, ${tier.defects} defect(s)` : '';
    return `${tier.passed}/${tier.steps} passed${defects}`;
  };
  return [
    `  frontend   ${describe(frontend)}`,
    `  backend    ${describe(backend)}`,
  ];
}

/** Short human-readable digest, used by the CLI. */
/**
 * How a status is printed. `passed-with-issues` prints as `PASS**`: it IS a
 * pass — every claim held and nothing about validation changes — and the
 * asterisks point at the step(s) that only acted and broke on the way, which
 * `issueSteps` names. One spelling for the CLI, the report and the panel.
 */
function statusLabel(status: ProofBundle['status']): string {
  return status === 'passed-with-issues' ? 'PASS**' : status.toUpperCase();
}

/** The broken action steps behind a `PASS**`, one line each. */
export function issueSteps(bundle: ProofBundle): string[] {
  return bundle.steps
    .filter((s) => !s.superseded && s.status !== 'passed')
    .map(
      (s) =>
        `step ${s.index} ${s.action}${s.selector ? ` ${s.selector}` : ''}` +
        (s.error ? ` — ${s.error.split('\n')[0]}` : ''),
    );
}

export function formatProofSummary(bundle: ProofBundle): string {
  const { summary } = bundle;
  const lines = [
    `${statusLabel(bundle.status)} ${bundle.name} (${bundle.durationMs}ms)`,
    ...(bundle.status === 'passed-with-issues'
      ? issueSteps(bundle).map((line) => `  ** issue   ${line} (does not affect the verdict)`)
      : []),
    `  steps      ${summary.passed}/${summary.totalSteps} passed`,
    ...tierLines(summary),
    `  resolution fast=${summary.fastPath} case=${summary.caseRetries} cache=${summary.cacheHits} jit=${summary.jitHeals} dialog=${summary.dialogsDismissed} agent=${summary.agentTakeovers}`,
    `  control    heal ${summary.healLatencyMs}ms + agent ${summary.agentLatencyMs}ms, ${summary.inputTokens} in / ${summary.outputTokens} out tokens`,
  ];
  if (summary.visualChecks > 0) {
    lines.push(
      `  visual     ${summary.visualChecks} snapshot(s), ${summary.visualFailures} drifted`,
    );
  }
  if (summary.dataRetries > 0) {
    lines.push(`  data       ${summary.dataRetries} fillRetry step(s) needed regeneration`);
  }
  if (summary.apiRequests > 0) {
    lines.push(
      `  api        ${summary.apiRequests} request(s), ${summary.apiFailures} with no response`,
    );
  }
  if (summary.dbChecks > 0) {
    lines.push(`  db         ${summary.dbChecks} check(s), ${summary.dbFailures} failed`);
  }
  if (bundle.variables && Object.keys(bundle.variables).length > 0) {
    // Names only on the one-line digest; the masked values are in the bundle.
    lines.push(`  variables  ${Object.keys(bundle.variables).join(', ')}`);
  }
  if (summary.networkCalls > 0) {
    const dropped = summary.networkDropped > 0 ? `, ${summary.networkDropped} not captured` : '';
    const blocked =
      summary.backendBlocked > 0 ? `, ${summary.backendBlocked} step(s) not healed` : '';
    lines.push(
      `  network    ${summary.networkCalls} call(s), ${summary.networkFailures} failed${blocked}${dropped}`,
    );
  }
  if (summary.defects > 0) {
    const high = bundle.defects.filter((d) => d.severity === 'high').length;
    lines.push(`  defects    ${summary.defects} (${high} high)`);
  }
  lines.push(`  runId      ${bundle.runId}`);
  return lines.join('\n');
}
