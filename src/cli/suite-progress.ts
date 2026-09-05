/**
 * The progress ledger of a suite — what a catalog run has proved so far, so a
 * run that stops short can be continued instead of started over.
 *
 * Live, 2026-08-21: a 108-row catalog stopped at row 36 when a model's daily
 * budget was refused; seventy cases were marked "never ran" and the only way
 * on was to run all 108 again — including the 36 that already had a verdict.
 * The ledger is written **after every case**, next to the claims file it
 * belongs to (`<claims>.progress.json`), and `catalog --resume` reads it:
 * a case with a verdict is skipped, a case that never ran (blocked) or was
 * never reached runs.
 *
 * Two rules:
 * - **A verdict is kept; a non-verdict is retried.** `passed`, `failed` and
 *   `review` say something about the application and are not re-run by a
 *   resume (re-running a failure is a retry, a different decision). `blocked`
 *   says nothing about the application and is exactly what a resume is for.
 * - **The cause of stopping is recorded where it can be.** A case that threw
 *   and a process that caught a signal both write `ended.cause`; a process
 *   killed outright cannot, and the reader then sees `ended: null` with the
 *   last recorded case as the high-water mark — honest about what is known.
 * - **An authored flow is remembered before it runs** (2026-09-05). Each
 *   case's flow path goes on the ledger the moment the case is queued
 *   (`authored`), so a resume replays it instead of paying the model again
 *   for a row the stopped pass had already written; a row with a verdict, a
 *   refusal, a vacuous flow or an explicit re-run is never replayed.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { CaseOutcome } from './exit.js';
import type { DeadEndRisk } from '../engine/proof-bundle.js';
import type { Flow } from '../engine/runner.js';
import { FlowFileSchema, SuiteLedgerSchema, parseArtifact } from '../artifacts/schemas.js';

export const LEDGER_VERSION = 1;

export interface LedgerOutcome {
  verdict: CaseOutcome['verdict'];
  /** The bundle's own status, when there was a bundle. */
  status: string | null;
  reason: string | null;
  reportPath: string | null;
  /** The authored flow on disk, when the run knew it — what `--rerun-vacuous` re-reads. */
  flowPath?: string | null | undefined;
  /** True when the flow asserted nothing about its claim (see `generator/vacuous.ts`). A resume re-authors it. */
  vacuous?: boolean | undefined;
  /**
   * The case's full name (`PL_06_05 ตรวจสอบ…`), so a resume can list this
   * finished case in its own roll-up without re-reading the sheet. Absent in
   * ledgers written before it was recorded; the id then stands in.
   */
  name?: string | undefined;
  /**
   * The case's proof bundle on disk, when the run wrote one. What a resume
   * re-reads to carry this finished case into its own suite index with the
   * full evidence rather than a bare verdict line.
   */
  proofPath?: string | null | undefined;
  /**
   * The Chromes this case ran on (CDP endpoints), primary first — more than
   * one when the case gave each persona a browser of its own. Absent for a
   * case that never ran and for ledgers written before 2026-09-03.
   */
  browsers?: string[] | undefined;
  /**
   * How many times authoring REFUSED to write this case (the flow lints:
   * ungrounded text, no assertion, …). Recorded so the row reads "authoring
   * refused: …" on the report instead of "never ran", and so a resume knows
   * to author it leniently once — and to stop re-authoring it after
   * `AUTHORING_REFUSAL_CAP` (2026-09-02: two rows of ec10n were refused on
   * every resume, each time spending the model twice and ending the run
   * with the same two "left").
   */
  authoringRefused?: number | undefined;
  /**
   * The cases this one needed finished first (CG-12), as their qualified
   * ids — recorded so a resume honours the edge: a dependent whose source
   * failed or never ran in the earlier pass is blocked again with the reason,
   * not re-run against a record the source never created.
   */
  dependsOn?: string[] | undefined;
  /**
   * The sheet's own verdict for this row (`Test Status`, normalised — CG-01):
   * `passed` / `failed`, or `blocked` when the sheet's testers could not run
   * it. Kept here so a resume's roll-up can still grade a carried case
   * against the sheet without re-reading it.
   */
  knownResult?: 'passed' | 'failed' | 'blocked' | undefined;
  at: string;
}

