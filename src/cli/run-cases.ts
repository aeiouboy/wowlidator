/**
 * Running a list of cases — one report per case, every case accounted for.
 * Split out of cli.ts verbatim.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { formatElapsed, phaseHeader, withLogTag } from '../log-format.js';

import { formatCoverage, meaningfulCoverage } from '../coverage/ax-coverage.js';
import {
  effectiveStatus,
  formatProofSummary,
  isPassing,
  familyLabel,
  issueSteps,
  writeProofBundle,
  type AgentRecord,
  type Defect,
  type GenerationProvenance,
  type ProofBundle,
} from '../engine/proof-bundle.js';
import { DEFAULT_CDP_URL, personasIn, runFlow, type Flow, type RunFlowOptions } from '../engine/runner.js';
import { AGENT_FAIL_FAST_MAX_STEPS } from '../orchestrator/workflow-agent.js';
import type { DeadEndRisk } from '../engine/proof-bundle.js';
import { describeRisk } from '../generator/dead-end-risk.js';
import {
  caseScheduleMeta,
  sectionAliaser,
  compatibleCases,
  expandSections,
  isGloballyExclusive,
  sectionsEnabled,
  windowsInterfere,
  type CaseScheduleMeta,
} from './sections.js';
import { SectionLocks, dataGateFor, dataLocksEnabled, dataWindows } from './data-locks.js';
import {
  LlmGovernorModel,
  QueueGovernor,
  RuleGovernorModel,
  governorMode,
  validateGovernorRead,
  validateGovernorWrite,
  type GovernorCaseFact,
  type GovernorObservation,
} from '../orchestrator/queue-governor.js';
import { raiseSessionCapFor } from '../providers/claude-cli-session.js';
import { ensureQuotaHold, quotaHolding, stopQuotaHold } from './quota-hold.js';
import { describeDiagnosis, diagnoseError } from '../generator/error-diagnosis.js';
import type { HealHintsProvider } from '../context/heal-hints.js';
import { growPool, laneBrowsers, writeFlowFile } from './artifacts.js';
import { BrowserLease } from '../browser/pool.js';
import { FlowRepairLoop } from '../repair/flow-repair-loop.js';
import { LlmFlowRepairModel } from '../repair/flow-repair-model.js';
import { RepairMemory } from '../repair/repair-memory.js';
import { SessionVault } from '../engine/session-vault.js';
import { slugify } from '../reporter/html-reporter.js';
import { RunHistory, formatTrend } from '../history/run-history.js';
import { resolveReportPath, writeHtmlReport } from '../reporter/html-reporter.js';
import { CatalogLiveReport } from './catalog-live-report.js';
import {
  baselineMaxRows,
  baselinePath,
  baselineProbe,
  detectBaselineTables,
  readBaseline,
  resolveBaselineMode,
  restoreBaseline,
  tablesNamedBySteps,
  takeBaseline,
  writeBaseline,
  type Baseline,
  type DbBaselineProbe,
} from '../db/baseline.js';
import {
  connectDb,
  connectDbWritable,
  defaultDbConfig,
  maskDsn,
  restoreDbConfig,
  type DbClient,
} from '../db/client.js';
import {
  DEFAULT_INDEX_FILENAME,
  writeSuiteIndex,
  type IndexEntry,
} from '../reporter/suite-index.js';
import { EXIT, failureOf, harnessOnly, neverRan, type CaseOutcome } from './exit.js';
import { vacuousFlow } from '../generator/vacuous.js';
import { describeUnprovedExclusivity, unprovedExclusivity } from '../generator/exclusivity.js';
import {
  caseIdOf,
  carriedOutcomes,
  newLedger,
  readLedger,
  recordOutcome,
  remaining,
  sortByPlan,
  writeLedger,
  writeLedgerSync,
  type LedgerOutcome,
  type SuiteLedger,
} from './suite-progress.js';
import {
  CaseQueue,
  DEFAULT_CONCURRENCY,
  PIPELINED_CONCURRENCY_AFTER_AUTHORING,
  PIPELINED_CONCURRENCY_WHILE_AUTHORING,
  caseWrites,
  dependencyStanding,
  dependsBackOn,
  orderDependentsAfterSources,
  readersFirst,
  runQueue,
  withWorkflowScripts,
  type DependencyStanding,
} from './case-plan.js';
import {
  hasGroundTruth,
  renderTruthTable,
  truthRows,
  truthTally,
  writeTruthTable,
  type KnownResult,
} from '../reporter/truth-table.js';
import type { CliOptions } from './options.js';
import { clearPauseFile, pauseFileFor, pauseRequested, requestPause, resetPause } from './pause.js';
import {
  assertRolesResolvable,
  buildAgent,
  buildDataModel,
  buildDiagnosisModel,
  buildHealer,
  buildInvestigationAgent,
  buildReviewJudge,
  buildStepRepair,
  emitTagged,
  lineLogger,
  planLogger,
  runPersonas,
  stepLogger,
} from './runtime.js';

/** One listed case, ready to run. */
export interface SuiteCase {
  /** How the case is named in the roll-up. */
  name: string;
  flow: Flow;
  /** Where the flow was written, when it was — recorded in the ledger for `--rerun-vacuous`. */
  flowPath?: string | undefined;
  /** Report `kind` — `catalog`, or the generator's own classification. */
  kind: string;
  /**
   * The sheet's Scenario ID this case belongs to (`PL_03`), when the list
   * came from a catalog. What `onCaseDone` consumers key on — the authoring
   * gate advances a scenario only when its queued cases have all finished.
   */
  scenarioId?: string | undefined;
  /**
   * Sub-folder for this case's artifacts, when the list has classes of its own.
   * A catalog's Scenario ID is one: the sheet already groups its rows, and a
   * folder per scenario keeps that grouping instead of flattening twelve
   * unrelated cases into one directory.
   */
  group?: string | undefined;
  /**
   * Absent for a hand-written flow re-run via `wowlidator run a b c` — the run
   * then reads as authored by nobody, exactly as its single-flow run would.
   */
  generatedBy?: GenerationProvenance | undefined;
  /** Static findings, ridden along with one case so they are not lost. */
  defects?: readonly Defect[] | undefined;
  /**
   * The pre-run dead-end risk judged after authoring (`dead-end-risk.ts`).
   * `fail-fast` runs the case once with no healer, no agent, no reconstruction
   * and no repair loop — see `failFastRunOptions`. Absent = the ordinary run.
   */
  risk?: DeadEndRisk | undefined;
  /**
   * Authoring REFUSED to write this case (a flow lint held on the last
   * attempt). There is no flow to run; the lane records it `blocked` with the
   * reason and the attempt count, so the ledger and the report carry it and a
   * resume can decide whether to author it again. See `suite-progress.ts`.
   */
  refused?: { reason: string; attempt: number } | undefined;
  /**
   * Cases this one continues from (CG-12), as the ids their names start
   * with. The lane waits for each to finish and runs only if every one
   * passed; a source that failed, was blocked, or is not in this run blocks
   * this case with the reason — never a run against a record the source
   * never created.
   */
  dependsOn?: readonly string[] | undefined;
  /**
   * The sheet's own verdict for the row (CG-01), the truth table's ground
   * truth — `blocked` included, which the provenance's typed field cannot
   * carry. Recorded on the ledger so a resume still grades the case.
   */
  knownResult?: KnownResult | undefined;
  /**
   * Every Expected line of the row is record-only (CG-09): the flow captures
   * and asserts nothing, on purpose. It is RUN (the vacuous gate lets it
   * through), and a clean run ends `review` with its captures — the sheet has
   * no oracle, so there is nothing to pass.
   */
  recordOnly?: boolean | undefined;
  /** Credentials by persona label for this case's `signIn` steps (CG-05). In memory only. */
  personas?: Readonly<Record<string, { email: string; password: string }>> | undefined;
}

/**
 * The run options a fail-fast case gets: the same run, every retry path off.
 * A dead-end that costs one run is a fact; one that costs four runs and six
 * model calls is the same fact, paid for four times. Exported so the rule is
 * one function and tested as one.
 */
export function failFastRunOptions(base: RunFlowOptions, flow?: Flow): RunFlowOptions {
  void flow;
  // Refined 2026-08-28 (asked for in so many words): a risk-flagged case
  // keeps the AGENT — once per step — and loses every RERUN. The agent stays
  // because a workflow leg has exactly one executor and the assist rung is a
  // single consult at the step that actually failed; "once per step" holds by
  // construction, since reconstruction (`stepRepair: null`) and the repair
  // loop are off, so a step fails at most once, walks the ladder at most
  // once, and the dead-end memo stops any identical retry from re-asking.
  // What fail-fast still removes: the healer (a model retry of the selector)
  // and every path that RE-RUNS a failed step or the whole case.
  //
  // The agent's ONE shot also gets a shorter leash (2026-09-02): the risk
  // judge already spent a call concluding this case will likely dead-end or
  // fail, and `AGENT_NO_PROGRESS_TURNS`/`AGENT_LOOK_ONLY_TURNS` do not catch
  // a leg that keeps landing genuinely-successful clicks on the WRONG
  // controls (live, HIR-EC-010: 101 turns hunting a value that does not
  // exist on the page). `Math.min` so an explicit tighter cap the caller
  // already set is never loosened.
  return {
    ...base,
    healer: null,
    makeHealer: undefined,
    stepRepair: null,
    agentMaxSteps:
      base.agentMaxSteps !== undefined
        ? Math.min(base.agentMaxSteps, AGENT_FAIL_FAST_MAX_STEPS)
        : AGENT_FAIL_FAST_MAX_STEPS,
  };
}

/**
 * Run every listed case, and report on every one of them.
 *
 * **A case that throws is logged and the list continues.** `runFlow` returning a
 * failed bundle was always survivable — that is an answer. An *exception* is
 * not: a dropped CDP connection, a browser killed mid-run, a report that could
 * not be written. Those used to escape the loop, so cases after the first
 * infrastructure hiccup were never run, never listed, and the roll-up that would
 * have said so never printed either. Ten cases went in, six lines came out, and
 * nothing in the output was false — it was just missing, which is worse, because
 * the four that vanished look exactly like cases nobody wrote.
 *
 * **Blocked is not failed.** A case that never produced a verdict proved nothing
 * about the application, in either direction. Calling it a failure would file
 * the harness's own gap as a defect in the product — the same distinction
 * `proofs-to-artifacts.py` already makes for a step that never ran.
 */
