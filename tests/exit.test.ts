/**
 * The exit-code contract's reading of a workflow leg the MODEL ended (task
 * C3, 2026-09-05).
 *
 * Before, every failing `workflow` step was an `error` under one wording —
 * "runtime error — the harness ended this case" — whether the harness, the
 * page or the model's own `fail` ended it. The typed `endedBy` on the record
 * lets `harnessOnly` say what actually happened: a `fail` is the agent's own
 * account, unverified, and is worded as that; the case still scores blocked
 * (no verdict) and the suite still exits 3. Pure over hand-written bundles.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { AgentRecord, ProofBundle, ProofStep } from '../src/engine/proof-bundle.js';
import { EXIT, exitCodeFor, harnessOnly, neverRan, suiteExit } from '../src/cli/exit.js';

function agent(over: Partial<AgentRecord>): AgentRecord {
  return {
    goal: 'reach the reporting screen',
    model: 'stub',
    success: false,
    summary: 'agent stopped',
    actions: [],
    turns: 2,
    maxSteps: 12,
    latencyMs: 800,
    ...over,
  };
}

function workflowStep(over: Partial<ProofStep>): ProofStep {
  return {
    index: 1,
    action: 'workflow',
    selector: null,
    resolvedSelector: null,
    resolution: null,
    status: 'error',
    startedAt: '2026-09-05T09:00:01.000Z',
    durationMs: 800,
    url: 'http://x.test/en/form',
    ...over,
  };
}

function bundle(step: ProofStep): ProofBundle {
  return {
    runId: 'run-c3',
    name: 'RPT-01',
    status: 'error',
    startedAt: '2026-09-05T09:00:00.000Z',
    finishedAt: '2026-09-05T09:00:02.000Z',
    durationMs: 2_000,
    cdpUrl: 'http://localhost:9222',
    cachePath: null,
    healerModel: null,
    summary: {
      totalSteps: 2, passed: 1, failed: 1,
      frontend: { steps: 2, passed: 1, failed: 1, defects: 0 }, backend: { steps: 0, passed: 0, failed: 0, defects: 0 },
      fastPath: 1, caseRetries: 0, cacheHits: 0, jitHeals: 0, dialogsDismissed: 0, agentTakeovers: 1, visualChecks: 0, visualFailures: 0,
      dataRetries: 0, apiRequests: 0, apiFailures: 0, dbChecks: 0, dbFailures: 0, networkCalls: 0, networkFailures: 0, backendBlocked: 0,
      healUnavailable: 0, networkDropped: 0, healLatencyMs: 0, agentLatencyMs: 800, inputTokens: 0, outputTokens: 0, defects: 0,
    },
    steps: [
      { index: 0, action: 'goto', selector: null, resolvedSelector: null, resolution: null, status: 'passed', startedAt: '2026-09-05T09:00:00.000Z', durationMs: 300, url: 'http://x.test/en/form' },
      step,
    ],
    defects: [],
    error: `run completed with 1 error:\n  ERROR: workflow — ${step.error ?? ''}`,
  } as ProofBundle;
}

describe("harnessOnly words a leg the model ended as the agent's own account", () => {
  const claim = 'the reporting screen is not linked from this page';
  const claimed = bundle(
    workflowStep({
      error: `workflow agent failed: agent reported the goal is unreachable: ${claim}`,
      agent: agent({
        endedBy: 'fail',
        summary: `agent reported the goal is unreachable: ${claim}`,
        unreachable: { claim, urlAfter: 'http://x.test/en/form', headingsAfter: ['Employment'] },
      }),
    }),
  );

  it("says 'no verdict — the agent's own account, unverified' with the claim, read off the record", () => {
    assert.equal(neverRan(claimed), null, 'a step did break');
    assert.equal(harnessOnly(claimed), `no verdict — the agent's own account, unverified: ${claim}`);
  });

  it('still scores blocked and exits as the environment family — never 1', () => {
    assert.equal(exitCodeFor(claimed), EXIT.environment);
    assert.equal(suiteExit([{ name: 'RPT-01', verdict: 'blocked', bundle: claimed, reason: harnessOnly(claimed) ?? undefined }]), EXIT.environment);
    assert.equal(suiteExit([{ name: 'RPT-01', verdict: 'blocked', bundle: claimed }, { name: 'OK', verdict: 'passed', bundle: null }]), EXIT.environment);
  });

  it('falls back to the summary when the record has no unreachable block, and takes the first line only', () => {
    const noBlock = bundle(workflowStep({ error: 'x', agent: agent({ endedBy: 'fail', summary: 'agent reported the goal is unreachable: gone\nsecond line' }) }));
    assert.equal(harnessOnly(noBlock), "no verdict — the agent's own account, unverified: agent reported the goal is unreachable: gone");
  });

  it('a harness stop keeps the runtime-error wording, and a held leg keeps blocked (…)', () => {
    const budget = bundle(
      workflowStep({
        error: 'workflow agent stopped by a harness limit (the 12-turn ceiling): agent gave up after 12 turns without reaching the goal',
        agent: agent({ endedBy: 'budget', summary: 'agent gave up after 12 turns without reaching the goal' }),
      }),
    );
    assert.match(harnessOnly(budget) ?? '', /^runtime error — the harness ended this case, not the application: workflow agent stopped by a harness limit \(the 12-turn ceiling\)/);
    assert.equal(exitCodeFor(budget), EXIT.environment);

    const held = bundle(
      workflowStep({
        error: 'workflow blocked (capability, policy-deny): held',
        blocked: { kind: 'blocked', reason: 'capability', rule: 'policy-deny', message: 'held', category: 'delete', target: null, policySource: 'test' },
        agent: agent({ endedBy: 'blocked', summary: 'agent blocked (capability): held' }),
      }),
    );
    assert.match(harnessOnly(held) ?? '', /^blocked \(capability, policy-deny\)/);

    // A record from an older build — no endedBy at all — reads as it always did.
    const older = bundle(workflowStep({ error: 'workflow agent failed: agent reported the goal is unreachable: gone', agent: agent({}) }));
    assert.match(harnessOnly(older) ?? '', /^runtime error — the harness ended this case/);
  });

  it("a contradicted claim beside a real failed step does not soften the verdict — the page's finding outranks the account", () => {
    const withFailure = bundle(workflowStep({ error: 'x', agent: agent({ endedBy: 'fail', unreachable: { claim: 'c', urlAfter: 'u', headingsAfter: [] } }) }));
    withFailure.steps.push({ ...withFailure.steps[0]!, index: 2, action: 'expectText', status: 'failed', error: 'expected "75"' });
    withFailure.status = 'failed';
    assert.equal(harnessOnly(withFailure), null);
    assert.equal(exitCodeFor(withFailure), EXIT.failed);
  });

  it('a cannot-offer leg is a failed step, so the case is a real failure, not a blocked one', () => {
    const evidence = bundle(
      workflowStep({
        status: 'failed',
        error: 'workflow agent failed on the page\'s own evidence: agent stopped: the goal\'s Employee Group = "Z" is not among the 9 option(s) the control offers',
        detail: { expected: 'Z', actual: '"Employee Group" offered 9 option(s): "A", "B"' },
        agent: agent({ endedBy: 'cannot-offer' }),
      }),
    );
    evidence.status = 'failed';
    assert.equal(harnessOnly(evidence), null);
    assert.equal(exitCodeFor(evidence), EXIT.failed);
  });
});
