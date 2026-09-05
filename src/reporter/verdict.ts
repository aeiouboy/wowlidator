/**
 * The paragraph a report should open with.
 *
 * ## Why this is its own module
 *
 * A proof bundle answers "what did the machinery do". A reader arriving at a
 * red run needs three different answers, in this order: **what broke**, **which
 * side is at fault**, and **is this new**. All three are already in the bundle
 * — spread across the step list, the summary's frontend/backend split, the
 * defect categories, the network capture and the trend block — and reassembling
 * them is work every reader currently does by hand, badly.
 *
 * Everything here is a pure function of the bundle, so the wording can be
 * tested like any other output, and every sentence traces to recorded evidence.
 * Nothing is inferred beyond what the run actually observed: where the evidence
 * is correlational (network attribution), the copy says so, in the same words
 * `src/api/` uses — "while this step was waiting", never "because of".
 */

import type { ProofBundle, ProofStep } from '../engine/proof-bundle.js';

/** Which team a failure most likely belongs to. */
export type Owner = 'frontend' | 'backend' | 'mixed';

export interface Verdict {
  status: 'passed' | 'passed-with-issues' | 'needs-review' | 'failed' | 'error' | 'dead-end';
  /** One line: outcome, flow name. */
  headline: string;
  /** What broke, in the author's own words where they gave any. */
  what: string;
  /** Which side, and the evidence for saying so. Null when nothing failed. */
  side: string | null;
  /** Whether this is new, from run history. Null when there is no history. */
  history: string | null;
  owner: Owner | null;
  firstFailingStep: number | null;
}

/**
 * Wording lives in one map so it is greppable, reviewable and swappable —
 * including by teams who want it in another language. Functions rather than
 * templates because several need a count or a name.
 */
