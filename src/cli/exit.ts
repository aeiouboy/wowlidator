/**
 * The exit-code contract and run-outcome classification. Split out of cli.ts
 * verbatim.
 */

import type { ProofBundle } from '../engine/proof-bundle.js';
import { effectiveStatus, isPassing } from '../engine/proof-bundle.js';

/**
 * The exit-code contract.
 *
 * Frozen and documented because automation depends on it: a CI job has to tell
 * "the test found a bug" apart from "the test could not run", and those demand
 * opposite responses — one opens a ticket, the other fixes the runner. Adding a
 * code is a breaking change to every pipeline consuming wowlidator; changing what an
 * existing one means is worse.
 */
export const EXIT = {
  /** Ran to completion, everything passed. */
  ok: 0,
  /** Ran to completion, at least one step or case failed. A real result. */
  failed: 1,
  /** Could not start: bad arguments, missing file, invalid flow. */
  usage: 2,
  /** Could not start: no browser, undriveable Chrome, missing provider key. */
  environment: 3,
} as const;

/**
 * Map a finished run onto the contract.
 *
 * A run that never attached to a browser is an environment problem wearing a
 * failed run's clothes — reporting it as `failed` would have CI file bugs
 * against an application it never reached.
 */
export function exitCodeFor(bundle: {
  status: string;
  error?: string | undefined;
  review?: { verdict: 'proved' | 'failed'; at?: string | undefined } | undefined;
  steps?: ProofBundle['steps'] | undefined;
}): number {
  const status = effectiveStatus(bundle);
  // A pass with issues exits as a pass: the claims held. The issues are on
  // the record as findings, where a reader looks for them.
  if (isPassing(status)) return EXIT.ok;
  // proved-? — the run awaits a human ruling on a wording near-miss. Neither
  // ok (nothing is confirmed) nor failed (nothing about the product is
  // established either): like a blocked case, it produced no verdict yet, and
  // that is the environment family's meaning in the suite contract.
  if (status === 'needs-review') return EXIT.environment;
  // A run the harness alone ended — every broken step an `error`, no claim
  // contradicted — is the environment family whatever its message says. The
  // per-step story outranks the message regex below, which only knows the
  // handful of phrasings that were taught to it (an undeclared table, an
  // unknown variable and a refused provider all exited 1 before this).
  if (
    bundle.steps !== undefined &&
    harnessOnly({ status: bundle.status, review: bundle.review, steps: bundle.steps }) !== null
  ) {
    return EXIT.environment;
  }
  // "The browser went away mid-run" joins the attach failures: a run without
  // a browser is an environment problem wearing a failed run's clothes, and
  // reporting it as `failed` would have CI file bugs against an application
  // the run never reached. See `BrowserGoneError` in the runner.
  if (
    bundle.error &&
    // "database unavailable" and "network observation" join the browser
    // failures for the same reason: a check the harness could not make says
    // nothing about the application, and exiting 1 would have CI file a bug
    // against an app the check never reached. See `DbUnavailableError` in
    // `src/db/client.ts` and the observer guard on `expectCalls`.
    /could not attach to a browser|Browser context management|browser went away mid-run|database unavailable|network observation (?:unavailable|truncated)/.test(
      bundle.error,
    )
  ) {
    return EXIT.environment;
  }
  return EXIT.failed;
}

/**
 * Classify an error that escaped a command.
 *
 * The backstop for the exit-code contract: an unrecognised flag, an unreadable
 * file and an unreachable browser all used to surface as 1 — "the tests
 * failed" — which is the one thing none of them mean.
 */
export function classifyError(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/Unknown option|argument is required|not allowed|Unexpected argument/i.test(message)) {
    return EXIT.usage;
  }
  if (/ENOENT|not valid JSON|Unexpected token/i.test(message)) return EXIT.usage;
  // A mutation policy that cannot be read is a bad argument, not a bad run.
  if (/mutation policy \(.*\) is not valid/i.test(message)) return EXIT.usage;
  // A model that cannot produce schema output is the machinery failing, not
  // the application — "regard as system failure" is the contract here: CI
  // must fix the role's routing, not file a bug against the app.
  if (
    /could not attach to a browser|Browser context management|no API key|ConfigError|failed to produce a valid structured response|could not be asked — the provider refused|structured-output circuit is open|day's request quota|rate-limit headroom|database unavailable|network observation (?:unavailable|truncated)|workflow blocked \(/i.test(
      message,
    )
  ) {
    return EXIT.environment;
  }
  return EXIT.failed;
}

/** What became of one listed case. */
export interface CaseOutcome {
  name: string;
  /** `blocked` — it produced no verdict about the application. See `neverRan`. */
  /** `review` — proved-?: awaiting a human ruling on a wording near-miss. */
  verdict: 'passed' | 'failed' | 'blocked' | 'review';
  /** Null only when nothing was produced at all — the call itself threw. */
  bundle: ProofBundle | null;
  /** Where its report landed, when there is one. */
  reportPath?: string | undefined;
  /** Why it is blocked, or which step broke. */
  reason?: string | undefined;
  /**
   * True when this verdict was not earned this pass: a resume pulled it from
   * the catalog run's ledger, where an earlier pass under the same run key
   * recorded it. It still counts — the resumed catalog is the whole plan —
   * but the roll-up says which lines are inherited rather than fresh.
   */
  carried?: boolean | undefined;
}

