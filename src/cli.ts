#!/usr/bin/env node
/**
 * Local developer entrypoint.
 *
 *   wowlidator run <flow.json>   execute a flow against the CDP-attached browser
 *   wowlidator generate <url>    let an LLM write the tests by reading the page
 *   wowlidator author "<prompt>" turn a described test into one runnable flow
 *   wowlidator doctor            verify provider keys and model ids resolve
 *   wowlidator data check <cat>  do the sheet's test-data codes exist, are they free, can the UI reach them
 *   wowlidator cache list        inspect healed selectors
 *   wowlidator cache forget      invalidate a repair (or all of them)
 *   wowlidator ui                open the control panel in a browser (--wow for wowUI)
 *   wowlidator mcp               serve the MCP interface over stdio
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { DEFAULT_CHROME_PROFILE } from './browser/chrome.js';
import { DEFAULT_MAX_CLAIMS } from './catalog/catalog.js';
import { DEFAULT_MAX_DRAFT_CASES } from './catalog/draft.js';
import { loadConfig, loadDotEnv, type WowlidatorConfig } from './config.js';
import { VIDEO_MODES, parseVideoMode } from './engine/video.js';
import { DEFAULT_MUTATION_POLICY, MUTATION_POLICIES, type MutationPolicy } from './generator/test-generator.js';
import { LaunchPresets, formatPresetLine } from './history/launch-presets.js';
import { main as mcpMain } from './mcp/server.js';
import { closeClaudeSessions } from './providers/claude-cli-session.js';
import { closeClaudeRetrievalServer } from './providers/claude-retrieval.js';
import { LlmFactory } from './providers/llm-factory.js';
import { DEFAULT_MAX_REPAIR_ATTEMPTS } from './repair/flow-repair-loop.js';
import { EXIT, classifyError } from './cli/exit.js';
import {
  LAUNCH_COMMANDS,
  SCREENSHOT_MODES,
  parseCaptureDelay,
  parseCaseTimeout,
  parseContextBudget,
  parseScope,
  parseCredentials,
  parsePersonas,
  parseScreenshotMode,
  resolveBrowsers,
  resolveHeadless,
  type CliOptions,
} from './cli/options.js';
import { USAGE } from './cli/usage.js';
import { cmdAuthor, cmdCatalog, cmdDraft, cmdGenerate } from './cli/commands/authoring.js';
import { cmdGo } from './cli/commands/go.js';
import { cmdCache, cmdCatalogReport, cmdContext, cmdData, cmdDb, cmdDoctor, cmdHistory } from './cli/commands/maintenance.js';
import { cmdCrawl, cmdRun, cmdWatch } from './cli/commands/run.js';

// Re-exported for the tests (tests/suite-outcomes.test.ts) and for embedders
// that were importing these from here before the split into src/cli/.
export { EXIT, harnessOnly, neverRan, suiteExit, exitCodeFor, classifyError } from './cli/exit.js';
export type { CaseOutcome } from './cli/exit.js';

/**
 * `wowlidator recall` — list saved launch presets, or re-execute one.
 *
 *   wowlidator recall            list them, newest first
 *   wowlidator recall last       re-run the most recent launch
 *   wowlidator recall <n>        re-run the n-th entry from the list
 *
 * Re-execution goes back through `main()` with the saved argv verbatim, so a
 * recalled run behaves exactly as if the user had typed it again — including
 * saving nothing new when the invocation is identical to the last one.
 */
