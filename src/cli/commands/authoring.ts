/**
 * The commands that write tests: generate, author, draft, and catalog.
 * Split out of cli.ts verbatim.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { phaseHeader, withLogTag } from '../../log-format.js';

import type { Page } from 'playwright';

import {
  LlmCatalogModel,
  approvedClaims,
  buildAuthoringPrompt,
  extractClaims,
  parseClaimsFile,
  toClaimsFile,
  type ClaimsFile,
} from '../../catalog/catalog.js';
import { LlmDraftModel, draftCatalog } from '../../catalog/draft.js';
import { extractDocumentFile, extractWorkbookSheets } from '../../catalog/extract.js';
import { CONTEXT_DOC_MAX_CHARS, referencedSources, selectRelevantContext } from '../../catalog/retrieve.js';
import { assessDeadEndRisk, describeRisk, riskEnabled, type DeadEndRisk, type RiskModel } from '../../generator/dead-end-risk.js';
import { fkPairsFromGraph } from '../sections.js';
import { raiseSessionCapFor } from '../../providers/claude-cli-session.js';
import { bm25 } from '../../context/relevance.js';
import { setClaudeRetrievalCorpus } from '../../providers/claude-retrieval.js';
import { StructuredOutputUnavailableError } from '../../providers/llm-factory.js';
import {
  parseSequenceDiagram,
  recomputeLaneTestability,
  sequenceToClaims,
  toGateInfo,
  type SequenceDoc,
} from '../../catalog/sequence.js';
import {
  dbTablesNamed,
  describeCase,
  destinationOf,
  menuPathOf,
  observeOnlyCase,
  parseTestCaseTable,
  parseWorkbookCases,
  renderTestCaseTable,
  roundsOf,
  sheetGateReason,
  sheetVerdict,
  personasOf,
  splitPairs,
  tablePersonas,
  tableToClaims,
  testDataPairs,
  unconfirmedTestData,
  uniqueKeys,
  type CaseDestination,
  type SheetVerdict,
  type TestCaseRow,
} from '../../catalog/test-case-table.js';
import { runSuffix, uniquePerRun } from '../../data/mock-data.js';
import {
  LlmDiagramTranscriber,
  isDiagramImage,
  transcribeDiagramImage,
} from '../../catalog/diagram-image.js';
import { ContextEngine } from '../../context/context-engine.js';
import { findRouteForUrl, routesForDescription, toPromptContext } from '../../context/query.js';
import { concreteRouteUrl } from '../../context/route-match.js';
import {
  graphFileFor,
  navDestination,
  resolveRepo,
  upsertRepo,
  type NavLink,
  type NavMap,
} from '../../context/repo-registry.js';
import type { ProjectGraph } from '../../context/types.js';
import { formatCoverage, meaningfulCoverage } from '../../coverage/ax-coverage.js';
import {
  formatProofSummary,
  writeProofBundle,
  type GenerationProvenance,
} from '../../engine/proof-bundle.js';
import { runFlow, withPage, withPages, type Flow } from '../../engine/runner.js';
import { pilotCapture } from '../../context/capture-pilot.js';
import {
  ApiTestGenerator,
  LlmApiGeneratorModel,
  NoSpecError,
} from '../../generator/api-test-generator.js';
import { statedPolarity } from '../../engine/polarity.js';
import {
  AuthoringError,
  DEFAULT_AUTHOR_MAX_NODES,
  FlowAuthor,
  LOGIN_URL_PATTERN,
  LlmFlowAuthorModel,
  caseFlows,
  ADVANCED_MARKER,
  EXPANDED_MARKER,
  type AuthoredFlow,
} from '../../generator/flow-author.js';
import { LlmGeneratorModel, TestGenerator } from '../../generator/test-generator.js';
import type { GeneratedSuite } from '../../generator/test-generator.js';
import { captureAxNodes, captureAxTree, type AxNode } from '../../healer/jit-healer.js';
import { DEFAULT_AUTHORING_RULES } from '../../generator/value-rules.js';
import { performSignIn } from '../../engine/sign-in.js';
import { acceptConsentGate } from '../../engine/consent-gate.js';
import { probeInteractions } from '../../context/page-probe.js';
import { formatTrend } from '../../history/run-history.js';
import {
  reportGroupForUrl,
  resolveReportPath,
  slugify,
  writeHtmlReport,
} from '../../reporter/html-reporter.js';
import {
  applyQuarantine,
  catalogFlowPath,
  cleanupChrome,
  flowFilename,
  openReport,
  pageDir,
  prepare,
  writeFlowFile,
  writeMachineReports,
} from '../artifacts.js';
import { EXIT, exitCodeFor, suiteExit, type CaseOutcome } from '../exit.js';
import {
  AUTHORING_REFUSAL_CAP,
  forgetAuthored,
  isErrorOutcome,
  isFailedOutcome,
  ledgerPathFor,
  markForRerun,
  markVacuous,
  readLedger,
  recordOutcome,
  remaining,
  resumeAuthored,
  summariseLedger,
  writeLedger,
  type LedgerAuthored,
  type SuiteLedger,
} from '../suite-progress.js';
import { substantiveAssertions, vacuousFlow } from '../../generator/vacuous.js';
import { CaseQueue, DEFAULT_CONCURRENCY, ScenarioGate, authorWorkers, dependencyCycles, mapPool, orderDependentsAfterSources, orderScenariosFastestFirst, unresolvedReferences } from '../case-plan.js';
import { healHintsFrom } from '../../context/heal-hints.js';
import { lookupPersona, personaEmails, personaLabelOf, type CliOptions } from '../options.js';
import { pauseRequested } from '../pause.js';
import { awaitQuotaRelease, ensureQuotaHold } from '../quota-hold.js';
import {
  assertRolesResolvable,
  buildAgent,
  buildCapturePilot,
  buildDataModel,
  buildFlowReviewer,
  buildAuthorRetryModel,
  buildValueResolution,
  buildHealer,
  buildStepRepair,
  lineLogger,
  planLogger,
  stepLogger,
  buildRiskModel,
} from '../runtime.js';
import { runCases, type LedgerHooks, type SuiteCase } from '../run-cases.js';

export async function cmdGenerate(url: string | undefined, options: CliOptions): Promise<number> {
  // `--api` reads the indexed spec rather than a page, so it needs no url.
  if (!url && !options.api) {
    process.stderr.write('wowlidator generate: missing <url>\n');
    return 2;
  }

  const gate = assertRolesResolvable(options, ['generator']);
  if (gate) {
    process.stderr.write(`wowlidator generate: ${gate}\n`);
    return EXIT.environment;
  }

  const blocked = await prepare(options, url);
  if (blocked !== null) return blocked;

  const log = lineLogger(options);

  // Static, no model call — see cmdContext. Purely additive to the prompt.
  // A saved repo (--repo) outranks the cwd build: it names the application
  // under test explicitly, and an unknown selection fails loudly here.
  let repoContextGraph: ProjectGraph | null = null;
  try {
    repoContextGraph = await loadRepoGraph(options, log ?? undefined);
  } catch (error) {
    process.stderr.write(`wowlidator generate: ${(error as Error).message}\n`);
    return 2;
  }
  const projectGraph =
    repoContextGraph ??
    (options.context || options.api
      ? await new ContextEngine({
        rootDir: options.root,
        cacheFile: options.contextOut,
        openApiSpec: options.openapi,
      }).build()
      : undefined);
  // What a claude-cli generator/healer session may search on demand — the
  // same graph the prompt slice is cut from. See `providers/claude-retrieval.ts`.
  setClaudeRetrievalCorpus({ graph: projectGraph ?? null });

  let suite: GeneratedSuite;
  if (options.api) {
    // The spec is the inventory here, exactly as the AX tree is for a page.
    const apiGenerator = new ApiTestGenerator({
      model: new LlmApiGeneratorModel({ factory: options.factory }),
      projectGraph: projectGraph!,
      maxCases: options.maxCases,
      policy: options.policy,
      onLog: log,
    });
    try {
      suite = await apiGenerator.generate(options.focus);
    } catch (error) {
      if (error instanceof NoSpecError) {
        // Refusing is the honest answer — say why, don't dump a stack.
        process.stderr.write(`wowlidator generate --api: ${error.message}\n`);
        return 2;
      }
      throw error;
    }
  } else {
    const generator = new TestGenerator({
      model: new LlmGeneratorModel({ factory: options.factory }),
      maxCases: options.maxCases,
      policy: options.policy,
      projectGraph,
      probe: options.probe,
      onLog: log,
    });

    log?.(`opening ${url}…`);
    const pilot = buildCapturePilot(options);
    suite = await withPage(options.cdp, async (page) => {
      await page.goto(url!, { waitUntil: 'domcontentloaded' });
      // Give client-rendered pages a beat before reading the AX tree.
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      // Then let the agent *look*: a heuristic can wait for the network, only
      // judgement can tell "still loading" from "loaded and empty".
      if (pilot) await pilotCapture(page, pilot, log);
      return generator.generate(page, options.focus);
    });
  }

  // Everything this command produces for this page goes in one folder.
  const group = reportGroupForUrl(suite.sourceUrl);
  const dir = pageDir(options, group);
  const suitePath = options.suite === undefined ? join(dir, 'suite.json') : resolve(options.suite);

  await mkdir(resolve(suitePath, '..'), { recursive: true });
  await writeFile(suitePath, `${JSON.stringify(suite, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `generated ${suite.cases.length} case(s) and ${suite.defects.length} defect(s) from ${suite.sourceUrl}\n` +
    `  model      ${suite.model} (${suite.latencyMs}ms, ${suite.inputTokens ?? 0} in / ${suite.outputTokens ?? 0} out tokens)\n` +
    `  folder     ${dir}\n` +
    `  suite      ${suitePath}\n`,
  );
  for (const testCase of suite.cases) {
    process.stdout.write(`  · [${testCase.kind}] ${testCase.name} (${testCase.flow.steps.length} steps)\n`);
  }
  // Surfaced, not silently dropped — a rising count means the prompt is slipping.
  for (const rejected of suite.rejected) {
    process.stdout.write(`  ✗ [${rejected.kind}] ${rejected.name} — rejected: ${rejected.reason}\n`);
  }

  // Each case is written out as a standalone flow whether or not it runs now,
  // so `wowlidator run <that file>` works later without re-generating.
  for (const [index, testCase] of suite.cases.entries()) {
    // Same reason as the catalog path: the file outlives the run, and a later
    // `wowlidator run` of it must land in this suite's group rather than
    // reading as a flow somebody wrote by hand.
    testCase.flow.authoredBy = {
      model: suite.model,
      generatedAt: suite.generatedAt,
      sourceUrl: suite.sourceUrl,
      kind: testCase.kind,
      rationale: testCase.rationale,
    };
    await writeFlowFile(
      join(
        dir,
        flowFilename({
          runId: '',
          name: testCase.name,
          status: 'generated',
          index: index + 1,
          kind: testCase.kind,
          group,
        }),
      ),
      testCase.flow,
    );
  }

  if (!options.run) return 0;

  // Execute every generated case, one report per case — and report on every one
  // of them, including any that could not be run at all. See `runCases`.
  const outcomes = await runCases(
    suite.cases.map((testCase, index) => ({
      name: testCase.name,
      flow: testCase.flow,
      kind: testCase.kind,
      // Static findings ride along with the first case so they aren't lost.
      defects: index === 0 ? suite.defects : undefined,
      generatedBy: {
        model: suite.model,
        generatedAt: suite.generatedAt,
        sourceUrl: suite.sourceUrl,
        kind: testCase.kind,
        rationale: testCase.rationale,
      },
    })),
    options,
    { dir, group, indexTitle: `wowlidator suite — ${group}` },
  );

  const ran = outcomes.flatMap((o) => (o.bundle === null ? [] : [o.bundle]));
  await writeMachineReports(ran, options);
  await openReport(outcomes.find((o) => o.reportPath !== undefined)?.reportPath ?? null, options);
  await cleanupChrome(options);

  return suiteExit(outcomes);
}

/**
 * Turn a described test into one runnable flow.
 *
 * With `--url` the model is given the page's accessibility tree and held to
 * selectors that appear in it. Without one it can only guess, so the result is
 * labelled ungrounded and every selector is flagged for hand-verification —
 * useful as a skeleton, never as something to trust into CI.
 */
/**
 * A catalog: a document of claims, turned into a test.
 *
 * Two phases on purpose, and the gate between them is the whole point — see
 * `src/catalog/catalog.ts`. `--claims-only` stops after listing what the
 * document asserts, which costs one cheap model call and no browser; the second
 * phase reads the (possibly pruned) claims file back and authors a flow that
 * covers exactly what survived.
 *
 * Running it in one go is allowed and is the wrong default: nothing has been
 * looked at, so a claim the model read out of a heading gets a browser and a
 * report of its own. The UI never does it; the flag exists for a script that
 * has already reviewed the catalog once.
 *
 * **The second phase produces several runs, not one.** A catalog asserts things
 * that are independent of each other, so it is authored as discrete cases and
 * each case is run on its own: one that fails is recorded, and the rest are
 * still checked. A single flow would stop at its first failure — correctly,
 * since everything after it is in an unknown state — and every remaining claim
 * would go unanswered while the report showed only the one that broke.
 */
/**
 * Construct a catalog from a description, some context documents, or a page.
 *
 * The other two ways in. `catalog <file>` starts from a sheet a team already
 * has; **Describe** and **Add Context** had nothing of the kind, and went
 * straight from a sentence to a flow — so what actually got run was never
 * written down anywhere a person could read, amend, or hand to a tester, and the
 * review gate that the catalog path is built around was skipped entirely.
 *
 * This writes the catalog instead, in the project's own format, and stops. It
 * runs nothing. What comes out is an ordinary catalog file, so the next step is
 * the ordinary catalog command and all three entrances meet at the same
 * reviewable table.
 *
 *   wowlidator draft "probation reviews" --url http://localhost:3000/…
 *   …edit the sheet…
 *   wowlidator catalog <that file> --url … --run
 */
export async function cmdDraft(subject: string | undefined, options: CliOptions): Promise<number> {
  const hasContext = options.contextDocs.length > 0;
  if ((subject === undefined || subject.trim() === '') && !hasContext) {
    process.stderr.write(
      'wowlidator draft: say what to cover, or give it something to read.\n\n' +
      '  wowlidator draft "the probation inbox"\n' +
      '  wowlidator draft --context-doc spec.md\n',
    );
    return EXIT.usage;
  }

  const gate = assertRolesResolvable(options, ['generator']);
  if (gate) {
    process.stderr.write(`wowlidator draft: ${gate}\n`);
    return EXIT.environment;
  }

  const log = lineLogger(options);

  const contextDocs = [];
  try {
    for (const path of options.contextDocs) {
      contextDocs.push(await extractDocumentFile(resolve(path)));
    }
  } catch (error) {
    process.stderr.write(
      `wowlidator draft: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT.usage;
  }
  for (const context of contextDocs) {
    if (context.note !== '') process.stdout.write(`  ! ${context.name}: ${context.note}\n`);
  }
  // A claude-cli generator may search these documents on demand as well as
  // being handed the retrieved slice — see `providers/claude-retrieval.ts`.
  setClaudeRetrievalCorpus({ docs: contextDocs });

  // A page is optional and worth a lot when it is there: menu paths and control
  // names come out matching what is really on screen, rather than being invented
  // and then failing to resolve three commands later.
  let axTree: string | undefined;
  if (options.url !== undefined) {
    const blocked = await prepare(options, options.url);
    if (blocked !== null) return blocked;
    log?.(`reading ${options.url}…`);
    axTree = await withPage(options.cdp, async (page) => {
      await page.goto(options.url as string, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      return captureAxTree(page, DEFAULT_AUTHOR_MAX_NODES);
    });
  }

  log?.('asking the generator role for the test cases…');
  let drafted;
  try {
    drafted = await draftCatalog(new LlmDraftModel({ factory: options.factory }), {
      description: subject ?? '',
      context: contextDocs,
      axTree,
      url: options.url,
      maxCases: options.maxDraftCases,
    });
  } catch (error) {
    process.stderr.write(
      `wowlidator draft: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT.failed;
  }

  if (drafted.rows.length === 0) {
    process.stderr.write(
      'wowlidator draft: no cases came back. Say more about what to cover, or ' +
      'add the spec with --context-doc.\n',
    );
    return EXIT.failed;
  }

  const target =
    options.catalogOut === undefined
      ? join(resolve(options.reportDir), 'catalogs', `${slugify(drafted.subject || subject || 'catalog')}.csv`)
      : resolve(options.catalogOut);
  await mkdir(resolve(target, '..'), { recursive: true });
  await writeFile(target, renderTestCaseTable(drafted.rows), 'utf8');

  const scenarios = new Set(drafted.rows.map((row) => row.scenarioId));
  const negative = drafted.rows.filter((row) => row.polarity === 'Negative').length;

  process.stdout.write(
    `drafted ${drafted.rows.length} case(s) across ${scenarios.size} scenario(s) — ${drafted.subject}\n` +
    `  model      ${drafted.model} (${drafted.latencyMs}ms, ${drafted.inputTokens ?? 0} in / ${drafted.outputTokens ?? 0} out tokens)\n` +
    `  grounded   ${axTree === undefined ? 'NO — no page was read, so menu paths are guesses' : `yes — against ${options.url}`}\n` +
    `  negative   ${negative} of ${drafted.rows.length}\n` +
    `  catalog    ${target}\n`,
  );
  for (const row of drafted.rows) {
    process.stdout.write(`    ${row.caseId} [${row.priority}] ${row.testCase}\n`);
  }
  process.stdout.write(
    '\nNothing has been run. This is a catalog, not a test — read it, strike out ' +
    'what you do not want, then:\n' +
    `  wowlidator catalog ${target} --url <page> --run\n`,
  );

  return EXIT.ok;
}

/**
 * One authored flow per table row, against one open page.
 *
 * The page is opened once and every row is authored against it: the browser is
 * the slow part, not the model, and reconnecting twelve times to read the same
 * accessibility tree would be the expensive way to get the same tree.
 *
 * **A row that cannot be authored does not stop the others.** Same rule as
 * running them: the sheet asked twelve questions, and one the model could not
 * express is not a reason to answer none of the rest. It is reported and the
 * loop goes on.
 */
/** The authoring summary: what was written, by which model, and where. */
function printAuthored(
  authored: AuthoredFlow,
  cases: readonly { name: string; flow: Flow }[],
  flowPaths: readonly string[],
  claims: number,
  group: string | undefined,
  dir: string,
): void {
  const totalSteps =
    (authored.flow.setup?.length ?? 0) +
    authored.flow.steps.length +
    (authored.flow.teardown?.length ?? 0);

  process.stdout.write(
    `authored "${authored.flow.name}" — ${totalSteps} step(s) in ${cases.length} case(s) for ${claims} claim(s)\n` +
    `  model      ${authored.model} (${authored.latencyMs}ms, ${authored.inputTokens ?? 0} in / ${authored.outputTokens ?? 0} out tokens)\n` +
    `  grounded   ${authored.grounded ? `yes — selectors checked against ${authored.sourceUrl}` : 'NO — selectors are guesses; verify every one before trusting this'}\n` +
    (group === undefined ? '' : `  folder     ${dir}\n`),
  );
  for (const [index, testCase] of cases.entries()) {
    process.stdout.write(
      `  · ${testCase.name} (${testCase.flow.steps.length} steps)\n` +
      `    flow     ${flowPaths[index]}\n`,
    );
  }
  if (authored.droppedSteps > 0) {
    process.stdout.write(
      `  ! dropped ${authored.droppedSteps} malformed step(s) the model emitted\n`,
    );
  }
  if (authored.review !== undefined) {
    const r = authored.review;
    process.stdout.write(
      `  review     ${r.flagged} ungrounded step(s): ${r.replaced} repointed, ${r.inserted} inserted, ` +
      `${r.kept} confirmed, ${r.unsure} still unsure, ${r.rejected.length} proposal(s) rejected ` +
      `(${r.model}, ${r.latencyMs}ms, ${r.inputTokens} in / ${r.outputTokens} out tokens)\n`,
    );
    for (const line of r.notes) process.stdout.write(`    · ${line}\n`);
    for (const line of r.rejected) process.stdout.write(`    ! ${line}\n`);
  }
}

/** One authored row of a test-case table, with the sheet facts wowUI groups on. */
interface TableCase {
  name: string;
  flow: Flow;
  scenarioId: string;
  /** `<scenarioId> <scenario title>` — the collapsible group label in wowUI. */
  scenario: string;
  caseTitle: string;
  /** The pre-run dead-end risk, judged right after authoring — see `dead-end-risk.ts`. */
  risk?: DeadEndRisk | undefined;
  /**
   * The sheet's recorded result (Actual Result / Test Status), normalised —
   * accuracy's ground truth. `blocked` is the sheet saying its testers could
   * not run the row (CG-01); it reaches the truth table as its own class and
   * never the provenance's passed/failed field.
   */
  knownResult?: SheetVerdict | undefined;
  /**
   * Every Expected line of the row is record-only (CG-09: `= ? OQ-…`,
   * `ยังไม่มีคำตอบ ให้บันทึกค่าที่ระบบแสดงจริง`): the case captures and never
   * asserts, and a clean run ends `review` with its captures, not `passed`.
   */
  recordOnly?: boolean | undefined;
  /** Cases this one continues from (CG-12), as their qualified ids. */
  dependsOn?: readonly string[] | undefined;
  /**
   * The credentials the row's persona labels resolved to (CG-05), for the
   * run's `signIn` steps. In memory only — never written with the flow.
   */
  personas?: Readonly<Record<string, { email: string; password: string }>> | undefined;
}


/**
 * `Flow.caseContext` for one sheet row — the compact card the runtime model
 * roles (healer, agent) read so a repair or a workflow turn knows the claim
 * the step serves. The sheet's own words, whitespace-folded and bounded:
 * context must never grow into a second copy of the catalog. The Note column
 * rides along because it is where a sheet says the things that decide honest
 * behaviour ("Cancelled", "KNOWN FAIL", "confirmed 22 Jul") — exactly what a
 * model needs before spending turns proving a removed feature absent.
 */
/**
 * Why a sheet row must not be authored at all, or null (S7). `Cancelled`
 * in Actual Result, or a Note that says the case is cancelled/dropped, is a
 * row about a feature that no longer exists in the requirement — authoring
 * it can only produce a false failure. Pending/TBC rows still author (the
 * feature exists, its wording is unsettled) but the author is told, see
 * `caseCard`.
 */
export function sheetGate(
  row: TestCaseRow,
  options: {
    /** `--include-blocked`: author Blocked / Pending rows on purpose (CG-01). */
    includeBlocked?: boolean | undefined;
    /**
     * Texts that may stand in for the cases a row cites but this catalog lacks
     * (CG-12: `ต่อจากเคส E2E-118`, `Employee ID : EMXXXX (จาก E2E-118)`) — the
     * context documents. A reference one of them names is a record the run
     * can look up; one none of them names is a record the run cannot have.
     */
    registry?: readonly string[] | undefined;
  } = {},
): string | null {
  // The pure gate lives with the parser (`sheetGateReason`): Cancelled, a Note
  // that says cancelled or cannot-run-yet, and — since CG-01 — a Test Status
  // of Blocked / Pending deploy / Pending confirm with its bug ticket.
  const reason = sheetGateReason(row, { includeBlocked: options.includeBlocked });
  if (reason !== null) return reason;
  // A row that NEEDS a case this catalog does not hold — its employee, its
  // plan — cannot be authored standalone: measured, the probation rows cite
  // E2E-118's hire and the harness would create nothing and fail on a record
  // that does not exist. Refused here, $0, unless a supplied document names
  // the case (a registry of what the earlier cycle created).
  const external = (row.externalRefs ?? []).filter(
    (id) => !(options.registry ?? []).some((text) => text.includes(id)),
  );
  if (external.length > 0) {
    return `depends on ${external.join(', ')}, which is not in this catalog — pass a --context-doc that records what it created, or run that case first`;
  }
  return null;
}

// `personasOf` moved to `catalog/test-case-table.ts` (2026-09-04): the claims
// phase needs it too, and a second implementation there would be a second
// answer to "how many logins does this catalog need" — the panel's gate
// promising two accounts while authoring refuses a third. Re-exported here
// because this is the import path every caller and test already uses.
export { personasOf };

/**
 * The row's labels resolved through the persona map (CG-05). A single
 * persona, or the FIRST of several, may fall back to the unlabelled `--as`
 * account — that is what every run before this passed, and `<HR_ADMIN_ACCOUNT>`
 * with `WOWLIDATOR_AS=admin@…` is the ec10 benchmark's own shape. A SECOND
 * persona has no such fallback: one session cannot be both people, and an
 * unmapped second label is exactly the guessed password this exists to end.
 * `missing` names the labels the row cannot be authored without.
 */
export function resolveRowPersonas(
  labels: readonly string[],
  options: Pick<CliOptions, 'personas' | 'credentials'>,
): {
  personas: Record<string, { email: string; password: string }>;
  missing: string[];
  first: { email: string; password: string } | undefined;
  fellBack: string | null;
} {
  const personas: Record<string, { email: string; password: string }> = {};
  const missing: string[] = [];
  let fellBack: string | null = null;
  labels.forEach((label, index) => {
    const key = personaLabelOf(label);
    let creds = lookupPersona(options.personas, key);
    if (creds === undefined && index === 0 && options.credentials !== undefined) {
      creds = options.credentials;
      fellBack = key;
    }
    if (creds === undefined) missing.push(key);
    else personas[key] = creds;
  });
  const firstLabel = labels[0] === undefined ? undefined : personaLabelOf(labels[0]);
  const first = firstLabel === undefined ? options.credentials : (personas[firstLabel] ?? options.credentials);
  return { personas, missing, first, fellBack };
}

/**
 * The described case with each `<LABEL>` token the map resolves spelled as
 * `email (<LABEL>)` — so the sheet's own `Login ด้วย <HR_ADMIN_ACCOUNT>` tells the
 * author which account, by email, and keeps the label a `signIn` step names.
 * Never the password.
 */
export function describeWithPersonas(
  described: string,
  personas: Readonly<Record<string, { email: string; password: string }>>,
): string {
  return described.replace(/<([A-Z][A-Z0-9_]*_ACCOUNT)>/g, (token, label: string) => {
    const creds = lookupPersona(personas, label);
    return creds === undefined ? token : `${creds.email} (${token})`;
  });
}

/**
 * The sheet's key values made unique to this run, in every column at once
 * (CG-13). The sheet says `Benefit Plan ID = PL_06_21`; the application
 * answered "already exists" on every rerun after the first, and the testers
 * appended `_R1`, `_R2` by hand. The resolver rewrites the TYPED value
 * (`fromUniquePerRun`); the assertions quote Expected, so the same literal
 * must change in Test data, Steps and Expected together or the case types
 * one thing and looks for another. One suffix, `runSuffix(runKey)`, and a
 * value already carrying it is left alone — the substitution is idempotent,
 * so the resolver seeing the rewritten text cannot add a second tail.
 */
export function substituteUniqueKeys(
  row: TestCaseRow,
  runKey: string | undefined,
): { row: TestCaseRow; substitutions: { key: string; from: string; to: string }[] } {
  if (runKey === undefined || runSuffix(runKey) === '') return { row, substitutions: [] };
  const suffix = runSuffix(runKey);
  const substitutions: { key: string; from: string; to: string }[] = [];
  const seen = new Set<string>();
  // Longest first, so `PL_06_21_R3` is rewritten before `PL_06_21` could eat its head.
  const keys = [...uniqueKeys(row)]
    .map((k) => ({ ...k, value: k.value.replace(/^["“]|["”]$/g, '').trim() }))
    .filter((k) => k.value !== '' && !k.value.endsWith(`_${suffix}`))
    .sort((a, b) => b.value.length - a.value.length);
  let { testData, steps, expected } = row;
  for (const key of keys) {
    if (seen.has(key.value)) continue;
    seen.add(key.value);
    const to = uniquePerRun(key.value, runKey);
    const escaped = key.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'gu');
    testData = testData.replace(re, to);
    steps = steps.replace(re, to);
    expected = expected.replace(re, to);
    substitutions.push({ key: key.key, from: key.value, to });
  }
  if (substitutions.length === 0) return { row, substitutions };
  return { row: { ...row, testData, steps, expected }, substitutions };
}