export async function runCases(
  cases: readonly SuiteCase[] | CaseQueue<SuiteCase>,
  options: CliOptions,
  where: {
    dir: string;
    group: string | undefined;
    indexTitle: string;
    /**
     * Route patterns the selected repository declares. What lets a 404 be
     * read correctly at run time: a path the codebase declares no route for
     * was asked for by the TEST, while one it declares and does not serve is
     * the application failing. Absent means no repository was indexed and the
     * run keeps no opinion. Loaded by the caller, which already holds the
     * graph open for authoring.
     */
    declaredRoutes?: readonly string[] | undefined;
    /**
     * Schedule facts from the indexed repository, when the caller holds a
     * graph: FK pairs (a section is a JOIN FAMILY, not a table) and the
     * declared tables (the governor's db-tool allowlist). Absent = table
     * sections stay unexpanded and the governor's db tools refuse.
     */
    graphFacts?: { fkPairs: readonly (readonly [string, string])[]; tables: readonly string[] } | undefined;
    /**
     * Where to keep the suite's progress ledger (see `suite-progress.ts`),
     * with the case ids the suite set out to prove. Omit and no ledger is
     * kept — `generate --run` has no claims file to resume from.
     */
    ledger?:
      | {
          path: string;
          planned: readonly string[];
          resume: boolean;
          /** The pass stamp, once known — read at every write, since it may be decided after the ledger opens. */
          stamp?: (() => string | null) | undefined;
          /**
           * The catalog run's unique key (`<catalog>@<stamp>`) — same late
           * read as `stamp`, since a resume settles it from the prior ledger.
           */
          runKey?: (() => string | null) | undefined;
          /** What started this run, recorded so a resume can be rebuilt later. */
          launch?: SuiteLedger['launch'];
        }
      | undefined;
    /**
     * Called after every case reaches an outcome — verdict, blocked, or
     * vacuous alike. The seam the scenario gate advances on; must not throw.
     */
    onCaseDone?: ((testCase: SuiteCase, outcome: CaseOutcome) => void) | undefined;
    /**
     * BM25-retrieved advisory context per heal (`healHintsFrom`) — the
     * catalog path passes the graph and documents it already holds.
     */
    healHints?: HealHintsProvider | undefined;
    /**
     * The plan's rows in the sheet's own words, for a run whose cases are
     * still being authored. The database baseline detects its tables from
     * these so the snapshot can be taken BEFORE the first case runs without
     * waiting for authoring to finish — see the baseline block below.
     */
    planRows?: readonly { name: string; text: string }[] | undefined;
  },
): Promise<CaseOutcome[]> {
  const log = lineLogger(options);
  // The ledger: reset on a fresh run, carried forward on a resume, written
  // after every case so a stop at any point leaves the high-water mark on
  // disk. A signal (the panel's Stop, Ctrl-C) records its cause on the way
  // out — synchronously, because nothing may be awaited once it has fired.
  let ledger: SuiteLedger | null = null;
  let onSignal: ((signal: NodeJS.Signals) => void) | null = null;
  // On a resume, the prior outcomes as they stood BEFORE this pass touched
  // them: the finished cases a resume inherits into its own roll-up and index
  // rather than re-running. Snapshotted here because `ledger` IS the prior
  // object and every fresh case overwrites its own entry.
  let inherited: Record<string, LedgerOutcome> | null = null;
  if (where.ledger !== undefined) {
    const prior = where.ledger.resume ? await readLedger(where.ledger.path) : null;
    if (prior !== null) {
      inherited = Object.fromEntries(Object.entries(prior.outcomes).map(([id, o]) => [id, { ...o }]));
    }
    ledger = prior ?? newLedger(where.indexTitle, where.ledger.planned);
    ledger.planned = [...where.ledger.planned];
    ledger.runKey = where.ledger.runKey?.() ?? ledger.runKey;
    ledger.launch = where.ledger.launch ?? ledger.launch;
    ledger.ended = null;
    await writeLedger(where.ledger.path, ledger);
    onSignal = (signal) => {
      if (ledger && where.ledger) {
        ledger.ended = {
          at: new Date().toISOString(),
          cause: `stopped by ${signal} with ${remaining(ledger).length} case(s) still to run`,
          complete: false,
        };
        try {
          writeLedgerSync(where.ledger.path, ledger);
        } catch {
          /* the ledger is advisory */
        }
      }
      process.exit(signal === 'SIGINT' ? 130 : 143);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }
  // **The catalog report is live** (2026-09-02): written now, with every
  // planned case a `never ran` row (or the verdict an earlier pass under the
  // same run key recorded), and rewritten after each case — so the panel's
  // Report button opens the current state of the catalog at any point of the
  // run, and a rerun updates the same file rather than minting another.
  // Beside it, the per-case workbook of each case that passed. Never fatal.
  const liveReport =
    ledger === null || where.ledger === undefined
      ? null
      : new CatalogLiveReport({
          ledger: () => ledger!,
          scenarioOf: (id) => {
            const item = queue.items.find((c) => caseIdOf(c.name) === id);
            return item === undefined ? undefined : (item.scenarioId ?? item.group);
          },
          history: options.history ? new RunHistory(options.historyPath) : null,
          onError: (message) => process.stderr.write(`  ! catalog report could not be written: ${message}\n`),
        });
  const noteOutcome = async (
    outcome: CaseOutcome,
    extra: {
      flowPath?: string | undefined;
      vacuous?: boolean | undefined;
      proofPath?: string | undefined;
      authoringRefused?: number | undefined;
      dependsOn?: readonly string[] | undefined;
      knownResult?: KnownResult | undefined;
    } = {},
  ): Promise<void> => {
    if (ledger === null || where.ledger === undefined) return;
    ledger.generatedAt = where.ledger.stamp?.() ?? ledger.generatedAt;
    ledger.runKey = where.ledger.runKey?.() ?? ledger.runKey;
    recordOutcome(ledger, outcome, extra);
    await writeLedger(where.ledger.path, ledger).catch(() => undefined);
    liveReport?.record(outcome.name, outcome.bundle);
    void liveReport?.refresh();
  };
  const entries: IndexEntry[] = [];
  /** The per-row facts every ledger record carries (CG-01 / CG-12). */
  const caseFacts = (testCase: SuiteCase): { dependsOn?: readonly string[] | undefined; knownResult?: KnownResult | undefined } => ({
    ...(testCase.dependsOn === undefined ? {} : { dependsOn: testCase.dependsOn }),
    ...(testCase.knownResult === undefined ? {} : { knownResult: testCase.knownResult }),
  });

  // **The list may still be growing.** A catalog pushes each case into a
  // `CaseQueue` the moment it is authored, so running starts while the model
  // is still writing the next row (see `cmdCatalog`). Everything below reads
  // the queue, never a count: the roster is printed per arrival, the schedule
  // is decided per arrival, and the roll-up waits for the queue to close.
  const streaming = cases instanceof CaseQueue;
  // Readers run before writers unless the caller pinned the list's own order.
  // A streaming suite cannot be reordered — rows run as they are authored.
  // A dependent after its source whatever the reorder did (CG-12):
  // `readersFirst` would put a reader that continues from a writer AHEAD of
  // it, and the loop below only ever waits on a source queued earlier.
  const queue = streaming
    ? cases
    : closedQueue(
        orderDependentsAfterSources(
          options.sheetOrder ? cases : readersFirst(cases),
          (c) => caseIdOf(c.name),
          (c) => c.dependsOn ?? [],
        ),
      );
  // The report exists before the first case has a verdict.
  if (liveReport !== null) await liveReport.refresh();

  // **The database baseline** (2026-09-02, asked for). Before the first case
  // runs: work out which tables the authored flows are about, snapshot exactly
  // those, and hand every case a probe that records — on each backend step —
  // what the run has done to them against that snapshot. After the run
  // (below), put the tables back when the mode says to. A resume never
  // re-snapshots: the state before the ORIGINAL run is the baseline, whatever
  // the cases since have written, so the ledger's baseline is authoritative.
  const baselineResolved = resolveBaselineMode(options.dbBaseline);
  if (baselineResolved.note !== null) log?.(`db baseline: ${baselineResolved.note}`);
  let baselineProbeForRun: DbBaselineProbe | null = null;
  let baselineClient: DbClient | null = null;
  let activeBaseline: Baseline | null = null;
  const priorBaseline = ledger?.dbBaseline;
  if (baselineResolved.mode !== 'off') {
    try {
      const config = defaultDbConfig();
      if (config === null) {
        log?.('db baseline: WOWLIDATOR_DB_URL is not set — skipping');
      } else if (priorBaseline !== undefined) {
        // A resume: reuse the snapshot the original run took.
        activeBaseline = await readBaseline(priorBaseline.path);
        baselineClient = await connectDb(config);
        baselineProbeForRun = baselineProbe(baselineClient, activeBaseline, baselineMaxRows());
        log?.(
          `db baseline  reusing ${activeBaseline.tables.length} table(s) snapshotted ${priorBaseline.takenAt} (resume)`,
        );
      } else {
        // **Detected from the PLAN, not from the finished flows** (2026-09-02).
        // The first version waited here for authoring to close the queue,
        // because a flow's DB steps are the surest source of table names.
        // That silently disabled pipelining: a ten-row catalog authored for
        // ten minutes with a case sitting ready in the queue and the engine
        // parked in a 200ms poll — the parallelism policy is the point of the
        // streaming path, and a baseline must not cost it. The sheet's own
        // words name the same tables through source (b), the operator can
        // always add more, and one FK hop covers the joins; so detection runs
        // NOW, on the plan rows plus whatever has authored already, and the
        // snapshot is taken before the first case is dispatched.
        baselineClient = await connectDb(config);
        const schema = await baselineClient.introspect();
        const authoredSoFar = queue.items.map((c) => ({ name: c.name, flow: c.flow }));
        const planned = (where.planRows ?? []).filter(
          (row) => !authoredSoFar.some((c) => caseIdOf(c.name) === caseIdOf(row.name)),
        );
        const detected = detectBaselineTables(
          [...authoredSoFar, ...planned],
          schema,
          { fkPairs: where.graphFacts?.fkPairs, extra: options.dbBaselineTables },
        );
        if (detected.length === 0) {
          log?.('db baseline  no tables under test detected — nothing to snapshot');
          await baselineClient.close().catch(() => undefined);
          baselineClient = null;
        } else {
          log?.(
            `db baseline  ${detected.length} table(s) from ${authoredSoFar.length} authored + ` +
              `${planned.length} planned row(s): ` +
              detected.map((d) => `${d.table} (${d.why[0] ?? 'detected'})`).join(', '),
          );
          activeBaseline = await takeBaseline(baselineClient, detected, schema, {
            runKey: ledger?.runKey ?? null,
          });
          const path = await writeBaseline(baselinePath(ledger?.runKey ?? null), activeBaseline);
          baselineProbeForRun = baselineProbe(baselineClient, activeBaseline, baselineMaxRows());
          const notRestorable = activeBaseline.tables.filter((t) => !t.restorable);
          log?.(
            `db baseline  snapshot ${path} — ` +
              activeBaseline.tables.map((t) => `${t.table} ${t.rowCount} row(s)`).join(', ') +
              (notRestorable.length > 0 ? ` · ${notRestorable.length} not restorable (${notRestorable.map((t) => t.table).join(', ')})` : ''),
          );
          if (ledger !== null && where.ledger !== undefined) {
            ledger.dbBaseline = {
              path,
              tables: activeBaseline.tables.map((t) => t.table),
              takenAt: activeBaseline.takenAt,
              mode: baselineResolved.mode,
            };
            await writeLedger(where.ledger.path, ledger).catch(() => undefined);
          }
        }
      }
    } catch (error) {
      // Never fatal: a baseline that could not be taken is a run without one.
      log?.(`db baseline: could not prepare — ${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}`);
      await baselineClient?.close().catch(() => undefined);
      baselineClient = null;
      baselineProbeForRun = null;
    }
  }

  // Outcomes are collected **by index**, never appended: cases finish in
  // whatever order they finish, and the roll-up, the suite index and the exit
  // code all have to read as the list someone approved rather than as a
  // stopwatch result.
  const collected: (CaseOutcome | undefined)[] = [];
  const indexed: (IndexEntry | undefined)[] = [];

  // Autoheal (`--repair` on a suite): each case runs through the same
  // FlowRepairLoop `wow run --repair` uses — on a failed / error / dead-end
  // outcome the repair model rewrites the flow around the break and the case
  // reruns itself, up to `options.repairAttempts` total runs. Gated on the
  // generator role resolving a key; when it cannot, the suite says so once and
  // runs exactly as before rather than failing ten cases on a missing key.
  let autoheal = options.repair;
  if (autoheal) {
    const gate = assertRolesResolvable(
      options,
      options.repairInvestigate ? ['generator', 'agent'] : ['generator'],
    );
    if (gate !== null) {
      process.stderr.write(`  ! autoheal requested, but ${gate} — running without it\n`);
      autoheal = false;
    }
  }
  // One memory across the whole suite: a fix one case's repair proved is
  // pre-applied to every later case that walks into the same break on the
  // same page, instead of each of them rediscovering it with model calls.
  const repairMemory = autoheal ? new RepairMemory() : null;
  // The post-run judge for a SYSTEM ERROR — a run that delivered no verdict.
  // Built once for the suite; called only on `status === 'error'` bundles.
  const diagnosisModel = buildDiagnosisModel(options);
  // One session across the whole suite: the sign-in a case establishes is
  // banked as storage state and injected into later cases' own isolated
  // contexts (never a shared context), so a flow that does not sign itself
  // in starts already authenticated instead of paying for the login again.
  const sessionVault = new SessionVault();

  // **Pause is instant** (2026-08-24; it used to wait for every in-flight
  // case, which at 3–5 concurrent lanes of minutes each meant a "pause" that
  // arrived a quarter of an hour after the click — a pause that slow is not
  // one). SIGUSR2 (wowUI's Pause button, or `kill -USR2 <pid>` from a
  // terminal) now writes the ledger's pause record synchronously and exits on
  // the spot. Interrupted cases keep NO verdict — an interrupted case proved
  // nothing, and a browser's mid-case state cannot be resurrected anyway —
  // so `remaining()` includes them and `--resume` re-runs each from its own
  // first step, in a fresh process on current code, while every finished
  // verdict is carried into the resumed roll-up. What instant costs is the
  // partial work of the interrupted lanes; that is the price that was asked
  // for. Distinct from Stop (SIGINT/SIGTERM) only in intent and wording now:
  // Stop means "I am done with this run", Pause means "continue it later".
  //
  // Without a ledger there is nothing a resume could pick up, so exiting
  // instantly would only throw finished-in-flight work away: there — and
  // only there — the old graceful behaviour stands (nothing new starts, the
  // in-flight cases finish with verdicts).
  resetPause();
  const pauseFile = where.ledger === undefined ? undefined : pauseFileFor(where.ledger.path);
  // A pause file left over from the paused process (the panel writes file AND
  // signal; the signal usually wins and exits before the file is consumed)
  // must not pause the very resume it asked for.
  if (pauseFile !== undefined) clearPauseFile(pauseFile);
  let pauseFired = false;
  const onPause = (): void => {
    if (pauseFired) return;
    pauseFired = true;
    requestPause();
    if (ledger !== null && where.ledger !== undefined) {
      ledger.ended = {
        at: new Date().toISOString(),
        cause:
          `paused with ${remaining(ledger).length} case(s) still to run — in-flight cases were ` +
          'interrupted and re-run on resume, on current code',
        complete: false,
      };
      try {
        writeLedgerSync(where.ledger.path, ledger);
      } catch {
        /* the ledger is advisory */
      }
      if (pauseFile !== undefined) clearPauseFile(pauseFile);
      process.stderr.write(
        '\n— paused instantly: interrupted cases keep no verdict; Continue testing / --resume ' +
          're-runs each from its first step and keeps every finished verdict —\n',
      );
      // The environment family, like a blocked case: the pause says nothing
      // about the application, and 0 or 1 here would claim it does. The
      // panel labels the job from its pause request, not from this code.
      process.exit(EXIT.environment);
    }
    process.stderr.write(
      '\n— pausing: no progress ledger to resume from, so cases in flight finish ' +
        'and nothing new starts —\n',
    );
  };
  if (process.platform !== 'win32') process.on('SIGUSR2', onPause);
  // The file route reaches runs no signal can: an orphaned suite (the panel
  // restarted after spawning it), or one started in another terminal —
  // `touch <ledger>.pause`. Polled here so the file is as instant as the
  // signal (it used to be noticed only when the next case would have
  // started, which on long cases was the same quarter-hour wait), and still
  // checked before every dispatch via `shouldPause` below as the backstop.
  const pausePoll =
    pauseFile === undefined
      ? null
      : setInterval(() => {
          if (pauseRequested(pauseFile)) onPause();
        }, 500);
  pausePoll?.unref();

  // Pool size. An explicit `--concurrency` is fixed for the whole run, as it
  // always was. A streaming (pipelined) suite with none stated runs 3 beside
  // the authoring pool and widens to 5 the moment the queue closes and the
  // model goes idle — `runQueue` re-reads this before every dispatch.
  const concurrencyOf = (): number =>
    options.concurrency !== undefined
      ? Math.max(1, options.concurrency)
      : streaming
        ? queue.closed
          ? PIPELINED_CONCURRENCY_AFTER_AUTHORING
          : PIPELINED_CONCURRENCY_WHILE_AUTHORING
        : DEFAULT_CONCURRENCY;
  // One tag per case, and only when something else may be running beside it:
  // a sequential run's output stays exactly what it was. A streaming list has
  // no count to consult yet, so it is tagged whenever the pool allows more
  // than one — the tag is what lets a reader (and wowUI) tell them apart.
  const parallel = concurrencyOf() > 1 && (streaming || queue.length > 1);
  const tagOf = (index: number): string | undefined => (parallel ? `[c${index + 1}]` : undefined);

  // The roster, per arrival. For a closed list that is the whole plan up
  // front, as before; for a queue it is one line as each case is queued.
  //
  // Section-aware since 2026-08-28 (docs/parallel-run-spec.md): a writer is
  // globally exclusive only when its sections are unknown, global, or it
  // deletes; two writers of DISJOINT sections share the pool. Off
  // (`WOWLIDATOR_SECTIONS=off`) restores the binary writer lock.
  // **Nothing is flagged any more** (2026-08-31): a case is dispatched the
  // moment a lane is free, and the serialisation happens INSIDE the run, at
  // the steps that actually change data — see `data-locks.ts` for the
  // measurement that prompted it. `WOWLIDATOR_DATA_LOCKS=off` restores the
  // case-level rule below.
  const useLocks = dataLocksEnabled();
  const locks = new SectionLocks();
  const useSections = sectionsEnabled();
  const fkPairs = where.graphFacts?.fkPairs ?? [];
  const metas: CaseScheduleMeta[] = [];
  // Route↔table aliasing: a case carrying both keys proves they are one
  // section, and from then on the pair is compared as one — see
  // `sectionAliaser` for the co-run this prevents.
  const aliases = sectionAliaser();
  const metaOf = (testCase: SuiteCase, index: number): CaseScheduleMeta => {
    if (metas[index] === undefined) {
      const raw = caseScheduleMeta(testCase.flow);
      metas[index] = { ...raw, sections: expandSections(raw.sections, fkPairs) };
      aliases.note(metas[index]!);
    }
    return { ...metas[index]!, sections: aliases.canon(metas[index]!.sections) };
  };
  const exclusive: boolean[] = [];
  const scheduleOf = (testCase: SuiteCase, index: number): boolean => {
    if (exclusive[index] === undefined) {
      exclusive[index] = useLocks
        ? false
        : useSections
          ? isGloballyExclusive(metaOf(testCase, index))
          : caseWrites(testCase.flow);
    }
    return exclusive[index]!;
  };

  // ---- interference registry + governor state ------------------------------
  /** Every case's window and sections, for the interference detector. */
  const windows = new Map<number, { name: string; meta: CaseScheduleMeta; startedMs: number; endedMs: number }>();
  const inFlightMeta = new Map<number, { name: string; meta: CaseScheduleMeta; startedMs: number }>();
  const heldCases = new Set<string>();
  /** Governor pool override; null = the ordinary sizing. Never above ceiling. */
  let poolOverride: number | null = null;
  let governorHold = false;
  // The account's session window: stop dispatching before it is full and
  // resume when it reopens (`quota-hold.ts`). Idempotent — the authoring
  // pool may already have armed it.
  ensureQuotaHold(options.config, (line) => process.stderr.write(`${line}\n`));
  /**
   * Cases whose non-pass was stamped as possible cross-case interference.
   * Each re-runs ALONE — but after the plan, not in the middle of it: the
   * lane records its provisional verdict and moves on, and the re-runs go
   * one at a time once the pool is empty. The old shape held the lane open
   * waiting for every other lane to finish; three lanes stamped at once each
   * waited for the other two and the run froze for good (2026-09-02, ec10NS
   * c6 — no lane can leave the in-flight set while it is waiting inside it).
   */
  const pendingSoloReruns: { name: string; run: () => Promise<void> }[] = [];

  /** Set once the governor is built below; canRunWith fires blocked events through it. */
  let governorRef: QueueGovernor | null = null;
  const blockedPolls = new Map<number, number>();

  const heldBlocks = (name: string): boolean =>
    [...heldCases].some((id) => name === id || name.startsWith(`${id} `) || name.startsWith(id));

  /**
   * Where a case's sources stand (CG-12) — `dependencyStanding` in
   * `case-plan.ts` owns the answer; this only supplies the lookups. The gate
   * lives in the deterministic scheduler, never the governor: a dependent's
   * verdict is correctness, and the governor is an optimiser that may be
   * absent, off, or out of budget without changing any verdict.
   */
  const dependencyStatus = (testCase: SuiteCase, index: number): DependencyStanding =>
    dependencyStanding(caseIdOf(testCase.name), testCase.dependsOn ?? [], index, {
      indexOf: (id) => queue.items.findIndex((c) => caseIdOf(c.name) === id),
      outcomeAt: (at) => collected[at],
      inherited: (id) => inherited?.[id],
      queueOpen: !queue.closed,
      planned: where.ledger?.planned ?? [],
      dependsBack: (id) => dependsBackOn(queue.items, (c) => caseIdOf(c.name), (c) => c.dependsOn ?? [], id, caseIdOf(testCase.name)),
    });
  const dependencyWaitLogged = new Set<number>();

  const canRunWith = (
    testCase: SuiteCase,
    index: number,
    inflight: readonly { item: SuiteCase; index: number }[],
  ): boolean | 'defer' => {
    // A dependent waits for its source's verdict before anything else is
    // asked; the source is queued ahead, so it is in flight or done. The
    // answer is `'defer'`, not `false`: the loop parks the dependent and
    // goes on dispatching the cases behind it (2026-09-04 — `false` held the
    // head of the queue, and a ten-lane pool drained to the one lane running
    // the prerequisite). The wait still counts toward the governor's
    // queue-blocked event, so a long one is explained, not mistaken for a
    // scheduler fault — see `waitingOn` on the observation.
    const dependency = dependencyStatus(testCase, index);
    if (dependency.kind === 'wait') {
      if (!dependencyWaitLogged.has(index)) {
        dependencyWaitLogged.add(index);
        process.stdout.write(`  [c${index + 1}]      waits for ${dependency.on} — ${testCase.name} continues from it\n`);
      }
      const polls = (blockedPolls.get(index) ?? 0) + 1;
      blockedPolls.set(index, polls);
      if (polls === 25 && governorRef !== null) void governorRef.onEvent(observe('queue-blocked'));
      return 'defer';
    }
    const held = heldBlocks(testCase.name);
    // Under data locks the only thing that can refuse a dispatch is an
    // explicit hold: two cases that touch the same section are no longer kept
    // apart here, they queue at the step that changes the data. That also
    // ends the head-of-line blocking this check used to cause — the loop
    // takes cases in order, so one un-dispatchable case stalled every
    // compatible case behind it.
    const compatible =
      !held &&
      (useLocks ||
        !useSections ||
        inflight.every(({ item, index: otherIndex }) =>
          compatibleCases(metaOf(testCase, index), metaOf(item, otherIndex)),
        ));
    if (compatible) {
      blockedPolls.delete(index);
      return true;
    }
    // A dispatch refused ~25 polls (~5s of lanes finishing nothing) is the
    // governor's queue-blocked event — once per case, fire-and-forget, and
    // only when a governor exists at all.
    const polls = (blockedPolls.get(index) ?? 0) + 1;
    blockedPolls.set(index, polls);
    if (polls === 25 && governorRef !== null) void governorRef.onEvent(observe('queue-blocked'));
    return false;
  };

  // ---- the queue governor (docs/parallel-run-spec.md §2.4) -----------------
  // Advisory and event-driven: absent, off, or out of budget, everything
  // above runs exactly as the deterministic scheduler alone. Built only for
  // a parallel suite — a serial run has no queue to govern.
  const poolCeiling = (): number => Math.max(concurrencyOf(), 2);
  // `rules` (the default) is a pure function — no model, no budget pressure,
  // so it may speak on every event; `model` restores the LLM governor with
  // its hard turn budget. See `governorMode`.
  const govMode = governorMode();
  const recentFailures: string[] = [];
  const governor: QueueGovernor | null =
    parallel && govMode !== 'off' && (govMode === 'rules' || options.agent)
      ? new QueueGovernor({
          model: govMode === 'rules' ? new RuleGovernorModel() : new LlmGovernorModel({ factory: options.factory }),
          ...(govMode === 'rules' ? { budget: 10_000 } : {}),
          hooks: {
            hold: (caseId) => {
              if (caseId === '') return false;
              heldCases.add(caseId);
              return true;
            },
            release: (caseId) => heldCases.delete(caseId),
            resizePool: (size) => {
              poolOverride = Math.max(1, Math.min(poolCeiling(), size));
              return poolOverride;
            },
            rerunAlone: () => false, // granted only at case end, through the detector's own path
            dbRead: async (sql) => {
              const gate = validateGovernorRead(sql);
              if (!gate.ok) return `refused: ${gate.reason}`;
              return runGovernorSql(sql, process.env['WOWLIDATOR_DB_URL'], 'read');
            },
            dbWrite: async (sql) => {
              const admin = process.env['WOWLIDATOR_DB_ADMIN_URL'];
              if (admin === undefined || admin.trim() === '') {
                return 'refused: WOWLIDATOR_DB_ADMIN_URL is not set — the governor may not write without an operator-supplied admin credential';
              }
              const gate = validateGovernorWrite(sql, where.graphFacts?.tables ?? []);
              if (!gate.ok) return `refused: ${gate.reason}`;
              return runGovernorSql(sql, admin, 'write');
            },
          },
          log: (line) => process.stderr.write(`  ${line}\n`),
        })
      : null;
  governorRef = governor;

  /** One statement through a short-lived client. Lazy import: a suite with no governor DB use never demands the driver. */
  async function runGovernorSql(sql: string, url: string | undefined, kind: 'read' | 'write'): Promise<string> {
    if (url === undefined || url.trim() === '') return `refused: no ${kind === 'read' ? 'WOWLIDATOR_DB_URL' : 'admin'} connection configured`;
    try {
      const { connectDb } = await import('../db/client.js');
      const client = await connectDb({ url });
      try {
        const result = await client.query(sql, []);
        return `${result.rowCount} row(s) in ${result.durationMs}ms` + (kind === 'read' ? `: ${JSON.stringify(result.rows.slice(0, 3)).slice(0, 300)}` : '');
      } finally {
        await client.close();
      }
    } catch (error) {
      return `failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
    }
  }

  /** The compact observation a governor turn reads — bounded on purpose. */
  const observe = (event: GovernorObservation['event']): GovernorObservation => {
    const now = Date.now();
    const pending: string[] = [];
    /** The prerequisite a pending case is parked on, if any — the observation's, not a guess. */
    const waitingOn = (c: SuiteCase, i: number): string | undefined => {
      if (c.dependsOn === undefined || c.dependsOn.length === 0) return undefined;
      const standing = dependencyStatus(c, i);
      return standing.kind === 'wait' ? standing.on : undefined;
    };
    queue.items.forEach((c, i) => {
      if (collected[i] !== undefined || inFlightMeta.has(i)) return;
      const m = metaOf(c, i);
      const on = waitingOn(c, i);
      pending.push(`${c.name.slice(0, 60)} [${m.writes ? 'writer' : 'reader'}${m.deletes ? ' deletes' : ''} ${m.sections.join(' ') || 'no-sections'}]${heldBlocks(c.name) ? ' HELD' : ''}${on === undefined ? '' : ` waits-for:${on}`}`);
    });
    const lanes = [...inFlightMeta.values()].map(
      (l) => `${l.name.slice(0, 60)} [${l.meta.writes ? 'writer' : 'reader'} ${l.meta.sections.join(' ') || 'no-sections'}] ${Math.round((now - l.startedMs) / 1000)}s`,
    );
    const done = collected.filter((c) => c !== undefined);
    const tally = `passed ${done.filter((c) => c!.verdict === 'passed').length} · failed ${done.filter((c) => c!.verdict === 'failed').length} · blocked ${done.filter((c) => c!.verdict === 'blocked').length} · left ${queue.items.length - done.length}`;
    const interfered = [...windows.values()].filter((w) => w.name.includes('interference')).length;
    const fact = (name: string, meta: CaseScheduleMeta, on?: string): GovernorCaseFact => ({
      name,
      writes: meta.writes,
      sections: meta.sections,
      ...(on === undefined ? {} : { waitingOn: on }),
    });
    const pendingFacts = queue.items
      .map((c, i) => ({ c, i }))
      .filter(({ i }) => collected[i] === undefined && !inFlightMeta.has(i))
      .slice(0, 30)
      .map(({ c, i }) => fact(c.name, metaOf(c, i), waitingOn(c, i)));
    const flyingFacts = [...inFlightMeta.values()].map((l) => fact(l.name, l.meta));
    return {
      event,
      pendingFacts,
      flyingFacts,
      recentFailures: recentFailures.slice(-6),
      queue: pending.slice(0, 20),
      lanes,
      tally,
      health: [
        `pool ${poolOverride ?? concurrencyOf()} (ceiling ${poolCeiling()})`,
        `held cases: ${heldCases.size === 0 ? 'none' : [...heldCases].join(', ')}`,
        `interference stamps so far: ${interfered}`,
      ],
      pool: { current: poolOverride ?? concurrencyOf(), max: poolCeiling() },
    };
  };
  if (parallel && !streaming) {
    const alone = queue.items.filter((c, i) => scheduleOf(c, i)).length;
    const locked = useLocks ? queue.items.filter((c) => dataWindows(c.flow, fkPairs).length > 0).length : 0;
    const reordered = !options.sheetOrder && alone > 0 && alone < queue.length;
    process.stdout.write(
      `\n  cases      ${queue.length}, up to ${concurrencyOf()} at a time` +
        (alone > 0 ? ` (${alone} change data and run alone)` : '') +
        (locked > 0 ? ` (${locked} change data — each locks its own section only while changing and checking it)` : '') +
        (reordered ? `\n             readers run first, before anything changes the data they assert on (--sheet-order keeps the list's own order)` : '') +
        `\n`,
    );
    for (const [index, testCase] of queue.items.entries()) {
      process.stdout.write(
        `  [c${index + 1}]      ${scheduleOf(testCase, index) ? 'alone  ' : useLocks && dataWindows(testCase.flow, fkPairs).length > 0 ? 'locks  ' : 'shared '} ${testCase.name}\n`,
      );
    }
    process.stdout.write('\n');
  } else if (parallel) {
    process.stdout.write(
      options.concurrency !== undefined
        ? `\n  cases      run as they are authored, up to ${concurrencyOf()} at a time (a case that changes data runs alone)\n`
        : `\n  cases      run as they are authored — up to ${PIPELINED_CONCURRENCY_WHILE_AUTHORING} at a time while authoring, ` +
          `${PIPELINED_CONCURRENCY_AFTER_AUTHORING} once it finishes (a case that changes data runs alone)\n`,
    );
  }

  // The warm claude pool must fit the lanes, or the (concurrency+1)th ask
  // falls to a cold one-shot — the exact bill parallelism exists to avoid.
  if (parallel) raiseSessionCapFor(concurrencyOf());
  // The browsers the lanes spread over (`--browsers`): each case leases the
  // least-loaded one for its length. One browser — the CDP port — unless
  // `prepare` was asked for a pool, so a single-browser run is unchanged.
  const browsers = new BrowserLease(laneBrowsers().length > 0 ? laneBrowsers() : [options.cdp ?? DEFAULT_CDP_URL]);
  if (parallel && browsers.size > 1) {
    process.stdout.write(`  browsers   ${browsers.size}, each case on the least-busy one\n`);
  }
  if (governor !== null && !streaming && queue.length > 1) void governor.onEvent(observe('suite-start'));
  await runQueue(
    queue,
    () => Math.min(poolOverride ?? concurrencyOf(), Math.max(concurrencyOf(), poolOverride ?? 1)),
    (testCase, index) => scheduleOf(testCase, index),
    // The lane's tag on the async context: every line written on this
    // case's behalf without an explicit tag — the repair loop's, the llm
    // log's on stderr — lands under `[cN]` with the rest of the case.
    (testCase, index) => withLogTag(tagOf(index), async () => {
    // A streaming list has no roster to print up front, so each case's
    // line of it is printed as the case starts.
    if (streaming && parallel) {
      process.stdout.write(
        `  [c${index + 1}]      ${scheduleOf(testCase, index) ? 'alone  ' : 'shared '} ${testCase.name}\n`,
      );
    }
    const tag = tagOf(index);
    // **A case authoring refused to write has no flow to run.** It is recorded
    // blocked with the lint's reason — on the ledger, so the report's row
    // says why instead of "never ran", and so the next resume knows how many
    // times this row has been refused (see `AUTHORING_REFUSAL_CAP`).
    if (testCase.refused !== undefined) {
      const reason = `authoring refused (attempt ${testCase.refused.attempt}): ${testCase.refused.reason}`;
      emitTagged(tag, `\nBLOCKED ${testCase.name} — ${reason}\n`, 'err');
      if (parallel) emitTagged(tag, `case "${testCase.name}" blocked\n`);
      collected[index] = { name: testCase.name, verdict: 'blocked', bundle: null, reason };
      await noteOutcome(collected[index]!, { authoringRefused: testCase.refused.attempt, ...caseFacts(testCase) });
      where.onCaseDone?.(testCase, collected[index]!);
      return;
    }
    // **A case whose source did not pass is not run** (CG-12): the record it
    // continues from was never created, and a failure against a missing
    // record would file the source's defect twice. Blocked with the reason,
    // and `--resume` re-runs it once the source passes.
    const dependency = dependencyStatus(testCase, index);
    if (dependency.kind !== 'ready') {
      const reason = dependency.kind === 'blocked' ? dependency.reason : `depends on ${dependency.on}, which had not finished`;
      emitTagged(tag, `\nBLOCKED ${testCase.name} — ${reason}\n`, 'err');
      if (parallel) emitTagged(tag, `case "${testCase.name}" blocked\n`);
      collected[index] = { name: testCase.name, verdict: 'blocked', bundle: null, reason };
      await noteOutcome(collected[index]!, { flowPath: testCase.flowPath, ...caseFacts(testCase) });
      where.onCaseDone?.(testCase, collected[index]!);
      return;
    }
    // **A flow that proves nothing about its claim is not run.** Its only
    // assertions are the sign-in proof and a URL, so the browser would spend
    // a minute producing a green that says nothing; it is recorded as
    // blocked — with the reason — and the next `--resume` re-authors it.
    // The one exception is a record-only case (CG-09): asserting nothing IS
    // its shape — it runs to capture, and ends for review below.
    const vacuous = testCase.recordOnly === true ? null : vacuousFlow(testCase.flow);
    if (vacuous !== null) {
      const reason = `vacuous flow — ${vacuous}; re-authored on --resume`;
      emitTagged(tag, `\nBLOCKED ${testCase.name} — ${reason}\n`, 'err');
      if (parallel) emitTagged(tag, `case "${testCase.name}" blocked\n`);
      collected[index] = { name: testCase.name, verdict: 'blocked', bundle: null, reason };
      await noteOutcome(collected[index]!, { flowPath: testCase.flowPath, vacuous: true, ...caseFacts(testCase) });
      where.onCaseDone?.(testCase, collected[index]!);
      return;
    }
    // **"Only" means only.** A flow on disk whose case says the page shows
    // ONLY / เฉพาะ / เท่านั้น a listed set, and which never counts that set,
    // passes over a list of any length (ec10_3x HIR-EC-029, 2026-09-02). It
    // is the vacuous shape for one claim: blocked with the reason, re-authored
    // on `--resume` under the author's exclusivity lint — never run green.
    const exclusive = unprovedExclusivity(testCase.flow.steps, testCase.flow.caseContext ?? testCase.name);
    if (exclusive !== null) {
      const reason = `exclusivity unproved — ${describeUnprovedExclusivity(exclusive)}; re-authored on --resume`;
      emitTagged(tag, `\nBLOCKED ${testCase.name} — ${reason}\n`, 'err');
      if (parallel) emitTagged(tag, `case "${testCase.name}" blocked\n`);
      collected[index] = { name: testCase.name, verdict: 'blocked', bundle: null, reason };
      await noteOutcome(collected[index]!, { flowPath: testCase.flowPath, vacuous: true, ...caseFacts(testCase) });
      where.onCaseDone?.(testCase, collected[index]!);
      return;
    }
    // Where this case's RUN begins (its authoring, when pipelined, ended at
    // `queued …` some lines — or many cases — earlier): one rule a reader
    // can search for, then the line the panel reads the boundary from.
    if (!options.json) emitTagged(tag, `\n${phaseHeader(`run ${caseIdOf(testCase.name)}`)}\n`);
    if (parallel) emitTagged(tag, `case "${testCase.name}" started\n`);
    else log?.(`running "${testCase.name}"…`);
    // The case's own clock, started at pickup: the bundle's `durationMs` is
    // one flow attempt, and under --repair the last attempt is the SHORTEST
    // part of what a person actually waited through.
    const caseStartedMs = Date.now();
    const caseStartedAt = new Date().toISOString();
    inFlightMeta.set(index, { name: testCase.name, meta: metaOf(testCase, index), startedMs: caseStartedMs });
    // Judged above the risk threshold after authoring: run once, and let the
    // dead-end be a dead-end — no heal, no agent, no reconstruction, no
    // repair loop. The verdict is recorded like any other; only the retries
    // are withheld, and the proof says so (`bundle.risk`, a note).
    const failFast = testCase.risk?.verdict === 'fail-fast';
    if (testCase.risk) emitTagged(tag, `  risk       ${describeRisk(testCase.risk)}\n`);
    // The case's own share of the suite's lock table: the spans of THIS flow
    // that change data, and nothing else. A reader gets null and never
    // touches the table. Built per case, because the windows are step
    // identities in this flow's own objects.
    const caseGate =
      useLocks && parallel
        ? (flow: Flow): ReturnType<typeof dataGateFor> =>
            dataGateFor(flow, locks, { fkPairs, onLog: (line) => emitTagged(tag, `  ${line}\n`) })
        : null;
    // One Chrome per persona: the people this case signs in as, the first on
    // the lane's browser and each later one on its own. The pool grows on
    // demand when `--browsers` did not size it (a catalog run cannot know
    // the count before authoring); a pool that still falls short is shared
    // and disclosed — contexts isolate the cookie jars on their own.
    const personaCount = personasIn(testCase.flow).length;
    if (personaCount > browsers.size) {
      for (const url of await growPool(options, personaCount)) browsers.add(url);
    }
    const leased = browsers.acquireMany(Math.max(1, personaCount));
    const laneCdp = leased.cdpUrls[0]!;
    const personaBrowsers = leased.cdpUrls.slice(1);
    if (personaCount > 1 && !leased.distinct) {
      emitTagged(
        tag,
        `  ${personaCount} personas over ${browsers.size} browser${browsers.size === 1 ? '' : 's'} — some share a Chrome (separate contexts, separate cookies)\n`,
      );
    }
    try {
      const ordinaryRunOptions: RunFlowOptions = {
        cdpUrl: laneCdp,
        personaBrowsers,
        // Concurrent cases must not share a browser context, whatever the
        // video mode says — see `SmartRunnerOptions.isolate`.
        isolate: parallel,
        cachePath: options.cache,
        sessionVault,
        screenshots: options.screenshots,
        highlightTarget: options.highlightTarget,
        video: options.video,
        humanize: options.humanize,
        // The agent as ERROR BACKSTOP, not journey driver (2026-08-28, asked
        // for with code-grounded authoring): flows are now written to run
        // deterministically — tree- or code-grounded steps instead of agent
        // legs — so in a suite that built an agent at all, the assist rung is
        // armed and the agent is consulted only at the step that actually
        // failed. `--no-agent` still turns both off; fail-fast still strips it.
        agentAssist: options.agentAssist || options.agent,
      backend: options.backend,
      declaredRoutes: where.declaredRoutes,
        captureDelayMs: options.captureDelayMs,
      stepDelayMs: options.stepDelayMs,
        makeHealer: buildHealer(options, where.healHints),
      stepRepair: buildStepRepair(options),
      dataGate: caseGate,
      reviewJudge: buildReviewJudge(options),
        healer: options.heal ? undefined : null,
        agent: buildAgent(options, tag),
        dataModel: buildDataModel(options),
        updateBaselines: options.updateBaselines,
        network: options.network,
        // Carried for masking only: a password the person supplied must not
        // reach the proof bundle or the emailable report in cleartext.
        credentials: options.credentials,
        // Every persona the run may sign in as (CG-05): the flags, the `--as`
        // default, and the labels this row resolved — in memory only.
        personas: runPersonas(options, testCase.personas),
        // Where an `upload` step's fixture path is resolved from: the flow's
        // own folder, the same rule `run` uses for a hand-written flow.
        ...(testCase.flowPath === undefined ? {} : { flowDir: dirname(resolve(testCase.flowPath)) }),
        historyPath: options.history ? options.historyPath : null,
        onStep: stepLogger(options, tag),
        onPlan: planLogger(options, tag),
        defects: testCase.defects,
        generatedBy: testCase.generatedBy,
        ...(baselineProbeForRun === null ? {} : { dbBaselineProbe: baselineProbeForRun }),
      };
      const caseRunOptions = failFast
        ? failFastRunOptions(ordinaryRunOptions, testCase.flow)
        : ordinaryRunOptions;

      /**
       * Everything that happens to a finished bundle: diagnosis, proof file,
       * report, verdict classification, the flow-file script fold, the ledger.
       * One function because a solo re-run (interference) needs to do all of
       * it again for its replacement verdict.
       */
      const settle = async (bundle: ProofBundle, { notify }: { notify: boolean }): Promise<void> => {
        // The governor hears about a case that still did not pass — it may
        // hold a sibling, shrink the pool, or seed the fixture the section is
        // starved on. Fire-and-forget: a verdict never waits on advice.
        if (!isPassing(bundle.status)) {
          recentFailures.push(bundle.error ?? bundle.status);
          if (recentFailures.length > 20) recentFailures.shift();
        }
        if (governor !== null && !isPassing(bundle.status)) void governor.onEvent(observe('case-ended'));
        // A SYSTEM ERROR gets one healer-role call saying which layer broke —
        // the test catalog, the generator, the agent, the environment or the
        // application — and the fix when one exists. Written into the bundle
        // BEFORE it is persisted, so the proof, the report and the panel all
        // carry it. A test-failure is a verdict and is never diagnosed.
        if (bundle.status === 'error' && diagnosisModel) {
          const diagnosis = await diagnoseError(
            {
              caseName: testCase.name,
              caseText: testCase.flow.caseContext ?? testCase.name,
              bundle,
              declaredRoutes: where.declaredRoutes ?? [],
              hints: where.healHints,
            },
            { model: diagnosisModel, log: (line) => emitTagged(tag, `${line}
  `, 'err') },
          );
          if (diagnosis) {
            bundle.diagnosis = diagnosis;
            bundle.notes = [...(bundle.notes ?? []), describeDiagnosis(diagnosis)];
            emitTagged(tag, `  diagnosis  ${describeDiagnosis(diagnosis)}
  `);
          }
        }
        const proofPath = await writeProofBundle(bundle, options.out);
        const target = resolveReportPath(
          { path: options.report, dir: options.reportDir, enabled: options.reportEnabled },
          {
            runId: bundle.runId,
            name: bundle.name,
            status: bundle.status,
            // index/kind are what stop one case's report overwriting the next.
            ...(cases.length === 1 ? {} : { index: index + 1 }),
            group: testCase.group ?? where.group,
            kind: testCase.kind,
          },
        );
        const reportPath = target === null ? null : await writeHtmlReport(bundle, target);

        emitTagged(
          tag,
          `\n${formatProofSummary(bundle)}\n` +
            // The summary's own duration is the LAST attempt; this is the span
            // a stopwatch agrees with — pickup to verdict, repairs included.
            (bundle.caseDurationMs === undefined ? '' : `  elapsed    ${formatElapsed(bundle.caseDurationMs)} from pickup to verdict\n`) +
            (meaningfulCoverage(bundle) ? `  ${formatCoverage(bundle.coverage!)}\n` : '') +
            (bundle.trend ? `  ${formatTrend(bundle.trend)}\n` : '') +
            `  proof      ${proofPath}\n` +
            (reportPath === null ? '' : `  report     ${reportPath}\n`),
        );
        // Two ways a run delivers no verdict: it never got going at all
        // (`neverRan`), or it broke off on the machinery alone — every broken
        // step an `error`, nothing about the application contradicted
        // (`harnessOnly`; a database that was never configured, an agent that
        // gave up, a provider that refused the call). Both score `blocked`,
        // never `failed`: filing the harness's own gap as a product defect is
        // the false test failure this suite used to produce 136 times over.
        const blocked = neverRan(bundle) ?? harnessOnly(bundle);
        if (blocked !== null) {
          // Said out loud, at the moment it happens, and on stderr: this is not a
          // verdict, and a reader scanning stdout for verdicts must not take it
          // for one. It keeps its report — the evidence of what went wrong is
          // still worth having — but it is not filed among the results.
          emitTagged(tag, `  ! no verdict: ${blocked}\n`, 'err');
        }
        if (reportPath !== null && blocked === null) indexed[index] = { bundle, reportPath };
        const verdict: CaseOutcome['verdict'] =
          blocked !== null
            ? 'blocked'
            // The status a consumer acts on: an auto-review ruling (the
            // judge at 70%+) or a human ruling outranks the machine's
            // deferral, so a ruled run scores passed/failed, not 'review'.
            : effectiveStatus(bundle) === 'needs-review'
              ? 'review'
              : isPassing(effectiveStatus(bundle))
                ? 'passed'
                : 'failed';
        // **A record-only case that ran clean is not a pass** (CG-09): its
        // Expected lines say "record what the system shows" — the sheet has
        // no oracle, so there is nothing the run could have proved. It ends
        // `review` with its captures named, for a person to read.
        const observed =
          testCase.recordOnly === true && verdict === 'passed'
            ? `observed only — the sheet has no oracle; captured: ${
                bundle.variables && Object.keys(bundle.variables).length > 0
                  ? Object.entries(bundle.variables).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(', ')
                  : 'see the screenshots'
              }`
            : null;
        collected[index] = {
          name: testCase.name,
          verdict: observed === null ? verdict : 'review',
          bundle,
          reportPath: reportPath ?? undefined,
          reason: observed ?? blocked ?? failureOf(bundle),
        };
        if (parallel) {
          emitTagged(tag, `case "${testCase.name}" ${blocked !== null ? 'blocked' : familyLabel(bundle.status)}\n`);
        }
        // Fold successful agent journeys back into the flow file as
        // deterministic scripts, so the next run of this same file replays
        // them with no model turn — the flow-file half of `AgentMemory`.
        // Best-effort on purpose: a script that could not be written costs a
        // few model turns next run, never a verdict.
        if (testCase.flowPath !== undefined && blocked === null) {
          const journeys = bundle.steps
            .map((step) => step.agent)
            .filter((record): record is AgentRecord => record !== undefined && record.success);
          const scripted = withWorkflowScripts(testCase.flow, journeys);
          if (scripted !== null) {
            await writeFlowFile(testCase.flowPath, scripted)
              .then(() => emitTagged(tag, `  scripted   agent journey recorded in the flow for $0 replay\n`))
              .catch(() => undefined);
          }
        }
        await noteOutcome(collected[index]!, { flowPath: testCase.flowPath, proofPath, ...caseFacts(testCase) });
        // The scenario gate counts each case once; a solo re-run replaces a
        // verdict it has already counted.
        if (notify) where.onCaseDone?.(testCase, collected[index]!);
      };

      let bundle;
      if (autoheal && !failFast) {
        // The loop runs the first attempt itself, so the case is not run twice
        // — a clean first pass is one run, exactly as without autoheal.
        const loop = new FlowRepairLoop({
          model: new LlmFlowRepairModel({ factory: options.factory }),
          maxAttempts: options.repairAttempts,
          // Repaired attempts land beside the case's own artifacts, one
          // reviewable file per attempt — never overwriting anything.
          outDir: testCase.group === undefined ? where.dir : join(where.dir, slugify(testCase.group)),
          onLog: (line) => emitTagged(tag, `${line}\n`),
          agent: options.repairInvestigate ? buildInvestigationAgent(options) : null,
          regenerateFrom: options.repairRegenerate,
          memory: repairMemory,
          runOptions: caseRunOptions,
        });
        const outcome = await loop.run(testCase.flow, slugify(testCase.name));
        const repaired = outcome.attempts.filter((a) => a.repair);
        for (const a of repaired) {
          emitTagged(tag, `  autoheal   ${a.repair!.flowPath}\n  patch      ${a.repair!.patchPath}\n`);
        }
        bundle = outcome.attempts[outcome.attempts.length - 1]!.bundle;
      } else {
        bundle = await runFlow(testCase.flow, caseRunOptions);
      }

      // Stamp the case span before the bundle is persisted — from pickup to
      // now, whatever number of attempts it took.
      bundle.caseStartedAt = caseStartedAt;
      bundle.caseDurationMs = Date.now() - caseStartedMs;
      if (testCase.risk) {
        bundle.risk = testCase.risk;
        bundle.notes = [...(bundle.notes ?? []), describeRisk(testCase.risk)];
      }
      // **The interference detector** (docs/parallel-run-spec.md, defect #11):
      // a non-pass produced while another lane WROTE an intersecting section
      // is not yet a verdict about the application. The bundle is stamped and
      // recorded as it stands — provisional — and the case is queued to re-run
      // ONCE with nothing else in flight, after the rest of the plan; the
      // re-run's outcome then replaces it, with the first attempt's status on
      // the note. The lane itself never waits: waiting here is what deadlocked
      // three lanes that were stamped together. This is the honesty backstop
      // for every mis-drawn section boundary.
      if (useSections && parallel && !isPassing(bundle.status) && bundle.status !== 'needs-review') {
        const mine = { meta: metaOf(testCase, index), startedMs: caseStartedMs, endedMs: Date.now() };
        const culprits = [...windows.entries(), ...[...inFlightMeta.entries()].map(([i, l]) => [i, { ...l, endedMs: Date.now() }] as const)]
          .filter(([otherIndex, other]) => otherIndex !== index && windowsInterfere(mine, other))
          .map(([, other]) => other.name);
        if (culprits.length > 0) {
          const firstStatus = bundle.status;
          const stamp = `possible cross-case interference: ${[...new Set(culprits)].slice(0, 3).join(', ')} wrote an intersecting data section during this run`;
          emitTagged(tag, `  interference  ${stamp} — verdict provisional; re-runs alone once the rest of the plan is done\n`, 'err');
          bundle.notes = [...(bundle.notes ?? []), `${stamp} — provisional: re-runs alone after the rest of the plan`];
          pendingSoloReruns.push({
            name: testCase.name,
            run: async () => {
              emitTagged(tag, `\nre-running alone "${testCase.name}" — first attempt ${firstStatus}, flagged as possible interference\n`);
              inFlightMeta.set(index, { name: testCase.name, meta: metaOf(testCase, index), startedMs: Date.now() });
              try {
                const rerun = await runFlow(testCase.flow, caseRunOptions);
                rerun.caseStartedAt = caseStartedAt;
                rerun.caseDurationMs = Date.now() - caseStartedMs;
                if (testCase.risk) rerun.risk = testCase.risk;
                rerun.notes = [...(rerun.notes ?? []), `${stamp} — re-ran alone (first attempt: ${firstStatus})`];
                await settle(rerun, { notify: false });
              } catch (error) {
                // The provisional verdict stands, and says why it is provisional.
                const reason = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
                emitTagged(tag, `  ! solo re-run did not complete — the first attempt's verdict stands: ${reason}\n`, 'err');
              } finally {
                const lane = inFlightMeta.get(index);
                if (lane !== undefined) {
                  windows.set(index, { ...lane, endedMs: Date.now() });
                  inFlightMeta.delete(index);
                }
              }
            },
          });
        }
      }
      await settle(bundle, { notify: true });
    } catch (error) {
      // The narrower case: something threw before there was a bundle at all —
      // a report that could not be written, an unexpected engine error.
      const reason = error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error);
      emitTagged(tag, `\nBLOCKED ${testCase.name} — ${reason}\n`, 'err');
      collected[index] = { name: testCase.name, verdict: 'blocked', bundle: null, reason };
      await noteOutcome(collected[index]!, { flowPath: testCase.flowPath, ...caseFacts(testCase) });
      where.onCaseDone?.(testCase, collected[index]!);
    } finally {
      browsers.releaseMany(leased.cdpUrls);
      // The case's window joins the registry either way — the interference
      // detector needs finished writers, and a lane must never stay
      // "in flight" after a throw.
      const lane = inFlightMeta.get(index);
      if (lane !== undefined) {
        windows.set(index, { ...lane, endedMs: Date.now() });
        inFlightMeta.delete(index);
      }
    }
    }),
    () => pauseRequested(pauseFile),
    canRunWith,
    () => governorHold || quotaHolding(),
  ).catch(async (error: unknown) => {
    if (ledger !== null && where.ledger !== undefined) {
      ledger.ended = {
        at: new Date().toISOString(),
        cause: error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error),
        complete: false,
      };
      await writeLedger(where.ledger.path, ledger).catch(() => undefined);
    }
    throw error;
  });
  if (onSignal !== null) {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  if (process.platform !== 'win32') process.off('SIGUSR2', onPause);
  if (pausePoll !== null) clearInterval(pausePoll);
  stopQuotaHold();

  // **Interference re-runs, alone, after the plan.** Nothing is in flight now,
  // so each re-run is the clean proof the stamp asked for — one at a time, in
  // the order the stamps landed. A pause raised meanwhile is honoured: the
  // cases not yet re-run keep their provisional verdicts, note included.
  if (pendingSoloReruns.length > 0) {
    process.stdout.write(
      `\n${pendingSoloReruns.length} case(s) flagged as possible cross-case interference now re-run alone, one at a time\n`,
    );
    for (const pending of pendingSoloReruns) {
      if (pauseRequested(pauseFile)) {
        process.stdout.write(`  paused before re-running "${pending.name}" — its provisional verdict stands, interference note included\n`);
        break;
      }
      await pending.run();
    }
  }

  // **What the plan did not predict.** The snapshot is taken from the sheet's
  // words before authoring finishes, so a flow may end up naming a table the
  // plan never mentioned. That table has no baseline row: its changes are not
  // compared and a restore cannot put it back. Said out loud rather than left
  // for someone to infer from a report with a gap in it.
  if (activeBaseline !== null) {
    const covered = new Set(activeBaseline.tables.map((t) => t.table.toLowerCase()));
    const missed = new Set<string>();
    for (const item of queue.items) {
      for (const named of tablesNamedBySteps(item.flow)) {
        if (!covered.has(named.toLowerCase())) missed.add(named);
      }
    }
    if (missed.size > 0) {
      process.stdout.write(
        `  ! db baseline  ${missed.size} table(s) the authored flows name were not in the snapshot ` +
          `(${[...missed].join(', ')}) — their changes are not compared, and a restore cannot put them back. ` +
          'Name them with --db-baseline-tables to include them next run.\n',
      );
    }
  }

  // **Restore the database to the baseline** — the run is over (solo re-runs
  // included), so nothing is mid-flight to disturb. Only in `restore` mode,
  // only when a snapshot was taken, and only through the separate write
  // connection; every statement is printed before it runs, and the result is
  // verified against the baseline through the read-only client. Never a
  // verdict about the application: a failed restore is an environment fact,
  // and it is surfaced loudly on the ledger and in the report, not as a defect.
  if (activeBaseline !== null && baselineResolved.mode === 'restore' && !pauseRequested(pauseFile)) {
    const restoreConfig = restoreDbConfig();
    if (restoreConfig === null) {
      log?.('db restore: WOWLIDATOR_DB_RESTORE_URL is not set — the tables were left as the run left them');
    } else if (baselineClient === null) {
      log?.('db restore: the read-only client is gone — cannot verify a restore, so none was attempted');
    } else {
      let writable: DbClient | null = null;
      try {
        writable = await connectDbWritable(restoreConfig);
        log?.(`db restore  ${maskDsn(restoreConfig.url ?? '')} — restoring ${activeBaseline.tables.filter((t) => t.restorable).length} table(s)`);
        const result = await restoreBaseline(writable, baselineClient, activeBaseline, {
          onStatement: (sql) => emitTagged('db', `  restore sql  ${sql}\n`, 'err'),
        });
        log?.(`db restore  ${result.detail}`);
        if (ledger !== null && where.ledger !== undefined && ledger.dbBaseline !== undefined) {
          ledger.dbBaseline.restored = { at: result.at, ok: result.ok, detail: result.detail };
          await writeLedger(where.ledger.path, ledger).catch(() => undefined);
        }
      } catch (error) {
        log?.(`db restore: failed — ${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}`);
      } finally {
        await writable?.close().catch(() => undefined);
      }
    }
  } else if (activeBaseline !== null && baselineResolved.mode === 'restore' && pauseRequested(pauseFile)) {
    log?.('db restore: run paused — the tables were left as they are; `wowlidator db restore` puts them back');
  }
  await baselineClient?.close().catch(() => undefined);

  const fresh: CaseOutcome[] = collected.filter((o): o is CaseOutcome => o !== undefined);
  for (const entry of indexed) if (entry !== undefined) entries.push(entry);

  // **A resume answers for the whole catalog, not for its own subset.** The
  // planned cases an earlier pass already finished (same ledger, same run key)
  // are pulled in as finished tests: their verdicts join the roll-up, the exit
  // code and — where their proof bundle can still be read — the suite index,
  // so "36 passed then 72 more" reads as one 108-case catalog rather than a
  // 72-case run that lost a third of its history.
  const carried: CaseOutcome[] = [];
  if (inherited !== null && where.ledger !== undefined) {
    const ranIds = new Set(fresh.map((outcome) => caseIdOf(outcome.name)));
    for (const { id, outcome: prior } of carriedOutcomes(inherited, where.ledger.planned, ranIds)) {
      const outcome: CaseOutcome = {
        name: prior.name ?? id,
        verdict: prior.verdict,
        bundle: null,
        carried: true,
        ...(prior.reportPath === null || prior.reportPath === undefined ? {} : { reportPath: prior.reportPath }),
        ...(prior.reason === null || prior.reason === undefined ? {} : { reason: prior.reason }),
      };
      // Full fidelity when the evidence is still on disk: the prior pass's own
      // bundle makes a real index row. Unreadable or unrecorded (an older
      // ledger) degrades to the verdict line alone — disclosed, never invented.
      if (prior.proofPath !== null && prior.proofPath !== undefined) {
        try {
          const bundle = JSON.parse(await readFile(prior.proofPath, 'utf8')) as ProofBundle;
          if (typeof bundle?.runId === 'string' && Array.isArray(bundle.steps)) {
            outcome.bundle = bundle;
            if (outcome.reportPath !== undefined) {
              entries.push({ bundle, reportPath: outcome.reportPath });
            }
          }
        } catch {
          /* the verdict still stands; only the index row is lost */
        }
      }
      carried.push(outcome);
    }
    if (carried.length > 0) {
      process.stdout.write(
        `\n  carried    ${carried.length} case(s) finished by the earlier run of this catalog` +
          ` (run key ${ledger?.runKey ?? 'unknown'}) join this roll-up as finished tests\n`,
      );
    }
  }
  const outcomes: CaseOutcome[] = sortByPlan([...fresh, ...carried], where.ledger?.planned ?? []);

  if (outcomes.length > 1) {
    const blocked = outcomes.filter((o) => o.verdict === 'blocked');
    const failed = outcomes.filter((o) => o.verdict === 'failed');
    // A record-only case that ran clean (CG-09) is counted apart from the
    // wording near-misses: both await a person, for different reasons.
    const observed = outcomes.filter((o) => o.verdict === 'review' && isObservedOnly(o));
    const review = outcomes.filter((o) => o.verdict === 'review' && !isObservedOnly(o));
    const passed = outcomes.length - blocked.length - failed.length - review.length - observed.length;

    // One line per listed case, always all of them. The roll-up is the only
    // place the reader can see that the count adds up.
    process.stdout.write(
      `\n${outcomes.length} case(s) — ${passed} passed, ${failed.length} failed` +
        (review.length > 0 ? `, ${review.length} proved-? awaiting human review` : '') +
        (observed.length > 0 ? `, ${observed.length} observed only (no oracle in the sheet; captures for review)` : '') +
        (blocked.length > 0 ? `, ${blocked.length} never ran` : '') +
        '\n',
    );
    // The suite's whole bill on one line: wall clock summed over the cases
    // (concurrency means it exceeds the elapsed time — that is the point of
    // saying "case time") and every runtime model token — heals, agent turns,
    // data retries, reconstruction asks. Authoring spend is reported where
    // authoring happens; this line is what the RUNS cost.
    {
      // Over the cases THIS pass ran: a carried case's bill was reported by
      // the pass that paid it, and repeating it here would double-count.
      const spent = outcomes.filter((o) => o.carried !== true);
      const wallMs = spent.reduce((a, o) => a + (o.bundle?.durationMs ?? 0), 0);
      const tokIn = spent.reduce((a, o) => a + (o.bundle?.summary.inputTokens ?? 0), 0);
      const tokOut = spent.reduce((a, o) => a + (o.bundle?.summary.outputTokens ?? 0), 0);
      process.stdout.write(
        `  spent      ${fmtDuration(wallMs)} case time` +
          (tokIn > 0 || tokOut > 0
            ? ` · ${fmtCount(tokIn)} in / ${fmtCount(tokOut)} out tokens (runtime model roles)`
            : ' · 0 runtime model tokens') +
          '\n',
      );
    }
    // Every listed case gets a line, and every line that is not a pass says why.
    // A bare ✗ with nothing after it was the worst of both: it read as a defect
    // and gave nobody anything to act on.
    const MARK = { passed: '✓', failed: '✗', blocked: '⃠', review: '?' } as const;
    for (const outcome of outcomes) {
      // A pass whose path broke says so on its own line: the green is the
      // claims, the parenthesis is the path, and a reader skimming the roll-up
      // sees both.
      const withIssues = outcome.bundle?.status === 'passed-with-issues';
      // A negative test's ✓ means "the application refused it, as required" —
      // the opposite of what a bare ✓ reads as, so the roll-up says which.
      const polarity = outcome.bundle?.polarity === 'negative' ? ' [negative]' : '';
      // `pass**`: the claims held and the verdict is a pass; the asterisks
      // name the step that only acted and broke, so a reader knows where to
      // look without mistaking it for a validation failure.
      const issues = withIssues && outcome.bundle ? issueSteps(outcome.bundle) : [];
      // The case's own runtime record rides the line in brackets: wall clock
      // always, tokens only when a runtime model was actually paid.
      const cost =
        outcome.bundle === null
          ? ''
          : ` [${fmtDuration(outcome.bundle.durationMs)}` +
            (outcome.bundle.summary.inputTokens > 0 || outcome.bundle.summary.outputTokens > 0
              ? ` · ${fmtCount(outcome.bundle.summary.inputTokens)} in / ${fmtCount(outcome.bundle.summary.outputTokens)} out tok`
              : '') +
            ']';
      process.stdout.write(
        `  ${MARK[outcome.verdict]} ${outcome.name}${polarity}` +
          (withIssues
            ? ` — pass** (** ${issues[0] ?? 'a step that only acted broke'}${issues.length > 1 ? `; +${issues.length - 1} more` : ''})`
            : '') +
          (outcome.verdict === 'review'
            ? isObservedOnly(outcome)
              ? ' — observed only (the sheet has no oracle; read the captures in the report)'
              : ' — proved-? (a wording near-miss; confirm proved or failed in the panel)'
            : '') +
          (outcome.verdict === 'blocked' ? ' — never ran' : '') +
          (outcome.reason === undefined || withIssues ? '' : `: ${outcome.reason}`) +
          cost +
          // Inherited, not earned this pass: the earlier run of this catalog
          // (same run key) already finished it, and a resume keeps verdicts.
          (outcome.carried === true ? ' [finished by the earlier run]' : '') +
          '\n',
      );
    }

    // One front door for the folder: several reports with no index is several
    // files nobody opens, and the red one is as hidden as the green ones. The
    // blocked cases are listed there too, with no link, because there is
    // nothing to link to and an index of 7 rows for 10 cases reads as 7 cases.
    if (entries.length > 1 || blocked.length > 0) {
      const indexPath = await writeSuiteIndex(entries, join(where.dir, DEFAULT_INDEX_FILENAME), {
        title: where.indexTitle,
        blocked: blocked.map((o) => ({
          name: o.name,
          reason: o.reason ?? 'unknown',
          ...(o.reportPath === undefined ? {} : { reportPath: o.reportPath }),
        })),
      });
      process.stdout.write(`\n  index      ${indexPath}\n`);
    }

    // The truth table: when the catalog's sheet recorded its own results
    // (an Actual Result column → `knownResult` on every authored case), the
    // suite's verdicts can be graded against the human's — TP/TN/FP/FN, one
    // self-contained page listing every case. Pure arithmetic over verdicts
    // already earned: zero model tokens. Written whatever --report says,
    // because it is the suite-level result, not a per-case artifact.
    {
      // The suite case's own record first (it carries the sheet's `blocked`,
      // CG-01), the provenance stamp second, and for a carried case the
      // ledger the earlier pass wrote.
      const knownByName = new Map<string, KnownResult>();
      for (const testCase of queue.items) {
        const known = testCase.knownResult ?? testCase.flow.authoredBy?.knownResult;
        if (known !== undefined) knownByName.set(testCase.name, known);
      }
      for (const outcome of outcomes) {
        if (knownByName.has(outcome.name)) continue;
        const known = inherited?.[caseIdOf(outcome.name)]?.knownResult;
        if (known !== undefined) knownByName.set(outcome.name, known);
      }
      const rows = truthRows(outcomes, knownByName);
      if (hasGroundTruth(rows)) {
        const t = truthTally(rows);
        const truthPath = await writeTruthTable(
          join(where.dir, 'truth-table.html'),
          renderTruthTable(
            { source: where.indexTitle ?? 'catalog', ranAt: new Date().toISOString() },
            rows,
          ),
        ).catch(() => null);
        process.stdout.write(
          `  truth      TP ${t.tp} · TN ${t.tn} · FP ${t.fp} · FN ${t.fn} · ` +
            `no verdict ${t.noVerdict}` +
            (t.review > 0 ? ` · review ${t.review}` : '') +
            ` · unscored ${t.unscored}` +
            (t.accuracy === null ? '' : ` — accuracy ${Math.round(t.accuracy * 100)}% vs sheet`) +
            (truthPath === null ? '' : `\n  truth page ${truthPath}`) +
            '\n',
        );
      }
    }
  }

  if (ledger !== null && where.ledger !== undefined) {
    const left = remaining(ledger);
    ledger.generatedAt = where.ledger.stamp?.() ?? ledger.generatedAt;
    ledger.ended = {
      at: new Date().toISOString(),
      // Paused outranks the generic wording: every started case finished with
      // a verdict, so the count that is "left" is exactly where a resume
      // picks up — and the resume runs on current code, in its own process.
      cause: pauseRequested()
        ? `paused with ${left.length} case(s) still to run — resume continues at the exact case, on current code`
        : left.length === 0
          ? null
          : `${left.length} case(s) were never reached or never ran`,
      complete: left.length === 0,
    };
    await writeLedger(where.ledger.path, ledger).catch(() => undefined);
    process.stdout.write(
      `  progress   ${where.ledger.path}${left.length === 0 ? '' : ` — ${left.length} left; continue with --resume`}\n`,
    );

    // The final rewrite of the live catalog report (see `CatalogLiveReport`):
    // every verdict this pass earned or carried, the page no longer marked as
    // in progress. Printed here because this is where the roll-up names its
    // artifacts; the file itself has existed since the run started.
    if (liveReport !== null) {
      await liveReport.settle();
      const artifacts = await liveReport.refresh(true);
      if (artifacts !== null) {
        const { htmlPath, excel } = artifacts;
        process.stdout.write(
          `  catalog report ${htmlPath}\n` +
            `  passed xlsx ${excel.xlsxPath} — ${excel.passedCases} passed case(s)` +
            (excel.caseXlsxPaths.length > 0 ? `, one workbook per proved case in ${dirname(excel.caseXlsxPaths[0]!)}` : '') +
            (excel.removed.length > 0 ? `, ${excel.removed.length} stale export(s) of cases that no longer pass removed` : '') +
            '\n',
        );
      }
    }
  }
  return outcomes;
}

/** A `review` outcome that is a record-only case's clean run (CG-09), not a wording near-miss. */
function isObservedOnly(outcome: CaseOutcome): boolean {
  return outcome.reason !== undefined && outcome.reason.startsWith('observed only');
}

/** `95s` under two minutes, `4m12s` above — a duration a reader scans, not parses. */
function fmtDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

/** `950`, `12.3k`, `2.1M` — token counts at the precision anyone acts on. */
function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** A fixed list as a queue with nothing more to come. */
function closedQueue(cases: readonly SuiteCase[]): CaseQueue<SuiteCase> {
  const queue = new CaseQueue<SuiteCase>();
  for (const testCase of cases) queue.push(testCase);
  queue.close();
  return queue;
}