export const VERDICT_COPY = {
  passedHeadline: (name: string) => `PASSED — ${name}`,
  passedWithIssuesHeadline: (name: string) =>
    `PASS** — ${name} (every claim held; ** marks a step that only acted and broke — not a validation failure)`,
  passedWithIssuesWhat: (assertions: number, broken: number) =>
    `All ${assertions} claim${assertions === 1 ? '' : 's'} held, but ${broken} step${broken === 1 ? '' : 's'} that ` +
    'only acted (a click, a navigation, an agent leg) broke along the way. The claims are proved ' +
    'by the assertions that passed; the broken steps are listed below and filed as findings — ' +
    'read them before trusting the green, because a claim that holds whether or not the action ' +
    'before it landed may be a claim about the wrong thing.',
  needsReviewHeadline: (name: string) =>
    `PROVED-? — ${name} (a human must confirm: the wording on the page is a near-miss of the claim)`,
  needsReviewWhat: (unsure: number) =>
    `${unsure} assertion${unsure === 1 ? '' : 's'} failed only on WORDING, and closely: the page ` +
    'produced the right kind of thing under a name the claim does not quite match. Whether that is ' +
    'a spec violation or an acceptable rendering is a decision, not a measurement — the unsure ' +
    'steps below carry the exact expected-vs-actual pair as proof. Confirm the run proved or ' +
    'failed in the panel (or write `review` into the proof bundle); until then it counts as ' +
    'neither a pass nor a product failure.',
  failedHeadline: (name: string) => `FAILED — ${name}`,
  errorHeadline: (name: string) => `ERROR — ${name} (the run hit errors; this is not an assertion failure)`,
  // Family wording (2026-08-27): a dead end IS the test failing — the page
  // never offered what the case needed — so the headline leads with that and
  // keeps the mechanism in the parenthesis.
  deadEndHeadline: (name: string) => `TEST FAILED — ${name} (dead end: a control the case needed could not be found by any means; nothing left to try)`,
  passedAll: (steps: number) =>
    `All ${steps} step${steps === 1 ? '' : 's'} did what the test said they should.`,
  runError: 'The run could not complete. Nothing below was verified.',
  noSteps: 'No steps ran, so nothing was checked.',

  // What broke — chosen by the shape of the failure, not by guesswork.
  couldNotFind: (what: string) => `${what} — the control it needed was never found.`,
  /**
   * A step the agent had to judge its way past.
   *
   * PB_01_01 met a PDPA consent screen the flow never mentioned; without this
   * the report showed a bare `agent` badge and a reader had no way to learn
   * that a decision had been taken on their behalf. The agent's own words are
   * quoted, never paraphrased — the same rule the report follows for text
   * captured from the application.
   */
  agentDecided: (observed: string, decided: string) =>
    observed
      ? `The run met something the flow does not describe — the agent judged "${observed}" and decided to ${decided}.`
      : `The run met something the flow does not describe; the agent decided to ${decided}.`,
  // A content mismatch is the OPPOSITE of not-found: the element resolved and
  // answered, just not with the expected text. Calling it "never found" sent
  // readers hunting a missing control that was on screen the whole time.
  contentMismatch: (what: string) =>
    `${what} — the element was found, but the text it shows is not what the test expected.`,
  // Same inversion for an absence check: a timeout there means the element
  // STAYED VISIBLE, which is as far from "never found" as a failure gets.
  stayedVisible: (what: string) =>
    `${what} — the element the test expected to be absent was still on the page.`,
  assertionFailed: (what: string) => `${what} — the check did not hold.`,
  backendAnswered: (what: string) => `${what} — the endpoint did not answer as expected.`,
  stepFailed: (what: string) => `${what} — this step failed.`,
  // Where the failure happened outranks how: a step that ran against a
  // sign-in page says nothing about the feature it meant to test.
  strandedSide: (url: string) =>
    `The failing step ran against a sign-in page (${url}). If the flow did not mean to be ` +
    `testing that page, the session was never established and this failure says nothing ` +
    `about the feature — fix the flow's sign-in before reading anything else here.`,

  // Which side.
  frontendSide: (calls: number) =>
    calls > 0
      ? `This looks like a FRONTEND problem (the page or its selectors): all ${calls} network call${calls === 1 ? '' : 's'} during the run succeeded.`
      : 'This looks like a FRONTEND problem (the page or its selectors); no backend traffic was involved.',
  backendSide: (failures: number) =>
    // The closing clause belongs in both branches: whichever way the backend
    // failure surfaced, the actionable point is that the test is not at fault.
    failures > 0
      ? `This is a BACKEND problem: ${failures} request${failures === 1 ? '' : 's'} failed while the test was waiting. No amount of selector work will fix it.`
      : 'This is a BACKEND problem: an HTTP step the test made did not answer as expected. No amount of selector work will fix it.',
  mixedSide: 'Both sides failed in this run — treat the backend failures first, they may explain the rest.',

  // History.
  firstRun: 'First recorded run of this test — there is nothing to compare it against yet.',
  newlyBroken: 'This test was passing until this run.',
  stillBroken: (runs: number) => `This test has now failed ${runs} run${runs === 1 ? '' : 's'} in a row.`,
  newlyFixed: 'This test was failing and now passes.',
  stable: 'Consistent with recent runs.',
  flaky: 'This test alternates between passing and failing — treat the result as untrustworthy either way.',
} as const;

/** Actions whose failure is an assertion not holding, rather than a lost control. */
const ASSERTION_PREFIX = /^expect/;

/** The pathname, or the whole string when it is not a URL — regex fodder only. */
function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Describe a step the way its author would: their intent, else what it did. */
export function describeStep(step: ProofStep): string {
  if (step.intent) return `"${step.intent.replace(/\s+$/, '')}"`;
  const target = step.selector ?? step.resolvedSelector;
  return target ? `Step ${step.index} (${step.action} ${target})` : `Step ${step.index} (${step.action})`;
}

function whatBroke(step: ProofStep): string {
  const described = describeStep(step);
  const error = step.error ?? '';
  // Order is load-bearing. A content mismatch is frequently WRAPPED in a
  // "could not resolve" header (the ladder retried and every rung saw the
  // same wrong text), so the mismatch check must come first or the reader is
  // told a control on screen was "never found". An absence check's timeout is
  // the same inversion: the element was found and stayed.
  const base = /expected text to contain/i.test(error)
    ? VERDICT_COPY.contentMismatch(described)
    : step.action === 'expectHidden' && /Timeout .* exceeded/i.test(error)
      ? VERDICT_COPY.stayedVisible(described)
      : /could not resolve|did not resolve|Timeout .* exceeded/i.test(error)
        ? VERDICT_COPY.couldNotFind(described)
        : /expected status|expected .* to (contain|be)|did not match/i.test(error)
          ? VERDICT_COPY.backendAnswered(described)
          : ASSERTION_PREFIX.test(step.action)
            ? VERDICT_COPY.assertionFailed(described)
            : VERDICT_COPY.stepFailed(described);
  // What the page was showing outranks how the machinery failed to find
  // things on it — "the page said Access Denied" is the diagnosis, "could not
  // resolve" is a symptom. Quoted verbatim: evidence, never paraphrase.
  const showing = step.pageContext?.[0];
  const account = showing ? `The page was showing "${showing}" at the moment of failure. ${base}` : base;
  // A decision taken on the reader's behalf outranks the machinery's account
  // of how it failed to find things: "the agent accepted a consent screen and
  // it still did not resolve" is the diagnosis, "could not resolve" is the
  // symptom. Appended rather than prefixed — the page's own words still lead.
  return step.decision
    ? `${account} ${VERDICT_COPY.agentDecided(step.decision.observed, step.decision.decided)}`
    : account;
}