/** Refusals after which a resume stops re-authoring a row (an explicit rerun resets it). */
export const AUTHORING_REFUSAL_CAP = 2;

/**
 * A flow the pass authored and queued, before its case has an outcome.
 *
 * Measured 2026-09-05: a stopped catalog run (pause, SIGTERM, quota hold)
 * had authored 17 — then 11 — flows that never ran, and the resume authored
 * every one again, ~190 s and ~$1 of model time each. The flow file already
 * exists on disk the moment a case is queued (`writeFlowFile` runs first),
 * so the ledger only needs to remember WHERE it is: a resume reads it back
 * through the zod seam and pushes the case straight into the run queue.
 */
export interface LedgerAuthored {
  /** The flow on disk — the same path the case's outcome records later. */
  flowPath: string;
  authoredAt: string;
  /** The pre-run dead-end risk judged after authoring, when there was one — kept so a fail-fast case stays fail-fast. */
  risk?: DeadEndRisk | undefined;
  scenarioId?: string | undefined;
}

export interface SuiteLedger {
  version: number;
  title: string;
  /** The case ids the suite set out to prove, in sheet order. */
  planned: string[];
  startedAt: string;
  updatedAt: string;
  /**
   * The authoring pass's stamp (`GenerationProvenance.generatedAt`). wowUI
   * groups runs by it, so a resume reuses it and its cases land under the
   * original group rather than opening a new one. Null until the first
   * flow of the pass is authored.
   */
  generatedAt: string | null;
  /**
   * The catalog run's unique key: `<catalog name, slugged>@<pass stamp>` —
   * minted when the run is initialised, before anything is authored, and
   * reused verbatim by every resume, so the whole life of one approved list
   * (first run, pauses, continues, reruns) answers to one key. Null only in
   * ledgers written before the key existed.
   */
  runKey: string | null;
  /**
   * What started this run — enough to rebuild a resume command after the
   * process (and the panel that spawned it) are gone. Paths are absolute.
   * Absent in ledgers written before it was recorded.
   */
  launch?:
    | {
        catalog: string;
        claims: string;
        url?: string | undefined;
        repo?: string | undefined;
        /**
         * Whether the original pass had the multi-page agent (S8 of the
         * 2026-08-28 audit). A resume whose config lacks a role the pass
         * was authored with refuses at the boundary — nine be100 cases
         * errored one step at a time with "needs the multi-page agent, but
         * none is configured" on a resume that had silently dropped it.
         */
        agent?: boolean | undefined;
        /**
         * The account the run signed in as (`--as`) — the EMAIL only, never
         * the password, which rides env and is deliberately not recorded. A
         * resume rebuilt from this record (the panel restarted, the job's
         * env gone) can then ask for the password rather than run without
         * one: measured 2026-09-02 on ec10, a credential-less resume had
         * every journey capture bounce to the sign-in page, six rows refused
         * as login-only flows, and the four that ran fail at "Sign in".
         */
        persona?: string | undefined;
        /**
         * The persona labels the run had credentials for, as label → EMAIL
         * (CG-05) — never a password. A resume rebuilt from this record
         * knows which `--persona` entries to ask for again.
         */
        personas?: Record<string, string> | undefined;
        /** The workbook slice this run was (`--sheet` / `--category`, CG-11). */
        sheets?: string[] | undefined;
        categories?: string[] | undefined;
        /** Whether Blocked / Pending rows were authored on purpose (`--include-blocked`). */
        includeBlocked?: boolean | undefined;
      }
    | undefined;
  /**
   * The database baseline taken before this run's first case (see
   * `src/db/baseline.ts`): where the snapshot file is, which tables, when,
   * and — once it has happened — the restore's outcome. A resume reads it
   * rather than snapshotting again: the state BEFORE the run is the baseline,
   * whatever the cases since have done. `wowlidator db restore` reads it too,
   * for a run that was paused or killed before its own restore could run.
   */
  dbBaseline?:
    | {
        path: string;
        tables: string[];
        takenAt: string;
        mode: 'snapshot' | 'restore';
        restored?: { at: string; ok: boolean; detail: string } | undefined;
      }
    | undefined;
  outcomes: Record<string, LedgerOutcome>;
  /**
   * The flows authored this run, by case id, from the moment each is queued
   * (`recordAuthored`, via the runner's `noteAuthored` hook). A resume reuses
   * an entry whose case still has no verdict — see `resumeAuthored`. Absent
   * in ledgers written before 2026-09-05.
   */
  authored?: Record<string, LedgerAuthored> | undefined;
  /** Set when the run ended — cleanly or not. Null while it is (or was last seen) running. */
  ended: { at: string; cause: string | null; complete: boolean } | null;
}

