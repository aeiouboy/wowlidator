/**
 * The bench: a labelled set of frozen proof bundles scored for precision,
 * confusion and cost (2026-09-05, `src/bench/`).
 *
 * Unit tier, always: the label schema against a hand-written accept and a
 * hand-written reject; `scoreBench` and `flipRate` against bundles built
 * inline here, never by the runner; the seeded label set's every bundle
 * loading through the proof-bundle seam. The run script is driven as a
 * subprocess, as `tests/cli.test.ts` drives the CLI, because an exit code
 * and a gate message are only observable from outside.
 *
 * No browser, no model: the verifier greps `src/bench` for provider, engine
 * runner and playwright imports and finds none.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseProofBundle } from '../src/artifacts/schemas.js';
import { BENCH_TRUTHS, parseBenchLabels, parseBenchScoreFile, readBenchLabels } from '../src/bench/labels.js';
import { NO_DIAGNOSIS, costOf, diffScores, flipRate, isFiledDefect, scoreBench } from '../src/bench/score.js';
import { labelSetName } from '../src/bench/run.js';
import type { ProofBundle, ProofStep } from '../src/engine/proof-bundle.js';

const ROOT = resolve(import.meta.dirname, '..');
const LABELS = join(ROOT, 'tests', 'fixtures', 'bench', 'labels.json');
const RUN = join(ROOT, 'src', 'bench', 'run.ts');
/** tsx's ESM loader, resolved the way Node resolves it — a worktree may borrow its parent's node_modules. */
const TSX_LOADER = fileURLToPath(import.meta.resolve('tsx'));

// --- hand-written bundles ----------------------------------------------------

function step(index: number, action: string, status: ProofStep['status'], extra: Partial<ProofStep> = {}): ProofStep {
  return {
    index,
    action,
    selector: null,
    resolvedSelector: null,
    resolution: null,
    status,
    startedAt: '2026-09-05T00:00:00.000Z',
    durationMs: 10,
    url: null,
    ...extra,
  };
}

function bundle(
  status: ProofBundle['status'],
  overrides: Partial<ProofBundle> = {},
): ProofBundle {
  const steps = overrides.steps ?? [step(0, 'goto', 'passed')];
  const failed = steps.filter((s) => s.status !== 'passed').length;
  const tier = { steps: steps.length, passed: steps.length - failed, failed, defects: 0 };
  return {
    runId: `run-${status}-${Math.random().toString(36).slice(2, 8)}`,
    name: 'inline case',
    status,
    startedAt: '2026-09-05T00:00:00.000Z',
    finishedAt: '2026-09-05T00:00:01.000Z',
    durationMs: 1000,
    cdpUrl: null,
    cachePath: null,
    healerModel: null,
    summary: {
      totalSteps: steps.length,
      passed: steps.length - failed,
      failed,
      frontend: tier,
      backend: { steps: 0, passed: 0, failed: 0, defects: 0 },
      fastPath: steps.length,
      caseRetries: 0,
      cacheHits: 0,
      jitHeals: 0,
      dialogsDismissed: 0,
      agentTakeovers: 0,
      visualChecks: 0,
      visualFailures: 0,
      dataRetries: 0,
      apiRequests: 0,
      apiFailures: 0,
      dbChecks: 0,
      dbFailures: 0,
      networkCalls: 0,
      networkFailures: 0,
      backendBlocked: 0,
      healUnavailable: 0,
      networkDropped: 0,
      healLatencyMs: 0,
      agentLatencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      defects: 0,
    },
    steps,
    defects: [],
    ...overrides,
  };
}

const defect = (title: string) =>
  ({ id: 'run-1', source: 'runtime', category: 'functional', severity: 'medium', title, detail: title }) as const;

// --- the label schema --------------------------------------------------------