async function cmdRecall(ref: string | undefined, json: boolean): Promise<number> {
  const presets = new LaunchPresets();

  if (ref === undefined || ref === 'list') {
    const all = await presets.list();
    if (json) {
      process.stdout.write(`${JSON.stringify(all, null, 2)}\n`);
      return 0;
    }
    if (all.length === 0) {
      process.stdout.write('no launch presets saved yet — run something first\n');
      return 0;
    }
    process.stdout.write('saved launches (newest first):\n');
    all.forEach((preset, i) => process.stdout.write(`${formatPresetLine(preset, i)}\n`));
    process.stdout.write('\nre-run one with: wowlidator recall last | wowlidator recall <n>\n');
    return 0;
  }

  const preset = await presets.get(ref);
  if (!preset) {
    process.stderr.write(`wowlidator: no saved launch matches "${ref}" — see \`wowlidator recall\`\n`);
    return 2;
  }
  process.stderr.write(`[wowlidator] recalling: wowlidator ${preset.argv.join(' ')}\n`);
  return main(preset.argv);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // Handled before `parseArgs` because the panel has its own two flags
  // (`--port`, `--no-open`) and adding them to the shared option table would
  // make them appear valid on every other command, where they mean nothing.
  if (argv[0] === 'ui') {
    const { main: uiMain } = await import('./ui/server.js');
    return uiMain(argv.slice(1));
  }

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cdp: { type: 'string' },
      cache: { type: 'string' },
      out: { type: 'string' },
      report: { type: 'string' },
      'report-dir': { type: 'string' },
      'no-report': { type: 'boolean', default: false },
      screenshots: { type: 'string' },
      video: { type: 'string' },
      humanize: { type: 'string' },
      // parseArgs has no --no-x negation, so this is opt-in as written.
      'agent-assist': { type: 'boolean', default: false },
      // parseArgs has no `--no-x` negation, so these are declared as written.
      probe: { type: 'boolean', default: false },
      'capture-journey': { type: 'boolean', default: false },
      'capture-delay': { type: 'string' },
      'step-delay': { type: 'string' },
      'max-pages': { type: 'string' },
      'max-heal': { type: 'string' },
      concurrency: { type: 'string' },
      'author-concurrency': { type: 'string' },
      'author-attempts': { type: 'string' },
      'author-lookahead': { type: 'string' },
      'follow-buttons': { type: 'boolean', default: false },
      'no-ensure-chrome': { type: 'boolean', default: false },
      'chrome-profile': { type: 'string' },
      headless: { type: 'boolean', default: false },
      // `parseArgs` has no --no-x negation, same as --no-heal and --no-agent.
      'no-headless': { type: 'boolean', default: false },
      'stop-chrome': { type: 'boolean', default: false },
      browsers: { type: 'string' },
      'wait-for': { type: 'string' },
      open: { type: 'boolean', default: false },
      timeout: { type: 'string' },
      'case-timeout': { type: 'string' },
      every: { type: 'string' },
      notify: { type: 'string' },
      'until-fail': { type: 'boolean', default: false },
      'quarantine-flaky': { type: 'boolean', default: false },
      junit: { type: 'string' },
      ctrf: { type: 'string' },
      'no-heal': { type: 'boolean', default: false },
      'no-agent': { type: 'boolean', default: false },
      // Declared literally, like `no-heal`/`no-agent`: parseArgs has no
      // `--no-x` negation. Backend testing stays ON by default — the
      // behaviour every run had before the toggle existed.
      'no-backend': { type: 'boolean', default: false },
      // Accepted and ignored — backend testing is already the default. It
      // exists so the panel can state its choice in both directions rather
      // than relying on a default the two surfaces disagree about.
      backend: { type: 'boolean', default: false },
      'no-agent-capture': { type: 'boolean', default: false },
      'no-target-highlight': { type: 'boolean', default: false },
      'db-baseline': { type: 'string' },
      'db-baseline-tables': { type: 'string' },
      'no-author-review': { type: 'boolean', default: false },
      'no-value-resolution': { type: 'boolean', default: false },
      'no-reconstruct': { type: 'boolean', default: false },
      'no-agent-early-stop': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      focus: { type: 'string' },
      'max-cases': { type: 'string' },
      policy: { type: 'string' },
      'update-baselines': { type: 'boolean', default: false },
      'no-history': { type: 'boolean', default: false },
      suite: { type: 'string' },
      flow: { type: 'string' },
      url: { type: 'string' },
      run: { type: 'boolean', default: false },
      context: { type: 'boolean', default: false },
      root: { type: 'string' },
      repo: { type: 'string' },
      as: { type: 'string' },
      // Credentials by persona label, repeatable; the password never reaches a
      // flow file — the label does. Also WOWLIDATOR_PERSONAS. See `parsePersonas`.
      persona: { type: 'string', multiple: true },
      // A workbook catalog sliced to a worksheet / a Category (CG-11), both
      // repeatable and case-insensitive.
      sheet: { type: 'string', multiple: true },
      category: { type: 'string', multiple: true },
      // Author the rows the sheet records as Blocked / Pending on purpose
      // (CG-01). Declared literally: parseArgs has no --no-x negation and the
      // default is the gate.
      'include-blocked': { type: 'boolean', default: false },
      'context-out': { type: 'string' },
      force: { type: 'boolean', default: false },
      'sheet-order': { type: 'boolean', default: false },
      repair: { type: 'boolean', default: false },
      'repair-attempts': { type: 'string' },
      'repair-investigate': { type: 'boolean', default: false },
      'repair-regenerate': { type: 'boolean', default: false },
      openapi: { type: 'string' },
      'db-schema': { type: 'string' },
      // `data check`: the master-data lookup declaration. Not on CliOptions —
      // the one command that reads it takes it beside the options, so no other
      // command grows a field it never reads.
      'master-data': { type: 'string' },
      api: { type: 'boolean', default: false },
      // Catalogs. `context-doc` rather than `context`: `--context` already
      // means the static repository index, and two things called context would
      // be one flag away from silently doing the other's job.
      'claims-only': { type: 'boolean', default: false },
      claims: { type: 'string' },
      resume: { type: 'boolean', default: false },
      'rerun-vacuous': { type: 'boolean', default: false },
      'rerun-errors': { type: 'boolean', default: false },
      'resume-from': { type: 'string' },
      'rerun-failed': { type: 'boolean', default: false },
      'rerun-case': { type: 'string', multiple: true },
      'claims-out': { type: 'string' },
      'catalog-out': { type: 'string' },
      'max-cases-drafted': { type: 'string' },
      'context-doc': { type: 'string', multiple: true },
      'max-claims': { type: 'string' },
      'context-budget': { type: 'string' },
      scope: { type: 'string' },
      'no-network': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const command = positionals[0];

  if (values.help || command === undefined || command === 'help') {
    process.stdout.write(USAGE);
    return command === undefined && !values.help ? 2 : 0;
  }

  // Save the invocation the moment a launch command starts — BEFORE config,
  // flow loading, or the browser get a chance to fail — so a task that dies
  // before any test runs is still recallable with `wowlidator recall`.
  if (LAUNCH_COMMANDS.has(command)) {
    await new LaunchPresets().save({
      savedAt: new Date().toISOString(),
      command,
      argv: [...argv],
      cwd: process.cwd(),
    });
  }

  if (command === 'recall') {
    return cmdRecall(positionals[1], values.json === true);
  }

  const policy = (values.policy ?? DEFAULT_MUTATION_POLICY) as MutationPolicy;
  if (!(MUTATION_POLICIES as readonly string[]).includes(policy)) {
    process.stderr.write(`wowlidator: --policy must be one of ${MUTATION_POLICIES.join(', ')}\n`);
    return 2;
  }

  const repairAttempts =
    values['repair-attempts'] === undefined
      ? DEFAULT_MAX_REPAIR_ATTEMPTS
      : Number(values['repair-attempts']);
  if (!Number.isInteger(repairAttempts) || repairAttempts < 1) {
    process.stderr.write('wowlidator: --repair-attempts must be a positive integer\n');
    return 2;
  }

  const maxCases = values['max-cases'] === undefined ? 6 : Number(values['max-cases']);
  if (!Number.isInteger(maxCases) || maxCases < 1) {
    process.stderr.write('wowlidator: --max-cases must be a positive integer\n');
    return 2;
  }

  const maxClaims =
    values['max-claims'] === undefined ? DEFAULT_MAX_CLAIMS : Number(values['max-claims']);
  if (!Number.isInteger(maxClaims) || maxClaims < 1) {
    process.stderr.write('wowlidator: --max-claims must be a positive integer\n');
    return 2;
  }

  // Before the credential parsers: `WOWLIDATOR_AS` and `WOWLIDATOR_PERSONAS` are
  // documented as living in `.env`, and both are read from `process.env` at
  // parse time — loaded after them, every persona in the file "had no credentials".
  loadDotEnv();

  const credentials = parseCredentials(values.as);
  if (credentials === null) {
    process.stderr.write(
      'wowlidator: --as must be <email>:<password> — both halves are required ' +
        '(the password may contain colons; the first colon separates them)\n',
    );
    return 2;
  }

  const personas = parsePersonas(values.persona);
  if (!personas.ok) {
    process.stderr.write(`wowlidator: ${personas.error}\n`);
    return 2;
  }

  const scope = parseScope(values.scope);
  if (scope === null) {
    process.stderr.write('wowlidator: --scope must be unit or e2e\n');
    return 2;
  }

  const contextBudget = parseContextBudget(values['context-budget']);
  if (contextBudget === null) {
    process.stderr.write(
      'wowlidator: --context-budget must be a non-negative integer (characters; 0 sends every context document whole)\n',
    );
    return 2;
  }

  let config: WowlidatorConfig;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`wowlidator: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  // After `loadConfig`, so `WOWLIDATOR_SCREENSHOTS` is the fallback rather than a
  // setting the CLI reads and then discards.
  const screenshots = parseScreenshotMode(values.screenshots, config.screenshots);
  if (screenshots === null) {
    process.stderr.write(
      `wowlidator: --screenshots must be one of ${SCREENSHOT_MODES.join(', ')}\n`,
    );
    return 2;
  }

  // Same ladder as --screenshots: the flag beats WOWLIDATOR_VIDEO, and an
  // unrecognised value is refused rather than quietly read as "off" — a typo
  // that silently stopped recording would be discovered as a report with no
  // video in it and no reason given.
  const video = values.video === undefined ? config.video : parseVideoMode(values.video);
  if (video === null) {
    process.stderr.write(`wowlidator: --video must be one of ${VIDEO_MODES.join(', ')}\n`);
    return 2;
  }

  // `--humanize on|off` beats WOWLIDATOR_HUMANIZE; unset lets the runner
  // follow the recording (on while filming). Refused rather than guessed.
  const humanizeRaw = values.humanize;
  const humanize =
    humanizeRaw === undefined || humanizeRaw === 'auto'
      ? config.humanize
      : /^(on|1|true|yes)$/i.test(humanizeRaw)
        ? true
        : /^(off|0|false|no)$/i.test(humanizeRaw)
          ? false
          : null;
  if (humanize === null) {
    process.stderr.write('wowlidator: --humanize must be on, off or auto\n');
    return 2;
  }

  // Same rule as --screenshots: the flag overrides WOWLIDATOR_CAPTURE_DELAY_MS,
  // and an unparseable value is an error rather than a silent fallback — a
  // typo'd delay would otherwise be discovered as a filmstrip of blank frames.
  const captureDelayMs = parseCaptureDelay(values['capture-delay'], config.captureDelayMs);
  const caseTimeoutMs = parseCaseTimeout(values['case-timeout']);
  const stepDelayRaw = values['step-delay'] ?? process.env['WOWLIDATOR_STEP_DELAY'];
  const stepDelayMs =
    stepDelayRaw === undefined || stepDelayRaw === ''
      ? undefined
      : Number.isFinite(Number(stepDelayRaw)) && Number(stepDelayRaw) >= 0
        ? Number(stepDelayRaw)
        : undefined;
  if (captureDelayMs === null) {
    process.stderr.write('wowlidator: --capture-delay must be a number of milliseconds\n');
    return 2;
  }
  if (caseTimeoutMs === null) {
    process.stderr.write('wowlidator: --case-timeout must be a non-negative integer number of seconds, or off\n');
    return 2;
  }

  const options: CliOptions = {
    config,
    factory: new LlmFactory(config),
    cdp: values.cdp ?? config.cdpUrl,
    cache: values.cache ?? config.cachePath,
    out: values.out ?? config.proofDir,
    report: values.report ?? config.reportPath,
    reportDir: values['report-dir'] ?? config.reportDir,
    reportEnabled: values['no-report'] !== true && config.reportEnabled,
    screenshots,
    video,
    humanize,
    agentAssist: values['agent-assist'] === true || config.agentAssist,
    agentCapture: values['no-agent-capture'] !== true,
    highlightTarget: values['no-target-highlight'] !== true,
    dbBaseline: values['db-baseline'],
    dbBaselineTables: (values['db-baseline-tables'] ?? process.env['WOWLIDATOR_DB_BASELINE_TABLES'] ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== ''),
    authorReview: values['no-author-review'] !== true,
    valueResolution: values['no-value-resolution'] !== true && process.env['WOWLIDATOR_VALUE_RESOLUTION'] !== 'off',
    // Three retry rules, each toggleable by flag AND by env (so a run started
    // from a terminal or the panel obeys the same `.env` line):
    //  - reconstruction (retry a failed step up to 3×): --no-reconstruct, or
    //    WOWLIDATOR_RECONSTRUCT=off.
    reconstruct:
      values['no-reconstruct'] !== true &&
      process.env['WOWLIDATOR_RECONSTRUCT']?.trim().toLowerCase() !== 'off',
    //  - the agent's early give-up (look-only 3 / no-progress 5): the flag
    //    forces off; otherwise the agent reads WOWLIDATOR_AGENT_EARLY_STOP.
    agentEarlyStop: values['no-agent-early-stop'] === true ? false : undefined,
    captureDelayMs,
    stepDelayMs,
    heal: values['no-heal'] !== true,
    agent: values['no-agent'] !== true,
    backend: values['no-backend'] !== true,
    json: values.json,
    all: values.all,
    focus: values.focus,
    maxCases,
    suite: values.suite,
    flow: values.flow,
    url: values.url,
    run: values.run,
    policy,
    updateBaselines: values['update-baselines'],
    history: values['no-history'] !== true,
    context: values.context,
    probe: values.probe,
    captureJourney: values['capture-journey'] === true,
    maxPages: values['max-pages'] === undefined ? undefined : Number(values['max-pages']),
    maxHeal: values['max-heal'] === undefined ? undefined : Number(values['max-heal']),
    concurrency:
      values['concurrency'] === undefined ? undefined : Number(values['concurrency']),
    authorConcurrency:
      values['author-concurrency'] === undefined
        ? undefined
        : Number(values['author-concurrency']),
    authorAttempts:
      values['author-attempts'] === undefined ? undefined : Number(values['author-attempts']),
    authorLookahead:
      values['author-lookahead'] === undefined
        ? undefined
        : values['author-lookahead'] === 'all'
          ? ('all' as const)
          : Number(values['author-lookahead']),
    followButtons: values['follow-buttons'] === true,
    ensureChrome: values['no-ensure-chrome'] !== true,
    chromeProfile: values['chrome-profile'] ?? DEFAULT_CHROME_PROFILE,
    headless: resolveHeadless(values.headless === true, values['no-headless'] === true),
    stopChrome: values['stop-chrome'] === true,
    browsers: resolveBrowsers(values.browsers),
    waitFor: values['wait-for'],
    open: values.open === true,
    timeoutMs: values.timeout === undefined ? undefined : Number(values.timeout) * 1000,
    caseTimeoutMs,
    every: values.every,
    notify: values.notify,
    untilFail: values['until-fail'] === true,
    quarantineFlaky: values['quarantine-flaky'] === true,
    junit: values.junit ?? process.env['WOWLIDATOR_JUNIT_PATH'],
    ctrf: values.ctrf ?? process.env['WOWLIDATOR_CTRF_PATH'],
    root: values.root,
    repo: values.repo,
    credentials,
    personas: personas.personas,
    includeBlocked: values['include-blocked'] === true,
    sheets: values.sheet ?? [],
    categories: values.category ?? [],
    contextOut: values['context-out'],
    force: values.force,
    // Either refinement implies the loop itself — asking for an investigated
    // or regenerating repair is asking for a repair.
    resume:
      values.resume === true ||
      values['rerun-vacuous'] === true ||
      values['rerun-errors'] === true ||
      values['rerun-failed'] === true ||
      (Array.isArray(values['rerun-case']) && values['rerun-case'].length > 0) ||
      typeof values['resume-from'] === 'string',
    resumeFrom: typeof values['resume-from'] === 'string' ? values['resume-from'] : undefined,
    rerunVacuous: values['rerun-vacuous'] === true,
    rerunErrors: values['rerun-errors'] === true,
    rerunFailed: values['rerun-failed'] === true,
    rerunCases: Array.isArray(values['rerun-case']) && values['rerun-case'].length > 0 ? values['rerun-case'] : undefined,
    sheetOrder: values['sheet-order'] === true,
    //  - whole-flow repair (rerun a failed case up to N attempts): --repair,
    //    the rerun/investigate/regenerate flags, or WOWLIDATOR_REPAIR=on.
    repair:
      values.repair ||
      values['rerun-failed'] === true || values['repair-investigate'] === true || values['repair-regenerate'] === true ||
      process.env['WOWLIDATOR_REPAIR']?.trim().toLowerCase() === 'on',
    repairAttempts,
    repairInvestigate: values['repair-investigate'] === true,
    repairRegenerate: values['repair-regenerate'] === true,
    openapi: values.openapi,
    dbSchema: values['db-schema'],
    api: values.api,
    network: values['no-network'] !== true,
    claimsOnly: values['claims-only'] === true,
    claims: values.claims,
    claimsOut: values['claims-out'],
    historyPath: resolve(config.historyPath),
    catalogOut: values['catalog-out'],
    maxDraftCases:
      values['max-cases-drafted'] === undefined
        ? DEFAULT_MAX_DRAFT_CASES
        : Number(values['max-cases-drafted']),
    contextDocs: values['context-doc'] ?? [],
    contextBudget,
    scope,
    maxClaims,
  };

  switch (command) {
    case 'run':
      // Several flow files run as one suite — see `cmdRun`.
      return cmdRun(positionals.slice(1), options);
    case 'generate':
      return cmdGenerate(positionals[1], options);
    case 'author':
      // Join the tail so an unquoted prompt still works.
      return cmdAuthor(positionals.slice(1).join(' ').trim() || undefined, options);
    case 'catalog':
      return cmdCatalog(positionals[1], options);
    case 'draft':
      return cmdDraft(positionals[1], options);
    case 'cache':
      return cmdCache(positionals[1], positionals[2], options);
    case 'history':
      return cmdHistory(positionals[1], options);
    case 'context':
      return cmdContext(positionals[1], options, positionals[2]);
    case 'go':
      return cmdGo(positionals.slice(1).join(' ') || undefined, options);
    case 'crawl':
      return cmdCrawl(positionals[1], options);
    case 'watch':
      return cmdWatch(positionals[1], options);
    case 'doctor':
      return cmdDoctor(options);
    case 'report':
      return cmdCatalogReport(positionals[1], options);
    case 'db':
      return cmdDb(positionals[1], positionals[2], options);
    case 'data':
      return cmdData(positionals[1], positionals[2], options, { masterData: values['master-data'] });
    case 'mcp':
      await mcpMain();
      return 0;
    // `ui` is dispatched above, before parseArgs — this arm only exists so
    // `wowlidator help` and the switch tell the same story.
    case 'ui':
      return (await import('./ui/server.js')).main([]);
    default:
      process.stderr.write(`wowlidator: unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The drained-loop watchdog. A CDP websocket that dies mid-await can leave
  // a promise that never settles; with nothing else keeping the loop alive,
  // node just exits — code 0, zero output, a run that reports SUCCESS about
  // work it silently abandoned (seen live: a concurrent wowlidator run recycled
  // Chrome mid-authoring and the suite "passed" out of existence). `beforeExit`
  // fires exactly then, and an unfinished main() there is an environment fact.
  let mainSettled = false;
  process.on('beforeExit', () => {
    if (mainSettled) return;
    mainSettled = true; // say it once — beforeExit can fire again
    process.stderr.write(
      'wowlidator: the event loop drained before the command finished — a connection died ' +
        'without rejecting its waiters (usually the browser being closed or recycled under ' +
        'the run, e.g. by a second wowlidator run sharing the same Chrome). Nothing after ' +
        'that point ran; treat this run as blocked, not as a result.\n',
    );
    process.exitCode = EXIT.environment;
  });
  // Warm `claude` processes are spawned with piped stdio, and those pipes hold
  // the event loop open after main() has settled: a run whose last model call
  // landed at T exited at T + SESSION_IDLE_MS (90 s), every artefact written
  // within three seconds of the last step (job-5, 2026-09-04). The idle timer
  // is unref'd — the child is not — so the sessions are closed here explicitly.
  const releaseControlPlane = (): void => {
    closeClaudeSessions();
    closeClaudeRetrievalServer();
  };
  main().then(
    (code) => {
      mainSettled = true;
      process.exitCode = code;
      releaseControlPlane();
    },
    (error: unknown) => {
      mainSettled = true;
      process.stderr.write(`wowlidator: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = classifyError(error);
      releaseControlPlane();
    },
  );
}