/**
 * Did this run learn anything about the application, or only about the harness?
 *
 * Returns the reason it did not, or `null` when the verdict is real.
 *
 * **This, not the exception, is what a dead browser looks like.** `runFlow`
 * catches a failure to attach and returns a bundle carrying the error — status
 * `failed`, zero steps — so a `try`/`catch` around the call almost never fires,
 * and every case after the browser went away was reported as a red ✗ with no
 * explanation under it. Read literally that says the application is broken in
 * seven new ways; it says nothing about the application at all.
 *
 * The test is "the run failed, but no step of it did". Either nothing ran, or it
 * broke off partway without any assertion being contradicted. **Blocked, not
 * failed** — the same distinction `proofs-to-artifacts.py` makes for a step that
 * never ran, and the reason is the same: scoring the harness's own gap as a
 * defect sends someone to look for a bug that was never claimed to exist.
 */
export function neverRan(bundle: ProofBundle): string | null {
  if (isPassing(bundle.status)) return null;
  if (bundle.steps.some((step) => step.status !== 'passed')) return null;
  // First line only, same as `failureOf`: this goes on one line of a roll-up
  // that has one line per case, and the engine's attach error carries a
  // two-line "start Chrome like this" hint. The whole text is still on the
  // bundle and in the report.
  const reason = bundle.error?.split('\n')[0]?.trim();
  return reason === undefined || reason === ''
    ? 'the run ended before any step could fail'
    : reason;
}

/**
 * A run the HARNESS ended, with no claim about the application contradicted.
 *
 * Returns why, or `null` when some step actually delivered a finding.
 *
 * Measured on 544 live bundles (2026-08-24): 136 ended status `error`, and
 * every recorded cause was the machinery's — `database unavailable: no
 * connection is configured` (27 steps), the agent giving up or stalling, a
 * provider refusing the call on quota, `ERR_CONNECTION_REFUSED`, a goto
 * timeout. Every one of them was scored `failed` by the suite, so a missing
 * `WOWLIDATOR_DB_URL` read as "the test found a bug" twenty-two times — the
 * exact false-failure `exitCodeFor` already refuses for a single run, and the
 * stance the rest of the system already takes (`isErrorOutcome`: "the harness
 * ended it"; wowUI's "runtime error" label; `--rerun-errors` existing at all).
 *
 * The test is per step, not per status: **every non-superseded step that is
 * not passed has status `error`** — the status the engine reserves for "the
 * harness could not proceed". One `failed` or `dead-end` step anywhere and
 * this returns null: a contradicted claim or an unresolvable control is a
 * finding about the application, and an error step beside it must not soften
 * that verdict (`run completed with 1 failed, 2 error` stays failed).
 */
export function harnessOnly(bundle: {
  status: string;
  review?: { verdict: 'proved' | 'failed'; at?: string | undefined } | undefined;
  steps: ProofBundle['steps'];
}): string | null {
  const status = effectiveStatus(bundle);
  if (isPassing(status) || status === 'needs-review') return null;
  const broken = bundle.steps.filter((step) => !step.superseded && step.status !== 'passed');
  // Nothing broke at all — that is `neverRan`'s territory, not this one's.
  if (broken.length === 0) return null;
  if (broken.some((step) => step.status !== 'error')) return null;
  const first = broken[0]!;
  // A held mutation (Phase B, 2026-09-05) is the same family with a sharper
  // name: the harness withheld the one action that would have touched the
  // application, on the run's own policy or provenance rules. Typed on the
  // step, so this reads the record, never the message.
  if (first.blocked !== undefined) {
    return `blocked (${first.blocked.reason}, ${first.blocked.rule}) — the harness withheld the action; the application was never asked: ${first.blocked.message}`;
  }
  // A workflow leg the MODEL ended with `fail` (task C3, 2026-09-05): the
  // harness did not end this case and neither did the application — the
  // agent's own account did, and an account is a claim, never evidence. Said
  // as that, with the claim, so nobody reads "runtime error" and goes to fix
  // the runner. Typed on the record (`endedBy`), never parsed off the message;
  // the claim itself comes from the redacted record.
  if (first.agent?.endedBy === 'fail') {
    const claim = (first.agent.unreachable?.claim ?? first.agent.summary).split('\n')[0]?.trim() || first.agent.summary;
    return `no verdict — the agent's own account, unverified: ${claim}`;
  }
  const line = (first.error ?? 'runtime error').split('\n')[0]?.trim() || 'runtime error';
  return `runtime error — the harness ended this case, not the application: ${line}`;
}

/**
 * The exit code for a list of cases.
 *
 * A real failure outranks everything: something about the application is wrong.
 * Otherwise a case that never ran still cannot be reported as success — nothing
 * was proved — and it is an environment problem rather than a product one, so
 * it takes the environment code.
 */
export function suiteExit(outcomes: readonly CaseOutcome[]): number {
  if (outcomes.some((o) => o.verdict === 'failed')) return EXIT.failed;
  // A case awaiting human review is scored with the blocked family: nothing
  // was proved YET, and that cannot exit 0 — but nothing about the product
  // was established either, so it must not read as a defect.
  if (outcomes.some((o) => o.verdict === 'blocked' || o.verdict === 'review')) return EXIT.environment;
  return EXIT.ok;
}

/** The step that broke, as one line, or undefined when none did. */
export function failureOf(bundle: ProofBundle): string | undefined {
  const broke = bundle.steps.find((step) => step.status !== 'passed');
  if (broke === undefined) return undefined;
  return `${broke.intent ?? broke.action}: ${(broke.error ?? 'failed').split('\n')[0] ?? 'failed'}`;
}
