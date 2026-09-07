/**
 * The commands that look after the engine's own state: doctor, cache,
 * history, and context. Split out of cli.ts verbatim.
 */

import { readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { CacheManager } from '../../cache/cache-manager.js';
import { connectDb, defaultDbConfig, maskDsn } from '../../db/client.js';
import { LLM_ROLES, describeRouting } from '../../config.js';
import { ContextEngine } from '../../context/context-engine.js';
import { detectDbHint } from '../../context/db-hint.js';
import {
  graphFileFor,
  listRepos,
  mergedContextDocs,
  mergedScanInputs,
  resolveRepo,
  slugFor,
  upsertRepo,
} from '../../context/repo-registry.js';
import { SUPPORTED_EXTENSIONS, formatFor } from '../../catalog/extract.js';
import { summarize as summarizeContext } from '../../context/query.js';
import { RunHistory } from '../../history/run-history.js';
import { probeIsUsable, probeRole } from '../../providers/probe.js';
import type { CliOptions } from '../options.js';

import type { Browser } from 'playwright';

import type { TestCaseRow } from '../../catalog/test-case-table.js';
import type { FetchJson, LookupGrounding, MasterDataLookup } from '../../context/master-data.js';

interface DataTransport {
  readonly fetchJson: FetchJson;
  readonly notes: string[];
  readonly closeTransport?: (() => Promise<void>) | undefined;
}

type DataTransportBuild = DataTransport | { readonly exit: number };

/**
 * Verify each role end to end: key present, provider constructs, model id
 * actually resolves against the live API. Model ids drift far faster than this
 * codebase does, so this is the command that turns "should work" into "does".
 */
export async function cmdDoctor(options: CliOptions): Promise<number> {
  process.stdout.write(`wowlidator routing\n${describeRouting(options.config)}\n\n`);

  let failures = 0;
  for (const role of LLM_ROLES) {
    const entry = options.config.roles[role];
    const label = `${role.padEnd(9)} ${entry.provider}:${entry.modelId}`;

    // The probe is shared with the panel's Machinery page: one real call over
    // the failover path a run would take, classified by cause. Sequential
    // here on purpose — a rotation discovered for one role stays active for
    // every later role sharing the provider, which is what a run gets too.
    const probe = await probeRole(options.factory, role);
    if (!probeIsUsable(probe.status)) {
      process.stdout.write(`  ✗ ${label}\n      ${probe.detail}\n`);
      for (const attempt of probe.attempts.slice(0, -1)) {
        process.stdout.write(`      key ${attempt.keyIndex + 1}: ${attempt.detail}\n`);
      }
      failures += 1;
      continue;
    }
    const mark = probe.status === 'empty' ? '!' : '✓';
    const reply = probe.reply === null ? '' : ` (${JSON.stringify(probe.reply)})`;
    const quota =
      probe.quota?.remainingTokens !== null && probe.quota?.remainingTokens !== undefined
        ? `\n      ${probe.quota.remainingTokens.toLocaleString()} tokens left` +
          (probe.quota.limitTokens !== null ? ` of ${probe.quota.limitTokens.toLocaleString()}` : '') +
          (probe.quota.resetTokens !== null ? ` (resets in ${probe.quota.resetTokens})` : '')
        : '';
    process.stdout.write(`  ${mark} ${label}\n      ${probe.detail}${reply}${quota}\n`);
    for (const attempt of probe.attempts) {
      process.stdout.write(`      key ${attempt.keyIndex + 1}: ${attempt.detail}\n`);
    }
  }

  // The database, on the same make-a-real-call philosophy as the roles: a
  // SELECT 1 over the exact connection a run would use, plus the schema read
  // the grounding gate depends on. Printed only when a connection is
  // configured — silence for the unconfigured majority, the no-spec rule.
  const dbConfig = defaultDbConfig();
  if (dbConfig !== null) {
    const started = Date.now();
    try {
      const client = await connectDb(dbConfig);
      try {
        await client.query('SELECT 1', []);
        const schema = await client.introspect();
        process.stdout.write(
          `\n  ✓ db        ${maskDsn(dbConfig.url ?? '')}\n` +
            `      read-only session up in ${Date.now() - started}ms — ${schema.tables.length} table(s) visible\n`,
        );
      } finally {
        await client.close().catch(() => undefined);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
      process.stdout.write(`\n  ✗ db        ${detail}\n`);
      failures += 1;
    }
  }

  process.stdout.write(
    failures === 0
      ? '\nall roles reachable\n'
      : `\n${failures} role(s) unusable — see above\n`,
  );
  return failures === 0 ? 0 : 1;
}

export async function cmdCache(
  sub: string | undefined,
  key: string | undefined,
  options: CliOptions,
): Promise<number> {
  const cache = new CacheManager(options.cache === undefined ? {} : { filePath: options.cache });
  await cache.load();

  switch (sub) {
    case 'list': {
      const entries = cache.entries();
      if (entries.length === 0) {
        process.stdout.write(`no healed selectors in ${cache.filePath}\n`);
        return 0;
      }
      process.stdout.write(`${entries.length} healed selector(s) in ${cache.filePath}\n\n`);
      for (const entry of entries) {
        process.stdout.write(
          `${entry.key}\n` +
            `  -> ${entry.healed}  [${entry.strategy}, confidence ${entry.confidence.toFixed(2)}, ${entry.hits} hit(s)]\n` +
            `     ${entry.reasoning}\n\n`,
        );
      }
      return 0;
    }

    case 'forget': {
      if (options.all) {
        const removed = cache.size;
        cache.clear();
        await cache.flush();
        process.stdout.write(`cleared ${removed} entr${removed === 1 ? 'y' : 'ies'}\n`);
        return 0;
      }
      if (!key) {
        process.stderr.write('wowlidator cache forget: provide a key or --all\n');
        return 2;
      }
      const deleted = cache.delete(key);
      await cache.flush();
      process.stdout.write(deleted ? `forgot ${key}\n` : `no cache entry for ${key}\n`);
      return deleted ? 0 : 1;
    }

    default:
      process.stderr.write(`wowlidator cache: unknown subcommand ${sub ?? '(none)'}\n`);
      return 2;
  }
}

/**
 * Forget past runs.
 *
 * Two stores, cleared together, because the UI reads one and the trend reads
 * the other and clearing half of either leaves them disagreeing: the proof
 * bundles are the runs themselves — every step, screenshot and heal — and
 * `history.jsonl` is the thin index the trend verdict is computed from. Delete
 * only the index and the runs stay listed; delete only the bundles and the
 * next run is told it is "still broken" by runs nobody can look at any more.
 *
 * Reports are left alone. They are self-contained files someone may have
 * linked or filed somewhere, and this command is about the engine's own state,
 * not about anything already handed to a person.
 */
export async function cmdHistory(sub: string | undefined, options: CliOptions): Promise<number> {
  switch (sub) {
    case 'clear': {
      const proofDir = resolve(options.out);
      let bundles = 0;
      let names: string[] = [];
      try {
        names = await readdir(proofDir);
      } catch {
        // No proof directory is the same outcome as an empty one.
        names = [];
      }
      for (const name of names) {
        // Only what this engine writes there. A path is never taken from
        // input — the name comes from the directory listing itself — and
        // anything that is not a bundle is left exactly where it is.
        if (!name.endsWith('.json')) continue;
        await rm(join(proofDir, name), { force: true });
        bundles += 1;
      }

      // There is one history index and it does not move with `--out`, so
      // clearing a redirected proof directory must not empty it: the runs it
      // indexes are the ones still sitting in the *default* directory, and
      // deleting their trend while keeping the bundles is the half-cleared
      // state this command exists to avoid. Pointing `--out` somewhere else is
      // therefore a narrower operation, and says so rather than doing more
      // than it was asked to.
      const scoped = proofDir !== resolve(options.config.proofDir);
      const forgotten = scoped ? 0 : await new RunHistory(options.historyPath).clear();

      process.stdout.write(
        `cleared ${bundles} proof bundle(s) from ${proofDir}\n` +
          (scoped
            ? `kept the run history index — it belongs to ${resolve(options.config.proofDir)}\n`
            : `cleared ${forgotten} history entr${forgotten === 1 ? 'y' : 'ies'}\n`),
      );
      return 0;
    }

    default:
      process.stderr.write(`wowlidator history: unknown subcommand ${sub ?? '(none)'}\n`);
      return 2;
  }
}

export async function cmdContext(
  sub: string | undefined,
  options: CliOptions,
  arg?: string,
): Promise<number> {
  const engine = new ContextEngine({
    rootDir: options.root,
    cacheFile: options.contextOut,
    openApiSpec: options.openapi,
    dbSchema: options.dbSchema,
    // Introspection fallback: when no schema file exists but a connection is
    // configured, the live database is the source of truth.
    dbUrl: process.env['WOWLIDATOR_DB_URL'],
    dbRemoteOk: process.env['WOWLIDATOR_DB_REMOTE_OK'] === '1',
  });

  switch (sub) {
    // Scan a repository and REMEMBER it — the difference from `build`, whose
    // single cache file is last-writer-wins. Saved repos are selected on a run
    // with `--repo <slug|path>` (or the wowUI dropdown).
    case 'add': {
      if (!arg) {
        process.stderr.write('wowlidator context add: missing <path> to the repository\n');
        return 2;
      }
      const slug = slugFor(arg);
      // A re-add without flags falls back to what the entry remembered —
      // wowUI's Re-scan posts only the path, and building bare would drop
      // every operation/table node. See `mergedScanInputs`: the one merged
      // pair feeds both the build and the entry, so they cannot drift.
      // Made absolute HERE, at the command boundary, before the engine or the
      // registry sees them. The schema ingester resolves a relative source
      // against the repository being indexed — right for a file inside it,
      // and wrong for the way people actually type this: from their own
      // directory, naming a schema file that lives elsewhere. Seen live: a
      // repo saved with `--db-schema examples/hrms/x.sql` re-indexed with zero
      // tables and a warning nobody read, and every catalog against it
      // authored without DB checks. A URL (`--openapi https://…`) is left as
      // typed.
      const prior = await resolveRepo(arg);
      // Context documents remembered with the repo — markdown, text, PDF,
      // PowerPoint, Excel or CSV, validated here where a refusal can name the
      // file. Paths are stored absolute and read fresh at authoring time, so
      // an edited file updates the remembered context by itself; re-adding a
      // file of the same name replaces the remembered path.
      const rememberedDocs: string[] = [];
      for (const doc of options.contextDocs) {
        const absolute = resolve(doc);
        if (formatFor(absolute) === undefined) {
          process.stderr.write(
            `wowlidator context add: cannot remember "${doc}" — it reads ${SUPPORTED_EXTENSIONS.join(' ')}\n`,
          );
          return 2;
        }
        try {
          await stat(absolute);
        } catch {
          process.stderr.write(`wowlidator context add: no such context document: ${doc}\n`);
          return 2;
        }
        rememberedDocs.push(absolute);
      }
      const contextDocs = mergedContextDocs(prior, rememberedDocs);
      const { openapi, dbSchema } = mergedScanInputs(prior, {
        openapi: options.openapi === undefined || /^[a-z]+:\/\//i.test(options.openapi) ? options.openapi : resolve(options.openapi),
        dbSchema: options.dbSchema === undefined ? undefined : resolve(options.dbSchema),
      });
      const repoEngine = new ContextEngine({
        rootDir: arg,
        cacheFile: graphFileFor(slug),
        openApiSpec: openapi,
        dbSchema,
        dbUrl: process.env['WOWLIDATOR_DB_URL'],
        dbRemoteOk: process.env['WOWLIDATOR_DB_REMOTE_OK'] === '1',
      });
      const graph = await repoEngine.build({ force: options.force });
      // What the repo's own files say about its database — a hint for the
      // panel and for anyone asking "what do I set WOWLIDATOR_DB_URL to?".
      // Best-effort file parsing; never a connection, never a password.
      const dbHint = (await detectDbHint(resolve(arg))) ?? prior?.dbHint;
      if (dbHint !== undefined) {
        process.stdout.write(
          `  db hint    ${dbHint.engine} at ${dbHint.host ?? '?'}:${dbHint.port ?? '?'}` +
            `${dbHint.database === undefined ? '' : `/${dbHint.database}`} (from ${dbHint.source})` +
            `${dbHint.passwordAt === undefined ? '' : ` — password: ${dbHint.passwordAt}`}\n`,
        );
      }
      await upsertRepo({
        slug,
        path: resolve(arg),
        indexedAt: new Date().toISOString(),
        nodes: graph.nodes.length,
        openapi,
        dbSchema,
        // A re-scan must not forget what a signed-in capture learned or the
        // documents remembered alongside the code — same rule as
        // `mergedScanInputs` for the scan's own inputs.
        nav: prior?.nav,
        contextDocs,
        dbHint,
      });
      process.stdout.write(
        `${summarizeContext(graph)}\n\nsaved as ${slug} — ground a run in it with --repo ${slug}\n` +
          (contextDocs === undefined
            ? ''
            : `  remembers  ${contextDocs.length} context document(s): ${contextDocs.map((d) => d.split('/').pop()).join(', ')}\n`),
      );
      return 0;
    }

    case 'list': {
      const repos = await listRepos();
      if (repos.length === 0) {
        process.stdout.write('no repositories saved — wowlidator context add <path>\n');
        return 0;
      }
      for (const repo of repos) {
        process.stdout.write(
          `${repo.slug}\n  ${repo.path}\n  ${repo.nodes} node(s), scanned ${repo.indexedAt}\n`,
        );
      }
      return 0;
    }

    case 'build': {
      const graph = await engine.build({ force: options.force });
      process.stdout.write(`${summarizeContext(graph)}\n\nwritten to ${engine.cacheFile}\n`);
      return 0;
    }

    case 'show': {
      const graph = (await engine.load()) ?? (await engine.build());
      process.stdout.write(options.json ? `${JSON.stringify(graph, null, 2)}\n` : `${summarizeContext(graph)}\n`);
      return 0;
    }

    default:
      process.stderr.write(`wowlidator context: unknown subcommand ${sub ?? '(none)'} (expected build, show, add or list)\n`);
      return 2;
  }
}

/**
 * `wowlidator report [<ledger.progress.json> | <dir>]` — rebuild the catalog
 * report and its all-cases Excel export from a suite ledger on disk,
 * without re-running anything. Exists so the exports added after a run can be
 * applied to the runs already in the folders: the ledger names every planned
 * case and where its proof bundle landed, which is all the report is built
 * from at the suite roll-up too.
 *
 * Defaults to every ledger under `.wowlidator/catalogs/`. A proof bundle that
 * no longer exists is reported, never fatal — its case renders without
 * evidence, exactly as a never-ran row does.
 */
export async function cmdCatalogReport(target: string | undefined, _options: CliOptions): Promise<number> {
  const { readFile } = await import('node:fs/promises');
  const { readLedger } = await import('../suite-progress.js');
  const { buildCatalogReportCases, writeCatalogArtifacts } = await import('../catalog-live-report.js');
  type Bundle = import('../../engine/proof-bundle.js').ProofBundle;

  const ledgerPaths: string[] = [];
  const chosen = target === undefined ? resolve('.wowlidator', 'catalogs') : resolve(target);
  if (chosen.endsWith('.progress.json')) {
    ledgerPaths.push(chosen);
  } else {
    const names = await readdir(chosen).catch(() => [] as string[]);
    for (const name of names) if (name.endsWith('.progress.json')) ledgerPaths.push(join(chosen, name));
    if (ledgerPaths.length === 0) {
      process.stderr.write(`wowlidator report: no *.progress.json ledgers found in ${chosen}\n`);
      return 2;
    }
  }

  let failures = 0;
  for (const ledgerPath of ledgerPaths) {
    const ledger = await readLedger(ledgerPath);
    if (ledger === null) {
      process.stderr.write(`  ! ${ledgerPath} is not a readable suite ledger\n`);
      failures += 1;
      continue;
    }
    let missingProofs = 0;
    const cases = await buildCatalogReportCases(ledger, async (id) => {
      const proofPath = ledger.outcomes[id]?.proofPath;
      if (typeof proofPath !== 'string' || proofPath === '') return null;
      try {
        return JSON.parse(await readFile(proofPath, 'utf8')) as Bundle;
      } catch {
        missingProofs += 1;
        return null;
      }
    });
    const recorded = ledger.planned.filter((id) => ledger.outcomes[id] !== undefined).length;
    if (recorded > 0 && missingProofs === recorded) {
      // Every recorded case's evidence is gone: regenerating would OVERWRITE a
      // report that may still hold it, with one that holds nothing.
      process.stderr.write(
        `  ! ${ledger.runKey ?? ledger.title}: all ${recorded} proof bundle(s) are gone — skipped rather than ` +
          'overwriting a report that may still carry the evidence\n',
      );
      failures += 1;
      continue;
    }
    try {
      const { htmlPath, excel } = await writeCatalogArtifacts({
        title: ledger.title,
        runKey: ledger.runKey,
        generatedAt: ledger.generatedAt,
        cases,
        // A ledger still marked running keeps the page reloading itself.
        live: ledger.ended === null,
      });
      process.stdout.write(
        `  catalog report ${htmlPath}\n` +
          `  cases xlsx ${excel.xlsxPath} — ${excel.cases} case(s), ${excel.embeddedImages} image(s) embedded, ${excel.omittedImages} omitted, ${excel.caseXlsxPaths.length} per-case workbook(s), ${excel.videoPaths.length} recording(s)` +
          (excel.removed.length > 0 ? ` · ${excel.removed.length} stale export(s) removed` : '') +
          (missingProofs > 0 ? ` · ${missingProofs} proof bundle(s) no longer exist; those cases carry no evidence` : '') +
          '\n',
      );
    } catch (error) {
      process.stderr.write(
        `  ! ${ledger.runKey ?? ledger.title}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}\n`,
      );
      failures += 1;
    }
  }
  return failures === 0 ? 0 : 1;
}

/**
 * `wowlidator db restore [<baseline.json> | <runKey> | <ledger.progress.json>]`
 * — put the tables back for a run whose own restore never ran (it was paused
 * or killed, or it ran in snapshot mode and the operator decided to restore
 * afterwards). Reads the baseline the run wrote, connects the WRITE credential
 * (`WOWLIDATOR_DB_RESTORE_URL`) and the read-only one for verification, and
 * runs the same `restoreBaseline` the end of a run does. Never touches a table
 * outside the baseline; every statement is printed before it runs.
 *
 * With no argument it restores the newest baseline under `.wowlidator/db-baselines/`.
 */
export async function cmdDb(sub: string | undefined, target: string | undefined, _options: CliOptions): Promise<number> {
  if (sub !== 'restore') {
    process.stderr.write(`wowlidator db: unknown subcommand ${sub ?? '(none)'} (expected: restore)\n`);
    return 2;
  }
  const { readdir } = await import('node:fs/promises');
  const { readLedger } = await import('../suite-progress.js');
  const { readBaseline, restoreBaseline, BASELINE_DIR } = await import('../../db/baseline.js');
  const { connectDb, connectDbWritable, defaultDbConfig, maskDsn, restoreDbConfig } = await import('../../db/client.js');

  // Resolve the baseline file from what was given: a .json baseline, a ledger
  // (its `dbBaseline.path`), a run key, or nothing (newest baseline on disk).
  let baselinePath: string | null = null;
  if (target === undefined) {
    const dir = resolve(BASELINE_DIR);
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.json'));
    if (names.length === 0) {
      process.stderr.write(`wowlidator db restore: no baselines under ${dir}\n`);
      return 2;
    }
    const withTimes = await Promise.all(
      names.map(async (n) => ({ n, t: (await stat(join(dir, n)).catch(() => null))?.mtimeMs ?? 0 })),
    );
    withTimes.sort((a, b) => b.t - a.t);
    baselinePath = join(dir, withTimes[0]!.n);
  } else if (target.endsWith('.progress.json')) {
    const ledger = await readLedger(resolve(target));
    baselinePath = ledger?.dbBaseline?.path ?? null;
    if (baselinePath === null) {
      process.stderr.write(`wowlidator db restore: ${target} records no database baseline\n`);
      return 2;
    }
  } else if (target.endsWith('.json')) {
    baselinePath = resolve(target);
  } else {
    baselinePath = resolve(BASELINE_DIR, `${target.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}.json`);
  }

  const restoreConfig = restoreDbConfig();
  const readConfig = defaultDbConfig();
  if (restoreConfig === null) {
    process.stderr.write('wowlidator db restore: WOWLIDATOR_DB_RESTORE_URL is not set — nothing to restore through\n');
    return 3;
  }
  if (readConfig === null) {
    process.stderr.write('wowlidator db restore: WOWLIDATOR_DB_URL is not set — the restore is verified through it\n');
    return 3;
  }
  let baseline;
  try {
    baseline = await readBaseline(baselinePath);
  } catch (error) {
    process.stderr.write(`wowlidator db restore: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const reader = await connectDb(readConfig);
  const writable = await connectDbWritable(restoreConfig);
  try {
    process.stdout.write(
      `restoring ${baseline.tables.filter((t) => t.restorable).length} table(s) from ${baselinePath}\n` +
        `  write  ${maskDsn(restoreConfig.url ?? '')}\n`,
    );
    const result = await restoreBaseline(writable, reader, baseline, {
      onStatement: (sql) => process.stderr.write(`  sql  ${sql}\n`),
    });
    process.stdout.write(`  ${result.detail}\n`);
    return result.ok ? 0 : 3;
  } finally {
    await writable.close().catch(() => undefined);
    await reader.close().catch(() => undefined);
  }
}

async function buildDataTransport(
  options: CliOptions,
  injected: FetchJson | undefined,
  subcommand: string,
): Promise<DataTransportBuild> {
  if (injected !== undefined) return { fetchJson: injected, notes: [] };
  const { BrowserTransport, FetchTransport } = await import('../../api/api-client.js');
  const { fetchJsonThrough } = await import('../../context/master-data.js');
  const credentials = options.credentials ?? Object.values(options.personas)[0];
  if (credentials === undefined || options.url === undefined) {
    return {
      fetchJson: fetchJsonThrough(new FetchTransport()),
      notes: [
        "fetched over plain HTTP with no session — pass --as or --persona to use the application's own cookies",
      ],
    };
  }

  const { prepare, cleanupChrome } = await import('../artifacts.js');
  const { DEFAULT_CDP_URL } = await import('../../engine/runner.js');
  const { SIGN_IN_URL_PATTERN, performSignIn } = await import('../../engine/sign-in.js');
  const { acceptConsentGate } = await import('../../engine/consent-gate.js');
  const { chromium } = await import('playwright');
  const blocked = await prepare(options, options.url);
  if (blocked !== null) return { exit: blocked };
  const cdpUrl = options.cdp ?? DEFAULT_CDP_URL;
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
  } catch (error) {
    process.stderr.write(
      `wowlidator data ${subcommand}: could not attach to a browser at ${cdpUrl}: ` +
        `${error instanceof Error ? error.message.split('\n')[0] : String(error)}\n`,
    );
    return { exit: 3 };
  }
  const context = await browser.newContext();
  const closeTransport = async (): Promise<void> => {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    await cleanupChrome(options);
  };
  const notes: string[] = [];
  const tab = await context.newPage();
  try {
    await tab.goto(options.url, { waitUntil: 'domcontentloaded' });
    await tab.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    if (SIGN_IN_URL_PATTERN.test(tab.url())) {
      process.stderr.write(`[wowlidator] signing in as ${credentials.email} so the lookups carry the application's session…\n`);
      const outcome = await performSignIn(tab, credentials);
      if (!outcome.ok) {
        notes.push(`sign-in as ${credentials.email} did not take (${outcome.reason}); the lookups were sent without a session`);
      } else if (SIGN_IN_URL_PATTERN.test(tab.url())) {
        notes.push(`sign-in as ${credentials.email} left the tab on ${tab.url()}; the lookups may have been sent without a session`);
      }
    }
    await acceptConsentGate(tab).catch(() => false);
  } catch (error) {
    notes.push(
      `could not open ${options.url} first (${error instanceof Error ? error.message.split('\n')[0] : String(error)}); ` +
        'the lookups were sent without a session',
    );
  }
  return { fetchJson: fetchJsonThrough(new BrowserTransport(context)), notes, closeTransport };
}

async function cmdDataLookups(
  options: CliOptions,
  injected: FetchJson | undefined,
  out: string | undefined,
): Promise<number> {
  if (options.repo === undefined) {
    process.stderr.write('wowlidator data lookups: --repo <slug> is required — the saved index to inspect\n');
    return 2;
  }
  if (options.url === undefined) {
    process.stderr.write('wowlidator data lookups: --url <app> is required — the lookup paths are resolved against it\n');
    return 2;
  }
  const entry = await resolveRepo(options.repo);
  if (entry === null) {
    process.stderr.write(
      `wowlidator data lookups: unknown repository "${options.repo}" — see saved ones with: wowlidator context list\n`,
    );
    return 2;
  }
  const engine = new ContextEngine({
    rootDir: entry.path,
    cacheFile: graphFileFor(entry.slug),
    openApiSpec: entry.openapi,
    dbSchema: entry.dbSchema,
    dbUrl: process.env['WOWLIDATOR_DB_URL'],
    dbRemoteOk: process.env['WOWLIDATOR_DB_REMOTE_OK'] === '1',
  });
  const graph = await engine.load();
  if (graph === null) {
    process.stderr.write(
      `wowlidator data lookups: no readable saved graph for ${entry.slug} — rebuild it with: wowlidator context add ${entry.path}\n`,
    );
    return 2;
  }
  const { discoverLookups, lookupOperations } = await import('../../context/lookup-discovery.js');
  const transport = await buildDataTransport(options, injected, 'lookups');
  if ('exit' in transport) return transport.exit;
  let discoveries;
  try {
    discoveries = await discoverLookups(
      lookupOperations(graph),
      transport.fetchJson,
      { baseUrl: options.url },
    );
  } finally {
    await transport.closeTransport?.();
  }

  for (const discovery of discoveries) {
    if ('shape' in discovery) {
      process.stdout.write(
        `${discovery.field}\t${discovery.path}\trows=${JSON.stringify(discovery.shape.rows)} ` +
          `code=${discovery.shape.code} label=${discovery.shape.label}\n`,
      );
    } else {
      process.stdout.write(`${discovery.field}\t${discovery.path}\tunknown: ${discovery.unknown}\n`);
    }
  }
  const known = discoveries.filter((discovery) => 'shape' in discovery);
  const unknown = discoveries.filter((discovery) => 'unknown' in discovery);
  const unknownNames = unknown.length === 0 ? '' : ` (${unknown.map((item) => item.field).join(', ')})`;
  process.stdout.write(
    `summary: ${known.length} of ${discoveries.length} lookup(s) inferred; ${unknown.length} unknown${unknownNames}\n`,
  );
  for (const note of transport.notes) process.stdout.write(`note: ${note}\n`);

  if (out !== undefined) {
    const { writeFile } = await import('node:fs/promises');
    const { MASTER_DATA_DECLARATION_SCHEMA } = await import('../../context/master-data.js');
    const declaration = known.map((discovery) => ({
      field: [discovery.field],
      // The base that ANSWERED, not the app-relative path: a deployment may
      // serve the application under a prefix, and `data check` fetching the
      // bare path would reach the web server's 404 instead of the app.
      url: `${discovery.base}${discovery.path}`,
      rows: discovery.shape.rows,
      code: discovery.shape.code,
      label: discovery.shape.label,
    }));
    const parsed = MASTER_DATA_DECLARATION_SCHEMA.safeParse(declaration);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      process.stderr.write(
        `wowlidator data lookups: cannot write ${out}: ${issue?.message ?? 'invalid master-data declaration'}\n`,
      );
      return 2;
    }
    await writeFile(resolve(out), `${JSON.stringify(parsed.data, null, 2)}\n`, 'utf8');
    process.stdout.write(`wrote ${resolve(out)}\n`);
    process.stdout.write(
      "note: field names are derived from lookup URLs; edit them to match the sheet's own Test Data column names\n",
    );
  }
  return 0;
}

/**
 * `wowlidator data check <catalog> --master-data <file> --url <app>` — the
 * master-data grounding rung (`src/context/master-data.ts`): which of the
 * codes a sheet's Test Data names exist in the application's own master, what
 * they are called there, whether they are free, and whether the UI picker
 * can reach them. A report for a person, never a gate: exit 0 whatever it
 * finds, `--json` for tooling.
 *
 * The lookups are fetched over the HTTP execution plane's own seam. With
 * `--as` (or a `--persona`) the command signs in on a tab of its own and
 * sends through that browser context, so the application's cookies are used
 * exactly as a run's backend steps use them; without credentials it sends
 * plain HTTP and never touches Chrome. Tests inject `extra.fetchJson` to
 * point the fetcher at a fixture server; the CLI wires the transport.
 *
 * Every fetched page is data: read through the declared JSON paths, compared
 * as strings, never interpreted. A page that cannot be read makes its lookup
 * `unknown` with the reason — unverified is not missing.
 */
export async function cmdData(
  sub: string | undefined,
  catalog: string | undefined,
  options: CliOptions,
  extra: {
    masterData?: string | undefined;
    fetchJson?: FetchJson | undefined;
    out?: string | undefined;
  } = {},
): Promise<number> {
  if (sub === 'lookups') return cmdDataLookups(options, extra.fetchJson, extra.out);
  if (sub !== 'check') {
    process.stderr.write(`wowlidator data: unknown subcommand ${sub ?? '(none)'} (expected: check or lookups)\n`);
    return 2;
  }
  if (catalog === undefined) {
    process.stderr.write('wowlidator data check: missing <catalog> — the sheet whose Test Data codes to check\n');
    return 2;
  }
  if (extra.masterData === undefined) {
    process.stderr.write('wowlidator data check: --master-data <file> is required — the lookup declaration (see the manual)\n');
    return 2;
  }
  if (options.url === undefined && extra.fetchJson === undefined) {
    process.stderr.write("wowlidator data check: --url <app> is required — the lookups' paths are resolved against it\n");
    return 2;
  }

  const { readFile } = await import('node:fs/promises');
  const { extractWorkbookSheets } = await import('../../catalog/extract.js');
  const { parseTestCaseTable, parseWorkbookCases, testDataPairs } = await import('../../catalog/test-case-table.js');
  const {
    LookupFetcher,
    describeGroundingFinding,
    groundPlan,
    planLookups,
    readMasterDataDeclaration,
    renderGroundingReport,
    summarizeGrounding,
  } = await import('../../context/master-data.js');

  // Progress goes to stderr: under --json stdout is one document, and in text
  // mode the report is the output, not the narration.
  const log = (line: string): void => {
    process.stderr.write(`[wowlidator] ${line}\n`);
  };

  let lookups: MasterDataLookup[];
  try {
    lookups = await readMasterDataDeclaration(resolve(extra.masterData));
  } catch (error) {
    process.stderr.write(`wowlidator data check: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  // The catalog is read exactly as `catalog` reads it: a CSV or a workbook
  // whose columns already say what each row's Test Data is. Anything else
  // would need the model extractor, and this rung makes no model call.
  const catalogPath = resolve(catalog);
  const format = formatFor(catalogPath);
  let table: TestCaseRow[] | null = null;
  try {
    if (format === 'csv') table = parseTestCaseTable(await readFile(catalogPath, 'utf8'));
    else if (format === 'xlsx') table = parseWorkbookCases(extractWorkbookSheets(await readFile(catalogPath)));
    else {
      process.stderr.write(`wowlidator data check: ${catalog} must be a .csv or .xlsx test-case table\n`);
      return 2;
    }
  } catch (error) {
    process.stderr.write(`wowlidator data check: cannot read ${catalog}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (table === null) {
    process.stderr.write(`wowlidator data check: ${catalog} is not a test-case table (needs Test Case ID, steps and expected columns)\n`);
    return 2;
  }
  const cases = table.map((row) => ({ caseId: row.caseId, pairs: testDataPairs(row.testData) }));
  const plans = planLookups(lookups, cases);
  log(`${table.length} row(s) in ${catalog}; ${lookups.length} lookup(s) → ${plans.length} fetch group(s)`);

  // The transport. Injected by a test; otherwise the browser's own cookies
  // when someone to sign in as was named, plain HTTP when not.
  const transport = await buildDataTransport(options, extra.fetchJson, 'check');
  if ('exit' in transport) return transport.exit;
  const { fetchJson, notes, closeTransport } = transport;

  const results: LookupGrounding[] = [];
  try {
    const fetcher = new LookupFetcher(fetchJson);
    for (const plan of plans) {
      const result = await groundPlan(plan, fetcher, options.url);
      results.push(result);
      const where = Object.entries(result.bindings).map(([k, v]) => `${k}=${v}`).join(', ');
      log(
        `${result.field.join('/')}${where === '' ? '' : ` [${where}]`}: ${result.status}` +
          (result.status === 'ok'
            ? ` — ${result.rowsFetched} row(s), ${result.codes.length} code(s) checked`
            : ` — ${result.reason ?? ''}`),
      );
    }
  } finally {
    await closeTransport?.();
  }

  const summary = summarizeGrounding(results);
  const finding = describeGroundingFinding(results);
  if (options.json) {
    const document = {
      catalog: catalogPath,
      declaration: resolve(extra.masterData),
      appUrl: options.url ?? null,
      rowsRead: table.length,
      notes,
      lookups: results,
      summary,
      finding,
    };
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(renderGroundingReport(results));
  for (const line of notes) process.stdout.write(`note: ${line}\n`);
  process.stdout.write(`\n${finding}\n`);
  return 0;
}