const HISTORY_COPY: Record<string, (bundle: ProofBundle) => string> = {
  'first-run': () => VERDICT_COPY.firstRun,
  'newly-broken': () => VERDICT_COPY.newlyBroken,
  'still-broken': (bundle) => VERDICT_COPY.stillBroken(bundle.trend?.sampleSize ?? 0),
  'newly-fixed': () => VERDICT_COPY.newlyFixed,
  stable: () => VERDICT_COPY.stable,
  flaky: () => VERDICT_COPY.flaky,
};

/**
 * Decide which side owns a failure.
 *
 * The precedence mirrors `ProofSummary`'s defect attribution, because the two
 * must never disagree: a report cannot say "frontend problem" above a defect
 * table filing it under backend.
 */
export function ownerOf(bundle: ProofBundle): Owner | null {
  const { frontend, backend } = bundle.summary;
  const backendBroke = backend.failed > 0 || backend.defects > 0;
  const frontendBroke = frontend.failed > 0 || frontend.defects > 0;
  if (backendBroke && frontendBroke) return 'mixed';
  if (backendBroke) return 'backend';
  if (frontendBroke) return 'frontend';
  return null;
}

/** Build the opening paragraph. Pure — every sentence comes from the bundle. */
export function buildVerdict(bundle: ProofBundle): Verdict {
  const failing = bundle.steps.find((step) => step.status !== 'passed' && step.status !== 'skipped');
  const owner = ownerOf(bundle);
  const summary = bundle.summary;

  const history = bundle.trend ? (HISTORY_COPY[bundle.trend.verdict]?.(bundle) ?? null) : null;

  if (bundle.status === 'passed') {
    return {
      status: 'passed',
      headline: VERDICT_COPY.passedHeadline(bundle.name),
      what: VERDICT_COPY.passedAll(summary.totalSteps),
      side: null,
      history,
      owner: null,
      firstFailingStep: null,
    };
  }
  if (bundle.status === 'passed-with-issues') {
    const counted = bundle.steps.filter((s) => !s.superseded);
    const assertions = counted.filter((s) => /^expect|^snapshot$|^fillEach$|^fillRetry$/.test(s.action)).length;
    const broken = counted.filter((s) => s.status !== 'passed' && s.status !== 'skipped').length;
    return {
      status: 'passed-with-issues',
      headline: VERDICT_COPY.passedWithIssuesHeadline(bundle.name),
      what: VERDICT_COPY.passedWithIssuesWhat(assertions, broken),
      side: null,
      history,
      owner: null,
      // The first broken step is where the reader should look, even on a pass.
      firstFailingStep: failing?.index ?? null,
    };
  }

  if (bundle.status === 'needs-review') {
    const unsure = bundle.steps.filter((s) => !s.superseded && s.unsure !== undefined).length;
    return {
      status: 'needs-review',
      headline: VERDICT_COPY.needsReviewHeadline(bundle.name),
      what: VERDICT_COPY.needsReviewWhat(unsure),
      side: null,
      history,
      owner: null,
      firstFailingStep: failing?.index ?? null,
    };
  }

  const what = failing
    ? whatBroke(failing)
    : bundle.error
      ? VERDICT_COPY.runError
      : VERDICT_COPY.noSteps;

  let side: string | null = null;
  // A failing step recorded on a sign-in URL outranks the frontend/backend
  // split: whatever the summary attributes, a step asserted against a login
  // page indicts the flow's sign-in, not the feature — the same evidence the
  // session guard reads, applied to the report's own copy. (Mirrors the
  // runner's looksLikeSignIn; the bundle is all this module may read.)
  const strandedUrl =
    failing?.url && /(^|\/)(login|signin|sign-in|auth|sso)(\/|$)/i.test(pathnameOf(failing.url))
      ? failing.url
      : null;
  if (strandedUrl !== null) side = VERDICT_COPY.strandedSide(strandedUrl);
  else if (owner === 'backend') side = VERDICT_COPY.backendSide(summary.networkFailures);
  else if (owner === 'frontend') side = VERDICT_COPY.frontendSide(summary.networkCalls);
  else if (owner === 'mixed') side = VERDICT_COPY.mixedSide;

  const headline =
    bundle.status === 'error'
      ? VERDICT_COPY.errorHeadline(bundle.name)
      : bundle.status === 'dead-end'
        ? VERDICT_COPY.deadEndHeadline(bundle.name)
        : VERDICT_COPY.failedHeadline(bundle.name);

  return {
    status: bundle.status,
    headline,
    what,
    side,
    history,
    owner,
    firstFailingStep: failing?.index ?? null,
  };
}