/**
 * A multi-round row as one labelled case per round (CG-10): `รอบที่ 2 …`
 * legs of a hire, `Case 2:` sub-runs of a payroll period, `--Insert R2--`
 * phases, a `ว่างทีละช่อง` loop over fields. Each round is its own case —
 * `PL_08_19#r2` — with the round's data written over the base Test data (a
 * key the round overrides takes the round's value; a new key is appended),
 * the round named in its Preconditions so the author performs the full
 * script ONCE for it, and an edge to the round before it (an `Insert R2`
 * inserts after R1's row exists). A row citing the expanded case now cites
 * its last round. A single-round row is returned as it was.
 */
export function expandRounds(rows: readonly TestCaseRow[]): TestCaseRow[] {
  const lastRound = new Map<string, string>();
  const out: TestCaseRow[] = [];
  for (const row of rows) {
    const rounds = roundsOf(row).map((round) => ({
      ...round,
      // The EC sheet writes a round's data INTO its header line — `3. รอบที่ 2
      // หน่วยธุรกิจ CU ค่าที่ต่างจากรอบอื่นในรอบนี้ Company = C013` — where the
      // parser keeps it as the label. The pairs are read off the label then.
      dataOverrides:
        round.dataOverrides !== '' || !/\s=\s/.test(round.label)
          ? round.dataOverrides
          : splitPairs(round.label.slice(round.label.search(/[A-Z][A-Za-z0-9 /()'-]{0,40}\s=\s/)))
            .filter((pair) => pair.key.split(/\s+/).length <= 5)
            .map((pair) => `${pair.key} = ${pair.value}`)
            .join('; '),
    }));
    if (rounds.length < 2) {
      out.push(row);
      continue;
    }
    // A sheet that numbers its later rounds from 2 leaves round 1 implicit —
    // the base Test data as written. It is a case too.
    if (rounds[0]!.n > 1) rounds.unshift({ label: 'รอบที่ 1 (ชุดข้อมูลหลัก)', n: 1, dataOverrides: '' });
    const total = rounds.length;
    rounds.forEach((round, index) => {
      const id = `${row.caseId}#r${round.n}`;
      const previous = index === 0 ? null : `${row.caseId}#r${rounds[index - 1]!.n}`;
      const ref = round.stepsRef === undefined ? '' : ` (repeat steps ${round.stepsRef})`;
      const banner =
        `Round ${round.n} of ${total} — ${round.label}${ref}: this case performs the full script ONCE ` +
        `with this round's data below; the other rounds are separate cases.`;
      out.push({
        ...row,
        caseId: id,
        sheetCaseId: row.sheetCaseId ?? row.caseId,
        testCase: `${row.testCase} — round ${round.n}/${total}: ${round.label}`,
        preconditions: row.preconditions === '' ? banner : `${banner}\n${row.preconditions}`,
        testData: applyRoundOverrides(row.testData, round.dataOverrides),
        dependsOn: [...(row.dependsOn ?? []), ...(previous === null ? [] : [previous])],
      });
      lastRound.set(row.caseId, id);
    });
  }
  if (lastRound.size === 0) return out;
  return out.map((row) =>
    row.dependsOn === undefined
      ? row
      : { ...row, dependsOn: [...new Set(row.dependsOn.map((id) => (id === row.caseId ? id : (lastRound.get(id) ?? id))))] },
  );
}

/** `Key = value; Key2 = value2` written over the Test data block, one pair per line. */
function applyRoundOverrides(testData: string, overrides: string): string {
  const pairs = overrides
    .split('; ')
    .map((pair) => pair.trim())
    .filter((pair) => pair.includes(' = '))
    .map((pair) => {
      const at = pair.indexOf(' = ');
      return { key: pair.slice(0, at).trim(), value: pair.slice(at + 3).trim() };
    });
  if (pairs.length === 0) return testData;
  const lines = testData.split('\n');
  const appended: string[] = [];
  for (const pair of pairs) {
    const re = new RegExp(`^(\\s*[-•*]?\\s*)${pair.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*.*$`, 'iu');
    let hit = false;
    for (let i = 0; i < lines.length; i += 1) {
      const m = re.exec(lines[i]!);
      if (m === null) continue;
      lines[i] = `${m[1] ?? ''}${pair.key} = ${pair.value}`;
      hit = true;
    }
    if (!hit) appended.push(`${pair.key} = ${pair.value}`);
  }
  return [...lines, ...appended].filter((line, i, all) => !(line.trim() === '' && i === all.length - 1)).join('\n');
}

/**
 * The workbook sliced to the worksheets and Categories asked for (CG-11),
 * case-insensitively; a Category may be spelled `SHEET/Category`. Empty
 * filters keep everything.
 */
export function sliceRows(
  rows: readonly TestCaseRow[],
  sheets: readonly string[],
  categories: readonly string[],
): TestCaseRow[] {
  const fold = (value: string | undefined): string => (value ?? '').trim().toLowerCase();
  const wantSheets = sheets.map(fold).filter((s) => s !== '');
  const wantCategories = categories.map(fold).filter((c) => c !== '');
  return rows.filter((row) => {
    if (wantSheets.length > 0 && !wantSheets.includes(fold(row.sheet))) return false;
    if (wantCategories.length > 0) {
      const own = fold(row.category);
      const qualified = `${fold(row.sheet)}/${own}`;
      if (!wantCategories.includes(own) && !wantCategories.includes(qualified)) return false;
    }
    return true;
  });
}

/** Names that OPEN something — a dialog, a form, the wizard's next step. Never a save, a submit, a delete. */
const OPENING_NAME = /^(?:create|add|new|next|continue|insert|open|edit|make correction|\+|สร้าง|เพิ่ม|ถัดไป|เปิด|แก้ไข|ทำรายการ)/iu;
const NOT_AN_OPENING = /delete|remove|ลบ|save|submit|บันทึก|confirm|ยืนยัน|approve|อนุมัติ|reject|ปฏิเสธ|sign|log ?out|ออกจากระบบ/iu;

/**
 * The first control a row's Steps click to reach its fields (CG-18, the
 * reduced form): `กดปุ่ม "Create Plan"`, `Click Add`, `กด ถัดไป`, `+`. Only
 * an OPENING name qualifies — the capture may open a dialog or a wizard step
 * on its own tab, never save, submit or delete anything — and only from the
 * first three steps: a control clicked later is past fields the author has
 * to fill first. Null when the row names none.
 */
export function openingControlOf(steps: string): string | null {
  const lines = steps
    .split('\n')
    .map((line) => line.replace(/^\s*\d{1,2}[.)]\s*/, '').trim())
    .filter((line) => line !== '')
    .slice(0, 3);
  for (const line of lines) {
    const quoted = /(?:กด(?:ปุ่ม)?|click|press|เลือก|select)\s*(?:the\s+)?(?:button\s+)?["“]([^"”\n]{1,40})["”]/iu.exec(line);
    const bare = /(?:กด(?:ปุ่ม)?|click|press)\s+(?:the\s+)?(?:button\s+)?(\+|[A-Z][A-Za-z0-9&/-]*(?:\s+[A-Z][A-Za-z0-9&/-]*){0,3}|ถัดไป|สร้าง[\p{L}\p{M}]*|เพิ่ม[\p{L}\p{M}]*)/iu.exec(line);
    const name = (quoted?.[1] ?? bare?.[1] ?? '').trim();
    if (name === '') continue;
    if (OPENING_NAME.test(name) && !NOT_AN_OPENING.test(name)) return name;
  }
  return null;
}

export function caseCard(row: TestCaseRow): string | undefined {
  const cut = (label: string, text: string, max: number): string | null => {
    const folded = text.replace(/\s+/g, ' ').trim();
    if (folded === '') return null;
    return `${label}: ${folded.length > max ? `${folded.slice(0, max)}…` : folded}`;
  };
  const lines = [
    // The qualified id is the case's identity (CG-04: `TM:PL_03_01`); the
    // sheet's own spelling rides beside it, since that is the id a tester
    // will look for in the workbook.
    cut('Case', `${row.caseId}${row.sheetCaseId === undefined ? '' : ` (sheet id ${row.sheetCaseId})`} ${row.testCase}`, 160),
    cut('Expected', row.expected, 420),
    // 420, not 120 (2026-08-28): the old cut ended PL_03_07's card mid-value
    // ("Benefit name = QA-Create Plan Benefit Type Reimbu…"), so every
    // runtime role reading the card — the judge, the agent, the diagnosis —
    // saw a truncated Test data and could only guess at the rest. The sheet's
    // Test data IS the values the flow must type; it is the one column that
    // must never be the thing cut.
    cut('Test data', row.testData, 420),
    // The fields the sheet has no value for yet (`UNCONFIRMED_VALUE`; ec09
    // HIR-EC-009's `= ? รอตารางโครงการ DVT`), named so every runtime role —
    // the agent, the judge, the diagnosis — reads "this field was never
    // keyed, by design" instead of hunting a value or blaming the app.
    (() => {
      const unconfirmed = unconfirmedTestData(row.testData);
      return unconfirmed.length === 0
        ? null
        : `Unconfirmed test data (no value yet — never typed, never asserted; their steps are skipped by design): ${unconfirmed
            .map((pair) => `${pair.key} = ${pair.value.replace(/\s+/g, ' ').slice(0, 60)}`)
            .join('; ')}`;
    })(),
    // A dated requirement change in the Note ("pop-up → page 4 Aug", "TBC
    // wording") is prepended as its own line, so the author reads "this is
    // now a page, not a dialog" BEFORE it writes role=dialog (S7). Four
    // be100 rows asserted a dialog the Note said had become a page.
    /^(?=.*\b(?:tbc|update|changed?|became|now|new req)\b)/i.test(row.note)
      ? `Requirement note (read before authoring — the sheet's later word outranks its steps): ${row.note.replace(/\s+/g, ' ').trim().slice(0, 200)}`
      : null,
    cut('Persona', row.persona, 80),
    cut('Note', row.note, 200),
  ].filter((line): line is string => line !== null);
  return lines.length === 0 ? undefined : lines.join('\n');
}

/**
 * Schedule facts for the section scheduler and the governor's db allowlist,
 * from the indexed graph: FK pairs (a section is a join family) and every
 * declared table name. Null graph → undefined, and the scheduler falls back
 * to unexpanded table sections with the governor's db tools refusing.
 */
export function graphFactsOf(
  graph: { nodes: readonly { kind: string; name: string }[]; edges: readonly { from: string; to: string; kind: string }[] } | null,
): { fkPairs: readonly (readonly [string, string])[]; tables: readonly string[] } | undefined {
  if (graph === null) return undefined;
  return {
    fkPairs: fkPairsFromGraph(graph),
    tables: graph.nodes.filter((n) => n.kind === 'table').map((n) => n.name),
  };
}

/**
 * Does this row's Expected output (or its Note / Test data) hold anything an
 * assertion can quote? Anchors, in the order sheets actually provide them: a
 * number, a `field = value` pair, a double-quoted span. Vague is none of the
 * three across all three columns — "increases correctly", "displays properly".
 */
export function expectedLacksAnchors(expected: string, note: string, testData: string): boolean {
  if (expected.trim() === '') return false; // nothing claimed — a different lint's problem
  const holds = (text: string): boolean =>
    /\d/.test(text) || /\S\s*=\s*\S/.test(text) || /"[^"]{2,}"/.test(text);
  return !holds(expected) && !holds(note) && !holds(testData);
}

async function authorEachRow(
  rows: readonly TestCaseRow[],
  author: FlowAuthor,
  options: CliOptions,
  context: {
    summary: string;
    context: readonly Awaited<ReturnType<typeof extractDocumentFile>>[];
    log: ((line: string) => void) | undefined;
    /** The saved repository's graph, for the per-row journey capture. */
    graph?: ProjectGraph | null | undefined;
    /**
     * Called the moment a row's case is complete, before the next row is
     * authored — the seam that lets a run start while authoring continues.
     * `first` is the pass's first authored flow, whose model and time stamp
     * every case of the pass (the group identity wowUI reads).
     */
    onCase?: ((testCase: TableCase, first: AuthoredFlow) => Promise<void>) | undefined;
    /**
     * Called when a row could not be written — a sheet gate, or authoring
     * refused on its last attempt — with the reason and how many refusals
     * this row now has. The seam that gets the refusal onto the ledger, so
     * the report says why and a resume does not re-author it forever.
     */
    onRefused?: ((row: TestCaseRow, reason: string, attempt: number) => Promise<void>) | undefined;
    /** Refusal counts from the prior ledger, by case id — what a resume authors leniently. */
    refusedBefore?: ReadonlyMap<string, number> | undefined;
    /**
     * Holds authoring to the scenario the runner is in (`ScenarioGate`).
     * Present only on the pipelined path — gating a run that starts after
     * the last row is authored would deadlock it by construction.
     */
    gate?: ScenarioGate | null | undefined;
    /**
     * The pre-run dead-end risk judge. Null = off, or the generator role does
     * not resolve; every case then runs the ordinary way.
     */
    risk?: RiskModel | null | undefined;
    /** The catalog run's key — its last six alphanumerics make a sheet's key values unique to this run (CG-13). */
    runKey?: string | undefined;
    /**
     * What "today" is for the relative dates a sheet writes (`Hire Date =
     * Today`, `+119 Day`) — decided once per invocation, `WOWLIDATOR_NOW`
     * overriding the clock, so every row of a pass resolves against the same
     * day and a test can pin it.
     */
    now?: Date | undefined;
  },
): Promise<{ first: AuthoredFlow; cases: TableCase[] }> {
  // Kept by sheet position, compacted at the end: rows authored side by side
  // finish in any order, and the list handed back must still read as the
  // sheet. (`onCase` fires in completion order — that is the point of it.)
  const slots: (TableCase | undefined)[] = new Array(rows.length).fill(undefined);
  let first: AuthoredFlow | undefined;
  const refused: string[] = [];
  // Rows already re-authored once against the risk judge (S6) — once per row.
  const riskRetried = new Set<string>();
  const workers = authorWorkers(options.authorConcurrency, options.config.roles.generator.provider);
  // N authoring workers = up to N concurrent generator calls (plus a risk
  // judge). The warm claude pool must fit them, or worker N+1 falls to a
  // cold one-shot at full price — the run-pool already does this for lanes.
  raiseSessionCapFor(workers);
  // Authoring spends the same session window the lanes do — arm the hold
  // here too, because on the pipelined path the first row is authored before
  // the run loop exists. Idempotent with the runner's own call.
  ensureQuotaHold(options.config, (line) => process.stderr.write(`${line}\n`));
  if (workers === 1 && options.authorConcurrency === undefined && rows.length > 1) {
    context.log?.(
      `authoring rows one at a time: the generator role is on ${options.config.roles.generator.provider}, ` +
      'which answers one call at a time (pass --author-concurrency to override)',
    );
  }
  // Rows authored beside each other interleave their narration; the case id
  // in front is what keeps a line readable. The tag rides the async context
  // (`withLogTag`, applied where the pool dispatches the row) so it reaches
  // the author's lints, the reviewer, the value resolver and the `[llm]`
  // lines too — not only the lines this file writes. A line that already
  // names its row (`  HIR-EC-001: persona …`) is not made to say it twice.
  // A sequential run's output is exactly what it was.
  const rowTag = (row: TestCaseRow): string | undefined => (workers > 1 && context.log ? `[${row.caseId}]` : undefined);
  const rowLog = (row: TestCaseRow): ((line: string) => void) | undefined => {
    const log = context.log;
    if (rowTag(row) === undefined || log === undefined) return log;
    const own = new RegExp(`^(\\s*)${row.caseId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `);
    return (line) => log(line.replace(own, '$1'));
  };

  const authorRow = async (sheetRow: TestCaseRow, index: number, page?: Page): Promise<void> => {
    const log = rowLog(sheetRow);
    // Where this row's authoring begins — the one line to search for.
    log?.(phaseHeader(`authoring ${sheetRow.caseId}`));
    const scenarioKey = sheetRow.scenarioId || 'ungrouped';
    // **The Note and Actual columns are a gate, not a footnote** (S7 of the
    // 2026-08-28 audit). A row the sheet records as Cancelled is a feature
    // the requirement dropped — four be100 rows were authored, run, and
    // failed against filters removed on 6 Jul. It never reaches a model.
    // Since CG-01 the same gate holds Blocked / Pending rows (with their bug
    // ticket) unless --include-blocked, and since CG-12 a row that needs a
    // case this catalog does not hold.
    const gate = sheetGate(sheetRow, {
      includeBlocked: options.includeBlocked,
      registry: context.context.map((doc) => doc.text),
    });
    if (gate !== null) {
      context.gate?.authored(scenarioKey);
      refused.push(`${sheetRow.caseId}: ${gate}`);
      log?.(`  ${sheetRow.caseId}: skipped — ${gate}`);
      // A gated row is final: recorded at the cap so a resume does not keep
      // listing it among the cases "left".
      await context.onRefused?.(sheetRow, gate, AUTHORING_REFUSAL_CAP);
      return;
    }
    // **Every persona the row names must have credentials** (CG-05). One
    // persona, or the first of several, may be the `--as` account; a second
    // one may not — one session cannot be two people, and a label nobody
    // supplied is exactly the guessed password this ends. Refused before a
    // model is spent, with the flag that fixes it.
    const personaLabels = personasOf(sheetRow);
    const resolved = resolveRowPersonas(personaLabels, options);
    if (resolved.missing.length > 0) {
      const reason = `persona ${resolved.missing.join(', ')} has no credentials (pass --persona ${resolved.missing[0]}=email:password, or WOWLIDATOR_PERSONAS)`;
      context.gate?.authored(scenarioKey);
      refused.push(`${sheetRow.caseId}: ${reason}`);
      log?.(`  ${sheetRow.caseId}: skipped — ${reason}`);
      await context.onRefused?.(sheetRow, reason, AUTHORING_REFUSAL_CAP);
      return;
    }
    if (personaLabels.length > 0) {
      log?.(
        `  ${sheetRow.caseId}: persona${personaLabels.length > 1 ? 's' : ''} ` +
        personaLabels.map((label) => `${personaLabelOf(label)} → ${resolved.personas[personaLabelOf(label)]?.email ?? '?'}`).join(', ') +
        (resolved.fellBack === null ? '' : ` (${resolved.fellBack} is the --as account; pass --persona ${resolved.fellBack}=… to name it)`),
      );
    }
    // **The sheet's key values are made unique to this run before anything
    // reads the row** (CG-13): `Benefit Plan ID = PL_06_21` becomes
    // `PL_06_21_<run suffix>` in Test data, Steps and Expected at once, so the
    // typed value and the asserted value are the same literal, and a rerun
    // never meets "already exists" about its own earlier run.
    const keyed = substituteUniqueKeys(sheetRow, context.runKey);
    const row = keyed.row;
    if (keyed.substitutions.length > 0) {
      log?.(
        `  ${row.caseId}: unique per run — ` +
        keyed.substitutions.map((sub) => `${sub.key}: ${sub.from} → ${sub.to}`).join(', '),
      );
    }
    const refusedBefore = context.refusedBefore?.get(row.caseId) ?? 0;
    const lenientGrounding = refusedBefore > 0;
    if (lenientGrounding) {
      log?.(`  ${row.caseId}: refused ${refusedBefore}× before — authoring with the tree-grounding lint relaxed; the run decides`);
    }
    if (context.gate) {
      // Author no further than the scenario the runner is in: a row of a
      // later scenario waits here until every earlier scenario's cases have
      // finished running. Workers take rows in sheet order, so blocking the
      // next row blocks the pool — which is the point.
      await context.gate.waitFor(scenarioKey, () => pauseRequested());
      if (pauseRequested()) return;
    }
    // The account's session window is nearly spent: a row authored now would
    // be refused mid-answer and recorded as never ran. Wait for the window.
    await awaitQuotaRelease(() => pauseRequested());
    if (pauseRequested()) return;
    // Per row, not once for the loop. Every row is authored in its own call
    // against the same open page, so whole context documents were multiplied
    // by the row count — a twelve-row sheet with one 120,000-character spec
    // spent roughly 360k input tokens on background, eleven-twelfths of it
    // about rows this call is not writing. The row's own steps and
    // expectations are the strongest query available anywhere in the system.
    // The row's own words, with each persona token spelled as the account it
    // resolved to (email only) — the author reads which person, the flow
    // keeps the label for its signIn step.
    const described = describeWithPersonas(describeCase(row), resolved.personas);
    // A row that CITES another source for its expected value ("as per the
    // Master Benefit List", "ตามเอกสาร Requirement") is the row whose own
    // words are the weakest query for that value — the value lives in the
    // cited document, and the citation is a few tokens drowned in step
    // narration. The cited phrases are boosted in the retrieval query
    // (repeated — term frequency is the lever BM25 actually has), so the
    // section holding the real value outranks sections that merely share the
    // row's step vocabulary, and the prompt below can demand the value be
    // quoted from it rather than invented.
    const cited = referencedSources(`${row.testCase}\n${described}`);
    // The sheet's own "no value yet" marks, said once per row in the log so
    // the reader knows before the run which steps will be skipped by design.
    const unconfirmed = unconfirmedTestData(row.testData);
    if (unconfirmed.length > 0) {
      log?.(
        `  ${row.caseId}: ${unconfirmed.length} unconfirmed test-data value(s) — ` +
          unconfirmed.map((pair) => `${pair.key} = ${pair.value.replace(/\s+/g, ' ').slice(0, 50)}`).join('; ') +
          ' — never typed, never asserted, never handed to the agent; their steps are skipped with the reason',
      );
    }
    // **Is the Expected output contextual enough to assert?** An expected
    // result with no concrete anchor — no value, no "field = value" pair, no
    // quoted label, no number in it or in the Note — leaves the author
    // nothing to quote, and an author with nothing to quote invents
    // (2026-08-28, asked for after PL_03_07). The check is $0; when it trips,
    // the expected text itself is boosted in the retrieval query (the same
    // term-frequency lever the citation boost uses) so the documents most
    // likely to hold the missing values are the ones retrieved, and the row's
    // description tells the author in one line where its anchors must come
    // from.
    const vague = expectedLacksAnchors(row.expected, row.note, row.testData);
    const describedForPrompt = vague
      ? `${described}\nExpected-result context: the Expected output above names no concrete value — take every asserted value from the Test data, the Note, the documents or the repository sections of this prompt, and never invent one.`
      : described;
    const retrievalQuery =
      cited.length === 0
        ? `${vague ? `${row.expected}\n${row.expected}\n` : ''}${row.testCase}\n${described}`
        : `${cited.join('\n')}\n${cited.join('\n')}\n${vague ? `${row.expected}\n` : ''}${row.testCase}\n${described}`;
    if (cited.length > 0) {
      log?.(`  ${row.caseId}: the case cites ${cited.join('; ')} — retrieving it from the background and the repository`);
    }
    if (vague) {
      log?.(`  ${row.caseId}: the expected output names no concrete value — retrieving context so assertions quote the documents/repository, not an invention`);
    }
    const selected = selectRelevantContext(context.context, retrievalQuery, {
      budgetChars: options.contextBudget,
      onWarn: (line) => process.stderr.write(`  ! ${line}\n`),
    });
    // One line per row in the narration, not a stdout note each: twelve
    // disclosure lines about background would bury the twelve about the cases.
    if (selected.retrieved) log?.(`  ${row.caseId}: ${selected.note}`);
    const prompt = buildAuthoringPrompt(
      [
        {
          claim: row.testCase,
          priority: row.priority || 'medium',
          source: row.caseId,
          testable: true,
        },
      ],
      { summary: context.summary, context: selected.documents, cases: [describedForPrompt] },
    );
    log?.(`writing ${row.caseId}: ${row.testCase}…`);
    // **Each row's journey ends on its own page, so each row gets its own
    // destination capture.** The journey capture used to exist only on the
    // `wow go "text"` path; a catalog of end-to-end rows was authored from the
    // sign-in page's tree alone, and every leg past it went to a `workflow`
    // step — measured, 228 of 416 step-seconds in one run, most of them
    // failing. Ranked against the row's own words (its steps and expected
    // output are the best query for "which route is this row about"), read
    // in a second tab so `page` stays the start page.
    const journeyTree =
      page === undefined
        ? undefined
        : await captureJourneyTree(page, options, context.graph ?? null, described, log, {
          // The Menu column is the sheet saying where the row goes, in the
          // application's own labels — as breadcrumbs first (CG-11), then
          // the cell, the title and the steps.
          where: [menuPathOf(row).join(' > '), row.menu, row.testCase, row.steps].filter((t) => t !== '').join('\n'),
          // A literal destination the row states outranks every ranking:
          // the PY rows put their URL in Steps, not in Menu, and 233 rows
          // pick a tab on arrival.
          destination: destinationOf(row),
          // The capture signs in as the row's own first persona (CG-05):
          // an HRBP row read through the admin's session sees the admin's
          // page, and the author grounds every selector in the wrong one.
          credentials: resolved.first,
          // The row's first opening click (CG-18, reduced): the fields of
          // ~400 rows live behind "Create Plan" / "Add" / "ถัดไป", and a
          // tree read before that click shows none of them.
          opening: openingControlOf(row.steps),
          // **Not behind a flag on this path.** A sheet row names a
          // destination that is almost never the start url, and authoring it
          // from the sign-in tree alone is the failure this capture exists
          // for: measured on PL_07, 10 of 10 rows had every Benefit Plan
          // Catalog selector refused as "appears in no captured tree", 5 of
          // them fatally. `--capture-journey` stays the opt-in for the
          // single-page paths, where the start url usually IS the subject.
          force: true,
        });
    // The repository slice ranked against THIS row's words — the shared
    // author-wide section describes the whole project; the routes that decide
    // this row's expectUrl and workflow destination are the row's own. The
    // cited phrases ride along for the same reason they boost the document
    // query: a row deferring to "the master list" may be naming a table or
    // component the graph declares.
    const rowProjectContext = repoPromptSection(
      context.graph ?? null,
      options.url,
      log,
      cited.length === 0 ? described : `${described}\n${cited.join('\n')}`,
    );
    try {
      // What the value resolver reads beside the case text (CG-02 / CG-05 /
      // CG-06): the Test data already split one pair per line by the parser,
      // the row's id, the pass's "today", and the persona map. NOT the run
      // key: the sheet's key values were already made unique above, in every
      // column at once, and the resolver's own `fromUniquePerRun` would put a
      // second tail on a `QA-…` name it cannot tell from a fresh one — one
      // source of the suffix, so the typed value and the assertion agree.
      const rowFacts = {
        testDataPairs: testDataPairs(row.testData),
        caseId: row.caseId,
        ...(context.now === undefined ? {} : { now: context.now }),
        ...(Object.keys(resolved.personas).length === 0 ? {} : { personas: resolved.personas }),
      };
      const one = await author.author(prompt, page, {
        journeyTree,
        lenientGrounding,
        // The ROW, not the prompt: the prompt also carries the retrieved
        // requirement documents, and a Thai spec says `ข้อความ` on every other
        // page — enough to classify every row as a wording claim and refuse
        // its assertions (ec10, 2026-09-02).
        caseText: described,
        ...(rowProjectContext === '' ? {} : { projectContext: rowProjectContext }),
        ...rowFacts,
      });
      first ??= one;
      // The sheet's own Positive/Negative column is the author's word on what
      // this row means to prove; it travels in the flow file so every run of
      // it — including re-runs and repairs — reports the same reading. A
      // blank cell stays blank and `runFlow` infers deterministically.
      const polarity = statedPolarity(row.polarity);
      // The card the runtime roles read (`Flow.caseContext`): the claim in
      // the sheet's own words, so a heal or an agent turn knows what the step
      // is proving — not only which selector broke. Bounded, and in the file
      // so re-runs and repairs keep it, the `authoredBy` rule.
      const card = caseCard(row);
      // The sheet's recorded Actual Result, when it holds one: the ground
      // truth accuracy compares this case's verdict against. Travels on the
      // provenance stamp, like scenario and caseTitle — a fact about the
      // sheet row, not about any one run.
      // `sheetVerdict`, not `recordedResult` (CG-01): a Test Status of
      // Blocked reaches the truth table as its own class. Only passed/failed
      // are a ground truth the risk judge and the provenance may read.
      const knownResult = sheetVerdict(row.actual);
      const humanVerdict = knownResult === 'passed' || knownResult === 'failed' ? knownResult : undefined;
      // A row whose every Expected line is record-only (CG-09) captures and
      // never asserts; the run ends it `review` with the captures rather
      // than scoring a flow that could not fail.
      const recordOnly = observeOnlyCase(row);
      const testCase: TableCase = {
        name: `${row.caseId} ${row.testCase}`,
        flow: {
          ...one.flow,
          name: `${row.caseId} ${row.testCase}`,
          ...(polarity === undefined ? {} : { polarity }),
          ...(card === undefined ? {} : { caseContext: card }),
        },
        scenarioId: row.scenarioId || 'ungrouped',
        scenario: `${row.scenarioId} ${row.scenario}`.trim() || 'ungrouped',
        caseTitle: row.testCase,
        ...(knownResult === undefined ? {} : { knownResult }),
        ...(recordOnly ? { recordOnly: true } : {}),
        ...(row.dependsOn === undefined || row.dependsOn.length === 0 ? {} : { dependsOn: [...row.dependsOn] }),
        ...(Object.keys(resolved.personas).length === 0 ? {} : { personas: resolved.personas }),
      };
      if (recordOnly) log?.(`  ${row.caseId}: every Expected line is record-only — the run will capture and end for review, never pass`);
      // Judged on the evidence the author just read — the ranked documents,
      // the repository slice, the declared routes — before a browser is spent.
      // A case above the threshold runs once with every retry path off.
      if (context.risk) {
        const risk = await assessDeadEndRisk(
          {
            caseName: testCase.name,
            caseText: `${row.testCase}\n${described}`,
            flow: testCase.flow,
            documents: selected.documents.map((d) => ({ name: d.name, text: d.text })),
            repository: rowProjectContext,
            declaredRoutes: declaredPageRoutes(context.graph ?? null),
            deploymentUrl: options.url,
            backend: options.backend,
            // The sheet's own Actual Result: a row the tester already saw
            // fail is the strongest expected-fail evidence there is.
            ...(humanVerdict === undefined ? {} : { knownResult: humanVerdict }),
          },
          { model: context.risk, log: (line) => process.stderr.write(`${line}\n`) },
        );
        if (risk) {
          testCase.risk = risk;
          log?.(`  ${row.caseId}: ${describeRisk(risk)}`);
          // **The judge's evidence feeds the author, once** (S6). A fail-fast
          // verdict with concrete reasons is re-asked immediately with those
          // reasons as feedback; the better flow wins. be100: "the search
          // box starts disabled" (0.78), "no Start-date filter exists"
          // (0.88) — each right, each spent on a full dead-ended run.
          // Only the DEAD-END dimension is worth a re-ask: a flow can be
          // rewritten around a control that does not exist, but not around a
          // sheet that already says the case fails — an expected-fail verdict
          // is a fact about the application, and re-authoring cannot author
          // it away. Measured live (2026-09-05): 29 of 59 risk re-asks were
          // expected-fail, each a full authoring call that changed nothing.
          const deadEndTripped = risk.likelihood > risk.threshold;
          if (risk.verdict === 'fail-fast' && deadEndTripped && risk.reasons.length > 0 && !riskRetried.has(row.caseId)) {
            riskRetried.add(row.caseId);
            log?.(`  ${row.caseId}: re-authoring once against the risk judge's ${risk.reasons.length} reason(s)…`);
            try {
              const again = await author.author(prompt, page, {
                journeyTree,
                lenientGrounding,
                caseText: described,
                ...(rowProjectContext === '' ? {} : { projectContext: rowProjectContext }),
                ...rowFacts,
                priorFeedback: risk.reasons.map((r) => `the pre-run risk judge found: ${r}`),
              });
              const riskAgain = await assessDeadEndRisk(
                {
                  caseName: testCase.name, caseText: `${row.testCase}\n${described}`, flow: again.flow,
                  documents: selected.documents.map((d) => ({ name: d.name, text: d.text })), repository: rowProjectContext,
                  declaredRoutes: declaredPageRoutes(context.graph ?? null), backend: options.backend,
                  deploymentUrl: options.url,
                  ...(humanVerdict === undefined ? {} : { knownResult: humanVerdict })
                },
                { model: context.risk, log: (line) => process.stderr.write(`${line}\n`) },
              );
              // Only a genuinely better flow replaces the first — feedback must never make the
              // result worse. "Better" used to mean only "scores a lower dead-end/fail
              // likelihood," and that is gameable: a flow that asserts nothing about the
              // claim cannot dead-end on it either, so it always looks safer than a flow that
              // tried. Measured live (HIR-EC-006/HIR-EC-010, 2026-09-02): the risk judge's own
              // reasons named steps 8 and 11-12 of a first draft that reached the hire wizard;
              // the re-ask, avoiding whatever it was told was risky, came back with four steps
              // that never leave the sign-in page — 0% risk, and 0% proof. `substantiveAssertions`
              // (`generator/vacuous.ts`, the SAME predicate the fatal vacuous-claim lint uses) is
              // the second gate: the swap also requires the re-authored flow to assert AT LEAST
              // as much about the claim as the first did, not merely score better on risk alone.
              const firstProof = substantiveAssertions([...(testCase.flow.setup ?? []), ...testCase.flow.steps]).length;
              const againProof = riskAgain
                ? substantiveAssertions([...(again.flow.setup ?? []), ...again.flow.steps]).length
                : 0;
              if (riskAgain && riskAgain.likelihood < risk.likelihood && againProof >= firstProof) {
                testCase.flow = { ...again.flow, name: testCase.flow.name, ...(testCase.flow.polarity === undefined ? {} : { polarity: testCase.flow.polarity }), ...(card === undefined ? {} : { caseContext: card }) };
                testCase.risk = riskAgain;
                log?.(`  ${row.caseId}: re-authored — ${describeRisk(riskAgain)}`);
              } else if (riskAgain && riskAgain.likelihood < risk.likelihood) {
                log?.(
                  `  ${row.caseId}: the re-authored flow scored lower risk (${riskAgain.likelihood}% vs ` +
                  `${risk.likelihood}%) but proves less of the claim (${againProof} vs ${firstProof} ` +
                  'substantive assertion(s)) — keeping the first; a flow that asserts nothing cannot ' +
                  'dead-end, which is not the same as succeeding',
                );
              } else {
                log?.(`  ${row.caseId}: the re-authored flow was no better; keeping the first`);
              }
            } catch (error) {
              log?.(`  ${row.caseId}: re-authoring against the risk reasons failed — keeping the first (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`);
            }
          }
        }
      }
      slots[index] = testCase;
      await context.onCase?.(testCase, first);
      context.gate?.authored(scenarioKey);
    } catch (error) {
      // A model that could not answer — the re-ask budget spent, or a
      // circuit already open — blocks THIS row with the reason and the run
      // goes on (2026-08-28). It used to escape as a fatal: on be100 an open
      // breaker thrown from one row's authoring review aborted the pass
      // with 100 cases never reached. A dead role now costs each remaining
      // row a millisecond and an honest "never ran: …" line, not the suite.
      if (!(error instanceof AuthoringError) && !(error instanceof StructuredOutputUnavailableError)) throw error;
      // A refused row still advances the gate: a scenario that authors
      // nothing must clear, or every scenario after it waits forever.
      context.gate?.authored(scenarioKey);
      // The WHOLE refusal, one bullet per lint. The first line alone reads
      // "2 problems with the authored flow — fix all of them" and names none
      // of them (ec10_2x HIR-EC-012/023, 2026-09-02: the ledger, the report and
      // stderr all carried that line and nothing a person could act on).
      const reason = refusalText(error);
      refused.push(`${row.caseId}: ${reason}`);
      process.stderr.write(`  ! ${row.caseId} could not be written — ${reason}\n`);
      await context.onRefused?.(row, reason, refusedBefore + 1);
    }
  };

  // **Rows are authored in a pool, one start tab per worker.** Authoring a
  // row is mostly waiting on a model, and twelve rows waited one after the
  // other — measured at roughly a minute each. A worker owns its tab because
  // the probe and the capture pilot act on the start page (the AX read alone
  // would be safe to share); the per-row journey capture was already in a
  // fresh context of its own. Starts stay in sheet order, so the first case
  // queued is usually the first row of the sheet.
  const tabs = Math.min(workers, rows.length);
  if (options.url) {
    await withPages(options.cdp, tabs, async (pages) => {
      context.log?.(`opening ${options.url}${tabs > 1 ? ` in ${tabs} tabs` : ''}…`);
      for (const page of pages) {
        await page.goto(options.url as string, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      }
      if (tabs > 1) context.log?.(`authoring ${rows.length} row(s), up to ${tabs} at a time`);
      await mapPool(
        rows,
        tabs,
        (row, index, slot) => withLogTag(rowTag(row), () => authorRow(row, index, pages[slot]!)),
        () => pauseRequested(),
      );
    });
  } else {
    await mapPool(rows, tabs, (row, index) => withLogTag(rowTag(row), () => authorRow(row, index)), () => pauseRequested());
  }
  const cases = slots.filter((c): c is TableCase => c !== undefined);

  if (first === undefined) {
    throw new AuthoringError(
      `none of the ${rows.length} case(s) could be written:\n  ${refused.join('\n  ')}`,
    );
  }
  // Never silent: a sheet of twelve that produced ten tasks must say so, or the
  // two that vanished look like rows nobody wrote.
  if (refused.length > 0) {
    process.stdout.write(
      `  ! ${refused.length} of ${rows.length} row(s) could not be turned into a test\n`,
    );
  }
  return { first, cases };
}

/**
 * Declared tables from the cached context graph, for the authoring prompt's
 * inventory section. Read-only (`load`, never `build`): indexing the schema is
 * `wowlidator context build --db-schema …`'s job, and authoring silently gaining a
 * project walk would be a surprise. Empty when no schema was ever indexed —
 * and with no inventory the author cannot emit a DB step at all.
 */
/** Tables sent to the author before relevance decides which ones matter. */
export const TABLE_INVENTORY_MAX = 40;

/** A table must score this much of the best table's score to be listed. */
const TABLE_SCORE_FLOOR = 0.35;

async function tableInventory(
  graph?: ProjectGraph | null,
  description?: string | undefined,
  log?: ((line: string) => void) | undefined,
  /**
   * Tables the sheet's Expected column names as its oracle (CG-17:
   * `DB : time_management.leave_requests`, `table employee_center.
   * probation_transactions column …`) — 29 rows. Checked against the
   * introspected inventory and, when declared, listed AHEAD of the relevance
   * picks and exempt from the API-route gate: a row that names the table is
   * evidence the feature reaches it, whatever the routes say. An unknown name
   * is logged, never invented into the inventory.
   */
  named: readonly string[] = [],
): Promise<{ name: string; summary: string }[]> {
  try {
    // A selected repo's graph outranks the default cache: its tables are the
    // application actually being tested, not whatever was indexed last.
    const source = graph ?? (await new ContextEngine({ warn: false }).load());
    if (!source) return [];
    const all = source.nodes
      .filter((node) => node.kind === 'table')
      .map((node) => ({ name: node.name, summary: node.meta?.['columns'] ?? '' }));
    const declared = new Map(all.map((table) => [table.name.toLowerCase(), table]));
    const namedKnown: { name: string; summary: string }[] = [];
    const namedUnknown: string[] = [];
    for (const name of new Set(named.map((n) => n.toLowerCase()))) {
      // `schema.table` as declared, else the bare table name under any schema.
      const hit = declared.get(name) ?? all.find((table) => table.name.toLowerCase().endsWith(`.${name}`) || table.name.toLowerCase() === name.split('.').pop());
      if (hit === undefined) namedUnknown.push(name);
      else if (!namedKnown.includes(hit)) namedKnown.push(hit);
    }
    if (namedUnknown.length > 0) {
      log?.(`schema: the sheet names ${namedUnknown.join(', ')} but the indexed schema declares no such table — not offered`);
    }
    if (namedKnown.length > 0) {
      log?.(`schema: ${namedKnown.length} table(s) the sheet names as its oracle are offered first: ${namedKnown.map((t) => t.name).join(', ')}`);
    }
    const withNamed = (picked: { name: string; summary: string }[]): { name: string; summary: string }[] => [
      ...namedKnown,
      ...picked.filter((table) => !namedKnown.includes(table)),
    ];

    // THE PERMISSION TO CLAIM THE DATABASE IS EVIDENCE THAT THE FEATURE HAS AN
    // API. A schema indexed from a .sql file says the tables exist; it says
    // nothing about whether the screen under test ever reaches them. Measured:
    // an application with 386 indexed tables whose overtime and leave screens
    // are Zustand stores persisted to localStorage — every DB assertion the
    // author wrote against them fails on every run of a feature working
    // exactly as built, and files it against the backend.
    //
    // So the offer is gated on the repository declaring an API route this test
    // plausibly touches. `toFlowStep` already drops a DB step when no
    // inventory came with the request, which makes this structural rather than
    // a sentence in a prompt — the MutationPolicy move.
    //
    // The gate only engages when the repo declares API routes AT ALL. With
    // none, "this app has no backend" and "the backend lives in another
    // repository" are the same picture, and refusing on that would silently
    // remove DB testing from every split-repo project. Understate, never
    // overstate — the same rule attribution follows everywhere else.
    const apiRoutes = source.nodes.filter(
      (node) => node.kind === 'route' && node.meta?.['type'] === 'api',
    );
    if (apiRoutes.length > 0 && description !== undefined && description.trim() !== '') {
      const apiScores = bm25(
        apiRoutes.map((route) => `${route.name} ${route.file ?? ''}`),
        description,
      );
      if (Math.max(0, ...apiScores) <= 0) {
        log?.(
          `schema: ${all.length} table(s) indexed, but none of the ${apiRoutes.length} API route(s) ` +
          'this repository declares matches what is being tested — DB checks are not offered' +
          (namedKnown.length > 0 ? ' beyond the tables the sheet itself names. ' : '. ') +
          'A database claim needs evidence the feature reaches a backend; a screen that keeps ' +
          'its state in the browser would fail one on every run.',
        );
        return namedKnown;
      }
    }

    // The inventory is the largest thing in an authoring prompt by an order of
    // magnitude — measured on a real run, 386 tables with every column came to
    // 50,310 of the call's 56,237 input tokens, 89% of it, against 63 tokens of
    // what the person actually asked for. Cost is only half the reason to
    // narrow it: the same dump offered four near-identical candidates
    // (ot_request, ot_request_detail, ot_request_decision,
    // ot_request_attachment) for one journey, and which one comes back is
    // exactly the kind of coin-flip that makes two runs of one prompt disagree.
    if (description === undefined || description.trim() === '' || all.length <= TABLE_INVENTORY_MAX) {
      return withNamed(all);
    }
    const scores = bm25(all.map((table) => `${table.name} ${table.summary}`), description);
    const best = Math.max(0, ...scores);
    // Nothing matched: the description names no table this schema has. Keeping
    // the whole inventory is the honest answer — narrowing to an arbitrary
    // forty would silently remove the ability to author a DB check at all,
    // and presence of the inventory IS the permission.
    if (best <= 0) return withNamed(all);
    const kept = all
      .map((table, i) => ({ table, score: scores[i] ?? 0 }))
      .filter((entry) => entry.score >= best * TABLE_SCORE_FLOOR)
      .sort((a, b) => b.score - a.score || a.table.name.localeCompare(b.table.name))
      .slice(0, TABLE_INVENTORY_MAX)
      .map((entry) => entry.table);
    log?.(
      `schema: ${kept.length} of ${all.length} table(s) match this test — the rest are not ` +
      'offered, so a DB check can only be written against these',
    );
    return withNamed(kept);
  } catch {
    return [];
  }
}

/**
 * The saved repository this run is grounded in, when `--repo` names one.
 * Selection is explicit, so an unknown value throws (callers turn it into
 * exit 2) rather than silently skipping — a run that looks grounded while
 * grounding nothing is the failure mode this feature must not have. The graph
 * goes through `ContextEngine.build()`, whose signature check is the
 * staleness handling: unchanged repo → cached graph, changed repo →
 * transparent re-scan. The scan's openapi/db-schema inputs are carried from
 * the registry so a re-scan never silently drops endpoint or table nodes.
 */
/**
 * The PAGE routes a graph declares — api handlers excluded, because a
 * navigation is not a request and an endpoint is not a page a flow can visit.
 * One definition, so authoring and the runtime 404 check cannot disagree
 * about what the application says it serves.
 */
function declaredPageRoutes(graph: ProjectGraph | null): readonly string[] {
  return (graph?.nodes ?? [])
    .filter((node) => node.kind === 'route' && node.meta?.['type'] !== 'api')
    .map((node) => node.name);
}

async function loadRepoGraph(
  options: CliOptions,
  log?: ((line: string) => void) | undefined,
): Promise<ProjectGraph | null> {
  if (!options.repo) return null;
  const entry = await resolveRepo(options.repo);
  if (!entry) {
    throw new Error(
      `unknown repository "${options.repo}" — see saved ones with: wowlidator context list`,
    );
  }
  const engine = new ContextEngine({
    rootDir: entry.path,
    cacheFile: graphFileFor(entry.slug),
    openApiSpec: entry.openapi,
    dbSchema: entry.dbSchema,
    dbUrl: process.env['WOWLIDATOR_DB_URL'],
    dbRemoteOk: process.env['WOWLIDATOR_DB_REMOTE_OK'] === '1',
  });
  try {
    const graph = await engine.build();
    log?.(`repository context: ${entry.slug} (${graph.nodes.length} node(s))`);
    return graph;
  } catch (error) {
    // Degrade to the saved graph rather than failing the run: grounding is
    // insight, and a repo that cannot be re-scanned right now (moved, mid-
    // rebase, permissions) still has the graph the last scan produced. The
    // staleness is dated out loud — a silent stale graph would be worse than
    // none — and only a repo with no saved graph at all stays a hard error.
    const stale = await engine.load().catch(() => null);
    if (!stale) throw error;
    log?.(
      `repository ${entry.slug} could not be re-scanned (${(error as Error).message}) — ` +
      `using the graph saved ${entry.indexedAt} (${stale.nodes.length} node(s)); it may lag the code`,
    );
    return stale;
  }
}

/**
 * The repo's route-centred prompt section, with the empty case disclosed:
 * the walk starts at the route matching `url` **and at the routes the
 * description names**, so no url and no description (or nothing matching
 * either) means no section — silence there would read as "the repo declares
 * nothing" when the truth is "nothing was looked up".
 *
 * `description` is what makes this useful on the describe path. A journey
 * starts on one page and is about another: seeded from the start URL alone,
 * "log in, then create an overtime request" produced two lines about the login
 * screen out of a graph that held 71 nodes describing overtime — measured on
 * the saved `cnext-hrms-fortest` index, from a real `go` invocation.
 */
function repoPromptSection(
  graph: ProjectGraph | null,
  url: string | undefined,
  log?: ((line: string) => void) | undefined,
  description?: string | undefined,
): string {
  if (!graph) return '';
  const query = description?.trim() ?? '';
  const section =
    url !== undefined || query !== ''
      ? toPromptContext(graph, {
        ...(url === undefined ? {} : { url }),
        ...(query === '' ? {} : { query }),
      })
      : '';
  // `toPromptContext` reports a no-match as a sentence, not an empty string —
  // splicing that sentence in as "what the repository declares" would hand
  // the model a section that declares nothing. Both empty cases are logged,
  // never silent, and neither produces a section.
  if (section === '' || section.startsWith('Project context: no indexed route matches')) {
    log?.(
      url === undefined
        ? 'repository context: no url to look up a route for — authoring proceeds without the code section'
        : `repository context: no indexed route matches ${url} — authoring proceeds without the code section`,
    );
    return '';
  }
  return section;
}

/**
 * The accessibility tree of a page the description names, as a labelled
 * section — or nothing, with the reason logged.
 *
 * The ceiling this lifts: the tree authoring reads is the page the run STARTS
 * on, and for "log in, then create an overtime request" that is the login
 * screen. The journey's real controls are then invisible by construction, and
 * 9 of 9 measured authoring runs handed the middle of the test to a `workflow`
 * step — one of them saying so in its own notes ("Subsequent pages beyond
 * login are handled via workflow as they are absent from the initial login
 * accessibility tree").
 *
 * Every bound here is deliberate:
 *
 * - **One page, one navigation, no clicks.** This is a read, not an
 *   exploration; `--probe` and the capture pilot own the interacting.
 * - **A second tab, not the run's page.** The tree authoring grounds its
 *   selectors in must stay the start page's. Navigating the run's own page and
 *   coming back would silently swap it if the return failed; a tab in the same
 *   context shares the session and cannot.
 * - **Nothing is invented.** `concreteRouteUrl` refuses any pattern whose
 *   parameters this run cannot ground, and the refusal is logged rather than
 *   filled in.
 * - **A capture that bounced to a sign-in page is discarded.** With no session
 *   the destination redirects, and handing the model the login screen under
 *   the destination's name is worse than handing it nothing — it is exactly
 *   the mislabelling that a separate `journeyTree` field exists to prevent,
 *   arriving through the back door.
 * - **It never throws.** A failure here degrades to the capture authoring
 *   always did, the capture-pilot containment rule.
 */
/**
 * Fields a sign-in form needs, decided structurally rather than by name.
 *
 * `input[type="password"]` is a fact about the document, not a guess about
 * wording — which is what makes it safe to act on unsupervised. The identity
 * field is then whatever visible text-ish input shares the password's form,
 * and the submit control is only ever one that DECLARES itself
 * (`[type="submit"]`): an undeclared `<button>` inside a login form is as
 * likely to be "Sign in with Microsoft" as the submit, and clicking the wrong
 * one navigates someone's browser to an identity provider.
 */
const CONSENT_URL_PATTERN = /\/(consent|pdpa|terms|agreement)(\/|$|\?)/i;

/** Why a journey capture gave up, so the wording can be tested without a browser. */
export type JourneyCaptureGiveUp =
  | { kind: 'no-session'; target: string; landed: string }
  | { kind: 'no-form-field'; missing: string }
  | { kind: 'sign-in-refused'; email: string; landed: string };

/**
 * The line a person reads when the capture gives up. Pure on purpose: this is
 * a feature that acts on someone's application, and the account of what it did
 * — or declined to do — is part of the feature rather than a log detail.
 */
export function journeyCaptureNote(reason: JourneyCaptureGiveUp): string {
  switch (reason.kind) {
    case 'no-session':
      return (
        `${reason.target} redirected to ${reason.landed} — this run has no session yet, so the ` +
        'capture would be the sign-in page under another name. Pass --as <email>:<password> to ' +
        'sign in for the capture. Discarded.'
      );
    case 'no-form-field':
      return (
        `the sign-in page has ${reason.missing}, so nothing was clicked and the capture is ` +
        'discarded. Acting on a form this could not read would be a click on your application ' +
        'that nobody asked for.'
      );
    case 'sign-in-refused':
      return (
        `signed in as ${reason.email}, but the page is still ${reason.landed} — the credentials ` +
        'were refused, or the form needs a field this does not fill. Discarded.'
      );
  }
}

/**
 * Should the capture try to sign in here?
 *
 * Three conditions, all required. Credentials must have been supplied
 * EXPLICITLY (`--as` / `WOWLIDATOR_AS`) — nothing here invents or borrows one.
 * The landing page must actually look like a sign-in. And it must not already
 * have tried, because one attempt is the whole budget: a retry loop against an
 * unfamiliar login form is how an unattended tool locks an account.
 */
export function shouldSignInForCapture(state: {
  landedUrl: string;
  credentials: { email: string; password: string } | undefined;
  alreadyTried: boolean;
}): boolean {
  if (state.credentials === undefined) return false;
  if (state.alreadyTried) return false;
  return LOGIN_URL_PATTERN.test(state.landedUrl);
}


/**
 * One sign-in on the capture tab, so `--capture-journey` works cold.
 *
 * Measured: the journey capture succeeded in 3 of 3 runs today purely because
 * an earlier run had left a session in localStorage. Without one it lands on
 * the sign-in page and — correctly — discards, so on a fresh browser the flag
 * silently bought nothing.
 *
 * Never throws, never clicks something it could not identify, and never
 * touches the run's own page. On any doubt it returns the reason and the
 * caller degrades to authoring from the start page alone.
 */
async function signInOnCaptureTab(
  tab: Page,
  credentials: { email: string; password: string },
): Promise<{ ok: true } | { ok: false; reason: JourneyCaptureGiveUp }> {
  // The procedure lives in the engine now (`src/engine/sign-in.ts`) — the
  // runner's session bootstrap runs the same one, so a sign-in that works for
  // a capture works for a run and vice versa. This wrapper only maps the
  // engine's plain-string outcome onto the capture's typed give-up reasons.
  const outcome = await performSignIn(tab, credentials);
  if (outcome.ok) return { ok: true };
  return { ok: false, reason: { kind: 'no-form-field', missing: outcome.reason } };
}

/** Re-exported shape kept for the two capture callers below. */
async function passConsentGate(tab: Page): Promise<boolean> {
  return acceptConsentGate(tab);
}

/**
 * A tab in a context of its own, for anything that signs in on the person's
 * behalf to read a page.
 *
 * The capture tabs used to share the start page's context, and the state of
 * that context is whatever the last thing left there — measured on the live
 * application: a session with no consent decision, so every capture landed on
 * /en/consent and read the consent page as the destination. A fresh context
 * has nothing in it: the capture always signs in, always passes the gate, and
 * reads the page it meant to; and nothing it does can leak into the runs that
 * follow, which used to inherit the shared context's session. Closing the
 * context is the whole cleanup.
 */
async function openCaptureTab(page: Page): Promise<{ tab: Page; close: () => Promise<void> }> {
  const browser = page.context().browser();
  if (browser === null) {
    // No browser handle (an embedder's page): fall back to a tab beside it.
    const tab = await page.context().newPage();
    return { tab, close: () => tab.close().catch(() => undefined) };
  }
  const context = await browser.newContext();
  const tab = await context.newPage();
  return { tab, close: () => context.close().catch(() => undefined) };
}

/** How many shell tabs the navigation learner will switch through. */
const NAV_TAB_LIMIT = 8;
const NAV_TAB_SETTLE_MS = 400;

/** Repositories whose navigation this process already tried to learn. Once. */
const navLearnedThisProcess = new Set<string>();

/**
 * Read the application's own navigation from a signed-in shell, and remember
 * it with the repository.
 *
 * One tab, one sign-in (undone before the tab closes, exactly as the journey
 * capture does), the shell's links, plus whatever its ARIA-marked disclosures
 * reveal — a collapsed sidebar rail is one such disclosure and, on the
 * application this was measured against, the one that holds the whole menu
 * (19 links behind "ขยายเมนู", "Probation Reviews" among them). Bounded by
 * the probe's own budget and safety model: only disclosures are ever clicked.
 * Persisted on the registry entry so the next catalog run, and the next
 * session, read it for free. Never throws — a menu that could not be read is
 * a ranking that has to do without it, which is what it did before.
 */
async function learnNavigationMap(
  page: Page,
  options: CliOptions,
  slug: string,
  log?: ((line: string) => void) | undefined,
): Promise<NavMap | undefined> {
  if (options.url === undefined || !options.credentials) return undefined;
  let origin: string;
  try {
    origin = new URL(options.url).origin;
  } catch {
    return undefined;
  }
  let tab: Page | undefined;
  let closeTab: (() => Promise<void>) | undefined;
  try {
    ({ tab, close: closeTab } = await openCaptureTab(page));
    await tab.goto(options.url, { waitUntil: 'domcontentloaded' });
    await tab.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    if (LOGIN_URL_PATTERN.test(tab.url())) {
      log?.(`navigation map: signing in as ${options.credentials.email} to read the application's menu…`);
      const outcome = await signInOnCaptureTab(tab, options.credentials);
      if (!outcome.ok || LOGIN_URL_PATTERN.test(tab.url())) {
        log?.(
          `navigation map: could not sign in (${outcome.ok ? `landed on ${tab.url()}` : journeyCaptureNote(outcome.reason)}) — the menu was not read`,
        );
        return undefined;
      }
    }
    await passConsentGate(tab);
    const links = new Map<string, NavLink>();
    const keep = (name: string, url: string, via?: string): void => {
      let path: string;
      try {
        const parsed = new URL(url, origin);
        if (parsed.origin !== origin) return;
        path = parsed.pathname;
      } catch {
        return;
      }
      const label = name.replace(/\s+/g, ' ').trim();
      if (label === '' || path === '/' || LOGIN_URL_PATTERN.test(path)) return;
      const key = `${label} → ${path}`;
      if (!links.has(key)) links.set(key, { label, path, ...(via === undefined ? {} : { via }) });
    };
    for (const node of await captureAxNodes(tab, 600)) {
      if (node.role === 'link' && node.url) keep(node.name, node.url);
    }
    const report = await probeInteractions(tab, { maxProbes: 8 });
    for (const probe of report.probes) {
      for (const node of probe.revealed) {
        if (node.role === 'link' && node.url) keep(node.name, node.url, probe.trigger);
      }
    }
    // **A shell's groups are tabs, and each tab shows a different set of
    // links.** On the measured application the sidebar is a rail of
    // `role="tab"` groups (Me / Org / Team / HR / Admin / Setup) — not
    // disclosures, so the probe above never opens them, and the panel only
    // ever shows the group the landing page belongs to. A tab is ARIA's own
    // word for "switches the view and does nothing else", which is why the
    // learner may click it where the general probe (whose blast radius is
    // every page a repair touches) declines to. Bounded, and the context is
    // thrown away afterwards, so nothing needs restoring.
    const tabs = await tab.locator('role=tab').all();
    for (const [index, group] of tabs.slice(0, NAV_TAB_LIMIT).entries()) {
      const label = ((await group.innerText().catch(() => '')) || `tab ${index + 1}`)
        .replace(/\s+/g, ' ')
        .trim();
      try {
        if (!(await group.isVisible())) continue;
        await group.click({ timeout: 2_000 });
        await tab.waitForTimeout(NAV_TAB_SETTLE_MS);
      } catch {
        continue;
      }
      for (const node of await captureAxNodes(tab, 600)) {
        if (node.role === 'link' && node.url) keep(node.name, node.url, label);
      }
    }
    const nav: NavMap = {
      learnedAt: new Date().toISOString(),
      origin,
      as: options.credentials.email,
      links: [...links.values()],
    };
    log?.(`navigation map: read ${nav.links.length} destination(s) from the application's own menu`);
    const entry = await resolveRepo(slug);
    if (entry) await upsertRepo({ ...entry, nav });
    return nav;
  } catch (error) {
    log?.(`navigation map: ${error instanceof Error ? error.message : String(error)} — not read`);
    return undefined;
  } finally {
    await closeTab?.();
  }
}

/** How many ranked routes the journey capture will try before giving up. */
const JOURNEY_ROUTE_CANDIDATES = 5;

/**
 * Page URLs the request itself names, on the run's own origin, in the order
 * written — the sign-in page, a consent page and API paths excluded. Absolute
 * URLs first, then bare paths ("/en/workflows/probation").
 */
export function literalDestinations(text: string, startUrl: string): string[] {
  let origin: string;
  let startPath: string;
  try {
    const parsed = new URL(startUrl);
    origin = parsed.origin;
    startPath = parsed.pathname;
  } catch {
    return [];
  }
  const out: string[] = [];
  const keep = (path: string): void => {
    const clean = path.replace(/[.,;:!?)\]'"]+$/, '');
    if (
      clean.length <= 1 ||
      clean === startPath ||
      /^\/api\//i.test(clean) ||
      LOGIN_URL_PATTERN.test(clean) ||
      CONSENT_URL_PATTERN.test(clean)
    ) {
      return;
    }
    const url = origin + clean;
    if (!out.includes(url)) out.push(url);
  };
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>()\]]+/gi)) {
    try {
      const url = new URL(match[0].replace(/[.,;:!?)\]'"]+$/, ''));
      if (url.origin === origin) keep(url.pathname);
    } catch {
      // not a URL after all
    }
  }
  for (const match of text.matchAll(/(?:^|[\s"'(])(\/[A-Za-z][A-Za-z0-9._~%-]*(?:\/[A-Za-z0-9._~%-]+)+)/g)) {
    keep(match[1] as string);
  }
  return out;
}

/**
 * Fill a route pattern's non-locale parameters from id-shaped tokens the
 * request mentions (EMP-0005, PB-001, RULE-TRV-002). Only such tokens: an
 * ordinary word substituted for `:id` would be a page this invented. Leaves
 * the pattern untouched when nothing fits, so `concreteRouteUrl` reports it.
 */
export function fillRouteIds(pattern: string, text: string): string {
  const ids = [...text.matchAll(/\b([A-Z]{2,}(?:-[A-Z0-9]+)*-?\d{2,})\b/g)].map((m) => m[1] as string);
  if (ids.length === 0) return pattern;
  let next = 0;
  return pattern
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':') || segment.slice(1).toLowerCase() === 'locale') return segment;
      const id = ids[next];
      if (id === undefined) return segment;
      next += 1;
      return id;
    })
    .join('/');
}

