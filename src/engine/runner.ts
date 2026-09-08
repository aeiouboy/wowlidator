/**
 * Execution plane: a thin, fast Playwright wrapper.
 *
 * Every action takes the fast path first, with a deliberately short timeout —
 * a selector that is going to work works immediately, and waiting longer only
 * slows down the failure we actually care about. Only once the fast path has
 * failed do we escalate: a cheap check for a blocking dialog, then cached
 * repair, then (and only then) the JIT healer.
 *
 * The escalation ladder is the whole design. Steps 1, 1.5, and 2 cost nothing.
 */

import {
  chromium,
  errors,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  // Aliased: `Response` alone collides with the DOM/undici global, and the
  // one a navigation returns is Playwright's.
  type Response as PlaywrightResponse,
} from 'playwright';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { ApiActions, resolveUrl, type FlowRequestSpec } from '../api/api-actions.js';
import { BrowserTransport, FetchTransport, type ApiTransport } from '../api/api-client.js';
import {
  NetworkObserver,
  describeCall,
  isBlockingFailure,
  type NetworkCall,
} from '../api/network-observer.js';
import {
  ObservationTruncatedError,
  ObservationUnavailableError,
  matchExpectedCalls,
  matchTable,
  neverViolations,
  describeExpected,
  type ExpectedCall,
  type FlowExpectCallsSpec,
} from '../api/expect-calls.js';
import { isSecretStepValue, maskSecret } from '../api/redact.js';
import type { RedactionPolicy } from '../api/redact.js';
import { VariableStore } from '../api/variables.js';
import { DbActions } from '../db/db-actions.js';
import type {
  FlowDbCalledSpec,
  FlowDbDeltaSpec,
  FlowDbRowSpec,
  FlowDbSnapshotSpec,
  FlowDbUnchangedSpec,
} from '../db/db-actions.js';
import { defaultDbConfig, type DbClient, type DbConfig } from '../db/client.js';
import type { DbBaselineProbe } from '../db/baseline.js';
import {
  DEFAULT_CAPTURE_DELAY_MS,
  captureEvidence,
  type EvidenceKind,
  type ScreenshotMode,
} from './evidence.js';
import {
  captionVideo,
  installCursorOverlay,
  keepCaption,
  sealVideo,
  videoSize,
  videoTempDir,
  VIDEO_ACTION_DWELL_MS,
  type VideoCut,
  type VideoMode,
  type VideoRecording,
} from './video.js';
import { CacheManager } from '../cache/cache-manager.js';
import { measureCoverage } from '../coverage/ax-coverage.js';
import { isFixtureSpec, writeFixture } from '../data/fixtures.js';
import {
  DEFAULT_BASELINE_DIR,
  baselinePath,
  compareSnapshot,
  isVisualFailure,
} from '../visual/baseline.js';
import { RunHistory, analyseTrend } from '../history/run-history.js';
import { HealFailedError, HealUnavailableError, JitHealer, captureAxTree } from '../healer/jit-healer.js';
import type { FlowRepairModel } from '../repair/flow-repair-model.js';
import { MutationBlockedError, REVEAL_ACTIONS, WorkflowAgent, cacheAgentMemory, type AgentDbProbe, type PlanStep } from '../orchestrator/workflow-agent.js';
import type { MutationPolicy, OnMutation } from '../orchestrator/mutation-policy.js';
import { nearestRoutes, routeIsDeclared } from '../context/route-match.js';
import { claudeCliUsage, claudeCliUsageSince, type ClaudeCliUsage } from '../providers/claude-cli.js';
import { sessionQuotaPoint, type SessionQuotaPoint } from '../providers/claude-quota.js';
import { SessionVault, type StoredSession } from './session-vault.js';

/**
 * One recorded action of a `workflow` step's deterministic script — the
 * agent's own `PlanStep` shape, re-exported under the flow file's name for
 * it so flow JSON stays readable without the orchestrator's vocabulary.
 */
export type WorkflowScriptStep = PlanStep;
import { selectorName } from '../orchestrator/agent-guards.js';
import {
  AUTO_PROVE_CONFIDENCE,
  autoReviewRuling,
  reviewPairs,
  type ReviewJudge,
} from './review-judge.js';
import {
  agentModelUnavailable,
  personaRefusal,
  differentPage,
  goalEvidence,
  looksLikeSignIn,
  queryAndHash,
  verificationOnlyGoal,
} from '../orchestrator/goal-evidence.js';
import {
  performSignIn,
  performSignOut,
} from './sign-in.js';
import {
  acceptConsentGate,
  acceptConsentGateAnywhere,
  consentGateShowing,
  CONSENT_GATE_URL_PATTERN,
} from './consent-gate.js';
import { generateValue, type DataKind } from '../data/mock-data.js';
import type { DataModel } from '../data/data-model.js';
import {
  describeDialog,
  dialogIsIntendedContext,
  dialogMentions,
  findDismissButton,
  openDialogNow,
  selectorInsideDialog,
  waitForDialog,
} from './modal.js';
import {
  exactTextSelector,
  headRoleOf,
  isTextSelector,
  optionNamePatterns,
  qualifyBareRole,
  relaxRoleName,
  targetsPopupContent,
  withoutGreeting,
  relaxTextSelector,
  sanitizeSelector, containsRoleName } from './selector.js';
// The wave-1 helpers (2026-09-03): each is deterministic and $0, and each is
// the engine half of a shape the HR workbook meets on nearly every case.
import { ANY_OFFERED, ListboxOptionMissingError, selectFromListbox } from './listbox.js';
import { pickDateInDialog } from './calendar.js';
import { readFieldError } from './field-error.js';
import { attachFiles, captureDownload } from './upload.js';
import { notFoundSurface } from './not-found.js';
import { codeAndLabelOf, foldValue, foldedIncludes, foldedMatch } from './normalise.js';
import { isoDateOf as isoDateOfText, type DateLocale } from './dates.js';
import { expandFlow, hasIncludes } from './compose.js';
import {
  API_STEP_ACTIONS,
  BACKEND_TIER_ACTIONS,
  BROWSER_FREE_ACTIONS,
  DB_STEP_ACTIONS,
  ProofBundleBuilder,
  type AgentAction,
  type AgentEndedBy,
  type AgentRecord,
  type StepDecision,
  type DataCaseResult,
  type DataRetryAttempt,
  type DataRetryRecord,
  type Defect,
  type DialogRecord,
  type GenerationProvenance,
  type HealRecord,
  type ProofBundle,
  type ProofStep,
  type RejectedHeal,
  type ResolutionSource,
  type StepTarget,
  nearMiss,
} from './proof-bundle.js';
import { captureTarget, TARGET_READ_BUDGET_MS } from './target.js';
import { approach, humanClick, humanFill, humanKeys, humanScrollTo, humanSettle, remainingTimeout } from './humanize.js';
import { revealHidden } from './reveal.js';
import { inferPolarity, type TestPolarity } from './polarity.js';
import type { DataGate } from '../cli/data-locks.js';

export const DEFAULT_CDP_URL = 'http://localhost:9222';
/** Fast-path timeout. Short by design — see the module comment. */
export const DEFAULT_FAST_TIMEOUT_MS = 2_000;

/**
 * Budget for the one-attribute read that decides whether a field is a
 * password. Deliberately tiny: the element has just been resolved and acted
 * on, so it is there now or the answer does not matter — and a masking
 * decision must never be able to slow a step down, let alone fail one.
 */
const ATTRIBUTE_READ_TIMEOUT_MS = 250;
/** Timeout for a cached or freshly healed selector, which we expect to work. */
export const DEFAULT_HEALED_TIMEOUT_MS = 10_000;

/**
 * The ceiling on a step's own `timeoutMs` (EH-07, 2026-09-03). A payroll run
 * or a bulk import can take minutes, and the sheets' "สถานะเปลี่ยนเป็น
 * Complete" (TC_PY_REC_001..095, TC_PY_SSO_001..062) and "Import Job Monitor
 * → Completed" (PL_10_24/26/57, RU_09_24/26) claims are about exactly that
 * wait. The author declares the patience per step; this caps it so a typo
 * cannot park a lane for an hour. Ten minutes.
 */
export const MAX_STEP_TIMEOUT_MS = 600_000;

/** A declared per-step patience, clamped to the ceiling; `undefined` when none was declared. */
export function stepPatience(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  return Math.min(Math.floor(timeoutMs), MAX_STEP_TIMEOUT_MS);
}

// Re-exported for callers that configure a run through the runner's surface
// (`src/config.ts`); the rules themselves live in `evidence.ts`/`video.ts`.
export type { ScreenshotMode } from './evidence.js';
export type { VideoMode } from './video.js';

export const CONSENT_POLICIES = ['accept', 'preserve'] as const;
export type ConsentPolicy = (typeof CONSENT_POLICIES)[number];
type ConsentSettlement = 'accepted' | 'preserved' | null;

export interface SmartRunnerOptions {
  /** CDP endpoint of an already-running Chrome. Connect-only; never launches. */
  cdpUrl?: string | undefined;
  cache: CacheManager;
  bundle: ProofBundleBuilder;
  /** Omit or pass `null` to run with healing disabled (pure execution plane). */
  healer?: JitHealer | null | undefined;
  /** Omit or pass `null` to disable multi-page agentic navigation. */
  agent?: WorkflowAgent | null | undefined;
  /**
   * Consulted only by a `fillRetry` step whose `kind` is `custom`. Every
   * other kind generates deterministically and never needs this at all.
   */
  dataModel?: DataModel | null | undefined;
  /**
   * `Flow.caseContext`, threaded to the runtime model roles: every heal and
   * every agent turn carries the test case the step serves. Context only —
   * it changes what those models know, never what any step claims.
   */
  caseContext?: string | undefined;
  fastTimeoutMs?: number | undefined;
  healedTimeoutMs?: number | undefined;
  /**
   * Film the run, with a drawn-in pointer so clicks are visible. Default `on`.
   *
   * Recording requires a context wowlidator creates, so turning it on means a
   * fresh cookie jar rather than the one the attached browser already had —
   * see `video.ts`. That is the reason this is a switch and not an assumption.
   */
  video?: VideoMode | undefined;
  /**
   * How long each action moment is held in a condensed film (`video: 'on'`),
   * ms. Default `VIDEO_ACTION_DWELL_MS`; see `video.ts`.
   */
  videoDwellMs?: number | undefined;
  /**
   * Perform like a person — the pointer travels to a control before the
   * press, a value goes in character by character, a navigation gets a beat
   * — for the film (`humanize.ts`). Never changes what a step resolves or
   * asserts. Default: on while filming (`video` not `off`), off otherwise,
   * so an unfilmed run pays nothing. `WOWLIDATOR_HUMANIZE` / `--humanize`.
   */
  humanize?: boolean | undefined;
  /**
   * Give this run its own browser context even when it is not being filmed.
   *
   * Two runs sharing `browser.contexts()[0]` share its pages, and a suite that
   * runs its cases concurrently would have them clicking in each other's tabs
   * — the exact interleaving the panel's one-browser-at-a-time rule exists to
   * prevent, moved inside a single command. A recorded run already gets its
   * own context for an unrelated reason (recording is a property of a context),
   * which is why this only has to cover `--video off`.
   *
   * The session is carried across exactly as the recording path carries it, so
   * isolation does not silently sign the run out.
   */
  isolate?: boolean | undefined;
  /**
   * Whether a context this run creates starts with the attached browser's
   * session (cookies + storage). Default true — the reason a filmed run can
   * still test a page someone signed into by hand. `false` starts EMPTY, and
   * is what a flow that signs in ITSELF wants: an inherited session is a
   * different account signed in before its first step, and on this
   * application a stale admin session left in the browser by an earlier run
   * put every persona's case on the admin's landing page instead of the login
   * form. `runFlow` sets it from the flow's own shape — see `signsInItself`.
   */
  inheritSession?: boolean | undefined;

  /**
   * A session banked by an earlier case of the same suite, injected into
   * this run's own context (`SessionVault` as data — contexts stay
   * isolated). Used only when `inheritSession` allows inheriting at all;
   * outranks the attached browser's state when present.
   */
  sessionState?: StoredSession | undefined;
  /**
   * Banked sessions by account EMAIL (lower-cased), for the people a
   * `signIn` opens a browser of their own for — the suite's vault, as
   * `sessionState` is for the primary. A persona context is seeded from
   * here and never from the pool member's leftover default context.
   */
  sessionStates?: Readonly<Record<string, StoredSession>> | undefined;

  /**
   * Credentials by persona label — `HR_ADMIN_ACCOUNT`, `MANAGER_ACCOUNT`,
   * `SPD_ADMIN` — for `signIn` steps and for `<X_ACCOUNT>` tokens the catalog
   * resolves. Never written into a flow file; the label is.
   */
  personas?: Record<string, { email: string; password: string }> | undefined;

  /**
   * Chromes for the people this case signs in as AFTER the first — one CDP
   * endpoint each, leased from the `--browsers` pool by the suite loop. The
   * first persona binds to the browser `connect` attached; every later
   * distinct `signIn` label takes the next URL here, opens its own context
   * there and keeps it for the length of the run, so a hand-off never signs
   * anyone out. Absent or exhausted, `signIn` falls back to signing the
   * active session out and in — the single-browser behaviour.
   */
  personaBrowsers?: readonly string[] | undefined;

  /**
   * How the sheets write dates — `th` reads `dd/mm/yyyy` day-first and a
   * Buddhist year (`2569`) as one to convert; `en-US` month-first; absent
   * leaves `01/09/2027` unconverted (January or September is never guessed).
   * Threaded from `Flow.locale`. See `engine/dates.ts` (EH-03).
   */
  locale?: DateLocale | undefined;

  /**
   * The directory an `upload` step's relative fixture paths resolve against
   * — the flow's own directory, the same one `use` fragments resolve from.
   */
  flowDir?: string | undefined;

  /**
   * Where a `download` step saves what it captured. Defaults to
   * `.wowlidator/downloads/<flow>`; the CLI points it at the run's media
   * folder so the report can link the file.
   */
  downloadDir?: string | undefined;

  /**
   * Stills.
   *
   * Left unset, this follows the recording: with video on it drops to
   * `on-failure`, because the film already carries every other step and a
   * per-step still would be the same evidence twice at many times the size.
   * With video off it stays at `all`, which is what it always was. Setting it
   * explicitly overrides that in either direction — a run can have both.
   */
  screenshots?: ScreenshotMode | undefined;
  /**
   * Draw a red rectangle around the step's target in its screenshot, so the
   * evidence shows what was acted on or checked, not only the page it sat on.
   * Default true. The target itself (`ProofStep.target`) is recorded either
   * way; this only decides whether the still is marked. See `engine/target.ts`.
   */
  highlightTarget?: boolean | undefined;
  /**
   * When set, every backend step (HTTP or DB) is followed by a probe of the
   * run's database BASELINE, and what it did to the tables under test is
   * recorded on the step (`ProofStep.dbChanges`). Evidence only, never a
   * verdict; a failing probe records `dbProbeError` and the step is
   * unaffected. See `src/db/baseline.ts`. Injected so tests stub it.
   */
  dbBaselineProbe?: DbBaselineProbe | undefined;
  /**
   * Pause before each screenshot, so the page has painted. A navigation waits
   * for `domcontentloaded`, which is earlier than "there is something to look
   * at"; see `evidence.ts`. Zero captures as soon as the load states allow.
   */
  captureDelayMs?: number | undefined;
  /**
   * Let the agent try to make a control reachable when the healer cannot find
   * it. Default false — see `#agentRescue` for why this is opt-in.
   */
  agentAssist?: boolean | undefined;
  /**
   * A tighter per-run turn ceiling for every `workflow` step's agent call —
   * see `WorkflowAgent`'s `RunOptions.maxSteps`. Absent leaves the agent's
   * own instance-wide budget (`DEFAULT_AGENT_MAX_STEPS`, unbounded unless
   * `WOWLIDATOR_AGENT_MAX_STEPS` is set) untouched. Set by
   * `failFastRunOptions` (`run-cases.ts`) for a case the pre-run risk judge
   * already flagged as likely to dead-end or fail: the agent still gets its
   * one shot, on a shorter leash, rather than an unbounded one.
   */
  agentMaxSteps?: number | undefined;
  /**
   * The host's mutation policy for every `workflow` leg of this run — which
   * categories may change the application, and which irreversible ones are
   * pre-approved (`src/orchestrator/mutation-policy.ts`). `undefined` leaves
   * the agent's own default (the `WOWLIDATOR_MUTATION_POLICY` manifest, else
   * none); `null` says "none" explicitly.
   */
  mutationPolicy?: MutationPolicy | null | undefined;
  /**
   * Whether this run may exercise the backend at all. Default `true` — the
   * behaviour every run had before the toggle existed. `false` and no HTTP or
   * database step may run: not authored, not loaded, not dispatched. See
   * `backendStepsIn`.
   */
  backend?: boolean | undefined;
  /**
   * Route patterns the application's own repository declares, from the
   * indexed context graph. What lets a 404 be read correctly: on a path the
   * codebase declares no route for, the TEST asked for a page that does not
   * exist; on a path it does declare, the APPLICATION failed to serve one it
   * has. Empty means no repository was indexed and the run keeps no opinion.
   */
  declaredRoutes?: readonly string[] | undefined;
  deploymentUrl?: string | undefined;
  /**
   * In-run step reconstruction: on a step's failure, ask this model for a
   * rebuilt step against the live page and retry, up to
   * `STEP_RECONSTRUCT_TRIES` total tries, before final classification.
   * Attempts a rescue supersedes count toward nothing; every rescue files a
   * `medium` drift defect; an assertion keeps its claim verbatim (only
   * preparation may be inserted before it). Null/absent disables.
   */
  stepRepair?: FlowRepairModel | null | undefined;
  /**
   * The suite's step-level data lock for this run, or null. Consulted around
   * every step: a run takes a data section when it reaches the step that
   * changes it and gives it back at the last step that still needs that
   * change to hold, so lanes overlap everywhere except the change-and-verify
   * span. See `cli/data-locks.ts` for why this replaced flagging whole flows.
   */
  dataGate?: DataGate | null | undefined;
  /**
   * Pause before each step, in ms. Zero (the default) keeps the hot path
   * hot. Under `video: 'always'` the default becomes
   * `DEMONSTRATION_STEP_DELAY_MS`: that mode records a film for a human to
   * watch, and a run that blurs through five states in two seconds
   * demonstrates nothing — the pause is what lets each state be seen, with
   * the caption naming the step about to happen.
   */
  stepDelayMs?: number | undefined;
  /** Measure AX-tree coverage at the end of the run. Default true. */
  coverage?: boolean | undefined;
  /** Where visual baselines live. */
  baselineDir?: string | undefined;
  /** Rewrite baselines instead of comparing against them. */
  updateBaselines?: boolean | undefined;
  /**
   * Watch the page's HTTP traffic over CDP so a step that failed because a
   * request failed can say so — and can decline to pay for a heal that would
   * only repair onto the resulting error state. Default true; it costs one
   * extra CDP session and no model call.
   */
  network?: boolean | undefined;
  /** How much of an observed request may be recorded. Defaults to redacting. */
  networkRedaction?: RedactionPolicy | undefined;
  /**
   * The credentials this run was told to sign in with (`--as`).
   *
   * Held for ONE purpose: masking. A value the person named as a credential is
   * masked wherever it lands in a record, whatever the field looks like and
   * whatever the DOM says — their statement outranks any inference this code
   * could make. The email is deliberately NOT masked: it is not a secret, and
   * it is frequently the evidence that says which persona a run signed in as.
   */
  credentials?: { email: string; password: string } | undefined;
  /**
   * Whether the flow contains its own sign-in (`signsInItself`). Decides the
   * session bootstrap below: a flow that types credentials must be the one
   * doing the signing in, and the harness must never race it.
   */
  flowSignsInItself?: boolean | undefined;
  readonly consentPolicy?: ConsentPolicy | undefined;
  /**
   * Ring-buffer cap for the observer. The default (300) suits per-step
   * evidence; a long journey ending in an `expectCalls` over the whole run
   * may need more — a `never` claim over a window that dropped calls is
   * blocked, not passed, and this is the dial that prevents that.
   */
  networkMaxCalls?: number | undefined;
  /**
   * Transport for `request` steps. Defaults to the browser context's own,
   * which inherits the session the UI steps established — that inheritance is
   * the whole reason API steps live in the same flow as UI steps.
   */
  transport?: ApiTransport | null | undefined;
  /**
   * Database connection for DB verification steps. Defaults to
   * `WOWLIDATOR_DB_URL` (see `defaultDbConfig`); `null` disables. Connection
   * is lazy — a run with no DB steps never opens one and never demands the
   * driver be installed.
   */
  db?: DbConfig | null | undefined;
  /** Pre-built DB client — the embedder/test seam. Wins over `db`. */
  dbClient?: DbClient | null | undefined;
}

/**
 * How many observed calls to attach to a failed step.
 *
 * Enough to see the pattern, few enough that a chatty SPA doesn't turn one red
 * step into a hundred rows nobody reads.
 */
const MAX_STEP_EVIDENCE = 8;

/**
 * How far back before a step began to look for the request that explains it.
 *
 * Almost never zero, and that's the whole point: the request that starves a
 * step is usually fired by the interaction *before* it. A `click` returns as
 * soon as the click lands, the XHR it triggered is still in flight, and it is
 * the following `expectVisible` that fails. A window starting at the failing
 * step's own start would miss exactly the call that matters.
 *
 * The cost of the window being too wide is a correlation reported for an
 * unrelated failure — which is why every message this produces says
 * "while this step was waiting", not "because of". The cost of it being too
 * narrow is paying for a heal that repairs onto an error banner, which is the
 * failure mode this whole rung exists to prevent.
 */
const NETWORK_LOOKBACK_MS = 3_000;

/** How often `expectCalls` re-reads the window while its budget lasts. */
const SEQUENCE_POLL_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Where an input step's value came from when the sheet did not state it —
 * resolved at authoring time (`generator/value-resolution.ts`). `generated`
 * is the one a reader must know about: a stand-in the author invented.
 */
export interface StepValueSource {
  /**
   * `relative-date` and `unique-per-run` (2026-09-03) are the resolver's two
   * deterministic rewrites — "Hire Date = Today" computed at authoring, a
   * key value suffixed so an import never collides with an earlier run.
   */
  kind: 'test-data' | 'rules' | 'repo' | 'db' | 'generated' | 'relative-date' | 'unique-per-run';
  detail: string;
}

/** One value in a data-driven step, with what should hold after filling it. */
export interface DataCase {
  value: string;
  /** Human label, e.g. "empty", "max length", "unicode". */
  label?: string | undefined;
  expectText?: { selector: string; value: string } | undefined;
  expectVisible?: string | undefined;
  expectHidden?: string | undefined;
}

interface ResolveResult<T> {
  value: T;
  resolution: ResolutionSource;
  resolvedSelector: string;
  heal?: HealRecord | undefined;
  dialog?: DialogRecord | undefined;
  /** What the agent did to make the control reachable, when it was called in. */
  agent?: AgentRecord | undefined;
  /** What the agent judged and chose, when it was asked to decide for itself. */
  decision?: StepDecision | undefined;
  /**
   * Facts a rung learned on the way to resolving — what a calendar rung
   * entered as, which option a listbox rung picked. Merged into the step's
   * `detail` at the recording boundary, since the ladder has no other way to
   * put a reading on the record.
   */
  note?: Record<string, unknown> | undefined;
}

/**
 * Minimal shape of the browser globals used inside `page.evaluate`.
 *
 * Declared locally rather than pulling in the DOM lib, which would make every
 * browser global visible to Node-side code and hide real mistakes.
 */
interface BrowserStorage {
  setItem(key: string, value: string): void;
  clear(): void;
}

interface BrowserGlobals {
  localStorage: BrowserStorage;
  sessionStorage: BrowserStorage;
}

/** What one scrollability reading tells us. */
interface ScrollMeasurement {
  /** How to name the thing in an error message. */
  what: string;
  /** Content is taller than the box. */
  overflows: boolean;
  /** And the scroll position actually moves — overflow a user can reach. */
  moved: boolean;
  scrollSize: number;
  clientSize: number;
}

interface ScrollTarget {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

interface ScrollStyled {
  readonly __styled: unique symbol;
}

interface BrowserScroll {
  document: {
    querySelector(selector: string): unknown;
    scrollingElement: unknown;
  };
  getComputedStyle(element: ScrollStyled): { overflowY?: string; overflow?: string };
}

interface BrowserDocument {
  document: {
    body: {
      hasAttribute(name: string): boolean;
      setAttribute(name: string, value: string): void;
      removeAttribute(name: string): void;
      focus(): void;
    };
  };
}

/** Thrown when every rung of the escalation ladder has failed. */
/**
 * The run is stranded on a sign-in page it never asked to be on.
 *
 * Fatal on purpose, and the only error in the engine that stops a flow dead.
 * Everything after a lost session is being asserted against the login screen,
 * so continuing produces two kinds of garbage and no information: steps that
 * fail because the feature is not on this page, and — far worse — steps the
 * healer *rescues* by repairing them onto whatever the login page happens to
 * offer. That is exactly how PB_01_01 came to report
 * `waitFor role=heading[name="Sign in"] … passed (jit)`: a green step, on a
 * page the test was never meant to reach.
 *
 * Same reasoning as rung 6 of the ladder declining to heal after a failed
 * request: when the precondition is gone, a repair can only fail identically
 * or succeed against the wrong thing, and the second outcome is worse than
 * stopping.
 */
export class SessionLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionLostError';
  }
}

/**
 * The browser (or its page/context) died mid-run.
 *
 * Fatal, like `SessionLostError`, and for the same shape of reason turned up
 * to eleven: every later step can only fail, and each failure files a defect
 * against an application that was never reached. Seen live in PB-02-01's
 * predecessor run, where two `goto`s failed with "Target page, context or
 * browser has been closed" and fourteen "defects" followed. Unlike a lost
 * session, teardown is *skipped* — there is no browser to tear down in — and
 * the run classifies as an environment problem, not a test result.
 */
export class BrowserGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserGoneError';
  }
}

/** Does this error mean the browser itself went away? */
export function isBrowserGone(message: string): boolean {
  return /Target (page|context|browser).* (has been closed|closed)|browser has been closed|Browser closed|Target closed/i.test(
    message,
  );
}

export class StepResolutionError extends Error {
  readonly selector: string;
  readonly attempts: string[];
  /** What the page was showing — stamped by the denial guard, carried to the step. */
  pageContext?: string[] | undefined;
  /** Repair candidates the healer proposed and the ladder refused. */
  rejectedHeals?: RejectedHeal[] | undefined;
  /**
   * What the agent decided here, when it was consulted and the step still
   * failed. Carried on the error because that is the only channel a failing
   * step has — and "the agent looked and chose to do nothing" is precisely
   * what a reader of a dead-ended step needs to see.
   */
  decision?: StepDecision | undefined;

  constructor(
    selector: string,
    attempts: string[],
    /**
     * `verdict`: the ladder stopped on a reading that IS the answer — text
     * nowhere on the page (the absence rung), a page the app does not have
     * (the not-found rung), a declared wait that ran out — and the step must
     * classify `failed`, never `dead-end`, whatever the attempt lines say.
     */
    options: { verdict?: string | undefined } = {},
  ) {
    // "Could not resolve" must not headline a failure where every rung DID
    // resolve the selector and the content behind it was wrong — that header
    // reads as "the control is missing" and files the wrong defect. Seen
    // live: `expectText role=main` resolved instantly on every rung, failed
    // on text, and the report said the control was never found.
    const textOnly =
      attempts.length > 0 &&
      attempts.some((line) => /expected text to contain/i.test(line)) &&
      attempts.every(
        (line) =>
          /expected text to contain/i.test(line) || line.startsWith('known content mismatch:'),
      );
    // A state contradiction (count, enabled/disabled, focus) is a verdict the
    // moment a rung reads it, whatever the rungs before it said — a fast
    // timeout followed by "found 51" means the list took a moment to open and
    // then held 51, not that the control was missing.
    const stateContradicted = endedInStateContradiction(attempts);
    const verdict = options.verdict !== undefined;
    const contentOnly = textOnly || stateContradicted || verdict;
    super(
      verdict
        ? `"${selector}" — ${options.verdict} after ${attempts.length} attempt(s):\n  - ${attempts.join('\n  - ')}`
        : stateContradicted
          ? `"${selector}" resolved, but the claim did not hold after ${attempts.length} attempt(s):\n  - ${attempts.join('\n  - ')}`
          : contentOnly
            ? `"${selector}" resolved, but its content did not hold after ${attempts.length} attempt(s):\n  - ${attempts.join('\n  - ')}`
            : `could not resolve "${selector}" after ${attempts.length} attempt(s):\n  - ${attempts.join('\n  - ')}`,
    );
    this.name = 'StepResolutionError';
    this.selector = selector;
    this.attempts = attempts;
    this.contentOnly = contentOnly;
  }

  /** Every rung resolved the selector and only the CONTENT missed. */
  readonly contentOnly: boolean;
}

/**
 * A backend step in a run that declared it does not test the backend.
 *
 * A harness-class fault in the same family as `MethodRefusedError`: it says
 * nothing about the application, so it is scored `error` and the case is
 * recorded blocked rather than failed.
 */
export class BackendDisabledError extends Error {
  override readonly name = 'BackendDisabledError';
}

/**
 * A navigation the application answered with 4xx, for a path its own codebase
 * declares no route for.
 *
 * Harness-class, in the family of `MethodRefusedError`: the test asked for a
 * page that does not exist, which says nothing about the application. Live
 * (be100 PL_02_03, 2026-08-25): a flow navigated to a URL that returned 404,
 * every later step then failed against the error page, and the run filed
 * those failures against the app. `page.goto`'s response was being discarded,
 * so the 404 was recorded as a passing step.
 *
 * The distinction the codebase makes possible: a 404 on a path the repository
 * DOES declare is the opposite finding — the app should serve it and does
 * not — and that is a real defect, raised as one rather than through this.
 */
export class RouteNotFoundError extends Error {
  override readonly name = 'RouteNotFoundError';
}

/**
 * Errors a step's own callback may raise that describe the HARNESS, not the
 * page — the ladder lets them through untouched (see the fast rung).
 */
const HARNESS_STEP_ERRORS: ReadonlySet<string> = new Set([
  'FixtureMissingError',
  'PersonaUnknownError',
  'PersonaBrowserUnavailableError',
  'UnknownVariableError',
]);

/**
 * A `signIn` step named a persona the run was not given (EH-10). Harness-
 * class like `RouteNotFoundError`: the flow asked for an account that does
 * not exist in this run's map, which says nothing about the application —
 * `error`, the case blocked, and the message names the labels that do exist.
 */
export class PersonaUnknownError extends Error {
  override readonly name = 'PersonaUnknownError';
}

/**
 * A persona's Chrome could not be attached (multi-browser personas): the
 * pool member `signIn` was handed for a second person answers nothing. The
 * machine, not the application — a harness error like `PersonaUnknownError`,
 * so the case is blocked, no app defect is filed, and step repair is never
 * asked to "rebuild" a browser.
 */
export class PersonaBrowserUnavailableError extends Error {
  override readonly name = 'PersonaBrowserUnavailableError';
}

/**
 * A workflow leg the HARNESS ended (task C3, 2026-09-05): the turn ceiling,
 * a stall, the no-progress judge, the value hunt, the off-page allowance, a
 * model that could not answer. None of these is a fact about the application
 * — the agent may have been one click away — so `classifyStepFailure` scores
 * the step `error` and the case blocked, exactly as the untyped
 * `workflow agent failed` message did before; the message now names the
 * limit, and `endedBy` carries it as data.
 */
export class AgentBudgetError extends Error {
  override readonly name = 'AgentBudgetError';
  readonly endedBy: AgentEndedBy;
  constructor(endedBy: AgentEndedBy, message: string) {
    super(message);
    this.endedBy = endedBy;
  }
}

/**
 * A workflow leg the PAGE ended (task C3): the control the goal names was
 * opened and its whole option list read twice, identically, after a settle,
 * and the goal's value was on none of them (`AgentRecord.endedBy ===
 * 'cannot-offer'`). That is an observation the harness made itself, so the
 * step scores `failed` — the application could not satisfy the pair the
 * goal asked for — with `expected` (the value asked) and `actual` (what the
 * list offered) on the step's detail, where `expectedActual()` reads them
 * for every assertion. A rewrite cannot make the option appear, so
 * reconstruction is futile for it.
 */
export class AgentEvidenceError extends Error {
  override readonly name = 'AgentEvidenceError';
  readonly expected: string;
  readonly actual: string;
  constructor(expected: string, actual: string, message: string) {
    super(message);
    this.expected = expected;
    this.actual = actual;
  }
}

/** The stops the harness owns — see `AgentBudgetError`. */
export const AGENT_HARNESS_STOPS: ReadonlySet<AgentEndedBy> = new Set<AgentEndedBy>([
  'budget',
  'stalled',
  'no-progress',
  'value-hunt',
  'wandered',
  'model-error',
]);

/**
 * The "expected X, actual Y" pair a `cannot-offer` leg recorded: the value
 * the goal asked for, and the options the control offered (count and head),
 * read off the last action's `listbox` facts — harness observation, never
 * the summary's prose. Null when the record carries no such action.
 */
export function agentLegComparison(record: AgentRecord): { expected: string; actual: string } | null {
  const facts = [...record.actions].reverse().find((a) => a.listbox !== undefined)?.listbox;
  if (facts === undefined) return null;
  const head = facts.shownHead.map((o) => JSON.stringify(o)).join(', ');
  return {
    expected: facts.value,
    actual:
      facts.shownCount === 0
        ? `${JSON.stringify(facts.trigger)} offered no options`
        : `${JSON.stringify(facts.trigger)} offered ${facts.shownCount} option(s): ${head}${facts.shownCount > facts.shownHead.length ? ', …' : ''}`,
  };
}

/** The harness limit an `AgentBudgetError` names, in words. */
function harnessLimitOf(endedBy: AgentEndedBy, record: AgentRecord): string {
  switch (endedBy) {
    case 'budget':
      return record.maxSteps === null ? 'the turn ceiling' : `the ${record.maxSteps}-turn ceiling`;
    case 'stalled':
      return 'an action repeated on an unchanged page';
    case 'no-progress':
      return 'consecutive turns in which nothing advanced';
    case 'value-hunt':
      return "the value hunt — the goal's values never appeared";
    case 'wandered':
      return 'the off-page allowance';
    case 'model-error':
      return 'the model could not answer';
    default:
      return endedBy;
  }
}

/**
 * The error a failed workflow leg throws, classed by the SOURCE of its
 * evidence (task C3). Pure over the (redacted) record:
 *
 * - a harness stop (`AGENT_HARNESS_STOPS`) → `AgentBudgetError`, still an
 *   `error` step and a blocked case, message naming the limit;
 * - the page's own enumeration (`cannot-offer`) → `AgentEvidenceError`, a
 *   `failed` step with expected/actual;
 * - the model's `fail`, a contradicted finish, or a record from before the
 *   field existed → the plain `workflow agent failed:` error, an `error`
 *   step — the agent's account is not a verdict, and `harnessOnly`
 *   (`src/cli/exit.ts`) words a `fail` as exactly that.
 */
export function agentLegFailure(record: AgentRecord): Error {
  const endedBy = record.endedBy;
  if (endedBy !== undefined && AGENT_HARNESS_STOPS.has(endedBy)) {
    return new AgentBudgetError(
      endedBy,
      `workflow agent stopped by a harness limit (${harnessLimitOf(endedBy, record)}): ${record.summary} ` +
        '(this is a limit of the run, not a fact about the application — nothing here says the feature is broken)',
    );
  }
  if (endedBy === 'cannot-offer') {
    const comparison = agentLegComparison(record);
    return new AgentEvidenceError(
      comparison?.expected ?? '',
      comparison?.actual ?? '',
      `workflow agent failed on the page's own evidence: ${record.summary}`,
    );
  }
  return new Error(`workflow agent failed: ${record.summary}`);
}

/**
 * The identity a persona label or token reduces to, for matching: angle
 * brackets, an `_ACCOUNT`/`ACCOUNT` tail, case and separators all folded.
 * `<HR_ADMIN_ACCOUNT>`, `HR admin` and `hr-admin` are one key.
 */
export function foldPersonaKey(text: string): string {
  return text
    .trim()
    .replace(/^[<{[]+|[>}\]]+$/g, '')
    .replace(/[\s_\-.]+/g, '')
    .replace(/account$/i, '')
    .toLowerCase();
}

/**
 * The persona `as` names, from the run's map — or null.
 *
 * Labels match loosely on purpose, because the sheets write them four ways:
 * `<HR_ADMIN_ACCOUNT>`, `HR_ADMIN_ACCOUNT`, `HR admin`, `hr-admin`; angle
 * brackets, an `_ACCOUNT`/`ACCOUNT` tail, case and separators are all
 * folded before comparing. A literal email that equals a persona's email
 * matches too, so a flow may say who by address.
 */
export function resolvePersona(
  as: string,
  personas: Readonly<Record<string, { email: string; password: string }>>,
): { label: string; email: string; password: string } | null {
  const fold = foldPersonaKey;
  const wanted = fold(as);
  if (wanted === '') return null;
  const asEmail = as.trim().toLowerCase();
  for (const [label, creds] of Object.entries(personas)) {
    if (label === as || fold(label) === wanted || creds.email.toLowerCase() === asEmail) {
      return { label, email: creds.email, password: creds.password };
    }
  }
  return null;
}

/**
 * The backend steps a flow carries, by index — empty when it carries none.
 *
 * Used by the two enforcement layers below the author: `runFlow` refuses a
 * flow that carries any when backend testing is off, and the step dispatcher
 * refuses each one individually. Three layers on purpose: the author cannot
 * write them, a flow authored earlier (or edited, or repaired) cannot run
 * them, and no path reaches the database or an endpoint by accident. "Not
 * even present" is the rule, and one layer is a rule with a hole in it.
 */
export function backendStepsIn(
  steps: readonly FlowStep[],
): { index: number; action: string }[] {
  const found: { index: number; action: string }[] = [];
  const walk = (list: readonly FlowStep[]): void => {
    for (const [index, step] of list.entries()) {
      if (step.action === 'when') {
        walk(step.then);
        walk(step.else ?? []);
        continue;
      }
      if (BACKEND_TIER_ACTIONS.has(step.action)) found.push({ index, action: step.action });
    }
  };
  walk(steps);
  return found;
}

/** Did this attempt resolve the element and miss only on its text? */
export function isContentMiss(line: string): boolean {
  return /expected text to contain/i.test(line);
}

/**
 * A rung that RESOLVED the element(s) and found the claim about their STATE
 * contradicted: the wrong count (of a non-empty match — zero is absence, and
 * absence may still be selector drift), the wrong enabled/disabled state, or
 * focus elsewhere. Unlike a text miss, no other rung can change this answer:
 * the healer proposes a different string for a control the page already
 * showed, and the agent's one look cannot make 51 options into 3. Live
 * (ec10 HIR-EC-029, 2026-09-02): `expectCount role=option = 3` found 51 at the
 * patience rung — the exact defect the sheet recorded as Failed — and the
 * ladder went on to spend 70 s on a healer and an agent, then classified the
 * step as a dead end that "could not resolve" the control, and every later
 * step inherited the page the agent had wandered onto.
 */
export function isStateContradiction(line: string): boolean {
  return (
    /expected \d+ matches, found [1-9]\d*/.test(line) ||
    /expected element to be (?:enabled|disabled), but it is/.test(line) ||
    /expected element to have focus/.test(line) ||
    // The list opened and was read, and the option is not in it (EH-01,
    // 2026-09-03): the healer cannot open a list and the agent's one look
    // cannot put an option into one. The read IS the verdict — "the option
    // set is wrong" is what HIR-EC-027/029's Failed rows mean.
    /no option named .* appeared/.test(line) ||
    // A click on a disabled control (EH-14): Playwright waits for "enabled"
    // until the timeout and names the state in its call log. The sheets'
    // "ทดลองกด … ไม่มีการเปลี่ยนแปลง" (MC_02_02, ML_01_05/06, PL_06_05, RU_07_02)
    // clicks a gated button on purpose; walking four rungs to say so is the
    // 60 s per case this line saves.
    // (`not editable` is deliberately NOT here: a read-only field is the
    // shell rung's case, one rung below, and has a real input beside it.)
    /element is not enabled/.test(line) ||
    /element is disabled/.test(line) ||
    // The calendar has the day and refuses it (EH-11): the picker's own
    // rule about the date, never the selector's.
    /is outside the picker's allowed range/.test(line) ||
    // The field resolved and was read for its message, and it shows none
    // (EH-12): a reading, not a resolution problem.
    /no validation message is shown for this field|validation message under the field, but none is shown/.test(line)
  );
}

/**
 * An attempt line's reason: the error's first line, plus the state
 * Playwright names further down its call log when there is one.
 *
 * `describe()` keeps the first line only — right for prose, and blind to
 * "element is not enabled", which Playwright prints as a call-log bullet
 * under "locator.click: Timeout 2000ms exceeded." A disabled control then
 * read exactly like a missing one and the ladder walked every rung (EH-14).
 * The state is appended so `isStateContradiction` can read it off the line.
 */
export function describeAttempt(error: unknown): string {
  const first = describe(error);
  if (!(error instanceof Error)) return first;
  const state = /element is not enabled|element is disabled/.exec(error.message);
  if (state === null || first.includes(state[0])) return first;
  return `${first} (${state[0]})`;
}

/**
 * `true` when the ladder's last real reading contradicted the claim — a state
 * contradiction followed by nothing but the dead-end memo. The memo line is
 * evidence the element was read on an earlier step, not a rung of its own.
 */
export function endedInStateContradiction(attempts: readonly string[]): boolean {
  let last = -1;
  for (let i = attempts.length - 1; i >= 0; i--) {
    if (isStateContradiction(attempts[i] ?? '')) {
      last = i;
      break;
    }
  }
  if (last === -1) return false;
  return attempts.slice(last + 1).every((line) => line.startsWith('known content mismatch:'));
}

/**
 * The ancestors of a selector, nearest first — the free repair for a label
 * whose value lives beside it.
 *
 * A summary card renders as a label and a value in separate elements
 * (`TOTAL PLANS` / `75`), so `text=Total plans` resolves the LABEL and its own
 * text can never contain the number. Live (be100 PL_03_01, run of
 * 2026-08-25 09:59): six assertions failed this way, each reporting
 * `expected text to contain "68", got "REIMBURSEMENT BY EMPLOYEE AND HR"` —
 * the element was right and its text was a fragment of the answer. An earlier
 * authoring of the same claims wrote `>> xpath=..` by hand and read
 * `TOTAL PLANS / 75`, which is exactly this, done deliberately.
 *
 * Two levels only, and only for a CONTENT miss: climbing far enough always
 * reaches `body`, where every assertion passes and none of them means
 * anything. Two is the card, the row, the tile — the smallest thing that
 * holds a label and its value together.
 */
export const MAX_KIN_CLIMB = 2;

/**
 * How many deterministic attempts must fail before the agent is asked at all.
 *
 * Three, as asked for directly (2026-08-25): the fast read, the late read,
 * and at least one repair — by then the page has given the same answer three
 * times and a fourth deterministic attempt will not differ.
 */
export const AGENT_TRIAGE_AFTER = 3;

/** What one read-only look at the page concluded about a step that failed. */
export type TriageVerdict = 'proved' | 'can-heal' | 'fail';

/**
 * Read a triage verdict out of the agent's own answer.
 *
 * The verdict rides in the decision's `value` because that is a field the
 * structured schema already has — a new field on every action's shape would
 * cost every prompt in the system tokens for one rung's sake. `fail` is the
 * default reading of anything unrecognised: the safe direction here is to
 * spend nothing and let the step fail on the evidence it already had.
 */
export function triageVerdictOf(value: string | null | undefined): TriageVerdict {
  const word = (value ?? '').trim().toLowerCase();
  if (word.startsWith('proved')) return 'proved';
  if (word.startsWith('can-heal') || word.startsWith('can heal')) return 'can-heal';
  return 'fail';
}

export function ancestorSelectors(selector: string, levels = MAX_KIN_CLIMB): string[] {
  const trimmed = selector.trim();
  if (trimmed === '' || /\bxpath=/.test(trimmed)) return [];
  const out: string[] = [];
  for (let level = 1; level <= levels; level += 1) {
    out.push(`${trimmed} >> xpath=${new Array(level).fill('..').join('/')}`);
  }
  return out;
}

/**
 * The viewport every wowlidator page runs at.
 *
 * Connecting over CDP inherits whatever size the Chrome window happens to be
 * — often a small window on a laptop — so captures came out narrow and, worse,
 * responsive layouts hid their desktop-only controls (this app's tier chips
 * are `hidden xl:inline-flex`, gone below 1280px). Pinning a full-width
 * desktop viewport makes runs, generation, and evidence all see the same
 * layout regardless of the window. `WOWLIDATOR_VIEWPORT=1440x900` overrides;
 * `WOWLIDATOR_VIEWPORT=off` keeps the window's own size.
 */
const DEFAULT_VIEWPORT = { width: 1920, height: 1080 } as const;

function configuredViewport(
  raw: string | undefined = process.env['WOWLIDATOR_VIEWPORT'],
): { width: number; height: number } | null {
  const value = raw?.trim() ?? '';
  if (value === '') return DEFAULT_VIEWPORT;
  if (/^(off|none|0)$/i.test(value)) return null;
  const match = /^(\d{3,5})\s*[xX]\s*(\d{3,5})$/.exec(value);
  if (!match) return DEFAULT_VIEWPORT;
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** What a recording context managed to bring over from the browser it films. */
interface SessionInheritance {
  state: Awaited<ReturnType<BrowserContext['storageState']>> | undefined;
  /** Cookies the attached browser had, whether or not they came across. */
  available: number;
  /** Why nothing was inherited, when that is the answer. */
  error?: string | undefined;
  /** Nothing was inherited ON PURPOSE — the flow signs in itself. Not a finding. */
  declined?: boolean | undefined;
  /** The state came from the suite's own vault, not the attached browser. */
  fromSuite?: boolean | undefined;
}

/**
 * Copy the attached browser's session so a filmed run is the same run.
 *
 * Never throws: a browser that will not hand over its state is a reason to
 * report a run that started signed out, not to refuse to run at all. The
 * counts come back either way so the caller can say what happened — silence
 * here is what turned a lost session into six invented frontend defects.
 */
async function inheritSession(browser: Browser): Promise<SessionInheritance> {
  const source = browser.contexts()[0];
  if (!source) return { state: undefined, available: 0 };
  try {
    const state = await source.storageState();
    return { state, available: state.cookies.length };
  } catch (error) {
    return { state: undefined, available: 0, error: describe(error) };
  }
}

/** Apply the configured viewport. Best-effort — a page that refuses stays as it is. */
async function applyViewport(page: Page): Promise<void> {
  const size = configuredViewport();
  if (size === null) return;
  await page.setViewportSize(size).catch(() => undefined);
}

/**
 * Turn what the agent actually returned into the decision recorded on a step.
 *
 * Deliberately derivative: every word here comes from the agent's own output —
 * `AgentRecord.summary` and the per-action `reasoning` it already produces —
 * rather than a second model call asked to narrate the first. A field that
 * cannot be filled honestly is left empty; synthesising words the agent never
 * said would put a claim in the report wearing the agent's voice.
 *
 * The split matters more than the wording. `observed`/`decided`/`because` are
 * claims; `actions` are the acts; `resolved` is whether the author's own
 * selector then worked, and is the only one of the four that is evidence.
 */
export function decisionFrom(
  record: AgentRecord,
  resolved: boolean,
): StepDecision {
  // The first acting turn is the decision — `finish` is the agent stopping,
  // not choosing. An agent that only ever called `finish` decided to do
  // nothing, and that is recorded as exactly that rather than as an absence.
  const acted = record.actions.filter((a) => a.action !== 'finish');
  const first = acted[0];
  return {
    // What it saw is only ever stated in the reasoning of the turn it acted
    // on; with no acting turn there is nothing it claimed to see, and an
    // empty string says so without inventing a sighting.
    observed: first?.reasoning ?? '',
    decided: first
      ? `${first.action}${first.selector ? ` ${first.selector}` : ''}${
          first.value ? ` = ${first.value}` : ''
        }`
      : 'nothing — the agent judged that no interaction was in the way',
    because: record.summary,
    actions: [...record.actions],
    resolved,
    model: record.model,
  };
}

export function redactAgentRecord(
  record: AgentRecord,
  suppliedSecrets: ReadonlySet<string> = new Set<string>(),
): AgentRecord {
  const secrets = new Set([...suppliedSecrets].filter((value) => value !== ''));
  for (const action of record.actions) {
    const value = action.value;
    if (typeof value !== 'string' || value === '') continue;
    if (
      isSecretStepValue({
        action: action.action,
        selector: action.selector ?? '',
        value,
        fieldIsPassword: null,
        secretValues: suppliedSecrets,
      })
    ) {
      secrets.add(value);
    }
  }

  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  const text = (value: string): string => {
    let safe = value;
    for (const secret of ordered) safe = safe.replaceAll(secret, maskSecret(secret));
    return safe;
  };
  const action = (value: AgentAction): AgentAction => ({
    ...value,
    value: typeof value.value === 'string' ? text(value.value) : value.value,
    url: text(value.url),
    reasoning: text(value.reasoning),
    ...(value.error === undefined ? {} : { error: text(value.error) }),
    ...(value.observed === undefined ? {} : { observed: text(value.observed) }),
    ...(value.listbox === undefined ? {} : { listbox: { ...value.listbox, value: text(value.listbox.value) } }),
  });

  return {
    ...record,
    goal: text(record.goal),
    summary: text(record.summary),
    actions: record.actions.map(action),
    ...(record.observations === undefined
      ? {}
      : {
          observations: record.observations.map((observation) => ({
            ...observation,
            text: text(observation.text),
            url: text(observation.url),
          })),
        }),
    ...(record.settledEvidence === undefined
      ? {}
      : { settledEvidence: text(record.settledEvidence) }),
    // The model's claim is prose the model wrote — it may echo a value it typed.
    ...(record.unreachable === undefined
      ? {}
      : { unreachable: { ...record.unreachable, claim: text(record.unreachable.claim), urlAfter: text(record.unreachable.urlAfter) } }),
  };
}

export function redactStepDecision(
  decision: StepDecision,
  suppliedSecrets: ReadonlySet<string> = new Set<string>(),
): StepDecision {
  const safe = redactAgentRecord(
    {
      goal: decision.observed,
      model: decision.model,
      success: decision.resolved,
      summary: decision.decided,
      actions: decision.actions,
      turns: 0,
      maxSteps: null,
      latencyMs: 0,
      settledEvidence: decision.because,
    },
    suppliedSecrets,
  );
  return {
    ...decision,
    observed: safe.goal,
    decided: safe.summary,
    because: safe.settledEvidence ?? '',
    actions: safe.actions,
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message;
  return String(error);
}

/**
 * Assertions that claim *presence* — "this is shown" — and nothing else.
 * These are the only actions the ladder's narrow rung may satisfy with "one
 * of several matches": any element a text selector matched contains the
 * asserted text, so any of them proves the claim. An action that *does*
 * something (click, fill) is excluded on purpose — acting on an arbitrary
 * match changes what the test exercises.
 */
const PRESENCE_ACTIONS: ReadonlySet<string> = new Set(['expectText', 'expectVisible', 'expectAnyVisible']);

/**
 * How long an ordinary click waits for a popup it did not declare.
 *
 * A `window.open` fired inside a click handler spawns its page while the
 * click is still being awaited, so the event is almost always already there;
 * this is the small margin for the stragglers (400ms — 250 proved tight on a
 * Chrome carrying a full test suite), paid on every click that
 * opens nothing — which is why it is small. A link that *declares*
 * `target="_blank"` gets the healed timeout instead.
 */
const POPUP_GRACE_MS = 400;

/**
 * Per-keystroke pacing for the `type` action — fast enough not to drag a run,
 * slow enough that per-keystroke listeners (debounced autocompletes) see
 * distinct events rather than one burst.
 */
const TYPE_KEY_DELAY_MS = 40;

/** Step pacing while filming for a human viewer (`video: 'always'`). */
export const DEMONSTRATION_STEP_DELAY_MS = 1_500;

/** Animation/state classes that churn on overlays and make a selector stale. */
const OVERLAY_STATE_CLASSES =
  /^(animating|transition|fade|in|out|visible|active|show|showing|open|opening|hidden)$/i;

/**
 * The element Playwright says intercepted a pointer, parsed out of its own
 * actionability log. This is what makes the overlay rung evidence-driven
 * rather than heuristic: the engine names the exact blocker
 * ("<div class=\"ui dimmer modals page …\"> intercepts pointer events"),
 * so acting on it overstates nothing — precisely the ARIA-only modal
 * detector's documented blind spot (a Semantic-UI dimmer carries no
 * `role=dialog`; found live on homepro.co.th's promo modal).
 */
export function parseInterception(
  message: string,
): { css: string | null; label: string } | null {
  // Line-anchored: the actionability log also prints the element the click
  // *resolved to* a few lines earlier, and a lazy match across the whole
  // message names that instead of the blocker.
  const line = message
    .split('\n')
    .find((entry) => entry.includes('intercepts pointer events'));
  if (line === undefined) return null;
  // The line can name two elements — "<p>…</p> from <div class=…>…</div>
  // subtree intercepts pointer events" — and the *last* one is the overlay
  // container; the first is just whichever leaf sat under the pointer.
  const matches = [...line.matchAll(/<(\w+)([^>]*)>/g)];
  const match = matches[matches.length - 1];
  if (!match) return null;
  const tag = match[1]!.toLowerCase();
  const attrs = match[2] ?? '';
  const classMatch = /class="([^"]*)"/.exec(attrs);
  const classes = (classMatch?.[1] ?? '')
    .split(/\s+/)
    .filter((c) => c !== '' && !OVERLAY_STATE_CLASSES.test(c))
    .slice(0, 3);
  const css = classes.length > 0 ? `${tag}.${classes.join('.')}` : null;
  const label = css ?? `<${tag}> overlay`;
  return { css, label };
}

/**
 * Headings that mean "you are not allowed to see this page".
 *
 * Deliberately narrow: only phrases that name an authorization failure
 * outright, in the scripts this codebase already meets. A missed denial page
 * costs one wasted heal; a false positive would suppress healing on a page
 * that merely mentions permissions — understate, never overstate, the same
 * rule `ax-coverage.ts` applies to attribution.
 */
/**
 * How much of a live-region message is kept, and how many. A toast is a
 * sentence; a page mid-error can hold several, and `pageContext` is read by a
 * human at the top of a failure, not scrolled through.
 */
const PAGE_MESSAGE_MAX = 2;
const PAGE_MESSAGE_MAX_CHARS = 160;

const DENIAL_HEADING_PATTERN =
  /access denied|forbidden|not authori[sz]ed|unauthori[sz]ed|permission denied|no permission|ไม่มีสิทธิ์|\b403\b/i;

const LATIN_LETTER = /[A-Za-zÀ-ɏ]/;
const NON_LATIN_LETTER = /[Ͱ-ϿЀ-ӿ֐-׿؀-ۿ฀-๿぀-ヿ一-鿿가-힯]/;

/**
 * A one-line diagnosis for a text assertion that failed across a script
 * boundary: the expected text is in one writing system and the page renders
 * its content in another. Deterministic and purely advisory — it never
 * changes the verdict, it explains it. Without it PB-05-01's report read as
 * "the detail page is broken" when the page had rendered the same employee's
 * name in Thai.
 */
/**
 * A short window of the page's actual text around the part that satisfied the
 * claim — enough to show the value in its context ("119 days remaining", not
 * just "days") without inlining a whole page of innerText into the bundle.
 */
function excerptAround(actual: string, matched: string): string {
  const text = actual.trim();
  if (text.length <= 200) return text;
  const at = text.indexOf(matched);
  if (at === -1) return text.slice(0, 200);
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, at + matched.length + 60);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/**
 * How an expected string was found in the actual text, when it was not found
 * verbatim.
 *
 * Three relaxations, in the order they are tried. Each is a case the
 * deterministic comparison used to lose to and hand — via `nearMiss` — to the
 * review judge and then to a human, at a model call and a queue entry apiece,
 * for a difference nothing about the application had caused.
 *
 * - `case` — the rendered text differs only in capitalisation. Case on screen
 *   is frequently CSS, not content: `text-transform` restyles a heading without
 *   touching the DOM, so the same markup reads "Insert new changes" to
 *   `innerText` and "INSERT NEW CHANGES" to a person. This engine already
 *   concedes the point for accessible names — `relaxRoleName` re-writes every
 *   authored `[name="…"]` to `[name="…" i]` because Chrome and Playwright
 *   disagree about it outright (`tests/selector-case.test.ts`). An assertion
 *   over `innerText` has no better claim to the distinction than the AX tree
 *   does.
 * - `template` — the expected string is a SPEC with a placeholder in it:
 *   "Insert New Changes for Benefit: {Plan name}". The braces are the sheet
 *   author saying "whatever the plan is called", and every literal segment
 *   around them still has to appear, in order. Matching it literally asserts
 *   that the page renders the word "{Plan name}", which no page does.
 * - `template-case` — both at once, which is the shape that actually turned up.
 *
 * Never a silent pass: the relaxation used is recorded on the step and shown in
 * the report, so a reader sees that the page's wording differed and how. A
 * claim that genuinely rides on capitalisation is not provable through
 * `innerText` in the first place and belongs in a visual check.
 */
export type TextMatchRelaxation = 'case' | 'template' | 'template-case' | 'normalised';

/** `{Plan name}`, `{{plan}}`, `<name>` — a sheet author's stand-in for a value. */
const EXPECTED_PLACEHOLDER = /\{\{?[^{}]*\}?\}|<[^<>]+>/g;

/** Intents that say a step is OPENING something — the only clicks whose trigger state is pre-read. */
const OPEN_INTENT = /\bopen|\bexpand|\bunfold|\bdrop-?down|\blistbox|เปิด|กาง/i;

/**
 * How an option's visible label is matched against the accessible names of an
 * open list — the rule now lives in `selector.ts` beside the other name
 * rewrites so `listbox.ts` and this file share it (EH-01, 2026-09-03);
 * re-exported here so `tests/form-actions.test.ts` and `tests/reveal.test.ts`
 * keep their imports.
 */
export { optionNamePatterns };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A regex for an expected string carrying placeholders, or null when it carries
 * none. The literal segments must appear in order; what stands between them is
 * the page's business.
 *
 * Two limits, stated because they bound what a `template` match proves:
 * a placeholder BETWEEN two literals matches at least one character, but
 * whitespace counts — "Benefit: {Plan} Effective" is satisfied by
 * "Benefit:  Effective" — and a placeholder at either END imposes nothing at
 * all, since there is no second literal to anchor it against. So a template
 * match proves the page's fixed wording, never that the variable part was
 * filled in. Asserting the value itself needs the value: quote it from the
 * case, or save it (`saveText`) and compare.
 */
export function templateToRegExp(expected: string, flags: string): RegExp | null {
  EXPECTED_PLACEHOLDER.lastIndex = 0;
  if (!EXPECTED_PLACEHOLDER.test(expected)) return null;
  const source = expected
    .split(EXPECTED_PLACEHOLDER)
    .map((literal) => escapeRegExp(literal.trim()))
    .filter((literal) => literal !== '')
    // Whitespace between literals is the page's to decide: a heading may wrap,
    // and `innerText` then reports a newline where the sheet wrote a space.
    .join('[\\s\\S]+?');
  if (source === '') return null;
  return new RegExp(source, flags);
}

/**
 * Find `expected` inside `actual`, conceding case and placeholders in that
 * order. Returns the substring of `actual` that satisfied it — so the report's
 * "actual" quotes the page's own wording, not the spec's — with the relaxation
 * that was needed, or null when the text is genuinely absent.
 */
export function relaxedTextMatch(
  expected: string,
  actual: string,
): { found: string; relaxation: TextMatchRelaxation } | null {
  const needle = expected.trim();
  if (needle === '') return null;

  const at = actual.toLowerCase().indexOf(needle.toLowerCase());
  if (at !== -1) return { found: actual.slice(at, at + needle.length), relaxation: 'case' };

  // Case-sensitive first, so a template that matches exactly is not reported as
  // a case difference it never had.
  const exactTemplate = templateToRegExp(needle, '');
  const exactHit = exactTemplate?.exec(actual);
  if (exactHit?.[0]) return { found: exactHit[0], relaxation: 'template' };

  const looseTemplate = templateToRegExp(needle, 'i');
  const looseHit = looseTemplate?.exec(actual);
  if (looseHit?.[0]) return { found: looseHit[0], relaxation: 'template-case' };

  // The LAST look (EH-05, 2026-09-03): the value as the sheet reads it —
  // dashes, currency marks, thousands separators, quotes, and the code or
  // label half of a "CODE - Label" value — never script, never plain
  // substring. "A - Permanent" against "A — Permanent" (HIR-EC-037..150),
  // "Active" against "A (Active)", "30,000.00" against "฿30,000.00" were each
  // scored as defects by a comparator that folded case and nothing else.
  const normalised = normalisedTextMatch(needle, actual);
  if (normalised !== null) return { found: normalised, relaxation: 'normalised' };

  return null;
}

/**
 * `foldedMatch` as a text assertion may use it: the whole value, then the
 * label half, and the code half only when it is a real code (two or more
 * characters) — a one-letter code such as the `A` of "A - Permanent" folds
 * to the English article and would be found as a whole word in any sentence.
 * Returns the folded spelling that matched, or null.
 */
export function normalisedTextMatch(expected: string, actual: string): string | null {
  const kind = foldedMatch(expected, actual);
  if (kind === null) return null;
  const halves = codeAndLabelOf(expected);
  if (kind === 'exact' || kind === 'contains') return foldValue(expected);
  if (halves === null) return null;
  if (kind === 'label') return foldValue(halves.label);
  // `code`
  if (foldValue(halves.code).length >= 2) return foldValue(halves.code);
  return foldedIncludes(actual, halves.label) ? foldValue(halves.label) : null;
}

export function scriptMismatchNote(expected: string, actual: string): string {
  const expectedLatin = LATIN_LETTER.test(expected) && !NON_LATIN_LETTER.test(expected);
  const expectedOther = NON_LATIN_LETTER.test(expected) && !LATIN_LETTER.test(expected);
  const actualHasOther = NON_LATIN_LETTER.test(actual);
  const actualHasLatin = LATIN_LETTER.test(actual);
  const crossed = (expectedLatin && actualHasOther) || (expectedOther && actualHasLatin);
  if (!crossed) return '';
  // One line on purpose: the ladder's attempts trace keeps an error's first
  // line only, and a diagnosis that starts on line two never reaches a reader.
  return (
    ' — note: the page renders content in a different script than the expected text; ' +
    'this may be a language rendering, not a missing feature. If the claim is not about ' +
    'language, assert a language-neutral anchor (an ID, code or number) or list the ' +
    "accepted renderings in the step's \"anyOf\"."
  );
}

/**
 * Actions that may legitimately change the page.
 *
 * Used to tell "the test navigated" from "the application navigated" — see
 * `#flagUnrequestedNavigation`. A click can follow a link, a `goto` obviously
 * moves, and the agent drives the browser wholesale; everything else that
 * changes the URL did so without being asked.
 */
/**
 * Steps that PUT A VALUE IN — the ones the entry rung of last resort can
 * hand to the agent, because for these "did it work" is answerable by reading
 * the value back rather than by re-running a selector.
 *
 * `check`/`uncheck` are deliberately absent: their value is a state, not a
 * string, and the ladder's own re-run already decides them.
 */
const ENTRY_ACTIONS: ReadonlySet<string> = new Set(['fill', 'fillRetry', 'type', 'selectOption']);

/**
 * How many steps in a row may end "could not resolve" before the paid rungs
 * stop being offered.
 *
 * A page that answers for nothing is not a selector problem, and the ladder
 * cannot heal its way out of one. Live (HIR-EC-001 run `4989de4a`,
 * 2026-09-08): once `Special Benefit Group` dead-ended, the next fifteen
 * controls dead-ended too — Employee Group, the dates, Work Schedule, the
 * whole Compensation block, and Save & Submit itself — and each one paid a
 * full ladder first: three healer calls and an agent look, ninety to a
 * hundred and thirty seconds apiece. Six minutes of run became thirty-three,
 * and not one of those calls changed a verdict.
 *
 * So after three in a row the free rungs still run, and the paid ones say why
 * they did not. The moment anything resolves the count is cleared, because
 * the evidence for the breaker is gone. Verdicts are identical either way —
 * this buys back time, never a different answer.
 */
const UNRESOLVED_BREAKER = Number(process.env['WOWLIDATOR_UNRESOLVED_BREAKER'] ?? 3);

/** The rule itself, so a test can check the boundary and the off switch. */
export function paidRungsAreWasted(unresolvedRun: number, limit: number = UNRESOLVED_BREAKER): boolean {
  return Number.isFinite(limit) && limit > 0 && unresolvedRun >= limit;
}

/**
 * Does an in-run reconstruction throw away the value the step existed to put in?
 *
 * An entry step's VALUE is its claim, exactly as an assertion's text is. Live
 * (HIR-EC-001 run `720d801c`, 2026-09-08) a failed
 * `selectOption Position = 40106337` was reconstructed as a bare `click` on
 * the Position trigger. The click landed, the step was recorded green, and
 * nothing had been selected — so the application's own auto-fill never fired,
 * four derived fields stayed empty, and thirty later steps failed against a
 * form that had never been filled.
 *
 * The working reconstruction is the other shape the model offers: open the
 * control in `insertBefore`, and click the OPTION in the replacement, which
 * names the value in a selector of its own. Only the shape that silently
 * drops the value is refused, and the step then fails as it did before.
 */
export function reconstructionDropsValue(original: FlowStep, replacement: FlowStep): boolean {
  if (!ENTRY_ACTIONS.has(original.action)) return false;
  const wanted = 'value' in original && typeof original.value === 'string' ? original.value.trim() : '';
  if (wanted === '') return false;
  const value = 'value' in replacement && typeof replacement.value === 'string' ? replacement.value.trim() : '';
  if (value !== '') return false;
  const to = 'selector' in replacement && typeof replacement.selector === 'string' ? replacement.selector : '';
  const from = 'selector' in original && typeof original.selector === 'string' ? original.selector : '';
  // A replacement aimed somewhere else names the value in its own selector
  // (`text=<option>`); one aimed at the same control names nothing.
  return to === from;
}

/**
 * Did the control end up holding what the step asked for?
 *
 * Deliberately tolerant in one direction only: a control routinely RENDERS a
 * value differently from the way it was typed — a date field shows
 * `1 Sep 2027` for `01 Sep 2027`, a combobox reports its label with the
 * surrounding row text. So the asked-for value need only be present in what
 * came back, case- and space-insensitively. It is never the other way round:
 * an empty control can never satisfy a non-empty ask.
 */
/**
 * The `YYYY-MM-DD` a native `<input type="date">` accepts, from the way a
 * person writes a date — or `null` when the text is not unambiguously a date.
 *
 * Playwright's `fill` on a date input rejects anything else with `Malformed
 * value` (measured), and a sheet writes dates the way people read them:
 * `01 Sep 2027`, `1 September 2027`, `Sep 1, 2027`. Only unambiguous shapes are
 * converted; `01/09/2027` is left alone, because whether it is January or
 * September depends on who wrote it, and a wrong guess would enter a wrong
 * date silently.
 */
/**
 * The field names a step's intent speaks of — `Hire Date`, `Date of Birth`,
 * `National ID / Tax ID` — as the label a hidden input is named by.
 *
 * Title-Case runs (with `of`/`/`/`&` allowed inside) and anything quoted, up to
 * three, longest first, so "key Hire Date = 15 Sep 2027 into the Hire Date
 * field" yields `Hire Date` once. Pure; tested through the shell rung.
 */
export function fieldNamesIn(intent: string | undefined): string[] {
  if (intent === undefined || intent.trim() === '') return [];
  const found = new Set<string>();
  for (const m of intent.matchAll(/["“']([^"”']{2,60})["”']/g)) found.add(m[1]!.trim());
  // The Thai phrase after a data-entry verb — "กรอกวันเกิด", "ระบุวันที่มีผล
  // = 15 ก.ย. 2569", "เลือก Event Reason เป็น New Hire" — up to the value
  // separator (` = `, `เป็น`, `ตาม`, `ด้วย`, `:`) or the end (EH-03 (3),
  // 2026-09-03). A Thai intent yielded nothing before, so the shell rung
  // skipped its label-first branch on every Thai sheet. Vowel signs and tone
  // marks are `\p{M}`, not `\p{L}` — a class without it stops mid-word.
  for (const m of intent.matchAll(
    /(?:กรอก|เลือก|ระบุ|ตั้งค่า|ใส่|คีย์|กำหนด|พิมพ์)\s*(?:ช่อง|ฟิลด์|field)?\s*([\p{L}\p{M}\p{N} /&]{2,60}?)\s*(?:=|:|เป็น|ตาม|ด้วย|ให้|แล้ว|,|$)/gmu,
  )) {
    const phrase = m[1]!.trim().replace(/\s+(?:ว่า|คือ)$/u, '');
    if (phrase.length < 2 || /^\d+$/.test(phrase)) continue;
    found.add(phrase);
  }
  for (const m of intent.matchAll(/\b([A-Z][A-Za-z]+(?:(?:\s+(?:of|the|and|&|\/)\s*|\s+)[A-Z][A-Za-z]*)*)\b/g)) {
    // Strip the verb a step intent opens with ("Enter the National ID / Tax
    // ID" → "National ID / Tax ID"), then drop what is left of the openers,
    // months and anything numeric — those are never a field's label.
    const phrase = m[1]!
      .trim()
      .replace(/^(?:Step|Case|Test|Expected|Key(?:\s+in)?|Fill(?:\s+in)?|Enter|Select|Click|Set|Type|Choose|Then|And)\b(?:\s+(?:the|a|an|in|into))?\s*/, '')
      .trim();
    if (phrase === '' || !/^[A-Z]/.test(phrase)) continue;
    if (/^(The|Then|And|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Age|Today)$/.test(phrase)) continue;
    if (/\d/.test(phrase)) continue;
    found.add(phrase);
  }
  return [...found].sort((a, b) => b.length - a.length).slice(0, 3);
}

/**
 * Since 2026-09-03 (EH-03) the conversion lives in `engine/dates.ts` — a
 * superset of what this file did (Thai months, a Buddhist year beside one,
 * `dd/mm/yyyy` under a locale, `31/12/9999` anywhere) with the same refusals
 * (`01/09/2027` with no locale stays null). Re-exported so callers and
 * `tests/form-actions.test.ts` keep their import.
 */
export function isoDateOf(text: string, locale?: DateLocale | undefined): string | null {
  return isoDateOfText(text, locale);
}

export function valueMatches(asked: string, held: string): boolean {
  const fold = (v: string): string => v.toLowerCase().replace(/\s+/g, ' ').trim();
  const a = fold(asked);
  const h = fold(held);
  if (a === '') return h === '';
  if (h.includes(a)) return true;
  // The sheet's spelling against the control's rendering (EH-05): "A -
  // Permanent" held as "A — Permanent", "CDS (C001)" held as "C001". Whole
  // words, never substring, so this widens only past the dash and code
  // conventions the page and the sheet disagree on.
  return foldedMatch(asked, held) !== null;
}

const NAVIGATING_ACTIONS: ReadonlySet<string> = new Set([
  'goto',
  'click',
  'press',
  'back',
  'forward',
  'workflow',
  'closeModal',
  // A persona switch signs out, travels to the sign-in page and lands on
  // the account's home — three navigations the flow asked for (EH-10).
  'signIn',
]);

// `differentPage` (origin or pathname differ) is imported from
// `orchestrator/goal-evidence.ts` since 2026-09-03 (OA-9) so the runner's
// displacement note and the agent's own history line share one predicate.

/**
 * Whether this URL can hold web storage at all.
 *
 * Only http and https get a storage origin. `about:blank` — where every page
 * starts, and where a flow sits until its first `goto` — is opaque, and so are
 * `file:`, `data:` and `chrome:`; touching `localStorage` on any of them throws
 * a `SecurityError` rather than returning empty. Decided by inspecting the URL,
 * the same way `isBrowserFree` decides whether a flow needs a browser: it cannot
 * be wrong, and it cannot be confused with storage that a real origin has
 * genuinely refused.
 */
export function hasStorableOrigin(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * One person's browser for the length of a run: the Chrome, the context (the
 * cookie jar), the page the steps drive, and everything that describes THAT
 * page rather than the run — the recording, the caption on it, the network
 * observer attached to it, the session guard's memory of where its last
 * `goto` went. A runner holds one of these per persona it has signed in as
 * (multi-browser personas, 2026-09-03) and every step reads the active one,
 * so a hand-off between people is a pointer move, never a sign-out.
 *
 * The first session is the one `connect()` attached; `signIn` opens the
 * others on the Chromes `SmartRunnerOptions.personaBrowsers` names.
 */
type PersonaSession = {
  /** The persona label this session belongs to; null until a `signIn` claims it. */
  label: string | null;
  /** Where the Chrome listens; null for an `attach()`ed embedder's browser. */
  cdpUrl: string | null;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Only a context this runner created may be closed by it — see `close()`. */
  ownsContext: boolean;
  /** Set only when this runner created a recording context for this session. */
  video: { dir: string; size: { width: number; height: number } } | null;
  /** The caption now showing, re-applied whenever a navigation wipes it. */
  caption: string;
  /** Pages this session drove and then navigated away from, via popup adoption. */
  pagesLeftBehind: Page[];
  network: NetworkObserver | null;
  /** Where the previous step's network mark sat — see `#takeNetMark`. */
  previousNetMark: number | undefined;
  /** Lower bound of the current step's evidence window. */
  evidenceFloorMs: number | undefined;
  /** Where the last `expectCalls` window ended — see the accessor's note. */
  sequenceMark: number;
  /** Path of the most recent `goto`, and whether that goto asked for a sign-in page. */
  lastGotoPath: string | null;
  lastGotoAskedSignIn: boolean;
  lastAction: string | null;
  /** Did the step that ran that action FAIL? See `dialogIsIntendedContext`. */
  lastActionFailed: boolean;
  strandedReported: boolean;
  /** See the `#signInDidNotTake` accessor. */
  signInDidNotTake: boolean;
  /** The session bootstrap runs once per session — a second bounce is a real finding. */
  sessionBootstrapTried: boolean;
  /** The account the last `signIn` on this session established, for the suite's vault. */
  signedInAs: string | null;
  /** How the recording was sealed, once `close()` has run. */
  sealed: VideoRecording | null;
};

/** What `SmartRunner.#openContext` hands back. */
type OpenedContext = {
  context: BrowserContext;
  page: Page;
  video: { dir: string; size: { width: number; height: number } } | null;
};

export class SmartRunner {
  /**
   * Mutable on purpose: a click on a `target="_blank"` link navigates a page
   * this runner would otherwise never watch, and adopting the popup (see
   * `#adoptPage`) is what keeps the flow on the journey the user is on.
   *
   * A view of the ACTIVE persona's page (see `PersonaSession`): a persona
   * switch re-points it, and the ~50 step implementations that read
   * `this.page` follow without knowing.
   */
  get page(): Page {
    return this.#active.page;
  }
  set page(page: Page) {
    this.#active.page = page;
  }
  readonly bundle: ProofBundleBuilder;

  /** Every session this run opened, in creation order; the first is the primary. */
  readonly #sessions: PersonaSession[] = [];
  /** The session the steps are driving now. */
  #active: PersonaSession;
  get #context(): BrowserContext {
    return this.#active.context;
  }
  readonly #cache: CacheManager;
  readonly #healer: JitHealer | null;
  readonly #agent: WorkflowAgent | null;
  readonly #caseContext: string | undefined;
  readonly #dataModel: DataModel | null;
  readonly #fastTimeoutMs: number;
  readonly #healedTimeoutMs: number;
  readonly #screenshots: ScreenshotMode;
  readonly #highlightTarget: boolean;
  readonly #dbBaselineProbe: DbBaselineProbe | null;
  readonly #captureDelayMs: number;
  /**
   * Set only when this runner created a recording context, which is also the
   * only case in which it may close one. An embedder that came in through
   * `attach()` owns its own context and its own video, if any.
   */
  get #video(): { dir: string; size: { width: number; height: number } } | null {
    return this.#active.video;
  }
  set #video(video: { dir: string; size: { width: number; height: number } } | null) {
    this.#active.video = video;
  }
  /** How this run is filmed — `'always'` keeps the whole recording on a pass. */
  #videoMode: VideoMode = 'on';
  /** Dwell per action moment when the film is condensed (`'on'`). */
  #videoDwellMs: number = VIDEO_ACTION_DWELL_MS;
  /** Perform actions like a person (`humanize.ts`); follows the recording unless set. */
  #humanize = false;
  /** Whether a context this runner opens is filmed — the `video` option, remembered for persona sessions. */
  #recording = true;
  /** Pause before each step. See `SmartRunnerOptions.stepDelayMs`. */
  #stepDelayMs = 0;
  /** The caption now showing, re-applied whenever a navigation wipes it. */
  get #caption(): string {
    return this.#active.caption;
  }
  set #caption(caption: string) {
    this.#active.caption = caption;
  }
  readonly #agentAssist: boolean;
  /** See `SmartRunnerOptions.agentMaxSteps`. `undefined` leaves the agent's own budget alone. */
  readonly #agentMaxSteps: number | undefined;
  /** See `SmartRunnerOptions.mutationPolicy`. `undefined` leaves the agent's own default alone. */
  readonly #mutationPolicy: MutationPolicy | null | undefined;
  /** Whether this run may exercise the backend at all — see `assertBackendAllowed`. */
  readonly #backend: boolean;
  /** What the application's repository declares — see `RouteNotFoundError`. */
  readonly #declaredRoutes: readonly string[];
  readonly #deploymentUrl: string | undefined;
  /**
   * Selectors that already exhausted the ladder in this run, keyed by
   * `url :: selector` (and the persona, when one is signed in: an employee's
   * 403 page and the manager's real page share a URL and nothing else),
   * valued with the step index that established it. Never persisted — a
   * negative result belongs to this run's page state only.
   */
  readonly #deadResolutions = new Map<string, { step: number; contentMiss: boolean }>();
  /** Pages this session drove and then navigated away from, via popup adoption. */
  get #pagesLeftBehind(): Page[] {
    return this.#active.pagesLeftBehind;
  }
  /**
   * Repair model for in-run step reconstruction, or null. Public and
   * readonly: `executeSteps` (a module function, not a method) drives the
   * retry loop and needs to consult it.
   */
  readonly stepRepair: FlowRepairModel | null;
  /** The suite's step-level data lock, or null — see `SmartRunnerOptions.dataGate`. */
  readonly dataGate: DataGate | null;
  /** Where the previous step's network mark sat — see `#takeNetMark`. */
  get #previousNetMark(): number | undefined {
    return this.#active.previousNetMark;
  }
  set #previousNetMark(mark: number | undefined) {
    this.#active.previousNetMark = mark;
  }
  /** Lower bound of the current step's evidence window. */
  get #evidenceFloorMs(): number | undefined {
    return this.#active.evidenceFloorMs;
  }
  set #evidenceFloorMs(floor: number | undefined) {
    this.#active.evidenceFloorMs = floor;
  }
  readonly #coverage: boolean;
  readonly #baselineDir: string;
  readonly #updateBaselines: boolean;
  readonly #networkEnabled: boolean;
  readonly #networkRedaction: RedactionPolicy;
  /**
   * Values the person named as secret via `--as`. Masked wherever they land in
   * a record — see `#maskValue`. A set, so the check stays exact-match: no
   * substring cleverness, which would mask an unrelated field that happened to
   * contain the password as a fragment.
   */
  readonly #secretValues: ReadonlySet<string>;
  readonly #networkMaxCalls: number | undefined;
  get #network(): NetworkObserver | null {
    return this.#active.network;
  }
  set #network(observer: NetworkObserver | null) {
    this.#active.network = observer;
  }
  readonly #api: ApiActions;
  /** Whether `#api`'s transport is the active context's — rebuilt on a persona switch. */
  readonly #transportFollowsContext: boolean;
  readonly #db: DbActions;
  /** The time `setClock` pinned, re-installed on every persona page opened after it. */
  #pinnedClock: Date | null = null;
  /**
   * Where the last `expectCalls` window ended — consecutive `expectCalls`
   * steps verify consecutive stretches of the journey. Deliberately not the
   * `#evidenceFloorMs` machinery: that floor reaches back into the previous
   * step by design, which is right for failure evidence and wrong for a
   * window that must not double-count.
   */
  get #sequenceMark(): number {
    return this.#active.sequenceMark;
  }
  set #sequenceMark(mark: number) {
    this.#active.sequenceMark = mark;
  }
  #defectSeq = 0;
  #ownsPage = true;
  /** Path of the most recent `goto`, and whether that goto asked for a sign-in page. */
  get #lastGotoPath(): string | null {
    return this.#active.lastGotoPath;
  }
  set #lastGotoPath(path: string | null) {
    this.#active.lastGotoPath = path;
  }
  get #lastGotoAskedSignIn(): boolean {
    return this.#active.lastGotoAskedSignIn;
  }
  set #lastGotoAskedSignIn(asked: boolean) {
    this.#active.lastGotoAskedSignIn = asked;
  }
  get #lastAction(): string | null {
    return this.#active.lastAction;
  }
  set #lastAction(action: string | null) {
    this.#active.lastAction = action;
    // Assigning an action always clears the failure mark; only `noteAction`
    // sets it, and only for a step that actually threw.
    this.#active.lastActionFailed = false;
  }
  get #lastActionFailed(): boolean {
    return this.#active.lastActionFailed;
  }
  set #lastActionFailed(failed: boolean) {
    this.#active.lastActionFailed = failed;
  }
  get #strandedReported(): boolean {
    return this.#active.strandedReported;
  }
  set #strandedReported(reported: boolean) {
    this.#active.strandedReported = reported;
  }
  /**
   * A credential submit fired, the hydration race ate it, and the replay did
   * not rescue it — so this session holds no session. Positive evidence only:
   * set from the same signatures `nativeFormResubmitDetected` and
   * `fillsLostToHydration` produce, never from a page merely looking like a
   * login screen. See `#strandedMessage`.
   */
  get #signInDidNotTake(): boolean {
    return this.#active.signInDidNotTake;
  }
  set #signInDidNotTake(didNotTake: boolean) {
    this.#active.signInDidNotTake = didNotTake;
  }
  /** `--as`, for the session bootstrap; masking holds them separately. */
  #credentials: { email: string; password: string } | undefined;
  #flowSignsInItself = false;
  /** The bootstrap runs once per session — a second bounce is a real finding. */
  get #sessionBootstrapTried(): boolean {
    return this.#active.sessionBootstrapTried;
  }
  set #sessionBootstrapTried(tried: boolean) {
    this.#active.sessionBootstrapTried = tried;
  }
  /** Only a context this runner created may be closed by it — see `close()`. */
  get #ownsContext(): boolean {
    return this.#active.ownsContext;
  }
  set #ownsContext(owns: boolean) {
    this.#active.ownsContext = owns;
  }
  /** Credentials by persona label, for `signIn` steps — see `SmartRunnerOptions.personas`. */
  readonly #personas: Record<string, { email: string; password: string }>;
  /** How the sheets write dates — see `SmartRunnerOptions.locale`. */
  readonly #locale: DateLocale | undefined;
  /** What `upload` fixture paths resolve against. */
  readonly #flowDir: string | undefined;
  /** Where `download` saves. */
  readonly #downloadDir: string;
  /**
   * The sign-in page this flow's own gotos named, learned from the first goto
   * that asked for one — where a `signIn` step goes when it names no `url`.
   */
  #signInUrl: string | null = null;
  /**
   * Chromes still unclaimed for later personas — see
   * `SmartRunnerOptions.personaBrowsers`. Shifted as `signIn` hands them out.
   */
  readonly #personaBrowsers: string[];
  /** See `SmartRunnerOptions.sessionStates`. */
  readonly #sessionStates: Readonly<Record<string, StoredSession>>;
  readonly #consentPolicy: ConsentPolicy;
  /** The account the last `signIn` step established on the active session, for the suite's vault. */
  get #lastSignedInAs(): string | null {
    return this.#active.signedInAs;
  }
  set #lastSignedInAs(email: string | null) {
    this.#active.signedInAs = email;
  }
  /** URLs (per persona) the not-found rung already filed a defect for — one per page, never per step. */
  readonly #notFoundReported = new Set<string>();

  private constructor(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    options: SmartRunnerOptions,
    cdpUrl: string | null = options.cdpUrl ?? null,
  ) {
    this.#active = SmartRunner.#newSession({ browser, context, page, cdpUrl });
    this.#sessions.push(this.#active);
    this.bundle = options.bundle;
    this.bundle.setActor({ persona: null, browser: cdpUrl });
    this.#cache = options.cache;
    this.#healer = options.healer ?? null;
    this.#agent = options.agent ?? null;
    this.#dataModel = options.dataModel ?? null;
    this.#caseContext = options.caseContext;
    this.#fastTimeoutMs = options.fastTimeoutMs ?? DEFAULT_FAST_TIMEOUT_MS;
    this.#healedTimeoutMs = options.healedTimeoutMs ?? DEFAULT_HEALED_TIMEOUT_MS;
    this.#screenshots =
      options.screenshots ?? ((options.video ?? 'on') !== 'off' ? 'on-failure' : 'all');
    this.#captureDelayMs = options.captureDelayMs ?? DEFAULT_CAPTURE_DELAY_MS;
    this.#highlightTarget = options.highlightTarget ?? true;
    this.#dbBaselineProbe = options.dbBaselineProbe ?? null;
    if (this.#dbBaselineProbe !== null) this.bundle.setDbBaseline(this.#dbBaselineProbe.summary());
    this.#agentAssist = options.agentAssist ?? false;
    this.#agentMaxSteps = options.agentMaxSteps;
    this.#mutationPolicy = options.mutationPolicy;
    this.#backend = options.backend ?? true;
    this.#declaredRoutes = options.declaredRoutes ?? [];
    this.#deploymentUrl = options.deploymentUrl;
    this.stepRepair = options.stepRepair ?? null;
    this.dataGate = options.dataGate ?? null;
    this.#stepDelayMs =
      options.stepDelayMs ?? ((options.video ?? 'on') === 'always' ? DEMONSTRATION_STEP_DELAY_MS : 0);
    this.#coverage = options.coverage ?? true;
    this.#baselineDir = options.baselineDir ?? DEFAULT_BASELINE_DIR;
    this.#updateBaselines = options.updateBaselines ?? false;
    this.#networkEnabled = options.network ?? true;
    this.#networkRedaction = options.networkRedaction ?? {};
    // Only the password. The email is not a secret and is the evidence that
    // says which persona signed in. Every persona's password joins the set
    // (EH-10): a `signIn` step never writes one into a flow file, but the
    // sign-in it performs must not leak one into a record either.
    this.#personas = options.personas ?? {};
    this.#personaBrowsers = [...(options.personaBrowsers ?? [])];
    this.#sessionStates = options.sessionStates ?? {};
    this.#secretValues = new Set(
      [
        ...(options.credentials?.password ? [options.credentials.password] : []),
        ...Object.values(this.#personas).map((p) => p.password),
      ].filter((p) => p !== ''),
    );
    this.#credentials = options.credentials;
    this.#locale = options.locale;
    this.#flowDir = options.flowDir;
    this.#downloadDir =
      options.downloadDir ?? join('.wowlidator', 'downloads', options.bundle.name.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80) || 'run');
    this.#flowSignsInItself = options.flowSignsInItself ?? false;
    this.#consentPolicy = options.consentPolicy ?? 'accept';
    this.#networkMaxCalls = options.networkMaxCalls;
    this.#recording = (options.video ?? 'on') !== 'off';
    this.#humanize = options.humanize ?? this.#recording;
    this.#transportFollowsContext = options.transport === undefined;
    // One store, both action families: a `request` step saves `{{orderId}}`
    // and an `expectDbRow` keys on it — two stores would make one name mean
    // two different things in one flow.
    const variables = new VariableStore();
    const recordDefect = (
      category: Defect['category'],
      severity: Defect['severity'],
      title: string,
      detail: string,
    ): void => this.#recordRuntimeDefect(category, severity, title, detail, undefined);
    this.#api = new ApiActions({
      transport: options.transport ?? new BrowserTransport(context),
      bundle: this.bundle,
      variables,
      redaction: this.#networkRedaction,
      currentUrl: () => this.#currentUrl(),
      recordDefect,
    });
    this.#db = new DbActions({
      db: options.db === undefined ? defaultDbConfig() : options.db,
      client: options.dbClient,
      bundle: this.bundle,
      variables,
      currentUrl: () => this.#currentUrl(),
      // Read only after a DB check has already failed, and only to separate
      // "the write was refused" from "no write was ever sent". GET and HEAD
      // cannot change state, so they are not evidence that anything tried.
      // The browser-free construction below passes none of this: an API flow
      // has no page to watch, and no witness means no attribution, which is
      // exactly the behaviour this had before.
      writeWitness: () => {
        const observer = this.#network;
        if (!observer) return { observing: false, total: 0, mutating: 0 };
        const calls = observer.all();
        return {
          observing: true,
          total: calls.length,
          mutating: calls.filter((call) => !/^(GET|HEAD)$/i.test(call.method)).length,
        };
      },
      recordDefect,
    });
  }

  /** Values saved by `request` steps, for `{{name}}` interpolation later. */
  get variables(): VariableStore {
    return this.#api.variables;
  }

  /**
   * Attach to a running browser over CDP. This never launches Chrome — start
   * one with `--remote-debugging-port=9222` first (`npm run chrome`).
   */
  static async connect(options: SmartRunnerOptions): Promise<SmartRunner> {
    const cdpUrl = options.cdpUrl ?? DEFAULT_CDP_URL;
    const browser = await SmartRunner.#attachBrowser(cdpUrl);

    // Recording is a property of a context, set when the context is created,
    // and there is no way to switch it on for one that already exists. So a
    // recorded run gets its own context — and with it its own cookie jar,
    // which is the cost of filming and the reason `--video off` exists.
    const recording = (options.video ?? 'on') !== 'off';
    let inheritance: SessionInheritance | null = null;
    let opened: OpenedContext;
    if (recording || options.isolate === true) {
      // **A recording context must carry the attached browser's session, or
      // filming silently changes what the test is.** Recording is a property
      // of a context and can only be set when one is created, so a filmed run
      // cannot reuse the browser's own context — and a bare `newContext()`
      // starts with an empty cookie jar. Against an application that requires
      // a login, every protected URL then redirects to the sign-in page and
      // the whole run tests the login screen: twenty steps "pass" on a page
      // the flow never meant to be on, the assertions fail, and the report
      // blames the selectors. Seen exactly that way in PB_02_01, whose 26
      // steps all ran on `/en/login`.
      //
      // `storageState()` is the whole session as data — cookies, and
      // localStorage for every origin the browser visited — so handing it to
      // the new context makes filming invisible to the application.
      // The suite's own vault outranks the attached browser: a session a
      // sibling case established seconds ago is the fresher truth.
      //
      // An isolated, unfilmed run makes the same move for a different
      // reason: a context of its own, carrying the session so the
      // application cannot tell the difference.
      inheritance =
        options.inheritSession === false
          ? { state: undefined, available: 0, declined: true }
          : options.sessionState !== undefined
            ? { state: options.sessionState, available: options.sessionState.cookies.length, fromSuite: true }
            : await inheritSession(browser);
      opened = await SmartRunner.#openContext(browser, {
        recording,
        storageState: inheritance.state,
        load: () => options.cache.load(),
      });
    } else {
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = await context.newPage();
      await applyViewport(page);
      await options.cache.load();
      opened = { context, page, video: null };
    }

    const runner = new SmartRunner(browser, opened.context, opened.page, options, cdpUrl);
    if (inheritance) runner.#noteSessionInheritance(inheritance);
    // Whoever created the context closes it. Without this an isolated,
    // unfilmed run leaves a live context behind in a Chrome that outlives the
    // process — one per case, every suite.
    if (options.isolate === true) runner.#ownsContext = true;
    if (opened.video) {
      runner.#video = opened.video;
      runner.#videoMode = options.video ?? 'on';
      runner.#videoDwellMs = options.videoDwellMs ?? VIDEO_ACTION_DWELL_MS;
      // The first frame is written when the page opens, so this is the origin
      // every step's offset is measured from.
      runner.#ownsContext = true;
      keepCaption(opened.page, () => runner.#caption);
      options.bundle.setVideoStart(Date.now());
    }
    await runner.observeNetwork();
    return runner;
  }

  /** Attach to a Chrome over CDP — connect-only, never a launch. */
  static async #attachBrowser(cdpUrl: string): Promise<Browser> {
    try {
      return await chromium.connectOverCDP(cdpUrl);
    } catch (error) {
      throw new Error(
        `could not attach to a browser at ${cdpUrl}: ${describe(error)}\n` +
          'Start Chrome with --remote-debugging-port first (npm run chrome).',
      );
    }
  }

  /**
   * A context of this runner's own — filmed when asked, carrying the session
   * given as data — and the page on it. Everything from the context to a
   * usable page is on the hook for undoing the context if it fails: nothing
   * else will close it, and an abandoned recording context is not garbage —
   * it is a live browser context sitting in a Chrome that outlives this
   * process, one per failed run.
   */
  static async #openContext(
    browser: Browser,
    what: { recording: boolean; storageState: StoredSession | undefined; load?: (() => Promise<void>) | undefined },
  ): Promise<OpenedContext> {
    const viewport = configuredViewport();
    const size = videoSize(viewport);
    const dir = what.recording ? await videoTempDir() : null;
    const context = await browser.newContext({
      ...(dir ? { recordVideo: { dir, size } } : {}),
      ...(viewport ? { viewport } : {}),
      ...(what.storageState ? { storageState: what.storageState } : {}),
    });
    try {
      if (dir) await installCursorOverlay(context);
      const page = await context.newPage();
      await applyViewport(page);
      await what.load?.();
      return { context, page, video: dir ? { dir, size } : null };
    } catch (error) {
      await context.close().catch(() => undefined);
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** A fresh `PersonaSession` around a browser, context and page. */
  static #newSession(where: { browser: Browser; context: BrowserContext; page: Page; cdpUrl: string | null }): PersonaSession {
    return {
      label: null,
      cdpUrl: where.cdpUrl,
      browser: where.browser,
      context: where.context,
      page: where.page,
      ownsContext: false,
      video: null,
      caption: '',
      pagesLeftBehind: [],
      network: null,
      previousNetMark: undefined,
      evidenceFloorMs: undefined,
      sequenceMark: Date.now(),
      lastGotoPath: null,
      lastGotoAskedSignIn: false,
      lastAction: null,
      lastActionFailed: false,
      strandedReported: false,
      signInDidNotTake: false,
      sessionBootstrapTried: false,
      signedInAs: null,
      sealed: null,
    };
  }

  /** The session a persona label owns, if one has been opened for it. */
  #sessionOf(label: string): PersonaSession | undefined {
    const wanted = foldPersonaKey(label);
    return this.#sessions.find((s) => s.label !== null && foldPersonaKey(s.label) === wanted);
  }

  /**
   * Make `session` the one the steps drive. A pointer move plus the two
   * things bound to a context or a page rather than to the run: the API
   * transport (a context's cookie jar) and a pinned clock (a page's).
   */
  async #activate(session: PersonaSession): Promise<void> {
    if (session === this.#active) return;
    this.#active = session;
    this.bundle.setActor({ persona: session.label, browser: session.cdpUrl });
    if (this.#transportFollowsContext) this.#api.setTransport(new BrowserTransport(session.context));
    if (this.#pinnedClock !== null) {
      await session.page.clock.install({ time: this.#pinnedClock }).catch(() => undefined);
    }
    await this.observeNetwork();
  }

  /**
   * Open a persona's own browser: attach to the Chrome `cdpUrl` names, give
   * it a context of this runner's own (filmed like the primary, seeded from
   * the vault's state for that account when the suite has one — never from
   * whatever the pool member's default context was left holding), and make
   * it the active session. The Chrome answering nothing is a harness error:
   * the machine, not the application.
   */
  async #openPersonaSession(label: string, cdpUrl: string, storageState: StoredSession | undefined): Promise<PersonaSession> {
    let browser: Browser;
    try {
      browser = await chromium.connectOverCDP(cdpUrl);
    } catch (error) {
      throw new PersonaBrowserUnavailableError(
        `signIn as ${label}: could not attach to the browser at ${cdpUrl} for this persona — ${describe(error)}`,
      );
    }
    let opened: OpenedContext;
    try {
      opened = await SmartRunner.#openContext(browser, { recording: this.#recording, storageState });
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw new PersonaBrowserUnavailableError(
        `signIn as ${label}: the browser at ${cdpUrl} would not open a context for this persona — ${describe(error)}`,
      );
    }
    const session = SmartRunner.#newSession({ browser, context: opened.context, page: opened.page, cdpUrl });
    session.label = label;
    session.ownsContext = true;
    if (opened.video) {
      session.video = opened.video;
      keepCaption(opened.page, () => session.caption);
      this.bundle.setVideoStart(Date.now(), label);
    }
    this.#sessions.push(session);
    await this.#activate(session);
    return session;
  }

  /** The persona label the steps are running as, or null before any `signIn`. */
  get activePersona(): string | null {
    return this.#active.label;
  }

  /** Where the active persona's Chrome listens, for the record; null for an attached embedder. */
  get activeBrowser(): string | null {
    return this.#active.cdpUrl;
  }

  /**
   * The persona scope for an agent leg's REPLAY MEMORY — the label, or nothing.
   *
   * Every `#agent.run` that passes `memory` must pass this too. Two people ask
   * the same question from the same address in a case that changes hands ("open
   * Team > Probation Reviews and open the case" as the manager, then as the
   * approver), and an unscoped key replays the first person's journey on the
   * second person's browser at zero model turns. `#deadResolutions` is keyed
   * this way already, for the same reason spelled out where it is declared.
   *
   * Only the LABEL, and only for the key: it never reaches a prompt. A
   * single-persona run yields `undefined` and keys exactly as it always did.
   */
  #agentPersona(): { persona: string } | Record<string, never> {
    const label = this.activePersona;
    return label === null || label === '' ? {} : { persona: label };
  }

  /**
   * Start watching the page's HTTP traffic. Idempotent and best-effort:
   * `connect()` calls it for you, and embedders that came in through
   * `attach()` can call it themselves.
   *
   * Failure here is swallowed by design. Observation is diagnostic — the same
   * rule history and coverage follow — and a browser that won't hand out a
   * second CDP session is a reason to run without evidence, not to fail a run
   * that would otherwise have been perfectly good.
   */
  async observeNetwork(): Promise<void> {
    if (!this.#networkEnabled || this.#network) return;
    try {
      this.#network = await NetworkObserver.attach(this.page, {
        redaction: this.#networkRedaction,
        maxCalls: this.#networkMaxCalls,
      });
      this.#sequenceMark = this.#network.mark();
    } catch {
      this.#network = null;
    }
  }

  /** Feed statically-generated findings into this run's report. */
  addDefects(defects: readonly Defect[]): void {
    this.bundle.addDefects(defects);
  }

  /** Wrap an existing page — used by tests and by embedders that own the browser. */
  static attach(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    options: SmartRunnerOptions,
  ): SmartRunner {
    const runner = new SmartRunner(browser, context, page, options);
    runner.#ownsPage = false;
    return runner;
  }

  // --- Actions -------------------------------------------------------------

  async goto(url: string): Promise<void> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    // What the flow asked for, which is what makes "we were sent somewhere
    // else" a fact rather than a guess.
    try {
      const asked = new URL(url, this.page.url() || undefined);
      this.#lastGotoPath = asked.pathname;
      // Per-goto, not sticky-for-the-run: a flow that signs in FIRST always
      // has a login goto in its past, and a run-wide flag then exempted the
      // exact case the guard exists for — a post-login goto to a protected
      // page bounced straight back to /login, followed by every body step
      // dead-ending against login furniture as "frontend" defects. Only the
      // most recent goto says what the flow means to be looking at now.
      this.#lastGotoAskedSignIn = looksLikeSignIn(asked.href);
      // The flow's own sign-in page, remembered for a `signIn` step that
      // names none — the same place `groundCredentialFills` learns it from.
      if (this.#lastGotoAskedSignIn && this.#signInUrl === null) this.#signInUrl = asked.href;
    } catch {
      this.#lastGotoPath = null;
      this.#lastGotoAskedSignIn = false;
    }
    const urlBeforeNav = this.page.url();
    try {
      // **The response is evidence, and it used to be thrown away.** Playwright
      // resolves `goto` for any response at all, so a 404 recorded as a
      // passing navigation and every later step then failed against an error
      // page — attributed to the application (be100 PL_02_03, 2026-08-25).
      const response = await this.page.goto(url, { waitUntil: 'domcontentloaded' });
      // **The session bootstrap.** A goto that asked for an ordinary page and
      // landed on the sign-in screen, in a run that HAS credentials and whose
      // flow contains no sign-in of its own, is a flow that assumes a session
      // against a browser that has none — a fresh headless Chrome, an
      // isolated context. Seen live (BE_Test2.csv, 2026-08-19 16:53): a
      // test-case-table catalog authored against a signed-in browser, every
      // case of which then died on the login screen under the session guard.
      // The rows' own precondition is "a signed-in user", the person supplied
      // the account (`--as`), and establishing a documented precondition
      // deterministically is preparation, not the claim — the same contract
      // as the agent rung. Once per run; a flow that signs in itself is never
      // raced; no credentials means the honest fatal below stands.
      const bootstrapped = await this.#bootstrapSession(url);
      // **Consent-gate recovery** (docs/consent-gate-recovery-spec.md, F1).
      // A client-side consent gate can render ON the URL this goto asked for
      // — URL unchanged, consent heading showing — and accepting it bounces
      // to the app's home landing, abandoning the deep link. Both facts
      // measured on the BE_Test2 11:52 run, where recovery left to the model
      // was a coin flip: the one flow whose agent returned to the asked-for
      // page passed, the three that wandered off by menu label went red.
      // Deterministic here: detect by content, accept, re-issue this goto
      // once. Never when the goto asked for the gate itself.
      const consentSettled = await this.#settleConsentGate(url, urlBeforeNav);
      // Judged after the recoveries above, never before: a consent gate or a
      // session bootstrap can turn a first 4xx into a perfectly good page,
      // and failing on the first answer would blame the app for a redirect
      // it was always going to make.
      await this.#judgeNavigationStatus(url, response);
      // The pointer put back on the new document's overlay (film only): a
      // fresh document shows no pointer until the mouse moves. No pause —
      // the film already holds the landing for its dwell, and a real pause
      // here moved the ladder's clock (the patience rung's fixtures flipped
      // from `late` to `fast` at 350 ms).
      await humanSettle(this.page, { enabled: this.#humanize });
      this.bundle.addStep({
        action: 'goto',
        selector: null,
        resolvedSelector: null,
        resolution: null,
        status: 'passed',
        startedAt,
        durationMs: Date.now() - started,
        url: this.page.url(),
        detail: {
          url,
          ...(bootstrapped === null ? {} : { sessionEstablished: bootstrapped }),
          ...(consentSettled === 'accepted' ? { consentAccepted: true } : {}),
          ...(consentSettled === 'preserved' ? { consentPreserved: true } : {}),
        },
        // The landing state. A navigation is where the page changes most, so
        // this is the frame everything after it is read against.
        screenshot: await this.#shoot(bootstrapped === null && !consentSettled ? 'routine' : 'notable'),
      });
    } catch (error) {
      this.bundle.addStep({
        action: 'goto',
        selector: null,
        resolvedSelector: null,
        resolution: null,
        status: 'failed',
        startedAt,
        durationMs: Date.now() - started,
        url: this.page.url(),
        detail: { url },
        error: describe(error),
        // A failed navigation still lands somewhere — an error page, a login
        // redirect, a blank screen — and which of those it is decides what to
        // do next.
        screenshot: await this.#shoot('failure'),
      });
      throw error;
    }
  }

  /**
   * Click — and follow the click where it actually went.
   *
   * A link with `target="_blank"` (homepro.co.th's "ติดต่อเรา", live) opens
   * its destination in a NEW page: the click lands, nothing on the watched
   * page changes, and every later step asserts against the page the user
   * left. So a click that spawns a popup adopts it: the runner switches to
   * the new page and the flow continues on the journey the click started.
   * Recorded on the step (`detail.openedNewTab`) — an adopted page is a fact
   * about the run, not a silent switch.
   *
   * The wait is paid where it is owed: a declared `target="_blank"` waits
   * properly for its popup; everything else gets a short grace, enough for a
   * `window.open` fired in the click handler, cheap enough for the thousands
   * of clicks that never spawn anything.
   */
  async click(selector: string, intent?: string): Promise<void> {
    const detail: Record<string, unknown> = {};
    await this.#step(
      'click',
      selector,
      intent,
      async (locator, timeout) => {
        // The listener is armed before the click, so a popup spawned during
        // the click's own await — a `target="_blank"` default action, a
        // `window.open` in the handler — is already resolved by the time the
        // grace window is consulted. No attribute pre-read: that would spend
        // a second rung-timeout before the click got its first, silently
        // doubling the fast path for every click on the page.
        // A listbox trigger TOGGLES. A flow that opens a dropdown, counts its
        // options, then "opens" it again before the next check closes it,
        // and every check after that fails on a list that is not there (ec10
        // HIR-EC-029, 2026-09-02). Only when the step's own intent says it is
        // opening something is the one-attribute read paid, and only an
        // already-expanded popup trigger is left alone.
        if (intent !== undefined && OPEN_INTENT.test(intent)) {
          const state = await locator
            .first()
            .evaluate((el) => [el.getAttribute('aria-haspopup'), el.getAttribute('aria-expanded')], undefined, {
              timeout: ATTRIBUTE_READ_TIMEOUT_MS,
            })
            .catch(() => null);
          if (state !== null && state[0] !== null && state[0] !== 'false' && state[1] === 'true') {
            detail['skipped'] = 'already open';
            this.bundle.note(`${selector}: already open (aria-expanded=true) — not clicked again; a second click would close it`);
            return;
          }
        }
        // Humanised: the pointer travels to the element the rung resolved
        // and hovers (`humanize.ts`) BEFORE the popup listener is armed —
        // the approach never clicks, and a grace window that started
        // counting during it would have expired before the press.
        const performStarted = Date.now();
        const spent = this.#humanize ? await approach(this.page, locator, timeout) : 0;
        const popupPromise = this.page
          .waitForEvent('popup', { timeout: POPUP_GRACE_MS })
          .catch(() => null);
        try {
          await locator.click({ timeout: remainingTimeout(timeout, spent) });
          if (this.#humanize) detail['performedMs'] = Date.now() - performStarted;
        } catch (error) {
          // A grace window consumed on a failed click would tax every rung
          // of the ladder; the failure is the story, rethrow it now.
          popupPromise.catch(() => null);
          throw error;
        }
        const popup = await popupPromise;
        if (popup !== null) {
          await this.#adoptPage(popup);
          detail['openedNewTab'] = this.page.url();
        }
        await this.#noteNotFoundLanding(detail);
      },
      detail,
    );
  }

  /**
   * Did the action just land the run on the application's own not-found
   * page? The click itself did what it said — it is recorded on the PASSED
   * step as `landedOnNotFound`, and the verdict lands on the first assertion
   * after it (the not-found stop rung, EH-09). One bounded read, after the
   * navigation the click started has had a moment to commit; a navigation
   * still in flight is caught by the next step's rung instead.
   */
  async #noteNotFoundLanding(detail: Record<string, unknown>): Promise<void> {
    try {
      await this.page.waitForLoadState('domcontentloaded', { timeout: 500 }).catch(() => undefined);
      const surface = await notFoundSurface(this.page, 500);
      if (surface === null) return;
      detail['landedOnNotFound'] = surface.heading;
      this.bundle.note(
        `the page now shows "${surface.heading}" at ${surface.url} — the action led to a page the application does not have; ` +
          'the next assertion carries the verdict',
      );
    } catch {
      // Evidence only — a read that fails changes nothing about the step.
    }
  }

  /**
   * Continue the run on a page the application just opened.
   *
   * The original page is left as it is — closing it mid-run could take a
   * recording with it, and it is the page the user's journey came from. On a
   * filmed run the popup was born inside the recording context, so it is on
   * film too; captions resume with the next step's narration.
   */
  async #adoptPage(popup: Page): Promise<void> {
    await popup.waitForLoadState('domcontentloaded', { timeout: this.#healedTimeoutMs }).catch(() => undefined);
    await applyViewport(popup);
    // Remembered so `close()` can shut it: leaving it to leak accumulated a
    // tab per adopted popup, and a Chrome carrying dozens of leftover tabs
    // degrades every run after it. It cannot be closed *now* — a filmed
    // run's recording may live on it, and it is the page the journey came
    // from if anything still needs to look back.
    this.#pagesLeftBehind.push(this.page);
    this.page = popup;
  }

  async fill(selector: string, value: string, intent?: string, valueSource?: StepValueSource): Promise<void> {
    const detail: Record<string, unknown> = this.#withValueSource({ value }, valueSource);
    await this.#step(
      'fill',
      selector,
      intent,
      async (locator, timeout) => {
        // Humanised, the value goes in character by character (no keydown,
        // as `fill` promises) and is READ BACK; a field that does not hold
        // it is filled by this same `fill` — the rung's own action decides.
        const performed = await humanFill(this.page, locator, value, timeout, { enabled: this.#humanize });
        if (performed) detail['performedMs'] = performed.performedMs;
      },
      detail,
    );
  }

  /**
   * Carry the step's value provenance onto the proof, and say out loud when a
   * value was GENERATED by the author: the run typed a stand-in, and a reader
   * judging the result has to know it was not the sheet's data.
   */
  #withValueSource(detail: Record<string, unknown>, source: StepValueSource | undefined): Record<string, unknown> {
    if (source === undefined) return detail;
    if (source.kind === 'generated') {
      this.bundle.note(`value generated by the author for ${String(detail['value'] ?? '')}: ${source.detail}`);
    }
    return { ...detail, valueSource: source };
  }

  /**
   * Choose a dropdown option by its visible label — one step for both a
   * native `<select>` and a custom combobox. `fill` throws on a select and
   * `click` can only open one; this is the action that completes it.
   */
  async selectOption(selector: string, value: string, intent?: string, valueSource?: StepValueSource): Promise<void> {
    const detail: Record<string, unknown> = value === ANY_OFFERED ? { value } : this.#withValueSource({ value }, valueSource);
    await this.#step(
      'selectOption',
      selector,
      intent,
      async (locator, timeout) => {
        // Explicit timeout: locator.evaluate would otherwise wait Playwright's
        // 30s default for a missing element, stretching every ladder rung. Its
        // failure is left to throw — "the dropdown is not there" must read as
        // an ordinary resolution failure, not as a missing option.
        const tag = await locator.first().evaluate((el) => el.tagName, undefined, { timeout });
        detail['via'] = tag === 'SELECT' ? 'native' : 'custom';
        const chosen = tag === 'SELECT'
          ? await this.#selectNative(locator, value, timeout)
          : await this.#selectCustom(locator, selector, value, timeout, detail);
        if (value === ANY_OFFERED) {
          detail['actual'] = chosen;
          Object.assign(detail, this.#withValueSource(detail, {
            kind: 'generated',
            detail: `the sheet named no value; took the first option the control offered: ${JSON.stringify(chosen)}`,
          }));
        }
      },
      detail,
    );
  }

  /** Native `<select>`: match the visible label first, the value attribute second. */
  async #selectNative(locator: Locator, value: string, timeout: number): Promise<string> {
    if (value === ANY_OFFERED) {
      const offered = locator.locator('option:not([disabled])');
      const count = await offered.count();
      for (let index = 0; index < count; index += 1) {
        const option = offered.nth(index);
        const optionValue = await option.getAttribute('value', { timeout });
        if (optionValue === null || optionValue === '') continue;
        const label = ((await option.textContent({ timeout })) ?? '').trim();
        await locator.selectOption(optionValue, { timeout });
        return label;
      }
      const shown = (await locator.locator('option').allTextContents()).map((label) => label.trim()).filter((label) => label !== '');
      throw new ListboxOptionMissingError('the select', value, shown, '');
    }
    try {
      await locator.selectOption({ label: value }, { timeout });
    } catch {
      // The author may have quoted the value attribute instead of the label.
      await locator.selectOption(value, { timeout });
    }
    return value;
  }

  /**
   * Custom dropdown: click to open, then pick the option the way a user
   * would — `selectFromListbox` (`engine/listbox.ts`, EH-01 2026-09-03). The
   * driver waits for a dependent list to fill (District after Province,
   * HIR-EC-001), types the CODE half into the search box humi's searchable
   * selects offer, matches the whole name before a whole word and never a
   * substring, ticks each row of a multi-value ("CDS (C001), B2S (C006)",
   * PL_06_07), and reads the trigger back so a click that landed on a
   * disabled option is a failure with evidence rather than a green step.
   * The option is searched page-wide because custom dropdowns portal their
   * options to the end of the document, not inside the control.
   *
   * The list is given the HEALED budget, not the rung's: resolving the
   * trigger is the race the ladder times; a fetch that fills the list is
   * the application's own pace, the same argument `type` makes for typing.
   */
  async #selectCustom(
    locator: Locator,
    selector: string,
    value: string,
    timeout: number,
    detail: Record<string, unknown>,
  ): Promise<string> {
    void selector;
    // `record`, not `require`: a trigger whose text is its LABEL ("City")
    // never shows the pick, and demanding it failed a listbox that had
    // worked (tests/form-actions.test.ts). The read-back is on the record;
    // a click that landed on a disabled option is already its own error.
    const result = await selectFromListbox(this.page, locator, value, {
      timeout: Math.max(timeout, this.#healedTimeoutMs),
      readBack: 'record',
    });
    detail['selected'] = result.picked;
    detail['matchedBy'] = result.matchedBy;
    detail['readBack'] = result.readBack;
    detail['readBackConfirmed'] = result.confirmed;
    detail['waitedMs'] = result.waitedMs;
    if (result.typed !== undefined) detail['typed'] = result.typed;
    if (result.via === 'checkbox') detail['via'] = 'multi-select';
    return result.picked[0] ?? value;
  }

  /** Tick a checkbox, radio, or ARIA toggle — see `#setChecked`. */
  async check(selector: string, intent?: string): Promise<void> {
    await this.#setChecked('check', selector, true, intent);
  }

  /** Untick one. */
  async uncheck(selector: string, intent?: string): Promise<void> {
    await this.#setChecked('uncheck', selector, false, intent);
  }

  /**
   * Set a checkable control's state and verify it actually changed — what
   * makes this preferable to a bare `click` when the resulting state is the
   * point. Native inputs go through Playwright's `setChecked`; a styled
   * toggle falls back to reading `aria-checked`/`aria-pressed`, clicking only
   * when the state differs, and re-reading to confirm. A control exposing no
   * state at all is refused rather than clicked blind.
   */
  async #setChecked(
    action: 'check' | 'uncheck',
    selector: string,
    target: boolean,
    intent?: string,
  ): Promise<void> {
    const detail: Record<string, unknown> = {};
    await this.#step(action, selector, intent, async (locator, timeout) => {
      // Explicit timeout for the same reason as selectOption's tag probe:
      // evaluate waits 30s by default for an element that may not be there.
      const readState = (): Promise<boolean | null> =>
        locator
          .first()
          .evaluate(
            (el) => {
              const aria = el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed');
              return aria === null ? null : aria === 'true';
            },
            undefined,
            { timeout },
          )
          .catch(() => null);

      try {
        // Native checkbox or radio — Playwright verifies the state itself.
        await locator.setChecked(target, { timeout });
        detail['via'] = 'native';
      } catch (error) {
        // Not natively checkable. Without ARIA state there is nothing to
        // verify against, so the original error stands.
        const before = await readState();
        if (before === null) throw error;
        detail['via'] = 'aria';
        if (before === target) return; // already in the wanted state — a no-op, not a toggle
        await locator.click({ timeout });
        const after = await readState();
        if (after !== target) {
          throw new Error(
            `clicked ${JSON.stringify(selector)}, but it still reports ` +
              `${action === 'check' ? 'unchecked' : 'checked'} (aria state ${String(after)})`,
          );
        }
      }
    }, detail);
  }

  /**
   * Type into a field key by key, firing the events a real keyboard fires —
   * for autocomplete/typeahead/masked fields that react per keystroke, which
   * `fill`'s single programmatic assignment cannot wake.
   */
  async type(selector: string, value: string, intent?: string, valueSource?: StepValueSource): Promise<void> {
    const detail: Record<string, unknown> = this.#withValueSource({ value }, valueSource);
    await this.#step(
      'type',
      selector,
      intent,
      async (locator, timeout) => {
        const started = Date.now();
        // Focus the way a user does, then clear so the typed value is the
        // whole value. A non-input target (a div listening for keydown) has
        // nothing to clear; that is fine.
        await humanClick(this.page, locator, timeout, { enabled: this.#humanize });
        await locator.fill('', { timeout }).catch(() => undefined);
        // The typing budget scales with length: resolving the field is the
        // race the ladder times, typing N characters at a human pace is not,
        // and a fixed 2s window would fail long values on timing alone.
        // Real keystrokes either way; humanised only jitters the pace.
        const performed = await humanKeys(
          this.page,
          locator,
          value,
          TYPE_KEY_DELAY_MS,
          Math.max(this.#healedTimeoutMs, value.length * TYPE_KEY_DELAY_MS + 1000),
          { enabled: this.#humanize },
        );
        if (performed) detail['performedMs'] = Date.now() - started;
      },
      detail,
    );
  }

  async waitFor(selector: string, intent?: string, timeoutMs?: number): Promise<void> {
    await this.#step(
      'waitFor',
      selector,
      intent,
      (locator, timeout) => locator.waitFor({ state: 'visible', timeout }),
      undefined,
      stepPatience(timeoutMs),
    );
  }

  /**
   * Seed a localStorage key. The page must already be on the target origin —
   * localStorage is origin-scoped, so `goto` has to come first.
   */
  async setLocalStorage(key: string, value: string): Promise<void> {
    await this.#bareStep('setLocalStorage', { key }, async () => {
      await this.page.evaluate(
        ([k, v]: [string, string]) =>
          (globalThis as unknown as BrowserGlobals).localStorage.setItem(k, v),
        [key, value] as [string, string],
      );
    });
  }

  /**
   * Pin the page's clock to a fixed moment, via Playwright's clock API.
   *
   * This is the capability that makes time-dependent claims checkable at all:
   * "14 days remaining shows the Urgent chip" is a claim about a boundary,
   * and a run on the wall clock exercises whatever day it happens to be —
   * usually none of the boundaries, while the report reads as though it
   * checked them (seen live: a 13/13 "pass" of an urgency-tier case whose
   * four probe dates were all in the past by run day). No selector, nothing
   * to heal — `#bareStep`, like the other state seeding. An unparseable time
   * fails loudly: a clock silently NOT installed turns every later assertion
   * back into that vacuous pass.
   */
  async setClock(time: string, intent?: string): Promise<void> {
    await this.#bareStep('setClock', { time, ...(intent !== undefined ? { intent } : {}) }, async () => {
      const parsed = new Date(time);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(
          `setClock: "${time}" is not a date the clock can be pinned to — use ISO, e.g. 2026-08-01 or 2026-08-01T00:00:00Z`,
        );
      }
      await this.page.clock.install({ time: parsed });
      // A clock is per page: a persona's page opened after this gets the
      // same pin, or the manager's leg would run on the wall clock.
      this.#pinnedClock = parsed;
    });
  }

  /**
   * Clear localStorage and sessionStorage for the current origin.
   *
   * **A page that has not navigated yet has no storage to clear, and that is
   * done, not an error.** Storage is origin-scoped; before the first `goto` the
   * page sits on `about:blank`, whose origin is opaque, and reading
   * `localStorage` there throws `SecurityError: Access is denied for this
   * document`. As the first step of `setup` — where a model reliably puts it,
   * and where it reads as ordinary hygiene — that aborts the flow before it has
   * looked at the application even once, and reports a frontend defect about a
   * page nobody visited.
   *
   * So the origin is checked first and the clear is skipped when there is
   * nothing to clear, with the reason recorded on the step rather than left to
   * be inferred from a suspiciously fast pass. On a real origin the call is made
   * for real and a `SecurityError` there still fails the step: storage blocked
   * on a page that *has* storage is a genuine finding about the environment, and
   * swallowing it would be the overstatement this is trying to avoid.
   *
   * `setLocalStorage` deliberately does **not** do this. Its intent is to put a
   * value somewhere, which an opaque origin cannot honour, so a flow that seeds
   * auth before navigating must fail loudly instead of running on unauthenticated
   * and failing later somewhere confusing. Clearing has the opposite property:
   * "leave no storage behind" is already true of a page that has none.
   */
  async clearStorage(): Promise<void> {
    const url = this.page.url();
    const storable = hasStorableOrigin(url);
    await this.#bareStep(
      'clearStorage',
      storable ? {} : { cleared: 'nothing — the page has not navigated to an origin yet', url },
      async () => {
        if (!storable) return;
        await this.page.evaluate(() => {
          const g = globalThis as unknown as BrowserGlobals;
          g.localStorage.clear();
          g.sessionStorage.clear();
        });
      },
    );
  }

  /**
   * Sign out through the application's own control (`performSignOut`), so a
   * persona switch exercises the same path a user takes. When the app offers
   * no name-gated sign-out control anywhere the step falls back to clearing
   * cookies and storage — the session still ends, and the step's `detail`
   * says the real path was not exercised rather than letting a wiped session
   * read as a working sign-out. A `#bareStep`: there is no author-supplied
   * selector to heal, the `setLocalStorage` category.
   */
  async signOut(intent?: string): Promise<void> {
    const detail: Record<string, unknown> = { intent, urlBefore: this.page.url() };
    await this.#bareStep('signOut', detail, async () => {
      // The active session is nobody's after this: a later `signIn` for the
      // same label logs in again rather than "switching" to a dead session.
      this.#active.label = null;
      this.#active.signedInAs = null;
      this.bundle.setActor({ persona: null, browser: this.#active.cdpUrl });
      const result = await performSignOut(this.page);
      if (result.ok) {
        detail['via'] = result.via;
        detail['urlAfter'] = result.landedUrl;
        return;
      }
      // Fallback: end the session without the app's help. Cookies AND
      // storage — a cookie-backed session survives a storage wipe entirely.
      await this.page.context().clearCookies();
      if (hasStorableOrigin(this.page.url())) {
        await this.page.evaluate(() => {
          const g = globalThis as unknown as BrowserGlobals;
          g.localStorage.clear();
          g.sessionStorage.clear();
        });
      }
      detail['via'] =
        `fallback — ${result.reason}; cleared cookies and storage instead, so the ` +
        'application\'s own sign-out path was NOT exercised';
      detail['urlAfter'] = this.page.url();
    });
  }

  // --- History navigation --------------------------------------------------
  //
  // A journey through an application is rarely a straight line: open a card,
  // check it, come back, open the next one. Without these a flow has to
  // `goto` the origin page again, which throws away exactly the state the
  // journey was testing — scroll position, an open filter, a loaded list.

  /**
   * Let any navigation already in flight finish before touching history.
   *
   * `click` returns when the click lands, not when the router responds, so a
   * `back` immediately after a click steps back past the entry the click was
   * about to create — landing on whatever preceded the *test*, usually
   * `about:blank`. Found against a real queue page: the row navigated, `back`
   * ran 37ms later, and the flow failed with "there is no previous page" while
   * the application had done nothing wrong.
   *
   * Stability, not a fixed wait: the URL is sampled until it stops changing,
   * so a fast navigation costs one sample and a slow one is still caught.
   */
  async #settleNavigation(): Promise<void> {
    const deadline = Date.now() + this.#fastTimeoutMs;
    let previous = this.page.url();
    let stable = 0;
    while (Date.now() < deadline && stable < 2) {
      await this.page.waitForTimeout(80);
      const current = this.page.url();
      stable = current === previous ? stable + 1 : 0;
      previous = current;
    }
  }

  /** Go back one entry in history, and wait for the page that follows. */
  async back(intent?: string): Promise<void> {
    await this.#bareStep('back', { intent }, async () => {
      await this.#settleNavigation();
      // `commit`, not the default `load`: a back navigation restored from the
      // back/forward cache fires no load event at all, so waiting for one
      // times out on exactly the pages where going back worked perfectly.
      const response = await this.page.goBack({
        timeout: this.#healedTimeoutMs,
        waitUntil: 'commit',
      });
      await this.page
        .waitForLoadState('domcontentloaded', { timeout: this.#healedTimeoutMs })
        .catch(() => undefined);
      // `goBack` resolves with null when there was nowhere to go. Silently
      // continuing would leave every later step asserting against the wrong
      // page and blaming the wrong thing.
      if (response === null && this.page.url() === 'about:blank') {
        throw new Error('there is no previous page to go back to');
      }
    });
  }

  /** Go forward one entry in history. */
  async forward(intent?: string): Promise<void> {
    await this.#bareStep('forward', { intent }, async () => {
      await this.#settleNavigation();
      const response = await this.page.goForward({
        timeout: this.#healedTimeoutMs,
        waitUntil: 'commit',
      });
      await this.page
        .waitForLoadState('domcontentloaded', { timeout: this.#healedTimeoutMs })
        .catch(() => undefined);
      if (response === null && this.page.url() === 'about:blank') {
        throw new Error('there is no next page to go forward to');
      }
    });
  }

  // --- Scrolling -----------------------------------------------------------

  /**
   * Scroll something into view.
   *
   * Goes through the ladder, unlike the other bare steps here: the target is
   * an author-supplied selector that can drift like any other, and healing it
   * is meaningful.
   */
  async scrollTo(selector: string, intent?: string): Promise<void> {
    await this.#step('scrollTo', selector, intent, async (locator, timeout) => {
      // A smooth scroll first, for the film; the instant one is the action
      // of record and a no-op once the element is already in view.
      await humanScrollTo(locator, timeout, { enabled: this.#humanize });
      await locator.scrollIntoViewIfNeeded({ timeout });
    });
  }

  /**
   * Assert that something can actually be scrolled.
   *
   * "Is there more content below?" and "can a user reach it?" are different
   * questions, and only the second one matters. A container with
   * `overflow: hidden`, a fixed-height panel whose inner list overflows
   * invisibly, a modal body that traps the wheel — all of them have content
   * past the fold that nobody can get to, and every functional assertion
   * written against them passes, because the DOM is perfectly fine.
   *
   * So this checks both halves: there is overflow, *and* moving the scroll
   * position actually moves it. The position is restored afterwards, because
   * an assertion that leaves the page somewhere else changes what the next
   * step is testing.
   */
  async expectScrollable(selector?: string, intent?: string): Promise<void> {
    await this.#bareStep('expectScrollable', { selector, intent }, async () => {
      // Poll, don't measure once. Found against a real hub page: at 73ms the
      // document was still a shell exactly one viewport tall, so a single
      // reading reported "696px of content in 696px" and called a page that
      // scrolls to 2806px unscrollable. Same hydration race `expectUrl` lost.
      const result = await this.#pollScroll(selector, (r) => r.overflows && r.moved);
      if (!result.overflows) {
        throw new Error(
          `expected ${result.what} to be scrollable, but its content fits ` +
            `(${result.scrollSize}px of content in ${result.clientSize}px)`,
        );
      }
      if (!result.moved) {
        throw new Error(
          `expected ${result.what} to be scrollable: its content overflows ` +
            `(${result.scrollSize}px in ${result.clientSize}px) but the scroll position ` +
            'would not move — the overflow is unreachable',
        );
      }
    });
  }

  /** The mirror of `expectScrollable`, for a pane that must stay put. */
  async expectNotScrollable(selector?: string, intent?: string): Promise<void> {
    await this.#bareStep('expectNotScrollable', { selector, intent }, async () => {
      // A negative assertion must not wait for the thing to become true — that
      // would be waiting for its own failure. It does have to let the page
      // finish arriving first, or it passes against a shell that has not
      // rendered the content yet, which is the same false pass in reverse.
      await this.page
        .waitForLoadState('networkidle', { timeout: this.#fastTimeoutMs })
        .catch(() => undefined);
      const result = await this.#measureScroll(selector);
      if (result.overflows && result.moved) {
        throw new Error(
          `expected ${result.what} not to scroll, but it does ` +
            `(${result.scrollSize}px of content in ${result.clientSize}px)`,
        );
      }
    });
  }

  /**
   * Measure until the page agrees, or the fast-path budget runs out.
   *
   * Returns the last measurement either way, so the failure message reports
   * the real numbers rather than "timed out" — the sizes are the whole
   * diagnostic value of a scroll assertion.
   */
  async #pollScroll(
    selector: string | undefined,
    satisfied: (result: ScrollMeasurement) => boolean,
  ): Promise<ScrollMeasurement> {
    const deadline = Date.now() + this.#fastTimeoutMs;
    let last = await this.#measureScroll(selector);
    while (!satisfied(last) && Date.now() < deadline) {
      await this.page.waitForTimeout(100);
      last = await this.#measureScroll(selector);
    }
    return last;
  }

  /**
   * Measure scrollability, restoring the position before returning.
   *
   * Runs in one `evaluate` so the probe-and-restore cannot be interleaved with
   * anything the page does — a half-scrolled page left behind by a failed
   * assertion is a state no later step asked for.
   */
  async #measureScroll(selector?: string): Promise<ScrollMeasurement> {
    if (selector) {
      // A missing container is a different failure from an unscrollable one,
      // and saying so beats reporting "0px of content in 0px".
      const count = await this.page.locator(selector).count();
      if (count === 0) throw new Error(`no element matches ${JSON.stringify(selector)} to scroll`);
    }

    const measured = await this.page.evaluate((target: string | null) => {
      const g = globalThis as unknown as BrowserScroll;
      const element = target
        ? (g.document.querySelector(target) as ScrollTarget | null)
        : (g.document.scrollingElement as ScrollTarget | null);
      if (!element) return null;

      const scrollSize = element.scrollHeight;
      const clientSize = element.clientHeight;
      const overflows = scrollSize > clientSize + 1;

      // `element.scrollTop = n` works even on `overflow: hidden`, so moving the
      // position proves nothing on its own — script can scroll what a user
      // cannot. The computed style is what says whether a wheel, a drag or a
      // keypress would do anything, and that is the question being asked.
      const style = g.getComputedStyle(element as unknown as ScrollStyled);
      const axis = String(style.overflowY || style.overflow || '');
      const userScrollable =
        element === g.document.scrollingElement || /(auto|scroll|overlay)/.test(axis);

      const before = element.scrollTop;
      element.scrollTop = before + Math.max(40, Math.floor(clientSize / 2));
      const moved = userScrollable && element.scrollTop !== before;
      element.scrollTop = before;

      return { scrollSize, clientSize, overflows, moved };
    }, selector ?? null);

    if (!measured) throw new Error(`nothing to measure for ${selector ?? 'the page'}`);
    return { what: selector ? JSON.stringify(selector) : 'the page', ...measured };
  }

  // --- Keyboard ------------------------------------------------------------

  /** Press a key, optionally focusing `selector` first. */
  async press(key: string, selector?: string, intent?: string): Promise<void> {
    if (selector === undefined) {
      await this.#bareStep('press', { key }, () => this.page.keyboard.press(key));
      return;
    }
    await this.#step(
      'press',
      selector,
      intent,
      (locator, timeout) => locator.press(key, { timeout }),
      { key },
    );
  }

  /** Assert the element currently holds keyboard focus. */
  async expectFocused(selector: string, intent?: string): Promise<void> {
    await this.#step('expectFocused', selector, intent, async (locator, timeout) => {
      await locator.waitFor({ state: 'attached', timeout });
      if (!(await locator.first().evaluate((el) => el === el.ownerDocument.activeElement))) {
        throw new Error('expected element to have focus, but it does not');
      }
    });
  }

  /**
   * Tab through the page and assert focus lands on `selectors` in order.
   *
   * Focus order is the one accessibility property that cannot be read from a
   * static tree — it only exists while tabbing — so it needs a real
   * interaction to verify.
   */
  async expectTabOrder(selectors: readonly string[], intent?: string): Promise<void> {
    await this.#bareStep('expectTabOrder', { selectors, intent }, async () => {
      // Reset focus so the sequence is reproducible regardless of what ran
      // before.
      //
      // Two non-obvious traps here, both found the hard way:
      //   - `body.focus()` alone is a no-op, because body is not focusable
      //     without a tabindex.
      //   - `activeElement.blur()` clears activeElement but leaves Chrome's
      //     *sequential focus navigation starting point* on the old element,
      //     so the next Tab resumes from there instead of the top.
      // Temporarily making body focusable and focusing it resets both.
      await this.page.evaluate(() => {
        const body = (globalThis as unknown as BrowserDocument).document.body;
        const hadTabIndex = body.hasAttribute('tabindex');
        if (!hadTabIndex) body.setAttribute('tabindex', '-1');
        body.focus();
        if (!hadTabIndex) body.removeAttribute('tabindex');
      });

      const reached: string[] = [];
      for (const selector of selectors) {
        await this.page.keyboard.press('Tab');
        const matched = await this.page
          .locator(selector)
          .first()
          .evaluate((el) => el === el.ownerDocument.activeElement)
          .catch(() => false);
        reached.push(matched ? selector : '(not focused)');
        if (!matched) {
          throw new Error(
            `tab order diverged at position ${reached.length}: expected focus on ` +
              `${JSON.stringify(selector)}. Reached: ${reached.join(' → ')}`,
          );
        }
      }
    });
  }

  // --- Data-driven ---------------------------------------------------------

  /**
   * Fill one field with several values, asserting after each.
   *
   * This is boundary-value analysis made expressible. Every case runs even
   * after one fails — a partial boundary table is far less useful than the
   * whole one when you are trying to find where behaviour changes.
   */
  /**
   * Boundary values are the step's own evidence, so they are NOT masked by the
   * credential heuristics that guard `fill`/`type` — a table showing which
   * inputs a form accepted is worthless with its inputs hidden, and these
   * values come from the author's table or from `mock-data.ts`, never from a
   * real account. A value the person supplied through `--as` is still masked:
   * that statement outranks this reasoning wherever the two meet.
   */
  async fillEach(
    selector: string,
    cases: readonly DataCase[],
    intent?: string,
    submit?: string,
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const results: DataCaseResult[] = [];

    for (const [index, testCase] of cases.entries()) {
      const label = testCase.label ?? `case ${index + 1}`;
      try {
        await this.page
          .locator(selector)
          .first()
          .fill(testCase.value, { timeout: this.#healedTimeoutMs });
        // Validation usually fires on submit, not on input — without this,
        // every boundary case would assert against a form that never ran.
        if (submit !== undefined) {
          await this.page.locator(submit).first().click({ timeout: this.#healedTimeoutMs });
        }
        await this.#checkDataExpectation(testCase);
        results.push({ label, value: this.#maskSuppliedSecret(testCase.value), ok: true });
      } catch (error) {
        results.push({
          label,
          value: this.#maskSuppliedSecret(testCase.value),
          ok: false,
          error: describe(error),
        });
      }
    }

    const failed = results.filter((r) => !r.ok);
    const status = failed.length === 0 ? 'passed' : 'failed';

    this.bundle.addStep({
      action: 'fillEach',
      intent,
      selector,
      resolvedSelector: selector,
      resolution: 'fast',
      status,
      startedAt,
      durationMs: Date.now() - started,
      url: this.page.url(),
      detail: { intent, cases: cases.length, submit },
      dataCases: results,
      screenshot: await this.#shoot(status === 'failed' ? 'failure' : 'routine'),
      error:
        failed.length === 0
          ? undefined
          : `${failed.length}/${results.length} value(s) failed: ${failed
              .map((r) => `${r.label} (${JSON.stringify(r.value)})`)
              .join(', ')}`,
    });

    if (failed.length > 0) {
      this.#recordRuntimeDefect(
        'functional',
        'high',
        `Boundary failures on ${selector}`,
        failed.map((r) => `${r.label}: ${r.error ?? 'failed'}`).join('; '),
        selector,
      );
      throw new Error(`fillEach: ${failed.length} of ${results.length} value(s) failed`);
    }
  }

  async #checkDataExpectation(testCase: DataCase): Promise<void> {
    const timeout = this.#fastTimeoutMs;
    if (testCase.expectText) {
      const actual =
        (await this.page.locator(testCase.expectText.selector).first().textContent({ timeout })) ??
        '';
      if (!actual.includes(testCase.expectText.value)) {
        throw new Error(
          `expected ${JSON.stringify(testCase.expectText.value)} in ` +
            `${testCase.expectText.selector}, got ${JSON.stringify(actual.trim().slice(0, 80))}`,
        );
      }
    }
    if (testCase.expectVisible) {
      await this.page
        .locator(testCase.expectVisible)
        .first()
        .waitFor({ state: 'visible', timeout });
    }
    if (testCase.expectHidden) {
      await this.page
        .locator(testCase.expectHidden)
        .first()
        .waitFor({ state: 'hidden', timeout });
    }
  }

  /**
   * Fill a field, submit, and check whether `failureSelector` (a validation
   * or conflict message — "email already exists", "SKU not found") is still
   * visible. If it is, regenerate the value and try again, up to
   * `maxAttempts`. Every kind except `custom` generates deterministically —
   * see `mock-data.ts` — so most calls never spend a token.
   *
   * Like `fillEach`, this does not go through the escalation ladder: the
   * *field* selector is assumed stable, only the *value* is in question.
   */
  async fillRetry(
    selector: string,
    kind: DataKind,
    failureSelector: string,
    options: {
      submit?: string | undefined;
      maxAttempts?: number | undefined;
      description?: string | undefined;
      intent?: string | undefined;
    } = {},
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    const description = options.description ?? options.intent ?? selector;

    const attempts: DataRetryAttempt[] = [];
    let modelId: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let previousValue: string | undefined;
    let observedError: string | undefined;
    let succeeded = false;
    let fatalError: string | undefined;

    for (let attempt = 1; attempt <= maxAttempts && !succeeded && fatalError === undefined; attempt++) {
      let value: string;
      try {
        if (kind === 'custom') {
          if (!this.#dataModel) {
            throw new Error('fillRetry kind "custom" needs a DataModel, but none is configured');
          }
          const generated = await this.#dataModel.generate({ description, observedError, previousValue, attempt });
          value = generated.value;
          modelId = this.#dataModel.id;
          inputTokens += generated.inputTokens ?? 0;
          outputTokens += generated.outputTokens ?? 0;
        } else {
          value = generateValue(kind, attempt);
        }
      } catch (error) {
        fatalError = describe(error);
        break;
      }
      previousValue = value;

      try {
        await this.page.locator(selector).first().fill(value, { timeout: this.#healedTimeoutMs });
        if (options.submit !== undefined) {
          await this.page.locator(options.submit).first().click({ timeout: this.#healedTimeoutMs });
        }
      } catch (error) {
        attempts.push({ attempt, kind, value: this.#maskSuppliedSecret(value), succeeded: false });
        fatalError = describe(error);
        break;
      }

      // Wait up to the fast-path budget for the conflict indicator — the
      // same short-by-design timeout as everywhere else, and for the same
      // reason: if it's going to reappear, it reappears immediately.
      const stillConflicting = await this.page
        .locator(failureSelector)
        .first()
        .waitFor({ state: 'visible', timeout: this.#fastTimeoutMs })
        .then(() => true)
        .catch(() => false);

      succeeded = !stillConflicting;
      attempts.push({ attempt, kind, value: this.#maskSuppliedSecret(value), succeeded });
      observedError = succeeded ? undefined : `"${failureSelector}" still visible after attempt ${attempt}`;
    }

    const dataRetry: DataRetryRecord = {
      kind,
      attempts,
      succeeded,
      model: modelId,
      inputTokens: modelId ? inputTokens : undefined,
      outputTokens: modelId ? outputTokens : undefined,
    };
    const failureMessage = succeeded
      ? undefined
      : (fatalError ?? `still conflicting after ${attempts.length} attempt(s)`);

    this.bundle.addStep({
      action: 'fillRetry',
      intent: options.intent,
      selector,
      resolvedSelector: selector,
      resolution: 'fast',
      status: succeeded ? 'passed' : 'failed',
      startedAt,
      durationMs: Date.now() - started,
      url: this.page.url(),
      detail: { kind, failureSelector, submit: options.submit, maxAttempts, intent: options.intent },
      dataRetry,
      screenshot: await this.#shoot(
        !succeeded ? 'failure' : attempts.length > 1 ? 'notable' : 'routine',
      ),
      error: failureMessage,
    });

    if (succeeded && attempts.length > 1) {
      // A passing step that still tells you something: the first value
      // conflicted, same reasoning as a JIT heal being reported even though
      // the step passed.
      this.#recordRuntimeDefect(
        'functional',
        'low',
        `Data regenerated on conflict: ${selector}`,
        `Needed ${attempts.length} attempt(s) before "${failureSelector}" cleared. If this is a ` +
          'shared test environment, consider whether seed data needs resetting.',
        selector,
      );
    }

    if (!succeeded) {
      this.#recordRuntimeDefect('functional', 'high', `Step failed: fillRetry ${selector}`, failureMessage ?? 'unknown', selector);
      throw new Error(`fillRetry: "${selector}" ${failureMessage}`);
    }
  }

  // --- Visual regression ---------------------------------------------------

  /** Compare the page (or one element) against a stored baseline. */
  async snapshot(name: string, selector?: string): Promise<void> {
    const startedAt = new Date().toISOString();
    const started = Date.now();

    const path = baselinePath(this.#baselineDir, this.bundle.name, name);

    try {
      // PNG, not JPEG: lossy artefacts would register as pixel drift.
      const shot =
        selector === undefined
          ? await this.page.screenshot({ type: 'png', fullPage: false })
          : await this.page
              .locator(selector)
              .first()
              .screenshot({ type: 'png', timeout: this.#healedTimeoutMs });

      const result = await compareSnapshot(shot, path, name, {
        updateBaseline: this.#updateBaselines,
      });
      const failed = isVisualFailure(result);

      this.bundle.addStep({
        action: 'snapshot',
        selector: selector ?? null,
        resolvedSelector: selector ?? null,
        resolution: 'fast',
        status: failed ? 'failed' : 'passed',
        startedAt,
        durationMs: Date.now() - started,
        url: this.page.url(),
        detail: { name, baseline: path },
        snapshot: result,
        error: failed ? result.message : undefined,
        // A snapshot that matched carries no image of its own — the baseline
        // and the render were identical, so there was nothing to show. Without
        // this it would be the one step in the run with no evidence at all.
        screenshot: await this.#shoot(failed ? 'failure' : 'routine'),
      });

      if (failed) {
        this.#recordRuntimeDefect(
          'usability',
          'high',
          `Visual regression: ${name}`,
          result.message,
          selector,
        );
        throw new Error(`snapshot "${name}": ${result.message}`);
      }
    } catch (error) {
      // Only wrap genuine capture failures; a drift failure is already recorded.
      if (error instanceof Error && error.message.startsWith(`snapshot "${name}"`)) throw error;
      this.bundle.addStep({
        action: 'snapshot',
        selector: selector ?? null,
        resolvedSelector: null,
        resolution: null,
        status: 'failed',
        startedAt,
        durationMs: Date.now() - started,
        url: this.page.url(),
        detail: { name },
        error: describe(error),
        screenshot: await this.#shoot('failure'),
      });
      throw error;
    }
  }

  // --- Modals ----------------------------------------------------------------

  /**
   * Assert a dialog/modal is currently open, optionally checking it mentions
   * `name`. Detection is ARIA-based (`role="dialog"`/`"alertdialog"`, or a
   * native `<dialog open>`) — see `modal.ts` for what that does and doesn't
   * catch. Like other presence/absence checks, this does not go through the
   * escalation ladder: there's no selector here to heal.
   */
  async expectModal(name?: string, intent?: string, timeoutMs?: number): Promise<void> {
    const detail: Record<string, unknown> = {
      name,
      intent,
      ...(name === undefined ? {} : { expected: name }),
    };
    const patience = stepPatience(timeoutMs);
    if (patience !== undefined) detail['timeoutMs'] = patience;
    await this.#bareStep('expectModal', detail, async () => {
      const started = Date.now();
      const dialog = await waitForDialog(this.page, patience ?? this.#healedTimeoutMs);
      if (patience !== undefined) detail['waitedMs'] = Date.now() - started;
      if (!dialog) {
        if (name !== undefined) detail['actual'] = '(no dialog or modal visible)';
        throw new Error('no dialog or modal is currently visible');
      }
      if (name) {
        // Label, heading, or anywhere in the text (EH-02): humi's Create
        // Plan modal opens with an eyebrow, so the first 80 characters named
        // the wrong thing and "Confirm delete plan" could not match a dialog
        // whose title was the second line.
        const mention = await dialogMentions(dialog, name);
        const label = await describeDialog(dialog);
        detail['actual'] = mention === null ? label : mention.text;
        if (mention === null) {
          throw new Error(`open dialog ("${label}") does not mention "${name}"`);
        }
        detail['mentionedVia'] = mention.via;
      }
    });
  }

  /**
   * Close whatever dialog/modal is currently open. Pass `button` to target a
   * specific control inside it (a selector, scoped to the dialog); omit it to
   * fall back to `findDismissButton`'s best-effort match on common
   * dismiss/accept text — the same heuristic the automatic blocking-dialog
   * recovery in `#resolve` uses.
   */
  async closeModal(button?: string, intent?: string): Promise<void> {
    await this.#bareStep('closeModal', { button, intent }, async () => {
      const dialog = await waitForDialog(this.page, this.#healedTimeoutMs);
      if (!dialog) throw new Error('no dialog or modal is currently open to close');

      if (button) {
        await dialog.locator(button).first().click({ timeout: this.#healedTimeoutMs });
        return;
      }
      const dismiss = await findDismissButton(dialog);
      if (!dismiss) {
        throw new Error(
          'no dismiss button found in the open dialog — pass an explicit `button` selector',
        );
      }
      await dismiss.locator.click({ timeout: this.#healedTimeoutMs });
    });
  }

  // --- Assertions ----------------------------------------------------------

  /** Assert that the element's text contains `expected`. */
  /**
   * Assert the element's *visible* text contains `expected` — or any entry of
   * `anyOf`, the accepted equivalent renderings of the same content.
   *
   * `anyOf` exists for bilingual applications: a requirement written as
   * "Somchai Sukjai" against a page that renders "สมชาย สุขใจ" is the same
   * claim about the same employee, and failing it is a false fail about
   * language, not the feature (PB-05-01, live). The alternatives are
   * explicit and author-supplied — the engine never invents an equivalence —
   * so a case that *means* to check a specific language simply lists only
   * that language. Which variant matched is recorded on the step, because
   * "passed via the Thai rendering" is evidence, not trivia.
   *
   * Visible text (`innerText`), not `textContent`: against `body` the latter
   * happily reads `<script>` payloads — PB-05-01's "got …" text was mostly
   * Next.js flight data no user has ever seen. An assertion about what the
   * page says must read what the page shows.
   */
  async expectText(
    selector: string,
    expected: string,
    intent?: string,
    anyOf?: readonly string[],
    timeoutMs?: number,
  ): Promise<void> {
    const accepted = [expected, ...(anyOf ?? [])];
    const patience = stepPatience(timeoutMs);
    // Mutated by the callback below, read when the step is recorded — this is
    // how "which rendering satisfied the claim" reaches the bundle.
    const detail: Record<string, unknown> = {
      expected,
      ...(anyOf?.length ? { anyOf: [...anyOf] } : {}),
      ...(patience === undefined ? {} : { timeoutMs: patience }),
    };
    await this.#step(
      'expectText',
      selector,
      intent,
      async (locator, timeout) => {
        // Poll until the text appears or the window closes — the same rule
        // `expectUrl` and `expectScrollable` already follow, for the same
        // reason: a selector like `body` resolves instantly on a page that
        // has not hydrated, so a single read is a race the assertion loses
        // by construction. PB-05-01's detail page renders the name ~3s after
        // the route commits; one read at 2s saw only the app shell.
        const deadline = Date.now() + timeout;
        let actual = '';
        for (;;) {
          try {
            actual = await locator.innerText({ timeout });
          } catch {
            // Non-HTML elements (SVG text, say) have no innerText; fall back
            // rather than failing an assertion the page can satisfy.
            actual = (await locator.textContent({ timeout })) ?? '';
          }
          const matched = accepted.find((candidate) => actual.includes(candidate));
          if (matched !== undefined) {
            if (matched !== expected) detail['matchedRendering'] = matched;
            detail['actual'] = excerptAround(actual, matched);
            return;
          }
          // Verbatim failed. Before spending another poll — and ultimately a
          // judge call and a human's queue slot — concede the two differences
          // that are not the application's doing: rendered case, and a
          // placeholder the sheet author wrote as a stand-in. See
          // `relaxedTextMatch`. Only on the LAST look, so a page still
          // rendering gets every chance to satisfy the strict comparison first
          // and a relaxation is never recorded for text that was merely late.
          if (Date.now() >= deadline) {
            for (const candidate of accepted) {
              const relaxed = relaxedTextMatch(candidate, actual);
              if (relaxed === null) continue;
              if (candidate !== expected) detail['matchedRendering'] = candidate;
              // The page's own words, not the spec's — the whole point of
              // quoting an actual.
              detail['matchedText'] = relaxed.found;
              detail['relaxation'] = relaxed.relaxation;
              detail['actual'] = excerptAround(actual, relaxed.found);
              this.bundle.note(
                `expectText ${selector}: the page reads ${JSON.stringify(relaxed.found)} where the claim ` +
                  `says ${JSON.stringify(candidate)} — accepted as a ${relaxed.relaxation} difference; ` +
                  'confirm the wording if the claim rides on it',
              );
              return;
            }
          }
          if (Date.now() >= deadline) break;
          await this.page.waitForTimeout(Math.min(150, Math.max(1, deadline - Date.now())));
        }
        // First reading wins: the authored selector's own text is the honest
        // "actual". Later rungs read wider elements (kin climbs to the card,
        // a heal may land on a container), and letting the last write win put
        // a whole page of innerText where the report's Actual column should
        // have shown a breadcrumb (be100 PL_02_07, live). The thrown message
        // is capped the same way — each attempt line lands in the bundle and
        // the report verbatim.
        if (detail['actual'] === undefined) detail['actual'] = actual.trim().slice(0, 400);
        const shown = actual.trim();
        throw new Error(
          `expected text to contain ${JSON.stringify(expected)}` +
            (anyOf?.length ? ` (or an accepted rendering: ${anyOf.map((a) => JSON.stringify(a)).join(', ')})` : '') +
            `, got ${JSON.stringify(shown.length > 200 ? `${shown.slice(0, 200)}…` : shown)}` +
            scriptMismatchNote(expected, actual),
        );
      },
      detail,
      patience,
    );
  }

  async expectVisible(selector: string, intent?: string, timeoutMs?: number): Promise<void> {
    const patience = stepPatience(timeoutMs);
    const detail: Record<string, unknown> = {
      expected: 'visible',
      ...(patience === undefined ? {} : { timeoutMs: patience }),
    };
    await this.#step(
      'expectVisible',
      selector,
      intent,
      async (locator, timeout) => {
        try {
          await locator.waitFor({ state: 'visible', timeout });
          detail['actual'] = 'visible';
          // **A "visible" that resolved on nothing the author named proves
          // nothing** (S5 of the 2026-08-28 audit). PL_04_13: three
          // `expectVisible role=combobox >> nth=0` passed on a page with
          // zero comboboxes — the positional fallback resolved SOMETHING
          // and the human had recorded the case Failed. A positional or
          // nameless selector whose element has no accessible name and no
          // text is recorded vacuous; the case is scored needs-review, never
          // green on it.
          if (/>>\s*nth=|^role=[a-z]+\s*$|^role=[a-z]+\s*>>/i.test(selector)) {
            const named = await locator
              .evaluate((el) => {
                // Structural cast, not HTMLElement: tsconfig pins types to
                // ["node"], so DOM lib names do not exist at compile time —
                // the callback runs in the browser, where the shape is real.
                const e = el as unknown as {
                  getAttribute(name: string): string | null;
                  innerText?: string;
                };
                return Boolean(
                  (e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.innerText || '').trim(),
                );
              })
              .catch(() => true);
            if (!named) {
              detail['vacuous'] = 'resolved an element with no accessible name or text — this assertion cannot fail and proves nothing';
              this.bundle.note(
                `vacuous assertion: expectVisible ${selector} resolved an element with no name or text; the claim it serves is unproved — review it`,
              );
            }
          }
        } catch (error) {
          detail['actual'] = 'not visible (hidden or absent)';
          throw error;
        }
      },
      detail,
      patience,
    );
  }

  /**
   * Assert the element is absent or not visible.
   *
   * Runs *outside* the escalation ladder. Healing a selector whose whole point
   * is that it should not resolve would let the healer "repair" it onto some
   * unrelated element and turn a correct pass into a meaningless one.
   *
   * `timeoutMs` (EH-07) is the one dial: a toast that auto-dismisses after
   * five seconds (humi `toast.tsx`, RU_05_02 "Warning หายไปอัตโนมัติ 5-6
   * วินาที") fails the fast window while being exactly what the sheet said.
   */
  async expectHidden(selector: string, intent?: string, timeoutMs?: number): Promise<void> {
    const patience = stepPatience(timeoutMs);
    const detail: Record<string, unknown> = {
      selector,
      intent,
      expected: 'hidden or absent',
      ...(patience === undefined ? {} : { timeoutMs: patience }),
    };
    await this.#bareStep('expectHidden', detail, async () => {
      const started = Date.now();
      try {
        await this.page
          .locator(selector)
          .first()
          .waitFor({ state: 'hidden', timeout: patience ?? this.#fastTimeoutMs });
        detail['actual'] = 'hidden or absent';
        if (patience !== undefined) detail['waitedMs'] = Date.now() - started;
      } catch (error) {
        detail['actual'] = 'still visible';
        if (patience !== undefined) detail['waitedMs'] = Date.now() - started;
        throw error;
      }
    });
  }

  async expectEnabled(selector: string, intent?: string): Promise<void> {
    const detail: Record<string, unknown> = { expected: 'enabled' };
    await this.#step(
      'expectEnabled',
      selector,
      intent,
      async (locator, timeout) => {
        await locator.waitFor({ state: 'attached', timeout });
        const enabled = await locator.isEnabled({ timeout });
        detail['actual'] = enabled ? 'enabled' : 'disabled';
        if (!enabled) {
          throw new Error('expected element to be enabled, but it is disabled');
        }
      },
      detail,
    );
  }

  async expectDisabled(selector: string, intent?: string): Promise<void> {
    const detail: Record<string, unknown> = { expected: 'disabled' };
    await this.#step(
      'expectDisabled',
      selector,
      intent,
      async (locator, timeout) => {
        await locator.waitFor({ state: 'attached', timeout });
        const enabled = await locator.isEnabled({ timeout });
        detail['actual'] = enabled ? 'enabled' : 'disabled';
        if (enabled) {
          throw new Error('expected element to be disabled, but it is enabled');
        }
      },
      detail,
    );
  }

  // --- enhancedX wave-2 steps (2026-09-03) ---------------------------------

  /**
   * Either/or (CG-08): pass when ANY of `selectors` is visible, fail naming
   * every one that was not. The sheets offer alternatives on ~95 rows —
   * "ระบบประมวลผลสำเร็จหรือแสดง error ตามเงื่อนไข ไม่ crash" (PY negatives),
   * "กรณีสร้างสำเร็จ / กรณีปฏิเสธ" — and an author forced to pick one branch
   * failed a correct application on the other.
   *
   * Through the ladder on the FIRST selector — so its free rewrites (case,
   * bare role, reveal, dialog, patience) apply — while every alternative is
   * polled as written in the same window: the ladder's rungs never rewrite
   * the alternatives, and a heal of the first is one heal, not N.
   */
  async expectAnyVisible(selectors: string[], intent?: string, timeoutMs?: number): Promise<void> {
    const list = selectors.map((s) => s.trim()).filter((s) => s !== '');
    if (list.length === 0) throw new Error('expectAnyVisible needs at least one selector');
    const patience = stepPatience(timeoutMs);
    const detail: Record<string, unknown> = {
      expected: 'any visible',
      selectors: [...list],
      ...(patience === undefined ? {} : { timeoutMs: patience }),
    };
    const others = list.slice(1);
    await this.#step(
      'expectAnyVisible',
      list[0]!,
      intent,
      async (locator, timeout) => {
        const deadline = Date.now() + timeout;
        const candidates: { label: string; locator: Locator }[] = [
          { label: list[0]!, locator: locator.first() },
          ...others.map((s) => ({ label: s, locator: this.page.locator(s).first() })),
        ];
        for (;;) {
          for (const candidate of candidates) {
            if (await candidate.locator.isVisible().catch(() => false)) {
              detail['actual'] = `visible: ${candidate.label}`;
              detail['matched'] = candidate.label;
              return;
            }
          }
          if (Date.now() >= deadline) break;
          await this.page.waitForTimeout(Math.min(150, Math.max(1, deadline - Date.now())));
        }
        detail['actual'] = 'none visible';
        throw new Error(
          `none of ${list.length} visible: ${list.map((s) => JSON.stringify(s)).join(', ')} — ` +
            'the request accepts either outcome, and the page shows neither',
        );
      },
      detail,
      patience,
    );
  }

  /**
   * The validation message shown FOR a named field (EH-12): the control's
   * `aria-errormessage` / `aria-describedby`, else its FormField container
   * (`engine/field-error.ts`). A message under the WRONG field passes an
   * unscoped `expectText body`; the sheets say "ระบบแสดง Error message '…'
   * ด้านล่าง Field X" on ~110 rows (PL_06_05/10/15, TC_SSO_009/011,
   * HIR-EC-049/055/059…) and mean exactly the field. With `value` the
   * wording is compared like `expectText` (verbatim, then case, then the
   * sheet's own normalisation); without it any non-empty message passes.
   */
  async expectFieldError(selector: string, value?: string, intent?: string): Promise<void> {
    const detail: Record<string, unknown> = {
      ...(value === undefined ? { expected: 'a validation message under the field' } : { expected: value }),
    };
    await this.#step(
      'expectFieldError',
      selector,
      intent,
      async (locator, timeout) => {
        await locator.first().waitFor({ state: 'attached', timeout });
        // Poll through the window: validation renders after the submit that
        // triggered it, and one read at resolve time is a race.
        const deadline = Date.now() + timeout;
        let read = await readFieldError(this.page, locator, { timeout });
        while (read === null && Date.now() < deadline) {
          await this.page.waitForTimeout(Math.min(150, Math.max(1, deadline - Date.now())));
          read = await readFieldError(this.page, locator, { timeout });
        }
        if (read === null) {
          detail['actual'] = '(no validation message under this field)';
          throw new Error(
            value === undefined
              ? 'expected a validation message under the field, but none is shown'
              : `no validation message is shown for this field (expected ${JSON.stringify(value)})`,
          );
        }
        detail['actual'] = read.text;
        detail['via'] = read.via;
        detail['invalid'] = read.invalid;
        if (value === undefined) return;
        if (read.text.includes(value)) return;
        const relaxed = relaxedTextMatch(value, read.text);
        if (relaxed !== null) {
          detail['relaxation'] = relaxed.relaxation;
          detail['matchedText'] = relaxed.found;
          this.bundle.note(
            `expectFieldError ${selector}: the field says ${JSON.stringify(read.text)} where the claim says ` +
              `${JSON.stringify(value)} — accepted as a ${relaxed.relaxation} difference; confirm the wording if the claim rides on it`,
          );
          return;
        }
        detail['foundInPageText'] = true;
        throw new Error(`expected text to contain ${JSON.stringify(value)}, got ${JSON.stringify(read.text)}`);
      },
      detail,
    );
  }

  /**
   * Attach `files` through the control `selector` names (EH-08): the
   * `input[type=file]` itself, a dropzone hiding one, a `<label for>` or
   * `aria-controls` pointing at one, or a button that opens the native
   * chooser — `engine/upload.ts`. Paths resolve against the flow's own
   * directory; a fixture that is not on disk is a harness fault
   * (`FixtureMissingError` → `error`, never a defect against the app).
   * Bulk Import CSV (PL_10_07..57, RU_09_07..57), consent PDFs (CNS-EC-003…),
   * medical certificates (ML_01_05/06) — ~110 rows had no step for this.
   */
  async upload(selector: string, files: string[], intent?: string): Promise<void> {
    const detail: Record<string, unknown> = { files: [...files] };
    await this.#step(
      'upload',
      selector,
      intent,
      async (locator, timeout) => {
        // **A fixture SPEC is minted here, not looked up on disk.**
        // `pdf:personal-information` is the vocabulary `src/data/fixtures.ts`
        // owns — a file the harness writes, for a form that demands an
        // attachment the sheet never named. `writeFixture` had no caller in
        // `src/` at all, so every such upload reached `attachFiles` as a
        // literal PATH and died `fixture file not found: …/pdf:HIR-EC-001-
        // attachment`. Live (run 15) that was the first errored step and the
        // whole case's verdict: `error`, not a defect, over a file the
        // harness was supposed to write itself.
        const resolved = await this.#resolveFixtures(files, detail);
        const result = await attachFiles(this.page, locator, resolved, {
          timeout,
          ...(this.#flowDir === undefined ? {} : { baseDir: this.#flowDir }),
        });
        detail['via'] = result.via;
        detail['attached'] = result.files.map((f) => ({ name: f.name, bytes: f.bytes }));
      },
      detail,
    );
  }

  /**
   * Every file an `upload` names, as a path on disk: a fixture spec is built
   * and written under the run's own key; anything else is left exactly as the
   * flow wrote it, for `attachFiles` to resolve against the flow directory.
   *
   * Minting is recorded on the step (`detail.minted`) because a file the
   * harness invented is a stand-in a reader must weigh — the same rule as a
   * generated VALUE.
   */
  async #resolveFixtures(files: readonly string[], detail: Record<string, unknown>): Promise<string[]> {
    const minted: { spec: string; path: string; description: string }[] = [];
    const out: string[] = [];
    for (const file of files) {
      const spec = file.trim();
      if (!isFixtureSpec(spec)) {
        out.push(file);
        continue;
      }
      try {
        const written = await writeFixture(spec, { runKey: this.bundle.runId });
        // ABSOLUTE, always. `writeFixture` returns a path under the fixture
        // root as written — relative to the process's cwd — and `attachFiles`
        // resolves a relative path against the FLOW's directory, which is
        // somewhere else entirely. Live (run 17): the file was minted and the
        // step still died `fixture file not found`, one directory tree away
        // from the file that existed.
        const path = resolve(written.path);
        minted.push({ spec, path, description: written.description });
        out.push(path);
      } catch (error) {
        // `isFixtureSpec` tests the SHAPE and `buildFixture` validates the
        // parts — an unknown mutation passes the first and throws the second.
        // Keep the string: `attachFiles` then says "fixture file not found",
        // which is the honest message, rather than an unhandled throw that
        // reads as a browser fault.
        detail['fixtureError'] = `${spec}: ${error instanceof Error ? error.message : String(error)}`;
        out.push(file);
      }
    }
    if (minted.length > 0) detail['minted'] = minted;
    return out;
  }

  /**
   * Click `selector` and capture the download it starts (EH-08), saving it
   * under the run's download directory and putting the saved path into the
   * variable store as `{{as}}` so a later step can name it. Playwright never
   * saves a download unless the event is armed first, so an unarmed click
   * simply loses the file — "Download Sample CSV" (PL_10_06/23, RU_09_06/23,
   * PL_11_01..12) was unprovable. Capture only; what the file holds is the
   * data plane's to check.
   */
  async download(selector: string, as: string, intent?: string): Promise<void> {
    const detail: Record<string, unknown> = { as };
    await this.#step(
      'download',
      selector,
      intent,
      async (locator, timeout) => {
        await mkdir(this.#downloadDir, { recursive: true });
        const captured = await captureDownload(this.page, () => locator.first().click({ timeout }), {
          dir: this.#downloadDir,
          timeout: this.#healedTimeoutMs,
        });
        detail['download'] = { filename: captured.filename, bytes: captured.bytes, path: captured.path, url: captured.url };
        this.variables.set(as, captured.path);
      },
      detail,
    );
  }

  /**
   * Sign in as the persona `as` names (EH-10): a label from
   * `SmartRunnerOptions.personas` (`HR_ADMIN_ACCOUNT`, `<MANAGER_ACCOUNT>`,
   * `manager`…) or a literal email that matches one. When a session is live
   * the application's own sign-out path is travelled first (`performSignOut`,
   * the same control a user clicks); then the sign-in page — `url`, else the
   * one this flow's own gotos named, else `/login` on the current origin —
   * and the deterministic two-step sign-in every other caller uses. A
   * `#bareStep`: nothing here is a selector to heal. The password is masked
   * like every `--as` value; the email is the evidence of who signed in.
   *
   * ~125 rows hand off between people mid-case (PRB-EC-001..088
   * manager→HRBP→HR admin, ML_01_* employee→manager, consent admin/employee)
   * and used to author the second login by hand — the shape PB-02-01 got
   * wrong three times in one flow.
   */
  async signIn(as: string, url?: string, intent?: string): Promise<void> {
    const detail: Record<string, unknown> = { as, intent, urlBefore: this.page.url() };
    await this.#bareStep('signIn', detail, async () => {
      const persona = resolvePersona(as, this.#personas);
      if (persona === null) {
        throw new PersonaUnknownError(
          `signIn as ${JSON.stringify(as)}: no persona by that label — ` +
            (Object.keys(this.#personas).length === 0
              ? 'no personas were supplied to this run (WOWLIDATOR_PERSONAS / RunFlowOptions.personas)'
              : `the labels available are ${Object.keys(this.#personas).map((k) => JSON.stringify(k)).join(', ')}`),
        );
      }
      detail['persona'] = persona.label;
      detail['signedInAs'] = persona.email;

      // **One Chrome per person (2026-09-03).** Three shapes, in order:
      //
      // 1. This persona already has a session — switch to it. Nobody is
      //    signed out; the employee returning after the manager's approval
      //    finds their own page exactly as they left it. Only when the app
      //    has since expired that session (the page sits on a sign-in URL)
      //    does the login below run again, on that same browser.
      // 2. A first `signIn` on a session nobody has claimed binds to it —
      //    the primary, which `signsInItself` already started with an empty
      //    jar. No second browser for the first person.
      // 3. A new persona with a spare Chrome in `personaBrowsers` gets its
      //    own: a context there, seeded from the suite's vault under that
      //    account, and the login on it. Absent a spare, the single-browser
      //    path below: sign the active session out the way a user does,
      //    then in — today's behaviour, byte for byte.
      const existing = this.#sessionOf(persona.label);
      if (existing !== undefined) {
        await this.#activate(existing);
        detail['switchedTo'] = existing.cdpUrl;
        detail['browser'] = existing.cdpUrl;
        if (!looksLikeSignIn(this.page.url())) {
          detail['keptSession'] = true;
          this.#lastAction = 'signIn';
          detail['urlAfter'] = this.page.url();
          return;
        }
        detail['sessionExpired'] = true;
      } else if (this.#active.label === null && this.#active.signedInAs === null) {
        this.#active.label = persona.label;
        this.bundle.setActor({ persona: persona.label, browser: this.#active.cdpUrl });
        detail['browser'] = this.#active.cdpUrl;
      } else if (this.#personaBrowsers.length > 0) {
        const cdpUrl = this.#personaBrowsers.shift()!;
        const banked = this.#sessionStates[persona.email.toLowerCase()];
        const session = await this.#openPersonaSession(persona.label, cdpUrl, banked);
        detail['browser'] = cdpUrl;
        detail['openedBrowser'] = cdpUrl;
        if (banked !== undefined) {
          // The vault may already land this person signed in: one goto to
          // the app tells. Off the sign-in page afterwards means no form.
          const target = this.#signInTarget(url, String(detail['urlBefore'] ?? ''));
          await session.page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
          if (!looksLikeSignIn(session.page.url()) && hasStorableOrigin(session.page.url())) {
            detail['inheritedSession'] = true;
            try {
              this.#lastGotoPath = new URL(session.page.url()).pathname;
            } catch {
              this.#lastGotoPath = null;
            }
            this.#lastAction = 'signIn';
            this.#lastSignedInAs = persona.email;
            detail['urlAfter'] = session.page.url();
            return;
          }
        }
      }

      // End the live session the way a user does. A sign-in form is hidden
      // from a signed-in user, so this is not optional; the fallback wipe is
      // disclosed, exactly as the `signOut` step discloses it.
      if (!looksLikeSignIn(this.page.url()) && hasStorableOrigin(this.page.url())) {
        const out = await performSignOut(this.page);
        if (out.ok) {
          detail['signedOutVia'] = out.via;
        } else {
          await this.page.context().clearCookies();
          await this.page
            .evaluate(() => {
              const g = globalThis as unknown as BrowserGlobals;
              g.localStorage.clear();
              g.sessionStorage.clear();
            })
            .catch(() => undefined);
          detail['signedOutVia'] =
            `fallback — ${out.reason}; cleared cookies and storage instead, so the application's own sign-out path was NOT exercised`;
        }
      }

      const target = this.#signInTarget(url, String(detail['urlBefore'] ?? ''));
      detail['signInUrl'] = target;
      // Learned for the personas after this one: a hand-off names no URL
      // and its fresh page has no origin to resolve `/login` against.
      this.#signInUrl ??= target;
      if (!looksLikeSignIn(this.page.url()) || url !== undefined) {
        await this.page.goto(target, { waitUntil: 'domcontentloaded' });
      }
      this.#lastGotoAskedSignIn = true;
      const outcome = await performSignIn(this.page, { email: persona.email, password: persona.password });
      if (!outcome.ok) {
        detail['urlAfter'] = this.page.url();
        throw new Error(`signIn as ${persona.label} (${persona.email}) did not take — ${outcome.reason}`);
      }
      const consentSettled =
        this.#consentPolicy === 'accept'
          ? ((await acceptConsentGate(this.page)) ? 'accepted' : null)
          : ((await consentGateShowing(this.page)) !== null ? 'preserved' : null);
      if (consentSettled === 'accepted') detail['consentAccepted'] = true;
      if (consentSettled === 'preserved') detail['consentPreserved'] = true;
      // The run now means to be where the sign-in landed it: the session
      // guard reads the last goto, and this step was that navigation.
      try {
        this.#lastGotoPath = new URL(this.page.url()).pathname;
      } catch {
        this.#lastGotoPath = null;
      }
      this.#lastGotoAskedSignIn = false;
      this.#lastAction = 'signIn';
      this.#lastSignedInAs = persona.email;
      // The session is this person's now — on the single-browser path the
      // primary changes hands, and the record follows.
      this.#active.label = persona.label;
      this.bundle.setActor({ persona: persona.label, browser: this.#active.cdpUrl });
      detail['urlAfter'] = this.page.url();
    });
  }

  /**
   * Where a `signIn` goes: the step's own `url`, else the sign-in page this
   * run has already learned, else `/login` on the current origin — or, when
   * the current page has none (a persona's fresh page sits on `about:blank`),
   * on the origin the run was on before the switch.
   */
  #signInTarget(url: string | undefined, urlBefore: string): string {
    if (url !== undefined) return url;
    if (this.#signInUrl !== null) return this.#signInUrl;
    const base = hasStorableOrigin(this.page.url()) ? this.page.url() : urlBefore;
    try {
      return new URL('/login', base).toString();
    } catch {
      throw new Error('signIn: no sign-in page to open — name one with `url`, or goto the application first');
    }
  }

  /**
   * Every session's state, by the account it ended as — for the suite's
   * vault, so the manager's session banks under the manager and the
   * employee's under the employee. Sessions nobody signed in on are skipped.
   * Read BEFORE `close()`, which takes the contexts away.
   */
  async exportSessions(): Promise<{ email: string; url: string; state: StoredSession }[]> {
    const out: { email: string; url: string; state: StoredSession }[] = [];
    for (const session of this.#sessions) {
      if (session.signedInAs === null) continue;
      try {
        out.push({ email: session.signedInAs, url: session.page.url(), state: await session.context.storageState() });
      } catch {
        // A context already gone banks nothing.
      }
    }
    return out;
  }

  /** The account the last `signIn` step established, for the suite's vault; null when none ran. */
  get lastSignedInAs(): string | null {
    return this.#lastSignedInAs;
  }

  /** Assert how many elements the selector matches. Zero bypasses the ladder. */
  async expectCount(selector: string, expected: number, intent?: string, timeoutMs?: number): Promise<void> {
    const patience = stepPatience(timeoutMs);
    if (expected === 0) {
      // Same reasoning as expectHidden: absence must not be "repaired". A
      // declared patience is the window the count may take to reach zero
      // (a list emptying after a delete) — polled, since a single read at
      // t=0 answers a question nobody asked.
      const zeroDetail: Record<string, unknown> = {
        selector,
        expected,
        intent,
        ...(patience === undefined ? {} : { timeoutMs: patience }),
      };
      await this.#bareStep('expectCount', zeroDetail, async () => {
        const deadline = Date.now() + (patience ?? 0);
        let actual = await this.page.locator(selector).count();
        while (actual !== 0 && Date.now() < deadline) {
          await this.page.waitForTimeout(Math.min(150, Math.max(1, deadline - Date.now())));
          actual = await this.page.locator(selector).count();
        }
        zeroDetail['actual'] = actual;
        if (actual !== 0) {
          throw new Error(`expected 0 matches, found ${actual}`);
        }
      });
      return;
    }

    const detail: Record<string, unknown> = {
      expected,
      ...(patience === undefined ? {} : { timeoutMs: patience }),
    };
    await this.#step(
      'expectCount',
      selector,
      intent,
      async (locator, timeout) => {
        await locator.first().waitFor({ state: 'attached', timeout });
        const actual = await locator.count();
        detail['actual'] = actual;
        if (actual !== expected) {
          throw new Error(`expected ${expected} matches, found ${actual}`);
        }
      },
      detail,
      patience,
    );
  }

  /**
   * Read how many elements match, into the variable store — the first half
   * of a reconciliation claim ("the tile matches the table", "no change
   * after Insert"). Goes through the ladder like any selector, and waits
   * for at least one match: a save that silently recorded 0 off a bogus
   * selector would make the later compare a fight between two mistakes.
   * A legitimately-empty result is saved via `saveText` of the readout
   * ("0 of 0") instead — the page's own words for emptiness.
   */
  async saveCount(selector: string, as: string, intent?: string): Promise<void> {
    const detail: Record<string, unknown> = { as };
    await this.#step(
      'saveCount',
      selector,
      intent,
      async (locator, timeout) => {
        await locator.first().waitFor({ state: 'attached', timeout });
        const count = await locator.count();
        detail['saved'] = count;
        this.variables.set(as, String(count));
      },
      detail,
    );
  }

  /** Read an element's visible text into the variable store — see `saveCount`. */
  async saveText(selector: string, as: string, intent?: string): Promise<void> {
    const detail: Record<string, unknown> = { as };
    await this.#step(
      'saveText',
      selector,
      intent,
      async (locator, timeout) => {
        const first = locator.first();
        await first.waitFor({ state: 'visible', timeout });
        const text = ((await first.innerText()) ?? '').trim();
        detail['saved'] = text.slice(0, 200);
        this.variables.set(as, text);
      },
      detail,
    );
  }

  /** Assert the current URL contains `expected`. No selector, so no healing. */
  async expectUrl(expected: string, intent?: string): Promise<void> {
    const detail: Record<string, unknown> = { expected, intent };
    await this.#bareStep('expectUrl', detail, async () => {
      // Wait, don't peek. A client-side navigation is in flight when this step
      // begins — `click` returns as soon as the click lands, not when the
      // router has finished — so reading `page.url()` synchronously races it
      // and loses every time. That made `click` → `expectUrl`, the most
      // ordinary pair in any suite, fail against every SPA ever written, in
      // under a millisecond, with an error naming the *old* URL.
      //
      // The *healed* budget, not the fast one, and the distinction is the
      // point: the fast-path argument — "a selector that is going to work
      // works immediately" — is about finding an element on a page that has
      // already loaded. This is waiting for a page to arrive. A route that
      // takes four seconds on a cold browser is slow, not broken, and failing
      // it teaches nobody anything. Found on a freshly-started Chrome, where
      // the same navigation that took 18ms warm took over two seconds cold.
      try {
        await this.page.waitForURL((url) => url.toString().includes(expected), {
          timeout: this.#healedTimeoutMs,
        });
        detail['actual'] = this.page.url();
      } catch {
        // Report what the URL actually is now, not what the timeout said —
        // "expected X, got Y" is the whole diagnostic value of this step.
        detail['actual'] = this.page.url();
        throw new Error(
          `expected url to contain ${JSON.stringify(expected)}, got ${JSON.stringify(this.page.url())} — ` +
            'note: if the page shown IS the correct destination, the expectation was derived ' +
            "from a label rather than from where the control points; take expected URLs from " +
            "the tree's url= attributes, never from a control's name",
        );
      }
    });
  }

  /**
   * Evaluate a `when` condition and record the choice as a step.
   *
   * A *probe*, not an assertion, and the difference is the whole point:
   *
   * - **It never heals.** Healing asks "which element did the author really
   *   mean?", which is a question about a selector that ought to resolve. Here
   *   not resolving is a legitimate answer — often the answer the flow is
   *   asking for ("is the role switcher already showing HRBP?"). A repair
   *   would turn "no" into "yes, some other element", silently taking the
   *   wrong branch. Same reasoning that keeps `expectHidden` off the ladder.
   * - **It never fails the flow.** An unresolvable selector means the
   *   condition is false, and the `else` branch (or nothing) runs.
   *
   * The step is recorded either way, with the branch it took, so a report
   * shows *why* the following steps are the ones that ran.
   */
  async evaluateWhen(
    condition: { visible?: string; hidden?: string; enabled?: string; disabled?: string },
    intent?: string,
  ): Promise<boolean> {
    const entries = (['visible', 'hidden', 'enabled', 'disabled'] as const)
      .map((key) => [key, condition[key]] as const)
      .filter((pair): pair is readonly [typeof pair[0], string] => typeof pair[1] === 'string');

    if (entries.length !== 1) {
      throw new Error(
        `a "when" step needs exactly one of visible/hidden/enabled/disabled, got ${entries.length}`,
      );
    }
    const [kind, selector] = entries[0]!;

    let matched = false;
    await this.#bareStep('when', { selector, condition: kind, intent }, async () => {
      const locator = this.page.locator(selector).first();
      try {
        switch (kind) {
          case 'visible':
            await locator.waitFor({ state: 'visible', timeout: this.#fastTimeoutMs });
            matched = true;
            break;
          case 'hidden':
            await locator.waitFor({ state: 'hidden', timeout: this.#fastTimeoutMs });
            matched = true;
            break;
          case 'enabled':
            await locator.waitFor({ state: 'attached', timeout: this.#fastTimeoutMs });
            matched = await locator.isEnabled();
            break;
          case 'disabled':
            await locator.waitFor({ state: 'attached', timeout: this.#fastTimeoutMs });
            matched = !(await locator.isEnabled());
            break;
        }
      } catch {
        // Absent, or never settled inside the fast-path budget. Either way the
        // honest reading is "the condition does not hold right now".
        matched = false;
      }
    });

    this.bundle.noteBranch(matched);
    return matched;
  }

  /** Assert an input's current value. */
  async expectValue(selector: string, expected: string, intent?: string): Promise<void> {
    const detail: Record<string, unknown> = { expected };
    await this.#step(
      'expectValue',
      selector,
      intent,
      async (locator, timeout) => {
        // `inputValue` throws on a button-based combobox (humi's custom
        // select shows its choice as the trigger's text) — read what the
        // control holds the way the entry rung does, then compare.
        let actual: string;
        try {
          actual = await locator.inputValue({ timeout });
        } catch (error) {
          const held = await this.#readEntered(selector);
          if (held === null) throw error;
          actual = held;
          detail['readVia'] = 'text';
        }
        detail['actual'] = actual;
        if (actual === expected) return;
        // Trimmed, then the sheet's own normalisation (EH-05) — the LAST
        // look, recorded, so "A - Permanent" held as "A — Permanent" is a
        // pass that names the spelling rather than a defect.
        if (actual.trim() === expected.trim()) {
          detail['relaxation'] = 'case';
          return;
        }
        if (foldedMatch(expected, actual) !== null) {
          detail['relaxation'] = 'normalised';
          this.bundle.note(
            `expectValue ${selector}: the control holds ${JSON.stringify(actual)} where the claim says ` +
              `${JSON.stringify(expected)} — accepted as a normalised difference; confirm the spelling if the claim rides on it`,
          );
          return;
        }
        throw new Error(
          `expected value ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        );
      },
      detail,
    );
  }

  /** Assert an attribute equals `expected`. */
  async expectAttribute(
    selector: string,
    name: string,
    expected: string,
    intent?: string,
  ): Promise<void> {
    const detail: Record<string, unknown> = { attribute: name, expected };
    await this.#step(
      'expectAttribute',
      selector,
      intent,
      async (locator, timeout) => {
        await locator.waitFor({ state: 'attached', timeout });
        const actual = await locator.getAttribute(name);
        detail['actual'] = actual ?? '(attribute absent)';
        if (actual !== expected) {
          throw new Error(
            `expected @${name} to be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
          );
        }
      },
      detail,
    );
  }

  // --- API actions ---------------------------------------------------------
  //
  // Delegated to `ApiActions`, which owns them so that a browser-free flow can
  // run exactly the same code without a page. See `src/api/api-actions.ts`.

  /** Make an HTTP call as part of the flow. A non-2xx does not fail the step. */
  async request(spec: FlowRequestSpec): Promise<void> {
    await this.#api.request(spec);
  }

  /** Assert the last response's status. Accepts one status or a set of them. */
  async expectStatus(expected: number | readonly number[], intent?: string): Promise<void> {
    await this.#api.expectStatus(expected, intent);
  }

  /** Assert something about the last response's JSON body. */
  async expectJson(
    path: string,
    options: { value?: string | undefined; intent?: string | undefined } = {},
  ): Promise<void> {
    await this.#api.expectJson(path, options);
  }

  /** Assert a response header. Names are compared case-insensitively. */
  async expectHeader(name: string, value: string, intent?: string): Promise<void> {
    await this.#api.expectHeader(name, value, intent);
  }

  // --- Database verification (delegated; see `src/db/db-actions.ts`) -------

  async dbSnapshot(spec: FlowDbSnapshotSpec): Promise<void> {
    await this.#db.dbSnapshot(spec);
  }

  async expectDbRow(spec: FlowDbRowSpec): Promise<void> {
    await this.#db.expectDbRow(spec);
  }

  /**
   * The agent's read-only database access, offered only when a database is
   * actually configured — an absent probe makes `dbCount` fail with advice
   * instead of a connection error, and never dangles a capability the run
   * cannot honour. Spread into `RunOptions` at the `agent.run` call sites.
   */
  #agentDbProbe(): { dbProbe: AgentDbProbe } | null {
    // `--no-backend` withdraws the probe too, not only the flow's own DB
    // steps. Seen live (PL_03_02, 2026-08-27): a run declared backend-off,
    // and the agent still settled a UI-reading goal with three `dbCount`
    // calls — a pass whose evidence the run's own limits said not to touch.
    if (!this.#backend) return null;
    if (!this.#db.configured) return null;
    return { dbProbe: (table, where) => this.#db.probeCount(table, where) };
  }

  async expectDbDelta(spec: FlowDbDeltaSpec): Promise<void> {
    await this.#db.expectDbDelta(spec);
  }

  async expectDbUnchanged(spec: FlowDbUnchangedSpec): Promise<void> {
    await this.#db.expectDbUnchanged(spec);
  }

  async expectDbCalled(spec: FlowDbCalledSpec): Promise<void> {
    await this.#db.expectDbCalled(spec);
  }

  /**
   * Assert the traffic the page made — the sequence lane of a journey.
   *
   * Ordered-subsequence over the observer's window (see `expect-calls.ts` for
   * the matching semantics), polling through the healed budget because the
   * XHR a click fired is usually still in flight when the assertion starts —
   * the same reasoning that makes `expectUrl` wait rather than peek.
   *
   * Never on the escalation ladder: there is no selector, and "healing" a
   * traffic claim could only repair it onto different traffic. And two of its
   * outcomes are harness facts, not page facts: no observer, and a window the
   * ring buffer truncated — both classify as `error`/environment, file no app
   * defect, and say what dial to turn.
   */
  async expectCalls(spec: FlowExpectCallsSpec): Promise<void> {
    const expected: ExpectedCall[] = this.variables.interpolateDeep([...(spec.calls ?? [])]);
    const never: ExpectedCall[] = this.variables.interpolateDeep([...(spec.never ?? [])]);
    const detail: Record<string, unknown> = {
      ...(spec.intent !== undefined ? { intent: spec.intent } : {}),
      window: spec.since ?? 'mark',
    };

    await this.#bareStep('expectCalls', detail, async () => {
      if (expected.length === 0 && never.length === 0) {
        throw new Error(
          'expectCalls needs at least one entry in `calls` or `never` — an empty check would ' +
            'pass while proving nothing',
        );
      }
      const observer = this.#network;
      if (!observer) {
        throw new ObservationUnavailableError(
          'the page traffic observer is not attached (network observation off, or the browser ' +
            'refused a second CDP session) — this says nothing about the application',
        );
      }

      const windowStart = spec.since === 'run' ? 0 : this.#sequenceMark;
      // The window is truncated when eviction has eaten into it: drops
      // happened AND the oldest retained record starts after the window does.
      const truncated = (): boolean => {
        if (observer.dropped === 0) return false;
        const oldest = observer.all()[0];
        return oldest === undefined || oldest.startedAt > windowStart;
      };
      const truncatedError = (claim: string): ObservationTruncatedError =>
        new ObservationTruncatedError(
          `the observer dropped ${observer.dropped} call(s) and the assertion window reaches ` +
            `past the oldest retained record, so ${claim} cannot be proven — a truncated ` +
            'capture reads exactly like a quiet page. Raise networkMaxCalls, or assert earlier ' +
            'in the journey.',
        );

      const deadline = Date.now() + (spec.timeoutMs ?? this.#healedTimeoutMs);
      for (;;) {
        const observed = observer.since(windowStart);
        detail['observedCalls'] = observed.length;
        detail['dropped'] = observer.dropped;

        // An observed violation is real whatever the buffer dropped.
        const violations = neverViolations(observed, never);
        if (violations.length > 0) {
          const first = violations[0]!;
          detail['violations'] = violations.map(
            ({ expected: entry, call }) =>
              `${describeExpected(entry)} — observed: ${call ? describeCall(call) : ''}`,
          );
          throw new Error(
            `observed a call the flow forbids: ${describeExpected(first.expected)}` +
              (first.call ? ` — ${describeCall(first.call)}` : ''),
          );
        }

        const result = matchExpectedCalls(observed, expected);
        detail['calls'] = matchTable(result);

        if (result.complete) {
          // Presence is proven; absence still needs an intact window.
          if (never.length > 0 && truncated()) throw truncatedError('a "never" claim');
          this.#sequenceMark = observer.mark();
          return;
        }

        if (Date.now() >= deadline) {
          // A missing call over a truncated window may simply have been
          // evicted — failing the step would blame the app for the capture.
          if (truncated()) throw truncatedError('a missing call');
          const missing = result.matches.find((match) => match.call === null)!;
          // The plane hazard, named at the moment it bites: expectCalls can
          // only see traffic the page fires. An endpoint only the test (or a
          // backend service) would call is never observed here however
          // healthy it is — seen live as a high "backend" defect against a
          // seed endpoint nothing on the page calls. The wording must leave
          // the reader with that possibility in hand.
          throw new Error(
            `expected ${describeExpected(missing.expected)} — not observed ` +
              `(${observed.length} call(s) in the window, in order; see the match table). ` +
              `expectCalls watches traffic the page itself makes: if nothing on the page ` +
              `fires this call — because only the test should make it, or a server makes ` +
              `it server-side — author it as a \`request\` step (or drop the claim) rather ` +
              `than reading this as the endpoint being broken.`,
          );
        }
        await sleep(SEQUENCE_POLL_MS);
      }
    });
  }

  /**
   * Record a step that does not participate in the escalation ladder.
   *
   * Used by absence assertions, URL assertions, and state seeding — none of
   * which have a selector the healer could meaningfully repair.
   */
  async #bareStep(
    action: string,
    detail: Record<string, unknown>,
    run: () => Promise<void>,
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const selector = typeof detail['selector'] === 'string' ? detail['selector'] : null;
    const intent = typeof detail['intent'] === 'string' ? detail['intent'] : undefined;
    const netMark = this.#takeNetMark();

    // An HTTP or DB step never touched the page, so a picture of the page is
    // not evidence about it — the request/response pair (or check record)
    // already recorded is, and a screenshot here would only assert that
    // something changed when nothing did. Evidence proportionate to what the
    // step actually exercised.
    const touchesPage = !BROWSER_FREE_ACTIONS.has(action);

    try {
      await run();
      this.bundle.addStep({
        action,
        intent,
        selector,
        resolvedSelector: selector,
        // 'fast' means "free path", which is exactly what this was — except
        // for an HTTP step, which never touched the page at all. Counting
        // those as fast-path resolutions inflates a frontend number with
        // backend work and blurs the split the summary is there to make.
        resolution: touchesPage ? 'fast' : null,
        status: 'passed',
        startedAt,
        durationMs: Date.now() - started,
        url: this.page.url(),
        detail,
        screenshot: touchesPage ? await this.#shoot('routine') : undefined,
      });
      await this.#probeDbBaseline(action);
    } catch (error) {
      const evidence = this.#networkEvidence(netMark);
      this.bundle.addStep({
        action,
        intent,
        selector,
        resolvedSelector: null,
        resolution: null,
        status: 'failed',
        startedAt,
        durationMs: Date.now() - started,
        url: this.page.url(),
        detail,
        error: describe(error),
        network: evidence.calls.length > 0 ? evidence.calls : undefined,
        screenshot: touchesPage ? await this.#shoot('failure') : undefined,
      });
      // A harness-class failure (a persona the run lacks, its Chrome gone)
      // is not a finding about the application — the step fails, the case
      // blocks, no defect is filed against the app.
      if (!(error instanceof Error && HARNESS_STEP_ERRORS.has(error.name))) {
        this.#recordStepFailureDefect(
          action,
          selector ?? undefined,
          describe(error),
          evidence.failures,
          'Assertion',
        );
      }
      throw error;
    }
  }

  /**
   * Hand the browser to the workflow agent until `goal` is reached, then
   * return to the deterministic fast path. Use for multi-page navigations
   * whose interstitials aren't known ahead of time.
   */
  /**
   * What a navigation's status code means, read against the codebase.
   *
   * A 4xx is not one finding but two, and only the repository can tell them
   * apart:
   *
   *   * the path is declared → the application should serve this page and
   *     did not. A real defect, filed as one.
   *   * the path is NOT declared → the TEST asked for a page that does not
   *     exist. Harness-class: it says nothing about the application, and the
   *     nearest declared routes are named so the flow can be corrected.
   *
   * With no repository indexed there is no way to tell, so the run keeps no
   * opinion and the navigation stands as it always did — a 404 page will fail
   * the steps that follow on their own evidence.
   */
  async #judgeNavigationStatus(asked: string, response: PlaywrightResponse | null): Promise<void> {
    const status = response?.status() ?? 0;
    if (status < 400) return;
    // The page may have been rescued since — a consent gate accepted, a
    // session established — and what it is showing NOW is what matters.
    const landed = this.page.url();
    const declared = routeIsDeclared(landed, this.#declaredRoutes, this.#deploymentUrl);
    if (declared === true) {
      this.#recordRuntimeDefect(
        'functional',
        'high',
        `The application did not serve a page it declares: ${asked}`,
        `Navigating to ${asked} was answered ${status}. The application's own codebase declares a ` +
          'route for this path, so this is the application failing to serve a page it has, not the ' +
          'test asking for one that does not exist.',
        undefined,
      );
      return;
    }
    if (declared === null) return; // nothing indexed — no opinion to offer
    const near = nearestRoutes(landed, this.#declaredRoutes);
    throw new RouteNotFoundError(
      `${asked} was answered ${status}, and the application's codebase declares no route for it — ` +
        'the test asked for a page that does not exist, which is test drift rather than a finding ' +
        'about the application.' +
        (near.length === 0
          ? ' No declared route resembles it closely enough to suggest.'
          : ` The nearest routes it does declare: ${near.map((one: { pattern: string }) => one.pattern).join(', ')}.`),
    );
  }

  /**
   * **Layer three of "not even present."** Throw before a backend step runs.
   *
   * `runFlow` already refuses a flow that carries one, so reaching this means
   * a caller drove the runner directly — the MCP server, the repair loop, an
   * embedder. Belt and braces on purpose: the rule is that a run with backend
   * testing off touches no endpoint and no database by ANY route, and a rule
   * enforced in one place is a rule with a hole in it.
   */
  assertBackendAllowed(action: string): void {
    if (this.#backend || !BACKEND_TIER_ACTIONS.has(action)) return;
    throw new BackendDisabledError(
      `"${action}" is a backend step and this run has backend testing turned off. This is a ` +
        'limit the run was given, not a finding about the application — turn backend testing ' +
        'on, or prove the claim through the page.',
    );
  }

  async workflow(goal: string, script?: readonly WorkflowScriptStep[] | undefined): Promise<AgentRecord> {
    const startedAt = new Date().toISOString();
    const started = Date.now();

    if (!this.#agent) {
      const error = new Error(
        `workflow step "${goal}" needs the multi-page agent, but none is configured`,
      );
      this.bundle.addStep({
        action: 'workflow',
        selector: null,
        resolvedSelector: null,
        resolution: null,
        status: 'failed',
        startedAt,
        durationMs: Date.now() - started,
        url: this.page.url(),
        detail: { goal },
        error: error.message,
        screenshot: await this.#shoot('failure'),
      });
      throw error;
    }

    // **What the agent did is recorded as evidence, not only as its own
    // account.** The step carries what the page showed before and after —
    // URL, headings, and every request the page itself made while the agent
    // held it — so a leg nothing asserts on afterwards is still auditable
    // from the report: which page it ended on, what appeared, what the app
    // was asked to do. This is the honest form of "let the agent try and
    // record the screen and API changes as its proof": the agent's claim is
    // still never the verdict (see below), but the changes it caused are on
    // the record for a person to judge, and the film shows the rest.
    const netMark = this.#takeNetMark();
    const urlBefore = this.page.url();
    const headingsBefore = await this.#headingsNow();
    // `saveVariable` (OA-8): the agent's `save` action puts a value the page
    // shows — the Employee ID a hire generated, a Version ID — into the
    // run's variable store, so a later `fill … {{EMPLOYEE_ID}}` can use it.
    // Typed as an extension here so the runner compiles before and after the
    // agent's `RunOptions` grows the field.
    const runOptions: Parameters<WorkflowAgent['run']>[2] & {
      saveVariable?: ((name: string, value: string) => void) | undefined;
    } = {
      memory: cacheAgentMemory(this.#cache),
      caseContext: this.#caseContext,
      humanize: this.#humanize,
      ...this.#agentPersona(),
      ...(script === undefined ? {} : { script }),
      ...(this.#agentDbProbe() ?? {}),
      ...(this.#agentMaxSteps === undefined ? {} : { maxSteps: this.#agentMaxSteps }),
      ...(this.#mutationPolicy === undefined ? {} : { mutationPolicy: this.#mutationPolicy }),
      ...(this.dataGate === null
        ? {}
        : {
            onMutation: (request: Parameters<OnMutation>[0]) =>
              this.dataGate?.lockNow(
                request.url,
                `agent ${request.decisionAction} ${JSON.stringify(request.target ?? request.selector)}`,
              ),
          }),
      saveVariable: (name: string, value: string): void => {
        this.variables.set(name, value);
        this.bundle.note(`workflow: saved {{${name}}} = ${JSON.stringify(value.slice(0, 120))} from the page`);
      },
    };
    const record = await this.#agent.run(this.page, goal, runOptions);
    const urlAfter = this.page.url();
    const headingsAfter = await this.#headingsNow();
    const traffic = this.#networkEvidence(netMark);

    // **What the agent claims is never the evidence.** The ladder's agent rung
    // has always obeyed this structurally — it prepares the page and then the
    // author's own selector is retried — and this action did not: a single
    // `!record.success` read decided the step, so an agent that met its goal
    // and then talked itself out of saying so filed a `high` defect against a
    // working application. See `goal-evidence.ts` for the run this came from.
    //
    // The page is asked first. Only when it has nothing to say does the
    // agent's own account stand.
    // **A held leg is judged by nobody** (Phase B). The agent ended on a
    // policy, provenance or approval hold: the application was never asked,
    // so neither the page's evidence nor the agent's account can settle it.
    // It is recorded as `error` with the typed hold on the step, files no
    // defect, and the case scores blocked — no verdict, not a red one.
    const blocked = !record.success ? (record.blocked ?? null) : null;
    let evidence = record.success || blocked !== null ? null : goalEvidence(goal, urlBefore, urlAfter);
    // **A goal that only asks to LOOK is the assertion's job, and the agent's
    // failure at it is not a fact about the application.** The agent's
    // contract here is prepare-never-perform; a "verify X shows Y" leg asks
    // it to be the oracle, and an agent can only ever produce an account of
    // itself — which this module exists to distrust. Live (be100 PL_03_01,
    // 2026-08-25): five turns hunting a number that was on the page, "agent
    // stalled", the step failed with a `high` defect, and the NEXT step's
    // `expectText "75"` passed against the same page. The leg hands off:
    // whatever the flow asserts afterwards is the proof, and a step that
    // asserts nothing afterwards is caught by `unsettledWorkflowClaim` at
    // authoring time, not invented into a defect here.
    // Two ways to reach the same conclusion: the goal's own WORDING says it
    // asks only to verify (`verificationOnlyGoal`, judged before a turn is
    // spent), or the RUNTIME shows the agent never had anything to act on
    // (`record.lookedOnly` — every action across the whole loop was a look).
    // The second catches what the first cannot: a goal with no verify verb
    // at all, or one the wording classifier reads ambiguously, that still
    // turns out to be a reading question once the page is actually looked
    // at. Live (be100 PL_03_01, 2026-08-26): "add them together, and confirm
    // that the sum equals the Total Plans number" was classed as an ACTION
    // goal on the bare word "add" — arithmetic, not a click — the agent
    // scrolled five times finding nothing to press, and was recorded
    // stalled with a high defect. A stronger model does not fix a goal that
    // was never actionable; only reading the runtime evidence does.
    const deferred = evidence === null && blocked === null && !record.success && verificationOnlyGoal(goal);
    if (deferred) {
      evidence = {
        rule: 'verification-deferred',
        reason:
          'the goal asked only to verify, which is an assertion\'s job and not the agent\'s — ' +
          `the agent's own account (${record.summary}) is not evidence either way, and the ` +
          'checks that follow this step are what settle the claim',
      };
    } else if (evidence === null && blocked === null && !record.success && record.lookedOnly === true) {
      evidence = {
        rule: 'verification-deferred',
        reason:
          'every action the agent took was a look (scroll, wait) — it never had a control on this ' +
          `page the goal could name, which is what a reading question looks like at runtime even ` +
          `when the goal's wording did not say so outright. The agent's account (${record.summary}) ` +
          'is not evidence either way, and the checks that follow this step are what settle the claim',
      };
    }
    // A model that could not answer is not an application that could not
    // comply. Same rule the healer follows for `HealUnavailableError`: a
    // provider fact, not a page fact, and it must never be worded as "the goal
    // is unreachable" or counted against the app.
    const providerFailed = !record.success && evidence === null && agentModelUnavailable(record.summary);
    // A goal naming two people is refused before the first turn — a fact about
    // how the leg was AUTHORED, not about the application. Harness-class for
    // the same reason the provider refusal is: no question was ever put to the
    // page, so there is no answer to file against it.
    const authoringRefused = !record.success && evidence === null && personaRefusal(record.summary);
    const failed = !record.success && evidence === null;
    const safeRecord = redactAgentRecord(record, this.#secretValues);
    // **Three classes of failed leg, by the source of the evidence** (task
    // C3). A leg the PAGE ended — the goal's control enumerated twice and
    // its value on none of the options — is the one shape that records
    // what an assertion records: what was asked, what the page offered.
    const comparison =
      failed && blocked === null && !providerFailed && !authoringRefused && record.endedBy === 'cannot-offer'
        ? agentLegComparison(safeRecord)
        : null;
    const safeEvidence =
      evidence === null
        ? null
        : {
            ...evidence,
            reason:
              record.summary === ''
                ? evidence.reason
                : evidence.reason.replaceAll(record.summary, safeRecord.summary),
          };
    const safeObserved =
      safeRecord.observations !== undefined && safeRecord.observations.length > 0
        ? safeRecord.observations.slice(0, 12)
        : undefined;
    // F4 of docs/consent-gate-recovery-spec.md: a failure reported from a
    // page the flow never asked for names the displacement outright. The
    // measured shape: an interstitial dumped the agent elsewhere, it wandered
    // to the wrong page and honestly reported "the button does not exist" —
    // true of the page it was on, false of the page the step began on. The
    // note is what routes a reader to the gate finding instead of filing
    // "the control is missing" against a page that has it.
    // By PAGE, not by URL (OA-9): humi mirrors the wizard step into
    // `?step=2` on one route, and the note used to call an agent that had
    // correctly clicked Next "displaced" (ec10-3x HIR-EC-002 leg 12). Only a
    // different origin or pathname is displacement; a query or hash change
    // is named neutrally.
    const displaced =
      failed && !providerFailed && !authoringRefused && blocked === null && differentPage(urlBefore, urlAfter)
        ? ` — note: the agent ended on ${urlAfter}, not the page this step began on (${urlBefore}); ` +
          'the control it reported on may exist on the original page'
        : failed && !providerFailed && !authoringRefused && urlAfter !== urlBefore
          ? ` — on the same page, now at ${queryAndHash(urlAfter) || urlAfter}`
          : '';

    // The evidence of an agent leg is the control it was working on — the
    // last one it acted on successfully — outlined and scrolled into view,
    // so the still shows the section the agent reached rather than the top
    // of the page the step began on (asked for 2026-09-02).
    const lastActed = [...(record.actions ?? [])].reverse().find((a) => a.ok && typeof a.selector === 'string' && a.selector !== '');
    const agentTarget = lastActed?.selector ? await this.#target(lastActed.selector) : undefined;
    this.bundle.addStep({
      action: 'workflow',
      selector: null,
      resolvedSelector: null,
      resolution: null,
      // A provider that could not be asked is a harness fact — `error`, the
      // system-error family — never `failed`, which files the subject.
      // Live (be100 PL_02_08/09, 2026-08-28): an open circuit breaker was
      // scored as two red test failures.
      // A held leg is the same family: the harness withheld the action.
      status: failed ? (providerFailed || authoringRefused || blocked !== null ? 'error' : 'failed') : 'passed',
      startedAt,
      durationMs: Date.now() - started,
      url: urlAfter,
      detail: {
        goal: safeRecord.goal,
        turns: record.turns,
        // Phase C telemetry: which tactics the model was sent, and how much
        // of the prompt the provider served from cache.
        ...(record.skills === undefined ? {} : { skills: record.skills }),
        ...(record.cachedInputTokens === undefined || record.cachedInputTokens <= 0 ? {} : { cachedInputTokens: record.cachedInputTokens }),
        ...(safeEvidence === null
          ? {}
          : { settledBy: safeEvidence.rule, evidence: safeEvidence.reason }),
        // A success settled by the agent itself says how (S1): the live
        // tree's line for `observed-state`, or the bare claim — so a reader
        // can tell a proved leg from a trusted one in the report.
        ...(evidence === null && record.success && record.settledBy !== undefined
          ? {
              settledBy: record.settledBy,
              evidence:
                (safeRecord.settledEvidence ?? '') +
                (safeObserved === undefined
                  ? ''
                  : `${safeRecord.settledEvidence ? ' | ' : ''}observed: ${safeObserved
                      .map((o) => `${o.selector} = ${JSON.stringify(o.text.slice(0, 160))}`)
                      .join(' | ')}`),
            }
          : {}),
        ...(safeObserved === undefined ? {} : { observed: safeObserved }),
        // The before/after the agent produced, as data. Headings are what a
        // person reads to know which screen they are on; the diff of them is
        // "what appeared". Capped, like every other evidence list.
        urlBefore,
        urlAfter,
        headingsBefore: headingsBefore.slice(0, 8),
        headingsAfter: headingsAfter.slice(0, 8),
        appeared: headingsAfter.filter((h) => !headingsBefore.includes(h)).slice(0, 8),
        callsMade: traffic.calls.length,
        // The page's own enumeration, as an assertion records it — so
        // `expectedActual()` reads this leg like any `expectText`.
        ...(comparison === null ? {} : { expected: comparison.expected, actual: comparison.actual }),
      },
      agent: safeRecord,
      // The typed hold, lifted onto the step so no reader has to open the
      // agent record to learn that this is not a finding.
      ...(blocked === null ? {} : { blocked }),
      network: traffic.calls.length > 0 ? traffic.calls : undefined,
      target: agentTarget,
      screenshot: await this.#shoot(failed ? 'failure' : 'notable', agentTarget),
      error: failed
        ? blocked === null
          ? `${safeRecord.summary}${displaced}`
          : `workflow blocked (${blocked.reason}, ${blocked.rule}): ${blocked.message}`
        : undefined,
    });

    if (evidence !== null) {
      // Green, and still a finding — the turns were paid for either way, and
      // a leg that keeps costing them is a fact about the FLOW worth a
      // reader's attention. Three shapes read differently: an agent that
      // succeeded and failed to notice; a goal phrased as read-only from the
      // start; and a goal the RUNTIME showed had nothing to act on, which the
      // wording alone could not have told the author in advance.
      const cause: 'under-reported' | 'wording' | 'runtime' = deferred
        ? 'wording'
        : evidence.rule === 'verification-deferred'
          ? 'runtime'
          : 'under-reported';
      this.#recordRuntimeDefect(
        'usability',
        'low',
        cause === 'wording'
          ? `Workflow goal asks the agent to verify, which is an assertion's job: ${safeRecord.goal}`
          : cause === 'runtime'
            ? `Workflow goal had nothing on the page for the agent to act on: ${safeRecord.goal}`
            : `Workflow agent under-reported its own success: ${safeRecord.goal}`,
        cause === 'wording'
          ? `The agent said "${safeRecord.summary}" after ${record.turns} turn(s). ${safeEvidence?.reason ?? ''} ` +
            'A workflow leg prepares the page; it cannot be the oracle, because an agent produces an ' +
            'account of itself and never evidence. Write this leg as the assertion it is ' +
            '(expectText / expectVisible on the value), and keep the agent for the navigation that ' +
            'reaches the page.'
          : cause === 'runtime'
            ? `The agent said "${safeRecord.summary}" after ${record.turns} turn(s). ${safeEvidence?.reason ?? ''} ` +
              'Confirm this leg is reachable (the right page, the content finished loading) — if it ' +
              'is, the goal likely describes reading a value rather than acting, and reads better as ' +
              'the assertion it is; if it is not, the earlier step that was meant to reach it is ' +
              'the one to fix.'
            : `The agent said "${safeRecord.summary}" after ${record.turns} turn(s), but ${safeEvidence?.reason ?? ''}. ` +
              'The step is judged on that evidence rather than on the agent\'s account of itself. ' +
              'The turns were still paid for: narrow the goal, or replace this leg with ordinary steps.',
        undefined,
      );
    }

    if (failed) {
      if (blocked !== null) {
        // No defect, and no application verdict: the harness held the one
        // action that would have touched the application. The error is
        // typed (`MutationBlockedError`) so the step loop files it as
        // `error`, reconstruction does not try to rewrite its way past a
        // policy, and the suite scores the case blocked.
        throw new MutationBlockedError(
          blocked,
          `workflow blocked (${blocked.reason}, ${blocked.rule}): ${blocked.message} ` +
            '(the harness withheld this action on its mutation policy or provenance rules — the application was never asked; no defect was filed against the app)',
        );
      }
      if (providerFailed) {
        // No defect at all. Nothing here is a claim about the application —
        // the agent never reached it.
        throw new Error(
          `workflow agent unavailable: ${safeRecord.summary} ` +
            '(this is a SYSTEM failure — the model, not the application; no defect was filed against the app)',
        );
      }
      if (authoringRefused) {
        // No defect either, and for the stronger reason: the goal was refused
        // before a turn was spent, so the application was never asked
        // anything. The summary already names the fix — one `signIn` per
        // person, one leg each — and the case records blocked rather than
        // failed, which is what stops a badly-worded goal being counted as a
        // broken feature.
        throw new Error(
          `workflow goal refused: ${safeRecord.summary} ` +
            '(this is an AUTHORING fault — the goal names more than one person; no defect was filed against the app)',
        );
      }
      const exhausted = record.maxSteps !== null && record.turns >= record.maxSteps;
      this.#recordRuntimeDefect(
        'functional',
        // Running out of turns is a fact about the budget, not about the
        // feature: the agent may have been one click away. `high` is reserved
        // for a goal the agent actively determined it could not reach.
        exhausted ? 'medium' : 'high',
        `Workflow goal not reached: ${safeRecord.goal}`,
        exhausted
          ? `${safeRecord.summary}${displaced}. The ${record.maxSteps}-turn budget ran out, which is a harness limit rather than ` +
            'an application fact — nothing here says the feature is broken. Narrow the goal, or settle the ' +
            'claim with an assertion after this step.'
          : `${safeRecord.summary}${displaced}`,
        undefined,
      );
      // Classed by the source of the evidence — see `agentLegFailure`: a
      // harness stop stays `error` under a message that names the limit, the
      // page's own enumeration is `failed` with expected/actual, and the
      // model's `fail` stays the untyped `error` it always was.
      throw agentLegFailure(safeRecord);
    }

    return safeRecord;
  }

  // --- Escalation ladder ---------------------------------------------------

  // --- Secret masking ------------------------------------------------------

  /**
   * The step's detail with a credential-shaped `value` masked.
   *
   * Applied at the recording boundary — the point a live value becomes a
   * stored artefact — which is the same rule and the same moment
   * `src/api/redact.ts` applies to an HTTP payload. The run keeps using the
   * real value throughout; only the record is masked.
   *
   * Measured flaw this closes: a real bundle on disk held
   * `{"action":"fill","selector":"input[type=\"password\"]","detail":{"value":"admin2026"}}`,
   * and the HTML report inlines it — a report deliberately built to be
   * emailable. `--as` made it worse by design, since it exists so a person
   * supplies a REAL credential rather than the model inventing one.
   *
   * Evidence first, wording second:
   *   1. a value the person named via `--as` — unconditional, any field;
   *   2. the field's own `type="password"` — a fact about the document;
   *   3. `looksLikeCredentialField` — the fallback for when the DOM cannot
   *      answer, which is most often a step that failed to resolve at all and
   *      whose value was therefore never typed anywhere, yet is still recorded.
   *
   * Never throws and never waits meaningfully: a masking decision must not be
   * able to fail a step, so an unreadable field simply falls through to (3).
   */
  async #maskValue(
    action: string,
    selector: string,
    intent: string | undefined,
    detail: Record<string, unknown> | undefined,
    resolvedSelector: string | null,
  ): Promise<Record<string, unknown> | undefined> {
    if (detail === undefined) return detail;
    const value = detail['value'];
    if (typeof value !== 'string' || value === '') return detail;

    // The DOM read is skipped when the answer cannot change the outcome — a
    // supplied secret is masked regardless, and a non-typing action is never
    // masked by inference.
    const needsDom =
      !this.#secretValues.has(value) && (action === 'fill' || action === 'type');
    const secret = isSecretStepValue({
      action,
      selector,
      intent,
      value,
      fieldIsPassword: needsDom ? await this.#fieldIsPassword(resolvedSelector) : null,
      secretValues: this.#secretValues,
    });
    return secret ? { ...detail, value: maskSecret(value) } : detail;
  }

  /**
   * Is the resolved field an `<input type="password">`?
   *
   * `null` means "could not tell" — gone, detached, not an input, or the read
   * threw — which is deliberately distinct from `false` so the caller can fall
   * back to the wording heuristic rather than treating silence as a denial.
   */
  async #fieldIsPassword(resolvedSelector: string | null): Promise<boolean | null> {
    if (resolvedSelector === null) return null;
    try {
      const type = await this.page
        .locator(resolvedSelector)
        .first()
        .getAttribute('type', { timeout: ATTRIBUTE_READ_TIMEOUT_MS });
      return type === null ? null : type.toLowerCase() === 'password';
    } catch {
      return null;
    }
  }

  /** Mask any `--as` value inside a composite record's own values. */
  #maskSuppliedSecret(value: string): string {
    return this.#secretValues.has(value) ? maskSecret(value) : value;
  }

  /**
   * A whole step with any credential-shaped `value` masked, for the records
   * that store a step verbatim rather than as `detail` — `ReconstructionRecord`
   * serialises `from`/`to` in full, so masking the recorded step's own detail
   * leaves that copy untouched.
   *
   * No DOM read here: this runs after the fact, on a step that may never have
   * resolved, so it is the wording heuristic and the `--as` set — exactly the
   * evidence available at this point.
   */
  maskStepSecrets<T>(step: T): T {
    const candidate = step as { value?: unknown; selector?: unknown; intent?: unknown };
    const value = candidate.value;
    if (typeof value !== 'string' || value === '') return step;
    const secret = isSecretStepValue({
      action: String((step as { action?: unknown }).action ?? ''),
      selector: typeof candidate.selector === 'string' ? candidate.selector : '',
      intent: typeof candidate.intent === 'string' ? candidate.intent : undefined,
      value,
      fieldIsPassword: null,
      secretValues: this.#secretValues,
    });
    return secret ? ({ ...step, value: maskSecret(value) } as T) : step;
  }

  async #step(
    action: string,
    selector: string,
    intent: string | undefined,
    run: (locator: Locator, timeoutMs: number) => Promise<unknown>,
    detail?: Record<string, unknown>,
    /**
     * The step's own declared wait (`timeoutMs`, EH-07), already clamped:
     * the patience rung's window instead of the healed timeout, and — when
     * it expires — a verdict about time, with no healer or agent after it.
     */
    patience?: number | undefined,
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const netMark = this.#takeNetMark();

    try {
      const result = await this.#resolve(
        action,
        selector,
        intent,
        run,
        netMark,
        typeof detail?.['expected'] === 'string' ? (detail['expected'] as string) : undefined,
        // An input step's own value, for the entry rung of last resort.
        ENTRY_ACTIONS.has(action) && typeof detail?.['value'] === 'string'
          ? (detail['value'] as string)
          : undefined,
        patience,
      );
      // A rung's own reading (what a calendar entered as, which option a
      // listbox picked) joins the record here — the ladder has no other
      // channel to the bundle.
      if (result.note !== undefined) detail = { ...(detail ?? {}), ...result.note };
      if (patience !== undefined && (result.resolution === 'late' || result.resolution === 'fast')) {
        detail = { ...(detail ?? {}), waitedMs: Date.now() - started };
      }
      // The element the step just used, read before the shutter so the
      // record and the rectangle describe the same thing.
      const target = await this.#target(result.resolvedSelector);
      this.bundle.addStep({
        action,
        intent,
        selector,
        resolvedSelector: result.resolvedSelector,
        resolution: result.resolution,
        status: 'passed',
        startedAt,
        durationMs: Date.now() - started,
        url: this.page.url(),
        detail: await this.#maskValue(action, selector, intent, detail, result.resolvedSelector),
        heal: result.heal,
        dialog: result.dialog,
        agent:
          result.agent === undefined
            ? undefined
            : redactAgentRecord(result.agent, this.#secretValues),
        decision:
          result.decision === undefined
            ? undefined
            : redactStepDecision(result.decision, this.#secretValues),
        target,
        screenshot: await this.#shoot(
          // A heal, a dismissed dialog or an agent intervention is a passing
          // step that still changed what the test exercised; the rest are
          // ordinary filmstrip frames.
          result.resolution === 'jit' ||
            result.resolution === 'dialog' ||
            result.resolution === 'agent'
            ? 'notable'
            : 'routine',
          target,
        ),
      });

      if (result.heal) {
        // A heal is a passing step that still tells you something drifted.
        this.#recordRuntimeDefect(
          'functional',
          'low',
          `Selector drifted: ${selector}`,
          `Repaired to "${result.heal.to}" (${result.heal.strategy}, confidence ${result.heal.confidence.toFixed(2)}). ` +
            `Update the test to stop paying for this repair.`,
          selector,
        );
      }

      if (result.dialog) {
        // A passing step that still tells you something: the page put up an
        // unexpected dialog in the way. Real users hit the same friction.
        this.#recordRuntimeDefect(
          'usability',
          'medium',
          `Unexpected dialog blocked a step: ${selector}`,
          `"${result.dialog.name}" appeared and was dismissed via its "${result.dialog.button}" ` +
            `control before the step could proceed. If this dialog is expected, assert on it explicitly ` +
            `with expectModal/closeModal instead of relying on automatic recovery.`,
          selector,
        );
      }
    } catch (error) {
      const evidence = this.#networkEvidence(netMark);
      const resolution = error instanceof StepResolutionError ? error : undefined;
      // What the page is saying, read once on the failure path. A denial
      // heading still leads when the ladder found one — it is the harder stop
      // — and a live-region message follows, or leads when there is no denial.
      const pageContext = [...(resolution?.pageContext ?? []), ...(await this.#pageMessages())];
      // **An exact-match miss over text the page HOLDS is a wording question,
      // not an absence.** `text="X"` and `role=…[name="X"]` demand a whole
      // element whose text/name IS X; a page rendering X inside a longer
      // sentence fails them at any timeout while a reader sees the text
      // plainly on screen (be100 PL_06_10: `text="Plan ID already exists"`
      // dead-ended against a toast holding exactly that sentence, 40s and a
      // healer call to disprove nothing). One $0 read settles which case this
      // is: when the asserted text is contained in the page's own innerText,
      // the step keeps its failure but carries the evidence
      // (`expected`/`actual`/`foundInPageText`), and `finish()` classifies
      // the run proved-? for a human to rule — never a silent pass, never a
      // bare "could not resolve" about text that is there.
      if (PRESENCE_ACTIONS.has(action)) {
        // Only `expectText`'s expected IS content. The state assertions record
        // a state label there — `expectVisible` writes the literal word
        // "visible" — and probing the page for THAT stamped `foundInPageText`
        // on any page that happens to render the English word "visible"
        // (tests/evidence.test.ts's fixture, live): a dead-ended CSS selector
        // then read as a wording question about text nobody asserted. For
        // everything else the only content worth probing is the selector's
        // own name (`text=`/`role=[name=…]`); a CSS selector has none and is
        // never stamped.
        const wanted =
          action === 'expectText' && typeof detail?.['expected'] === 'string'
            ? (detail['expected'] as string)
            : (selectorName(selector) ?? '');
        const contained = wanted === '' ? null : await this.#textContainedInPage(wanted);
        if (contained !== null) {
          detail = {
            ...(detail ?? {}),
            expected: wanted,
            actual: contained,
            foundInPageText: true,
          };
        }
      }
      // **A near-NAME on the right role is the same wording question** (EN-2
      // audit, false alarms): `role=button[name="Save"]` dead-ended while the
      // page's footer button is "Proceed"; `role=textbox[name="Benefit Plan
      // ID"]` while the field is named a word apart. When an assertion's
      // named-role selector resolved nothing but the live tree holds a
      // same-role control whose name is a near-miss of the asserted one, the
      // step carries both names and qualifies for proved-? — the judge (or a
      // person) rules whether the page's name satisfies the sheet's, instead
      // of a bare "could not resolve" filing a false alarm.
      if (
        resolution !== undefined &&
        (detail === undefined || detail['foundInPageText'] === undefined) &&
        (ASSERTION_ACTIONS as readonly string[]).includes(action)
      ) {
        const named = /^role=([a-z]+)\s*\[name="((?:[^"\\]|\\.)*)"/i.exec(selector.trim());
        if (named) {
          const role = (named[1] as string).toLowerCase();
          const wantedName = (named[2] as string).replace(/\\(.)/g, '$1');
          try {
            const tree = await captureAxTree(this.page, 200);
            const lineRe = new RegExp(`^\\s*${role}\\s+"((?:[^"\\\\]|\\\\.)*)"`, 'i');
            for (const line of tree.split('\n')) {
              const m = lineRe.exec(line);
              const candidate = m?.[1]?.replace(/\\(.)/g, '$1');
              // `nearMiss` alone is deliberately lenient (any non-numeric
              // wording mismatch is "worth judging") — here it would stamp
              // every same-role node as near. Require the names to actually
              // share a word (3+ chars) or contain one another first.
              const sharesWord = (x: string, y: string): boolean => {
                const xs = x.toLowerCase(); const ys = y.toLowerCase();
                if (xs.includes(ys) || ys.includes(xs)) return true;
                const words = xs.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
                return words.some((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&')}([^\\p{L}\\p{N}]|$)`, 'iu').test(y));
              };
              if (
                candidate !== undefined &&
                candidate !== '' &&
                sharesWord(wantedName, candidate) &&
                nearMiss(wantedName, candidate)
              ) {
                detail = {
                  ...(detail ?? {}),
                  expected: wantedName,
                  actual: `the page's ${role} is named ${JSON.stringify(candidate)}`,
                  foundInPageText: true,
                };
                break;
              }
            }
          } catch {
            // Evidence-gathering only — a failed capture changes nothing.
          }
        }
      }
      // A not-found stop is a verdict about the PAGE (EH-09): the heading is
      // the evidence, and there is no wording for a judge to rule on — the
      // stamp keeps the near-miss gate off it.
      if (resolution?.attempts.some((line) => line.startsWith('not-found:'))) {
        detail = { ...(detail ?? {}), verdict: 'not-found' };
      }
      // A failed step may still HAVE a target: an assertion that found its
      // element and disagreed with its content. A short read of the authored
      // selector marks it in the still when it is there; a selector that
      // matched nothing costs one bounded miss and records no target.
      const failedTarget = await this.#target(selector, Math.min(TARGET_READ_BUDGET_MS, 750));
      this.bundle.addStep({
        action,
        intent,
        selector,
        resolvedSelector: null,
        resolution: null,
        status: 'failed',
        startedAt,
        durationMs: Date.now() - started,
        url: this.page.url(),
        // A failed step never resolved, so there is no field to read a type
        // from — the wording fallback carries this path alone, which is
        // exactly the case it exists for.
        detail: await this.#maskValue(action, selector, intent, detail, null),
        // A StepResolutionError's later lines are the escalation trace — the
        // rung-by-rung account `escalationTrace()` in the reporter parses.
        // `describe()` keeps only the first line, which is right for prose
        // and would silently erase the trace from every report and bundle.
        error: resolution ? resolution.message : describe(error),
        // Diagnostics the ladder gathered on the way down: what the page was
        // showing, and which repairs were proposed and refused. Both are
        // evidence a reader needs and neither survives as anything but a
        // trace substring otherwise.
        pageContext: pageContext.length > 0 ? pageContext : undefined,
        rejectedHeals: resolution?.rejectedHeals,
        decision: resolution?.decision,
        network: evidence.calls.length > 0 ? evidence.calls : undefined,
        target: failedTarget,
        screenshot: await this.#shoot('failure', failedTarget),
      });
      if (resolution) {
        // Remember an exhausted ladder for this page+selector, so an identical
        // retry later in the run fails in one attempt instead of repaying the
        // whole ladder and another model call. Backend and stranded stops are
        // excluded: those describe a moment, not the page's answer.
        const transient = resolution.attempts.some(
          (line) => line.startsWith('backend:') || line.startsWith('declined to heal:'),
        );
        if (!transient) {
          this.#deadResolutions.set(await this.#deadEndKey(selector), {
            step: this.bundle.steps.length - 1,
            contentMiss: resolution.contentOnly,
          });
        }
      }
      this.#recordStepFailureDefect(action, selector, describe(error), evidence.failures);
      throw error;
    }
  }

  /**
   * Attribute a failed step to the backend when the evidence supports it.
   *
   * The wording matters and is deliberately correlational: we know a request
   * failed while this step was waiting, not that it caused the step to fail.
   * Overclaiming here would be the same mistake `ax-coverage.ts` refuses to
   * make when it declines to credit a CSS selector it cannot attribute.
   */
  #recordStepFailureDefect(
    action: string,
    selector: string | undefined,
    message: string,
    failures: readonly NetworkCall[],
    /** "Step" for an interaction, "Assertion" for a check — kept from before. */
    label: 'Step' | 'Assertion' = 'Step',
  ): void {
    // A harness fact files no application defect: "the observer was not
    // attached" and "the buffer truncated the window" say nothing about the
    // app, and a defect would send someone hunting a bug nobody claimed
    // exists. Same prefix matching the exit contract uses.
    if (/^(?:database unavailable|network observation)/.test(message)) return;
    if (failures.length === 0) {
      // A backend-tier step that failed is a backend finding by construction —
      // there is no selector, no page, and nothing a test author can repair.
      // Filing it as `functional` would put a 500 on the UI team's pile.
      this.#recordRuntimeDefect(
        BACKEND_TIER_ACTIONS.has(action) ? 'backend' : 'functional',
        'high',
        `${label} failed: ${action}${selector ? ` ${selector}` : ''}`,
        message,
        selector,
      );
      return;
    }

    const listed = failures.slice(0, MAX_STEP_EVIDENCE).map(describeCall).join('\n  ');
    this.#recordRuntimeDefect(
      'backend',
      'high',
      `Backend call failed during: ${action}${selector ? ` ${selector}` : ''}`,
      `${failures.length} request(s) failed while this step was waiting:\n  ${listed}\n\n` +
        `The step itself reported: ${message}\n` +
        'This is a correlation, not a proof of cause — but a failing request is a far more ' +
        'likely explanation for a control that never appeared than a drifted selector, so no ' +
        'repair was attempted. Fix the request before touching the test.',
      selector,
    );
  }

  /**
   * Calls worth attaching to a failed step: the ones that failed, plus a
   * little surrounding traffic for context when nothing failed outright.
   */
  /**
   * Take this step's network mark, and remember where the previous step began.
   *
   * The evidence window reaches back to the *previous step's start*, not just
   * a fixed lookback from this one: the request that starves a step is almost
   * always fired by the step before it, and a fixed 3s window loses exactly
   * that call as soon as the prior step runs long. PB-02-01's login block
   * spent 20s+ per step walking the ladder, and three failed steps in a row
   * carried no network evidence at all while their neighbours did.
   */
  /**
   * The dead-end memo's key for this page state (EH-15). `CacheManager.key`
   * already keeps the page-naming query params (`?step=2`, `scopeUrl`); a
   * wizard that keeps its step OUT of the URL is told apart by the label of
   * its stepper's `aria-current="step"` node — humi's `Stepper.tsx` — read
   * once, bounded, only when the URL carries no step of its own. Two forms
   * on one URL must not share one memo: a dead end on step 1 is not step 2's.
   */
  async #deadEndKey(selector: string): Promise<string> {
    const who = this.#active.label === null ? '' : `${this.#active.label} :: `;
    const key = who + CacheManager.key(this.page.url(), selector);
    try {
      if (/[?&]step=/.test(this.page.url())) return key;
      const current = this.page.locator('nav [aria-current="step"]').first();
      if ((await current.count()) === 0) return key;
      const label = (await current.innerText({ timeout: ATTRIBUTE_READ_TIMEOUT_MS })).replace(/\s+/g, ' ').trim();
      return label === '' ? key : `${key} @step:${label.slice(0, 60)}`;
    } catch {
      return key;
    }
  }

  /** The page's headings right now — the cheapest honest "which screen is this". */
  async #headingsNow(): Promise<string[]> {
    try {
      const texts = await this.page.locator('role=heading').allInnerTexts();
      return texts.map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t !== '');
    } catch {
      return [];
    }
  }

  #takeNetMark(): number | undefined {
    if (!this.#network) return undefined;
    const mark = this.#network.mark();
    this.#evidenceFloorMs = Math.min(mark - NETWORK_LOOKBACK_MS, this.#previousNetMark ?? mark);
    this.#previousNetMark = mark;
    return mark;
  }

  #networkEvidence(mark: number | undefined): {
    calls: NetworkCall[];
    failures: NetworkCall[];
  } {
    if (mark === undefined || !this.#network) return { calls: [], failures: [] };
    try {
      const since = this.#network.since(this.#evidenceFloorMs ?? mark - NETWORK_LOOKBACK_MS);
      const failures = since.filter(isBlockingFailure);
      const calls =
        failures.length > 0 ? failures.slice(0, MAX_STEP_EVIDENCE) : since.slice(-MAX_STEP_EVIDENCE);
      return { calls, failures };
    } catch {
      return { calls: [], failures: [] };
    }
  }

  /**
   * Detect a heal that was really a race condition.
   *
   * If the *original* selector resolves once the page has settled, it was
   * never broken — it was slow, and the 2s fast-path budget expired first.
   * Healing "fixes" that invisibly and permanently, so the flake never gets
   * diagnosed. One cheap re-check turns it into a reported defect.
   */
  async #flagTimingHeal(original: string, healed: string): Promise<void> {
    if (original === healed) return;
    try {
      const count = await this.page.locator(original).count();
      if (count === 0) return; // Genuine drift: the original really is gone.
    } catch {
      return;
    }

    this.#recordRuntimeDefect(
      'functional',
      'medium',
      `Heal masked a timing issue: ${original}`,
      `"${original}" resolves once the page settles, so it was not broken — it was slower ` +
        `than the ${this.#fastTimeoutMs}ms fast-path budget. The heal to "${healed}" hides a ` +
        'race condition rather than fixing it. Add an explicit wait for the state this step ' +
        'depends on instead of relying on the repair.',
      original,
    );
  }

  /**
   * Report a text selector that was written tighter than the page renders.
   *
   * The relax rung is a rescue, not an absolution: the flow quoted a rendering
   * the application does not use, and left alone it will pay this rung on
   * every run forever. `low` because nothing about the application is wrong —
   * DB_07_01's `text="75,000"` against a page rendering `฿75,000.00` was two
   * `high` defects filed at a working feature, and the honest replacement is
   * one small note telling the author what the page actually says.
   *
   * The matched text is read back so the finding names the real rendering
   * rather than describing the shape of the problem. Best-effort: a read that
   * fails must not turn a rescued step into a failed one.
   */
  async #flagOverExactText(original: string, relaxed: string): Promise<void> {
    let shown: string | null = null;
    try {
      const text = await this.page.locator(relaxed).first().innerText({ timeout: 1_000 });
      shown = text.trim().replace(/\s+/g, ' ').slice(0, 120) || null;
    } catch {
      shown = null;
    }

    this.#recordRuntimeDefect(
      'functional',
      'low',
      `Text selector was more exact than the page: ${original}`,
      `"${original}" matches an element's WHOLE text, and the page renders that value with ` +
        `more around it${shown ? ` — it shows "${shown}"` : ''}. Matched instead as ` +
        `"${relaxed}". The assertion holds; the selector was written tighter than the ` +
        'rendering. Quote what the page actually shows (or use the unquoted substring form) ' +
        'so the suite stops paying this rung every run.',
      original,
    );
  }

  async #flagOverExactName(original: string, relaxed: string): Promise<void> {
    let shown: string | null = null;
    try {
      const text = await this.page.locator(relaxed).first().innerText({ timeout: 1_000 });
      shown = text.trim().replace(/\s+/g, ' ').slice(0, 120) || null;
    } catch {
      shown = null;
    }
    this.#recordRuntimeDefect(
      'functional',
      'low',
      `Accessible name was more exact than the page: ${original}`,
      `"${original}" matches an element's WHOLE accessible name, and the page names it with ` +
        `more around it${shown ? ` — it shows "${shown}"` : ''}. Matched instead as a whole word ` +
        `inside the name ("${relaxed}"). The assertion holds; the selector was written tighter ` +
        'than the rendering. Quote the name the page actually exposes so the suite stops paying this rung every run.',
      original,
    );
  }

  #recordRuntimeDefect(
    category: Defect['category'],
    severity: Defect['severity'],
    title: string,
    detail: string,
    selector: string | undefined,
  ): void {
    this.#defectSeq += 1;
    this.bundle.addDefect({
      id: `run-${this.#defectSeq}`,
      source: 'runtime',
      category,
      severity,
      title,
      detail,
      selector,
      stepIndex: this.bundle.steps.length - 1,
    });
  }

  /**
   * The page's url, or null when there isn't one.
   *
   * A `request` step can run before anything has been navigated to — the page
   * is on `about:blank` — and reporting that as the step's location is worse
   * than reporting nothing, since it reads like a navigation bug.
   */
  #currentUrl(): string | null {
    const url = this.page.url();
    return url && url !== 'about:blank' ? url : null;
  }

  /**
   * Capture what the page looked like at this step.
   *
   * The kinds, the size decisions and the never-throws rule all live in
   * `evidence.ts`, because the crawler captures on the same terms and two
   * copies of that rule would drift.
   */
  /**
   * A backend step just ran — probe the database baseline and record what the
   * tables under test look like against it. Only for HTTP and DB steps, and
   * only when a baseline probe is configured; evidence, never a verdict, so a
   * probe that throws lands on the step as `dbProbeError` and nothing else.
   */
  async #probeDbBaseline(action: string): Promise<void> {
    if (this.#dbBaselineProbe === null) return;
    if (!API_STEP_ACTIONS.has(action) && !DB_STEP_ACTIONS.has(action)) return;
    try {
      const changes = await this.#dbBaselineProbe.probe();
      this.bundle.annotateDbChanges(changes, undefined);
    } catch (error) {
      this.bundle.annotateDbChanges(undefined, error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error));
    }
  }

  async #shoot(kind: EvidenceKind, target?: StepTarget | undefined): Promise<string | undefined> {
    // The rectangle is drawn from the target's selector, live, at the
    // shutter — not from the box recorded a moment earlier, which the settle
    // may have moved. Only when the run wants it and there is a target.
    const highlight =
      this.#highlightTarget && target !== undefined ? this.page.locator(target.selector).first() : undefined;
    return captureEvidence(this.page, this.#screenshots, kind, this.#captureDelayMs, highlight);
  }

  /**
   * What the step acted on, read from the live element. Bounded and
   * never-throwing (`captureTarget`); `null` selectors read as no target.
   */
  async #target(selector: string | null, budgetMs: number = TARGET_READ_BUDGET_MS): Promise<StepTarget | undefined> {
    return captureTarget(this.page, selector, budgetMs);
  }

  /**
   * Notice that the application moved the run somewhere it never asked to go.
   *
   * This is the shape of a lost session, and it is invisible in the verdict
   * without help. PB_02_01 asked for `/en/workflows/probation/PB-001`, was
   * bounced to `/en/login` while a `setLocalStorage` step ran, and spent its
   * remaining 24 steps on the sign-in page — reported as six unresolvable
   * selectors, which reads as "the front end is broken" and is not what
   * happened.
   *
   * **The test is factual, not a guess about authentication.** It only fires
   * when the URL changed between two adjacent steps *neither of which can
   * navigate* — no `goto`, no `click`, nothing that follows a link. When that
   * is true the application moved by itself, which is worth saying whatever
   * the reason. Only reported for a run that actually failed: a self-directed
   * redirect that broke nothing is an app's business, not a finding.
   */
  #flagUnrequestedNavigation(): void {
    // The stranded guard already said this, with more for a reader to act on.
    if (this.#strandedReported) return;
    const steps = this.bundle.steps;
    if (!steps.some((step) => step.status !== 'passed' && step.status !== 'skipped')) return;

    let previous: { url: string; action: string } | null = null;
    for (const step of steps) {
      if (step.status === 'skipped') continue;
      const url = step.url;
      if (url === null) continue;
      if (
        previous !== null &&
        !NAVIGATING_ACTIONS.has(previous.action) &&
        !NAVIGATING_ACTIONS.has(step.action) &&
        differentPage(previous.url, url)
      ) {
        const signIn = looksLikeSignIn(url);
        this.#recordRuntimeDefect(
          'functional',
          'high',
          signIn
            ? 'The application redirected the run to a sign-in page'
            : 'The application navigated the run somewhere it did not ask to go',
          `Between "${previous.action}" and "${step.action}" — neither of which navigates — ` +
            `the page moved from ${previous.url} to ${url}. ` +
            (signIn
              ? 'Every step after this one ran against the sign-in page, so failures below ' +
                'describe that page and not the feature under test. This is what a missing ' +
                'or expired session looks like: check that the browser is signed in, and ' +
                'that any token the flow seeds is applied before the app decides.'
              : 'Steps after this one ran against a different page than the flow intended.'),
          undefined,
        );
        return; // once is the finding; repeating it per step is noise
      }
      previous = { url, action: step.action };
    }
  }

  /**
   * Record what the recording context did or did not bring with it.
   *
   * A filmed run that starts signed out does not fail in a way that says so.
   * It fails as a pile of unresolvable selectors, on a login page the flow
   * never asked for, and the report blames the front end — which is how
   * PB_02_01 came to file six defects about an application that was fine.
   * So the one moment the truth is knowable, it is written down.
   */
  #noteSessionInheritance(inheritance: SessionInheritance): void {
    // Declined is a decision, not a defect: the flow authenticates itself and
    // asked for a clean start. Recorded on the bundle's notes so the report
    // says why this run held no cookies at step 0.
    if (inheritance.declined) {
      this.bundle.note(
        'session: started from an empty context — the flow signs in itself, so the ' +
          "attached browser's session was deliberately not inherited",
      );
      return;
    }
    if (inheritance.fromSuite) {
      this.bundle.note(
        `session: reused the session a sibling case of this suite established ` +
          `(${inheritance.state?.cookies.length ?? 0} cookie(s)) — no sign-in was paid for`,
      );
      return;
    }
    const carried = inheritance.state?.cookies.length ?? 0;
    if (inheritance.error !== undefined) {
      this.#recordRuntimeDefect(
        'functional',
        'high',
        'The run could not inherit the browser’s session',
        `Filming needs its own browser context, and this one could not copy the attached ` +
          `browser's cookies (${inheritance.error}). If the application requires a login, ` +
          `every step after the first redirect is happening on the sign-in page. Re-run with ` +
          `--video off to use the browser's own context.`,
        undefined,
      );
      return;
    }
    if (inheritance.available > 0 && carried === 0) {
      this.#recordRuntimeDefect(
        'functional',
        'high',
        'The run started without the browser’s session',
        `The attached browser held ${inheritance.available} cookie(s) but the recording ` +
          `context received none. If the application requires a login, this run is testing ` +
          `the sign-in page. Re-run with --video off to use the browser's own context.`,
        undefined,
      );
    }
  }

  /**
   * Where the recording should stop, or `null` to keep none of it.
   *
   * The rule (2026-08-31): **every run keeps its film.** A recording used to
   * be evidence of a failure only — a clean pass discarded its film, and the
   * report's "View actual flow" button existed for a minority of runs. Asked
   * for universally: the film of the mock user performing the task IS the
   * evidence a reviewer opens first, pass or fail, so a clean pass now keeps
   * the whole recording. The cut rules below still apply when something
   * broke — the film runs from the start (the state leading up to a failure
   * is most of what makes it diagnosable) and is trimmed only when the
   * failure was the last filmed moment.
   *
   * The *first* failure, not the last. Once a step has failed the run
   * continues, and everything after it is happening in a state the test no
   * longer understands — so the later failures are usually consequences, and
   * the first one is the one worth watching.
   *
   * A failed step with no offset (an HTTP step, or a failure before filming
   * began) cuts nothing: there is no moment on film to cut to, and guessing
   * one would produce a video that claims to end at a step it never saw.
   */
  #videoCut(): VideoCut {
    const steps = this.bundle.steps;
    let sawSuperseded = false;
    let firstBroken: ProofStep | undefined;
    for (const step of steps) {
      if (step.status === 'passed' || step.status === 'skipped') continue;
      // A superseded failure is an attempt, not the outcome — its
      // reconstruction passed in its place, and the run went on. Cutting the
      // film at it produced a PASSED run whose recording showed two steps of
      // five (seen live: "Navigate to Contact Us Page", cut at a rescued
      // expectUrl while the rescue and everything after went unfilmed).
      if (step.superseded) {
        sawSuperseded = true;
        continue;
      }
      if (step.videoOffsetMs === undefined) continue;
      firstBroken = step;
      break;
    }
    if (firstBroken === undefined) {
      // Nothing broke (or every break was rescued): the whole film is the
      // record of the task being performed, and it is what "View actual
      // flow" plays. `sawSuperseded` no longer changes the answer — it is
      // kept readable above for the cut rules that still need it.
      void sawSuperseded;
      return 'full';
    }
    // **The run carried on past the failure, so the film does too.** The
    // "cut at the first broken step" rule was written when a failure ended
    // the run, and its premise — everything afterwards is a state the test
    // no longer understands — stopped being true when steps after a failure
    // started getting their turn. Measured (BE_Test2, 2026-08-19): a flow
    // dead-ended clicking "Create Plan" at step 3, clicked the same control
    // and passed at step 6, passed both assertions — and its recording was
    // 13 seconds ending at step 1, the one part of the run that proved
    // nothing. Is the footage after the break relevant? It is the only
    // evidence of what the run did about the break. The report's player
    // still opens pre-seeked to the first broken step (`data-failure-offset`),
    // so the moment the film was kept for is the first frame seen; the rest
    // is scrub-able rather than gone. A run whose failure was its LAST filmed
    // step is cut there as before — there is nothing after it to keep.
    const later = steps.some(
      (s) => s.index > firstBroken!.index && s.videoOffsetMs !== undefined && !s.superseded,
    );
    if (later) return 'full';
    return {
      stepIndex: firstBroken.index,
      atMs: firstBroken.videoOffsetMs! + firstBroken.durationMs,
    };
  }

  /**
   * Stop the run if it is stranded on a sign-in page it never asked for.
   *
   * **This is the guard that turns the single most common wasted run into one
   * sentence.** An application that requires a login redirects every protected
   * URL to its sign-in page, and a flow whose session did not take then spends
   * every remaining step there: assertions fail because the feature is not on
   * this page, the healer repairs some of them onto login-page controls and
   * reports them green, and the run ends with a pile of defects about an
   * application that is working perfectly.
   *
   * Called before each step, so nothing runs — and nothing heals — once the
   * run is somewhere it cannot answer the question it was asked.
   *
   * Three conditions, all required, so a flow that *means* to be on a sign-in
   * page is never stopped:
   *
   * - the page is on a sign-in URL now;
   * - the MOST RECENT `goto` did not ask for a sign-in page — per-goto, not
   *   "any goto in this run": a flow that logs in first always has a login
   *   goto in its past, and the run-wide version of this exemption is what
   *   let a bounced post-login navigation spend six steps dead-ending
   *   against login furniture (seen live: the whole DB_04 create-plan body
   *   filed high frontend defects from /en/login);
   * - the last `goto` asked for a different page, i.e. we were sent here.
   *
   * A `click` is exempt: following a "Sign out" control is a legitimate way to
   * arrive, and the flow that clicked it knows where it is going.
   */
  assertSessionHeld(): void {
    const message = this.#strandedMessage();
    if (message === null) return;
    if (!this.#strandedReported) {
      this.#strandedReported = true;
      // Before the defect and before the throw: the verdict must hold even
      // when a later path swallows the error. See `noteSessionLost`.
      this.bundle.noteSessionLost();
      this.#recordRuntimeDefect(
        'functional',
        'high',
        this.#signInDidNotTake
          ? 'The sign-in never took effect — the run held no session'
          : 'The run lost its session and was sent to the sign-in page',
        message,
        undefined,
      );
    }
    throw new SessionLostError(message);
  }

  /**
   * The stranded diagnosis, or `null` when the run is where it should be.
   *
   * Split out from `assertSessionHeld` so the escalation ladder can consult it
   * without stopping the run: a step whose page was redirected *while it ran*
   * must decline to heal, but it is still an ordinary failed step.
   */
  /**
   * Establish the session this flow assumes, when it can be done honestly.
   * Returns the account it signed in as, or null when nothing was done.
   */
/**
   * F1 of docs/consent-gate-recovery-spec.md: if the page a `goto` landed on
   * is SHOWING the consent gate — content-detected, because the gate renders
   * in place on the asked-for URL — accept it and re-issue the same goto
   * once. Runs whether the flow signed in itself or the bootstrap did; a goto
   * that asked for the gate's own page keeps its subject and is never
   * touched. Once per goto: a gate that re-renders after acceptance is an
   * application finding, and the next step fails honestly with the gate in
   * its pageContext.
   */
  async #settleConsentGate(askedUrl: string, urlBeforeNav: string): Promise<ConsentSettlement> {
    try {
      const asked = new URL(askedUrl, this.page.url() || undefined);
      // A flow that means to test the consent page is never steered off it.
      if (CONSENT_GATE_URL_PATTERN.test(asked.pathname)) return null;
    } catch {
      return null;
    }
    let gate = await consentGateShowing(this.page);
    if (gate === null) {
      // The gate has a THIRD shape on the measured application: the goto
      // lands on the target URL, and the client guard bounces to /en/consent
      // a beat AFTER domcontentloaded — so an immediate check sees nothing.
      // The tell is cheap and does not tax ordinary gotos: the page was ON a
      // consent URL before this goto (the sign-in just landed there), or is
      // on one now. Only then is a short bounce-window paid, and the re-check
      // also catches an in-place gate that finished rendering meanwhile.
      const expectGate =
        this.#consentPolicy === 'preserve' ||
        CONSENT_GATE_URL_PATTERN.test(this.page.url()) ||
        (() => {
          try {
            return CONSENT_GATE_URL_PATTERN.test(new URL(urlBeforeNav).pathname);
          } catch {
            return false;
          }
        })();
      if (expectGate) {
        try {
          await this.page.waitForURL((u) => CONSENT_GATE_URL_PATTERN.test(u.pathname), { timeout: 2_000 });
        } catch (error) {
          if (!(error instanceof errors.TimeoutError)) throw error;
        }
        await this.page.waitForTimeout(300);
        gate = await consentGateShowing(this.page);
      }
    }
    if (gate === null) return null;
    if (this.#consentPolicy === 'preserve') {
      this.bundle.note(`consent gate: preserved the screen that stood in front of ${askedUrl}`);
      return 'preserved';
    }
    const accepted = await acceptConsentGateAnywhere(this.page);
    if (!accepted) return null;
    // Accepting abandons the deep link (the app lands on its home page), so
    // the recovery is only done once the goto is re-issued.
    await this.page.goto(askedUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await this.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    this.bundle.note(
      `consent gate: accepted the consent screen that stood in front of ${askedUrl} and returned to it`,
    );
    this.#recordRuntimeDefect(
      'usability',
      'low',
      'A consent gate stood in front of the page under test',
      `The navigation to ${askedUrl} landed on a consent screen; the run accepted it ` +
        `(name-gated control) and re-issued the navigation. Author the consent accept into ` +
        `setup (a clickIfVisible right after sign-in) to make the flow self-contained.`,
      undefined,
    );
    return 'accepted';
  }

  async #bootstrapSession(askedUrl: string): Promise<string | null> {
    if (this.#credentials === undefined) return null;
    if (this.#flowSignsInItself) return null;
    if (this.#sessionBootstrapTried) return null;
    if (this.#lastGotoAskedSignIn) return null;
    // A consent gate is the session HALF established — accept it and go on.
    if (this.#consentPolicy === 'accept' && (await acceptConsentGate(this.page))) {
      if (!looksLikeSignIn(this.page.url())) return null;
    }
    if (!looksLikeSignIn(this.page.url())) return null;
    this.#sessionBootstrapTried = true;

    const outcome = await performSignIn(this.page, this.#credentials);
    if (!outcome.ok) {
      // Disclosed and left to the ordinary fatal: a sign-in the harness could
      // not complete says the credentials or the form are the problem, and
      // pretending otherwise would bury it.
      this.bundle.note(
        `session bootstrap: signing in as ${this.#credentials.email} did not take — ${outcome.reason}`,
      );
      return null;
    }
    if (this.#consentPolicy === 'accept') {
      await acceptConsentGate(this.page);
      await this.page.goto(askedUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    }
    await this.page
      .waitForLoadState('networkidle', { timeout: 10_000 })
      .catch(() => undefined);
    this.bundle.note(
      `session bootstrap: the flow assumes a signed-in user and the browser had no session, ` +
        `so the run signed in as ${this.#credentials.email} and returned to ${askedUrl}`,
    );
    // Green, and still a finding: the flow depends on a precondition it does
    // not establish, and every fresh browser will pay this again until the
    // sign-in is authored into setup (or --as keeps being supplied).
    this.#recordRuntimeDefect(
      'usability',
      'low',
      'The flow assumes a signed-in user',
      `Its first navigation landed on the sign-in page, so the run established the session ` +
        `itself with the supplied --as credentials (${this.#credentials.email}). Author the ` +
        `sign-in into setup to make the flow self-contained.`,
      undefined,
    );
    return this.#credentials.email;
  }

  #strandedMessage(): string | null {
    // The sign-in that never took, as opposed to the session that was lost.
    // `#strandedMessage`'s original question is "were we bounced AWAY from
    // what we asked for?", which needs `path !== #lastGotoPath` — and in a
    // flow that logs in first, the most recent goto IS the login page, so it
    // correctly declines and the run carries on unauthenticated. That is how
    // DB_04_01 filed six high frontend defects, DB_06_01 five, DB_07_01 five
    // and DB_08_01 three, every one of them about an application that was
    // fine: the login silently failed and everything after it ran on a page
    // the flow had no session for.
    //
    // This branch asks the other question — "did the sign-in work at all?" —
    // and it never guesses: `#signInDidNotTake` is set only from the hydration
    // signatures, after a replay that failed to rescue them. It deliberately
    // does NOT require the current page to look like a sign-in page: this app
    // renders a protected route for a beat before its client guard bounces
    // it, so "where are we now" is the wrong evidence. The trigger is the
    // flow asking for a page that needs a session — which is also what
    // exempts a negative sign-in test, since one that stays on the login page
    // to assert an error message never sets `#lastGotoAskedSignIn` false.
    const neverSignedIn = signInDidNotTakeMessage({
      signInDidNotTake: this.#signInDidNotTake,
      lastGotoAskedSignIn: this.#lastGotoAskedSignIn,
      lastGotoPath: this.#lastGotoPath,
    });
    if (neverSignedIn !== null) return neverSignedIn;
    // `click` is exempt (following a "Sign out" control is a legitimate way
    // to arrive) and so is `signOut`, which is that same arrival made
    // explicit — a persona switch MEANS to be on the sign-in page next.
    if (this.#lastGotoAskedSignIn || this.#lastAction === 'click' || this.#lastAction === 'signOut')
      return null;
    const current = this.page.url();
    if (!looksLikeSignIn(current)) return null;
    if (this.#lastGotoPath === null) return null;
    let path: string;
    try {
      path = new URL(current).pathname;
    } catch {
      return null;
    }
    if (path === this.#lastGotoPath) return null;

    return (
      `the run is on the sign-in page (${current}) after asking for ` +
      `${this.#lastGotoPath} — the session is not established, so nothing after this ` +
      `point can say anything about the feature under test.\n` +
      `  Every later step would be asserted against the login screen, and a heal could ` +
      `"fix" one onto a login control and report it green.\n` +
      (this.#credentials === undefined && !this.#flowSignsInItself
        ? `  The flow contains no sign-in of its own and the run was given no account: pass ` +
          `--as <email>:<password> and the run will establish the session itself before ` +
          `continuing.\n`
        : '') +
      `  Fix the flow's sign-in: log in through the UI before the steps that need it, ` +
      `and if it seeds a token with setLocalStorage, navigate again afterwards so the ` +
      `application reads it.`
    );
  }

  /**
   * The pause before a step, when pacing is on. After `narrate` on purpose:
   * the caption names the step about to happen, and the pause is when a
   * viewer reads it and sees the state it starts from.
   */
  async paceStep(): Promise<void> {
    if (this.#stepDelayMs <= 0) return;
    await this.page.waitForTimeout(this.#stepDelayMs).catch(() => undefined);
  }

  /**
   * Record how a credential submit ended.
   *
   * Called for every credential-shaped click: `true` when a hydration
   * signature fired AND the page is still on the sign-in URL afterwards —
   * the submit demonstrably did not take. `false` clears it, so a flow that
   * retries its login and succeeds is not haunted by the first attempt.
   */
  noteSignInOutcome(didNotTake: boolean): void {
    this.#signInDidNotTake = didNotTake;
  }

  /**
   * Remember what just ran, for `assertSessionHeld` — and whether it failed,
   * for `dialogIsIntendedContext`. A dialog is the flow's own context only
   * when the step that opened it did what it meant to.
   */
  noteAction(action: string, failed = false): void {
    this.#lastAction = action;
    this.#lastActionFailed = failed;
  }

  /** How many steps in a row have ended "could not resolve" — see `UNRESOLVED_BREAKER`. */
  #unresolvedRun = 0;

  /** Record whether a step's control could be reached at all. Cleared by any success. */
  noteResolveOutcome(unresolved: boolean): void {
    this.#unresolvedRun = unresolved ? this.#unresolvedRun + 1 : 0;
  }

  /** True while the page has answered for nothing long enough that a paid rung cannot help. */
  get #pageAnswersNothing(): boolean {
    return paidRungsAreWasted(this.#unresolvedRun);
  }

  /**
   * A form submitted natively before the app hydrated — see
   * `nativeFormResubmitDetected`. Two findings in one: the harness raced the
   * page (and recovered by replaying), and the application let a credential
   * form degrade to a native GET, which puts what was typed — passwords
   * included — into URLs, browser history and server logs.
   */
  recordNativeResubmitFinding(step: FlowStep, param: string): void {
    this.#recordRuntimeDefect(
      'usability',
      'medium',
      'Form submitted natively before the app hydrated',
      `Clicking ${(step as { selector?: string }).selector ?? step.action} landed before the ` +
        `application attached its submit handler, so the browser performed the form's default ` +
        `GET submission — ${
          param === NATIVE_SUBMIT_UNNAMED
            ? "the URL gained a query string it did not have when the credentials were typed (the form's inputs carry no name attribute, so it submitted a bare \"?\")"
            : `form values (parameter "${param}") appeared in the page URL`
        } and no ` +
        `session was created. The run waited for hydration and replayed the fill block and the ` +
        `click once. This is also an application finding: a form that degrades to a native GET ` +
        `submission exposes what was typed in the URL.`,
      (step as { selector?: string }).selector,
    );
  }

  /**
   * The race's second signature — see `fillsLostToHydration`. Same class of
   * finding as `recordNativeResubmitFinding`: the harness typed faster than
   * the app could listen, and the recovery is disclosed, never silent.
   */
  recordLostFillFinding(step: FlowStep, lostSelector: string): void {
    this.#recordRuntimeDefect(
      'usability',
      'medium',
      'Filled fields were reset by hydration before the submit',
      `The fills landed before the application hydrated, and hydration reset its controlled ` +
        `inputs — ${lostSelector} no longer held what the flow typed when ` +
        `${(step as { selector?: string }).selector ?? step.action} was clicked, so the form ` +
        `submitted without it and no session was created. The run waited for hydration and ` +
        `replayed the fill block and the click once. This is also an application finding: a ` +
        `form a fast user can fill before hydration silently discards their input.`,
      (step as { selector?: string }).selector,
    );
  }

  /** A rescued step is also a finding: the flow is drifting from the app. */
  recordReconstructionDefect(step: FlowStep, failures: number): void {
    this.#recordRuntimeDefect(
      'functional',
      'medium',
      `Step reconstructed in-run: ${step.action}${'selector' in step ? ` ${(step as { selector?: string }).selector ?? ''}` : ''}`,
      `This step only passed after ${failures} failed attempt(s) and an in-run rebuild by the ` +
        'repair model. The run is green, but the flow as written no longer matches the ' +
        'application — update the step (see the reconstruction record on it) so the suite ' +
        'stops paying a model every run.',
      'selector' in step ? (step as { selector?: string }).selector : undefined,
    );
  }

  /**
   * The denial heading the page is showing right now, or null.
   *
   * Deterministic and free: one non-waiting locator read of the page's
   * headings, matched against `DENIAL_HEADING_PATTERN`. Anything that goes
   * wrong reads as "no denial" — this is a guard, and a guard that can fail a
   * step by itself would be worse than the miss it prevents.
   */
  async #denialSurface(): Promise<string | null> {
    try {
      const headings = await this.page.locator('role=heading').allInnerTexts();
      const denial = headings.find((text) => DENIAL_HEADING_PATTERN.test(text));
      return denial?.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * What the page is telling the user right now — its live-region messages.
   *
   * A failure's diagnosis is frequently written on the screen in words, and
   * wowlidator was not reading it. Adjudicated live on DB_06_01: the flow
   * filled two of the rule form's required fields and clicked Save;
   * `RuleForm.tsx` refuses the save and raises a warning toast naming the
   * missing field, so the row never appeared and `expectVisible` was filed as
   * a `high` application defect. The application was working correctly *and
   * said so* — that sentence is the finding, and the report showed "could not
   * resolve" instead.
   *
   * ARIA only (`role="alert"` / `role="status"`), the same understate-never-
   * overstate rule `modal.ts` applies to dialog detection: a hand-rolled
   * toast `<div>` with no live-region role is a disclosed gap, not something
   * guessed at from class names. Non-waiting and hard-capped — this runs on a
   * path that has already failed, and anything that goes wrong reads as "the
   * page said nothing", because a diagnostic that can fail a step by itself
   * would be worse than the miss it prevents.
   */
  /**
   * Is `wanted` contained in the page's own rendered text? The excerpt around
   * the match when it is, null when it is not (or the page cannot be read).
   * `innerText`, not `textContent`, for the reason `expectText` reads it: a
   * user has never seen a `<script>` payload. Whitespace is folded on both
   * sides and matching is case-insensitive — an exact-match instrument
   * already failed; this read only decides whether the text is on screen at
   * all, and the excerpt it returns is the evidence a human rules on.
   */
  async #textContainedInPage(wanted: string): Promise<string | null> {
    try {
      const body = await this.page.evaluate(() => {
        const doc = (globalThis as unknown as { document?: { body?: { innerText?: string } } }).document;
        return doc?.body?.innerText ?? '';
      });
      const hay = body.replace(/\s+/g, ' ');
      const needle = wanted.replace(/\s+/g, ' ').trim();
      if (needle === '') return null;
      const at = hay.toLowerCase().indexOf(needle.toLowerCase());
      if (at < 0) return null;
      return excerptAround(hay, hay.slice(at, at + needle.length));
    } catch {
      return null;
    }
  }

  async #pageMessages(): Promise<string[]> {
    try {
      // Two reads, not one comma-separated selector: Playwright's `role=`
      // engine takes a single role, so `role=alert, role=status` is parsed as
      // the role literally named "alert, role=status" and matches nothing —
      // silently, which is exactly the failure mode this method exists to
      // prevent. Found by the test asserting the message reaches the step.
      const texts = [
        ...(await this.page.locator('role=alert').allInnerTexts()),
        ...(await this.page.locator('role=status').allInnerTexts()),
      ];
      const seen = new Set<string>();
      const messages: string[] = [];
      for (const raw of texts) {
        const text = raw.trim().replace(/\s+/g, ' ').slice(0, PAGE_MESSAGE_MAX_CHARS);
        if (text === '' || seen.has(text)) continue;
        seen.add(text);
        messages.push(text);
        if (messages.length >= PAGE_MESSAGE_MAX) break;
      }
      return messages;
    } catch {
      return [];
    }
  }

  /**
   * Caption the recording with the step about to run.
   *
   * The report can already seek a video to a step, so this is not navigation —
   * it is what lets the recording stand on its own once it has been pulled out
   * of the report and attached to a bug. A silent clip of a pointer clicking
   * things becomes an account of a test when each click says what it is for.
   *
   * No-op when not filming, and skipped for an HTTP step: nothing about a
   * `request` happens on screen, so captioning the page it did not touch would
   * label a frame with something that is not in it.
   */
  async narrate(index: number, action: string, intent?: string | undefined): Promise<void> {
    if (!this.#video || BROWSER_FREE_ACTIONS.has(action)) return;
    this.#caption = `${index}  ${intent ?? action}`;
    await captionVideo(this.page, this.#caption);
  }

  async #resolve(
    action: string,
    selector: string,
    intent: string | undefined,
    run: (locator: Locator, timeoutMs: number) => Promise<unknown>,
    /** Network-observer timestamp taken when this step began, if observing. */
    netMark?: number | undefined,
    /** The text this step is looking for, when it is looking for one. */
    expected?: string | undefined,
    /**
     * The value an INPUT step is putting in, when it is one. What the entry
     * rung below hands the agent, and what it reads back to decide.
     */
    entry?: string | undefined,
    /**
     * The step's own declared wait (EH-07): the patience window, and a stop
     * — a declared wait that ran out is a verdict about time, not a selector,
     * and no model is paid after it.
     */
    patience?: number | undefined,
  ): Promise<ResolveResult<unknown>> {
    const attempts: string[] = [];
    // Candidates the healer proposed and refused. Evidence about what was
    // tried, carried onto whatever failure this step ultimately records.
    let rejectedHeals: RejectedHeal[] | undefined;

    // What (if anything) Playwright said intercepted the pointer — fuel for
    // the overlay rung below.
    let intercepted: { css: string | null; label: string } | null = null;
    const noteInterception = (error: unknown): void => {
      if (intercepted === null && error instanceof Error) {
        intercepted = parseInterception(error.message);
      }
    };

    // 1. Fast path — $0, short timeout.
    try {
      const value = await run(this.page.locator(selector), this.#fastTimeoutMs);
      return { value, resolution: 'fast', resolvedSelector: selector };
    } catch (error) {
      // A harness fault raised by the step itself — a fixture that is not on
      // disk — is not a resolution problem: no rung can put a file on disk,
      // and wrapping it in a ladder walk would score it a dead end against
      // the application. Out, verbatim, so `classifyStepFailure` reads its name.
      if (error instanceof Error && HARNESS_STEP_ERRORS.has(error.name)) throw error;
      noteInterception(error);
      attempts.push(`fast "${selector}": ${describeAttempt(error)}`);
    }

    // 1.01. **The element resolved and the claim about its STATE was wrong.**
    //
    // A count of 51 where 3 were claimed, a button enabled where disabled was
    // claimed: the control is on the page and the ladder has nothing to
    // repair. No sanitiser, case relaxation, overlay clearing, healer or agent
    // can turn that reading into a pass — they can only wander (ec10
    // HIR-EC-029: 70 s of healer and agent after "found 51", then a dead end
    // that read as a missing control, then eleven steps on the page the agent
    // had left behind). The one thing that CAN change the answer is time — a
    // list still filling, a button still validating — so the patience window
    // is paid once, and then the reading stands as the verdict.
    if (isStateContradiction(attempts[attempts.length - 1] ?? '')) {
      try {
        const value = await run(this.page.locator(selector), this.#healedTimeoutMs);
        this.#recordRuntimeDefect(
          'functional',
          'medium',
          `Slower than the fast-path budget: ${selector}`,
          `This step only held when given ${this.#healedTimeoutMs}ms — the state settles, ` +
            `but not within the ${this.#fastTimeoutMs}ms fast path. The feature works; the page ` +
            'is slow. Worth fixing before the budget hides a real regression.',
          selector,
        );
        return { value, resolution: 'late', resolvedSelector: selector };
      } catch (error) {
        attempts.push(`late "${selector}" (${this.#healedTimeoutMs}ms): ${describeAttempt(error)}`);
      }
      throw new StepResolutionError(selector, attempts);
    }

    // 1.02. **A read-only shell over the real input** (2026-09-02).
    //
    // `fill` on a read-only input does not fail — it WAITS for the field to
    // become editable until the timeout, so every rung below would burn its
    // whole budget on the same element (measured: 56 s, 41 s and 93 s for the
    // three inputs of ec10 HIR-EC-001, and none of them entered anything).
    // The shape behind it is a common date-picker idiom: a visible read-only
    // text box carrying the placeholder ("Select date") drawn over a hidden
    // `<input type="date">` that the label actually points at
    // (humi-SIT `HumiDatePicker`, StepIdentity's Hire Date). The tree lists
    // both; the flow took the one whose NAME was the placeholder.
    //
    // So: if the element resolved and is read-only, this is not a resolution
    // problem and no later rung can fix it. Fill the editable input beside it
    // — as an ISO date when it is a date input — and when there is none, go
    // straight to the agent rather than time out four more times.
    let readOnlyShell = false;
    if (entry !== undefined && (action === 'fill' || action === 'fillRetry')) {
      const shell = await this.#readOnlyShell(selector);
      if (shell !== null) {
        readOnlyShell = true;
        attempts.push(`read-only: "${selector}" resolved but is a read-only field — a display, not the input`);
        // **The label first, the neighbour second.** Four "Select date" shells
        // sit on the hire form, so `.first()` of the given selector is a
        // guess at WHICH date. The step's own intent almost always names the
        // field ("key Hire Date = 15 Sep 2027"), and the hidden input is
        // named by that label — try those names as textboxes before the
        // positional sibling.
        for (const label of fieldNamesIn(intent)) {
          const byLabel = `role=textbox[name=${JSON.stringify(label)} i]`;
          try {
            const input = this.page.locator(byLabel).first();
            if ((await this.page.locator(byLabel).count()) !== 1) continue;
            const kind = await input
              .evaluate((el) => ((el as unknown as { type?: string; readOnly?: boolean }).readOnly ? 'readonly' : ((el as unknown as { type?: string }).type ?? '').toLowerCase()), undefined, { timeout: this.#fastTimeoutMs })
              .catch(() => 'readonly');
            if (kind === 'readonly') continue;
            const asDate = kind === 'date' ? isoDateOf(entry) : null;
            if (kind === 'date' && asDate === null) continue;
            await input.fill(asDate ?? entry, { timeout: this.#fastTimeoutMs });
            this.bundle.note(
              `${selector}: the visible field is a read-only display; filled the input the label ` +
                `"${label}" points at (${byLabel})` + (asDate !== null && asDate !== entry ? ` as ${asDate}` : ''),
            );
            return { value: undefined, resolution: 'narrow', resolvedSelector: byLabel };
          } catch (error) {
            attempts.push(`label-input "${byLabel}": ${describe(error)}`);
          }
        }
        if (shell.sibling !== null) {
          try {
            const target = this.page.locator(shell.sibling).first();
            const asDate = shell.siblingType === 'date' ? isoDateOf(entry) : null;
            if (shell.siblingType === 'date' && asDate === null) {
              attempts.push(`shell-input "${shell.sibling}": a date input, but ${JSON.stringify(entry)} is not an unambiguous date`);
            } else {
              await target.fill(asDate ?? entry, { timeout: this.#fastTimeoutMs });
              this.bundle.note(
                `${selector}: the visible field is a read-only display over the real input; ` +
                  `filled the input beneath it (${shell.sibling})` +
                  (asDate !== null && asDate !== entry ? ` as ${asDate}` : ''),
              );
              return { value: undefined, resolution: 'narrow', resolvedSelector: shell.sibling };
            }
          } catch (error) {
            attempts.push(`shell-input "${shell.sibling}": ${describe(error)}`);
          }
        } else {
          attempts.push('read-only: no editable input beside it');
        }
      }
    }
    if (readOnlyShell) {
      // Nothing between here and the agent can make a read-only field
      // writable; skipping those rungs is what turns a 90-second miss into a
      // few seconds — and the agent may know the control's own way in.
      const entered = await this.#agentEnter(action, selector, intent, entry, attempts);
      if (entered !== null) return entered;
      const failure = new StepResolutionError(selector, attempts);
      throw failure;
    }

    // 1.03. **A calendar behind a button** (EH-11, 2026-09-03).
    //
    // humi's `DateField` is a `<button aria-haspopup="dialog">` showing the
    // date it holds; the value is chosen in a portaled `role=dialog` calendar
    // — day buttons named by their number, month nav, a month view. `fill`
    // on a button fails ("not an <input>"), `type` and `paste` are refused,
    // the shell rung above applies only to a read-only INPUT, so every such
    // date (BE Effective Start/End, PY-Config effective dates, probation
    // Extended/Confirm dates — ~150 rows) went to the agent, one model call
    // per field, guessing at day buttons. The driver (`engine/calendar.ts`)
    // is deterministic: convert the value with the flow's locale, open, walk
    // the months, click the day, read the trigger back. A day the picker
    // disables is the page's rule about the date, a state verdict.
    if (entry !== undefined && (action === 'fill' || action === 'type' || action === 'fillRetry')) {
      const trigger = await this.#calendarTrigger(selector);
      if (trigger !== null) {
        const iso = isoDateOf(entry, this.#locale);
        if (iso === null) {
          attempts.push(
            `calendar: "${selector}" opens a calendar dialog, but ${JSON.stringify(entry)} is not an unambiguous date ` +
              `(accepted: YYYY-MM-DD, 1 Sep 2027, Sep 1, 2027, 15 ก.ย. 2569, dd/mm/yyyy under locale th/en-GB, {{date:today+30d}})`,
          );
        } else {
          try {
            const picked = await pickDateInDialog(this.page, trigger, iso, { timeout: this.#healedTimeoutMs });
            this.bundle.note(
              `${selector}: a calendar dialog — picked ${iso} via ${picked.via} (${picked.navigated} month step(s)); ` +
                `the field now shows ${JSON.stringify(picked.shown ?? '')}` +
                (picked.confirmed ? '' : ' — which does not read as that date'),
            );
            if (!picked.confirmed) {
              attempts.push(
                `calendar "${selector}": picked ${iso} but the field shows ${JSON.stringify(picked.shown ?? '')}, which does not render that date`,
              );
            } else {
              return {
                value: undefined,
                resolution: 'narrow',
                resolvedSelector: selector,
                note: { enteredAs: picked.shown, enteredIso: iso, via: `calendar-${picked.via}` },
              };
            }
          } catch (error) {
            attempts.push(`calendar "${selector}": ${describeAttempt(error)}`);
            // A disabled day is the picker's own verdict about the date
            // (`DateOutOfRangeError`) — nothing below can move a min/max.
            if (isStateContradiction(attempts[attempts.length - 1] ?? '')) {
              throw new StepResolutionError(selector, attempts);
            }
          }
        }
      }
    }

    // 1.05. Known dead end — $0, and a stop.
    //
    // This exact selector already exhausted the whole ladder on this exact
    // page earlier in this run. One fresh fast attempt above is the honest
    // price (the page may have changed state); repaying the free rungs plus a
    // healer call for an identical answer is not. PB-02-01 walked the same
    // three-step login block through the full ladder three times over —
    // nine ladder walks and nine model calls for one fact. Never persisted:
    // the negative result belongs to this run's page, not to the next run's.
    // The key keeps `?step=2` and the stepper's current label (EH-15): two
    // wizard forms on one route are two pages.
    const deadKey = await this.#deadEndKey(selector);
    const priorDeadEnd = this.#deadResolutions.get(deadKey);
    if (priorDeadEnd !== undefined) {
      // A repeated CONTENT mismatch is not a dead end: the element resolves
      // and the fresh fast attempt above just re-read it. The ladder is still
      // not repaid — the answer cannot change — but the failure keeps its
      // content-only classification, so the run stays a VERDICT (`failed` →
      // the near-miss gate → the judge) instead of a dead-end that buries a
      // wording question (be100 PL_02_07, live: "Benefit Plans" against a
      // breadcrumb reading "Benefit Plan Catalog" was retried once, memoed,
      // and the dead-end status then hid the mismatch from the judge).
      attempts.push(
        priorDeadEnd.contentMiss
          ? `known content mismatch: step ${priorDeadEnd.step} already read this element on this ` +
              "same page — not repaid; the text has not changed, and the wording is the judge's to rule on"
          : `known dead end: identical failure at step ${priorDeadEnd.step} on this same page — ` +
              'not repaid; the page has not changed its answer, fix the flow',
      );
      throw new StepResolutionError(selector, attempts);
    }

    // 1.1. Non-standard syntax sanitizer (e.g. StaticText[name="X"] -> text="X")
    const sanitized = sanitizeSelector(selector);
    if (sanitized !== selector) {
      try {
        const value = await run(this.page.locator(sanitized), this.#fastTimeoutMs);
        return { value, resolution: 'case', resolvedSelector: sanitized };
      } catch (error) {
        attempts.push(`sanitized "${sanitized}": ${describe(error)}`);
      }
    }

    // 1.2. Case-relaxed retry — still $0, still the author's own selector.
    //
    // Chrome computes an accessible name with CSS `text-transform` applied;
    // Playwright's `role=` matcher does not. A control styled
    // `text-transform: uppercase` is therefore captured as "DUE SOON …" and
    // matched against "Due soon …", and matches nothing at any timeout. This
    // rung retries the same selector with the name compared case-insensitively.
    //
    // It sits above healing for the same reason dialog dismissal does, and it
    // is not that it is cheaper: the healer reads the *same* AX tree, so it
    // would propose the same name and reject its own correct answer at the
    // verify step, having spent a call. Only re-matching the author's selector
    // can fix a mismatch that lives in the matcher rather than in the page.
    //
    // Generated flows already carry the flag (see `src/engine/selector.ts`),
    // so in practice this rescues hand-authored and pre-existing flows.
    const relaxed = relaxRoleName(selector);
    if (relaxed) {
      try {
        const value = await run(this.page.locator(relaxed), this.#fastTimeoutMs);
        return { value, resolution: 'case', resolvedSelector: relaxed };
      } catch (error) {
        attempts.push(`case "${relaxed}": ${describe(error)}`);
      }
    }

    // 1.25. **Collapsed section** — still $0, still the author's own selector.
    //
    // A form that folds its sections (an accordion card, a closed <details>,
    // an inactive tab) has the control in the DOM and out of the tree: `role=`
    // selectors skip hidden elements, and the healer reads the same tree the
    // control is missing from, so it can only propose a control that is not
    // there either. Live (ec10 HIR-EC-002, 2026-09-02): Gender sits inside the
    // hire form's collapsed "Personal Information" card; the agent tried
    // `button` and `combobox` by that name for five turns and stalled. If the
    // selector matches once hidden elements are included, the disclosure that
    // owns the hidden ancestor (aria-controls, the header beside it, the
    // <summary>, the tab) is clicked — the click a person makes — and the
    // author's own selector is run again. See `engine/reveal.ts`.
    const revealed = await revealHidden(this.page, selector);
    if (revealed !== null) {
      const via = revealed.disclosures.join(', ');
      if (revealed.revealed) {
        try {
          const value = await run(this.page.locator(selector), this.#fastTimeoutMs);
          this.bundle.note(`${selector}: inside a collapsed section — expanded "${via}" to reach it`);
          return { value, resolution: 'reveal', resolvedSelector: selector };
        } catch (error) {
          attempts.push(`reveal (expanded "${via}") "${selector}": ${describe(error)}`);
        }
      } else {
        attempts.push(`reveal: expanded "${via}" but "${selector}" stayed hidden`);
      }
    }

    // 1.26. **The option lives in a closed popup** (EH-14, 2026-09-03).
    //
    // "VNM ไม่สามารถกดเลือกได้ (disabled)" (TC_SSO_038, TC_WT_032/035,
    // TC_TAX_061, TC_SEV_026/034/037) is a claim about an option INSIDE a
    // listbox that is not open, and the reveal rung above only opens
    // disclosures. For an assertion headed by a popup-only role, the one
    // closed popup trigger the intent names (or the only one on the page)
    // is opened — a click a person makes — and the author's own selector is
    // run again. The list is left open: an assertion reads it, and the next
    // step's own guard knows an open trigger is not clicked twice.
    if (
      (action === 'expectDisabled' || action === 'expectEnabled' || action === 'expectVisible' || action === 'expectCount') &&
      targetsPopupContent(selector)
    ) {
      const opened = await this.#openPopupFor(intent);
      if (opened !== null) {
        try {
          const value = await run(this.page.locator(selector), this.#fastTimeoutMs);
          this.bundle.note(`${selector}: inside a closed popup — opened the "${opened}" list to read its options`);
          return { value, resolution: 'reveal', resolvedSelector: selector };
        } catch (error) {
          attempts.push(`open-popup (opened "${opened}") "${selector}": ${describeAttempt(error)}`);
          if (isStateContradiction(attempts[attempts.length - 1] ?? '')) {
            throw new StepResolutionError(selector, attempts);
          }
        }
      }
    }

    // 1.12. Volatile greeting — the same assertion, minus the time of day.
    //
    // "Good afternoon, ผู้ดูแลระบบ" was authored as the sign-in proof, and the
    // page — on a clock the flow itself pinned to midnight with `setClock` —
    // said "Good morning, ผู้ดูแลระบบ". Six cases of one catalog failed on
    // that single line (ec10, 2026-09-02) about an application that had
    // signed the admin in perfectly well. The greeting is not the fact; the
    // name after it is, so the selector is re-matched on the name alone. Free,
    // deterministic, and recorded as `narrow` — re-matched against the page
    // text — so the report says the wording moved.
    const ungreeted = withoutGreeting(selector);
    if (ungreeted) {
      try {
        const value = await run(this.page.locator(ungreeted), this.#fastTimeoutMs);
        this.bundle.note(
          `${selector}: matched on the name alone — the page greets by time of day, and ` +
            `the greeting is not the fact this step proves (resolved as ${ungreeted})`,
        );
        return { value, resolution: 'narrow', resolvedSelector: ungreeted };
      } catch (error) {
        attempts.push(`greeting "${ungreeted}": ${describe(error)}`);
      }
    }

    // 1.15. Bare role — the same selector, with the `role=` it forgot to say.
    //
    // `textbox >> nth=1` and `button[name="Save"]` are *valid* selectors:
    // Playwright reads the leading token as a CSS tag name. There is no
    // `<textbox>` element and no `<button name="Save">`, so they resolve
    // nothing on every page at any timeout, and the step reads as "the control
    // is missing" about an application that is fine.
    //
    // Free, deterministic, and above healing for the same reason as the case
    // rung: this is the author's own selector, and re-matching it is the only
    // move that cannot change what the test exercises. Generated flows now
    // carry the prefix (see `src/engine/selector.ts`), so this rescues the
    // hand-authored and already-written ones — which is how PB_02_01's login
    // came to spend twenty-six steps on the sign-in page.
    const qualified = qualifyBareRole(selector);
    if (qualified) {
      try {
        const value = await run(this.page.locator(qualified), this.#fastTimeoutMs);
        return { value, resolution: 'case', resolvedSelector: qualified };
      } catch (error) {
        attempts.push(`bare-role "${qualified}": ${describe(error)}`);
      }
      // A qualified selector can still carry a case mismatch, and paying one
      // more free attempt here beats paying the healer.
      const both = relaxRoleName(qualified);
      if (both) {
        try {
          const value = await run(this.page.locator(both), this.#fastTimeoutMs);
          return { value, resolution: 'case', resolvedSelector: both };
        } catch (error) {
          attempts.push(`bare-role+case "${both}": ${describe(error)}`);
        }
      }
    }

    // 1.3. Ambiguous-match narrowing — still $0, still the author's own text.
    //
    // Playwright's unquoted `text=…` is a *substring* match, so `text=4 days`
    // resolves "Overdue 54 days", "≤ 14 days · near due" and the row that
    // actually says "4 days" all at once, and strict mode correctly refuses to
    // pick one. Read as a verdict that is exactly backwards: the text being
    // asserted is on the page — more places than the author knew — and the
    // step reports "could not resolve". Healing cannot fix it for the same
    // reason as a case mismatch: the model would propose the same text and
    // then reject its own multi-match answer at the verify step.
    //
    // Two narrowings, both deterministic, both only after a strict-mode
    // violation (a plain not-found means the text is genuinely absent and
    // must stay a failure):
    //
    //   1. Exact form — `text="4 days"` matches whole normalised text, which
    //      is precisely what the author observed when the step was written.
    //   2. Presence assertions only, still ambiguous — take the first
    //      *visible* match. Safe here and nowhere else: every text-engine
    //      match contains the asserted text by construction, so "this text is
    //      shown" is satisfied by any of them. A click gets no such rung —
    //      acting on "whichever matched first" changes what the test does.
    const lastAttempt = attempts[attempts.length - 1] ?? '';
    if (isTextSelector(selector) && lastAttempt.includes('strict mode violation')) {
      const exact = exactTextSelector(selector);
      if (exact) {
        try {
          const value = await run(this.page.locator(exact), this.#fastTimeoutMs);
          return { value, resolution: 'narrow', resolvedSelector: exact };
        } catch (error) {
          attempts.push(`narrow "${exact}": ${describe(error)}`);
        }
      }
      if (PRESENCE_ACTIONS.has(action)) {
        const anyVisible = `${exact ?? selector} >> visible=true >> nth=0`;
        try {
          const value = await run(this.page.locator(anyVisible), this.#fastTimeoutMs);
          return { value, resolution: 'narrow', resolvedSelector: anyVisible };
        } catch (error) {
          attempts.push(`narrow "${anyVisible}": ${describe(error)}`);
        }
      }
    }

    // 1.35. Over-exact text — the same rung's mirror, and the same $0 move.
    //
    // Playwright's quoted `text="X"` matches an element's WHOLE normalised
    // text, so it resolves nothing the instant the page renders that value
    // with anything around it. Adjudicated live on DB_07_01: the flow asserted
    // `text="75,000"` and the app renders `฿{v.toLocaleString('th-TH', {
    // minimumFractionDigits: 2 })}` — `฿75,000.00`. The number was on screen
    // the whole time; the step reported "could not resolve" and two `high`
    // defects were filed against a working application. The healer cannot help
    // for the same reason it cannot help with a case mismatch: it reads the
    // same page and proposes the same text.
    //
    // Gated on a plain not-found (a strict-mode violation means the text is
    // already ambiguous, and rung 1.3 above is the correct answer there), and
    // on PRESENCE assertions only — the rule rung 1.3 already states for its
    // own any-of half: a text-engine match contains the asserted text by
    // construction, so "this text is shown" is satisfied by any of them, while
    // a click acting on a loosened match would change what the test exercises.
    if (
      isTextSelector(selector) &&
      PRESENCE_ACTIONS.has(action) &&
      !lastAttempt.includes('strict mode violation')
    ) {
      const loose = relaxTextSelector(selector);
      if (loose) {
        // Ambiguity is expected here — the whole point is that the page wraps
        // the value in more text — so the first visible match is taken in the
        // same breath rather than as a second rung.
        for (const candidate of [loose, `${loose} >> visible=true >> nth=0`]) {
          try {
            const value = await run(this.page.locator(candidate), this.#fastTimeoutMs);
            await this.#flagOverExactText(selector, candidate);
            return { value, resolution: 'narrow', resolvedSelector: candidate };
          } catch (error) {
            attempts.push(`relax "${candidate}": ${describe(error)}`);
          }
        }
      }
    }

    // 1.36. Over-exact accessible name — 1.35's mirror for role selectors.
    //
    // `role=option[name="New Hire" i]` demands an option whose WHOLE name is
    // "New Hire"; humi renders it as "H_NEWHIRE — New Hire" (code and label),
    // so the presence claim failed at every timeout, paid the healer and the
    // agent, and dead-ended — three times in one case (ec10 HIR-EC-029,
    // 2026-09-02) for options that were on screen. Presence assertions only,
    // the same rule as 1.35, and the name is matched as a WHOLE WORD inside
    // the longer name (unicode boundaries: "Male" is not inside "Female").
    if (PRESENCE_ACTIONS.has(action) && !lastAttempt.includes('strict mode violation')) {
      const loose = containsRoleName(selector);
      if (loose) {
        // Ambiguity is expected — "Migration" is a whole word in both "DM —
        // DATA MIGRATION" and "HIREDM — HIRE - DATA MIGRATION" — and a
        // presence claim is satisfied by any of them, so the first visible
        // match is taken in the same breath, as 1.35 does.
        for (const candidate of [loose, `${loose} >> visible=true >> nth=0`]) {
          try {
            const value = await run(this.page.locator(candidate), this.#fastTimeoutMs);
            await this.#flagOverExactName(selector, candidate);
            return { value, resolution: 'narrow', resolvedSelector: candidate };
          } catch (error) {
            attempts.push(`relax "${candidate}": ${describe(error)}`);
          }
        }
      }
    }

    // 1.37. **A row named by one of its cells** (EH-04, 2026-09-03).
    //
    // Playwright's `role=row` accessible name is the concatenation of every
    // cell, so `role=row[name="TH_MED_005"]` is over-exact by construction —
    // and the sheets address rows by one cell on ~330 rows ("กดไอคอนดินสอ
    // ของ Plan PL_07_01", "กด Open case ของ Employee ID …"). Rung 1.36 covers
    // presence claims; an ACTING step (`click role=row[…] >> role=button`)
    // dead-ended. The one loosening an acting step gets: the HEAD's name as
    // a whole word, and only when exactly ONE row answers to it — two rows
    // is still ambiguous, and acting on "whichever matched first" would
    // change what the test exercises.
    if (!PRESENCE_ACTIONS.has(action) && !lastAttempt.includes('strict mode violation')) {
      const head = headRoleOf(selector);
      if (head === 'row' || head === 'cell' || head === 'gridcell' || head === 'listitem') {
        const loose = containsRoleName(selector);
        if (loose) {
          const headOnly = loose.split(/\s*>>\s*/)[0] ?? loose;
          const rows = await this.page.locator(headOnly).count().catch(() => 0);
          if (rows === 1) {
            try {
              const value = await run(this.page.locator(loose), this.#fastTimeoutMs);
              this.bundle.note(
                `${selector}: the ${head}'s name is every cell joined — matched ${JSON.stringify(selectorName(selector) ?? '')} ` +
                  `as a whole word of the one ${head} that holds it (resolved as ${loose})`,
              );
              return { value, resolution: 'narrow', resolvedSelector: loose };
            } catch (error) {
              attempts.push(`row-scope "${loose}": ${describeAttempt(error)}`);
            }
          } else if (rows > 1) {
            attempts.push(
              `row-scope "${headOnly}": ${rows} ${head}s contain ${JSON.stringify(selectorName(selector) ?? '')} — ambiguous, so no ${head} was acted on`,
            );
          }
        }
      }
    }

    // 1.5. Blocking-dialog recovery — still $0. A surprising share of
    // "selector" failures are really "something is blocking the page"
    // failures: a cookie banner, a promo modal, a newsletter signup,
    // appearing after the page settles. If one showed up, dismiss it and
    // retry the ORIGINAL selector once before paying for a heal — a heal
    // here would either fail the same way, or worse, "successfully" repair
    // onto a control inside the dialog itself.
    //
    // EXCEPT when the dialog is the flow's OWN context: one opened by the
    // previous interaction — a click, a keypress, and since 2026-09-03
    // (EH-02) a fill, a selectOption, a check inside it — or one that holds
    // the very control this step is aimed at. Dismissing it destroys the
    // state the test built (seen live: the ladder closed a deliberately-
    // opened "Edit rule" dialog, and every later step failed downstream of
    // the wreckage; BE's Create Plan popup discards the whole form on
    // "Cancel"). Left open, the failing step still fails honestly, and the
    // healer then reads a tree that CONTAINS the dialog — which is exactly
    // where the right candidate lives.
    {
      const openNow = await openDialogNow(this.page);
      if (openNow) {
        const context = dialogIsIntendedContext(this.#lastAction, this.#lastActionFailed)
          ? `opened by the previous ${this.#lastAction}`
          : (await selectorInsideDialog(openNow, selector))
            ? 'holding the very control this step is aimed at'
            : null;
        if (context !== null) {
          attempts.push(
            `dialog: a "${await describeDialog(openNow).catch(() => 'dialog')}" ${context} ` +
              'is treated as the intended context, not a blocker — not dismissed',
          );
        } else {
          const dialog = await this.#dismissBlockingDialog(openNow);
          if (dialog) {
            try {
              const value = await run(this.page.locator(selector), this.#fastTimeoutMs);
              return { value, resolution: 'dialog', resolvedSelector: selector, dialog };
            } catch (error) {
              attempts.push(`fast (after dismissing "${dialog.name}") "${selector}": ${describe(error)}`);
            }
          }
        }
      }
    }

    // 1.6. Non-ARIA overlay — still $0, and still evidence, not guesswork.
    //
    // The ARIA rung above can only see `role=dialog`; a Semantic-UI dimmer, a
    // hand-rolled promo, a PDPA strip carry no such role and were the
    // detector's documented blind spot. But when one of them blocks a click,
    // Playwright *names it* in the failure ("<div class=…> intercepts pointer
    // events") — so this rung acts only on that named element: a dismiss
    // control inside it if one is recognisable, else Escape, then the
    // author's own selector retried once. Found live on homepro.co.th, whose
    // promo dimmer swallowed every click on the page behind it.
    if (intercepted !== null) {
      // 1.55. **A fixed or sticky bar over the target — scroll clear of it.**
      //
      // Playwright scrolls a target into view before clicking, to the nearest
      // edge — and a sticky top bar then sits exactly over it. The overlay
      // rung below would press Escape (closing the very listbox the flow had
      // just opened) and retry under the same bar. Live (ec10 HIR-EC-029,
      // 2026-09-02): "div.humi-topbar intercepts pointer events" on the Event
      // Reason trigger, four steps in a row. The bar is not a dialog and has
      // nothing to dismiss; the target only needs to be in the middle of the
      // viewport, which is where a person would have scrolled it.
      const bar = await this.#stickyBar(intercepted);
      if (bar !== null) {
        try {
          await this.page
            .locator(selector)
            .first()
            .evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }), undefined, {
              timeout: this.#fastTimeoutMs,
            });
          const value = await run(this.page.locator(selector), this.#fastTimeoutMs);
          this.bundle.note(`${selector}: was under the fixed "${bar}" bar — scrolled it to the middle of the viewport`);
          return { value, resolution: 'scroll', resolvedSelector: selector };
        } catch (error) {
          attempts.push(`scroll (clear of "${bar}") "${selector}": ${describe(error)}`);
        }
      }
      const overlay = await this.#clearInterceptingOverlay(intercepted);
      if (overlay) {
        try {
          const value = await run(this.page.locator(selector), this.#fastTimeoutMs);
          return { value, resolution: 'dialog', resolvedSelector: selector, dialog: overlay };
        } catch (error) {
          attempts.push(
            `fast (after clearing "${overlay.name}" via ${overlay.button}) "${selector}": ${describe(error)}`,
          );
        }
      }
    }

    const cacheKey = CacheManager.key(this.page.url(), selector);

    // 2. Previously healed selector — also $0.
    const cached = this.#cache.get(cacheKey);
    if (cached) {
      try {
        const value = await run(this.page.locator(cached.healed), this.#healedTimeoutMs);
        this.#cache.recordUse(cacheKey);
        return { value, resolution: 'cache', resolvedSelector: cached.healed };
      } catch (error) {
        // A stale repair is worse than none — drop it and let the healer retry.
        attempts.push(`cache "${cached.healed}": ${describe(error)}`);
        this.#cache.delete(cacheKey);
      }
    }

    // 2.5. Backend check — still $0, and it is a *stop*, not another attempt.
    //
    // If a request the page made has already failed hard (5xx, dropped
    // connection, expired session), the control this step wants probably never
    // rendered because the data behind it never arrived. Healing here can only
    // do one of two things: fail identically, having spent a token, or
    // "successfully" repair onto whatever the app rendered instead — usually
    // an error banner or an empty state. The second outcome is strictly worse
    // than failing, because the suite goes green while checking the wrong
    // thing. Same reasoning that puts dialog dismissal ahead of healing.
    const blocking = netMark === undefined ? [] : this.#networkEvidence(netMark).failures;
    if (blocking.length > 0) {
      this.bundle.noteBackendBlocked();
      attempts.push(
        `backend: ${blocking.length} request(s) failed while this step was waiting ` +
          `(${describeCall(blocking[0]!)}${blocking.length > 1 ? ', …' : ''}) — ` +
          'no repair attempted, the selector is not the problem',
      );
      throw new StepResolutionError(selector, attempts);
    }

    // 2.5. Stranded on a sign-in page — a stop, not another attempt.
    //
    // The step began somewhere legitimate and the application redirected
    // mid-step, so the guard that runs before each step could not have caught
    // it. Healing from here is the worst available move: the AX tree the
    // healer reads is the *login page*, so it proposes a login control,
    // verifies that it resolves to exactly one element, and reports the step
    // green. That is not a repaired test — it is a test that now checks the
    // sign-in screen. Seen exactly once and it produced
    // `waitFor role=heading[name="Sign in"] … passed (jit)`.
    //
    // Same shape as the backend rung above: when the precondition is gone, a
    // repair can only fail identically or succeed against the wrong thing.
    const stranded = this.#strandedMessage();
    if (stranded !== null) {
      attempts.push(`declined to heal: ${stranded.split('\n')[0] ?? stranded}`);
      throw new StepResolutionError(selector, attempts);
    }

    // 2.6. Denied surface — a stop, not another attempt.
    //
    // If the page is showing an authorization failure, the control this step
    // wants is not late and not renamed: the page has answered a different
    // question. Healing from here can only fail identically or repair onto
    // the denial page's own furniture — PB-02-01's healer dutifully proposed
    // `role=heading[name="ไม่มีสิทธิ์เข้าถึง · Access Denied"]` and the run threw
    // that diagnosis away as a low-confidence repair. The denial heading is
    // the finding; it goes on the step as page context and into the defect
    // table as `authorization`, and no token is spent repairing around it.
    //
    // A flow that *means* to test the denial page never reaches this rung:
    // its assertions name the denial content and resolve on the fast path.
    const denial = await this.#denialSurface();
    if (denial !== null) {
      attempts.push(
        `authorization: the page is showing "${denial}" — no repair attempted, ` +
          'the selector is not the problem; the run is not permitted to see this page',
      );
      this.#recordRuntimeDefect(
        'authorization',
        'high',
        `The page answered with "${denial}"`,
        `While resolving "${selector}" the page was showing an authorization failure. ` +
          'The signed-in identity cannot see this surface — fix the flow to sign in as ' +
          'the right persona (navigate to the sign-in page before switching identity), ' +
          'or grant the account access. No selector change can fix this.',
        selector,
      );
      const failure = new StepResolutionError(selector, attempts);
      failure.pageContext = [denial];
      throw failure;
    }

    // 2.62. **The application's own not-found page** (EH-09, 2026-09-03).
    //
    // A Next.js app answers a client-side click into a stale route with its
    // `not-found.tsx` rendered IN PLACE, status 200 — humi's eyebrow "404 —
    // ไม่พบหน้าที่ค้นหา", h1 "หน้านี้ถูกย้ายหรือลบไปแล้ว". `#judgeNavigationStatus`
    // sees only a goto's HTTP status, so nothing read it: every step after
    // "View Details → 404" (HIR-EC-002, BUG 71887) walked the whole ladder,
    // the healer proposed the 404 page's own links, and the run read as
    // "controls missing". The heading IS the finding: a `failed` verdict
    // with the page as evidence, one defect per URL, no token spent.
    const missing = await notFoundSurface(this.page);
    if (missing !== null) {
      attempts.push(
        `not-found: the page is showing "${missing.heading}" at ${missing.url} — ` +
          'the application navigated to a page it does not have; no repair attempted',
      );
      const notFoundKey = `${this.#active.label ?? ''} :: ${missing.url}`;
      if (!this.#notFoundReported.has(notFoundKey)) {
        this.#notFoundReported.add(notFoundKey);
        this.#recordRuntimeDefect(
          'functional',
          'high',
          `The application led the run to a missing page: ${missing.url}`,
          `While resolving "${selector}" the page was showing ${JSON.stringify(missing.heading)} (read from its ${missing.via}). ` +
            'The action before this step navigated to a route the application does not serve — a broken link ' +
            'or a stale route in the app, not a selector problem. Every step on this page fails on the same evidence.',
          selector,
        );
      }
      const failure = new StepResolutionError(selector, attempts, {
        verdict: 'the page is the application\'s not-found page',
      });
      failure.pageContext = [missing.heading];
      throw failure;
    }

    // 2.65. **The text is nowhere on the page** (EH-06, 2026-09-03).
    //
    // A presence claim whose text is in no visible text of the page — after
    // the quoted-text and whole-word rungs above have already conceded the
    // shapes a page renders a value in — is either genuinely absent or held
    // by an element that renders it in a way innerText cannot see. One $0
    // read tells those apart, and the failure path was already making it —
    // AFTER the healer (which can only echo, or propose a container) and the
    // agent's look had been paid: 20–40 s per failing assertion, three per
    // failing case (already-done.md, item 5). The page gets ONE patience
    // window first, exactly the one rung 2.7 would have spent, so late text
    // is never called absent; then the reading stands as the verdict.
    // `expectAnyVisible` is left to rung 2.7: only its first selector reaches
    // the ladder, and absence of ONE alternative says nothing about the rest.
    const absenceWanted =
      (PRESENCE_ACTIONS.has(action) && action !== 'expectAnyVisible') || action === 'expectCount'
        ? action === 'expectText' && expected !== undefined
          ? [expected]
          : [selectorName(selector) ?? '']
        : [];
    const absenceNames = absenceWanted.map((w) => w.trim()).filter((w) => w !== '');
    if (absenceNames.length > 0 && !(await this.#anyNameOnPage(absenceNames))) {
      const window = patience ?? this.#healedTimeoutMs;
      try {
        const value = await run(this.page.locator(selector), window);
        this.#recordRuntimeDefect(
          'functional',
          'medium',
          `Slower than the fast-path budget: ${selector}`,
          `This step only passed when given ${window}ms — the content renders, ` +
            `but not within the ${this.#fastTimeoutMs}ms fast path. The feature works; the page ` +
            'is slow (or hydrates late). Worth fixing before the budget hides a real regression.',
          selector,
        );
        return { value, resolution: 'late', resolvedSelector: selector };
      } catch (error) {
        attempts.push(`late "${selector}" (${window}ms): ${describeAttempt(error)}`);
        if (isStateContradiction(attempts[attempts.length - 1] ?? '')) {
          throw new StepResolutionError(selector, attempts);
        }
      }
      if (!(await this.#anyNameOnPage(absenceNames))) {
        const quoted = absenceNames.map((w) => JSON.stringify(w)).join(', ');
        attempts.push(
          `absence: ${quoted} is not in the page's visible text — no repair can find it; the claim fails on the page as it stands`,
        );
        throw new StepResolutionError(selector, attempts, { verdict: 'the text is not on the page' });
      }
    }

    // 2.7. Patience — the author's own selector, one more window, free.
    //
    // A presence assertion against a hydrating page loses by construction:
    // `body` resolves instantly on a shell that has not rendered the content
    // yet, so the fast window closes on the wrong page state and every later
    // rung reasons about that same wrong state. PB-05-01's detail page
    // renders its content ~3s after the route commits; the assertion died at
    // 2s and a working feature filed a defect. One more attempt at the healed
    // timeout is strictly cheaper than the model call the jit rung is about
    // to make, cannot change what the test exercises (it is the author's own
    // selector), and when it passes the run still records a timing defect —
    // "passed, slower than the budget" is a finding, not a free pass.
    //
    // Presence actions only: a click that needs ten seconds is a different
    // kind of slow, and acting late is not the same as observing late.
    // `expectCount` belongs here too — any expectCount that reaches the
    // ladder claims count > 0 (a zero-count expectation runs through
    // `#bareStep`, off the ladder entirely), which is a presence claim about
    // several things instead of one.
    //
    // A step that DECLARED its own patience (`timeoutMs`, EH-07) gets that
    // window here instead of the healed timeout — a payroll run, an import
    // that reports "Completed" minutes later — and when it expires the wait
    // is the verdict: a declared wait that ran out is a fact about time, not
    // about a selector, and neither the healer nor the agent is paid for it.
    if (PRESENCE_ACTIONS.has(action) || action === 'waitFor' || action === 'expectCount' || patience !== undefined) {
      const window = patience ?? this.#healedTimeoutMs;
      try {
        const value = await run(this.page.locator(selector), window);
        this.#recordRuntimeDefect(
          'functional',
          'medium',
          `Slower than the fast-path budget: ${selector}`,
          `This step only passed when given ${window}ms — the content renders, ` +
            `but not within the ${this.#fastTimeoutMs}ms fast path. The feature works; the page ` +
            'is slow (or hydrates late). Worth fixing before the budget hides a real regression.',
          selector,
        );
        return { value, resolution: 'late', resolvedSelector: selector };
      } catch (error) {
        attempts.push(`late "${selector}" (${window}ms): ${describeAttempt(error)}`);
        // The patience window resolved the element and read the claim wrong
        // (HIR-EC-029: fast timed out while the list opened; late counted 51
        // against 3). That reading is the verdict — see 1.01; nothing below
        // can change it, and everything below costs time or a model call.
        if (isStateContradiction(attempts[attempts.length - 1] ?? '')) {
          throw new StepResolutionError(selector, attempts);
        }
        if (patience !== undefined) {
          attempts.push(
            `jit: skipped — the step declared its own patience (${patience}ms) and it expired; ` +
              'a declared wait that ran out is a verdict about time, not a selector',
          );
          throw new StepResolutionError(selector, attempts, {
            verdict: `the declared wait of ${patience}ms ran out`,
          });
        }
        // Either/or (CG-08): every alternative was polled through the
        // window as written; none showing is the answer, and a heal of the
        // first alternative alone would prove nothing about the rest.
        if (action === 'expectAnyVisible') {
          attempts.push('jit: skipped — none of the alternatives is visible after the patience window; the request accepts either outcome and the page shows neither');
          throw new StepResolutionError(selector, attempts, { verdict: 'none of the alternatives is visible' });
        }
      }
    }

    // 2.9. **Kin — $0.** The selector resolved every time and only its TEXT
    // missed: the element is right and the answer is beside it, not in it.
    // A summary card is a label and a value in separate elements, so
    // `text=Total plans` can never contain "75" however long it is given.
    // Climbing to the card and comparing there is what an author writes by
    // hand as `>> xpath=..`, and it costs nothing — so it belongs before the
    // healer, which on this exact shape proposed `text="68"` (find an element
    // containing the answer: circular) at 0.20 confidence and was rightly
    // refused. Only for a content miss, and only two levels: climb far enough
    // and every assertion passes against `body`.
    if (attempts.length > 0 && attempts.every(isContentMiss)) {
      for (const kin of ancestorSelectors(selector)) {
        try {
          const value = await run(this.page.locator(kin).first(), this.#fastTimeoutMs);
          this.#recordRuntimeDefect(
            'usability',
            'low',
            `The value is beside the label, not inside it: ${selector}`,
            `"${selector}" resolves the label alone, whose text can never contain the expected ` +
              `value; "${kin}" holds both and the claim holds there. Write the assertion against ` +
              'the container (the card, the row, the tile) so the run stops rediscovering it.',
            selector,
          );
          return { value, resolution: 'kin', resolvedSelector: kin };
        } catch (error) {
          attempts.push(`kin "${kin}": ${describe(error)}`);
        }
      }
    }

    // 3. **Control plane — where determinism ends, and it ends in two calls.**
    //
    // The standing rule (2026-08-26, asked for directly): a step whose
    // deterministic ladder has failed gets ONE look and, at most, ONE repair.
    // `#agentTriage` owns both and can spend no more.
    //
    // The healer keeps its place ahead of that for the one thing it is good
    // at — a WRONG SELECTOR on the right page. It reads a static tree and
    // proposes a different string, which is exactly the wrong tool for a
    // CONTENT miss: measured (be100 PL_03_01), asked why `text=Total plans`
    // did not contain "75", it proposed `text="68"` — find an element
    // containing the expected value, which is circular — at 0.20 confidence,
    // and was rightly refused. So a content miss skips it entirely and goes
    // to the agent, which can look at the page and answer where the value is.
    const contentMiss = attempts.length > 0 && attempts.every(isContentMiss);
    // The healer reads a tree captured with every listbox CLOSED (EH-13): a
    // selector headed by `option`/`menuitem`/`treeitem`, or a `selectOption`
    // whose trigger did open, is a failure the healer can only echo or
    // repair onto the trigger — HIR-EC-029 measured 70 s per such miss.
    const popupTarget =
      targetsPopupContent(selector) ||
      (action === 'selectOption' && attempts.some((line) => /opened .* but no option named/.test(line)));

    if (!contentMiss && popupTarget) {
      attempts.push('jit: skipped — the target lives inside a listbox the healer cannot open');
    } else if (!contentMiss && this.#pageAnswersNothing) {
      attempts.push(
        `jit: skipped — ${this.#unresolvedRun} step(s) in a row could not resolve, so this page is ` +
          'answering for nothing and a repaired selector would fail the same way',
      );
    } else if (!contentMiss) {
      if (!this.#healer) {
        attempts.push('jit: healer disabled');
      } else {
        let outcome: Awaited<ReturnType<JitHealer['heal']>> | null = null;
        try {
          // The most recent attempt is the most direct evidence of what's wrong
          // right now — e.g. a strict-mode violation ("resolved to 126 elements")
          // needs a very different fix than a plain not-found timeout.
          const failureReason = attempts[attempts.length - 1];
          outcome = await this.#healer.heal({
            page: this.page,
            action,
            selector,
            intent,
            failureReason,
            caseContext: this.#caseContext,
            // The value an entry step is putting in: the replacement must be
            // the control that takes it, never a static text (EH-13).
            ...(entry === undefined ? {} : { entry }),
          });
        } catch (error) {
          if (error instanceof HealUnavailableError) {
            // The provider failed, not the page. Counted apart and worded apart:
            // "unavailable" must never read as "the control is absent".
            this.bundle.noteHealUnavailable();
            attempts.push(`jit: unavailable — ${describe(error)} (a provider fact, not a page fact)`);
          } else {
            attempts.push(`jit: ${describe(error)}`);
          }
          // The healer's refused candidates are evidence — carry them onto
          // whatever failure this step ultimately records.
          rejectedHeals = error instanceof HealFailedError ? error.rejectedHeals : undefined;
        }

        if (outcome !== null) {
          const heal: HealRecord = {
            from: selector,
            to: outcome.selector,
            strategy: outcome.suggestion.strategy,
            confidence: outcome.suggestion.confidence,
            reasoning: outcome.suggestion.reasoning,
            model: this.#healer.model.id,
            latencyMs: outcome.latencyMs,
            inputTokens: outcome.suggestion.inputTokens,
            outputTokens: outcome.suggestion.outputTokens,
          };
          try {
            const value = await run(this.page.locator(outcome.selector), this.#healedTimeoutMs);
            await this.#flagTimingHeal(selector, outcome.selector);
            return { value, resolution: 'jit', resolvedSelector: outcome.selector, heal };
          } catch (error) {
            // The selector resolved during verification but the action still
            // failed — don't keep a repair that can't carry the step.
            this.#cache.delete(cacheKey);
            attempts.push(`jit "${outcome.selector}": ${describe(error)}`);
          }
        }
      }
    }

    // 4. **The last rung, and the only one left.** One look; one repair if the
    // look earned it. Returns null when nothing was accepted, and then the
    // step fails on the evidence it has already gathered.
    const triaged = await this.#agentTriage(action, selector, intent, expected, run, attempts);
    if (triaged !== null) return triaged;

    // 5. **Entry of last resort.** Everything above re-runs the AUTHOR'S OWN
    // selector, which is the right rule while the selector is merely hard to
    // reach — and the wrong one when the selector names a control the page
    // does not have. Live (ec10 HIR-EC-001, 2026-09-02): the flow keyed a Hire
    // Date into `role=textbox[name="Select date" i] >> nth=0` and chose an
    // Event Reason from `role=combobox[name="Event Reason" i]`; the agent's
    // look reported, correctly, that no `combobox` role exists on that page at
    // all — the control is a `button`. Three input steps burned 190 seconds
    // and the case never entered a single value, so nothing after it meant
    // anything. Asked for 2026-09-02.
    //
    // So for an INPUT step only, the agent is asked to put the value in by
    // whatever the page actually offers, keyboard and paste included, and the
    // result is judged by READING THE VALUE BACK rather than by re-running a
    // selector already known not to resolve.
    const entered = await this.#agentEnter(action, selector, intent, entry, attempts);
    if (entered !== null) return entered;

    const failure = new StepResolutionError(selector, attempts);
    if (rejectedHeals?.length) failure.rejectedHeals = rejectedHeals;
    throw failure;
  }

  /**
   * Put the value in by whatever the page actually offers — the entry rung.
   *
   * Every other rung ends by re-running the author's own selector, which is
   * exactly right while that selector is merely hard to reach. It is useless
   * when the selector names a control the page does not have: re-running
   * `role=combobox[name="Event Reason" i]` on a page whose Event Reason is a
   * `button` fails however well the agent understood the form.
   *
   * So this rung asks for the OUTCOME rather than the action: set this field
   * to this value, with the whole input vocabulary including keyboard and
   * paste. What decides it is a read-back of the value — from the author's
   * selector if it resolves now, otherwise from the control the agent last
   * acted on. A step that passes here is recorded `agent`, and a runtime
   * defect says the flow's selector needs rewriting, because paying a model
   * to rediscover the same field every run is a cost, not a fix.
   *
   * Gated by `--agent-assist` for the same reason the repair stage is: it
   * types into someone's application.
   */
  /**
   * Is the resolved element a read-only field, and is there an editable input
   * beside it that the label really points at? Bounded, never throws — a page
   * that cannot answer is simply not this case.
   */
  /**
   * The `button[aria-haspopup="dialog"]` the selector resolves to — the
   * trigger of a calendar dialog (humi `DateField`) — or null. The element
   * itself first; then, when the author named the field's label and the
   * selector landed on the label element, the trigger it labels. Bounded,
   * never throws: a page that cannot answer is simply not this case.
   */
  async #calendarTrigger(selector: string): Promise<Locator | null> {
    try {
      const candidate = this.page.locator(selector).first();
      if ((await candidate.count()) === 0) return null;
      const facts = await candidate.evaluate(
        (el) => {
          const node = el as unknown as {
            tagName?: string;
            getAttribute(name: string): string | null;
            control?: { getAttribute(name: string): string | null } | null;
          };
          const own = (node.getAttribute('aria-haspopup') ?? '').toLowerCase();
          if (own === 'dialog') return 'self';
          const labelled = node.control;
          if (labelled && (labelled.getAttribute('aria-haspopup') ?? '').toLowerCase() === 'dialog') return 'control';
          return null;
        },
        undefined,
        { timeout: ATTRIBUTE_READ_TIMEOUT_MS },
      );
      if (facts === 'self') return candidate;
      if (facts === 'control') return this.page.locator(`${selector} >> xpath=.. >> [aria-haspopup="dialog"]`).first();
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Open the one closed popup the step is about (rung 1.26): a trigger with
   * `aria-haspopup` and `aria-expanded="false"` whose accessible name shares
   * a field name with the intent — or the only such trigger on the page.
   * Returns the trigger's name once clicked, else null; never guesses among
   * several unnamed candidates.
   */
  async #openPopupFor(intent: string | undefined): Promise<string | null> {
    try {
      const triggers = this.page.locator(
        '[aria-haspopup="listbox"][aria-expanded="false"], [aria-haspopup="menu"][aria-expanded="false"], [aria-haspopup="true"][aria-expanded="false"]',
      );
      const count = Math.min(await triggers.count(), 12);
      if (count === 0) return null;
      const names = fieldNamesIn(intent).map((n) => foldValue(n));
      const labelled: { locator: Locator; name: string }[] = [];
      for (let i = 0; i < count; i += 1) {
        const one = triggers.nth(i);
        if (!(await one.isVisible().catch(() => false))) continue;
        const name = (
          (await one.getAttribute('aria-label', { timeout: ATTRIBUTE_READ_TIMEOUT_MS }).catch(() => null)) ??
          (await one.innerText({ timeout: ATTRIBUTE_READ_TIMEOUT_MS }).catch(() => ''))
        )
          .replace(/\s+/g, ' ')
          .trim();
        labelled.push({ locator: one, name });
      }
      const byName = labelled.filter((t) => names.some((n) => n !== '' && foldedIncludes(t.name, n)));
      const chosen = byName.length === 1 ? byName[0]! : labelled.length === 1 ? labelled[0]! : null;
      if (chosen === null) return null;
      await chosen.locator.click({ timeout: this.#fastTimeoutMs });
      await this.page.waitForTimeout(300);
      return chosen.name || 'unnamed';
    } catch {
      return null;
    }
  }

  /**
   * Is any of `names` on the page — in its visible text, verbatim or by the
   * sheet's own normalisation, or as a label, placeholder or title (an
   * icon button's only name)? The absence rung's evidence (EH-06): a read
   * that fails answers "yes" — a stop must never rest on a read that broke.
   */
  async #anyNameOnPage(names: readonly string[]): Promise<boolean> {
    try {
      const body = await this.page.evaluate(() => {
        const doc = (globalThis as unknown as { document?: { body?: { innerText?: string } } }).document;
        return doc?.body?.innerText ?? '';
      });
      const hay = body.replace(/\s+/g, ' ');
      const folded = foldValue(hay);
      for (const name of names) {
        const needle = name.replace(/\s+/g, ' ').trim();
        if (needle === '') continue;
        if (hay.toLowerCase().includes(needle.toLowerCase())) return true;
        if (folded.includes(foldValue(needle))) return true;
        const halves = codeAndLabelOf(needle);
        if (halves !== null && foldedIncludes(hay, halves.label)) return true;
        const labelled =
          (await this.page.getByLabel(needle, { exact: false }).count()) +
          (await this.page.getByPlaceholder(needle, { exact: false }).count()) +
          (await this.page.getByTitle(needle, { exact: false }).count());
        if (labelled > 0) return true;
      }
      return false;
    } catch {
      return true;
    }
  }

  async #readOnlyShell(
    selector: string,
  ): Promise<{ sibling: string | null; siblingType: string | null } | null> {
    try {
      const shell = this.page.locator(selector).first();
      const state = await shell.evaluate(
        (el) => {
          const node = el as unknown as { readOnly?: boolean; tagName?: string };
          return { readOnly: node.readOnly === true, tag: node.tagName ?? '' };
        },
        undefined,
        { timeout: this.#fastTimeoutMs },
      );
      if (!state.readOnly) return null;
      const sibling = `${selector} >> xpath=.. >> input:not([readonly]):not([type="hidden"]):not([disabled])`;
      const count = await this.page.locator(sibling).count();
      if (count !== 1) return { sibling: null, siblingType: null };
      const type = await this.page
        .locator(sibling)
        .first()
        .evaluate((el) => ((el as unknown as { type?: string }).type ?? '').toLowerCase(), undefined, {
          timeout: this.#fastTimeoutMs,
        })
        .catch(() => '');
      return { sibling, siblingType: type };
    } catch {
      return null;
    }
  }

  async #agentEnter(
    action: string,
    selector: string,
    intent: string | undefined,
    entry: string | undefined,
    attempts: string[],
  ): Promise<ResolveResult<unknown> | null> {
    // Not gated by --agent-assist, unlike the repair stage above it: that
    // stage CHANGES the application on its own initiative, whereas this one
    // performs the very write the flow's own step already asked for. The
    // step is the authorisation; the read-back is the check.
    if (entry === undefined || this.#agent === null) return null;
    // The same evidence that stops the healer stops this: a page that has
    // answered for nothing will not answer for an agent either.
    if (this.#pageAnswersNothing) return null;

    const what = intent && intent.trim() !== '' ? intent.trim() : `${action} ${selector}`;
    const goal =
      `The test could not put a value into this control with its own selector, and that selector ` +
      `may name a role this page does not use. Put the value in, using whatever the page really ` +
      `offers, then stop.\n` +
      `WHAT THE STEP IS FOR: ${what}\n` +
      `THE SELECTOR THAT FAILED: ${selector}\n` +
      `THE VALUE TO ENTER: ${JSON.stringify(entry)}\n` +
      `You may fill, type key by key, choose an option, press keys, or paste — paste inserts the ` +
      `whole value at once and is the way into a control that refuses both an assignment and ` +
      `typing, such as a date picker or a masked field. Read the control first if you are unsure ` +
      `what it is. Do not submit the form, and change nothing else. Call finish once the control ` +
      `holds the value.`;

    let record: AgentRecord;
    try {
      record = await this.#agent.run(this.page, goal, {
        memory: cacheAgentMemory(this.#cache),
        caseContext: this.#caseContext,
        humanize: this.#humanize,
        ...this.#agentPersona(),
      });
    } catch (error) {
      attempts.push(`agent-enter: ${describe(error)}`);
      return null;
    }

    // **The agent's word is not the evidence.** Read the value back — from the
    // author's selector if it resolves now, else from the control the agent
    // last acted on successfully.
    const acted = [...(record.actions ?? [])]
      .reverse()
      .find((a) => a.ok && typeof a.selector === 'string' && a.selector !== '');
    const candidates = [selector, acted?.selector].filter(
      (c): c is string => typeof c === 'string' && c !== '',
    );
    for (const candidate of candidates) {
      const held = await this.#readEntered(candidate);
      if (held === null) continue;
      if (!valueMatches(entry, held)) continue;
      this.#recordRuntimeDefect(
        'usability',
        'medium',
        'A value could only be entered after the agent found the control',
        `"${selector}" could not take ${JSON.stringify(entry)}; the agent entered it via ` +
          `${JSON.stringify(candidate)} (${record.summary || 'no summary'}). Rewrite the step ` +
          'against the control the page actually renders, so the run stops paying a model to ' +
          'rediscover it.',
        selector,
      );
      attempts.push(`agent-enter: entered via "${candidate}", read back as ${JSON.stringify(held)}`);
      return { value: undefined, resolution: 'agent', resolvedSelector: candidate, agent: record };
    }
    attempts.push(
      `agent-enter: the value was not in the control afterwards (${record.summary || 'no summary'})`,
    );
    return null;
  }

  /**
   * What a control currently holds, as text — an input's `value`, a
   * select's chosen label, or the element's own text for a custom control
   * that renders its choice. `null` when nothing could be read.
   */
  async #readEntered(selector: string): Promise<string | null> {
    try {
      const locator = this.page.locator(selector).first();
      const held = await locator.evaluate(
        (el) => {
          const node = el as unknown as {
            value?: unknown;
            selectedOptions?: ArrayLike<{ label?: string }>;
            getAttribute?: (name: string) => string | null;
            innerText?: string;
            textContent?: string;
          };
          const chosen = node.selectedOptions?.[0]?.label;
          if (typeof chosen === 'string' && chosen !== '') return chosen;
          if (typeof node.value === 'string' && node.value !== '') return node.value;
          const aria = node.getAttribute?.('aria-valuetext') ?? node.getAttribute?.('value');
          if (typeof aria === 'string' && aria !== '') return aria;
          return node.innerText ?? node.textContent ?? '';
        },
        undefined,
        { timeout: this.#fastTimeoutMs },
      );
      return typeof held === 'string' ? held : null;
    } catch {
      return null;
    }
  }

  /**
   * When determinism runs out: one look, then at most one repair.
   *
   * Live (be100 PL_03_01, 2026-08-25): six assertions in one case failed as
   * `expected text to contain "68", got "REIMBURSEMENT BY EMPLOYEE AND HR"`.
   * The element was right, its text was a fragment of the answer, and the
   * whole answer — `REIMBURSEMENT BY EMPLOYEE AND HR 68` — sat in the run's
   * own recorded page excerpt. The healer, which reads one static tree and
   * proposes a string, offered `text="68"`: find an element containing the
   * expected value, which is circular, and it was rightly refused at 0.20.
   * Nothing in the ladder could ask the page the question the step was asking.
   *
   * **Two model turns, and never more.** One read-only look returns a verdict
   * — `proved`, `can-heal`, `fail`. Only `can-heal` buys a second, repairing
   * run. `fail` returns at once, so a genuinely broken page costs one call.
   *
   * **Neither verdict is believed.** After each stage the harness re-runs the
   * author's own comparison — against the element the agent named, or against
   * the author's own selector on the page it opened up. A step whose claim
   * does not hold afterwards fails exactly as it would have. That is what
   * lets an ASSERTION be offered this at all, where the old `#agentRescue`
   * was refused one: the read stage cannot act, and the repair stage offered
   * to an assertion is restricted to actions that REVEAL what already exists
   * (`REVEAL_ACTIONS` — open, focus, follow; never type), so a claim can be
   * brought into view but never typed into existence.
   *
   * Returns null when nothing was accepted, so the caller falls through and
   * the step fails on the evidence it already had.
   */
  async #agentTriage<T>(
    action: string,
    selector: string,
    intent: string | undefined,
    expected: string | undefined,
    run: (locator: Locator, timeoutMs: number) => Promise<unknown>,
    attempts: string[],
  ): Promise<ResolveResult<T> | null> {
    if (!this.#agent) return null;
    const asserting = (ASSERTION_ACTIONS as readonly string[]).includes(action);
    const what =
      intent ??
      (expected === undefined
        ? `the target of "${selector}"`
        : `${JSON.stringify(expected)} for what "${selector}" names`);
    const lastFailure = attempts[attempts.length - 1] ?? 'it did not resolve';

    // ---- Stage 1: one read-only look -------------------------------------
    const lookGoal =
      `A test step has failed ${attempts.length} times and you are being asked to look at the ` +
      `page ONCE and say which of three things is true. Do NOT click, type or navigate — you ` +
      `may only wait and scroll.\n` +
      `THE STEP: ${action} "${selector}"${expected === undefined ? '' : `, expecting ${JSON.stringify(expected)}`}.\n` +
      `WHAT IT IS FOR: ${what}.\n` +
      `WHAT WENT WRONG LAST: ${lastFailure}\n` +
      `Answer by calling finish, with the verdict in "value" and nothing else in it:\n` +
      `  value="proved" — the page ALREADY shows this, just not where the test looked. Put the ` +
      `Playwright selector of the element that shows it in "selector". Do not name an element ` +
      `merely because the text appears in it somewhere; it must be the one this step is about.\n` +
      `  value="can-heal" — it is not visible yet, but something on this page would reveal it: a ` +
      `menu to open, a tab to switch, a notice to accept, a page to go to. Say which in ` +
      `"reasoning".\n` +
      `  value="fail" — the page genuinely does not offer this. Say why in "reasoning". This is a ` +
      `correct answer and costs nothing further; prefer it to a guess.`;

    let look: AgentRecord;
    try {
      look = await this.#agent.run(this.page, lookGoal, {
        readOnly: true,
        caseContext: this.#caseContext,
      });
    } catch (error) {
      attempts.push(`agent-look: ${describe(error)}`);
      return null;
    }

    const answer = [...look.actions].reverse().find((one) => one.action === 'finish');
    const verdict = triageVerdictOf(answer?.value);
    attempts.push(`agent-look: ${verdict} — ${look.summary}`);

    if (verdict === 'proved') {
      const named = answer?.selector ?? null;
      if (named !== null && named.trim() !== '') {
        try {
          const value = (await run(this.page.locator(named).first(), this.#healedTimeoutMs)) as T;
          this.#recordRuntimeDefect(
            'usability',
            'low',
            `The claim holds, but not where the flow looked: ${selector}`,
            `"${selector}" could not carry this step. Asked to look, the agent named ` +
              `"${named}", and the claim holds there. Write the step against that element so the ` +
              'run stops paying a model to rediscover it.',
            selector,
          );
          return { value, resolution: 'agent-read', resolvedSelector: named, agent: look };
        } catch (error) {
          // Named and checked, and it did not hold. The agent's account is
          // never the evidence — this is what that costs it.
          attempts.push(`agent-look "${named}": ${describe(error)}`);
        }
      } else {
        attempts.push('agent-look: said proved but named no element — an account, not evidence');
      }
      return null;
    }

    if (verdict !== 'can-heal') return null;

    // **The repair is opt-in** (`--agent-assist`), because unlike the look
    // above it this stage *changes the application* before the step runs: it
    // clicks, it opens, it navigates. That is a decision about someone's
    // system, not a default — the same reasoning as `--follow-buttons` and
    // `--probe`, and the contract the deleted `#agentRescue` carried. The
    // look stage is ungated precisely because it cannot act.
    if (!this.#agentAssist) {
      attempts.push(
        'agent-heal: not attempted — the agent judged this reachable, but acting on the page ' +
          'is opt-in (--agent-assist)',
      );
      return null;
    }

    // ---- Stage 2: one repairing run --------------------------------------
    const healGoal =
      `You looked at this page and said the test's target can be reached. Do that now, in as few ` +
      `actions as you can, and then stop.\n` +
      `WHAT IS NEEDED: ${what}\n` +
      `WHAT YOU SAID STANDS IN THE WAY: ${decisionFrom(look, true).decided || look.summary}\n` +
      (asserting
        ? `This step is an ASSERTION, so you may only REVEAL what is already there — open the ` +
          `menu, switch the tab, accept the notice, go to the page, scroll. You may not type, ` +
          `and you must not create, submit or change anything: a claim you made true proves ` +
          `nothing.\n`
        : `Do NOT perform the test's own step — the test will act on "${selector}" itself.\n`) +
      `Call finish as soon as the target is reachable.`;

    let heal: AgentRecord;
    try {
      heal = await this.#agent.run(this.page, healGoal, {
        memory: cacheAgentMemory(this.#cache),
        caseContext: this.#caseContext,
        humanize: this.#humanize,
        ...this.#agentPersona(),
        ...(asserting ? { allowedActions: REVEAL_ACTIONS } : {}),
      });
    } catch (error) {
      attempts.push(`agent-heal: ${describe(error)}`);
      return null;
    }

    // The author's own selector, and its free variants — exactly the
    // `#agentRescue` contract. Whatever the agent says it did, this is what
    // decides the step.
    for (const candidate of [selector, relaxRoleName(selector), qualifyBareRole(selector), withoutGreeting(selector)]) {
      if (candidate === null) continue;
      try {
        const value = (await run(this.page.locator(candidate), this.#healedTimeoutMs)) as T;
        this.#recordRuntimeDefect(
          'usability',
          'medium',
          'A step only worked after the agent revealed what the flow does not describe',
          `"${selector}" could not carry this step until the agent acted. It judged: ` +
            `${decisionFrom(look, true).observed || look.summary}. It chose: ` +
            `${decisionFrom(heal, true).decided || heal.summary}. Add the step that handles this ` +
            '(accept the notice, open the menu, switch the tab, scroll) so the run stops paying a ' +
            'model to rediscover it every time.',
          selector,
        );
        return { value, resolution: 'agent', resolvedSelector: candidate, agent: heal };
      } catch (error) {
        attempts.push(`agent-heal "${candidate}": ${describe(error)}`);
      }
    }
    return null;
  }


  /**
   * Detect and dismiss a blocking dialog, with no wait — called only after
   * the fast path has already failed, so this must stay cheap rather than
   * adding a second timeout on top of the one that just elapsed.
   */
  /**
   * Clear an overlay Playwright reported as intercepting the pointer.
   *
   * Preference order matches the risk: a recognisable dismiss control inside
   * the named element first (`findDismissButton` — name-gated, so a promo's
   * anonymous link is never clicked and can never navigate us away), then
   * Escape, the one key every modal convention binds to "go away". The retry
   * afterwards is what decides whether it worked; this only reports what was
   * done.
   */
  /** The intercepting element's label when it is `position: fixed|sticky`, else null. */
  async #stickyBar(intercepted: { css: string | null; label: string }): Promise<string | null> {
    if (intercepted.css === null) return null;
    const position = await this.page
      .locator(intercepted.css)
      .first()
      .evaluate((el) => (globalThis as unknown as { getComputedStyle(e: unknown): { position: string } }).getComputedStyle(el).position, undefined, {
        timeout: ATTRIBUTE_READ_TIMEOUT_MS,
      })
      .catch(() => null);
    return position === 'fixed' || position === 'sticky' ? intercepted.label : null;
  }

  async #clearInterceptingOverlay(intercepted: {
    css: string | null;
    label: string;
  }): Promise<DialogRecord | null> {
    try {
      if (intercepted.css !== null) {
        const container = this.page.locator(intercepted.css).first();
        if (await container.isVisible().catch(() => false)) {
          const dismiss = await findDismissButton(container);
          if (dismiss) {
            await dismiss.locator.click({ timeout: this.#fastTimeoutMs });
            await this.page.waitForTimeout(350);
            return { name: intercepted.label, button: dismiss.text };
          }
        }
      }
      await this.page.keyboard.press('Escape');
      await this.page.waitForTimeout(350);
      return { name: intercepted.label, button: 'Escape' };
    } catch {
      return null;
    }
  }

  async #dismissBlockingDialog(open?: Locator | null): Promise<DialogRecord | null> {
    const dialog = open ?? (await openDialogNow(this.page));
    if (!dialog) return null;
    // The AUTOMATIC policy (EH-02): neutral names only — Close, Cancel, ปิด,
    // ยกเลิก — and an affirmative one only on a consent/cookie notice. The
    // unrequested rung once clicked "OK"/"Continue" and confirmed whatever
    // the dialog asked; "Cancel" on humi's Create Plan popup discards the
    // form, "ตกลง" on a delete confirm deletes. An explicit `closeModal`
    // keeps searching both families — the author asked for it closed.
    const dismiss = await findDismissButton(dialog, { policy: 'automatic' });
    if (!dismiss) return null;

    const name = await describeDialog(dialog);
    try {
      await dismiss.locator.click({ timeout: this.#fastTimeoutMs });
    } catch {
      return null; // couldn't actually click it — don't claim a dismissal that never happened
    }
    return { name, button: dismiss.text };
  }

  // --- Teardown ------------------------------------------------------------

  /**
   * Flush the cache and detach. For a CDP connection Playwright disconnects
   * rather than killing the browser, so the user's Chrome survives the run.
   */
  /**
   * This run's session as data, for the suite's vault — cookies plus
   * localStorage, the same serialization the recording context inherits by.
   */
  async exportSession(): Promise<StoredSession> {
    return this.#context.storageState();
  }

  async close(): Promise<ProofBundle> {
    try {
      this.#flagUnrequestedNavigation();
    } catch {
      // Diagnostic, same rule as coverage below: it explains a failure, it
      // must never create one.
    }

    // Re-probe every selector that dead-ended: one that resolves *now* was
    // never absent — it was slower than the fast-path budget, and the defect
    // it filed should say "timing", not "missing". The mirror of
    // `#flagTimingHeal`, pointed at failures instead of successes.
    // Diagnostic: anything that goes wrong here changes nothing.
    try {
      // Only steps that failed on the page the run *ended* on can be
      // re-checked honestly: probing a login-page selector against whatever
      // page the run finished on would call a genuine absence "timing".
      const here = this.page.url();
      const deadEnded = new Set<string>();
      for (const step of this.bundle.steps) {
        if (
          step.status !== 'passed' &&
          step.status !== 'skipped' &&
          step.selector !== null &&
          step.resolution === null &&
          step.url === here &&
          // Only genuine resolution failures may be downgraded to timing. A
          // content mismatch resolved fine and failed on what the element
          // SAYS ("expected text to contain…"), and an intercepted click
          // resolved fine and failed on what covered it — re-probing either
          // selector proves only what was never in doubt, and the "TIMING,
          // not absence" downgrade then papers over the real finding. Seen
          // live: a failed `expectText body` (content absent because the
          // journey never created it) downgraded to timing because `body`,
          // of course, resolves.
          !/expected text to contain|intercepts pointer events/i.test(step.error ?? '')
        ) {
          deadEnded.add(step.selector);
        }
      }
      for (const selector of deadEnded) {
        const count = await this.page
          .locator(selector)
          .count()
          .catch(() => 0);
        if (count > 0) this.bundle.reclassifyTimingDefect(selector);
      }
    } catch {
      // Same rule as coverage below: never let a diagnostic fail the run.
    }

    // Measured before teardown so the page is still in its final state.
    if (this.#coverage) {
      try {
        this.bundle.setCoverage(
          await measureCoverage(this.page, this.bundle.resolvedSelectors()),
        );
      } catch {
        // Coverage is diagnostic; never let it fail an otherwise good run.
      }
    }

    // Every session's observer, summed: the manager's approval leg made
    // requests on its own Chrome, and a total that counted only the active
    // session's would understate the run.
    const totals = { calls: 0, failures: 0, dropped: 0 };
    let observed = false;
    for (const session of this.#sessions) {
      const observer = session.network;
      if (!observer) continue;
      observed = true;
      try {
        const calls = observer.all();
        totals.calls += calls.length + observer.dropped;
        totals.failures += calls.filter(isBlockingFailure).length;
        totals.dropped += observer.dropped;
      } catch {
        // Diagnostic, same rule as coverage above.
      }
      await observer.detach().catch(() => undefined);
      session.network = null;
    }
    if (observed) {
      try {
        this.bundle.setNetworkTotals(totals);
      } catch {
        // Diagnostic.
      }
    }

    // The DB connection is the runner's to close (it opened lazily on the
    // first DB step; a run with none has nothing to close). Never fatal.
    await this.#db.close().catch(() => undefined);

    // Saved variables are evidence once a later check keys on one — masked by
    // name before they leave the store, same rule as every other credential.
    try {
      this.bundle.setVariables(this.variables.snapshotForReport());
    } catch {
      // Diagnostic, same rule as coverage above.
    }

    await this.#cache.flush();

    // Every session, in the order they were opened — the primary first.
    //
    // Sealing a recording has to happen between closing its context and
    // closing its browser, and in that order: Playwright finalises a video
    // when its *context* closes, so asking earlier reads a half-written file
    // that no player will open, and closing the browser first can take the
    // page — and with it `page.video()` — away before it can be asked. The
    // primary's film is cut where the run broke; a persona's is kept whole,
    // because the cut is judged over the run's steps and a persona's film
    // covers only its own share of them.
    const primary = this.#sessions[0];
    for (const session of this.#sessions) {
      const video = session.video;
      if (video) {
        const page = session.page;
        await session.context.close().catch(() => undefined);
        // `'on'` condenses every film — the primary's and each persona's —
        // to its action moments (`ProofBundleBuilder.videoMoments`, on that
        // film's own clock); `'always'` keeps the wall-clock film whole.
        const film = session === primary ? '' : (session.label ?? 'persona');
        const sealed = await sealVideo(
          page,
          video.dir,
          video.size,
          session === primary && this.#videoMode !== 'always' ? this.#videoCut() : 'full',
          this.#videoMode === 'always' ? undefined : this.bundle.videoActionMoments(film),
          this.#videoDwellMs,
        );
        if (sealed) {
          session.sealed = sealed;
          if (session === primary) this.bundle.setVideo(sealed);
          else this.bundle.addPersonaVideo(session.label ?? 'persona', session.cdpUrl, sealed);
        }
        session.video = null;
      } else if (this.#ownsPage && session.ownsContext) {
        // An isolated, unfilmed context is this runner's to close too — a
        // CDP disconnect below leaves it alive in a Chrome that outlives
        // the process, one per case, every suite.
        await session.context.close().catch(() => undefined);
      }

      if (this.#ownsPage) {
        // Pages adoption left behind are this runner's to clean up, under
        // the same ownership rule as the current page.
        if (!session.ownsContext) {
          for (const page of session.pagesLeftBehind) await page.close().catch(() => undefined);
          await session.page.close().catch(() => undefined);
        }
        await session.browser.close().catch(() => undefined);
      }
    }
    return this.bundle.finish();
  }
}

/**
 * Borrow a page from the CDP-attached browser for a one-off task (generation,
 * inspection), then clean up. Same connect-only contract as `SmartRunner`.
 */
export async function withPage<T>(
  cdpUrl: string | undefined,
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const url = cdpUrl ?? DEFAULT_CDP_URL;
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(url);
  } catch (error) {
    throw new Error(
      `could not attach to a browser at ${url}: ${describe(error)}\n` +
        'Start Chrome with --remote-debugging-port first (npm run chrome).',
    );
  }

  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  await applyViewport(page);
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

/**
 * `withPage`, for `count` tabs at once in the browser's shared context — one
 * per authoring worker. Every tab is closed when `fn` settles, however it
 * settles; the browser itself is only disconnected from, never killed.
 */
export async function withPages<T>(
  cdpUrl: string | undefined,
  count: number,
  fn: (pages: Page[]) => Promise<T>,
): Promise<T> {
  const url = cdpUrl ?? DEFAULT_CDP_URL;
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(url);
  } catch (error) {
    throw new Error(
      `could not attach to a browser at ${url}: ${describe(error)}\n` +
        'Start Chrome with --remote-debugging-port first (npm run chrome).',
    );
  }

  const context = browser.contexts()[0] ?? (await browser.newContext());
  const pages: Page[] = [];
  try {
    for (let i = 0; i < Math.max(1, count); i += 1) {
      const page = await context.newPage();
      await applyViewport(page);
      pages.push(page);
    }
    return await fn(pages);
  } finally {
    for (const page of pages) await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

// --- Declarative flows -----------------------------------------------------

export type FlowStep =
  // --- navigation and interaction ---
  | { action: 'goto'; url: string }
  | { action: 'click'; selector: string; intent?: string | undefined }
  // --- composition and control flow ---
  /**
   * Splice in another flow's steps. Expanded before the run — see
   * `src/engine/compose.ts`.
   */
  | {
      action: 'use';
      /** Path to a `.flow.json`, relative to the flow doing the using. */
      flow: string;
      /** Values for `{{name}}` placeholders inside the fragment. */
      with?: Record<string, string> | undefined;
      intent?: string | undefined;
    }
  /**
   * Run `then` when the condition holds, `else` otherwise.
   *
   * The condition is a *probe*, not an assertion: it never heals and never
   * fails the flow, it only chooses a branch. Exactly one of the four
   * condition fields must be set.
   */
  | {
      action: 'when';
      visible?: string | undefined;
      hidden?: string | undefined;
      enabled?: string | undefined;
      disabled?: string | undefined;
      then: FlowStep[];
      else?: FlowStep[] | undefined;
      intent?: string | undefined;
    }
  | { action: 'fill'; selector: string; value: string; intent?: string | undefined; valueSource?: StepValueSource | undefined }
  /** Choose a dropdown option by its visible label — native `<select>` or custom combobox. */
  | { action: 'selectOption'; selector: string; value: string; intent?: string | undefined; valueSource?: StepValueSource | undefined }
  /** Tick / untick a checkbox, radio, or ARIA toggle, verifying the state changed. */
  | { action: 'check'; selector: string; intent?: string | undefined }
  | { action: 'uncheck'; selector: string; intent?: string | undefined }
  /** Type key by key — for autocomplete/typeahead/masked fields `fill` cannot wake. */
  | { action: 'type'; selector: string; value: string; intent?: string | undefined; valueSource?: StepValueSource | undefined }
  | { action: 'waitFor'; selector: string; intent?: string | undefined; timeoutMs?: number | undefined }
  /**
   * Hand the browser to the agent until `goal` is satisfied. `script` is a
   * deterministic journey a previous successful run recorded on this very
   * step (see `withWorkflowScripts`): replayed before any model turn, and
   * the agent takes over only where the replay no longer grounds.
   */
  | { action: 'workflow'; goal: string; script?: WorkflowScriptStep[] | undefined }
  // --- keyboard ---
  | { action: 'press'; key: string; selector?: string | undefined; intent?: string | undefined }
  | { action: 'expectFocused'; selector: string; intent?: string | undefined }
  | { action: 'expectTabOrder'; selectors: string[]; intent?: string | undefined }
  // --- data-driven (boundary value analysis) ---
  | {
      action: 'fillEach';
      selector: string;
      cases: DataCase[];
      /** Clicked after each fill, before asserting — for on-submit validation. */
      submit?: string | undefined;
      intent?: string | undefined;
    }
  // --- mock data (regenerate-and-retry on a data conflict) ---
  | {
      action: 'fillRetry';
      selector: string;
      kind: DataKind;
      /** Visible while the current value still conflicts; retry stops once this clears. */
      failureSelector: string;
      /** Clicked after each fill, before checking `failureSelector`. */
      submit?: string | undefined;
      maxAttempts?: number | undefined;
      /** Field description for the `custom` kind, e.g. "employee ID". */
      description?: string | undefined;
      intent?: string | undefined;
    }
  // --- backend ---
  /**
   * An HTTP call made by the test itself. Sent through the browser context by
   * default, so it inherits whatever session the UI steps established.
   */
  | ({ action: 'request' } & FlowRequestSpec)
  | { action: 'expectStatus'; status: number | number[]; intent?: string | undefined }
  /** Omit `value` to assert only that the path resolves — for a server-assigned id. */
  | { action: 'expectJson'; path: string; value?: string | undefined; intent?: string | undefined }
  | { action: 'expectHeader'; name: string; value: string; intent?: string | undefined }
  /**
   * Assert the traffic the page made — ordered subsequence + absence claims
   * over the network observer's window. Browser-bound (it needs the live
   * observer) but backend-tier (its subject is HTTP). See `expect-calls.ts`.
   */
  | ({ action: 'expectCalls' } & FlowExpectCallsSpec)
  // --- database verification (read-only; see `src/db/`) ---
  | ({ action: 'dbSnapshot' } & FlowDbSnapshotSpec)
  | ({ action: 'expectDbRow' } & FlowDbRowSpec)
  | ({ action: 'expectDbDelta' } & FlowDbDeltaSpec)
  | ({ action: 'expectDbUnchanged' } & FlowDbUnchangedSpec)
  /** Statement-statistics tier — correlational "called as planned", via pg_stat_statements. */
  | ({ action: 'expectDbCalled' } & FlowDbCalledSpec)
  // --- modals ---
  | { action: 'expectModal'; name?: string | undefined; intent?: string | undefined; timeoutMs?: number | undefined }
  | { action: 'closeModal'; button?: string | undefined; intent?: string | undefined }
  // --- visual regression ---
  | { action: 'snapshot'; name: string; selector?: string | undefined }
  // --- state seeding (setup/teardown) ---
  | { action: 'setLocalStorage'; key: string; value: string }
  | { action: 'clearStorage' }
  /**
   * End the session the way a user does — the application's own sign-out
   * control (searched name-gated on the page, then behind ARIA-marked
   * identity menus). The persona-switch step: sign out, goto the sign-in
   * page, fill the next account's credentials.
   */
  | { action: 'signOut'; intent?: string | undefined }
  /**
   * Pin the page's clock to a fixed moment (ISO date or date-time), so a
   * claim that depends on "today" — an urgency tier, a due-date boundary, an
   * expiry — is checkable instead of drifting with the wall clock. Belongs in
   * setup, BEFORE the first `goto`: an application reads the clock as it
   * renders, and installing after the fact changes nothing already drawn.
   */
  | { action: 'setClock'; time: string; intent?: string | undefined }
  // --- history and scrolling ---
  /** Go back one history entry — for "open it, check it, come back". */
  | { action: 'back'; intent?: string | undefined }
  | { action: 'forward'; intent?: string | undefined }
  | { action: 'scrollTo'; selector: string; intent?: string | undefined }
  /** Assert the page, or a container, can really be scrolled by a user. */
  | { action: 'expectScrollable'; selector?: string | undefined; intent?: string | undefined }
  | { action: 'expectNotScrollable'; selector?: string | undefined; intent?: string | undefined }
  // --- assertions ---
  /**
   * `anyOf`: accepted equivalent renderings of the same content, for
   * bilingual applications — see `SmartRunner.expectText`. Omit it to
   * enforce one specific rendering.
   */
  | { action: 'expectText'; selector: string; value: string; anyOf?: string[] | undefined; intent?: string | undefined; timeoutMs?: number | undefined }
  | { action: 'expectVisible'; selector: string; intent?: string | undefined; timeoutMs?: number | undefined }
  | { action: 'expectHidden'; selector: string; intent?: string | undefined; timeoutMs?: number | undefined }
  | { action: 'expectEnabled'; selector: string; intent?: string | undefined }
  | { action: 'expectDisabled'; selector: string; intent?: string | undefined }
  | { action: 'expectCount'; selector: string; count: number | string; intent?: string | undefined; timeoutMs?: number | undefined }
  /**
   * Either/or: passes when ANY of the selectors is visible — an Expected line
   * that offers alternatives ("สำเร็จหรือแสดง error … ไม่ crash"). Fails naming
   * every selector that was not.
   */
  | { action: 'expectAnyVisible'; selectors: string[]; intent?: string | undefined; timeoutMs?: number | undefined }
  /**
   * The validation message shown FOR a named field (aria-errormessage /
   * aria-describedby / the field's own container), optionally equal to `value`.
   */
  | { action: 'expectFieldError'; selector: string; value?: string | undefined; intent?: string | undefined }
  /** Attach files to a file input, a dropzone, or a control that opens the chooser. */
  | { action: 'upload'; selector: string; files: string[]; intent?: string | undefined }
  /**
   * Click `selector` and capture the download it starts; the saved path goes
   * into the variable store as `{{as}}`. Capture only — see `SmartRunner.download`.
   */
  | { action: 'download'; selector: string; as: string; intent?: string | undefined }
  /**
   * Sign in as a named persona (`<HR_ADMIN_ACCOUNT>`, `MANAGER_ACCOUNT`, or a
   * literal email that matches one) using `RunFlowOptions.personas`, signing
   * out first when a session is live. Mid-flow persona hand-offs.
   */
  | { action: 'signIn'; as: string; url?: string | undefined; intent?: string | undefined }
  // --- cross-surface reconciliation (EN-2 audit): read one surface, compare
  // on another. `saveCount`/`saveText` write into the run's variable store;
  // a later expectCount/expectText carries `{{name}}`.
  | { action: 'saveCount'; selector: string; as: string; intent?: string | undefined }
  | { action: 'saveText'; selector: string; as: string; intent?: string | undefined }
  | { action: 'expectUrl'; value: string; intent?: string | undefined }
  | { action: 'expectValue'; selector: string; value: string; intent?: string | undefined }
  | {
      action: 'expectAttribute';
      selector: string;
      name: string;
      value: string;
      intent?: string | undefined;
    };

/**
 * Actions that assert something about the page.
 *
 * A flow containing none of these can pass while proving nothing — the
 * false-confidence failure mode. `hasAssertion()` is what lets the generator
 * refuse to emit such a case.
 */
export const ASSERTION_ACTIONS = [
  // `request` is deliberately NOT here: a call whose status nobody checks
  // passes whether or not the endpoint works, which is precisely the
  // false-confidence failure mode this list exists to prevent. `dbSnapshot`
  // is out for the same reason — it records, it claims nothing.
  'expectStatus',
  'expectJson',
  'expectHeader',
  'expectCalls',
  'expectDbRow',
  'expectDbDelta',
  'expectDbUnchanged',
  'expectDbCalled',
  'expectFocused',
  'expectTabOrder',
  'fillEach',
  'fillRetry',
  'expectModal',
  'snapshot',
  'expectText',
  'expectVisible',
  'expectHidden',
  'expectEnabled',
  'expectDisabled',
  'expectCount',
  'expectAnyVisible',
  'expectFieldError',
  'expectUrl',
  'expectValue',
  'expectScrollable',
  'expectNotScrollable',
  'expectAttribute',
] as const;

export type AssertionAction = (typeof ASSERTION_ACTIONS)[number];

const ASSERTION_SET: ReadonlySet<string> = new Set(ASSERTION_ACTIONS);

/** True when `steps` contains at least one real assertion. */
export function hasAssertion(steps: readonly FlowStep[]): boolean {
  return steps.some((step) => ASSERTION_SET.has(step.action));
}

/** How many steps a run intends to take, once composition has been resolved. */
export interface RunPlan {
  /** `setup + steps + teardown` — the denominator live progress counts against. */
  total: number;
  setup: number;
  steps: number;
  teardown: number;
}

export interface Flow {
  name: string;
  readonly consentPolicy?: ConsentPolicy | undefined;
  /**
   * The authoring pass that wrote this flow, when a model did.
   *
   * Written into the file, not merely into the run, because the file outlives
   * the run: re-running an authored case, or repairing it, produces a bundle
   * that would otherwise carry no provenance at all — and wowUI would file it
   * under "Authored flows" rather than beside the catalog it came from. The
   * flow is the artifact, so the artifact records where it came from.
   */
  authoredBy?: GenerationProvenance | undefined;
  /**
   * Whether this test means to prove acceptance or refusal. Stamped by the
   * catalog path when the sheet's own Positive/Negative column states it —
   * the author's word, which always wins. Absent, `runFlow` infers it
   * deterministically from the flow's own words and assertions
   * (`inferPolarity`), so every bundle carries the label either way.
   */
  polarity?: TestPolarity | undefined;
  /**
   * The test case this flow proves, as a compact card — the claim and its
   * expected output in the sheet's own words, stamped by the catalog path.
   * In the file for the same reason `authoredBy` is: the file outlives the
   * run, and the runtime roles (healer, agent) read it so a repair or a
   * workflow turn knows WHAT the step is trying to prove, not only which
   * selector failed. Context for those models, never an instruction — the
   * claim itself lives in the steps.
   */
  caseContext?: string | undefined;
  /**
   * How far this test reaches. Stamped `e2e` by the authoring path when the
   * flow switches personas (`switchesPersona` in `flow-author.ts`): a test
   * that signs in as two different people is a journey across the
   * application's own session machinery, not a unit check of one screen,
   * whatever scope the request asked for.
   */
  scope?: 'unit' | 'e2e' | undefined;
  /**
   * How this flow's sheet writes dates (EH-03): `th` reads `dd/mm/yyyy`
   * day-first and converts a Buddhist year; `en-US` month-first. Absent
   * leaves an ambiguous `01/09/2027` unconverted — never guessed.
   */
  locale?: DateLocale | undefined;
  /** Prefixed to relative `goto` urls. */
  baseUrl?: string | undefined;
  /**
   * Preconditions — authentication, seeded storage, navigation to a known
   * state. Failures here abort the flow before `steps` run, because a test
   * whose preconditions did not hold cannot produce a meaningful result.
   */
  setup?: FlowStep[] | undefined;
  steps: FlowStep[];
  /** Cleanup. Always runs, including after a failure. */
  teardown?: FlowStep[] | undefined;
}

/**
 * Interpolate `{{name}}` in a step's string fields.
 *
 * Skipped entirely when the step carries no placeholder, which is the normal
 * case — a scan of a few short strings beats constructing a copy of every step
 * in every flow. API steps are left to `ApiActions`, which already interpolates
 * bodies and headers and knows which of its own fields must be resolved after
 * `baseUrl` rather than before (see the ordering trap in `src/api/`).
 */
function interpolateStep(step: FlowStep, variables: VariableStore): FlowStep {
  // Browser-free steps interpolate their own fields (`ApiActions` needs the
  // baseUrl ordering, `DbActions` has nested where/values this shallow walk
  // could not reach) — and `expectCalls` deep-interpolates its own entries
  // for the same nesting reason, so its top-level pass here is harmless.
  if (BROWSER_FREE_ACTIONS.has(step.action)) return step;
  const hasPlaceholder = Object.values(step).some(
    (value) => typeof value === 'string' && value.includes('{{'),
  );
  if (!hasPlaceholder) return step;

  const out: Record<string, unknown> = { ...step };
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === 'string' && value.includes('{{')) out[key] = variables.interpolate(value);
  }
  return out as FlowStep;
}

/** One step that did not pass, in a run that kept going anyway. */
export interface StepIssue {
  action: string;
  selector: string | null;
  kind: 'failed' | 'error' | 'dead-end';
  message: string;
}

/**
 * What actually went wrong with a step, in the vocabulary the report uses:
 * an exhausted escalation ladder is a *dead end* (nothing left to try), a
 * broken assertion is a *fail*, and everything else — a thrown exception, a
 * navigation that never landed, bad interpolation — is an *error*, because
 * calling it a test failure would blame the app for the harness's problem.
 */
export function classifyStepFailure(action: string, error: unknown): StepIssue['kind'] {
  // A content-only resolution failure is a verdict, not a lost control:
  // every rung resolved the element and only its text missed. `failed` keeps
  // it eligible for the near-miss gate (proved-? → the judge); `dead-end`
  // buried wording questions behind a status that reads "the control was
  // absent" (be100 PL_02_07).
  if (error instanceof StepResolutionError) return error.contentOnly ? 'failed' : 'dead-end';
  if (error instanceof Error && error.cause instanceof StepResolutionError) {
    return error.cause.contentOnly ? 'failed' : 'dead-end';
  }
  // A workflow leg the PAGE ended (task C3): the goal's control enumerated
  // twice, identically, and its value on none of the options. The harness
  // observed that itself, so it is a verdict — `failed`, with expected and
  // actual on the step — never the `error` every other agent stop is.
  if (error instanceof Error && error.name === 'AgentEvidenceError') return 'failed';
  // Harness and grounding facts are errors even under an `expect` name: an
  // unreachable database, an unattached observer, a table the schema does not
  // declare, an unknown {{variable}} nothing saved, an assertion with no
  // request before it — calling any of them a test failure would blame the
  // app for the harness's (or the flow's) problem. Matched by error name so
  // this module does not import the whole db/api families for six classes.
  // (The variable and no-response names joined 2026-08-24: the identical
  // unknown-variable fault was already `error` on a `request` step and
  // `failed` + a backend defect on an `expectJson` — the asymmetry the api
  // CLAUDE.md's "an unknown variable is an error" rule always meant to rule
  // out.)
  if (
    error instanceof Error &&
    (error.name === 'DbUnavailableError' ||
      error.name === 'DbGroundingError' ||
      error.name === 'ObservationUnavailableError' ||
      error.name === 'ObservationTruncatedError' ||
      error.name === 'UnknownVariableError' ||
      error.name === 'NoResponseError' ||
      // A 405/501 is the endpoint refusing the VERB the test chose — the
      // flow's fault, never the application's (2026-08-25, be100 PL_03_03).
      error.name === 'MethodRefusedError' ||
      // A backend step in a run that turned the backend off is a limit the
      // run was given, never a finding about the application.
      error.name === 'BackendDisabledError' ||
      // A 404 on a path the codebase declares no route for is the test asking
      // for a page that does not exist, never the application failing.
      error.name === 'RouteNotFoundError' ||
      // A fixture the flow names that is not on disk, or a persona the run
      // was not given (2026-09-03): the test's problem, never the app's.
      error.name === 'FixtureMissingError' ||
      error.name === 'PersonaUnknownError' ||
      // A persona's own Chrome that answers nothing: the machine's problem.
      error.name === 'PersonaBrowserUnavailableError' ||
      // A mutation the run's own policy or provenance rules withheld
      // (2026-09-05): the application was never asked, so nothing about it
      // is established either way.
      error.name === 'MutationBlockedError' ||
      // A workflow leg the HARNESS ended (task C3): the turn ceiling, a
      // stall, the no-progress judge — a limit of the run, not a fact about
      // the application. (The default below already says `error` for a
      // `workflow` step; named here so the classing is explicit.)
      error.name === 'AgentBudgetError')
  ) {
    return 'error';
  }
  if (action.startsWith('expect') || action === 'snapshot' || action === 'fillEach' || action === 'fillRetry') {
    return 'failed';
  }
  return 'error';
}

/**
 * Build the one run-level message for a run that finished with issues. The
 * run is complete — every step got its turn — so the message is a tally plus
 * one line per issue, worded the way each kind deserves.
 */
/**
 * The run completed and some steps did not pass — a TALLY, not a fatal.
 *
 * Its own type because the bundle has to tell the two apart: a fatal (the
 * session guard, a dead browser) says the claims were asserted against the
 * wrong page and no passing assertion may outrank it; a tally says exactly
 * what the step records already say. Recording the tally as the run error
 * used to make the qualified pass unreachable — every run with a broken step
 * carried a run-level error, which is the one thing `passed-with-issues` must
 * never override (PL_02_03, live: 7/9 steps, both assertions green, verdict
 * dead-end).
 */
class StepIssuesError extends Error {
  readonly issues: readonly StepIssue[];
  constructor(issues: readonly StepIssue[]) {
    super(summarizeIssues(issues));
    this.name = 'StepIssuesError';
    this.issues = issues;
  }
}

class StopAfterFirstIssue extends Error {
  constructor() {
    super('stop after first issue');
    this.name = 'StopAfterFirstIssue';
  }
}

export function stopAfterFirstIssue(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['WOWLIDATOR_STOP_AFTER_FIRST_ISSUE'] ?? '').trim().toLowerCase() === 'on';
}

function summarizeIssues(issues: readonly StepIssue[]): string {
  const label = { failed: 'failed', error: 'error', 'dead-end': 'dead end' } as const;
  const counts = { failed: 0, error: 0, 'dead-end': 0 };
  for (const issue of issues) counts[issue.kind] += 1;
  const parts = (Object.keys(counts) as (keyof typeof counts)[])
    .filter((k) => counts[k] > 0)
    .map((k) => `${counts[k]} ${label[k]}`);
  const lines = issues.map(
    (i) =>
      `  ${label[i.kind].toUpperCase()}: ${i.action}${i.selector ? ` ${i.selector}` : ''} — ${i.message.split('\n')[0]}`,
  );
  return `run completed with ${parts.join(', ')}:\n${lines.join('\n')}`;
}

/** AX budget for a reconstruction ask — same as `--repair`'s. */
const DEFAULT_RECONSTRUCT_MAX_AX_NODES = 150;

/** Total tries per step, including the original, before final classification. */
export const STEP_RECONSTRUCT_TRIES = 3;

/**
 * Ladder stops whose whole argument is "a rewrite can only fail identically
 * or succeed against the wrong thing" — reconstruction honours them for the
 * same reason healing does.
 */
function reconstructionFutile(error: unknown): boolean {
  // Harness and grounding facts — the same names `classifyStepFailure` scores
  // as `error`, not `failed`: an unreachable database, an undeclared table, a
  // missing network observer. No rewrite of the step can connect a database
  // that is not configured, so asking for one spends a model call to fail
  // identically (be100, 2026-08-23: every `expectDbRow` failing on "database
  // unavailable" was sent for reconstruction anyway).
  if (
    error instanceof Error &&
    (error.name === 'DbUnavailableError' ||
      error.name === 'DbGroundingError' ||
      error.name === 'ObservationUnavailableError' ||
      error.name === 'ObservationTruncatedError' ||
      // No rewrite of the step can save a variable nothing set, or conjure
      // the request an assertion needed to have before it — same futility
      // rule, two more names (2026-08-24).
      error.name === 'UnknownVariableError' ||
      error.name === 'NoResponseError' ||
      // Nor can a rewrite give a handler a method it does not export.
      error.name === 'MethodRefusedError' ||
      // Nor can a rewrite give a run permission it was denied.
      error.name === 'BackendDisabledError' ||
      // Nor can a rewritten selector conjure a route the application lacks.
      error.name === 'RouteNotFoundError' ||
      // Nor put a fixture on disk, nor invent an account.
      error.name === 'FixtureMissingError' ||
      error.name === 'PersonaUnknownError' ||
      // Nor start a Chrome.
      error.name === 'PersonaBrowserUnavailableError' ||
      // Nor grant a run a mutation its policy denies, nor make a row observed.
      error.name === 'MutationBlockedError' ||
      // Nor make a listbox offer an option it enumerated twice without (C3).
      error.name === 'AgentEvidenceError')
  ) {
    return true;
  }
  if (!(error instanceof StepResolutionError)) return false;
  // A content-only miss stays ELIGIBLE for reconstruction on purpose: the
  // claim survives verbatim, but inserted preparation can make it true (the
  // canonical rescue — a missing click before an expectText). Only when the
  // retries run dry does the failure classify `failed` and reach the
  // near-miss gate and the judge.
  return error.attempts.some(
    (line) =>
      line.startsWith('backend:') ||
      line.startsWith('declined to heal:') ||
      line.startsWith('authorization:') ||
      line.startsWith('known dead end:') ||
      // A rebuilt selector cannot summon text that is nowhere on the page
      // (EH-06), nor bring back a page the application does not have (EH-09).
      line.startsWith('absence:') ||
      line.startsWith('not-found:'),
  );
}

/**
 * Did that click's form submit natively, before the app hydrated?
 *
 * The live failure this catches: a login page's Sign in is clicked ~140ms
 * after load, before React attaches the submit handler, so the browser
 * performs the `<form>`'s default GET submission — the URL becomes
 * `/en/login?email=…&password=…`, no session is created, and every later
 * step runs against the login page filing "frontend" defects about an app
 * that works. Detection is evidence-based: a query parameter whose name
 * reads as a password, or whose value equals something a preceding fill
 * typed. Checked only when the preceding fill block looks credential-shaped,
 * so ordinary clicks never pay the recheck window.
 *
 * **A form whose inputs have no `name` submits nothing but a bare `?`**, and
 * that is the shape this missed for a whole catalog run. The app under test
 * writes `<input type="email">` / `<input type="password">` with no `name`
 * attribute, so its pre-hydration GET produced `/en/login?` — no parameters at
 * all, no evidence for either check above, no replay, and a silently failed
 * login. Measured across DB_01_01…DB_09_01: 21 of the 25 defects those runs
 * filed were downstream of exactly this. So a query string that **appeared
 * across the click** on a sign-in URL is the third signature. It is compared
 * against the URL as it stood when the fill block began — never "a login URL
 * happens to have a query string", which would trip on an ordinary
 * `/login?redirect=/somewhere`.
 *
 * Returns the offending parameter name, `NATIVE_SUBMIT_UNNAMED` for the bare
 * form, or null.
 */
export async function nativeFormResubmitDetected(
  urlOf: () => string,
  fills: readonly FlowStep[],
  recheckMs = 600,
  /** The URL when the credential fill block began. Absent disables the third signature. */
  urlBefore?: string | null,
): Promise<string | null> {
  if (fills.length === 0) return null;
  const credentialShaped = fills.some((step) =>
    /password|passwd|pwd/i.test(
      `${(step as { selector?: string }).selector ?? ''} ${(step as { intent?: string }).intent ?? ''}`,
    ),
  );
  if (!credentialShaped) return null;
  const typedValues = new Set(
    fills
      .map((step) => (step as { value?: string }).value)
      .filter((value): value is string => typeof value === 'string' && value !== ''),
  );
  // The native GET navigation commits within milliseconds on a healthy page,
  // but the click returns as soon as it lands — give the URL a short window
  // to show its hand before declaring the submit real.
  let before: URL | null = null;
  if (typeof urlBefore === 'string') {
    try {
      before = new URL(urlBefore);
    } catch {
      before = null;
    }
  }
  // A bare "?" is invisible to `URL.search`, which normalises an empty query
  // to '' — and the bare "?" IS the whole signature for a form whose inputs
  // have no name. `href` keeps it, so the query evidence is read from the
  // serialised form. (Found by writing the test: `new URL('http://x/a?')`
  // gives `search: ""`, `href: "http://x/a?"`.)
  const hasQuery = (u: URL): boolean => u.href.includes('?');
  const deadline = Date.now() + recheckMs;
  for (;;) {
    let url: URL;
    try {
      url = new URL(urlOf());
    } catch {
      return null;
    }
    for (const [name, value] of url.searchParams) {
      if (/password|passwd|pwd/i.test(name)) return name;
      if (typedValues.has(value)) return name;
    }
    // The unnamed-fields form: still on the sign-in page, and a query string
    // that was not there when the credentials were typed. Both halves are
    // required — the search must have APPEARED, and we must not have left.
    if (
      before !== null &&
      !hasQuery(before) &&
      hasQuery(url) &&
      url.pathname === before.pathname &&
      looksLikeSignIn(url.href)
    ) {
      return NATIVE_SUBMIT_UNNAMED;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 150));
  }
}

/**
 * The "sign-in never took effect" diagnosis, or null.
 *
 * Pure and exported so the decision can be tested without a browser — the
 * message itself reads the page nowhere, which is the point: this app renders
 * a protected route for a beat before its client guard bounces it, so "what
 * does the URL look like now" is the wrong evidence and only the recorded
 * outcome of the submit will do.
 */
export function signInDidNotTakeMessage(state: {
  signInDidNotTake: boolean;
  lastGotoAskedSignIn: boolean;
  lastGotoPath: string | null;
}): string | null {
  // All three required. `lastGotoAskedSignIn` false plus a path is "the flow
  // has since asked for a page that needs a session" — which is exactly what
  // exempts a negative sign-in test that stays put to assert an error.
  if (!state.signInDidNotTake || state.lastGotoAskedSignIn || state.lastGotoPath === null) {
    return null;
  }
  return (
    `the sign-in did not take effect — the run is not signed in, and it has since asked ` +
    `for ${state.lastGotoPath}, which needs a session. Nothing after this point can say ` +
    `anything about the feature under test.\n` +
    `  This is not a redirect: the page never left the sign-in screen when the credentials ` +
    `were submitted. The click landed before the application hydrated, so the form ` +
    `submitted natively (or hydration reset the fields), and the replay did not recover it.\n` +
    `  Fix the flow's sign-in: assert something only a signed-in page shows immediately ` +
    `after the submit click, so the failure is caught here rather than as a pile of ` +
    `defects about the feature.`
  );
}

/**
 * Does this fill block type a credential? The shared shape behind both
 * hydration signatures and the sign-in verdict — one spelling, so the three
 * cannot drift apart.
 */
function credentialShapedBlock(fills: readonly FlowStep[]): boolean {
  return fills.some((step) =>
    /password|passwd|pwd/i.test(
      `${(step as { selector?: string }).selector ?? ''} ${(step as { intent?: string }).intent ?? ''}`,
    ),
  );
}

/**
 * The evidence marker for a native submit whose form named none of its fields
 * — see `nativeFormResubmitDetected`. Not a parameter name, because there
 * were none; the finding's wording branches on it.
 */
export const NATIVE_SUBMIT_UNNAMED = '(unnamed form fields)';

/** The replayed copy of a step, labelled so the bundle reads as what happened. */
function markReplayed(
  step: FlowStep,
  reason = 'the form submitted natively before hydration',
): FlowStep {
  return {
    ...step,
    intent: `${(step as { intent?: string }).intent ?? step.action} — replayed after ${reason}`,
  } as FlowStep;
}

/**
 * Did hydration EAT the fills? The second signature of the same race, seen
 * live on DB_04_01/DB_06_01/DB_07_01: the Sign-in click lands pre-hydration
 * but the form does NOT navigate (so `nativeFormResubmitDetected` has no URL
 * evidence) — instead React hydrates after the fills and resets its
 * controlled inputs, the click submits an empty password, and the page just
 * sits on the login screen. Even reconstruction's re-clicks then fail,
 * because nothing re-fills what hydration wiped.
 *
 * Evidence-based like its sibling: a credential-shaped field that reads back
 * a DIFFERENT value than the step typed (typically empty) is the signature.
 * Checked only when the block is credential-shaped, and each read is a
 * single immediate `inputValue` — the click already settled, so there is
 * nothing to wait for. A field that cannot be read (gone, not an input) is
 * skipped, never guessed at.
 *
 * Returns the lost field's selector (the evidence), or null.
 */
export async function fillsLostToHydration(
  valueOf: (selector: string) => Promise<string | null>,
  fills: readonly FlowStep[],
): Promise<string | null> {
  const credentialShaped = (step: FlowStep): boolean =>
    /password|passwd|pwd/i.test(
      `${(step as { selector?: string }).selector ?? ''} ${(step as { intent?: string }).intent ?? ''}`,
    );
  // No credential fill anywhere in the block → no reads at all: ordinary
  // form interactions must not pay a page round-trip per fill.
  if (!fills.some(credentialShaped)) return null;
  for (const step of fills) {
    if (!credentialShaped(step)) continue;
    const selector = (step as { selector?: string }).selector;
    const typed = (step as { value?: string }).value;
    if (!selector || typeof typed !== 'string' || typed === '') continue;
    const now = await valueOf(selector);
    if (now !== null && now !== typed) return selector;
  }
  return null;
}

async function executeSteps(
  runner: SmartRunner,
  steps: readonly FlowStep[],
  baseUrl: string | undefined,
  issues: StepIssue[],
): Promise<void> {
  // The contiguous fill/type block immediately behind the step now running —
  // what a hydration replay would have to repeat. See
  // `nativeFormResubmitDetected`; one replay per section, ever, so a page
  // that keeps racing cannot loop the run.
  const recentFills: FlowStep[] = [];
  // The URL as it stood when the block began — the baseline for the
  // unnamed-fields signature in `nativeFormResubmitDetected`. Captured at the
  // block's FIRST fill so "the URL gained a query string" is a real
  // observation rather than an assumption about what a login URL looks like.
  let urlBeforeFills: string | null = null;
  let hydrationReplayed = false;
  for (let rawIndex = 0; rawIndex < steps.length; rawIndex += 1) {
    const raw = steps[rawIndex];
    if (raw === undefined) break;
    const issuesBefore = issues.length;
    // **The data lock, taken and given back by the steps themselves.** A run
    // in a parallel suite holds a data section only from the step that
    // changes it to the last step that still needs the change to hold — see
    // `cli/data-locks.ts`. This is the only place that blocks, and it blocks
    // before the step is narrated, so a lane waiting on a section reads as
    // waiting rather than as a slow step.
    await runner.dataGate?.before(raw, runner.page.url());
    // A step that does not pass no longer aborts the run: it is recorded and
    // classified (fail / error / dead end), and the next step gets its turn.
    // The run reports everything it saw at the end instead of stopping at the
    // first thing that went wrong.
    //
    // Before that final classification comes **in-run reconstruction**: a
    // step's first failure asks the repair model for a rebuilt step against
    // the live page (the same job `--repair` does between runs, without the
    // re-run), and the step is retried until its failures reach
    // `STEP_RECONSTRUCT_TRIES`. Attempts a later reconstruction rescued are
    // marked superseded — recorded, but an outcome for nothing. Two honesty
    // rails: an **assertion keeps its claim verbatim** (a reconstruction may
    // only insert preparation before it — a claim rewritten until it passes
    // proves nothing, the same argument that keeps the agent rung off
    // assertions), and every rescue files a `medium` defect, because a flow
    // that needs rebuilding every run is drifting from the app.
    let original: FlowStep;
    try {
      original = interpolateStep(raw, runner.variables);
    } catch (error) {
      // Bad interpolation (an unknown {{var}}) fails this step and moves on,
      // exactly as it did before reconstruction existed — there is nothing a
      // rebuilt step could do about a variable the run never saved.
      const kind = classifyStepFailure(raw.action, error);
      runner.bundle.reclassifyLastStep(kind, raw.action);
      issues.push({
        action: raw.action,
        selector: (raw as { selector?: string }).selector ?? null,
        kind,
        message: error instanceof Error ? error.message : String(error),
      });
      runner.dataGate?.after(raw);
      if (stopAfterFirstIssue()) throw new StopAfterFirstIssue();
      continue;
    }
    let plan: FlowStep[] = [original];
    let failures = 0;
    const supersededIndexes: number[] = [];
    const history: Array<{ attempt: number; summary: string; outcome: string }> = [];
    let lastProposal: { replacement: FlowStep; inserted: number; reasoning: string } | null = null;

    for (;;) {
      let failedStep: FlowStep = original;
      try {
        for (const step of plan) {
          // Before anything else. A run bounced to the sign-in page cannot
          // answer the question it was asked — see `assertSessionHeld`.
          //
          // Exempt for a `signIn` and nothing else (HIR-EC-009, 2026-09-04):
          // a flow whose setup is `goto <app page>` then `signIn` starts with
          // an empty jar (`signsInItself` declines the inherited session), so
          // the goto bounces to the login page and all three stranded
          // conditions hold on the very step that exists to sign in — and
          // `#bootstrapSession` cannot rescue it either, because it bails
          // when the flow signs in itself. A sign-in page is exactly where a
          // `signIn` expects to be. The exemption is this step only: the
          // steps AFTER it are guarded as before (if the sign-in did not
          // take, the next step still stops the run), `signOut` is not
          // exempt, and `#strandedMessage`'s own three conditions — which
          // the ladder also consults to refuse a heal onto login furniture —
          // are untouched.
          if (step.action !== 'signIn') runner.assertSessionHeld();
          await runner.narrate(
            runner.bundle.steps.length,
            step.action,
            (step as { intent?: string | undefined }).intent,
          );
          await runner.paceStep();
          try {
            await executeStep(runner, step, baseUrl, issues);
            runner.noteAction(step.action);
            runner.noteResolveOutcome(false);
          } catch (error) {
            runner.noteAction(step.action, true);
            runner.noteResolveOutcome(
              error instanceof StepResolutionError && /^could not resolve/.test(error.message),
            );
            failedStep = step;
            throw error;
          }
        }
      } catch (error) {
        if (error instanceof StopAfterFirstIssue) throw error;
        // A lost session is fatal: it stops the flow rather than being
        // recorded as one more failed step among many.
        if (error instanceof SessionLostError) throw error;
        // A dead browser is fatal too, and it is an *environment* fact.
        if (error instanceof Error && isBrowserGone(error.message)) {
          throw new BrowserGoneError(
            `the browser went away mid-run (${error.message.split('\n')[0]}) — ` +
              'this is an environment failure, not an application result; every ' +
              'step after this point was skipped rather than blamed on the app',
          );
        }

        failures += 1;
        const recordedIndex = runner.bundle.steps.length - 1;

        const repair = runner.stepRepair;
        // `canExpress` guards the ask the schema refuses every answer to: a
        // step whose action the repair schema cannot spell (DB, HTTP,
        // workflow) makes the model echo the action, fail validation on
        // every identical temperature-0 retry, and open the structured-output
        // breaker for the rest of the run.
        if (
          repair &&
          failures < STEP_RECONSTRUCT_TRIES &&
          !reconstructionFutile(error) &&
          repair.canExpress?.(original.action) !== false
        ) {
          const proposal = await askReconstruction(
            runner,
            repair,
            original,
            failedStep,
            error,
            failures,
            history,
          );
          if (proposal !== null) {
            supersededIndexes.push(recordedIndex);
            const isAssertion = (ASSERTION_ACTIONS as readonly string[]).includes(original.action);
            // An assertion keeps its claim; everything else may be replaced —
            // except an entry step whose replacement drops the value.
            //
            // An entry step's VALUE is its claim, exactly as an assertion's
            // text is. Live (HIR-EC-001 run `720d801c`, 2026-09-08) a failed
            // `selectOption Position = 40106337` was reconstructed as a bare
            // `click` on the Position trigger. The click landed, the step was
            // recorded green, and nothing had been selected — so R199 never
            // fired, Organization, Cost Center, Work Location and Job Code
            // stayed empty, and thirty of the next steps failed against a form
            // that had never been filled. The working reconstruction is the
            // other shape the model offers: open the control in `insertBefore`
            // and click the OPTION in the replacement, which names the value in
            // a selector of its own. Only the shape that silently drops the
            // value is refused, and the step then fails as it did before.
            const dropsTheValue = !isAssertion && reconstructionDropsValue(original, proposal.replacement);
            if (dropsTheValue) {
              history.push({
                attempt: failures,
                summary:
                  `the reconstruction replaced ${original.action} ` +
                  `${JSON.stringify(('value' in original ? original.value : '') ?? '')} with a click on the same ` +
                  'control, which puts no value in — refused, the step stands as authored',
                outcome: 'reconstruction refused',
              });
            }
            const replacement = isAssertion || dropsTheValue ? original : proposal.replacement;
            plan = [...proposal.insertBefore, replacement];
            lastProposal = {
              replacement,
              inserted: proposal.insertBefore.length,
              reasoning: proposal.reasoning,
            };
            history.push({
              attempt: failures,
              summary: proposal.reasoning,
              outcome: 'retrying in-run with this reconstruction',
            });
            continue;
          }
        }

        // Out of tries (or nothing to try): final classification, as ever.
        const kind = classifyStepFailure(failedStep.action, error);
        runner.bundle.reclassifyLastStep(kind, failedStep.action);
        issues.push({
          action: failedStep.action,
          selector: (failedStep as { selector?: string }).selector ?? null,
          kind,
          message: error instanceof Error ? error.message : String(error),
        });
        break;
      }

      // The plan ran clean. If earlier tries failed, they are attempts now,
      // not outcomes — and the rescue itself is a finding.
      if (supersededIndexes.length > 0 && lastProposal) {
        runner.bundle.supersedeSteps(supersededIndexes);
        runner.bundle.noteReconstruction({
          attempt: failures + 1,
          // A second recording boundary, and one the first fix missed: these
          // serialise the WHOLE step, so a masked `detail.value` on the step
          // itself does nothing for the copy stored here. Found by grepping a
          // real bundle after the fill masking landed and finding the password
          // still present under `reconstruction.from`.
          from: JSON.stringify(runner.maskStepSecrets(original)),
          to: JSON.stringify(runner.maskStepSecrets(lastProposal.replacement)),
          inserted: lastProposal.inserted,
          reasoning: lastProposal.reasoning,
          model: repairModelId(runner),
        });
        runner.recordReconstructionDefect(original, failures);
      }

      // Hydration-race recovery, after the plan ran clean: a click that
      // "passed" may still have submitted its form natively (pre-hydration),
      // which no per-step check can see — the click landed, the page just did
      // the wrong thing with it. Detect it from the URL's own evidence, file
      // the finding (it is an app fact too: credentials reached the URL), and
      // replay the fill block + click once against the hydrated page.
      if (original.action === 'fill' || original.action === 'type') {
        if (recentFills.length === 0) urlBeforeFills = runner.page.url();
        recentFills.push(original);
      } else if (original.action === 'click') {
        const param = hydrationReplayed
          ? null
          : await nativeFormResubmitDetected(
              () => runner.page.url(),
              recentFills,
              undefined,
              urlBeforeFills,
            );
        // Same race, second signature: no URL evidence because the form never
        // navigated — hydration reset the controlled inputs instead, and the
        // click submitted emptiness (DB_04_01/DB_06_01/DB_07_01 live). Only
        // consulted when the first signature is absent, and it reads the
        // fields once, immediately.
        const lostField =
          param !== null || hydrationReplayed
            ? null
            : await fillsLostToHydration(async (selector) => {
                try {
                  return await runner.page.locator(selector).inputValue({ timeout: 1_000 });
                } catch {
                  return null;
                }
              }, recentFills);
        if (param !== null || lostField !== null) {
          hydrationReplayed = true;
          const reason =
            param !== null
              ? 'the form submitted natively before hydration'
              : 'hydration reset the filled fields';
          if (param !== null) runner.recordNativeResubmitFinding(original, param);
          else runner.recordLostFillFinding(original, lostField as string);
          await runner.page
            .waitForLoadState('networkidle', { timeout: 10_000 })
            .catch(() => undefined);
          await runner.page.waitForTimeout(300).catch(() => undefined);
          try {
            for (const fill of recentFills) {
              await executeStep(runner, markReplayed(fill, reason), baseUrl, issues);
            }
            await executeStep(runner, markReplayed(original, reason), baseUrl, issues);
          } catch (error) {
            if (error instanceof SessionLostError) throw error;
            // A failed replay classifies like any failed step; the original
            // finding already says what went wrong the first time.
            const kind = classifyStepFailure(original.action, error);
            runner.bundle.reclassifyLastStep(kind, original.action);
            issues.push({
              action: original.action,
              selector: (original as { selector?: string }).selector ?? null,
              kind,
              message: error instanceof Error ? error.message : String(error),
            });
          }
          // Did the recovery work? Only a credential block can answer, and
          // only after the replay: still on the sign-in page means this run
          // holds no session, and every later step is about to be asserted
          // against a page it has no right to be on. See `#strandedMessage`.
          runner.noteSignInOutcome(looksLikeSignIn(runner.page.url()));
        } else if (credentialShapedBlock(recentFills)) {
          // A credential submit with no hydration evidence and no sign-in URL
          // left behind is a submit that worked — clear any earlier verdict,
          // so a flow that retries its login is judged on the retry.
          runner.noteSignInOutcome(false);
        }
        recentFills.length = 0;
        urlBeforeFills = null;
      } else {
        recentFills.length = 0;
        urlBeforeFills = null;
      }
      break;
    }
    runner.dataGate?.after(raw);
    if (
      raw.action === 'workflow' &&
      issues.length > issuesBefore &&
      skipAfterFailedLeg()
    ) {
      const goal = raw.goal.slice(0, 80);
      const failedStep = runner.bundle.steps[runner.bundle.steps.length - 1];
      const message = `not run: depends on step ${failedStep?.index ?? rawIndex} (${goal}), which did not reach its goal`;
      const tail = dependentTail(steps, rawIndex);
      for (const skippedIndex of tail) {
        const skipped = steps[skippedIndex];
        if (skipped === undefined) continue;
        runner.bundle.recordSkipped(skipped, message);
        runner.dataGate?.after(skipped);
      }
      rawIndex = tail[tail.length - 1] ?? rawIndex;
    }
    if (stopAfterFirstIssue() && issues.length > issuesBefore) throw new StopAfterFirstIssue();
  }
}

const PLACE_REESTABLISHING_ACTIONS: ReadonlySet<FlowStep['action']> = new Set([
  'goto',
  'signIn',
  'signOut',
  'workflow',
  'back',
  'forward',
  'setClock',
  'clearStorage',
]);

/**
 * The steps after a failed `workflow` leg that only made sense on the page the
 * leg was meant to reach: everything up to the next action that re-establishes
 * where the run is, OR the next browser-free step — a `request`/DB step reads
 * nothing off the page, and the assertions after it belong to it, not to the
 * leg (a consent case whose leg dead-ends still proves its claim through the
 * API it calls next).
 */
export function dependentTail(steps: readonly FlowStep[], failedIndex: number): number[] {
  const tail: number[] = [];
  for (let index = failedIndex + 1; index < steps.length; index += 1) {
    const step = steps[index];
    if (step === undefined || PLACE_REESTABLISHING_ACTIONS.has(step.action) || BROWSER_FREE_ACTIONS.has(step.action)) break;
    tail.push(index);
  }
  return tail;
}

export function skipAfterFailedLeg(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['WOWLIDATOR_SKIP_AFTER_FAILED_LEG'] ?? '').trim().toLowerCase() !== 'off';
}

function repairModelId(runner: SmartRunner): string {
  return runner.stepRepair?.id ?? 'unknown';
}

/**
 * One reconstruction ask against the live page. Best-effort everywhere: a
 * model that cannot be reached, declines, or answers garbage returns null,
 * and the step falls through to its ordinary classification.
 */
async function askReconstruction(
  runner: SmartRunner,
  repair: FlowRepairModel,
  original: FlowStep,
  failedStep: FlowStep,
  error: unknown,
  attempt: number,
  history: Array<{ attempt: number; summary: string; outcome: string }>,
): Promise<{ insertBefore: FlowStep[]; replacement: FlowStep; reasoning: string } | null> {
  let axTree = '(page unavailable for a fresh accessibility-tree read)';
  try {
    axTree = await captureAxTree(runner.page, DEFAULT_RECONSTRUCT_MAX_AX_NODES);
  } catch {
    // The live page is right here; if even that read fails, the proposal is
    // still worth asking for.
  }
  try {
    const proposal = await repair.repair({
      flow: { name: runner.bundle.name, steps: [original] },
      failedStep,
      section: 'steps',
      index: 0,
      error: describe(error),
      axTree,
      url: runner.page.url(),
      attempt,
      history,
    });
    // The call was made whatever the answer says — a `canFix: false` costs the
    // same tokens a fix does, and a bill that omits the refusals understates
    // exactly the runs that struggled most.
    runner.bundle.noteModelSpend(proposal.inputTokens ?? 0, proposal.outputTokens ?? 0);
    if (!proposal.canFix) return null;
    return {
      insertBefore: proposal.insertBefore,
      replacement: proposal.replacement,
      reasoning: proposal.reasoning,
    };
  } catch {
    // Provider trouble is not a page fact; the step classifies as it would
    // have without reconstruction.
    return null;
  }
}

async function executeStep(
  runner: SmartRunner,
  step: FlowStep,
  baseUrl: string | undefined,
  issues: StepIssue[],
): Promise<void> {
  runner.assertBackendAllowed(step.action);
  {
    switch (step.action) {
      case 'use':
        // expandFlow() removes these before a run starts. Reaching one means a
        // caller executed a flow it never expanded — say so, rather than
        // silently skipping a fragment and running an incomplete test.
        throw new Error(
          `internal: unexpanded "use" step for "${step.flow}" — ` +
            'call expandFlow() before executing a composed flow',
        );
      case 'when': {
        const matched = await runner.evaluateWhen(
          {
            ...(step.visible !== undefined ? { visible: step.visible } : {}),
            ...(step.hidden !== undefined ? { hidden: step.hidden } : {}),
            ...(step.enabled !== undefined ? { enabled: step.enabled } : {}),
            ...(step.disabled !== undefined ? { disabled: step.disabled } : {}),
          },
          step.intent,
        );
        const branch = matched ? step.then : step.else;
        if (branch?.length) await executeSteps(runner, branch, baseUrl, issues);
        break;
      }
      case 'goto':
        await runner.goto(resolveUrl(step.url, baseUrl));
        break;
      case 'click':
        await runner.click(step.selector, step.intent);
        break;
      case 'fill':
        await runner.fill(step.selector, step.value, step.intent, step.valueSource);
        break;
      case 'selectOption':
        await runner.selectOption(step.selector, step.value, step.intent, step.valueSource);
        break;
      case 'check':
        await runner.check(step.selector, step.intent);
        break;
      case 'uncheck':
        await runner.uncheck(step.selector, step.intent);
        break;
      case 'type':
        await runner.type(step.selector, step.value, step.intent, step.valueSource);
        break;
      case 'waitFor':
        await runner.waitFor(step.selector, step.intent, step.timeoutMs);
        break;
      case 'workflow':
        await runner.workflow(step.goal, step.script);
        break;
      case 'setLocalStorage':
        await runner.setLocalStorage(step.key, step.value);
        break;
      case 'clearStorage':
        await runner.clearStorage();
        break;
      case 'signOut':
        await runner.signOut(step.intent);
        break;
      case 'setClock':
        await runner.setClock(step.time, step.intent);
        break;
      case 'back':
        await runner.back(step.intent);
        break;
      case 'forward':
        await runner.forward(step.intent);
        break;
      case 'scrollTo':
        await runner.scrollTo(step.selector, step.intent);
        break;
      case 'expectScrollable':
        await runner.expectScrollable(step.selector, step.intent);
        break;
      case 'expectNotScrollable':
        await runner.expectNotScrollable(step.selector, step.intent);
        break;
      case 'expectText':
        await runner.expectText(step.selector, step.value, step.intent, step.anyOf, step.timeoutMs);
        break;
      case 'expectVisible':
        await runner.expectVisible(step.selector, step.intent, step.timeoutMs);
        break;
      case 'expectHidden':
        await runner.expectHidden(step.selector, step.intent, step.timeoutMs);
        break;
      case 'expectEnabled':
        await runner.expectEnabled(step.selector, step.intent);
        break;
      case 'expectDisabled':
        await runner.expectDisabled(step.selector, step.intent);
        break;
      case 'expectAnyVisible':
        await runner.expectAnyVisible(step.selectors, step.intent, step.timeoutMs);
        break;
      case 'expectFieldError':
        await runner.expectFieldError(step.selector, step.value, step.intent);
        break;
      case 'upload':
        await runner.upload(step.selector, step.files, step.intent);
        break;
      case 'download':
        await runner.download(step.selector, step.as, step.intent);
        break;
      case 'signIn':
        await runner.signIn(step.as, step.url, step.intent);
        break;
      case 'expectCount': {
        // A string count is a `{{variable}}` already interpolated above — the
        // saved half of a reconciliation claim. Non-numeric after
        // interpolation is the flow's fault, said loudly.
        const n = typeof step.count === 'string' ? Number(step.count.trim()) : step.count;
        if (!Number.isInteger(n) || n < 0) {
          throw new Error(
            `expectCount was given ${JSON.stringify(step.count)}, which is not a whole number after interpolation`,
          );
        }
        await runner.expectCount(step.selector, n, step.intent, step.timeoutMs);
        break;
      }
      case 'saveCount':
        await runner.saveCount(step.selector, step.as, step.intent);
        break;
      case 'saveText':
        await runner.saveText(step.selector, step.as, step.intent);
        break;
      case 'expectUrl':
        await runner.expectUrl(step.value, step.intent);
        break;
      case 'expectValue':
        await runner.expectValue(step.selector, step.value, step.intent);
        break;
      case 'expectAttribute':
        await runner.expectAttribute(step.selector, step.name, step.value, step.intent);
        break;
      case 'press':
        await runner.press(step.key, step.selector, step.intent);
        break;
      case 'expectFocused':
        await runner.expectFocused(step.selector, step.intent);
        break;
      case 'expectTabOrder':
        await runner.expectTabOrder(step.selectors, step.intent);
        break;
      case 'fillEach':
        await runner.fillEach(step.selector, step.cases, step.intent, step.submit);
        break;
      case 'fillRetry':
        await runner.fillRetry(step.selector, step.kind, step.failureSelector, {
          submit: step.submit,
          maxAttempts: step.maxAttempts,
          description: step.description,
          intent: step.intent,
        });
        break;
      case 'request':
        // `baseUrl` is passed through rather than applied here — see the note
        // on `FlowRequestSpec.baseUrl` about placeholders and percent-encoding.
        await runner.request({ ...step, baseUrl });
        break;
      case 'expectStatus':
        await runner.expectStatus(step.status, step.intent);
        break;
      case 'expectJson':
        await runner.expectJson(step.path, { value: step.value, intent: step.intent });
        break;
      case 'expectHeader':
        await runner.expectHeader(step.name, step.value, step.intent);
        break;
      case 'expectCalls':
        await runner.expectCalls(step);
        break;
      case 'dbSnapshot':
        await runner.dbSnapshot(step);
        break;
      case 'expectDbRow':
        await runner.expectDbRow(step);
        break;
      case 'expectDbDelta':
        await runner.expectDbDelta(step);
        break;
      case 'expectDbUnchanged':
        await runner.expectDbUnchanged(step);
        break;
      case 'expectDbCalled':
        await runner.expectDbCalled(step);
        break;
      case 'expectModal':
        await runner.expectModal(step.name, step.intent, step.timeoutMs);
        break;
      case 'closeModal':
        await runner.closeModal(step.button, step.intent);
        break;
      case 'snapshot':
        await runner.snapshot(step.name, step.selector);
        break;
    }
  }
}

/**
 * Execute a flow: setup → steps → teardown.
 *
 * Teardown runs even when the body fails, so a run cannot leave the browser
 * in a state that poisons the next test. A setup failure short-circuits the
 * body — preconditions that did not hold make the result meaningless.
 */
export async function executeFlow(runner: SmartRunner, flow: Flow): Promise<void> {
  const issues: StepIssue[] = [];

  // A lost session stops the body (see `assertSessionHeld`) but must not skip
  // cleanup: "teardown always runs" is the rule everywhere else, and a flow
  // that signed in and created something still has to put it back.
  let fatal: unknown;
  try {
    if (flow.setup?.length) await executeSteps(runner, flow.setup, flow.baseUrl, issues);
    await executeSteps(runner, flow.steps, flow.baseUrl, issues);
  } catch (error) {
    // A dead browser skips teardown outright — "teardown always runs" holds
    // for every failure that leaves a browser to run it in, and this one
    // does not. Attempting it would only stack more closed-target errors on
    // top of the one that matters.
    if (error instanceof BrowserGoneError) throw error;
    if (!(error instanceof SessionLostError) && !(error instanceof StopAfterFirstIssue)) throw error;
    fatal = error;
  }
  if (flow.teardown?.length) {
    try {
      await executeSteps(runner, flow.teardown, flow.baseUrl, issues);
    } catch (error) {
      // Teardown stranded too: the body's reason is the one worth reporting.
      if (error instanceof SessionLostError || error instanceof BrowserGoneError) {
        // swallow — the body's outcome is the story
      } else {
        throw error;
      }
    }
  }

  if (fatal instanceof StopAfterFirstIssue) throw new StepIssuesError(issues);
  if (fatal) throw fatal;
  if (issues.length > 0) throw new StepIssuesError(issues);
}

export interface RunFlowOptions {
  abortSignal?: AbortSignal | undefined;
  cdpUrl?: string | undefined;
  cachePath?: string | undefined;
  healer?: JitHealer | null | undefined;
  agent?: WorkflowAgent | null | undefined;
  dataModel?: DataModel | null | undefined;
  fastTimeoutMs?: number | undefined;
  healedTimeoutMs?: number | undefined;
  /** Film the run with a drawn-in pointer. Default `on`; see `video.ts`. */
  video?: VideoMode | undefined;
  /** Dwell per action moment in a condensed film, ms. Default `VIDEO_ACTION_DWELL_MS`. */
  videoDwellMs?: number | undefined;
  /** Perform like a person, for the film. Default: on while filming. See `SmartRunnerOptions.humanize`. */
  humanize?: boolean | undefined;
  /**
   * Give this run its own browser context even when it is not being filmed.
   *
   * Two runs sharing `browser.contexts()[0]` share its pages, and a suite that
   * runs its cases concurrently would have them clicking in each other's tabs
   * — the exact interleaving the panel's one-browser-at-a-time rule exists to
   * prevent, moved inside a single command. A recorded run already gets its
   * own context for an unrelated reason (recording is a property of a context),
   * which is why this only has to cover `--video off`.
   *
   * The session is carried across exactly as the recording path carries it, so
   * isolation does not silently sign the run out.
   */
  isolate?: boolean | undefined;
  /**
   * Whether a context this run creates starts with the attached browser's
   * session (cookies + storage). Default true — the reason a filmed run can
   * still test a page someone signed into by hand. `false` starts EMPTY, and
   * is what a flow that signs in ITSELF wants: an inherited session is a
   * different account signed in before its first step, and on this
   * application a stale admin session left in the browser by an earlier run
   * put every persona's case on the admin's landing page instead of the login
   * form. `runFlow` sets it from the flow's own shape — see `signsInItself`.
   */
  inheritSession?: boolean | undefined;

  /**
   * The suite's session vault. Before the run, a banked session for this
   * flow's origin is injected (unless the flow signs in itself); after it,
   * a run that ends signed in on that origin banks its own state — so one
   * sign-in serves the whole suite. See `engine/session-vault.ts`.
   */
  sessionVault?: SessionVault | undefined;

  /** See `SmartRunnerOptions.personas`. */
  personas?: Record<string, { email: string; password: string }> | undefined;
  /** See `SmartRunnerOptions.personaBrowsers`. */
  personaBrowsers?: readonly string[] | undefined;
  /** See `SmartRunnerOptions.locale`. Wins over `Flow.locale`. */
  locale?: DateLocale | undefined;
  /** See `SmartRunnerOptions.downloadDir`. */
  downloadDir?: string | undefined;

  screenshots?: ScreenshotMode | undefined;
  /** See `SmartRunnerOptions.highlightTarget`. */
  highlightTarget?: boolean | undefined;
  /** See `SmartRunnerOptions.dbBaselineProbe`. */
  dbBaselineProbe?: DbBaselineProbe | undefined;
  captureDelayMs?: number | undefined;
  /** Let the agent make an unreachable control reachable. Default false. */
  agentAssist?: boolean | undefined;
  /** See `SmartRunnerOptions.agentMaxSteps`. */
  agentMaxSteps?: number | undefined;
  /** See `SmartRunnerOptions.mutationPolicy`. */
  mutationPolicy?: MutationPolicy | null | undefined;
  /**
   * Whether this run may exercise the backend at all. Default `true` — the
   * behaviour every run had before the toggle existed. `false` and no HTTP or
   * database step may run: not authored, not loaded, not dispatched. See
   * `backendStepsIn`.
   */
  backend?: boolean | undefined;
  /**
   * Route patterns the application's own repository declares, from the
   * indexed context graph. What lets a 404 be read correctly: on a path the
   * codebase declares no route for, the TEST asked for a page that does not
   * exist; on a path it does declare, the APPLICATION failed to serve one it
   * has. Empty means no repository was indexed and the run keeps no opinion.
   */
  declaredRoutes?: readonly string[] | undefined;
  /**
   * In-run step reconstruction: on a step's failure, ask this model for a
   * rebuilt step against the live page and retry, up to
   * `STEP_RECONSTRUCT_TRIES` total tries, before final classification.
   * Attempts a rescue supersedes count toward nothing; every rescue files a
   * `medium` drift defect; an assertion keeps its claim verbatim (only
   * preparation may be inserted before it). Null/absent disables.
   */
  stepRepair?: FlowRepairModel | null | undefined;
  /**
   * The suite's step-level data lock for this run — see `data-locks.ts`.
   *
   * A **function**, not a gate, because the flow that finally runs is not
   * always the flow the suite handed over: `--repair` re-authors it between
   * attempts, and a gate's windows are step identities in one flow's own
   * objects. Resolving it here, against the flow actually about to run, is
   * what keeps a repaired attempt locked instead of silently unlocked. A lone
   * run passes nothing and holds no lock.
   */
  dataGate?: ((flow: Flow) => DataGate | null) | null | undefined;
  /**
   * The auto-review judge: one small `agent`-role call when a run lands on
   * proved-?, ruling it `proved` at `AUTO_PROVE_CONFIDENCE` or better — see
   * `src/engine/review-judge.ts`. Null/absent leaves every proved-? for a
   * human, exactly as before the judge existed.
   */
  reviewJudge?: ReviewJudge | null | undefined;
  /**
   * Pause before each step, in ms. Zero (the default) keeps the hot path
   * hot. Under `video: 'always'` the default becomes
   * `DEMONSTRATION_STEP_DELAY_MS`: that mode records a film for a human to
   * watch, and a run that blurs through five states in two seconds
   * demonstrates nothing — the pause is what lets each state be seen, with
   * the caption naming the step about to happen.
   */
  stepDelayMs?: number | undefined;
  coverage?: boolean | undefined;
  baselineDir?: string | undefined;
  updateBaselines?: boolean | undefined;
  /** Observe the page's HTTP traffic over CDP. Default true. */
  network?: boolean | undefined;
  /** How much of an observed request may be recorded. Defaults to redacting. */
  networkRedaction?: RedactionPolicy | undefined;
  /** Credentials for `--as`; carried only so their password can be masked. */
  credentials?: { email: string; password: string } | undefined;
  /** Ring-buffer cap for the observer — see `SmartRunnerOptions.networkMaxCalls`. */
  networkMaxCalls?: number | undefined;
  /**
   * Transport for `request` steps. Defaults to the browser context's (so API
   * calls inherit the UI's session), or to Node's `fetch` for a browser-free
   * flow.
   */
  transport?: ApiTransport | null | undefined;
  /**
   * Database connection for DB verification steps. Defaults to
   * `WOWLIDATOR_DB_URL`; `null` disables. Lazy — a flow with no DB steps
   * never connects and never demands the driver.
   */
  db?: DbConfig | null | undefined;
  /** Pre-built DB client — the embedder/test seam. Wins over `db`. */
  dbClient?: DbClient | null | undefined;
  /** Append to and compare against this run-history index. Null disables. */
  historyPath?: string | null | undefined;
  /** Build the healer once the cache exists. Ignored when `healer` is given. */
  makeHealer?: ((cache: CacheManager) => JitHealer) | undefined;
  /** Defects from a generator pass, merged into this run's report. */
  defects?: readonly Defect[] | undefined;
  /** Provenance when this flow was generated rather than hand-written. */
  generatedBy?: GenerationProvenance | undefined;
  /** Called right after each step is recorded — for live progress output. */
  onStep?: ((step: ProofStep) => void) | undefined;
  /**
   * Called once, before the first step, with how many steps this run intends
   * to take. Live progress needs a denominator, and this is the only place it
   * is knowable: composition has been resolved by then, so it counts the steps
   * a fragment spliced in, and it is still before anything has run.
   */
  onPlan?: ((plan: RunPlan) => void) | undefined;
  /**
   * Directory that `use` paths resolve against — normally the directory of the
   * `.flow.json` being run. Defaults to the process's cwd, which is right for
   * a flow built in memory and wrong for one loaded from disk, so callers that
   * read a file should pass it.
   */
  flowDir?: string | undefined;
}

class RunAbortedError extends Error {
  override readonly name = 'RunAbortedError';

  constructor() {
    super('the suite stopped this case at its case ceiling');
  }
}

function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.reject(new RunAbortedError());
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new RunAbortedError());
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

/**
 * Actions that need no browser at all — shared with the proof bundle's set
 * definitions, so "does this step need a page" has exactly one answer. Note
 * this is `BROWSER_FREE_ACTIONS`, not `BACKEND_TIER_ACTIONS`: `expectCalls`
 * is backend-tier but needs the live observer, so its presence keeps a flow
 * on the browser path.
 */
const API_ONLY_ACTIONS = BROWSER_FREE_ACTIONS;

/**
 * True when nothing in this flow needs a page.
 *
 * Decided by inspection rather than by a flag, because it can't be wrong: a
 * flow of pure API steps has nothing to click, and asking the user to also
 * remember to pass `--no-browser` would only create a way to get it wrong.
 */
export function isBrowserFree(flow: Flow): boolean {
  const every = [...(flow.setup ?? []), ...flow.steps, ...(flow.teardown ?? [])];
  return every.length > 0 && every.every((step) => API_ONLY_ACTIONS.has(step.action));
}

async function executeApiSteps(
  api: ApiActions,
  db: DbActions,
  steps: readonly FlowStep[],
  baseUrl: string | undefined,
  issues: StepIssue[],
  bundle?: ProofBundleBuilder,
  dataGate?: DataGate | null,
  dbBaselineProbe?: DbBaselineProbe | null,
): Promise<void> {
  for (const step of steps) {
    // The same step-level data lock the browser path takes — a browser-free
    // flow writes to the same database as everything else.
    await dataGate?.before(step, undefined);
    // Same run-to-the-end rule as the browser path: a miss is classified and
    // collected, and the next step still runs.
    try {
      switch (step.action) {
        case 'request':
          await api.request({ ...step, baseUrl });
          break;
        case 'expectStatus':
          await api.expectStatus(step.status, step.intent);
          break;
        case 'expectJson':
          await api.expectJson(step.path, { value: step.value, intent: step.intent });
          break;
        case 'expectHeader':
          await api.expectHeader(step.name, step.value, step.intent);
          break;
        case 'dbSnapshot':
          await db.dbSnapshot(step);
          break;
        case 'expectDbRow':
          await db.expectDbRow(step);
          break;
        case 'expectDbDelta':
          await db.expectDbDelta(step);
          break;
        case 'expectDbUnchanged':
          await db.expectDbUnchanged(step);
          break;
        case 'expectDbCalled':
          await db.expectDbCalled(step);
          break;
        default:
          // Unreachable via `runFlow`, which checks `isBrowserFree` first — but
          // reachable by an embedder calling this directly, and a clear message
          // beats a `page is undefined` three frames down. (`expectCalls` lands
          // here on purpose: it needs the live observer, so it keeps a flow on
          // the browser path — see `API_ONLY_ACTIONS`.)
          throw new Error(
            `"${step.action}" needs a browser; this flow was run without one because every ` +
              'other step was an API or DB step',
          );
      }
      if (dbBaselineProbe && (API_STEP_ACTIONS.has(step.action) || DB_STEP_ACTIONS.has(step.action))) {
        try {
          bundle?.annotateDbChanges(await dbBaselineProbe.probe(), undefined);
        } catch (probeError) {
          bundle?.annotateDbChanges(undefined, probeError instanceof Error ? (probeError.message.split('\n')[0] ?? '') : String(probeError));
        }
      }
    } catch (error) {
      const kind = classifyStepFailure(step.action, error);
      bundle?.reclassifyLastStep(kind, step.action);
      issues.push({
        action: step.action,
        selector: null,
        kind,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      dataGate?.after(step);
    }
  }
}

/**
 * Run a flow that never opens a browser.
 *
 * Everything downstream of the run — the proof bundle, the HTML report, run
 * history and flake analysis, `--repair` — works on the result unchanged,
 * because none of them ever depended on there having been a page. Coverage is
 * the one exception, and it correctly reports nothing measured rather than 0%,
 * which would read as "every control was missed".
 */
/**
 * The label the bundle carries: the flow's own statement when the catalog
 * stamped one, a deterministic inference otherwise. Inference reads the
 * flow's name (on the catalog path that is the row's claim verbatim), every
 * step's intent, and the step shapes that can only mean refusal.
 */
function flowPolarity(flow: Flow): { polarity: TestPolarity; source: 'stated' | 'inferred' } {
  if (flow.polarity !== undefined) return { polarity: flow.polarity, source: 'stated' };
  const steps = [...(flow.setup ?? []), ...flow.steps];
  const text = [flow.name, ...steps.map((step) => ('intent' in step ? (step.intent ?? '') : ''))]
    .filter((t) => t !== '')
    .join('\n');
  return { polarity: inferPolarity(text, steps as never), source: 'inferred' };
}

export async function runApiFlow(flow: Flow, options: RunFlowOptions = {}): Promise<ProofBundle> {
  // The browser-free path meters the same way — see `runFlow`.
  const sessionBefore = claudeCliUsage();
  const quotaBefore = await sessionQuotaPoint();
  const apiPolarity = flowPolarity(flow);
  const bundle = new ProofBundleBuilder({
    name: flow.name,
    cdpUrl: null,
    cachePath: null,
    healerModel: null,
    generatedBy: options.generatedBy,
    onStep: options.onStep,
    polarity: apiPolarity.polarity,
    polaritySource: apiPolarity.source,
  });
  if (options.dbBaselineProbe) bundle.setDbBaseline(options.dbBaselineProbe.summary());
  if (options.defects?.length) bundle.addDefects(options.defects);

  let defectSeq = 0;
  const recordDefect = (
    category: Defect['category'],
    severity: Defect['severity'],
    title: string,
    detail: string,
  ): void => {
    defectSeq += 1;
    bundle.addDefect({
      id: `run-${defectSeq}`,
      source: 'runtime',
      category,
      severity,
      title,
      detail,
      stepIndex: bundle.steps.length - 1,
    });
  };
  // One store for both families — same reasoning as the runner's constructor.
  const variables = new VariableStore();
  const api = new ApiActions({
    transport: options.transport ?? new FetchTransport(),
    bundle,
    variables,
    redaction: options.networkRedaction,
    recordDefect,
  });
  const db = new DbActions({
    db: options.db === undefined ? defaultDbConfig() : options.db,
    client: options.dbClient,
    bundle,
    variables,
    recordDefect,
  });

  const issues: StepIssue[] = [];
  // Same per-flow resolution as the browser path: a browser-free flow writes
  // to the same database and takes the same locks.
  const gate = options.dataGate?.(flow) ?? null;
  const execution = (async (): Promise<void> => {
    if (flow.setup?.length) {
      await executeApiSteps(api, db, flow.setup, flow.baseUrl, issues, bundle, gate, options.dbBaselineProbe);
    }
    await executeApiSteps(api, db, flow.steps, flow.baseUrl, issues, bundle, gate, options.dbBaselineProbe);
    // Teardown still always runs — its job is to clean up regardless of how
    // the body went, and that reasoning has nothing to do with browsers.
    if (flow.teardown?.length) {
      await executeApiSteps(api, db, flow.teardown, flow.baseUrl, issues, bundle, gate, options.dbBaselineProbe);
    }
  })();
  try {
    await abortable(execution, options.abortSignal);
  } catch (error) {
    if (!(error instanceof RunAbortedError)) throw error;
    bundle.recordRunError(error);
    bundle.note(error.message);
  } finally {
    gate?.releaseAll();
    await db.close().catch(() => undefined);
  }

  bundle.setVariables(variables.snapshotForReport());
  if (issues.length > 0) bundle.recordIssueTally(new StepIssuesError(issues).message);
  // What the person's own Claude session was charged for this run. A delta
  // over the whole run rather than an absolute, so a suite of cases in one
  // process each carry their own share and never the accumulated total.
  await noteSessionSpend(bundle, sessionBefore, quotaBefore);
  const sealed = bundle.finish();

  if (options.historyPath !== null) {
    try {
      const history = new RunHistory(options.historyPath ?? undefined);
      const priors = await history.forFlow(sealed.name);
      const trend = analyseTrend(sealed, priors);
      bundle.setTrend(trend);
      await history.append(sealed);
      return options.abortSignal?.aborted === true
        ? structuredClone({ ...sealed, trend })
        : { ...sealed, trend };
    } catch {
      return options.abortSignal?.aborted === true ? structuredClone(sealed) : sealed;
    }
  }

  return options.abortSignal?.aborted === true ? structuredClone(sealed) : sealed;
}

/**
 * Connect, run a flow to completion (or first failure), and always return a
 * sealed proof bundle. A failing step is recorded, not thrown.
 *
 * A flow with no UI steps is dispatched to `runApiFlow` and never touches
 * Chrome — see `isBrowserFree`.
 */
/**
 * Does this flow authenticate on its own — a credential-shaped fill (a password
 * field by selector or intent, or the taught nameless-textbox idiom on a
 * sign-in page) anywhere in its setup or body?
 *
 * Decides whether a run should START with the attached browser's session. A
 * flow that signs in itself and also inherits a session begins as a different
 * account than it is about to become; measured on the application this was
 * written against, a stale admin session left in the browser by an earlier
 * run put an HRBP case on the admin landing page before its first step, and
 * the sign-in form the flow expected was not there.
 */
export function signsInItself(flow: Flow): boolean {
  const steps: FlowStep[] = [...(flow.setup ?? []), ...flow.steps];
  let onSignIn = false;
  for (const step of steps) {
    // A `signIn` step IS the flow signing in (EH-10): the bootstrap must
    // never race it, and an inherited session is never what it wants.
    if (step.action === 'signIn') return true;
    if (step.action === 'goto') {
      onSignIn = looksLikeSignIn(step.url);
      continue;
    }
    if (step.action !== 'fill' && step.action !== 'type') continue;
    const text = `${step.selector} ${step.intent ?? ''}`;
    if (/password|passwd|pwd/i.test(text)) return true;
    if (onSignIn && /role=textbox\s*>>\s*nth=/i.test(step.selector)) return true;
  }
  return false;
}

/**
 * The distinct people a flow signs in as, in order of first appearance — the
 * `as` of every `signIn` step, folded by `foldPersonaKey` so `<MANAGER_ACCOUNT>`
 * and `manager` count once. `when` branches are walked; a `use` fragment is
 * a file this cannot read and is left to the run.
 *
 * This is how many browsers a multi-persona case needs: the first persona
 * binds to the primary Chrome, every later one leases its own, so the extras
 * a case asks for are `personasIn(flow).length - 1`.
 */
export function personasIn(flow: Flow): string[] {
  const seen = new Map<string, string>();
  const walk = (steps: readonly FlowStep[]): void => {
    for (const step of steps) {
      if (step.action === 'signIn') {
        const key = foldPersonaKey(step.as);
        if (key !== '' && !seen.has(key)) seen.set(key, step.as);
      } else if (step.action === 'when') {
        walk(step.then);
        if (step.else) walk(step.else);
      }
    }
  };
  walk([...(flow.setup ?? []), ...flow.steps, ...(flow.teardown ?? [])]);
  return [...seen.values()];
}

export async function runFlow(
  sourceFlow: Flow,
  options: RunFlowOptions = {},
): Promise<ProofBundle> {
  // The session meter as it stands BEFORE this run. Everything the run then
  // spends is the difference — which is what makes a suite of cases sharing
  // one process each report their own share rather than the running total.
  // The quota point beside it, so a cost can be reported WITH how much of
  // the 5-hour session window the run moved (cached 30 s; null when the
  // account's quota is unreadable, and then simply absent from the proof).
  const sessionBefore = claudeCliUsage();
  const quotaBefore = await sessionQuotaPoint();
  // Composition is resolved once, here, so every caller — CLI, MCP, the repair
  // loop — gets it without asking, and everything downstream sees an ordinary
  // flow. `flowDir` is what makes a fragment path relative to the flow that
  // used it rather than to whatever directory the process happens to be in.
  const flow = hasIncludes(sourceFlow)
    ? await expandFlow(sourceFlow, { dir: options.flowDir ?? process.cwd() })
    : sourceFlow;

  // **Layer two of "not even present".** A flow carrying a backend step under
  // `backend: false` is refused HERE, before a browser opens and before a
  // single step runs — and refused, never silently skipped: a suite that
  // quietly drops assertions goes green having proved less than it claims,
  // which is the vacuous-pass failure in a new coat. The steps are named, so
  // the fix is obvious (turn the toggle on, or re-author the case).
  if (options.backend === false) {
    const offenders = backendStepsIn([...(flow.setup ?? []), ...flow.steps]);
    if (offenders.length > 0) {
      throw new BackendDisabledError(
        `"${flow.name}" carries ${offenders.length} backend step(s) — ` +
          `${[...new Set(offenders.map((one) => one.action))].join(', ')} — but this run has ` +
          'backend testing turned off. Nothing was run: a case whose claim needs the backend ' +
          'cannot be proved by silently dropping the step that proves it. Turn backend testing ' +
          'on (and give the run a database URL), or re-author the case to prove its claim ' +
          'through the page.',
      );
    }
  }

  // Announced before the browser-free branch, so both paths report a plan and
  // a progress bar does not silently stay empty for an API-only flow.
  //
  // `total` is what the flow intends, not what it will necessarily record: a
  // failure stops `steps` early, and `when` runs one branch of two. It is an
  // upper bound, and the honest one — a denominator that shrank as a run went
  // wrong would make a failing run look like it was accelerating.
  const plan: RunPlan = {
    setup: flow.setup?.length ?? 0,
    steps: flow.steps.length,
    teardown: flow.teardown?.length ?? 0,
    total: 0,
  };
  plan.total = plan.setup + plan.steps + plan.teardown;
  options.onPlan?.(plan);

  if (isBrowserFree(flow)) return runApiFlow(flow, options);

  const cache = new CacheManager(
    options.cachePath === undefined ? {} : { filePath: options.cachePath },
  );
  await cache.load();

  const healer =
    options.healer !== undefined ? options.healer : (options.makeHealer?.(cache) ?? null);

  // Resolved once, against the flow this run will actually execute.
  const gate = options.dataGate?.(flow) ?? null;

  const polarity = flowPolarity(flow);
  const bundle = new ProofBundleBuilder({
    name: flow.name,
    cdpUrl: options.cdpUrl ?? DEFAULT_CDP_URL,
    cachePath: cache.filePath,
    healerModel: healer?.model.id ?? null,
    generatedBy: options.generatedBy,
    onStep: options.onStep,
    polarity: polarity.polarity,
    polaritySource: polarity.source,
  });

  // Generator findings belong in the report even if the run dies at connect.
  if (options.defects?.length) bundle.addDefects(options.defects);

  // The one origin this flow tests, for the suite's session vault: banked
  // state is only ever injected into — and saved from — a matching origin.
  // Keyed per ACCOUNT (EH-10): a suite alternating employee and manager
  // cases used to hand a later case whichever account the previous one
  // ended as. A run that knows who it means to be (`--as`) inherits only
  // that account's banked session; one that does not takes the most recent.
  const vaultOrigin = flowOriginOf(flow);
  const bankedSession =
    options.sessionVault !== undefined && vaultOrigin !== null
      ? (options.sessionVault.get(vaultOrigin, options.credentials?.email) ?? undefined)
      : undefined;
  // And for every person the flow signs in as (one Chrome per persona): the
  // banked state under THEIR email, so the manager's second appearance in a
  // suite starts signed in on the manager's own browser.
  const sessionStates: Record<string, StoredSession> = {};
  if (options.sessionVault !== undefined && vaultOrigin !== null && options.personas !== undefined) {
    for (const label of personasIn(flow)) {
      const persona = resolvePersona(label, options.personas);
      if (persona === null) continue;
      const state = options.sessionVault.get(vaultOrigin, persona.email);
      if (state !== null) sessionStates[persona.email.toLowerCase()] = state;
    }
  }

  let runner: SmartRunner;
  try {
    runner = await SmartRunner.connect({
      cdpUrl: options.cdpUrl,
      cache,
      bundle,
      healer,
      agent: options.agent,
      dataModel: options.dataModel,
      // The flow's own card: the file is the artifact, so a re-run or a
      // repair still tells the runtime roles what the case proves.
      caseContext: flow.caseContext,
      fastTimeoutMs: options.fastTimeoutMs,
      healedTimeoutMs: options.healedTimeoutMs,
      video: options.video,
      videoDwellMs: options.videoDwellMs,
      humanize: options.humanize,
      isolate: options.isolate,
      // Explicit wins; else the flow's own shape decides. A flow that types a
      // password wants to be the account it types, not the one the browser
      // was left signed in as.
      inheritSession: options.inheritSession ?? !signsInItself(flow),
      personas: options.personas,
      personaBrowsers: options.personaBrowsers,
      ...(Object.keys(sessionStates).length === 0 ? {} : { sessionStates }),
      locale: options.locale ?? flow.locale,
      flowDir: options.flowDir,
      downloadDir: options.downloadDir,
      flowSignsInItself: signsInItself(flow),
      consentPolicy: flow.consentPolicy,
      screenshots: options.screenshots,
      highlightTarget: options.highlightTarget,
      dbBaselineProbe: options.dbBaselineProbe,
      captureDelayMs: options.captureDelayMs,
      agentAssist: options.agentAssist,
      agentMaxSteps: options.agentMaxSteps,
      mutationPolicy: options.mutationPolicy,
      // Forwarded explicitly, like everything else here. `connect` takes a
      // fresh object rather than this one, so a field added to
      // `RunFlowOptions` and not listed here reaches the runner as undefined
      // and its guard silently never fires — which is exactly what happened
      // to both of these when they were added (caught 2026-08-26 by a 404
      // test that saw `routes=0` inside the runner).
      backend: options.backend,
      declaredRoutes: options.declaredRoutes,
      deploymentUrl: flow.baseUrl,
      stepRepair: options.stepRepair,
      dataGate: gate,
      stepDelayMs: options.stepDelayMs,
      coverage: options.coverage,
      baselineDir: options.baselineDir,
      updateBaselines: options.updateBaselines,
      network: options.network,
      networkRedaction: options.networkRedaction,
      credentials: options.credentials,
      networkMaxCalls: options.networkMaxCalls,
      transport: options.transport,
      db: options.db,
      dbClient: options.dbClient,
      ...(bankedSession === undefined ? {} : { sessionState: bankedSession }),
    });
  } catch (error) {
    // Died before a single test step could run. The bundle still goes to run
    // history — a launch that failed at attach is a result worth recalling,
    // not a run that never happened.
    bundle.recordRunError(error);
    await noteSessionSpend(bundle, sessionBefore, quotaBefore);
    return appendToHistory(bundle.finish(), bundle, options, flow.caseContext);
  }

  const execution = executeFlow(runner, flow);
  try {
    await abortable(execution, options.abortSignal);
  } catch (error) {
    // The step itself is already recorded; keep the message at run level too.
    // A tally of step issues is kept apart from a fatal — see StepIssuesError.
    if (error instanceof StepIssuesError) bundle.recordIssueTally(error.message);
    else bundle.recordRunError(error);
  } finally {
    // A run that died mid-window must not take the section down with it: the
    // lanes waiting on it are other people's verdicts.
    gate?.releaseAll();
  }

  // Bank the session for the suite's later cases — observation-gated: only a
  // run that ENDS on this origin, off the sign-in page, with cookies to its
  // name, has a session worth carrying. Never a verdict: any failure here is
  // a convenience lost, not a run changed.
  if (options.sessionVault !== undefined && vaultOrigin !== null) {
    try {
      // Every person's session under their own account (one Chrome per
      // persona): each session that ends on the origin, off the sign-in
      // page, banks as the account it signed in as.
      const banked = new Set<string>();
      for (const session of await runner.exportSessions()) {
        if (session.url.startsWith(vaultOrigin) && !looksLikeSignIn(session.url)) {
          options.sessionVault.put(vaultOrigin, session.state, session.email);
          banked.add(session.email.toLowerCase());
        }
      }
      const url = runner.page.url();
      const endedAs = runner.lastSignedInAs ?? options.credentials?.email;
      if (!banked.has((endedAs ?? '').toLowerCase()) && url.startsWith(vaultOrigin) && !looksLikeSignIn(url)) {
        const state = await runner.exportSession();
        // Under the account the run ENDED as: the last `signIn`'s email,
        // else the `--as` account, else the anonymous slot.
        options.sessionVault.put(vaultOrigin, state, endedAs);
      }
    } catch {
      // The context may already be gone (a run-level error) — nothing to bank.
    }
  }

  // Recorded before the bundle is sealed by `close()`, so the run's own
  // share of the session meter travels with its proof.
  await noteSessionSpend(bundle, sessionBefore, quotaBefore);
  const sealed = await runner.close();
  const recorded = await appendToHistory(sealed, bundle, options, flow.caseContext);
  return options.abortSignal?.aborted === true ? structuredClone(recorded) : recorded;
}

/**
 * Record what this run charged the operator's Claude session, WITH where the
 * 5-hour window stood — a cost figure should never travel without its "and
 * how much of my session was that" half. The end reading bypasses the quota
 * cache (a short run would otherwise reread its own start snapshot and
 * report a 0% move); a run that made no claude calls fetches nothing.
 */
async function noteSessionSpend(
  bundle: ProofBundleBuilder,
  sessionBefore: ClaudeCliUsage,
  quotaBefore: SessionQuotaPoint | null,
): Promise<void> {
  const spent = claudeCliUsageSince(sessionBefore);
  if (spent.calls <= 0) return;
  let quota: { beforePercent: number; afterPercent: number; resetsAt: string | null } | undefined;
  if (quotaBefore !== null) {
    const after = await sessionQuotaPoint(process.env, true);
    if (after !== null) {
      quota = {
        beforePercent: quotaBefore.percent,
        afterPercent: after.percent,
        resetsAt: after.resetsAt,
      };
    }
  }
  bundle.noteSessionUsage('claude-cli', spent, quota);
}

/** The origin a flow tests against — its baseUrl, else its first goto. */
function flowOriginOf(flow: Flow): string | null {
  const gotos = [...(flow.setup ?? []), ...flow.steps].filter(
    (step): step is Extract<FlowStep, { action: 'goto' }> => step.action === 'goto',
  );
  for (const candidate of [flow.baseUrl, ...gotos.map((g) => g.url)]) {
    if (candidate === undefined) continue;
    try {
      return new URL(candidate).origin;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * History is diagnostic: a failure to read or append it must never change
 * the verdict of the run it is describing.
 */
async function appendToHistory(
  sealed: ProofBundle,
  bundle: ProofBundleBuilder,
  options: RunFlowOptions,
  caseContext?: string,
): Promise<ProofBundle> {
  // The auto-review judge, before the history write so the ruling is part of
  // the record a recall reads. One small call, only on proved-? runs, only
  // when a judge was built (agent role resolvable, not switched off). A
  // ruling stamps `review` — `effectiveStatus` then reads the run as passed
  // or failed everywhere, both ways at the bar since the gate widened to
  // every wording mismatch — and anything short of the bar leaves the
  // human's queue exactly as it was, with the judge's opinion on `notes`.
  // **A wording dispute whose expected words are the SHEET's own is a spec
  // question** (EN-2 audit: 29 of 31 genuine QA fails were deliberate design
  // vs the sheet, and a binary verdict hid every one). Stamped before the
  // judge so both surfaces can show it to BA triage whatever the ruling.
  if (sealed.status === 'needs-review' && typeof caseContext === 'string' && caseContext !== '') {
    const disputed = sealed.steps.filter((s) => s.unsure !== undefined && !s.superseded);
    const fromSheet =
      disputed.length > 0 &&
      disputed.every((s) => {
        const expected = s.detail?.['expected'];
        return typeof expected === 'string' && expected !== '' && caseContext.includes(expected);
      });
    if (fromSheet) {
      sealed.specQuestion = true;
      sealed.notes = [
        ...(sealed.notes ?? []),
        'spec question: every disputed expectation quotes the sheet\'s own wording and the page renders it differently — ' +
          'deliberate design vs the spec is a BA call, not a machine verdict',
      ];
    }
  }
  if (sealed.status === 'needs-review' && options.reviewJudge) {
    try {
      const pairs = reviewPairs(sealed);
      if (pairs.length > 0) {
        const judge = options.reviewJudge;
        const judgement = await judge.judge({
          flowName: sealed.name,
          caseContext,
          pairs,
        });
        let ruling = autoReviewRuling(judgement, judge.id);
        // **The judge may not overrule a human record without a person**
        // (S2 of the 2026-08-28 audit). PL_04_08: the sheet's Actual Result
        // is Passed — a tester ran it by hand — and the judge ruled "failed"
        // at 0.9 on "still visible contradicts hidden", never asking whether
        // "not shown" meant hidden, disabled or inert. A machine ruling that
        // contradicts a human one is downgraded to the human's queue with
        // the disagreement named; agreement, and rows with no record, stand.
        const humanSaid = sealed.generatedBy?.knownResult;
        if (ruling !== null && humanSaid !== undefined && ruling.verdict !== (humanSaid === 'passed' ? 'proved' : 'failed')) {
          sealed.notes = [
            ...(sealed.notes ?? []),
            `auto-review: ${judge.id} would rule ${ruling.verdict} (confidence ${judgement.confidence.toFixed(2)}) but the sheet's own Actual Result ` +
              `is ${humanSaid} — a machine may not overrule a human record; left for a person. ${judgement.reasoning.split('\n')[0] ?? ''}`,
          ];
          ruling = null;
        }
        if (ruling !== null) {
          sealed.review = ruling;
          sealed.notes = [
            ...(sealed.notes ?? []),
            `auto-review: ruled ${ruling.verdict} by ${judge.id} at confidence ${judgement.confidence.toFixed(2)} — ${judgement.reasoning.split('\n')[0] ?? ''}`,
          ];
        } else {
          sealed.notes = [
            ...(sealed.notes ?? []),
            `auto-review: left for a human — ${judge.id} said ${judgement.satisfied ? 'satisfied' : 'not satisfied'} at confidence ${judgement.confidence.toFixed(2)} (bar ${AUTO_PROVE_CONFIDENCE})`,
          ];
        }
      }
    } catch (error) {
      // A judge fault never changes a verdict — the run stays proved-?.
      sealed.notes = [...(sealed.notes ?? []), `auto-review: could not run — ${describe(error)}`];
    }
  }
  if (options.historyPath === null) return sealed;
  try {
    const history = new RunHistory(options.historyPath ?? undefined);
    const priors = await history.forFlow(sealed.name);
    const trend = analyseTrend(sealed, priors);
    bundle.setTrend(trend);
    await history.append(sealed);
    return { ...sealed, trend };
  } catch {
    return sealed;
  }
}