/** One rung of an escalation trace, rewritten for a reader. */
export interface TraceRung {
  rung: string;
  /** Plain-language account of what was attempted. */
  prose: string;
  /** The raw message, kept verbatim — evidence, not decoration. */
  detail: string;
}

const RUNG_PROSE: Record<string, string> = {
  fast: 'Tried the selector exactly as the test wrote it',
  case: 'Retried it ignoring letter-case',
  narrow: "Re-matched the author's text selector against what the page actually renders",
  // The free rungs added on the humi benchmark (2026-09-03): a control folded
  // inside a collapsed section, a fixed bar over the control, a claim held
  // against the label's container, and the two stop rungs that end the
  // ladder with a verdict instead of paying a model to disprove nothing.
  reveal: "Opened the collapsed section holding the control and retried the author's own selector",
  scroll: 'Scrolled the control clear of the fixed bar that was intercepting the pointer and retried',
  kin: "Checked the claim against the control's container, where a label's value sits beside it",
  absence: "Stopped — the text is nowhere in the page's visible text, so no repair could find it; the claim fails on the page as it stands",
  'not-found': 'Stopped — the application had navigated to a page it does not have (a 404 rendered in place); no repair attempted',
  cache: 'Tried a selector repaired on an earlier run',
  late: 'Gave the content one longer window to render',
  backend: 'Stopped without attempting a repair — a request had already failed',
  authorization: 'Stopped without attempting a repair — the page is an authorization failure',
  known: 'Stopped — this exact selector already dead-ended on this page earlier in the run',
  declined: 'Declined to ask the model for a repair',
  jit: 'Asked the model for a replacement selector',
  agent: 'Let the agent drive the browser to make the control reachable, then retried',
};

/**
 * Turn a `StepResolutionError` message into ordered, readable rungs.
 *
 * The raw message is a stack of `- rung "selector": message` lines, which reads
 * as machinery. The reader wants the story: what was tried, in what order, and
 * where it gave up. Unrecognised rungs pass through with their own name rather
 * than being dropped — a new rung must never silently vanish from the account.
 */
export function escalationTrace(error: string | undefined): TraceRung[] {
  if (!error || !error.includes('\n')) return [];
  const rungs: TraceRung[] = [];
  for (const line of error.split('\n')) {
    // A rung's name may carry a hyphen (`not-found:` — the app-404 stop rung);
    // the old `[a-z]+` read it as "not" and the account said "Tried the not
    // step". A lone `not` never names a rung, so the widening is safe.
    const match = /^\s*-\s+([a-z]+(?:-[a-z]+)*)\b[^:]*:\s*(.*)$/i.exec(line);
    if (!match) continue;
    const rung = (match[1] ?? '').toLowerCase();
    const detail = (match[2] ?? '').trim();
    const prose = RUNG_PROSE[rung] ?? `Tried the "${rung}" step`;
    // A dialog rung reports itself as `fast (after dismissing "X")`.
    const dismissed = /after dismissing "([^"]*)"/.exec(line);
    rungs.push({
      rung: dismissed ? 'dialog' : rung,
      prose: dismissed ? `Dismissed the "${dismissed[1]}" dialog and retried` : prose,
      detail,
    });
  }
  return rungs;
}