async function captureJourneyTree(
  page: Page,
  options: CliOptions,
  graph: ProjectGraph | null,
  description: string,
  log?: ((line: string) => void) | undefined,
  /**
   * The part of the request that names WHERE it goes — a sheet's Menu column
   * and title — when the caller has it apart from the rest. Matched against
   * the application's own menu labels; the whole description is the fallback.
   */
  hints: {
    where?: string | undefined;
    force?: boolean | undefined;
    /**
     * The row's own stated destination (CG-11, `destinationOf`): a literal
     * URL on this origin outranks every ranking below; a tab is named in
     * the section so the author clicks it before reading.
     */
    destination?: CaseDestination | null | undefined;
    /** The account the capture signs in as — the row's first persona (CG-05); `--as` otherwise. */
    credentials?: { email: string; password: string } | undefined;
    /**
     * The row's first opening control (CG-18, reduced): clicked ONCE on the
     * capture tab after the landing tree is read, and the page after it
     * captured as a second, labelled tree. Only a name `openingControlOf`
     * passed — never a save, submit or delete.
     */
    opening?: string | null | undefined;
  } = {},
): Promise<string | undefined> {
  // `--scope e2e` turns this on by itself. An end-to-end test whose
  // destination page was never read cannot be grounded in it: measured, 9 of 9
  // authoring runs without the journey tree handed the middle of the journey
  // to a `workflow` step, and 0 of 3 did with it. Asking for e2e and getting
  // an ungrounded journey would be the flag failing to mean anything.
  if (!options.captureJourney && options.scope !== 'e2e' && hints.force !== true) return undefined;
  if (!options.captureJourney) {
    // Never silent: it is a navigation of someone's application that they did
    // not ask for by name, and they are owed the sentence saying which flag
    // asked for it.
    log?.(
      options.scope === 'e2e'
        ? 'journey capture: on because --scope e2e — an end-to-end test needs the page it ends on'
        : "journey capture: on because this row's destination is not the start page — a catalog row " +
        'authored from the sign-in tree alone hands every leg past it to a workflow step',
    );
  }
  if (options.url === undefined) {
    log?.('journey capture: needs a start url — skipped');
    return undefined;
  }
  // No graph is no RANKING, not no capture (2026-09-03, PY-1 TC_SSO_001_001):
  // a row that names its destination in so many words ("Navigate ไปที่
  // https://…/admin/config/sso") needs no route index to be read, and
  // refusing it here left the author with the sign-in tree alone — an
  // invented role=tab, the whole script handed to a workflow leg, and five
  // refusals with no attempt budget left. The graph is consulted only where
  // a ranking is actually needed, below.

  // **A URL the request names outright outranks any ranking.** A test-case
  // row frequently says where it goes in so many words ("Go to
  // http://localhost:3000/en/admin/employees/EMP-0005/probation"), and that
  // is evidence, not a guess — the BM25 ranking below is for the rows that
  // only say "Team → Probation Reviews". Measured before this: PB_01_01's row
  // named its page in step 2 and the ranker chose `…/:id/change-type` from
  // the same words, which needed an id and was skipped.
  const startRoute = graph === null ? undefined : findRouteForUrl(graph, options.url);
  const stated = hints.destination?.url ?? null;
  const literal = [
    ...(stated === null ? [] : literalDestinations(stated, options.url)),
    ...literalDestinations(description, options.url),
  ];
  let resolved: { ok: true; url: string } | undefined;
  if (literal.length > 0) {
    resolved = { ok: true, url: literal[0] as string };
    log?.(`journey capture: the request names ${resolved.url} — reading it`);
  } else if (stated !== null) {
    // A URL on ANOTHER host is not a page this run can reach — the 234 PY rows
    // naming payroll-cnext-dev — and `tableToClaims` has already refused the
    // row when it was passed the start url; here it only means "not here".
    log?.(`journey capture: the row names ${stated}, which is not on ${options.url} — ignored`);
  }
  // The capture's own account: the row's first persona, else the run's `--as`.
  const credentials = hints.credentials ?? options.credentials;
  // **The application's own menu, before any ranking over the code.** A
  // sheet says "Team → Probation Reviews"; the code says
  // `/:locale/workflows/probation`; only the deployed sidebar knows they are
  // the same place. Learned once per repository from a signed-in shell and
  // remembered on the registry entry — see `learnNavigationMap`.
  if (resolved === undefined && options.repo !== undefined) {
    const entry = await resolveRepo(options.repo);
    let origin: string | undefined;
    try {
      origin = new URL(options.url).origin;
    } catch {
      origin = undefined;
    }
    let nav = entry?.nav && entry.nav.origin === origin ? entry.nav : undefined;
    if (nav === undefined && entry && !navLearnedThisProcess.has(entry.slug)) {
      navLearnedThisProcess.add(entry.slug);
      nav = await learnNavigationMap(page, options, entry.slug, log);
    }
    const hit = navDestination(hints.where ?? description, nav);
    if (hit !== null && origin !== undefined) {
      resolved = { ok: true, url: origin + hit.path };
      log?.(
        `journey capture: the application's menu names "${hit.label}" → ${hit.path}` +
        (hit.via ? ` (behind "${hit.via}")` : '') +
        ' — reading it',
      );
    }
  }
  if (resolved === undefined && graph === null) {
    log?.('journey capture: the row names no URL on the start origin and there is no --repo to rank routes from — skipped');
    return undefined;
  }
  if (resolved === undefined) {
    const candidates = routesForDescription(graph as NonNullable<typeof graph>, description, JOURNEY_ROUTE_CANDIDATES).filter(
      (route) => route.id !== startRoute?.id && route.meta?.['type'] !== 'api',
    );
    if (candidates.length === 0) {
      log?.('journey capture: no indexed route matches the description — skipped');
      return undefined;
    }
    // Best-ranked FIRST, and the first that resolves to a real URL. A pattern
    // that needs an id takes one the request itself mentions (EMP-0005,
    // PB-001 — an id-shaped token in the row's own words), else the next
    // candidate is tried. One page is read either way: a second doubles the
    // navigation on someone else's application for a diminishing return —
    // the call `page-probe.ts` makes about a second level of disclosure.
    const skipped: string[] = [];
    for (const route of candidates) {
      const attempt = concreteRouteUrl(fillRouteIds(route.name, description), options.url);
      if (attempt.ok) {
        resolved = attempt;
        break;
      }
      skipped.push(`${route.name}: ${attempt.reason}`);
    }
    if (resolved === undefined) {
      log?.(`journey capture: no candidate route resolves to a page — ${skipped[0] ?? 'skipped'}`);
      return undefined;
    }
  }

  let extra: Page | undefined;
  let closeExtra: (() => Promise<void>) | undefined;
  let landingAfterSignIn: string | undefined;
  try {
    ({ tab: extra, close: closeExtra } = await openCaptureTab(page));
    // **Sign in first whenever credentials allow it, whether or not the
    // destination would have demanded it.** Two reasons, both measured on an
    // application whose routes are not guarded server-side: an unsigned tab
    // reads the page in a rendering the flow will never see (the flow signs
    // in), and a capture that never signs in never observes where the
    // application lands a signed-in user — the one piece of evidence that
    // stops the author guessing a landing path, which four cases in one run
    // did, identically, and failed on for 10 seconds each.
    if (
      credentials &&
      shouldSignInForCapture({ landedUrl: options.url, credentials, alreadyTried: false })
    ) {
      await extra.goto(options.url, { waitUntil: 'domcontentloaded' });
      await extra.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      if (LOGIN_URL_PATTERN.test(extra.url())) {
        log?.(`journey capture: signing in as ${credentials.email} first…`);
        const outcome = await signInOnCaptureTab(extra, credentials);
        if (outcome.ok && !LOGIN_URL_PATTERN.test(extra.url())) landingAfterSignIn = extra.url();
      }
    }
    log?.(`journey capture: reading ${resolved.url}…`);
    await extra.goto(resolved.url, { waitUntil: 'domcontentloaded' });
    await extra.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);

    // A gate in the way of the destination is passed, whoever signed in.
    if (await passConsentGate(extra)) {
      await extra.goto(resolved.url, { waitUntil: 'domcontentloaded' });
      await extra.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    }
    let landed = extra.url();
    if (LOGIN_URL_PATTERN.test(landed)) {
      if (
        !shouldSignInForCapture({
          landedUrl: landed,
          credentials,
          alreadyTried: false,
        })
      ) {
        log?.(
          `journey capture: ${journeyCaptureNote({ kind: 'no-session', target: resolved.url, landed })}`,
        );
        return undefined;
      }

      // Announced, because it is an action taken on someone's application.
      // A sign-in this performed and did not mention would be indefensible.
      log?.(`journey capture: signing in as ${(credentials as { email: string }).email} to reach ${resolved.url}…`);
      const outcome = await signInOnCaptureTab(extra, credentials as { email: string; password: string });
      if (!outcome.ok) {
        log?.(`journey capture: ${journeyCaptureNote(outcome.reason)}`);
        return undefined;
      }

      // Where the application put the signed-in user, before this navigates
      // away: real evidence for the one assertion the author otherwise has to
      // guess — "prove the sign-in took". Measured, without it the author
      // asserted /en/admin, /en/home and /en/employees for three personas from
      // route names alone, and any of those wrong is a blocked case.
      landingAfterSignIn = extra.url();
      await extra.goto(resolved.url, { waitUntil: 'domcontentloaded' });
      await extra.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      landed = extra.url();
      if (LOGIN_URL_PATTERN.test(landed)) {
        log?.(
          `journey capture: ${journeyCaptureNote({ kind: 'sign-in-refused', email: (credentials as { email: string }).email, landed })}`,
        );
        return undefined;
      }
    }

    // **The tab the row selects on arrival is selected HERE, before the tree
    // is read** (2026-09-04, PY-1 TC_SSO_001_001). A page with a tab strip
    // renders one panel at a time, so the landing tree is the DEFAULT tab's
    // panel and nothing of the tab the row is about. The prompt used to say
    // "the row selects the tab X — click it before reading" and hand over the
    // landing tree anyway: the author clicked the tab, then grounded every
    // control on the other panel's tree (its "Add Rate" for the script's
    // "Add", its rate form for the registration form), and the run died at the
    // first of them. `destinationOf` already reads the tab's name from the
    // row; matched by accessible name, whatever role the strip renders it as.
    const tabWanted = hints.destination?.tab ?? null;
    const tabSelected = await selectNamedTab(extra, tabWanted, log);
    if (tabSelected !== null) landed = extra.url();

    // The sections the row's script expands, expanded here — see
    // `expandCollapsedSections`. After the tab, because a tab is a context of
    // its own; before the tree, because a collapsed section's fields are not
    // in it.
    const expanded = await expandCollapsedSections(extra, log);

    const tree = await captureAxTree(extra, DEFAULT_AUTHOR_MAX_NODES);
    if (tree.trim() === '') {
      log?.(`journey capture: ${landed} yielded an empty tree — skipped`);
      return undefined;
    }
    log?.(`journey capture: read ${landed}${tabSelected === null ? '' : ` with the tab "${tabSelected.name}" selected`}`);
    // **The row's first opening click, once, on the capture tab** (CG-18,
    // reduced). ~400 rows' fields live behind "Create Plan" / "Add" / "ถัดไป",
    // and a tree read before that click shows none of them — every grounding
    // lint then declines the fields the row is about. The control must be in
    // the landed tree by name and must be an OPENING name (`openingControlOf`
    // has already refused saves, submits and deletes); the tab is a context of
    // its own, so what opens here reaches no run. Never fatal: a click that
    // does not land leaves the capture as it was.
    //
    // **Only from the state the script clicks it in.** The opening control
    // is scripted AFTER the tab; when the row names a tab this capture could
    // not select, the control that name matches on the landing panel belongs
    // to another tab ("Add" → the rate tab's "Add Rate"), and a tree read
    // behind it is evidence for a form the row never opens. No tree is
    // better than that tree: the author then declines the fields or hands the
    // leg to a workflow goal, both of which the run can settle honestly.
    let opened: Awaited<ReturnType<typeof captureAfterOpening>> = null;
    if (tabWanted !== null && tabSelected === null) {
      if (hints.opening) {
        log?.(
          `journey capture: the row's first click "${hints.opening}" is scripted after selecting the tab ` +
          `"${tabWanted}", which this page does not name — not clicked, so no control of another tab is read as the row's`,
        );
      }
    } else {
      opened = await captureAfterOpening(extra, hints.opening ?? null, log);
    }
    // The wizard's later pages, from wherever the capture now stands — after
    // the opening click, because that is what opens the wizard in the first
    // place on the rows that have one.
    const advanced = await advanceWizardPages(extra, opened?.tree ?? tree, log);
    const landing =
      landingAfterSignIn === undefined ||
        LOGIN_URL_PATTERN.test(landingAfterSignIn) ||
        CONSENT_URL_PATTERN.test(landingAfterSignIn)
        ? ''
        : `SIGN-IN LANDING (observed): after signing in as ${(credentials as { email: string }).email}` +
        ` — and passing the consent gate, when one appeared — the application landed on ${landingAfterSignIn}. ` +
        'This is the ONLY landing path you may expectUrl, and only for that same account; any ' +
        'other persona\'s landing is unknown, so its proof of sign-in is expectHidden of the ' +
        'submit control (see SIGNING IN), never a path inferred from a route or role name.\n\n';
    return landing + journeyTreeSection({ landed, tree, tabWanted, tabSelected, opened, expanded, advanced });
  } catch (error) {
    // Diagnostic, and swallowed: authoring without this section is exactly
    // what authoring did before it existed.
    log?.(
      `journey capture: ${error instanceof Error ? error.message : String(error)} — authoring ` +
      'proceeds with the start page alone',
    );
    return undefined;
  } finally {
    // The capture ran in a context of its own (`openCaptureTab`); closing it
    // is the whole cleanup, and nothing it did can reach the runs that follow.
    await closeExtra?.();
  }
}

