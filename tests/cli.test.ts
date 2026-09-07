/**
 * The command line, driven the way a user or a CI job drives it: as a
 * subprocess (spec T1, A2).
 *
 * Nothing here imports wowlidator's internals on purpose. The surface under test is
 * the *contract* — exit codes, what lands on stdout versus stderr, whether
 * `--json` stays parseable — and none of that is observable from the inside.
 * Every one of these promises is something automation depends on and nothing
 * previously enforced.
 *
 * Tiering follows the rest of the suite: commands that need a page run only
 * when a CDP endpoint answers; argument handling and gating run always.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';
const ROOT = resolve(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
/** tsx's ESM loader, by absolute path — so the CLI can be run from any cwd. */
const TSX_LOADER = join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');

/** Documented in README and frozen — see `EXIT` in `src/cli.ts`. */
const EXIT = { ok: 0, failed: 1, usage: 2, environment: 3 } as const;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI in a clean environment.
 *
 * Provider keys are stripped unless a test asks for them: a suite that only
 * passes on a developer's machine, because their shell happens to export a
 * key, is not testing the gating it claims to test.
 */
function runCli(
  args: string[],
  env: Record<string, string> = {},
  options: { cwd?: string } = {},
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    // `node --import <loader>` rather than `npx tsx`, because several tests run
    // from a scratch directory: the CLI loads `.env` relative to its cwd, so a
    // test asserting "no key configured" only means anything when it runs
    // somewhere the project's own `.env` cannot be found.
    const child = spawn(process.execPath, ['--import', TSX_LOADER, CLI, ...args], {
      cwd: options.cwd ?? ROOT,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !/API_KEY|^WOWLIDATOR_/.test(key)),
        ),
        WOWLIDATOR_DISABLE_REPORT: '1',
        WOWLIDATOR_CDP_URL: CDP_URL,
        ...env,
      } as NodeJS.ProcessEnv,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

async function cdpAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

const browserReady = await cdpAvailable(CDP_URL);
const skipBrowser = browserReady
  ? false
  : `no CDP endpoint at ${CDP_URL} — start Chrome with --remote-debugging-port=9222 (npm run chrome)`;

const FIXTURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>cli fixture</title></head>
<body><button id="go">Go</button><p id="out">idle</p>
<script>document.getElementById('go').addEventListener('click',()=>{document.getElementById('out').textContent='done'});</script>
</body></html>`;

describe('cli — argument handling and gating', () => {
  /** A directory with no `.env`, so key-gating tests test the gate. */
  let keyless: string;

  before(async () => {
    keyless = await mkdtemp(join(tmpdir(), 'wowlidator-keyless-'));
  });

  after(async () => {
    await rm(keyless, { recursive: true, force: true });
  });

  it('exits 2 with usage on an unknown command, not a stack trace', async () => {
    const result = await runCli(['definitely-not-a-command']);
    assert.equal(result.code, EXIT.usage);
    assert.match(result.stderr, /unknown command/);
    assert.ok(!/at .*\(.*:\d+:\d+\)/.test(result.stderr), 'a stack trace leaked to the user');
  });

  it('exits 2 with usage on an unknown flag', async () => {
    const result = await runCli(['run', 'x.flow.json', '--not-a-flag']);
    assert.equal(result.code, EXIT.usage);
  });

  it('exits 2 on a --scope that is neither unit nor e2e', async () => {
    // Rejects rather than falling back: "--scope e2ee" quietly authoring a
    // unit test is exactly the surprise the flag exists to remove.
    const result = await runCli(['author', 'check the journey', '--scope', 'e2ee']);
    assert.equal(result.code, EXIT.usage);
    assert.match(result.stderr, /--scope must be unit or e2e/);
  });

  it('exits 2 on a --context-budget that is not a count of characters', async () => {
    // Rejects rather than clamps: typed wrong it is either a prompt with no
    // background in it or one with all of it, and both are quiet.
    const result = await runCli(['catalog', 'cases.md', '--context-budget', 'lots']);
    assert.equal(result.code, EXIT.usage);
    assert.match(result.stderr, /--context-budget must be a non-negative integer/);
  });

  it('exits 2 on an --as that is not <email>:<password>', async () => {
    // Rejects rather than ignores: a pair silently dropped puts the author
    // straight back to inventing a password, which is the whole failure this
    // flag exists to remove.
    const result = await runCli(['author', 'check the page', '--as', 'employee@cnext.test']);
    assert.equal(result.code, EXIT.usage);
    assert.match(result.stderr, /--as must be <email>:<password>/);
  });

  it('exits 2 when the flow file does not exist', async () => {
    const result = await runCli(['run', '/nope/missing.flow.json']);
    assert.equal(result.code, EXIT.usage);
  });

  it('run with several flows fails at the boundary when any file is bad', async () => {
    // The multi-flow form (wowUI's "Rerun all" / "Heal all") reads every file
    // before any browser time is spent — a typo in the second path is a usage
    // error naming that file, never a half-run suite.
    const dir = await mkdtemp(join(tmpdir(), 'wow-run-many-'));
    try {
      const good = join(dir, 'good.flow.json');
      await writeFile(good, JSON.stringify({ name: 'ok', steps: [] }));
      const result = await runCli(['run', good, '/nope/missing.flow.json']);
      assert.equal(result.code, EXIT.usage, result.stdout + result.stderr);
      assert.match(result.stderr, /no such flow file: \/nope\/missing\.flow\.json/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exits 3, naming the role, when a command needs a key it does not have', async () => {
    // Environment, not usage: the invocation was correct, the machine is not
    // set up. CI must be able to tell those apart.
    const result = await runCli(['generate', 'http://localhost:1/x'], {}, { cwd: keyless });
    assert.equal(result.code, EXIT.environment, result.stdout + result.stderr);
    assert.match(result.stderr, /"generator" role has no API key/);
  });

  it('go routes a diagram image on disk to the catalog path, not to prose authoring', async () => {
    // Catalog's role gate fires before the file is read, so an empty png is
    // evidence enough of the DISPATCH: the pre-fix path fell through to
    // "describe a test" and demanded --url (exit 2) about a drawing.
    const image = join(keyless, 'checkout.png');
    await writeFile(image, '');
    const result = await runCli(['go', image], {}, { cwd: keyless });
    assert.equal(result.code, EXIT.environment, result.stdout + result.stderr);
    assert.match(result.stderr, /wowlidator catalog:/);
  });

  it('go still reads a diagram-image NAME with no file behind it as a description', async () => {
    // Evidence-based dispatch: the file must exist on disk. A sentence that
    // merely ends in .png is a description, and describing needs --url.
    const result = await runCli(['go', 'the missing chart.png'], {}, { cwd: keyless });
    assert.equal(result.code, EXIT.usage, result.stdout + result.stderr);
    assert.match(result.stderr, /needs a page/);
  });

  it('prints usage on --help and exits 0', async () => {
    const result = await runCli(['--help']);
    assert.equal(result.code, EXIT.ok);
    assert.match(result.stdout, /wowlidator/);
    assert.match(result.stdout, /--probe/, 'documented flags appear in help');
  });
});

describe('cli — data check (master-data grounding)', () => {
  // A fixture master behind a local HTTP server: three pages of positions for
  // one company, one for another, a flat cost-centre list. The CLI is given no
  // credentials, so it fetches over plain HTTP and never asks for a browser.
  const FIXTURES = join(ROOT, 'tests', 'fixtures');
  const PAGES = [
    { rows: [{ positionCode: 'P-001', name: { en: 'Analyst', th: 'นักวิเคราะห์' }, vacant: true, headcount: 1 }, { positionCode: 'P-002', name: { en: 'Clerk' }, vacant: false, headcount: 2 }], more: true },
    { rows: [{ positionCode: 'P-003', name: { en: 'Driver' }, vacant: true, headcount: 1 }, { positionCode: 'P-004', name: { en: 'Engineer' }, vacant: true, headcount: 3 }], more: true },
    { rows: [{ positionCode: 'P-005', name: { en: 'Foreman' }, vacant: true, headcount: 1 }, { positionCode: 'P-006', name: { en: 'Guard' }, vacant: false, headcount: 1 }], more: false },
  ];
  let server: Server;
  let origin: string;
  const hits: string[] = [];
  // A scratch cwd, like the keyless suite: the CLI loads `.env` from its cwd,
  // and a developer's own `WOWLIDATOR_AS` there would hand this command
  // credentials — and a browser to sign in with — that the test never gave it.
  let scratch: string;

  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'wowlidator-data-check-'));
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      hits.push(url.pathname + url.search);
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/api/positions' && url.searchParams.get('company') === 'ACME') {
        const page = PAGES[Number(url.searchParams.get('page')) - 1];
        if (page === undefined) return json(404, { error: 'no such page' });
        return json(200, { data: { rows: page.rows, hasNextPage: page.more } });
      }
      if (url.pathname === '/api/positions') {
        // The second company answers as a sign-in page would: HTML, 200.
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>Sign in</title>');
        return;
      }
      if (url.pathname === '/api/cost-centers') return json(200, [{ code: 'CC-9', title: 'Nine' }]);
      return json(500, { error: 'unexpected' });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    await rm(scratch, { recursive: true, force: true });
  });

  const args = (...more: string[]): string[] => [
    'data', 'check', join(FIXTURES, 'master-data-cases.csv'),
    '--master-data', join(FIXTURES, 'master-data.lookups.json'),
    '--url', origin,
    ...more,
  ];

  it('prints one JSON document with per-code rows and the summary counts, exit 0', async () => {
    hits.length = 0;
    const result = await runCli(args('--json'), {}, { cwd: scratch });
    assert.equal(result.code, EXIT.ok, result.stderr);
    const parsed = JSON.parse(result.stdout) as {
      rowsRead: number;
      lookups: { status: string; bindings: Record<string, string>; codes: { code: string; cases: string[]; found?: boolean; label?: string; reachable?: boolean; facts?: Record<string, unknown> }[] }[];
      summary: { codes: number; rows: number; notFound: { codes: number; rows: number }; unreachable: { codes: number; rows: number }; contended: { codes: number }; unknownLookups: number; urls: string[] };
      finding: string;
    };
    assert.equal(parsed.rowsRead, 7);
    const acme = parsed.lookups.find((l) => l.bindings['Company'] === 'ACME');
    assert.ok(acme, 'the ACME group was fetched');
    assert.equal(acme.status, 'ok');
    const p005 = acme.codes.find((c) => c.code === 'P-005');
    assert.deepEqual(
      { found: p005?.found, label: p005?.label, reachable: p005?.reachable, facts: p005?.facts, cases: p005?.cases },
      { found: true, label: 'Foreman', reachable: false, facts: { vacant: true, headcount: 1 }, cases: ['MD_01_02'] },
    );
    assert.equal(acme.codes.find((c) => c.code === 'P-404')?.found, false);
    const zeta = parsed.lookups.find((l) => l.bindings['Company'] === 'ZETA');
    assert.equal(zeta?.status, 'unknown', 'an HTML answer is unknown, not a missing code');
    assert.equal(parsed.summary.codes, 6);
    assert.equal(parsed.summary.rows, 7);
    assert.deepEqual([parsed.summary.notFound.codes, parsed.summary.notFound.rows], [1, 1]);
    assert.deepEqual([parsed.summary.unreachable.codes, parsed.summary.unreachable.rows], [1, 1]);
    assert.equal(parsed.summary.contended.codes, 1);
    assert.equal(parsed.summary.unknownLookups, 2, 'ZETA unread and the row with no Company unbound');
    assert.ok(parsed.summary.urls.some((u) => u.startsWith(`${origin}/api/positions?company=ACME&page=1`)));
    assert.match(parsed.finding, /^Master data: 6 codes named by 7 rows/);
    // Each distinct page once, however many rows wanted it.
    assert.equal(hits.filter((h) => h.startsWith('/api/positions?company=ACME')).length, 3);
  });

  it('prints the table and the summary line in text mode, exit 0', async () => {
    const result = await runCli(args(), {}, { cwd: scratch });
    assert.equal(result.code, EXIT.ok, result.stderr);
    assert.match(result.stdout, /Position \/ Position Code \[Company=ACME\]/);
    assert.match(result.stdout, /P-005\s+1\s+yes\s+Foreman\s+yes\s+1\s+no/);
    assert.match(result.stdout, /summary: 6 codes \/ 7 rows checked; 1 code\(s\) \/ 1 row\(s\) not found; 1 code\(s\) \/ 1 row\(s\) unreachable; 1 consumable code\(s\) shared by 2\+ rows; 2 lookup\(s\) unread/);
    assert.match(result.stdout, /lookups used:/);
    assert.match(result.stdout, /note: fetched over plain HTTP with no session/);
  });

  it('exits 2 when the declaration is missing or unusable', async () => {
    const noFile = await runCli(['data', 'check', join(FIXTURES, 'master-data-cases.csv'), '--url', origin]);
    assert.equal(noFile.code, EXIT.usage);
    assert.match(noFile.stderr, /--master-data <file> is required/);
    const notJson = await runCli(['data', 'check', join(FIXTURES, 'master-data-cases.csv'), '--master-data', join(FIXTURES, 'order.mmd'), '--url', origin]);
    assert.equal(notJson.code, EXIT.usage);
    assert.match(notJson.stderr, /is not JSON/);
  });

  it('documents the command in --help', async () => {
    const result = await runCli(['--help']);
    assert.match(result.stdout, /wowlidator data check <catalog> --master-data <file> --url <app>/);
    assert.match(result.stdout, /--master-data <file>/);
  });
});

interface LookupCliFixture {
  readonly graph: unknown;
  readonly live: {
    readonly repoSlug: string;
    readonly knownPath: string;
    readonly unknownPath: string;
    readonly knownBody: unknown;
    readonly summary: string;
  };
}

describe('cli — data lookups (lookup discovery)', () => {
  const FIXTURES = join(ROOT, 'tests', 'fixtures');
  let fixture: LookupCliFixture;
  let server: Server;
  let origin: string;
  let scratch: string;

  before(async () => {
    fixture = JSON.parse(await readFile(join(FIXTURES, 'lookup-discovery.json'), 'utf8'));
    scratch = await mkdtemp(join(tmpdir(), 'wowlidator-data-lookups-'));
    const registry = join(scratch, '.wowlidator', 'context');
    const repoRoot = join(scratch, 'fixture-repo');
    await mkdir(registry, { recursive: true });
    await mkdir(repoRoot, { recursive: true });
    await writeFile(
      join(registry, 'repos.json'),
      JSON.stringify({
        version: 1,
        repos: [{ slug: fixture.live.repoSlug, path: repoRoot, indexedAt: new Date(0).toISOString(), nodes: 6 }],
      }),
      'utf8',
    );
    await writeFile(join(registry, `${fixture.live.repoSlug}.graph.json`), JSON.stringify(fixture.graph), 'utf8');
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (path === fixture.live.knownPath) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(fixture.live.knownBody));
        return;
      }
      if (path === fixture.live.unknownPath) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>Sign in</title>');
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => (error ? rejectClose(error) : resolveClose())));
    await rm(scratch, { recursive: true, force: true });
  });

  it('reports every indexed lookup and writes a declaration accepted by data check', async () => {
    const declarationPath = join(scratch, 'discovered.lookups.json');

    const result = await runCli(
      ['data', 'lookups', '--repo', fixture.live.repoSlug, '--url', origin, '--out', declarationPath],
      {},
      { cwd: scratch },
    );

    assert.equal(result.code, EXIT.ok, result.stderr);
    assert.ok(result.stdout.includes(fixture.live.summary), result.stdout);
    const declaration: unknown = JSON.parse(await readFile(declarationPath, 'utf8'));
    assert.ok(Array.isArray(declaration));
    assert.equal(declaration.length, 1, 'the unknown lookup is omitted');
    const validation = await runCli(
      [
        'data',
        'check',
        join(FIXTURES, 'master-data-cases.csv'),
        '--master-data',
        declarationPath,
        '--url',
        origin,
      ],
      {},
      { cwd: scratch },
    );
    assert.equal(validation.code, EXIT.ok, validation.stderr);
  });

  it('documents the lookup discovery command in --help', async () => {
    const result = await runCli(['--help']);
    assert.match(result.stdout, /wowlidator data lookups --repo <slug> --url <app>/);
  });
});

describe('cli — run contract (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;
  let dir: string;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-cli-'));

    await writeFile(
      join(dir, 'pass.flow.json'),
      JSON.stringify({
        name: 'cli pass',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/' },
          { action: 'click', selector: '#go', intent: 'Press the button.' },
          { action: 'expectText', selector: '#out', value: 'done', intent: 'It reports done.' },
        ],
      }),
      'utf8',
    );
    await writeFile(
      join(dir, 'fail.flow.json'),
      JSON.stringify({
        name: 'cli fail',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/' },
          { action: 'expectVisible', selector: '#never-exists', intent: 'Something that is not there.' },
        ],
      }),
      'utf8',
    );
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    await rm(dir, { recursive: true, force: true });
  });

  it('exits 0 on a passing flow', async () => {
    const result = await runCli(['run', join(dir, 'pass.flow.json'), '--no-history']);
    assert.equal(result.code, EXIT.ok, result.stderr);
    assert.match(result.stdout, /PASSED/);
  });

  it('exits 1 on a failing flow — a result, not an error', async () => {
    const result = await runCli(['run', join(dir, 'fail.flow.json'), '--no-history', '--no-heal']);
    assert.equal(result.code, EXIT.failed);
    // An unresolvable selector is reported as DEAD-END, not FAILED — a finer
    // verdict, same exit code: both are results about the application.
    assert.match(result.stdout, /DEAD-END/);
  });

  it('emits exactly one JSON document on stdout under --json', async () => {
    // The invariant that gates every console.log in the engine: anything else
    // written to stdout makes the output unparseable for the tools that
    // consume it.
    const result = await runCli(['run', join(dir, 'pass.flow.json'), '--json', '--no-history']);
    assert.equal(result.code, EXIT.ok, result.stderr);

    const parsed = JSON.parse(result.stdout) as {
      status: string;
      summary: { frontend: unknown; backend: unknown };
    };
    assert.equal(parsed.status, 'passed');
    assert.ok(parsed.summary.frontend, 'the frontend/backend split is machine-readable');
    assert.ok(parsed.summary.backend);
  });

  it('keeps --json parseable when the run fails', async () => {
    const result = await runCli(['run', join(dir, 'fail.flow.json'), '--json', '--no-history', '--no-heal']);
    assert.equal(result.code, EXIT.failed);
    const parsed = JSON.parse(result.stdout) as { status: string; steps: unknown[] };
    assert.equal(parsed.status, 'dead-end');
    assert.ok(Array.isArray(parsed.steps));
  });

  it('reports the full escalation trace when healing is disabled', async () => {
    // The human summary trims a step's error to its first line; the full
    // rung-by-rung trace travels on the bundle, which --json puts on stdout.
    const result = await runCli(['run', join(dir, 'fail.flow.json'), '--json', '--no-heal', '--no-history']);
    assert.match(result.stdout, /healer disabled/);
  });

  it('exits 3, not 1, when no browser is reachable', async () => {
    // A run that never reached the application must not be reported as the
    // application failing.
    const result = await runCli(['run', join(dir, 'pass.flow.json'), '--no-history'], {
      WOWLIDATOR_CDP_URL: 'http://127.0.0.1:9',
    });
    assert.equal(result.code, EXIT.environment, result.stdout + result.stderr);
  });
});