/** Beside the claims file: `be100.claims.json` → `be100.claims.progress.json`. */
export function ledgerPathFor(claimsPath: string): string {
  return claimsPath.replace(/\.json$/i, '') + '.progress.json';
}

export function newLedger(title: string, planned: readonly string[]): SuiteLedger {
  const now = new Date().toISOString();
  return {
    version: LEDGER_VERSION,
    title,
    planned: [...planned],
    startedAt: now,
    updatedAt: now,
    generatedAt: null,
    runKey: null,
    outcomes: {},
    ended: null,
  };
}

export async function readLedger(path: string): Promise<SuiteLedger | null> {
  try {
    // Parsed, not asserted (Phase C): a resume REPLAYS this file's verdicts
    // into its own roll-up, so an outcome whose verdict is not one of the
    // four the suite scores must make the whole ledger unreadable rather
    // than ride in as a carried case.
    const parsed = parseArtifact<SuiteLedger>(SuiteLedgerSchema, JSON.parse(await readFile(path, 'utf8')));
    if (!parsed.ok || parsed.value.version !== LEDGER_VERSION) return null;
    const ledger = parsed.value;
    // Ledgers written before the run key existed read back as key-less, not broken.
    ledger.runKey ??= null;
    return ledger;
  } catch {
    return null;
  }
}

export async function writeLedger(path: string, ledger: SuiteLedger): Promise<void> {
  ledger.updatedAt = new Date().toISOString();
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}

/** For a signal handler, where nothing may be awaited before the process goes. */
export function writeLedgerSync(path: string, ledger: SuiteLedger): void {
  ledger.updatedAt = new Date().toISOString();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}

/** The case id a suite case name starts with — `PL_06_05 ตรวจสอบ…` → `PL_06_05`. */
export function caseIdOf(name: string): string {
  return name.split(/\s+/, 1)[0] ?? name;
}

export function recordOutcome(
  ledger: SuiteLedger,
  outcome: CaseOutcome,
  extra: {
    flowPath?: string | undefined;
    vacuous?: boolean | undefined;
    proofPath?: string | undefined;
    authoringRefused?: number | undefined;
    dependsOn?: readonly string[] | undefined;
    knownResult?: 'passed' | 'failed' | 'blocked' | undefined;
  } = {},
): void {
  // Which Chromes the steps ran on, in order of first use — read off the
  // proof, the one place that knows (the runner stamps each step).
  const browsers: string[] = [];
  for (const step of outcome.bundle?.steps ?? []) {
    if (step.browser !== undefined && !browsers.includes(step.browser)) browsers.push(step.browser);
  }
  ledger.outcomes[caseIdOf(outcome.name)] = {
    ...(extra.authoringRefused === undefined ? {} : { authoringRefused: extra.authoringRefused }),
    ...(browsers.length === 0 ? {} : { browsers }),
    ...(extra.dependsOn === undefined || extra.dependsOn.length === 0 ? {} : { dependsOn: [...extra.dependsOn] }),
    ...(extra.knownResult === undefined ? {} : { knownResult: extra.knownResult }),
    verdict: outcome.verdict,
    status: outcome.bundle?.status ?? null,
    reason: outcome.reason ?? null,
    reportPath: outcome.reportPath ?? null,
    flowPath: extra.flowPath ?? null,
    vacuous: extra.vacuous ?? false,
    name: outcome.name,
    proofPath: extra.proofPath ?? null,
    at: new Date().toISOString(),
  };
}