/** The roles a row's named tab or opening control may be rendered as. A tab strip is as often buttons or links as `tab`s. */
const CLICKABLE_ROLES = new Set(['button', 'link', 'menuitem', 'tab']);

/**
 * The one control a row's quoted name picks out of a captured tree — the
 * matcher behind both the tab the row selects on arrival and its opening
 * click, so "which control did the sheet mean" cannot mean two things.
 * Deterministic and $0: whole accessible name first (whitespace-folded,
 * case-insensitive), else the first whose name starts with it, else — for a
 * name of three characters or more — the first containing it; clickable roles
 * only. Returns the node and its `role=` selector, or null.
 */
export function controlNamedIn(
  nodes: readonly Pick<AxNode, 'role' | 'name'>[],
  wanted: string,
): { role: string; name: string; selector: string } | null {
  const fold = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();
  const needle = fold(wanted);
  if (needle === '') return null;
  const clickable = nodes.filter((node) => CLICKABLE_ROLES.has(node.role) && node.name.trim() !== '');
  const hit =
    clickable.find((node) => fold(node.name) === needle) ??
    clickable.find((node) => fold(node.name).startsWith(needle)) ??
    clickable.find((node) => needle.length >= 3 && fold(node.name).includes(needle));
  if (hit === undefined) return null;
  const name = hit.name.replace(/\s+/g, ' ').trim();
  return { role: hit.role, name, selector: `role=${hit.role}[name="${name.replace(/"/g, '\\"')}" i]` };
}

