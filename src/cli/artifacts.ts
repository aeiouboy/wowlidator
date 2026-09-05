/**
 * Where a run's artifacts land — flow files, machine reports, quarantine —
 * and the browser-lifecycle glue every browser command shares. Split out of
 * cli.ts verbatim.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { ensureChrome, ensureChromePool, portOf, stopChrome, waitForApp, type PoolMember } from '../browser/chrome.js';
import { poolMember } from '../browser/pool.js';
import type { ProofBundle } from '../engine/proof-bundle.js';
import { CONSENT_POLICIES, DEFAULT_CDP_URL, type Flow, type FlowStep } from '../engine/runner.js';
import { decideQuarantine } from '../history/quarantine.js';
import { RunHistory, type HistoryEntry } from '../history/run-history.js';
import { defaultReportFilename, reportGroupForUrl } from '../reporter/html-reporter.js';
import { writeCtrfReport, writeJUnitReport } from '../reporter/machine-report.js';
import { EXIT } from './exit.js';
import type { CliOptions } from './options.js';
import { lineLogger } from './runtime.js';

/**
 * The folder a page's artifacts share — its flow JSON and its report, together,
 * so everything about testing one page is in one place instead of scattered
 * between the project root and the reports directory.
 *
 * An explicit `--report` is not second-guessed: it decides where reports go,
 * and the flow stays here with the rest of the page's output.
 */
export function pageDir(options: CliOptions, group: string): string {
  return resolve(options.reportDir, group);
}

/**
 * The report and the flow share a basename, so `03-edge-case-pagination.html`
 * and `03-edge-case-pagination.flow.json` sit next to each other and it is
 * obvious which produced which.
 */
export function flowFilename(context: Parameters<typeof defaultReportFilename>[0]): string {
  return `${defaultReportFilename(context).replace(/\.html$/, '')}.flow.json`;
}

export async function writeFlowFile(path: string, flow: Flow): Promise<string> {
  const target = resolve(path);
  await mkdir(resolve(target, '..'), { recursive: true });
  await writeFile(target, `${JSON.stringify(flow, null, 2)}\n`, 'utf8');
  return target;
}

/**
 * Which page is this flow about? Its first navigation is the honest answer —
 * that is the page whose behaviour the assertions describe.
 */
export function groupForFlow(flow: Flow): string | undefined {
  const steps = [...(flow.setup ?? []), ...flow.steps];
  const firstGoto = steps.find((step): step is Extract<FlowStep, { action: 'goto' }> =>
    step.action === 'goto',
  );
  if (firstGoto === undefined) {
    return flow.baseUrl === undefined ? undefined : reportGroupForUrl(flow.baseUrl);
  }
  try {
    return reportGroupForUrl(new URL(firstGoto.url, flow.baseUrl).toString());
  } catch {
    return reportGroupForUrl(firstGoto.url);
  }
}

export function isFlow(value: unknown): value is Flow {
  if (typeof value !== 'object' || value === null) return false;
  if (!('name' in value) || typeof value.name !== 'string') return false;
  if (!('steps' in value) || !Array.isArray(value.steps)) return false;
  if (!('consentPolicy' in value) || value.consentPolicy === undefined) return true;
  return CONSENT_POLICIES.some((policy) => policy === value.consentPolicy);
}

/**
 * Mark a run quarantined when the caller asked for it and history agrees.
 *
 * Mutates the bundle rather than returning a copy because everything
 * downstream — the HTML report, JUnit, CTRF, the suite index — reads the same
 * object, and a quarantine that only some of them knew about would be worse
 * than none.
 */
export async function applyQuarantine(
  bundle: ProofBundle,
  options: CliOptions,
): Promise<{ quarantined: boolean; reason: string }> {
  // Read the same window `analyseTrend` used. `flaky` there means "two or more
  // flips in the last twenty runs", which stays true long after a test settles
  // down — so leaving quarantine needs its own evidence, and that evidence is
  // the recent history, not the verdict.
  let history: HistoryEntry[] = [];
  if (options.quarantineFlaky && options.history) {
    try {
      history = await new RunHistory(options.historyPath).forFlow(bundle.name);
    } catch {
      // Diagnostic, like everything else history-backed: an unreadable log
      // must not change a run's verdict.
    }
  }
  const decision = decideQuarantine(bundle, history, {
    enabled: options.quarantineFlaky,
  });
  if (decision.quarantined) {
    (bundle as { quarantined?: boolean }).quarantined = true;
    process.stdout.write(`  quarantine ${decision.reason}\n`);
  } else if (options.quarantineFlaky && bundle.status === 'failed') {
    process.stdout.write(`  quarantine not applied — ${decision.reason}\n`);
  }
  return decision;
}