/**
 * Remember where a queued case's flow was written, so a resume can run it
 * without authoring the row again. Called the moment the case is queued —
 * the file is already on disk by then — and overwritten by a re-authoring.
 */
export function recordAuthored(
  ledger: SuiteLedger,
  caseName: string,
  entry: { flowPath: string; risk?: DeadEndRisk | undefined; scenarioId?: string | undefined; authoredAt?: string | undefined },
): void {
  ledger.authored ??= {};
  ledger.authored[caseIdOf(caseName)] = {
    flowPath: entry.flowPath,
    authoredAt: entry.authoredAt ?? new Date().toISOString(),
    ...(entry.risk === undefined ? {} : { risk: entry.risk }),
    ...(entry.scenarioId === undefined ? {} : { scenarioId: entry.scenarioId }),
  };
}

/**
 * Drop the authored flows of the given cases: what every EXPLICIT re-run
 * (`--rerun-case`, `--rerun-errors`, `--resume-from`, …) does beside
 * `markForRerun`, because the ask is "author it again from the sheet row",
 * and a resume that stopped before the re-authoring must not replay the
 * flow the ask rejected.
 */
export function forgetAuthored(ledger: SuiteLedger, ids: readonly string[]): void {
  if (ledger.authored === undefined) return;
  for (const id of ids) delete ledger.authored[id];
  if (Object.keys(ledger.authored).length === 0) delete ledger.authored;
}

/**
 * Which of `rows` a resume may run from their recorded flow, and which it
 * must author. Pure — the file itself is judged by `resumeAuthored`.
 *
 * `reuse`: the row still counts as remaining (no verdict), authoring never
 * refused it, its flow was never judged vacuous, and the ledger holds an
 * authored entry for it. `author`: remaining, and any of those fails.
 * `settled`: rows with a verdict already — a resume touches neither list
 * for them (the caller normally filtered them out first). Each list keeps
 * `rows`' own order, the order everything downstream keeps.
 */
export function reusableAuthored<R extends { caseId: string }>(
  ledger: SuiteLedger,
  rows: readonly R[],
): { reuse: { row: R; entry: LedgerAuthored }[]; author: R[]; settled: R[] } {
  const left = new Set(remaining(ledger, rows.map((row) => row.caseId)));
  const reuse: { row: R; entry: LedgerAuthored }[] = [];
  const author: R[] = [];
  const settled: R[] = [];
  for (const row of rows) {
    if (!left.has(row.caseId)) {
      settled.push(row);
      continue;
    }
    const outcome = ledger.outcomes[row.caseId];
    const entry = ledger.authored?.[row.caseId];
    const refused = (outcome?.authoringRefused ?? 0) > 0;
    const vacuous = outcome?.vacuous === true;
    if (entry === undefined || typeof entry.flowPath !== 'string' || entry.flowPath === '' || refused || vacuous) {
      author.push(row);
      continue;
    }
    reuse.push({ row, entry });
  }
  return { reuse, author, settled };
}

/**
 * Read an authored flow back through the zod seam (`FlowFileSchema`). The
 * shape the runner replays — a name, step lists whose entries name an
 * action — must hold; a missing file, bad JSON or a wrong shape is a typed
 * refusal naming what was wrong, never a throw and never a partial flow.
 */