describe('bench — labels schema', () => {
  it('accepts the seeded labels.json', async () => {
    const raw = JSON.parse(await readFile(LABELS, 'utf8')) as unknown;
    const parsed = parseBenchLabels(raw);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.issue);
    assert.ok(parsed.value.length >= 6, `expected ≥6 labelled entries, got ${parsed.value.length}`);
    for (const label of parsed.value) assert.ok((BENCH_TRUTHS as readonly string[]).includes(label.truth));
  });

  it('rejects an entry with an unknown truth, naming the path', () => {
    const parsed = parseBenchLabels([
      { bundle: 'bundles/a.json', truth: 'pass' },
      { bundle: 'bundles/b.json', truth: 'flaky' },
    ]);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.issue, /^1\.truth: /);
  });

  it('rejects an empty set, a missing bundle path and a non-array', () => {
    assert.equal(parseBenchLabels([]).ok, false);
    assert.equal(parseBenchLabels([{ truth: 'pass' }]).ok, false);
    assert.equal(parseBenchLabels([{ bundle: '', truth: 'pass' }]).ok, false);
    assert.equal(parseBenchLabels({ bundle: 'x', truth: 'pass' }).ok, false);
  });

  it('readBenchLabels throws an error that names the file', async () => {
    await assert.rejects(readBenchLabels(join(ROOT, 'tests', 'fixtures', 'bench', 'does-not-exist.json')), /does-not-exist\.json/);
  });

  it('the score-file schema rejects a baseline whose precision is a word', () => {
    const good = parseBenchScoreFile({
      labelSet: 'bench',
      generatedAt: 'now',
      score: {
        cases: 1,
        filedDefects: 1,
        truePositives: 1,
        precision: 1,
        recall: null,
        costPerCase: { modelTurns: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, pageCalls: 0, durationMs: 0, sessionCalls: 0, sessionCostUsd: 0 },
      },
    });
    assert.ok(good.ok);
    const bad = parseBenchScoreFile({ labelSet: 'bench', generatedAt: 'now', score: { cases: 1, filedDefects: 1, truePositives: 1, precision: 'high', recall: null, costPerCase: {} } });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.match(bad.issue, /^score\.precision/);
  });
});

// --- the seeded set ----------------------------------------------------------