/**
 * Emit whatever machine-readable formats were asked for.
 *
 * Kept in one place so `run`, `generate` and `author` cannot drift in what
 * they support — a CI job should not have to know which command produced the
 * results it is reading.
 */
export async function writeMachineReports(
  bundles: readonly ProofBundle[],
  options: CliOptions,
): Promise<void> {
  if (bundles.length === 0) return;
  if (options.junit) {
    const path = await writeJUnitReport(bundles, options.junit);
    process.stdout.write(`  junit      ${path}\n`);
  }
  if (options.ctrf) {
    const path = await writeCtrfReport(bundles, options.ctrf);
    process.stdout.write(`  ctrf       ${path}\n`);
  }
}

/**
 * Everything that has to be true before a browser command can run.
 *
 * This is the work `wowlidator.sh` used to do — find or fix a driveable Chrome,
 * wait for the application — moved into the CLI so that one command is the
 * whole story and the rules live next to the code that depends on them.
 *
 * Returns an exit code when it could not get there, or `null` to carry on.
 */
export async function prepare(options: CliOptions, appUrl?: string): Promise<number | null> {
  const log = lineLogger(options);

  if (options.waitFor) {
    const ready = await waitForApp(options.waitFor, 90_000, log);
    if (!ready) {
      process.stderr.write(`wowlidator: ${options.waitFor} did not respond within 90s\n`);
      return EXIT.environment;
    }
  }

  if (!options.ensureChrome) return null;

  const wanted = {
    cdpUrl: options.cdp ?? DEFAULT_CDP_URL,
    profile: options.chromeProfile,
    headless: options.headless,
    onLog: log,
  };
  // `--browsers <n>`: a pool of n Chromes for a parallel run, the primary on
  // the CDP port plus n-1 more on the ports after it, each on its own profile
  // (see `src/browser/pool.ts`). Every member is ensured by the same rules as
  // the single browser; a member that cannot be had fails the run the same
  // way, naming which one.
  const members: PoolMember[] =
    options.browsers !== undefined && options.browsers > 1
      ? await ensureChromePool(wanted, options.browsers)
      : [{ ...(await ensureChrome(wanted)), profile: options.chromeProfile }];
  chromePool = members.map((m) => ({ cdpUrl: m.cdpUrl, profile: m.profile, startedByUs: m.startedByUs }));
  chromeStartedByUs = members[0]?.startedByUs === true;

  for (const [i, result] of members.entries()) {
    const who = members.length > 1 ? `browser ${i + 1} of ${members.length}: ` : '';
    if (result.status === 'blocked' || result.status === 'missing-chrome' || result.status === 'failed') {
      // Environment, not usage: the invocation was right, the machine is not
      // ready, and CI has to be able to tell those apart.
      process.stderr.write(`wowlidator: ${who}${result.message}\n`);
      return EXIT.environment;
    }
    if (result.status !== 'ready') log?.(`${who}${result.message}`);
  }
  if (members.length > 1) {
    log?.(`browser pool: ${members.length} Chromes — ${members.map((m) => portOf(m.cdpUrl)).join(', ')}`);
  }

  // A reachability check on the page under test, when we know it. Failing here
  // beats failing on step 1 with a selector error about a page that never
  // loaded.
  // The page gets APP_REACH_GRACE_MS to answer, with a countdown on the
  // console (2026-09-04): a dev server that is a few seconds from up used to
  // fail the whole run on one 5 s probe.
  if (appUrl && !options.waitFor) {
    const ready = await waitForApp(appUrl, APP_REACH_GRACE_MS, log);
    if (!ready) {
      process.stderr.write(
        `wowlidator: cannot reach ${appUrl} after ${APP_REACH_GRACE_MS / 1000}s — is the app running?\n` +
          'Use --wait-for <url> to wait longer (90s) instead of failing.\n',
      );
      // The browsers were started for a run that is not going to happen;
      // `--stop-chrome` means what it says on this exit too. Without this a
      // pool left n headless Chromes behind every time the app was down.
      await cleanupChrome(options);
      return EXIT.environment;
    }
  }

  return null;
}

/** How long the page under test gets to answer before a run is refused, when `--wait-for` was not given. */
export const APP_REACH_GRACE_MS = 10_000;