/**
 * The journey-tree section as the author reads it. Pure, so a test can hold
 * it to its wording: a tree read with the row's tab selected says so and
 * says the flow must click that tab first; a tab the capture could not select
 * is announced as such, so a control the script names that is absent below
 * is read as "not captured", never "not on the page".
 */
export function journeyTreeSection(parts: {
  landed: string;
  tree: string;
  tabWanted: string | null;
  tabSelected: { name: string; selector: string } | null;
  opened: { name: string; selector: string; url: string; tree: string } | null;
  expanded?: { name: string; selector: string } | null | undefined;
  advanced?: readonly { name: string; selector: string; url: string; tree: string }[] | undefined;
}): string {
  const { landed, tree, tabWanted, tabSelected, opened, expanded, advanced } = parts;
  const tabNote =
    tabSelected !== null
      ? ` This tree was read WITH the tab "${tabSelected.name}" selected (${tabSelected.selector}), as the row's script ` +
        'selects it on arrival: write that click first; the controls below belong to that tab\'s panel and are not on the ' +
        'page before it.'
      : tabWanted !== null
        ? ` The row selects the tab "${tabWanted}" on arrival, and this capture could NOT select it (no control of that name), ` +
          'so the controls below are the page\'s DEFAULT panel: click the tab first, and treat a control the script names that ' +
          'is not listed below as NOT CAPTURED rather than absent — a workflow goal in the script\'s own words is the honest ' +
          'shape for that leg, never a control of another panel that merely resembles the name.'
        : '';
  // Machine-readable on purpose: `expandedControlIn` reads this back at
  // acceptance and inserts the click, because a tree read expanded is
  // evidence for a page the flow has not reached until it clicks the same
  // control. The sentence is also for the model, which sees this section.
  const expandNote =
    expanded == null
      ? ''
      : `\n\n${EXPANDED_MARKER} ${expanded.selector}\nThis tree was read AFTER clicking "${expanded.name}" ` +
        `(${expanded.selector}), which opens every collapsed section of the form — the row's own script clicks it. ` +
        'Write that click before the first field: the controls below are inside sections that are CLOSED until it happens.';
  return (
    expandNote +
    `ANOTHER PAGE IN THIS JOURNEY — the accessibility tree of ${landed}, which the request ` +
    'describes. It is NOT the page this run starts on: a selector taken from here resolves ' +
    'only after the flow has navigated to that page, so write the goto or the click that ' +
    `reaches it first.${tabNote}\n\n${tree}` +
    (opened === null
      ? ''
      : `\n\nAFTER CLICKING "${opened.name}" ON ${landed}${tabSelected === null ? '' : ` (with the tab "${tabSelected.name}" selected)`} — the accessibility tree once that control ` +
      `(${opened.selector}) was clicked, now at ${opened.url}: the dialog, form or wizard step the row's ` +
      'fields live in. Write that click FIRST; every selector below resolves only after it, and none of ' +
      `them is on the page above.\n\n${opened.tree}`) +
    // Machine-readable, like `EXPANDED_MARKER` above: `advancedControlIn`
    // reads the selector back at acceptance, so a field of a later page gets
    // its entry step AFTER the click that reaches that page — the ordering is
    // the whole point, and prose cannot carry it.
    (advanced ?? [])
      .map(
        (page, at) =>
          `\n\n${ADVANCED_MARKER} ${page.selector}\nWIZARD PAGE ${at + 2} — the accessibility tree after clicking ` +
          `"${page.name}" (${page.selector}), now at ${page.url}. These controls are NOT on the page above: write ` +
          'that click before the first field of this page, and keep the fields of each page together in the order ' +
          `the wizard shows them.\n\n${page.tree}`,
      )
      .join('')
  );
}

/**
 * Select the tab the row names, on the capture tab, before the tree is read.
 * Matched by accessible name (`controlNamedIn`) in whatever role the strip
 * renders it as. Null — with the reason logged — when the row names no tab,
 * no control carries the name, or the click does not land; the landing tree
 * then stands, and `captureJourneyTree` says so in the section's label.
 */
/**
 * Open every collapsed section of a form BEFORE the journey tree is read.
 *
 * Third instance of one rule (2026-09-07, HIR-EC-001): the tree must be read
 * from the state the row's script reads it in — the tab it selects
 * (`selectNamedTab`), the control it opens (`captureAfterOpening`), and now
 * the disclosures it expands. A wizard renders its sections collapsed, so a
 * landing tree names the section HEADERS and none of the fields inside; every
 * grounding rule then declines a field the row is entirely about. Measured:
 * the hire form's `Hire Date` and `Personal Information (Attachment) *` are
 * absent from the captured tree, so the Expected-named split and the minted
 * attachment (`src/generator/CLAUDE.md`) both found nothing to work with and
 * the leg went to the agent to guess at — five turns on a date picker. The
 * row's own Steps column says to click it ("กดปุ่ม Expand all … เพื่อกางทุกส่วน
 * ไว้ก่อน"); the capture had not.
 *
 * Deterministic, $0, and never fatal: matched by accessible name from the
 * `expandAllWords` vocabulary (data, in `value-rules.ts`), clicked once, and a
 * click that does not land leaves the capture exactly as it was. Safe by
 * construction — an expand-all control reveals, it never saves, submits or
 * deletes.
 */
async function expandCollapsedSections(
  tab: Page,
  log?: ((line: string) => void) | undefined,
): Promise<{ name: string; selector: string } | null> {
  try {
    const nodes = await captureAxNodes(tab, 600);
    for (const word of DEFAULT_AUTHORING_RULES.expandAllWords) {
      const hit = controlNamedIn(nodes, word);
      if (hit === null) continue;
      await tab.locator(hit.selector).first().click({ timeout: 3_000 });
      await tab.waitForTimeout(800);
      await tab.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
      log?.(`journey capture: expanded the form with "${hit.name}" (${hit.selector}) before reading`);
      return { name: hit.name, selector: hit.selector };
    }
    return null;
  } catch (error) {
    log?.(
      `journey capture: expanding the form did not land (${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}) — the collapsed page is read`,
    );
    return null;
  }
}

async function selectNamedTab(
  tab: Page,
  name: string | null,
  log?: ((line: string) => void) | undefined,
): Promise<{ name: string; selector: string } | null> {
  if (name === null) return null;
  try {
    const hit = controlNamedIn(await captureAxNodes(tab, 600), name);
    if (hit === null) {
      log?.(`journey capture: the row selects the tab "${name}", which no button, link or tab on this page is named — the default panel is read`);
      return null;
    }
    await tab.locator(hit.selector).first().click({ timeout: 3_000 });
    await tab.waitForTimeout(800);
    await tab.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    log?.(`journey capture: selected the tab "${hit.name}" (${hit.selector}) before reading`);
    return { name: hit.name, selector: hit.selector };
  } catch (error) {
    log?.(`journey capture: selecting the tab "${name}" did not land (${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}) — the default panel is read`);
    return null;
  }
}

/**
 * Click the named opening control on the capture tab and read the page after
 * it. Deterministic and $0: the control is matched by accessible name
 * (`controlNamedIn`) in the tree as it stands — after the row's tab, when it
 * names one. Null — with the reason logged — when nothing matches or the
 * click does not land; the capture then stands as it was.
 */
/**
 * Carry a wizard to its next page and read that too.
 *
 * A journey capture reads ONE page, and a wizard's fields are on several.
 * Live (HIR-EC-001, 2026-09-07): the hire form's Employment page holds
 * Position, Cost Center, Employee Group, Work Schedule, Job Code — ten of the
 * twenty-two fields the row's second leg keys — and not one of them was in
 * the 288-node capture, because they are behind `button "Next"`. So every one
 * went to the agent to find by hunting, and Position alone was reached for
 * eight times in 415 s before the leg ended.
 *
 * Probed on the live form before this was written: Next on the blank page
 * goes straight to `?step=2` and renders the whole Employment page. Nothing
 * is submitted and no validation blocks it — a wizard's Next is a
 * disclosure, the same shape as the expand-all click above, which is why it
 * is safe to click on a capture tab. `NOT_AN_OPENING` still guards the name,
 * so a "Save Draft" beside it can never be taken for the advance.
 *
 * Capped at `WIZARD_PAGES_CAPTURED` advances, and stops as soon as a click
 * changes neither the URL nor the tree: a page that will not advance is the
 * end of the wizard, not a reason to keep clicking.
 */
async function advanceWizardPages(
  tab: Page,
  before: string,
  log?: ((line: string) => void) | undefined,
): Promise<{ name: string; selector: string; url: string; tree: string }[]> {
  const pages: { name: string; selector: string; url: string; tree: string }[] = [];
  let previous = before;
  for (let page = 0; page < WIZARD_PAGES_CAPTURED; page += 1) {
    try {
      const nodes = await captureAxNodes(tab, 600);
      let hit: { name: string; selector: string } | null = null;
      for (const word of DEFAULT_AUTHORING_RULES.advanceWords) {
        const found = controlNamedIn(nodes, word);
        if (found === null || NOT_AN_OPENING.test(found.name)) continue;
        hit = found;
        break;
      }
      if (hit === null) return pages;
      const wasAt = tab.url();
      await tab.locator(hit.selector).first().click({ timeout: 3_000 });
      await tab.waitForTimeout(1_000);
      await tab.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
      // Each page collapses its own sections, and the expand-all above ran on
      // the first one. Measured on the hire wizard: 108 nodes collapsed
      // against the fields the row keys — Employee Group, Work Schedule and
      // Job Code named nowhere in them.
      await expandCollapsedSections(tab, log);
      const tree = await captureAxTree(tab, DEFAULT_AUTHOR_MAX_NODES);
      if (tree.trim() === '' || (tree === previous && tab.url() === wasAt)) {
        log?.(`journey capture: "${hit.name}" advanced nothing — the wizard ends here`);
        return pages;
      }
      log?.(`journey capture: advanced with "${hit.name}" (${hit.selector}) and read ${tab.url()}`);
      pages.push({ name: hit.name, selector: hit.selector, url: tab.url(), tree });
      previous = tree;
    } catch (error) {
      log?.(`journey capture: advancing the wizard did not land (${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}) — the pages read so far stand`);
      return pages;
    }
  }
  return pages;
}

/** How many pages past the first a journey capture carries a wizard through. */
const WIZARD_PAGES_CAPTURED = 2;

async function captureAfterOpening(
  tab: Page,
  opening: string | null,
  log?: ((line: string) => void) | undefined,
): Promise<{ name: string; selector: string; url: string; tree: string } | null> {
  if (opening === null) return null;
  try {
    const hit = controlNamedIn(await captureAxNodes(tab, 600), opening);
    if (hit === null) {
      log?.(`journey capture: the row's first click "${opening}" names no button or link on this page — the fields behind it are not captured`);
      return null;
    }
    const { selector } = hit;
    const before = tab.url();
    await tab.locator(selector).first().click({ timeout: 3_000 });
    await tab.waitForTimeout(800);
    await tab.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    const tree = await captureAxTree(tab, DEFAULT_AUTHOR_MAX_NODES);
    if (tree.trim() === '') {
      log?.(`journey capture: after clicking "${hit.name}" the tree was empty — not captured`);
      return null;
    }
    log?.(`journey capture: clicked "${hit.name}" (${selector}) and read the page after it${tab.url() === before ? '' : ` — now at ${tab.url()}`}`);
    return { name: hit.name, selector, url: tab.url(), tree };
  } catch (error) {
    log?.(`journey capture: clicking "${opening}" did not land (${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}) — the landing tree stands`);
    return null;
  }
}

