/**
 * Persisted artifacts are parsed at their read seam (Phase C, 2026-09-05).
 *
 * Six readers, one rule each: a file that would change a verdict or trigger
 * an action is rejected the documented way when its authority-bearing
 * shapes are wrong, and read when they are right. Every fixture here is
 * HAND-WRITTEN — never produced by the artifact's own writer — because a
 * reader tested only against its writer proves nothing (the repo's rule).
 * Unit tier: no browser, no model, temp files only.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BaselineSchema,
  HealedSelectorEntrySchema,
  HistoryEntrySchema,
  ProofBundleSchema,
  ProjectGraphSchema,
  SuiteLedgerSchema,
  firstIssue,
  parseArtifact,
  parseProofBundle,
} from '../src/artifacts/schemas.js';
import { CacheManager } from '../src/cache/cache-manager.js';
import { readLedger, LEDGER_VERSION } from '../src/cli/suite-progress.js';
import { ContextEngine } from '../src/context/context-engine.js';
import { readBaseline } from '../src/db/baseline.js';
import { RunHistory } from '../src/history/run-history.js';

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wow-artifacts-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(name: string, content: unknown | string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return path;
}

// --- proof bundle ------------------------------------------------------------

const BUNDLE = {
  runId: 'run-9', name: 'PL_03_18', status: 'error',
  startedAt: '2026-09-05T09:00:00.000Z', finishedAt: '2026-09-05T09:00:02.000Z', durationMs: 2000,
  cdpUrl: 'http://localhost:9222', cachePath: null, healerModel: null,
  summary: { totalSteps: 2, passed: 1, failed: 1, extraCounterFromANewerBuild: 7 },
  steps: [
    { index: 0, action: 'goto', selector: null, resolvedSelector: null, resolution: null, status: 'passed', startedAt: 'x', durationMs: 1, url: 'http://x.test/' },
    { index: 1, action: 'workflow', selector: null, resolvedSelector: null, resolution: null, status: 'error', startedAt: 'x', durationMs: 1, url: 'http://x.test/',
      blocked: { kind: 'blocked', reason: 'capability', rule: 'policy-deny', message: 'held', category: 'delete', target: 'PL_03_18', policySource: 'test' } },
  ],
  defects: [],
};

describe('proof bundles are parsed before the panel scores them', () => {
  it('accepts a hand-written bundle and keeps every field, known or not', () => {
    const parsed = parseProofBundle(BUNDLE);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.value.steps[1]?.blocked?.reason, 'capability');
      assert.equal((parsed.value.summary as unknown as { extraCounterFromANewerBuild: number }).extraCounterFromANewerBuild, 7, 'unknown fields survive');
    }
  });

  it('rejects a step status, a run status or a hold reason outside the engine vocabulary', () => {
    const badStep = { ...BUNDLE, steps: [{ ...BUNDLE.steps[0], status: 'banana' }] };
    const badRun = { ...BUNDLE, status: 'kind-of-passed' };
    const badHold = { ...BUNDLE, steps: [{ ...BUNDLE.steps[1], blocked: { ...BUNDLE.steps[1]!.blocked, reason: 'whatever' } }] };
    for (const [label, value] of [['step', badStep], ['run', badRun], ['hold', badHold]] as const) {
      const parsed = parseProofBundle(value);
      assert.equal(parsed.ok, false, label);
      if (!parsed.ok) assert.match(parsed.issue, /status|reason/);
    }
    assert.equal(parseProofBundle({ runId: 'r', name: 'n', steps: 'not-an-array', summary: {} }).ok, false);
    assert.equal(parseProofBundle('a string').ok, false);
  });

  it('names the first issue by path', () => {
    const result = ProofBundleSchema.safeParse({ ...BUNDLE, steps: [{ ...BUNDLE.steps[0], status: 'banana' }] });
    assert.equal(result.success, false);
    if (!result.success) assert.match(firstIssue(result.error), /^steps\.0\.status: /);
  });
});

// --- suite ledger ------------------------------------------------------------

const LEDGER = {
  version: LEDGER_VERSION, title: 'EC', planned: ['A', 'B'],
  startedAt: '2026-09-05T09:00:00.000Z', updatedAt: '2026-09-05T09:00:01.000Z', generatedAt: null,
  outcomes: {
    A: { verdict: 'passed', status: 'passed', reason: null, reportPath: null, at: '2026-09-05T09:00:01.000Z', browsers: ['http://localhost:9222'] },
  },
  ended: null,
};

describe('the suite ledger is parsed before a resume carries its verdicts', () => {
  it('reads a hand-written ledger and backfills a missing run key', async () => {
    const ledger = await readLedger(await file('ok.progress.json', LEDGER));
    assert.ok(ledger);
    assert.equal(ledger.runKey, null);
    assert.equal(ledger.outcomes['A']?.verdict, 'passed');
  });

  it('refuses a verdict outside the four the suite scores, and the wrong version', async () => {
    const maybe = { ...LEDGER, outcomes: { A: { ...LEDGER.outcomes.A, verdict: 'maybe' } } };
    assert.equal(await readLedger(await file('maybe.progress.json', maybe)), null);
    assert.equal(await readLedger(await file('v0.progress.json', { ...LEDGER, version: LEDGER_VERSION + 1 })), null);
    assert.equal(await readLedger(await file('list.progress.json', { ...LEDGER, outcomes: [] })), null);
    assert.equal(await readLedger(await file('text.progress.json', '{not json')), null);
    assert.equal(parseArtifact(SuiteLedgerSchema, LEDGER).ok, true);
  });
});

// --- context graph -----------------------------------------------------------

const GRAPH = {
  version: 1, rootDir: '/proj', generatedAt: '2026-09-05T09:00:00.000Z', signature: 'sig',
  nodes: [{ id: 'route:/en/plans', kind: 'route', name: '/en/plans', file: 'app/plans/page.tsx', meta: { locale: 'en' } }],
  edges: [{ from: 'route:/en/plans', to: 'component:X', kind: 'renders' }],
  sources: [{ id: 'next-routes', nodes: 1, edges: 1, warnings: [] }],
};

describe('the context graph is parsed before the generator reads it', () => {
  it('loads a hand-written graph', async () => {
    const engine = new ContextEngine({ rootDir: dir, cacheFile: await file('graph.json', GRAPH) });
    const graph = await engine.load();
    assert.equal(graph?.nodes[0]?.kind, 'route');
  });

  it('returns null for nodes that are not a list, or a node of an unknown kind', async () => {
    const stringNodes = new ContextEngine({ rootDir: dir, cacheFile: await file('graph-str.json', { ...GRAPH, nodes: 'route:/x' }) });
    assert.equal(await stringNodes.load(), null);
    const badKind = new ContextEngine({ rootDir: dir, cacheFile: await file('graph-kind.json', { ...GRAPH, nodes: [{ ...GRAPH.nodes[0], kind: 'widget' }] }) });
    assert.equal(await badKind.load(), null);
    assert.equal(parseArtifact(ProjectGraphSchema, GRAPH).ok, true);
  });
});

// --- database baseline -------------------------------------------------------

const BASELINE = {
  version: 1, takenAt: '2026-09-05T09:00:00.000Z', runKey: 'ec@1',
  tables: [{ table: 'benefit_management.benefit_plan', why: ['named'], columns: ['id', 'name'], pk: ['id'], references: [], rowCount: 1, hash: 'h', restorable: true, rows: [{ id: 1, name: 'Dental' }] }],
};

describe('the db baseline is parsed before a restore writes it back', () => {
  it('reads a hand-written baseline', async () => {
    const baseline = await readBaseline(await file('base.json', BASELINE));
    assert.equal(baseline.tables[0]?.pk[0], 'id');
  });

  it('throws, naming the issue, when tables is not a list or a table lacks its rows', async () => {
    await assert.rejects(readBaseline(await file('base-str.json', { ...BASELINE, tables: 'benefit_plan' })), /not a wowlidator db baseline \(tables/);
    await assert.rejects(readBaseline(await file('base-rows.json', { ...BASELINE, tables: [{ ...BASELINE.tables[0], rows: undefined }] })), /tables\.0\.rows/);
    await assert.rejects(readBaseline(await file('base-v2.json', { ...BASELINE, version: 2 })), /version/);
    assert.equal(parseArtifact(BaselineSchema, BASELINE).ok, true);
  });
});

// --- healed-selector cache ---------------------------------------------------

const GOOD_ENTRY = {
  original: '#old', healed: 'role=button[name="Save"]', strategy: 'role', url: 'http://x.test/en/plans',
  confidence: 0.9, reasoning: 'renamed', model: 'm', healedAt: 'x', lastUsedAt: 'x', hits: 2,
};

describe('the healed-selector cache drops a corrupt entry and keeps the rest', () => {
  it('keeps the good entry beside a corrupt one', async () => {
    const path = await file('cache.json', {
      version: 1, updatedAt: 'x',
      entries: { good: GOOD_ENTRY, corrupt: { healed: 42, strategy: 'role' }, halfway: { healed: 'role=x' } },
    });
    const cache = new CacheManager({ filePath: path, warn: false });
    await cache.load();
    assert.equal(cache.get('good')?.healed, GOOD_ENTRY.healed);
    assert.equal(cache.get('corrupt'), undefined);
    assert.equal(cache.get('halfway'), undefined, 'an entry missing the fields the replay reads is not replayed');
    assert.equal(parseArtifact(HealedSelectorEntrySchema, GOOD_ENTRY).ok, true);
  });

  it('treats a file that is not an object as unreadable — empty, never a crash', async () => {
    const cache = new CacheManager({ filePath: await file('cache-list.json', ['not', 'a', 'cache']), warn: false });
    await cache.load();
    assert.equal(cache.get('good'), undefined);
  });
});

// --- run history -------------------------------------------------------------

const HISTORY_LINE = {
  runId: 'r1', name: 'login', status: 'passed', finishedAt: '2026-09-05T09:00:00.000Z', durationMs: 10,
  passed: 2, failed: 0, jitHeals: 0, defects: 0, failedSteps: [],
};

describe('run history skips a line whose status is not one the engine writes', () => {
  it('reads two good lines around a corrupt one and a mis-statused one', async () => {
    const lines = [
      JSON.stringify(HISTORY_LINE),
      '{"runId": "r2", "name": "login", "status": "maybe", "finishedAt": "x", "durationMs": 1, "passed": 0, "failed": 0}',
      '{not json at all',
      JSON.stringify({ ...HISTORY_LINE, runId: 'r3', status: 'failed', failedSteps: ['click:#x'] }),
    ];
    const history = new RunHistory(await file('history.jsonl', lines.join('\n')));
    const entries = await history.load();
    assert.deepEqual(entries.map((e) => e.runId), ['r1', 'r3']);
    assert.deepEqual(entries[1]?.failedSteps, ['click:#x']);
    assert.equal(parseArtifact(HistoryEntrySchema, HISTORY_LINE).ok, true);
  });
});