export async function loadAuthoredFlow(flowPath: string): Promise<{ ok: true; flow: Flow } | { ok: false; reason: string }> {
  let raw: string;
  try {
    raw = await readFile(flowPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === 'ENOENT' ? 'file is missing' : `unreadable (${code ?? (error instanceof Error ? error.message : String(error))})` };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: `not valid JSON — ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = parseArtifact<Flow>(FlowFileSchema, value);
  return parsed.ok ? { ok: true, flow: parsed.value } : { ok: false, reason: `not a flow file (${parsed.issue})` };
}

/**
 * The resume's split of the rows still to run: the flows it can REUSE — read
 * from disk and parsed — and the rows it must AUTHOR. A reusable entry whose
 * file is missing or fails the schema falls back to authoring, with the
 * reason logged against the file; one line per reused flow and one summary
 * line say what the resume saved. Never throws on a bad file.
 */
export async function resumeAuthored<R extends { caseId: string }>(
  ledger: SuiteLedger,
  rows: readonly R[],
  options: { log?: ((line: string) => void) | undefined } = {},
): Promise<{ reuse: { row: R; entry: LedgerAuthored; flow: Flow }[]; author: R[] }> {
  const split = reusableAuthored(ledger, rows);
  const reuse: { row: R; entry: LedgerAuthored; flow: Flow }[] = [];
  const fallen = new Set<string>();
  for (const { row, entry } of split.reuse) {
    const loaded = await loadAuthoredFlow(entry.flowPath);
    if (!loaded.ok) {
      options.log?.(`resume: ${row.caseId} — recorded flow ${entry.flowPath} cannot be reused (${loaded.reason}); authoring it again`);
      fallen.add(row.caseId);
      continue;
    }
    options.log?.(`resume: ${row.caseId} — flow reused from ${entry.flowPath}, authored ${entry.authoredAt}`);
    reuse.push({ row, entry, flow: loaded.flow });
  }
  // Rows' own order for the author list, fallen rows included.
  const author = rows.filter((row) => fallen.has(row.caseId) || split.author.includes(row));
  options.log?.(`resume: ${reuse.length} flows reused, ${author.length} rows to author`);
  return { reuse, author };
}

/**
 * Mark every recorded outcome whose flow proves nothing about its claim as
 * needing a re-run. `judge` reads the flow file and answers why it is
 * vacuous, or null. Returns the ids marked. The verdict becomes `blocked` —
 * a vacuous pass was never a verdict about the application.
 */
export async function markVacuous(
  ledger: SuiteLedger,
  judge: (flowPath: string) => Promise<string | null>,
): Promise<string[]> {
  const marked: string[] = [];
  for (const [id, outcome] of Object.entries(ledger.outcomes)) {
    if (!outcome.flowPath || outcome.verdict === 'blocked') continue;
    const why = await judge(outcome.flowPath);
    if (why === null) continue;
    outcome.verdict = 'blocked';
    outcome.vacuous = true;
    outcome.reason = `vacuous: ${why}`;
    marked.push(id);
  }
  return marked;
}

/**
 * Mark every recorded outcome `pick` selects as needing a run again — the
 * verdict becomes `blocked` (so `remaining()` includes it) and the reason
 * says which re-run asked for it. Returns the ids marked. Used for "rerun
 * all errors" (the harness broke, not the app) and "heal all failed" (a
 * second go with autoheal on).
 */
export function markForRerun(
  ledger: SuiteLedger,
  pick: (outcome: LedgerOutcome, id: string) => boolean,
  label: string,
): string[] {
  const marked: string[] = [];
  for (const [id, outcome] of Object.entries(ledger.outcomes)) {
    // A row authoring refused is blocked already and still a rerun candidate:
    // the explicit ask lifts the refusal cap so it is authored again.
    const refused = (outcome.authoringRefused ?? 0) >= AUTHORING_REFUSAL_CAP;
    if ((outcome.verdict === 'blocked' && !refused) || !pick(outcome, id)) continue;
    outcome.verdict = 'blocked';
    outcome.reason = `${label}: ${outcome.reason ?? outcome.status ?? 'no reason recorded'}`;
    delete outcome.authoringRefused;
    marked.push(id);
  }
  return marked;
}

/** The cases the harness ended, not the application: an `error` bundle or no bundle at all. */
export function isErrorOutcome(outcome: LedgerOutcome): boolean {
  return (
    outcome.status === 'error' ||
    (outcome.verdict === 'failed' && outcome.status === null) ||
    // Authoring refused to write it: the harness's gap, never the application's.
    (outcome.authoringRefused ?? 0) > 0
  );
}

/** A real failure about the application: failed or dead-end. */
export function isFailedOutcome(outcome: LedgerOutcome): boolean {
  return outcome.verdict === 'failed' && (outcome.status === 'failed' || outcome.status === 'dead-end');
}

/**
 * Which planned cases still need a run: never reached, or reached and blocked.
 * A case with a verdict is done as far as a resume is concerned.
 */
export function remaining(ledger: SuiteLedger, planned: readonly string[] = ledger.planned): string[] {
  return planned.filter((id) => {
    const done = ledger.outcomes[id];
    if (done === undefined) return true;
    // Refused by authoring twice (strict, then lenient): re-authoring a third
    // time is the same two model calls for the same answer. It stays blocked
    // with its reason on the report; `--rerun-errors` resets the count.
    if ((done.authoringRefused ?? 0) >= AUTHORING_REFUSAL_CAP) return false;
    return done.verdict === 'blocked' || done.vacuous === true;
  });
}

export interface LedgerSummary {
  planned: number;
  passed: number;
  failed: number;
  review: number;
  blocked: number;
  notReached: number;
}

/**
 * The finished cases a resume inherits rather than re-runs: every planned case
 * that was not run this pass and already holds a real verdict. `blocked` and
 * vacuous outcomes are excluded — they are exactly what the resume exists to
 * run — and so is anything the current pass ran (its fresh outcome stands).
 * Returned in plan order, since that is the order everything downstream keeps.
 */
export function carriedOutcomes(
  prior: Record<string, LedgerOutcome>,
  planned: readonly string[],
  ranIds: ReadonlySet<string>,
): { id: string; outcome: LedgerOutcome }[] {
  const carried: { id: string; outcome: LedgerOutcome }[] = [];
  for (const id of planned) {
    if (ranIds.has(id)) continue;
    const outcome = prior[id];
    if (outcome === undefined || outcome.verdict === 'blocked' || outcome.vacuous === true) continue;
    carried.push({ id, outcome });
  }
  return carried;
}

/**
 * Order merged outcomes as the plan someone approved reads, not as a stopwatch
 * result: a resume's roll-up interleaves carried and fresh cases, and sheet
 * order is the one order both sides share. Names outside the plan (a suite
 * with no planned ids) keep their existing relative order, after the planned.
 */
export function sortByPlan(outcomes: readonly CaseOutcome[], planned: readonly string[]): CaseOutcome[] {
  if (planned.length === 0) return [...outcomes];
  const rank = new Map(planned.map((id, index) => [id, index]));
  return [...outcomes]
    .map((outcome, index) => ({ outcome, index, at: rank.get(caseIdOf(outcome.name)) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map((entry) => entry.outcome);
}

export function summariseLedger(ledger: SuiteLedger): LedgerSummary {
  const counts = { passed: 0, failed: 0, review: 0, blocked: 0 };
  for (const id of ledger.planned) {
    const o = ledger.outcomes[id];
    if (o) counts[o.verdict] += 1;
  }
  const reached = counts.passed + counts.failed + counts.review + counts.blocked;
  return { planned: ledger.planned.length, ...counts, notReached: Math.max(0, ledger.planned.length - reached) };
}