export async function cmdCatalog(file: string | undefined, options: CliOptions): Promise<number> {
  if (!file) {
    process.stderr.write('wowlidator catalog: missing "<file>"\n');
    return 2;
  }

  const gate = assertRolesResolvable(options, ['generator']);
  if (gate) {
    process.stderr.write(`wowlidator catalog: ${gate}\n`);
    return EXIT.environment;
  }

  // `--repo` is validated up front, not only where phase 2 loads the graph —
  // otherwise `--claims-only --repo bogus` neither uses nor rejects the flag,
  // and the "unknown selection fails loudly" contract quietly has a gap.
  const repoEntry = options.repo === undefined ? null : await resolveRepo(options.repo);
  if (options.repo !== undefined && repoEntry === null) {
    process.stderr.write(
      `wowlidator catalog: unknown repository "${options.repo}" — see saved ones with: wowlidator context list\n`,
    );
    return 2;
  }

  const log = lineLogger(options);

  // Documents remembered WITH the repository ride along automatically — that
  // is what remembering them was for. Per-run `--context-doc` files come
  // first (this invocation's word wins the reading order), remembered ones
  // follow, deduplicated by resolved path so a document both remembered and
  // passed is read once. Read fresh from disk here, so an updated file is
  // its own update.
  const contextDocPaths = [...options.contextDocs];
  for (const remembered of repoEntry?.contextDocs ?? []) {
    if (!contextDocPaths.some((doc) => resolve(doc) === remembered)) {
      contextDocPaths.push(remembered);
      log?.(`context: reading ${remembered.split('/').pop()} — remembered with ${repoEntry!.slug}`);
    }
  }

  // --- the document, and its supporting cast --------------------------------
  let document;
  const contextDocs = [];
  let transcriptionNote = '';
  try {
    // An image of a sequence diagram gets one model step in front of the
    // ordinary path: a vision transcription to Mermaid, written to disk next
    // to the image so the gate can include diffing it against the drawing.
    // Everything downstream — parse, lanes, claims, authoring — then cites
    // the transcript, byte-for-byte the file a person can correct and re-run.
    let sourceFile = resolve(file);
    if (isDiagramImage(sourceFile)) {
      const transcriptPath = `${sourceFile}.transcribed.mmd`;
      // Sticky: the claims gate and the run must read the SAME transcript. A
      // second vision call between the two phases could read the pixels
      // differently, and the person would have approved claims about a
      // diagram that was then re-invented. Delete the file to re-transcribe.
      //
      // Sticky is keyed on the image being UNCHANGED, not on the file merely
      // existing: replacing the image under the same name while an old
      // transcript sits beside it would silently run approved claims about a
      // drawing that no longer exists. An image newer than its transcript is
      // re-transcribed, and says so.
      let existing: string | null = null;
      try {
        existing = await readFile(transcriptPath, 'utf8');
        const [imageStat, transcriptStat] = await Promise.all([
          stat(sourceFile),
          stat(transcriptPath),
        ]);
        if (imageStat.mtimeMs > transcriptStat.mtimeMs) {
          log?.(
            `${file} changed after its transcript was written — transcribing the new image (the old ${transcriptPath} is replaced)`,
          );
          existing = null;
        }
      } catch {
        existing = null;
      }
      if (existing !== null) {
        log?.(`reusing ${transcriptPath} — the transcript already reviewed at the gate; delete it to transcribe the image again`);
        // The transcript carries its own disclosure header (a `%%` Mermaid
        // comment the parser skips), so the "a model read pixels" warning —
        // including what it could not read — survives into every later phase,
        // not just the run that transcribed.
        const header = /^%% (.+)$/m.exec(existing);
        transcriptionNote =
          header?.[1] ??
          `transcribed earlier from ${file} — the run reads the reviewed .transcribed.mmd, not the image`;
      } else {
        const transcribed = await transcribeDiagramImage(
          sourceFile,
          new LlmDiagramTranscriber({ factory: options.factory }),
          log ?? undefined,
        );
        await writeFile(transcriptPath, `%% ${transcribed.note}\n${transcribed.mermaid}\n`, 'utf8');
        log?.(`transcript written to ${transcriptPath} — edit it there if the model misread the image; later phases reuse it as written`);
        // The vision call is paid work and reports like every other model
        // call — a summary that said "no model call" about a run that spent
        // tokens reading pixels would be the panel lying about cost.
        process.stdout.write(
          `  transcription  ${transcribed.inputTokens} in / ${transcribed.outputTokens} out tokens\n`,
        );
        transcriptionNote = transcribed.note;
      }
      sourceFile = transcriptPath;
    }
    document = await extractDocumentFile(sourceFile);
    if (transcriptionNote !== '') {
      document.note = document.note === '' ? transcriptionNote : `${document.note}; ${transcriptionNote}`;
    }
    for (const path of contextDocPaths) {
      // The whole document, not its first `DEFAULT_MAX_CHARS`. Extraction
      // truncates *positionally*, so a longer spec's last sections were
      // unreachable by every consumer, silently. Once relevance decides what
      // is sent, position no longer has to. With the budget off the old cap
      // applies again: an unbounded document sent whole is the one combination
      // this must not produce.
      contextDocs.push(
        await extractDocumentFile(
          resolve(path),
          options.contextBudget > 0 ? CONTEXT_DOC_MAX_CHARS : undefined,
        ),
      );
    }
  } catch (error) {
    process.stderr.write(
      `wowlidator catalog: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  log?.(
    `read ${document.name} (${document.format}, ${document.originalChars.toLocaleString('en-US')} chars)` +
    (contextDocs.length > 0 ? ` + ${contextDocs.length} context document(s)` : ''),
  );
  // Never a log line only: an approximation the reader does not see is an
  // approximation that reaches the model unchallenged.
  if (document.note !== '') process.stdout.write(`  ! ${document.name}: ${document.note}\n`);
  for (const context of contextDocs) {
    if (context.note !== '') process.stdout.write(`  ! ${context.name}: ${context.note}\n`);
  }

  // Is this the project's own catalog format? If so its columns already say
  // everything the extractor would have to infer, so it is read rather than
  // interpreted — no model call, no lost Test Case IDs, nothing invented. See
  // `src/catalog/test-case-table.ts`.
  let table: TestCaseRow[] | null = null;
  if (document.format === 'csv') {
    try {
      table = parseTestCaseTable(await readFile(resolve(file), 'utf8'));
    } catch {
      table = null;
    }
  } else if (document.format === 'xlsx') {
    // A workbook is read as a grid, sheet by sheet — never as its text form
    // re-parsed as a delimited file, which loses cell line breaks and sparse
    // rows and, on a real tracker, invented cases out of bug-ticket cells.
    try {
      table = parseWorkbookCases(extractWorkbookSheets(await readFile(resolve(file))));
    } catch {
      table = null;
    }
  }
  if (table !== null) {
    const sheets = [...new Set(table.map((row) => row.sheet).filter((s): s is string => s !== undefined))];
    log?.(
      `${document.name} is a test-case table — ${table.length} case(s), read from its columns` +
      (sheets.length > 0 ? ` across ${sheets.length} sheet(s): ${sheets.join(', ')}` : ''),
    );
    // **A workbook is sliced before it becomes claims** (CG-11): `--sheet EC
    // --category Hiring` makes the claims file, the ledger and the report
    // that slice's, rather than a 1,286-row plan someone strikes 1,136 rows
    // out of by hand. An empty slice is a usage error naming what exists.
    if (options.sheets.length > 0 || options.categories.length > 0) {
      const sliced = sliceRows(table, options.sheets, options.categories);
      if (sliced.length === 0) {
        const categories = [...new Set(table.map((row) => `${row.sheet ?? '-'}/${row.category ?? '-'}`))];
        process.stderr.write(
          `wowlidator catalog: --sheet ${options.sheets.join(', ') || '(any)'} --category ${options.categories.join(', ') || '(any)'} selects no row. ` +
          `Sheets: ${sheets.join(', ') || '(none)'}. Categories: ${categories.slice(0, 20).join(', ')}${categories.length > 20 ? ', …' : ''}\n`,
        );
        return 2;
      }
      log?.(
        `slice: ${sliced.length} of ${table.length} row(s) — sheet ${options.sheets.join('/') || 'any'}, category ${options.categories.join('/') || 'any'}`,
      );
      table = sliced;
    }
  } else if (options.sheets.length > 0 || options.categories.length > 0) {
    process.stderr.write('wowlidator catalog: --sheet / --category slice a test-case table or workbook, and this document is not one\n');
    return 2;
  }

  // A sequence diagram is structured the way a table is: read, not
  // interpreted. One claim per message, plane defaults classified
  // deterministically, and every guess written into the claims file for the
  // gate to confirm rather than acted on. No model call.
  let sequence: SequenceDoc | null = null;
  if (document.format === 'sequence') {
    try {
      sequence = parseSequenceDiagram(document.text);
    } catch (error) {
      // `extractDocumentFile` already validated the parse, so getting here
      // means the two passes disagree — surface it rather than guessing.
      process.stderr.write(
        `wowlidator catalog: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 2;
    }
  }

  // --- phase 1: what does this document claim? ------------------------------
  let claimsFile: ClaimsFile;
  if (options.claims !== undefined) {
    try {
      claimsFile = parseClaimsFile(await readFile(resolve(options.claims), 'utf8'));
    } catch (error) {
      process.stderr.write(
        `wowlidator catalog: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 2;
    }
    // Re-derive testability from the lane table the file itself carries, so a
    // plane corrected by hand in the JSON takes effect here exactly as it
    // does in the panel's lane editor — and so a lane correction that makes
    // the browser the claimed caller of server-side traffic is warned about
    // rather than silently manufacturing claims that must fail.
    const recompute = recomputeLaneTestability(claimsFile);
    if (recompute.changed > 0) {
      log?.(
        `lane table recomputed ${recompute.changed} claim(s) — testability follows the planes in ${options.claims}`,
      );
    }
    for (const warning of recompute.warnings) {
      process.stdout.write(`  ! ${warning}\n`);
    }
    log?.(`read ${approvedClaims(claimsFile).length} approved claim(s) from ${options.claims}`);
  } else if (table !== null) {
    // Free and exact: one claim per row, keyed to its Test Case ID.
    claimsFile = toClaimsFile(
      document.name,
      {
        summary: `${table.length} test case(s) across ${new Set(table.map((row) => row.scenarioId)).size} scenario(s)`,
        // The start url lets the parser refuse rows that navigate elsewhere
        // (CG-03: 234 PY rows name another host) at the gate, $0.
        claims: tableToClaims(table, options.url),
        model: 'read from the sheet (no model call)',
        latencyMs: 0,
        documentNote: document.note,
      },
      new Date().toISOString(),
      undefined,
      // The same reading the authoring gate makes, made once and written down
      // — so a surface can ask for the accounts BEFORE a browser opens, rather
      // than learning about them from a refusal line ten minutes in.
      tablePersonas(table),
    );
    const needs = claimsFile.personas ?? [];
    process.stdout.write(
      `read ${claimsFile.claims.length} claim(s) from ${document.name}\n` +
      `  format     test-case table — columns read directly, no model call\n` +
      `  summary    ${claimsFile.summary}\n` +
      (needs.length === 0
        ? ''
        : `  accounts   ${needs.map((p) => `${p.label} (${p.cases.length} case(s))`).join(', ')}\n`),
    );
  } else if (sequence !== null) {
    // Free and exact, the table path one notch up in structure: one claim per
    // message. Lanes past the browser boundary come out testable:false with
    // the boundary named — kept, shown, never checked.
    const derived = sequenceToClaims(sequence);
    // Claims derivation is deterministic either way, but an image-sourced
    // diagram DID pay a vision call to become text — a model string reading
    // "no model call" there would misstate what this run cost and hid.
    const claimsModel =
      transcriptionNote === ''
        ? 'read from the diagram (no model call)'
        : 'read from the transcript (deterministic) — the transcript itself is a model reading of the image';
    claimsFile = toClaimsFile(
      document.name,
      {
        summary: derived.summary,
        claims: derived.claims,
        model: claimsModel,
        latencyMs: 0,
        documentNote: document.note,
      },
      new Date().toISOString(),
      // The whole gate info, message mapping included — it is what lets the
      // panel's lane editor recompute testability when a plane is corrected.
      toGateInfo(sequence),
    );
    process.stdout.write(
      `read ${claimsFile.claims.length} claim(s) from ${document.name}\n` +
      `  format     sequence diagram (${sequence.notation}) — ` +
      (transcriptionNote === ''
        ? 'messages read directly, no model call\n'
        : 'messages read from the model-transcribed .mmd; review it against the image\n') +
      `  summary    ${claimsFile.summary}\n`,
    );
    // The participant table is the gate's new column. A guessed plane decides
    // which claims are checkable, so it is shown here and stored in the
    // claims file — confirm or correct it there before running.
    for (const participant of sequence.participants) {
      process.stdout.write(
        `  lane       ${participant.id} (${participant.label}) — ${participant.plane}` +
        `${participant.guessed ? '   (guessed — confirm in the claims file)' : ''}\n`,
      );
    }
  } else {
    log?.('asking the generator role what this document claims…');
    // The query is the catalog's own text: what background bears on THIS
    // document. Only the supporting documents are selected over — the catalog
    // goes whole, because a claim nobody retrieved is a requirement silently
    // dropped, and the run would still report green.
    const forClaims = selectRelevantContext(contextDocs, document.text, {
      budgetChars: options.contextBudget,
      onWarn: (line) => process.stderr.write(`  ! ${line}\n`),
    });
    if (forClaims.note !== '') log?.(forClaims.note);
    const model = new LlmCatalogModel({ factory: options.factory });
    let claims;
    try {
      claims = await extractClaims(model, {
        document,
        context: forClaims.documents,
        maxClaims: options.maxClaims,
      });
    } catch (error) {
      process.stderr.write(
        `wowlidator catalog: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
    claimsFile = toClaimsFile(document.name, claims, new Date().toISOString());
    process.stdout.write(
      `read ${claimsFile.claims.length} claim(s) from ${document.name}\n` +
      `  model      ${claims.model} (${claims.latencyMs}ms, ${claims.inputTokens ?? 0} in / ${claims.outputTokens ?? 0} out tokens)\n` +
      `  summary    ${claims.summary}\n`,
    );
  }

  const claimsPath =
    options.claimsOut === undefined
      ? join(resolve(options.reportDir), 'catalogs', `${slugify(document.name)}.claims.json`)
      : resolve(options.claimsOut);

  if (options.claims === undefined) {
    await mkdir(resolve(claimsPath, '..'), { recursive: true });
    await writeFile(claimsPath, `${JSON.stringify(claimsFile, null, 2)}\n`, 'utf8');
    process.stdout.write(`  claims     ${claimsPath}\n`);
    for (const claim of claimsFile.claims) {
      process.stdout.write(
        `    ${claim.testable ? '·' : ' '} [${claim.priority}] ${claim.claim}${claim.testable ? '' : '   (context, not checked)'}\n`,
      );
    }
  }

  if (options.claimsOnly) {
    process.stdout.write(
      '\nNothing has been run. Strike out anything you do not want by setting ' +
      '"approved": false, then:\n' +
      `  wowlidator catalog ${file} --claims ${claimsPath} --url <page> --run\n`,
    );
    return 0;
  }

  // --- phase 2: claims → steps → a run --------------------------------------
  const approved = approvedClaims(claimsFile).filter((claim) => claim.testable);
  if (approved.length === 0) {
    process.stderr.write(
      'wowlidator catalog: no approved, testable claims — nothing to prove.\n',
    );
    return 2;
  }

  const blocked = await prepare(options, options.url);
  if (blocked !== null) return blocked;

  let repoContextGraph: ProjectGraph | null = null;
  try {
    repoContextGraph = await loadRepoGraph(options, log ?? undefined);
  } catch (error) {
    process.stderr.write(`wowlidator catalog: ${(error as Error).message}\n`);
    return 2;
  }
  // Everything this run knows — graph and documents — becomes searchable by
  // the claude-cli generator/healer sessions, the catalog document itself
  // deliberately excluded (the boundary retrieval must not cross: the claims
  // are the question, never the corpus the answer is retrieved from).
  setClaudeRetrievalCorpus({ docs: contextDocs, graph: repoContextGraph });
  // The claims are what this catalog is about, so they decide which tables are
  // worth offering — same narrowing as the describe path, same reason. The
  // tables the sheet's Expected names outright (CG-17) are offered first.
  const approvedSources = new Set(approved.map((claim) => claim.source));
  const namedTables = [
    ...new Set(
      (table ?? [])
        .filter((row) => approvedSources.has(row.caseId))
        .flatMap((row) => dbTablesNamed(row).map((t) => t.table)),
    ),
  ];
  const tables = await tableInventory(
    repoContextGraph,
    approved.map((claim) => claim.claim).join('\n'),
    log ?? undefined,
    namedTables,
  );
  if (tables.length > 0) {
    log?.(`schema indexed — ${tables.length} table(s) available for DB checks`);
  } else if (
    approved.some((claim) => /\b(sql|database|db|psql|postgres|row|table|column)\b/i.test(claim.claim))
  ) {
    // Loud, not a log line: with no schema indexed the author structurally
    // CANNOT emit a DB check, so a database claim silently degrades to UI
    // text proxies and a green run overstates what was proven — seen live as
    // a "health counts match the database exactly" case that never read a
    // single count. The degradation still happens (the claims may have a
    // checkable UI half); it must never happen silently.
    process.stdout.write(
      '  ! these claims assert database state, but no schema is indexed — DB checks cannot ' +
      'be authored and the cases degrade to what the UI alone shows. Index one with: ' +
      'wowlidator context add <app repo> --db-schema <schema.sql> (or set WOWLIDATOR_DB_URL ' +
      'for live introspection) and pass --repo.\n',
    );
  }
  // What this catalog is about, in the document's own words — the same text
  // the claims were read out of. A catalog names its journey as surely as a
  // typed description does, so it seeds the same route lookup.
  const catalogDescription = [claimsFile.summary, ...approved.map((claim) => claim.claim)]
    .filter((line) => line !== '')
    .join('\n');
  const projectContext = repoPromptSection(
    repoContextGraph,
    options.url,
    log ?? undefined,
    catalogDescription,
  );
  const reviewer = buildFlowReviewer(options);
  const valueResolution = buildValueResolution(options, contextDocs);
  const retryModel = buildAuthorRetryModel(options);
  const author = new FlowAuthor({
    model: new LlmFlowAuthorModel({ factory: options.factory }),
    ...(retryModel === null ? {} : { retryModel }),
    policy: options.policy,
    probe: options.probe,
    ...(options.authorAttempts === undefined ? {} : { attempts: options.authorAttempts }),
    ...(reviewer === null ? {} : { reviewer }),
    ...(valueResolution === undefined ? {} : { valueResolution }),
    ...(tables.length > 0 ? { tables } : {}),
    ...(projectContext !== '' ? { projectContext } : {}),
    // The third grounding source for expectUrl. A route the application
    // declares is evidence as good as the tree's own url= attributes.
    declaredRoutes: (repoContextGraph?.nodes ?? [])
      .filter((node) => node.kind === 'route')
      .map((node) => node.name),
    // The same grounding, one layer down: `METHOD /path` for every endpoint
    // the repo declares, so an authored request's METHOD can be checked —
    // see `unindexedRequestMethod`.
    declaredOperations: (repoContextGraph?.nodes ?? [])
      .filter((node) => node.kind === 'operation')
      .map((node) => node.name),
    // The run's own backend toggle. Off, no HTTP or database step is written
    // and the claims are proved through the page with a note — see
    // `FlowAuthorOptions.backend`.
    backend: options.backend,
    // Supplied by the person, never guessed — see `parseCredentials`.
    ...(options.credentials ? { credentials: options.credentials } : {}),
    // `--scope e2e` was silently ignored on this path: the flag was read into
    // the options and never handed to the catalog's author, so a catalog of
    // end-to-end rows was authored as unit tests of the login page.
    scope: options.scope,
    onLog: log,
  });

  // A table row carries the steps a tester would take and what each should
  // produce, keyed step-by-step. That is strictly more than the claim sentence
  // the general path distils it into, so when the rows are there the author gets
  // them — the difference between a model inventing a journey and being told it.
  const approvedIds = new Set(approvedClaims(claimsFile).map((claim) => claim.source));
  // **A row with rounds is one case per round** (CG-10): `รอบที่ 2`, `Case 2:`,
  // `--Insert R2--`, a per-field `ว่างทีละช่อง` loop each become their own
  // labelled case with that round's data, so the plan, the ledger and the
  // report count what the sheet actually asks for. After the gate, not
  // before it: the claims a person reviews are the sheet's rows, one each,
  // and the split is mechanical — a round case is approved by the row's id.
  const approvedRows = table === null ? [] : table.filter((row) => approvedIds.has(row.caseId));
  const allRows = expandRounds(approvedRows);
  if (allRows.length !== approvedRows.length) {
    log?.(`rounds: ${approvedRows.length} approved row(s) become ${allRows.length} case(s) — a row listing rounds is one case per round`);
  }
  // `--resume`: the progress ledger beside the claims file says which cases
  // already have a verdict; only the ones that never ran, or were never
  // reached, are authored and run again. Stated out loud, with the counts,
  // because "108 planned, 36 skipped, 72 to run" is the whole point.
  // The pass stamp every case of this catalog is grouped by. A resume takes
  // the ORIGINAL pass's stamp from the ledger, so its cases join the group
  // the first run opened instead of starting a second one for the same
  // catalog — the stamp identifies the approved list, not the process.
  // Minted HERE, at initialisation, not lazily from the first authored flow:
  // the run key below is built on it, and a run that dies while authoring its
  // first case must still have left a keyed ledger behind.
  const passStamp: { value: string | null } = { value: new Date().toISOString() };
  // The catalog run's unique key: the catalog's name plus the pass stamp.
  // A resume reads the stored key from the prior ledger and keeps it, so one
  // approved list answers to one key across every pause and continue — and
  // the cases an earlier pass finished are pulled in under it as finished
  // tests rather than lost to the resumed subset.
  const storedRunKey: { value: string | null } = { value: null };
  const runKeyOf = (): string => storedRunKey.value ?? `${slugify(document.name)}@${passStamp.value}`;
  // The ledger is kept whenever there is anything to key it on — the claims
  // file just written counts, so a first pass (`catalog file.csv --run`, no
  // --claims yet) is resumable too, not only a re-run of a reviewed file.
  const ledgerClaimsPath = options.claims === undefined ? claimsPath : resolve(options.claims);
  const ledgerSpec =
    options.claims === undefined && allRows.length === 0
      ? undefined
      : {
        path: ledgerPathFor(ledgerClaimsPath),
        planned: allRows.map((r) => r.caseId),
        resume: options.resume,
        stamp: () => passStamp.value,
        runKey: () => runKeyOf(),
        // Enough to rebuild a resume after this process — and the panel
        // that may have spawned it — are gone. The password (`--as`) rides
        // env on purpose and is deliberately NOT recorded.
        launch: {
          catalog: resolve(file),
          claims: ledgerClaimsPath,
          ...(options.url === undefined ? {} : { url: options.url }),
          ...(options.repo === undefined ? {} : { repo: options.repo }),
          agent: options.agent,
          // The email only — see `SuiteLedger.launch.persona`.
          ...(options.credentials === undefined ? {} : { persona: options.credentials.email }),
          // Labels → emails, never a password (CG-05); the slice (CG-11).
          ...(Object.keys(options.personas).length === 0 ? {} : { personas: personaEmails(options.personas) }),
          ...(options.sheets.length === 0 ? {} : { sheets: [...options.sheets] }),
          ...(options.categories.length === 0 ? {} : { categories: [...options.categories] }),
          ...(options.includeBlocked ? { includeBlocked: true } : {}),
        },
      };
  let rows = allRows;
  // Rows authoring refused on an earlier pass, with their refusal counts —
  // a resume authors those leniently once, then stops re-authoring them.
  const refusedBefore = new Map<string, number>();
  /** Refused rows for the non-pipelined path, appended to the run so they are recorded. */
  let refusedForSerialRun: SuiteCase[] = [];
  // The prior ledger as this resume leaves it after every rerun marking —
  // what the pipelined path reads its reusable authored flows from.
  let priorLedger: SuiteLedger | null = null;
  if (options.resume) {
    const prior = ledgerSpec === undefined ? null : await readLedger(ledgerSpec.path);
    priorLedger = prior;
    for (const [id, outcome] of Object.entries(prior?.outcomes ?? {})) {
      if (outcome.authoringRefused !== undefined && outcome.authoringRefused > 0) refusedBefore.set(id, outcome.authoringRefused);
    }
    // A resume that dropped a role the pass was authored with is refused
    // here, once, with the fix — never nine per-step errors (S8).
    if (prior?.launch?.agent === true && !options.agent) {
      process.stderr.write(
        'wowlidator catalog: this run was authored WITH the multi-page agent, and this resume has it off — ' +
        'its workflow legs would error one by one. Configure the agent role (or drop --no-agent), or pass ' +
        '--no-agent explicitly together with --rerun-errors to accept the downgrade and re-author.\n',
      );
      return EXIT.environment;
    }
    // `--rerun-vacuous`: every recorded case whose flow on disk asserts
    // nothing about its claim is marked blocked in the ledger — a vacuous
    // pass was never a verdict — and the resume below picks it up.
    if (prior !== null && ledgerSpec !== undefined && options.rerunVacuous) {
      const marked = await markVacuous(prior, async (flowPath) => {
        try {
          const flow = JSON.parse(await readFile(flowPath, 'utf8')) as { setup?: unknown; steps?: unknown };
          return vacuousFlow(flow as never);
        } catch {
          return null;
        }
      });
      // Marked for re-authoring: the vacuous flow is not what a resume replays.
      forgetAuthored(prior, marked);
      await writeLedger(ledgerSpec.path, prior);
      log?.(
        marked.length === 0
          ? '--rerun-vacuous: no recorded case has a vacuous flow'
          : `--rerun-vacuous: ${marked.length} recorded case(s) proved nothing about their claim and will be re-authored: ${marked.join(', ')}`,
      );
    }
    // `--rerun-errors`: cases the HARNESS ended (an error bundle, or none)
    // are not verdicts about the application and get another run.
    // `--rerun-failed`: the failed and dead-end cases go again, with autoheal
    // on (the flag implies --repair) — a second look at the flow, not a
    // claim that the application changed.
    // `--resume-from <caseId>`: run again from that case ONWARD in plan order
    // — verdicts before it are kept, everything at or after it (whatever its
    // verdict, passes included) runs again. A fresh process, so the rerun
    // takes whatever `.env` and the code say NOW — the way to re-run the tail
    // of a paused suite under a new model or config. Case granularity on
    // purpose: a case restarts from its own first step, because a browser's
    // mid-case state cannot be resurrected.
    if (prior !== null && ledgerSpec !== undefined && options.resumeFrom) {
      const at = prior.planned.indexOf(options.resumeFrom);
      const start = at >= 0 ? at : prior.planned.findIndex((id) => id.startsWith(options.resumeFrom!));
      if (start < 0) {
        process.stderr.write(
          `wowlidator catalog: --resume-from "${options.resumeFrom}" matches no planned case. Planned ids: ${prior.planned.slice(0, 8).join(', ')}${prior.planned.length > 8 ? ', …' : ''}\n`,
        );
        return EXIT.usage;
      }
      const tail = new Set(prior.planned.slice(start));
      const marked = markForRerun(prior, (_o, id) => tail.has(id), `resume-from ${prior.planned[start]}`);
      // "Under the current config" means authored again, not replayed.
      forgetAuthored(prior, marked);
      await writeLedger(ledgerSpec.path, prior);
      log?.(
        `--resume-from: rerunning from ${prior.planned[start]} — ${marked.length} recorded case(s) rerun, ` +
        `${start} before it keep their verdicts; the rerun uses the current config`,
      );
    }
    // The single-case re-author (the panel's "Re-author & run" and its work
    // queue, 2026-08-28): the named cases lose their verdicts — whatever they
    // were, passes included — and the resume loop then re-authors each from
    // its sheet row with the CURRENT code and config before running it. The
    // sheet row is the source of truth; the recorded flow file is not reused.
    if (prior !== null && ledgerSpec !== undefined && options.rerunCases !== undefined && options.rerunCases.length > 0) {
      const wanted = new Set(options.rerunCases);
      const unknown = [...wanted].filter((id) => !prior.planned.some((p) => p === id || p.startsWith(id)));
      if (unknown.length > 0) {
        process.stderr.write(
          `wowlidator catalog: --rerun-case ${unknown.join(', ')} matches no planned case. Planned ids: ${prior.planned.slice(0, 8).join(', ')}${prior.planned.length > 8 ? ', …' : ''}\n`,
        );
        return EXIT.usage;
      }
      const marked = markForRerun(
        prior,
        (_o, id) => wanted.has(id) || [...wanted].some((w) => id.startsWith(w)),
        'rerun requested by case id — re-authored from the sheet row',
      );
      // The sheet row is the source of truth: the recorded flow is not reused.
      forgetAuthored(prior, marked);
      await writeLedger(ledgerSpec.path, prior);
      log?.(`--rerun-case: ${marked.length} case(s) re-authored from their sheet rows and re-run: ${marked.join(', ')}`);
    }
    if (prior !== null && ledgerSpec !== undefined && (options.rerunErrors || options.rerunFailed)) {
      const errors = options.rerunErrors ? markForRerun(prior, isErrorOutcome, 'rerun after error') : [];
      const failed = options.rerunFailed ? markForRerun(prior, isFailedOutcome, 'heal: re-run with autoheal') : [];
      // An explicit rerun authors again, as it always has; only a row the
      // last pass queued and never ran replays its recorded flow.
      forgetAuthored(prior, [...errors, ...failed]);
      await writeLedger(ledgerSpec.path, prior);
      if (options.rerunErrors) log?.(errors.length === 0 ? '--rerun-errors: no recorded case ended in error' : `--rerun-errors: ${errors.length} case(s) the harness ended will run again: ${errors.join(', ')}`);
      if (options.rerunFailed) log?.(failed.length === 0 ? '--rerun-failed: no recorded case failed' : `--rerun-failed: ${failed.length} failed case(s) will run again with autoheal: ${failed.join(', ')}`);
    }
    if (prior?.generatedAt) {
      passStamp.value = prior.generatedAt;
      log?.(`--resume: cases join the pass authored at ${prior.generatedAt}`);
    }
    // The stored key outranks a re-derived one: the run's identity was fixed
    // when the run was initialised, and a resume continues that run.
    if (prior?.runKey) storedRunKey.value = prior.runKey;
    if (prior === null) {
      log?.(`--resume: no progress ledger at ${ledgerSpec?.path ?? '(no --claims file)'} — running everything`);
    } else {
      const left = new Set(remaining(prior, allRows.map((r) => r.caseId)));
      rows = allRows.filter((row) => left.has(row.caseId));
      const s = summariseLedger(prior);
      log?.(
        `--resume: ${s.planned} planned — ${s.passed} passed, ${s.failed} failed${s.review > 0 ? `, ${s.review} proved-?` : ''} already have verdicts and are skipped; ` +
        `${rows.length} to run (${s.blocked} never ran, ${s.notReached} never reached)` +
        (prior.ended?.cause ? ` — the last run stopped: ${prior.ended.cause}` : ''),
      );
      if (rows.length === 0) {
        process.stdout.write('nothing left to run — every planned case has a verdict\n');
        return EXIT.ok;
      }
    }
  }

  // **Fastest scenario first.** With several scenarios queued, the sheet's
  // order is just typing order — and the ScenarioGate makes the first
  // scenario everyone else's wait. Reorder the scenario BLOCKS by estimated
  // cost, measured history first (this catalog's own prior proof bundles),
  // the sheet's Steps/Expected lines otherwise. Rows inside a scenario keep
  // sheet order; --sheet-order keeps everything as typed; the roll-up still
  // prints in planned (sheet) order either way.
  if (!options.sheetOrder && new Set(rows.map((r) => r.scenarioId || 'ungrouped')).size > 1) {
    const priorMs = new Map<string, number>();
    const ledgerForSpeed = ledgerSpec === undefined ? null : await readLedger(ledgerSpec.path);
    await Promise.all(
      Object.entries(ledgerForSpeed?.outcomes ?? {}).map(async ([caseId, outcome]) => {
        if (typeof outcome?.proofPath !== 'string' || outcome.proofPath === '') return;
        try {
          const bundle = JSON.parse(await readFile(outcome.proofPath, 'utf8')) as {
            caseDurationMs?: number;
            durationMs?: number;
          };
          const ms = bundle.caseDurationMs ?? bundle.durationMs;
          if (typeof ms === 'number' && ms > 0) priorMs.set(caseId, ms);
        } catch {
          // A missing or unreadable bundle prices that row statically.
        }
      }),
    );
    const ordered = orderScenariosFastestFirst(rows, priorMs);
    rows = ordered.rows;
    log?.(
      `scenario order, fastest estimate first: ${ordered.order
        .map((o) => `${o.scenario} (~${Math.round(o.estimateMs / 1000)}s, ${o.rows} row(s))`)
        .join(' → ')}` +
      (priorMs.size > 0 ? ` — ${priorMs.size} row(s) priced from this catalog's own history` : '') +
      ' (--sheet-order keeps the sheet’s order)',
    );
  }

  // **A dependent authors and runs after its source** (CG-12), whatever the
  // sheet's or the speed ordering's opinion: the source must exist before the
  // row that continues from it is written against the page, and the run loop
  // only ever waits on a source queued AHEAD of the dependent.
  rows = orderDependentsAfterSources(rows, (row) => row.caseId, (row) => row.dependsOn ?? []);
  // **What the plan cannot resolve, said once** (CG-12, 2026-09-04). A cycle
  // is named as one, here, before either side is blocked on the other at run
  // time; a case the rows need and this catalog does not hold is listed once
  // with the rows that need it — the per-row refusal below (`sheetGate`)
  // stays the row's own record, this is the plan's. Only a reference no
  // context document names is unresolved: a document that records what the
  // earlier cycle created stands in for the case (the `registry`).
  for (const cycle of dependencyCycles(rows, (row) => row.caseId, (row) => row.dependsOn ?? [])) {
    log?.(`dependency cycle: ${cycle.join(' → ')} → ${cycle[0]} — neither can run first; break the cycle in the sheet`);
  }
  const unresolved = unresolvedReferences(rows, contextDocs.map((doc) => doc.text));
  if (unresolved.length > 0) {
    log?.(
      `${unresolved.length} case(s) the rows continue from are not in this catalog — ` +
        `${unresolved.reduce((n, ref) => n + ref.rows.length, 0)} row(s) will be skipped, not run ` +
        '(pass a --context-doc that records what each created, or add its sheet to the catalog):',
    );
    for (const ref of unresolved) log?.(`  ${ref.id} ← ${ref.rows.join(', ')}`);
  }

  // Announced once, at initialisation: this is the name under which the run —
  // and any later resume of it — appears in the record's run list.
  if (ledgerSpec !== undefined) {
    log?.(`catalog run key ${runKeyOf()} — a resume continues this same run under it`);
  }

  let authored: AuthoredFlow;
  let tableCases: TableCase[] = [];
  // One provenance for the whole pass, from its first authored flow: the
  // same stamp whichever path writes it, so every case groups together.
  const provenanceOf = (first: AuthoredFlow): GenerationProvenance => ({
    model: first.model,
    generatedAt: (passStamp.value ??= first.authoredAt),
    sourceUrl: first.sourceUrl ?? `catalog: ${document.name}`,
    kind: 'catalog',
    rationale: claimsFile.summary || first.rationale,
    source: document.name,
    runKey: runKeyOf(),
  });
  // Where the pass's artifacts land — the same rule `dir`/`group` below
  // apply once authoring is done, needed earlier by the pipelined path.
  const placeFor = (first: AuthoredFlow): { group: string | undefined; dir: string } => {
    const g = first.sourceUrl === undefined ? undefined : reportGroupForUrl(first.sourceUrl);
    return { group: g, dir: g === undefined ? resolve(options.reportDir) : pageDir(options, g) };
  };
  // The same rule for a flow a resume replays from disk: its provenance
  // recorded the page the author read (an ungrounded pass wrote the catalog's
  // name there instead, which is no page and lands, as it did, ungrouped).
  const placeForReused = (flow: Flow): { group: string | undefined; dir: string } => {
    const source = flow.authoredBy?.sourceUrl;
    const g = source !== undefined && /^https?:\/\//i.test(source) ? reportGroupForUrl(source) : undefined;
    return { group: g, dir: g === undefined ? resolve(options.reportDir) : pageDir(options, g) };
  };
  try {
    if (rows.length > 0) {
      // Say which kind of test these rows become. A 'Test Script / Steps'
      // column IS the script — each row is a unit test of the screen its
      // steps land on, and only an explicit --scope e2e turns the journey
      // demands (notEndToEnd, forced journey capture) on. Said out loud
      // because the difference decides which refusals can fire, and a person
      // reading "dead-end" needs to know which contract the flow was held to.
      log?.(
        options.scope === 'e2e'
          ? `rows author as END-TO-END journeys (--scope e2e): each must travel and verify on the page it reaches`
          : `rows author as UNIT tests (their Steps column is the script; scope ${options.scope}) — pass --scope e2e to demand full journeys`,
      );
      // **A row is a case. Not a suggestion to the model — the unit itself.**
      //
      // Asking for one flow and letting the model divide it read a 12-row sheet
      // and came back with one task: it is free to group, and grouping is what
      // it does. But the sheet already drew the lines, and they are the lines
      // the person who wrote it meant. So each row is authored on its own and
      // the count out equals the count in, by construction rather than by
      // instruction — the same reason `MutationPolicy` is a filter and not a
      // sentence in a prompt.
      //
      // The cost is one authoring call per row against one open page. That is
      // the price of the guarantee, and it is the guarantee that was asked for.
      // **A case runs the moment it is written, when the pool allows more
      // than one.** Authoring a row is a model call the browser spends idle;
      // running a case is browser time the model spends idle. With
      // `--run` and a concurrency above 1 the two overlap: each authored
      // case is stamped, written to disk and pushed into a `CaseQueue` that
      // `runCases` is already draining, so the first case is usually proved
      // before the last row is authored. Concurrency 1 keeps the old order —
      // author everything, then run — which is also the A/B for a pipelined
      // result that looks wrong. The queue is closed in a `finally`: a
      // refused row or a thrown authoring must never leave runs waiting on
      // a list that will not grow.
      const pipelined =
        options.run && Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY) > 1;
      const queue = pipelined ? new CaseQueue<SuiteCase>() : null;
      const drain: { value: Promise<CaseOutcome[]> | null } = { value: null };
      const placed: { value: { group: string | undefined; dir: string } | null } = { value: null };
      if (queue !== null) {
        log?.(`cases will run as they are authored (pipelined; --concurrency 1 authors everything first)`);
      }
      // Authoring holds to the scenario the runner is in — a row of scenario
      // N+1 is not authored while scenario N still has cases running. Only on
      // the pipelined path: a run that starts after the last row would
      // deadlock a gate that waits on runs. `--author-lookahead all` restores
      // the old eager behaviour; a number widens the window by that many
      // scenarios.
      // The Machinery card's off-switch, same voice as `--author-lookahead
      // all`: authoring stops waiting on runs and every row authors as fast
      // as the pool allows — what feeds the parallel lanes.
      const gateOff = (process.env['WOWLIDATOR_SCENARIO_GATE'] ?? '').trim().toLowerCase() === 'off';
      const gate =
        queue === null || options.authorLookahead === 'all' || gateOff
          ? null
          : new ScenarioGate(
            rows.map((row) => row.scenarioId || 'ungrouped'),
            { lookahead: typeof options.authorLookahead === 'number' ? options.authorLookahead : 0 },
          );
      if (gate !== null) {
        log?.('authoring keeps pace with the runs: a scenario is authored only once every scenario before it has finished running (--author-lookahead widens this; the Machinery card can turn the gate off)');
      } else if (gateOff && queue !== null) {
        log?.('scenario gate OFF (WOWLIDATOR_SCENARIO_GATE=off) — every row authors as fast as the pool allows');
      }
      // The healer repairs with the same retrieved context the author reads:
      // the repository's declarations for the failing page, and the
      // background documents ranked by the failed step's own words.
      const suiteHealHints = healHintsFrom(repoContextGraph ?? null, contextDocs);
      const riskModel = buildRiskModel(options);
      if (riskModel === null && riskEnabled()) {
        log?.('pre-run dead-end risk is not judged: the generator role does not resolve — every case runs with every retry path');
      }
      // **A resume runs the flows the stopped pass authored; it does not
      // author them again** (2026-09-05). The ledger records each flow's
      // path the moment its case is queued (`SuiteLedger.authored`, through
      // the runner's `noteAuthored` hook below); a row still without a
      // verdict, never refused and never judged vacuous, is read back
      // through the zod seam and pushed straight into the queue. A file that
      // is missing or fails the schema, or a persona this resume has no
      // credentials for, falls back to authoring with the reason logged.
      const hooks: { value: LedgerHooks | null } = { value: null };
      let authorRows: TestCaseRow[] = rows;
      let reused: { row: TestCaseRow; entry: LedgerAuthored; flow: Flow }[] = [];
      if (queue !== null && priorLedger !== null) {
        const split = await resumeAuthored(priorLedger, rows, { log });
        authorRows = split.author;
        reused = split.reuse;
      }
      const queuedPaths: string[] = [];
      /** Flows a resume replayed from disk, in the order they were queued. */
      const reusedPaths: string[] = [];
      // Rows authoring refused: each becomes a flow-less case the runner
      // records as blocked, with the reason and the refusal count — that is
      // how the refusal reaches the ledger, the report and the next resume
      // (2026-09-02: ec10n's last two rows were refused and re-authored on
      // every resume, unrecorded, so every resume ended with the same "2
      // left"). Buffered until the runner exists; flushed into its queue
      // then, or written straight to the ledger if nothing at all authored.
      const pendingRefused: SuiteCase[] = [];
      const refusedCaseOf = (row: TestCaseRow, reason: string, attempt: number): SuiteCase => {
        const known = sheetVerdict(row.actual);
        return {
          name: row.caseId,
          flow: { name: row.caseId, steps: [] },
          kind: 'catalog',
          ...(row.scenarioId ? { scenarioId: row.scenarioId } : {}),
          ...(row.dependsOn === undefined || row.dependsOn.length === 0 ? {} : { dependsOn: [...row.dependsOn] }),
          ...(known === undefined ? {} : { knownResult: known }),
          refused: { reason, attempt },
        };
      };
      // **A dependent is never pushed ahead of its source** (CG-12). Rows are
      // authored in a pool and `onCase` fires in COMPLETION order, so the
      // dependent's flow can be ready before the source's. The queue indexes
      // by arrival and the run loop dispatches in index order, so a source
      // behind its dependent would never be dispatched while the dependent
      // waits for it. Held here until every planned source has been pushed
      // (or refused — a refusal is pushed too, and blocks the dependent with
      // its reason downstream); flushed at close so no case is abandoned.
      const plannedIds = new Set(rows.map((row) => row.caseId));
      const pushedIds = new Set<string>();
      const heldBySource = new Map<string, (() => Promise<void>)[]>();
      const releaseDependents = async (sourceId: string): Promise<void> => {
        pushedIds.add(sourceId);
        const released = heldBySource.get(sourceId) ?? [];
        heldBySource.delete(sourceId);
        for (const push of released) await push();
      };
      const offer = async (caseId: string, dependsOn: readonly string[] | undefined, push: () => Promise<void>): Promise<void> => {
        const missing = (dependsOn ?? []).find((id) => id !== caseId && plannedIds.has(id) && !pushedIds.has(id));
        if (missing === undefined) {
          await push();
          await releaseDependents(caseId);
          return;
        }
        log?.(`  ${caseId}: held until ${missing} is queued — it continues from that case`);
        const list = heldBySource.get(missing) ?? [];
        list.push(async () => offer(caseId, dependsOn, push));
        heldBySource.set(missing, list);
      };
      const flushHeld = async (): Promise<void> => {
        const pending = [...heldBySource.values()].flat();
        heldBySource.clear();
        for (const push of pending) {
          // Its source never arrived: pushed anyway, so the run records it
          // blocked with the reason rather than losing it.
          await push();
        }
      };
      const enqueueRefused = (refusedCase: SuiteCase): void => {
        if (queue === null) return;
        if (refusedCase.scenarioId !== undefined) gate?.queued(refusedCase.scenarioId);
        queue.push(refusedCase);
        void releaseDependents(refusedCase.name);
      };
      // The consumer, started once — by the first authored flow, or by the
      // first reused one, whichever is queued first. The report folder is
      // fixed by that first case: nothing is queued before there is somewhere
      // for its report to go.
      const startRunner = (place: { group: string | undefined; dir: string }): { group: string | undefined; dir: string } => {
        placed.value ??= place;
        const { group, dir } = placed.value;
        if (queue !== null) {
          drain.value ??= runCases(queue, options, {
            dir,
            group,
            indexTitle: `wowlidator catalog — ${document.name}`,
            declaredRoutes: declaredPageRoutes(repoContextGraph),
            graphFacts: graphFactsOf(repoContextGraph),
            ledger:
              ledgerSpec === undefined
                ? undefined
                : {
                  ...ledgerSpec,
                  hooks: (given) => {
                    hooks.value = given;
                  },
                },
            healHints: suiteHealHints,
            // The sheet's words for every planned row: what the
            // database baseline detects its tables from, so it can
            // snapshot before the first case instead of waiting for
            // the whole pass to author (which would disable the
            // pipelining this path exists for).
            planRows: rows.map(planRowText),
            onCaseDone: (finished) => {
              if (finished.scenarioId !== undefined) gate?.ran(finished.scenarioId);
            },
          });
          // Refusals that arrived before the runner existed join its queue now.
          for (const refusedCase of pendingRefused.splice(0)) enqueueRefused(refusedCase);
        }
        return placed.value;
      };
      let authoredRows: { first: AuthoredFlow; cases: TableCase[] } | null = null;
      try {
        // The reused flows first: they are ready now, and the browser would
        // otherwise idle through the first row's authoring.
        const fellBack = new Set<string>();
        for (const { row, entry, flow } of reused) {
          const scenarioId = row.scenarioId || 'ungrouped';
          const resolved = resolveRowPersonas(personasOf(row), options);
          if (resolved.missing.length > 0) {
            log?.(`resume: ${row.caseId} — persona ${resolved.missing.join(', ')} has no credentials in this resume; authoring it again`);
            fellBack.add(row.caseId);
            continue;
          }
          const { group } = startRunner(placeForReused(flow));
          // Its authoring is done as far as the scenario gate is concerned.
          gate?.authored(scenarioId);
          const known = sheetVerdict(row.actual);
          const reusedCase: SuiteCase = {
            name: `${row.caseId} ${row.testCase}`,
            flow,
            flowPath: entry.flowPath,
            kind: 'catalog',
            scenarioId,
            ...(group === undefined ? {} : { group: `${group}/${slugify(scenarioId)}` }),
            ...(flow.authoredBy === undefined ? {} : { generatedBy: flow.authoredBy }),
            ...(entry.risk === undefined ? {} : { risk: entry.risk }),
            ...suiteFactsOf({
              ...(row.dependsOn === undefined ? {} : { dependsOn: row.dependsOn }),
              ...(known === undefined ? {} : { knownResult: known }),
              ...(observeOnlyCase(row) ? { recordOnly: true } : {}),
              ...(Object.keys(resolved.personas).length === 0 ? {} : { personas: resolved.personas }),
            }),
          };
          reusedPaths.push(entry.flowPath);
          await offer(row.caseId, row.dependsOn, async () => {
            log?.(`  queued ${reusedCase.name} → ${entry.flowPath} (reused, not authored again)`);
            queue!.push(reusedCase);
            gate?.queued(scenarioId);
            // Already on the ledger under this run key: nothing is re-noted,
            // nothing re-substituted.
          });
        }
        if (fellBack.size > 0) {
          const back = new Set([...authorRows.map((row) => row.caseId), ...fellBack]);
          authorRows = rows.filter((row) => back.has(row.caseId));
        }
        authoredRows = authorRows.length === 0 ? null : await authorEachRow(authorRows, author, options, {
          summary: claimsFile.summary,
          context: contextDocs,
          log,
          graph: repoContextGraph,
          gate,
          risk: riskModel,
          refusedBefore,
          runKey: runKeyOf(),
          now: authoringNow(),
          onRefused: async (row, reason, attempt) => {
            const refusedCase = refusedCaseOf(row, reason, attempt);
            if (queue !== null && drain.value !== null) enqueueRefused(refusedCase);
            else pendingRefused.push(refusedCase);
          },
          onCase:
            queue === null
              ? undefined
              : async (testCase, first) => {
                // The report folder is known from the first queued flow —
                // this one, unless a resume replayed one before it.
                const { group, dir } = startRunner(placeFor(first));
                // Same stamp and same file the non-pipelined path writes
                // below — built here because the run needs both now.
                testCase.flow.authoredBy = stampProvenance(provenanceOf(first), testCase);
                const flowPath = await writeFlowFile(
                  catalogFlowPath(options, {
                    dir: join(dir, slugify(testCase.scenarioId)),
                    group,
                    name: testCase.flow.name,
                    index: rows.length === 1 ? undefined : queuedPaths.length + 1,
                  }),
                  testCase.flow,
                );
                queuedPaths.push(flowPath);
                const caseId = caseIdOfName(testCase.name);
                await offer(caseId, testCase.dependsOn, async () => {
                  log?.(`  queued ${testCase.name} → ${flowPath}`);
                  const queued: SuiteCase = {
                    name: testCase.name,
                    flow: testCase.flow,
                    flowPath,
                    kind: 'catalog',
                    scenarioId: testCase.scenarioId,
                    ...(group === undefined ? {} : { group: `${group}/${slugify(testCase.scenarioId)}` }),
                    generatedBy: testCase.flow.authoredBy,
                    ...(testCase.risk === undefined ? {} : { risk: testCase.risk }),
                    ...suiteFactsOf(testCase),
                  };
                  queue.push(queued);
                  gate?.queued(testCase.scenarioId);
                  // On the ledger the moment it is queued — the file is
                  // already on disk — so a stop before it runs costs the
                  // next resume nothing.
                  await hooks.value?.noteAuthored(queued);
                });
              },
        });
      } catch (error) {
        if (error instanceof AuthoringError && reusedPaths.length > 0 && drain.value !== null) {
          // Every row left to author was refused — each is on the queue
          // already, blocked with its reason — while the reused flows run.
          // Their refusals are rows of this run, not a reason to abandon it.
          log?.(`authoring: ${error.message.split('\n')[0] ?? error.message} — the ${reusedPaths.length} reused flow(s) still run`);
        } else {
          // Authoring broke; the cases already queued are still running and
          // still owed their reports. Let them finish before the error lands,
          // or they are abandoned mid-run with their proofs half-written.
          await flushHeld().catch(() => undefined);
          queue?.close();
          if (drain.value !== null) await drain.value.catch(() => undefined);
          // Nothing ran, so no runner wrote the ledger: the refusals go there
          // directly, or the next resume re-authors the same rows for the same
          // answer — the loop this exists to end.
          if (pendingRefused.length > 0 && ledgerSpec !== undefined) await persistRefusals(ledgerSpec.path, pendingRefused);
          throw error;
        }
      } finally {
        // A dependent whose source never arrived is pushed now — recorded
        // blocked with the reason, never abandoned — before the queue closes.
        await flushHeld().catch(() => undefined);
        queue?.close();
      }
      if (drain.value !== null && placed.value !== null) {
        if (authoredRows !== null) {
          printAuthored(authoredRows.first, authoredRows.cases, queuedPaths, approved.length, placed.value.group, placed.value.dir);
        }
        if (reusedPaths.length > 0) {
          process.stdout.write(`reused ${reusedPaths.length} flow(s) authored before this resume:\n`);
          for (const path of reusedPaths) process.stdout.write(`    flow     ${path}\n`);
        }
        const outcomes = await drain.value;
        return suiteExit(outcomes);
      }
      if (authoredRows === null) {
        // Only the pipelined path reuses flows, and it returned above once
        // its runner drained; a list that authored nothing and started no
        // runner is a contradiction, said rather than swallowed.
        throw new Error('wowlidator catalog: no row was authored and no run was started');
      }
      authored = authoredRows.first;
      tableCases = authoredRows.cases;
      refusedForSerialRun = pendingRefused;
    } else {
      const approvedText = approvedClaims(claimsFile)
        .map((claim) => claim.claim)
        .join('\n');
      const forFlow = selectRelevantContext(contextDocs, approvedText, {
        budgetChars: options.contextBudget,
        onWarn: (line) => process.stderr.write(`  ! ${line}\n`),
      });
      if (forFlow.note !== '') log?.(forFlow.note);
      const prompt = buildAuthoringPrompt(approvedClaims(claimsFile), {
        summary: claimsFile.summary,
        context: forFlow.documents,
      });
      log?.(`writing a flow for ${approved.length} claim(s)…`);
      authored = options.url
        ? await withPage(options.cdp, async (page) => {
          log?.(`opening ${options.url}…`);
          await page.goto(options.url as string, { waitUntil: 'domcontentloaded' });
          await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
          const pilot = buildCapturePilot(options);
          if (pilot) await pilotCapture(page, pilot, log);
          return author.author(prompt, page);
        })
        : await author.author(prompt);
    }
  } catch (error) {
    if (error instanceof AuthoringError) {
      process.stderr.write(`wowlidator catalog: ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const group =
    authored.sourceUrl === undefined ? undefined : reportGroupForUrl(authored.sourceUrl);
  // An ungrounded catalog has no page to be named after, so its cases land at
  // the top level of the report directory. Never the working directory: the
  // `grimval` wrapper runs the CLI from the engine's own checkout, so a catalog
  // of ten cases would leave ten flow files loose in it.
  const dir = group === undefined ? resolve(options.reportDir) : pageDir(options, group);

  // One flow per discrete case, each carrying the shared setup and teardown, so
  // a case stands on its own. That is what makes a failure survivable: the cases
  // after it are separate runs and still get answered. A body the model did not
  // divide is one case, and behaves exactly as it always did.
  // One task per row when the catalog was a table; otherwise the model's own
  // division of the single flow it wrote.
  const cases: (Pick<TableCase, 'name' | 'flow'> & Partial<TableCase>)[] =
    tableCases.length > 0 ? tableCases : caseFlows(authored);
  const flowPaths: string[] = [];
  // One provenance for the whole pass, stamped on every case's flow BEFORE it
  // is written and again carried on its run: the flow file outlives the run,
  // and a re-run or a repair of it has to land in this catalog's group rather
  // than among hand-written flows. (It was once stamped after the write, so
  // every file on disk lacked it and only the first run ever grouped.)
  const catalogProvenance = provenanceOf(authored);
  // The pass-wide provenance plus the two per-case facts a sheet states —
  // scenario and test-case title — so the run list can group by the former
  // and print the latter without re-reading the sheet.
  for (const testCase of cases) {
    testCase.flow.authoredBy = stampProvenance(catalogProvenance, testCase);
  }
  for (const [index, testCase] of cases.entries()) {
    // A sheet groups its rows by scenario; the folder does the same, so twelve
    // cases land in six classes rather than one flat pile.
    const scenario = testCase.scenarioId;
    flowPaths.push(
      await writeFlowFile(
        catalogFlowPath(options, {
          dir: scenario === undefined ? dir : join(dir, slugify(scenario)),
          group,
          name: testCase.flow.name,
          index: cases.length === 1 ? undefined : index + 1,
        }),
        testCase.flow,
      ),
    );
  }

  printAuthored(authored, cases, flowPaths, approved.length, group, dir);

  if (!options.run) return 0;

  // Every case runs, even after one fails — same reasoning as `fillEach`, one
  // level up: a catalog answered halfway is far less useful than the whole
  // table, and the claims after a failure were approved by someone who is still
  // owed an answer about them. `runCases` also survives a case that *throws*,
  // which a failed case does not: see its note.
  const outcomes = await runCases(
    [...cases.map((testCase, index) => ({
      flowPath: flowPaths[index],
      name: testCase.name,
      flow: testCase.flow,
      kind: 'catalog' as const,
      ...(testCase.scenarioId !== undefined && group !== undefined
        ? { group: `${group}/${slugify(testCase.scenarioId)}` }
        : {}),
      // The flow's own stamp, not the pass-wide one: it carries the scenario
      // and case title the run list groups and labels by.
      generatedBy: testCase.flow.authoredBy ?? catalogProvenance,
      ...(testCase.risk === undefined ? {} : { risk: testCase.risk }),
      ...suiteFactsOf(testCase),
    })), ...refusedForSerialRun],
    options,
    {
      dir,
      group,
      indexTitle: `wowlidator catalog — ${document.name}`,
      declaredRoutes: declaredPageRoutes(repoContextGraph),
      graphFacts: graphFactsOf(repoContextGraph),
      ledger: ledgerSpec,
      healHints: healHintsFrom(repoContextGraph ?? null, contextDocs),
      planRows: rows.map(planRowText),
    },
  );

  return suiteExit(outcomes);
}

export async function cmdAuthor(prompt: string | undefined, options: CliOptions): Promise<number> {
  if (!prompt) {
    process.stderr.write('wowlidator author: missing "<prompt>"\n');
    return 2;
  }

  const gate = assertRolesResolvable(options, ['generator']);
  if (gate) {
    process.stderr.write(`wowlidator author: ${gate}\n`);
    return EXIT.environment;
  }

  const blocked = await prepare(options, options.url);
  if (blocked !== null) return blocked;

  const log = lineLogger(options);

  let repoContextGraph: ProjectGraph | null = null;
  try {
    repoContextGraph = await loadRepoGraph(options, log ?? undefined);
  } catch (error) {
    process.stderr.write(`wowlidator author: ${(error as Error).message}\n`);
    return 2;
  }
  const tables = await tableInventory(repoContextGraph, prompt, log ?? undefined);
  if (tables.length > 0) {
    log?.(`schema indexed — ${tables.length} table(s) available for DB checks`);
  }
  const projectContext = repoPromptSection(
    repoContextGraph,
    options.url,
    log ?? undefined,
    prompt,
  );
  // Everything the author needs that does not depend on a page. The journey
  // capture does, so the author itself is built inside `withPage` below — a
  // second tree is a constructor option, and there is no page to read one from
  // out here.
  const reviewer = buildFlowReviewer(options);
  const valueResolution = buildValueResolution(options);
  const retryModel = buildAuthorRetryModel(options);
  const authorOptions = {
    model: new LlmFlowAuthorModel({ factory: options.factory }),
    ...(retryModel === null ? {} : { retryModel }),
    policy: options.policy,
    probe: options.probe,
    ...(options.authorAttempts === undefined ? {} : { attempts: options.authorAttempts }),
    ...(reviewer === null ? {} : { reviewer }),
    ...(valueResolution === undefined ? {} : { valueResolution }),
    ...(tables.length > 0 ? { tables } : {}),
    ...(projectContext !== '' ? { projectContext } : {}),
    // The third grounding source for expectUrl. A route the application
    // declares is evidence as good as the tree's own url= attributes.
    declaredRoutes: (repoContextGraph?.nodes ?? [])
      .filter((node) => node.kind === 'route')
      .map((node) => node.name),
    // The same grounding, one layer down: `METHOD /path` for every endpoint
    // the repo declares, so an authored request's METHOD can be checked —
    // see `unindexedRequestMethod`.
    declaredOperations: (repoContextGraph?.nodes ?? [])
      .filter((node) => node.kind === 'operation')
      .map((node) => node.name),
    // The run's own backend toggle. Off, no HTTP or database step is written
    // and the claims are proved through the page with a note — see
    // `FlowAuthorOptions.backend`.
    backend: options.backend,
    // Supplied by the person, never guessed — see `parseCredentials`.
    ...(options.credentials ? { credentials: options.credentials } : {}),
    scope: options.scope,
    onLog: log,
  };

  let authored;
  try {
    authored = options.url
      ? await withPage(options.cdp, async (page) => {
        log?.(`opening ${options.url}…`);
        await page.goto(options.url as string, { waitUntil: 'domcontentloaded' });
        // Client-rendered pages need a beat before the AX tree is meaningful.
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
        const pilot = buildCapturePilot(options);
        if (pilot) await pilotCapture(page, pilot, log);
        // Read in a second tab, so `page` is still the start page when the
        // author captures the tree its selectors are checked against.
        const journeyTree = await captureJourneyTree(
          page,
          options,
          repoContextGraph,
          prompt,
          log ?? undefined,
        );
        const author = new FlowAuthor({
          ...authorOptions,
          ...(journeyTree ? { journeyTree } : {}),
        });
        return author.author(prompt, page);
      })
      : await new FlowAuthor(authorOptions).author(prompt);
  } catch (error) {
    if (error instanceof AuthoringError) {
      process.stderr.write(`wowlidator author: ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  // Group by the page it was written against, so the flow and the report it
  // produces end up in the same folder. An ungrounded flow has no page to be
  // named after, so it stays at the top level *of the report directory* — not
  // the working directory, which is wherever the caller happened to be and, via
  // the `grimval` wrapper, is the engine's own checkout.
  const group =
    authored.sourceUrl === undefined ? undefined : reportGroupForUrl(authored.sourceUrl);
  const dir = group === undefined ? resolve(options.reportDir) : pageDir(options, group);
  const flowPath =
    options.flow === undefined
      ? join(dir, flowFilename({ runId: '', name: authored.flow.name, status: 'authored', group }))
      : resolve(options.flow);

  await writeFlowFile(flowPath, authored.flow);

  const totalSteps =
    (authored.flow.setup?.length ?? 0) +
    authored.flow.steps.length +
    (authored.flow.teardown?.length ?? 0);

  process.stdout.write(
    `authored "${authored.flow.name}" — ${totalSteps} step(s)\n` +
    `  model      ${authored.model} (${authored.latencyMs}ms, ${authored.inputTokens ?? 0} in / ${authored.outputTokens ?? 0} out tokens)\n` +
    `  grounded   ${authored.grounded ? `yes — selectors checked against ${authored.sourceUrl}` : 'NO — selectors are guesses; verify every one before trusting this'}\n` +
    `  rationale  ${authored.rationale}\n` +
    (group === undefined ? '' : `  folder     ${dir}\n`) +
    `  flow       ${flowPath}\n`,
  );
  // Surfaced, not silently dropped — a rising count means the prompt is slipping.
  if (authored.droppedSteps > 0) {
    process.stdout.write(
      `  ! dropped ${authored.droppedSteps} malformed step(s) the model emitted\n`,
    );
  }
  if (authored.notes.trim() !== '') {
    process.stdout.write(`  ! notes     ${authored.notes}\n`);
  }

  if (!options.run) return 0;

  log?.(`\nrunning "${authored.flow.name}"…`);
  const bundle = await runFlow(authored.flow, {
    cdpUrl: options.cdp,
    cachePath: options.cache,
    screenshots: options.screenshots,
    highlightTarget: options.highlightTarget,
    video: options.video,
    humanize: options.humanize,
    agentAssist: options.agentAssist,
    backend: options.backend,
    captureDelayMs: options.captureDelayMs,
    stepDelayMs: options.stepDelayMs,
    makeHealer: buildHealer(options),
    stepRepair: buildStepRepair(options),
    healer: options.heal ? undefined : null,
    agent: buildAgent(options),
    dataModel: buildDataModel(options),
    updateBaselines: options.updateBaselines,
    network: options.network,
    // Carried for masking only: a password the person supplied must not
    // reach the proof bundle or the emailable report in cleartext.
    credentials: options.credentials,
    historyPath: options.history ? options.historyPath : null,
    onStep: stepLogger(options),
    onPlan: planLogger(options),
    generatedBy: {
      model: authored.model,
      generatedAt: authored.authoredAt,
      sourceUrl: authored.sourceUrl ?? 'authored from prompt',
      kind: 'functional',
      rationale: authored.rationale,
    },
  });

  const proofPath = await writeProofBundle(bundle, options.out);
  const target = resolveReportPath(
    { path: options.report, dir: options.reportDir, enabled: options.reportEnabled },
    { runId: bundle.runId, name: bundle.name, status: bundle.status, group },
  );
  const reportPath = target === null ? null : await writeHtmlReport(bundle, target);

  process.stdout.write(
    `\n${formatProofSummary(bundle)}\n` +
    (meaningfulCoverage(bundle) ? `  ${formatCoverage(bundle.coverage!)}\n` : '') +
    (bundle.trend ? `  ${formatTrend(bundle.trend)}\n` : '') +
    `  proof      ${proofPath}\n` +
    (reportPath === null ? '' : `  report     ${reportPath}\n`),
  );
  if (bundle.error) process.stderr.write(`\n${bundle.error}\n`);

  const quarantine = await applyQuarantine(bundle, options);
  await writeMachineReports([bundle], options);
  await openReport(reportPath, options);
  await cleanupChrome(options);
  return quarantine.quarantined ? EXIT.ok : exitCodeFor(bundle);
}

/**
 * "Today" for the sheet's relative dates: `WOWLIDATOR_NOW` (an ISO date or
 * date-time) when set — what makes a run reproducible and a test pinnable —
 * else the wall clock, read once per invocation so every row agrees. A
 * resume takes ITS day, not the original pass's: the tester's calendar is
 * what the application compares against.
 */
function authoringNow(): Date {
  const raw = (process.env['WOWLIDATOR_NOW'] ?? '').trim();
  if (raw !== '') {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
    process.stderr.write(`  ! WOWLIDATOR_NOW="${raw}" is not a date — using the clock\n`);
  }
  return new Date();
}

/** The case id a suite case name starts with — the same rule the ledger keys on. */
function caseIdOfName(name: string): string {
  return name.split(/\s+/, 1)[0] ?? name;
}

/**
 * The provenance stamp for one authored case: the pass-wide record plus the
 * sheet's per-row facts. The truth table's ground truth is the typed
 * passed/failed only — `blocked` (CG-01) travels on the suite case and the
 * ledger, never as a human verdict a judge may not overrule. `recordOnly`
 * (CG-09) is written into the file so a re-run of it still ends for review;
 * it rides a spread because `GenerationProvenance` does not declare it yet
 * (proof-bundle.ts is another implementer's file).
 */
function stampProvenance(
  base: GenerationProvenance,
  testCase: Partial<TableCase>,
): GenerationProvenance {
  const human = testCase.knownResult === 'passed' || testCase.knownResult === 'failed' ? testCase.knownResult : undefined;
  return {
    ...base,
    ...(testCase.scenario === undefined ? {} : { scenario: testCase.scenario }),
    ...(testCase.scenarioId === undefined ? {} : { scenarioId: testCase.scenarioId }),
    ...(testCase.caseTitle === undefined ? {} : { caseTitle: testCase.caseTitle }),
    ...(human === undefined ? {} : { knownResult: human }),
    ...(testCase.recordOnly === true ? { recordOnly: true } : {}),
  };
}

/** The per-row facts a `SuiteCase` carries beside its flow (CG-01/05/09/12). */
function suiteFactsOf(testCase: Partial<TableCase>): Pick<SuiteCase, 'dependsOn' | 'knownResult' | 'recordOnly' | 'personas'> {
  return {
    ...(testCase.dependsOn === undefined || testCase.dependsOn.length === 0 ? {} : { dependsOn: [...testCase.dependsOn] }),
    ...(testCase.knownResult === undefined ? {} : { knownResult: testCase.knownResult }),
    ...(testCase.recordOnly === true ? { recordOnly: true } : {}),
    ...(testCase.personas === undefined ? {} : { personas: testCase.personas }),
  };
}

/**
 * Refusals with no runner to carry them: written to the ledger directly, so
 * the report says why each row has no verdict and a resume counts the refusal.
 * Only when the ledger already exists — a first pass that authored nothing at
 * all never opened one, and inventing it here would mint a run with no key.
 */
async function persistRefusals(ledgerPath: string, refused: readonly SuiteCase[]): Promise<void> {
  const ledger = await readLedger(ledgerPath);
  if (ledger === null) return;
  for (const c of refused) {
    if (c.refused === undefined) continue;
    recordOutcome(
      ledger,
      { name: c.name, verdict: 'blocked', bundle: null, reason: `authoring refused (attempt ${c.refused.attempt}): ${c.refused.reason}` },
      { authoringRefused: c.refused.attempt },
    );
  }
  const left = remaining(ledger).length;
  ledger.ended = {
    at: new Date().toISOString(),
    cause: left === 0 ? null : `${left} case(s) were never reached or never ran`,
    complete: left === 0,
  };
  await writeLedger(ledgerPath, ledger).catch(() => undefined);
}

/**
 * A sheet row as the database baseline reads it: the case id and every column
 * that can name a table in prose. Never the Actual column — a recorded result
 * describes a past run, not what this one will touch.
 */
function planRowText(row: TestCaseRow): { name: string; text: string } {
  return {
    name: row.caseId,
    text: [row.testCase, row.preconditions, row.testData, row.steps, row.expected, row.note]
      .filter((part) => typeof part === 'string' && part !== '')
      .join('\n'),
  };
}

/**
 * An authoring refusal as a person needs to read it: the summary line, then
 * every lint's complaint (`AuthoringError.messages`) as ` · ` bullets, capped so
 * a ledger row stays a row. A non-authoring error keeps its first line.
 */
function refusalText(error: Error): string {
  const first = error.message.split('\n')[0] ?? '';
  if (!(error instanceof AuthoringError) || error.messages.length <= 1 && error.messages[0] === error.message) {
    return first;
  }
  const bullets = error.messages.map((m) => m.split('\n')[0] ?? m).filter((m) => m !== '' && m !== first);
  const text = bullets.length === 0 ? first : `${first} · ${bullets.join(' · ')}`;
  return text.length > 1600 ? `${text.slice(0, 1597)}…` : text;
}
