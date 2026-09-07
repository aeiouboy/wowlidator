import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { dataGateFor, SectionLocks } from '../src/cli/data-locks.js';
import {
  caseCeilingReason,
  providerFailureLine,
  runCaseWithDeadline,
} from '../src/cli/run-cases.js';
import {
  DEFAULT_CASE_TIMEOUT_MS,
  parseCaseTimeout,
} from '../src/cli/options.js';
import { remaining, newLedger, recordOutcome } from '../src/cli/suite-progress.js';
import { writeProofBundle, type ProofBundle } from '../src/engine/proof-bundle.js';
import type { Flow } from '../src/engine/runner.js';

const partialBundle = (): ProofBundle => ({
  runId: 'partial',
  name: 'slow case',
  status: 'failed',
  startedAt: '2026-09-07T00:00:00.000Z',
  finishedAt: '2026-09-07T00:00:01.000Z',
  durationMs: 1_000,
  cdpUrl: null,
  cachePath: null,
  healerModel: null,
  summary: {
    totalSteps: 1,
    passed: 1,
    failed: 0,
    frontend: { steps: 1, passed: 1, failed: 0, defects: 0 },
    backend: { steps: 0, passed: 0, failed: 0, defects: 0 },
    fastPath: 1,
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
  steps: [{
    index: 0,
    action: 'goto',
    selector: null,
    resolvedSelector: null,
    resolution: null,
    status: 'passed',
    startedAt: '2026-09-07T00:00:00.000Z',
    durationMs: 10,
    url: 'https://app.example.test/start',
  }],
  defects: [],
});

describe('the suite case ceiling', () => {
  it('cuts a slow case, keeps its partial bundle, and releases its data lock for the next case', async () => {
    // Given: a writer owns the suite's real section lock and only its abort path releases it.
    const locks = new SectionLocks();
    const flow: Flow = {
      name: 'writer',
      steps: [
        { action: 'goto', url: 'https://app.example.test/admin/items' },
        { action: 'fill', selector: '#name', value: 'x' },
        { action: 'expectVisible', selector: '#saved' },
      ],
    };
    const gate = dataGateFor(flow, locks);
    assert.ok(gate !== null);
    await gate.before(flow.steps[1]!);
    assert.deepEqual(locks.heldSections, ['route:admin/items']);

    // When: its case promise outlives the ceiling.
    const result = await runCaseWithDeadline(
      async (signal) => {
        assert.ok(signal !== undefined);
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        try {
          return partialBundle();
        } finally {
          gate.releaseAll();
        }
      },
      { timeoutMs: 5, startedMs: Date.now() },
    );

    // Then: the evidence survives, the outcome is a resumable non-verdict, and the next writer can lock.
    assert.equal(result.ceilingReached, true);
    assert.equal(result.bundle.steps.length, 1);
    const reason = caseCeilingReason(5, result.elapsedMs);
    assert.match(reason, /case ceiling.*no verdict.*--resume runs it again/);
    result.bundle.notes = [reason];
    const artifactDir = await mkdtemp(join(tmpdir(), 'wowlidator-case-ceiling-'));
    try {
      const proofPath = await writeProofBundle(result.bundle, artifactDir);
      const written = JSON.parse(await readFile(proofPath, 'utf8')) as ProofBundle;
      assert.equal(written.steps.length, 1);
      assert.deepEqual(written.notes, [reason]);
    } finally {
      await rm(artifactDir, { recursive: true, force: true });
    }
    assert.deepEqual(locks.heldSections, []);
    const nextGate = dataGateFor(flow, locks);
    assert.ok(nextGate !== null);
    await nextGate.before(flow.steps[1]!);
    assert.deepEqual(locks.heldSections, ['route:admin/items']);
    nextGate.releaseAll();
  });

  it('leaves a case that finishes inside the ceiling byte-identical', async () => {
    const bundle = partialBundle();
    const before = JSON.stringify(bundle);
    const result = await runCaseWithDeadline(async () => bundle, {
      timeoutMs: 1_000,
      startedMs: Date.now(),
    });
    assert.equal(result.ceilingReached, false);
    assert.equal(JSON.stringify(result.bundle), before);
  });

  it('keeps a ceiling-cut blocked case in remaining for a plain resume', () => {
    const ledger = newLedger('deadline', ['A_1']);
    recordOutcome(ledger, {
      name: 'A_1 slow',
      verdict: 'blocked',
      bundle: partialBundle(),
      reason: caseCeilingReason(1_200_000, 1_200_004),
    });
    assert.deepEqual(remaining(ledger), ['A_1']);
  });
});

describe('case ceiling configuration', () => {
  it('uses flag over environment over the measured default', () => {
    assert.equal(parseCaseTimeout(undefined, {}), DEFAULT_CASE_TIMEOUT_MS);
    assert.equal(parseCaseTimeout(undefined, { WOWLIDATOR_CASE_TIMEOUT_MS: '9000' }), 9_000);
    assert.equal(parseCaseTimeout('3', { WOWLIDATOR_CASE_TIMEOUT_MS: '9000' }), 3_000);
  });

  it('accepts off and zero as disabled', () => {
    assert.equal(parseCaseTimeout('off', { WOWLIDATOR_CASE_TIMEOUT_MS: '9000' }), 0);
    assert.equal(parseCaseTimeout('0', { WOWLIDATOR_CASE_TIMEOUT_MS: '9000' }), 0);
  });
});

describe('provider failure roll-up', () => {
  it('prints non-zero role counts in the suite order', () => {
    assert.equal(
      providerFailureLine(new Map([['agent', 4], ['generator', 311], ['healer', 215]])),
      'provider failures: generator 311 · healer 215 · agent 4 (each degraded one step, never the verdict)',
    );
  });

  it('is absent when no provider failures were recorded', () => {
    assert.equal(providerFailureLine(new Map()), null);
  });
});