/** Set by `prepare`; only a browser this process started may be stopped. */
let chromeStartedByUs = false;
/** Every browser `prepare` ensured, primary first — what a parallel run leases from. */
let chromePool: { cdpUrl: string; profile: string; startedByUs: boolean }[] = [];

/**
 * The CDP endpoints a parallel run may spread its lanes over, primary first.
 * One entry unless `--browsers` asked for more; empty before `prepare` ran
 * (or with `--no-ensure-chrome`), in which case a caller uses `options.cdp`.
 */
export function laneBrowsers(): readonly string[] {
  return chromePool.map((m) => m.cdpUrl);
}

/**
 * Make sure the pool holds at least `count` browsers — for a case that needs
 * one Chrome per persona when `--browsers` did not ask for that many up
 * front. Catalog runs author their flows in a pipeline, so how many people a
 * case signs in as is unknown when `prepare` runs; the pool grows the moment
 * a case says.
 *
 * Members are ensured by the same rules as the pool `prepare` builds (see
 * `ensureChromePool`): consecutive ports from the primary, own profiles,
 * headless unless `--no-headless` was said. A member that cannot be had is
 * reported and skipped — the case then shares a browser and says so — never
 * blocked: a missing Chrome is a convenience lost, not a verdict.
 *
 * Returns the pool as it stands afterwards, primary first. Empty when
 * `prepare` never ran (`--no-ensure-chrome`): there is no pool to grow, and
 * the caller falls back to `options.cdp` exactly as before.
 */
export async function growPool(options: CliOptions, count: number): Promise<readonly string[]> {
  if (chromePool.length === 0 || !options.ensureChrome) return laneBrowsers();
  const primary = chromePool[0]!;
  const log = lineLogger(options);
  const wanted = Math.max(1, Math.floor(count));
  for (let i = chromePool.length; i < wanted; i += 1) {
    const member = poolMember(primary.cdpUrl, options.chromeProfile, i);
    const result = await ensureChrome({
      cdpUrl: member.cdpUrl,
      profile: member.profile,
      headless: options.headless ?? true,
      onLog: log ? (line): void => log(`[browser ${i + 1}] ${line}`) : undefined,
    });
    if (result.status === 'blocked' || result.status === 'missing-chrome' || result.status === 'failed') {
      process.stderr.write(`wowlidator: browser ${i + 1}: ${result.message} — personas will share a Chrome\n`);
      break;
    }
    chromePool.push({ cdpUrl: result.cdpUrl, profile: member.profile, startedByUs: result.startedByUs });
  }
  if (chromePool.length > 1) {
    log?.(`browser pool: ${chromePool.length} Chromes — ${chromePool.map((m) => portOf(m.cdpUrl)).join(', ')}`);
  }
  return laneBrowsers();
}

/** Stop the browser(s), if we started them and were asked to. */
export async function cleanupChrome(options: CliOptions): Promise<void> {
  if (!options.stopChrome) return;
  const ours = chromePool.length > 0
    ? chromePool.filter((m) => m.startedByUs)
    : chromeStartedByUs
      ? [{ cdpUrl: options.cdp ?? DEFAULT_CDP_URL, profile: options.chromeProfile, startedByUs: true }]
      : [];
  if (ours.length === 0) return;
  lineLogger(options)?.(
    ours.length === 1 ? 'stopping the Chrome this run started' : `stopping the ${ours.length} Chromes this run started`,
  );
  await Promise.all(ours.map((m) => stopChrome(portOf(m.cdpUrl), m.profile)));
}

/** Open a file with the platform's default handler. */
export async function openReport(path: string | null, options: CliOptions): Promise<void> {
  if (!path || !options.open) return;
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const { spawn } = await import('node:child_process');
  spawn(opener, [path], { detached: true, stdio: 'ignore' }).unref();
}

/**
 * Where a case's flow file goes.
 *
 * `--flow` names one file, and there may now be several. Numbering inside the
 * name the caller gave keeps their directory and extension and makes the
 * relationship obvious — silently overwriting it once per case would leave them
 * with the last case and no sign the others existed.
 */
export function catalogFlowPath(
  options: CliOptions,
  context: { dir: string; group: string | undefined; name: string; index: number | undefined },
): string {
  if (options.flow === undefined) {
    return join(
      context.dir,
      flowFilename({
        runId: '',
        name: context.name,
        status: 'catalog',
        group: context.group,
        ...(context.index === undefined ? {} : { index: context.index }),
      }),
    );
  }
  const target = resolve(options.flow);
  if (context.index === undefined) return target;
  return target.replace(/(\.flow)?\.json$/i, '') + `.${context.index}.flow.json`;
}