describe('bench — the seeded fixture set', () => {
  it('has ≥6 entries whose bundles exist and parse through the proof-bundle seam', async () => {
    const labels = await readBenchLabels(LABELS);
    assert.ok(labels.length >= 6);
    const seen = new Set<string>();
    for (const label of labels) {
      const file = resolve(dirname(LABELS), label.bundle);
      assert.ok((await stat(file)).isFile(), `${label.bundle} is not a file`);
      const parsed = parseProofBundle(JSON.parse(await readFile(file, 'utf8')));
      assert.ok(parsed.ok, `${label.bundle}: ${parsed.ok ? '' : parsed.issue}`);
      assert.ok(!seen.has(parsed.value.runId), `${label.bundle} duplicates run ${parsed.value.runId}`);
      seen.add(parsed.value.runId);
    }
  });

  it('every bundle file under bundles/ is labelled — no orphan fixtures', async () => {
    const labels = await readBenchLabels(LABELS);
    const labelled = new Set(labels.map((l) => l.bundle.replace(/^bundles\//, '')));
    const files = (await readdir(join(dirname(LABELS), 'bundles'))).filter((f) => f.endsWith('.json'));
    for (const f of files) assert.ok(labelled.has(f), `${f} has no label`);
  });

  it('carries the documented mix: passes, agent-budget errors, base-path 404s, a review', async () => {
    const labels = await readBenchLabels(LABELS);
    const statuses: string[] = [];
    for (const label of labels) {
      const parsed = parseProofBundle(JSON.parse(await readFile(resolve(dirname(LABELS), label.bundle), 'utf8')));
      if (parsed.ok) statuses.push(parsed.value.status);
    }
    assert.ok(statuses.filter((s) => s === 'passed').length >= 1);
    assert.ok(statuses.filter((s) => s === 'error').length >= 2);
    assert.ok(statuses.filter((s) => s === 'failed').length >= 1);
    assert.ok(statuses.includes('needs-review'));
  });
});

// --- scoring -----------------------------------------------------------------

describe('bench — scoreBench', () => {
  const filedReal = bundle('failed', {
    steps: [step(0, 'goto', 'passed'), step(1, 'expectVisible', 'failed')],
    defects: [defect('Assertion failed: expectVisible')],
  });
  const filedHarness = bundle('error', {
    steps: [
      step(0, 'goto', 'passed'),
      step(1, 'workflow', 'error', {
        detail: { callsMade: 7, turns: 2 },
        agent: {
          goal: 'reach the page',
          model: 'stub',
          success: false,
          summary: 'gave up',
          actions: [],
          turns: 2,
          maxSteps: 2,
          latencyMs: 100,
          inputTokens: 1000,
          outputTokens: 50,
          cachedInputTokens: 300,
        },
      }),
    ],
    defects: [defect('Workflow goal not reached')],
    diagnosis: {
      origin: 'agent',
      confidence: 0.1,
      reasoning: 'budget',
      fix: null,
      actionable: false,
      signals: [],
      model: 'stub',
      at: '2026-09-05T00:00:02.000Z',
      inputTokens: 200,
      outputTokens: 20,
    },
  });
  const cleanPass = bundle('passed');

  it('2 filed, 1 labelled real → precision 0.5, with the per-truth counts', () => {
    const score = scoreBench([
      { truth: 'real-defect', bundle: filedReal },
      { truth: 'harness', bundle: filedHarness },
      { truth: 'pass', bundle: cleanPass },
    ]);
    assert.equal(score.cases, 3);
    assert.equal(score.filedDefects, 2);
    assert.equal(score.truePositives, 1);
    assert.equal(score.precision, 0.5);
    assert.equal(score.missedDefects, 0);
    assert.equal(score.recall, 1);
    assert.deepEqual(score.byTruth, {
      pass: 1,
      'real-defect': 1,
      'spec-question': 0,
      'not-deployed': 0,
      'test-data': 0,
      harness: 1,
    });
    assert.deepEqual(score.byStatus, { failed: 1, error: 1, passed: 1 });
  });

  it('fills the confusion cell diagnosis.origin × truth, and a no-diagnosis row', () => {
    const score = scoreBench([
      { truth: 'real-defect', bundle: filedReal },
      { truth: 'harness', bundle: filedHarness },
      { truth: 'pass', bundle: cleanPass },
    ]);
    assert.equal(score.confusion['agent']?.harness, 1);
    assert.equal(score.confusion['agent']?.['real-defect'], undefined);
    assert.equal(score.confusion[NO_DIAGNOSIS]?.['real-defect'], 1);
    assert.equal(score.confusion[NO_DIAGNOSIS]?.pass, 1);
  });

  it('a filed defect is: effective status failed, or ≥1 defect — a clean pass is neither', () => {
    assert.equal(isFiledDefect(cleanPass), false);
    assert.equal(isFiledDefect(bundle('failed')), true);
    assert.equal(isFiledDefect(bundle('passed', { defects: [defect('backend noise')] })), true);
    // A human ruling on a needs-review outranks the machine's deferral, as everywhere else.
    assert.equal(isFiledDefect(bundle('needs-review', { review: { verdict: 'failed', at: 'now' } })), true);
    assert.equal(isFiledDefect(bundle('needs-review', { review: { verdict: 'proved', at: 'now' } })), false);
    assert.equal(isFiledDefect(bundle('needs-review')), false);
  });

  it('a labelled real defect the harness did not file is a miss, and precision is null with nothing filed', () => {
    const score = scoreBench([{ truth: 'real-defect', bundle: cleanPass }]);
    assert.equal(score.filedDefects, 0);
    assert.equal(score.precision, null);
    assert.equal(score.missedDefects, 1);
    assert.equal(score.recall, 0);
  });

  it('reads cost from the agent record, the diagnosis and the step detail, once each', () => {
    const cost = costOf(filedHarness);
    assert.equal(cost.modelTurns, 2);
    assert.equal(cost.inputTokens, 1200);
    assert.equal(cost.outputTokens, 70);
    assert.equal(cost.cachedInputTokens, 300);
    assert.equal(cost.pageCalls, 7);
    assert.equal(cost.durationMs, 1000);
    assert.equal(cost.sessionCalls, 0);
    assert.equal(cost.sessionCostUsd, 0);
  });

  it('reads the session calls and charge from summary.session when the run used one', () => {
    const billed = bundle('passed');
    billed.summary.session = { provider: 'claude-cli', calls: 3, costUsd: 0.25, inputTokens: 5, cachedInputTokens: 900, outputTokens: 40, wallMs: 1200 };
    const cost = costOf(billed);
    assert.equal(cost.sessionCalls, 3);
    assert.equal(cost.sessionCostUsd, 0.25);
  });

  it('costPerCase divides the totals by the number of cases and tolerates missing fields', () => {
    const score = scoreBench([
      { truth: 'harness', bundle: filedHarness },
      { truth: 'pass', bundle: cleanPass },
      { truth: 'pass', bundle: bundle('passed', { caseDurationMs: 5000, risk: { likelihood: 0.1, threshold: 0.5, verdict: 'run', reasons: [], missing: [], signals: [], model: 'stub', at: 'now', inputTokens: 100 } as never }) },
    ]);
    assert.equal(score.costTotal.inputTokens, 1300);
    assert.equal(score.costTotal.durationMs, 7000);
    assert.equal(score.costPerCase.modelTurns, 2 / 3);
    assert.equal(score.costPerCase.inputTokens, 1300 / 3);
    assert.equal(score.costPerCase.durationMs, 7000 / 3);
  });

  it('an empty set scores zero everywhere and null precision', () => {
    const score = scoreBench([]);
    assert.equal(score.cases, 0);
    assert.equal(score.precision, null);
    assert.equal(score.recall, null);
    assert.equal(score.costPerCase.inputTokens, 0);
    assert.deepEqual(score.confusion, {});
  });

  it('diffScores subtracts baseline from current, precision null when either side filed nothing', () => {
    const base = scoreBench([
      { truth: 'real-defect', bundle: filedReal },
      { truth: 'harness', bundle: filedHarness },
    ]);
    const now = scoreBench([
      { truth: 'real-defect', bundle: filedReal },
      { truth: 'harness', bundle: cleanPass },
    ]);
    const delta = diffScores(base, now);
    assert.equal(delta.filedDefects, -1);
    assert.equal(delta.precision, 0.5);
    assert.ok(delta.costPerCase.inputTokens < 0);
    assert.equal(diffScores(scoreBench([]), now).precision, null);
  });
});

// --- stability ---------------------------------------------------------------

describe('bench — flipRate', () => {
  it('is 0 when every case has the same status on every run', () => {
    assert.equal(
      flipRate([
        [bundle('passed'), bundle('passed'), bundle('passed')],
        [bundle('failed'), bundle('failed')],
      ]),
      0,
    );
  });

  it('is the share of cases whose status differs across runs — one of four flips → 0.25', () => {
    assert.equal(
      flipRate([
        [bundle('passed'), bundle('passed')],
        [bundle('passed'), bundle('failed')],
        [bundle('error'), bundle('error')],
        [bundle('passed')],
      ]),
      0.25,
    );
  });

  it('reads the effective status, so a reviewed needs-review that matches its neighbours is stable', () => {
    assert.equal(flipRate([[bundle('passed'), bundle('needs-review', { review: { verdict: 'proved', at: 'now' } })]]), 0);
    assert.equal(flipRate([[bundle('passed'), bundle('needs-review')]]), 1);
  });

  it('is 0 with no cases, and ignores empty inner arrays', () => {
    assert.equal(flipRate([]), 0);
    assert.equal(flipRate([[], [bundle('passed')]]), 0);
  });
});

// --- the run script ----------------------------------------------------------

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runBench(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', TSX_LOADER, RUN, ...args], {
      cwd: ROOT,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_KEY|^WOWLIDATOR_/.test(key))),
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

describe('bench — npm run bench (subprocess)', () => {
  let out: string;
  before(async () => {
    out = await mkdtemp(join(tmpdir(), 'wow-bench-'));
  });
  after(async () => {
    await rm(out, { recursive: true, force: true });
  });

  it('refuses without WOWLIDATOR_BENCH=1, non-zero, naming the variable, writing nothing', async () => {
    const result = await runBench(['--out', out]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /WOWLIDATOR_BENCH/);
    assert.equal(result.stdout, '');
    assert.deepEqual(await readdir(out), []);
  });

  it('with the gate set: exits 0, prints the table, writes <set>-score.json that parses', async () => {
    const result = await runBench(['--out', out], { WOWLIDATOR_BENCH: '1' });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /precision/);
    assert.match(result.stdout, /diagnosis origin × truth/);
    const file = join(out, 'bench-score.json');
    const parsed = parseBenchScoreFile(JSON.parse(await readFile(file, 'utf8')));
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.issue);
    assert.equal(parsed.value.labelSet, 'bench');
    assert.ok(parsed.value.score.cases >= 6);
    assert.ok(parsed.value.score.filedDefects >= 1);
  });

  it('--baseline prints the delta against an earlier score file', async () => {
    const result = await runBench(['--out', out, '--baseline', join(out, 'bench-score.json')], { WOWLIDATOR_BENCH: '1' });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /delta vs /);
    assert.match(result.stdout, /cases 0 · filed 0 · true positives 0 · precision 0\.0 pts/);
    assert.match(result.stdout, /precision × cost/);
  });

  it('--json puts one JSON object on stdout and nothing else', async () => {
    const result = await runBench(['--out', out, '--json'], { WOWLIDATOR_BENCH: '1' });
    assert.equal(result.code, 0, result.stderr);
    const parsed = parseBenchScoreFile(JSON.parse(result.stdout));
    assert.ok(parsed.ok);
  });

  it('a label file that will not parse exits 2 and names the file', async () => {
    const result = await runBench(['--out', out, '--labels', join(ROOT, 'tests', 'fixtures', 'bench', 'README.md')], { WOWLIDATOR_BENCH: '1' });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /README\.md/);
  });

  it('labelSetName names a generic labels.json after its directory', () => {
    assert.equal(labelSetName('/x/tests/fixtures/bench/labels.json'), 'bench');
    assert.equal(labelSetName('/x/sets/regression-2026-09.json'), 'regression-2026-09');
  });
});
