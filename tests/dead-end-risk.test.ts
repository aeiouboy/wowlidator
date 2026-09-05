/**
 * Pre-run dead-end risk (`src/generator/dead-end-risk.ts`) — entirely unit-tier.
 *
 * The signals are pure; the model is a `MockLanguageModelV4` through the same
 * `generateStructured` path every role uses; the fail-fast rule in the suite
 * loop is one exported function. Nothing here needs a browser or a key.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { failFastRunOptions } from '../src/cli/run-cases.js';
import type { RunFlowOptions } from '../src/engine/runner.js';
import { AGENT_FAIL_FAST_MAX_STEPS } from '../src/orchestrator/workflow-agent.js';
import {
  DEFAULT_RISK_THRESHOLD,
  LlmRiskModel,
  assessDeadEndRisk,
  buildRiskPrompt,
  describeRisk,
  riskEnabled,
  riskSignals,
  riskThreshold,
  riskVerdict,
  selectorNames,
  type RiskRequest,
} from '../src/generator/dead-end-risk.js';
import { jsonModel } from './helpers.js';

function request(overrides: Partial<RiskRequest> = {}): RiskRequest {
  return {
    caseName: 'PL_05_02 ตรวจสอบการเรียงลำดับข้อมูล',
    caseText: 'Steps: open Benefit Plans; Expected: the default order sorts by Status Active',
    flow: {
      name: 'PL_05_02',
      steps: [
        { action: 'goto', url: 'http://localhost:3000/en/benefits/plans' },
        { action: 'expectVisible', selector: 'role=columnheader[name="Status"]' } as never,
        { action: 'click', selector: 'role=button[name="Export to Excel"]' },
        { action: 'goto', url: 'http://localhost:3000/en/benefits/plans/archive' },
      ],
    },
    documents: [{ name: 'BE-UI-Fields.xlsx', text: 'Benefit Plans table: columns Plan name, Status, Type. Status shows Active / Inactive.' }],
    repository: 'route /[locale]/benefits/plans — page.tsx renders BenefitPlanTable',
    declaredRoutes: ['/:locale/benefits/plans', '/:locale/login'],
    backend: true,
    ...overrides,
  };
}

describe('the threshold and the switch', () => {
  it('is "more than 50%": exactly the line runs, above it fails fast', () => {
    assert.equal(DEFAULT_RISK_THRESHOLD, 0.5);
    assert.equal(riskVerdict(0.5, 0.5), 'run');
    assert.equal(riskVerdict(0.51, 0.5), 'fail-fast');
    // The second dimension (2026-08-28): a near-certain genuine FAIL
    // fail-fasts too — retries only re-prove a fact at full price.
    assert.equal(riskVerdict(0.1, 0.5, 0.51), 'fail-fast');
    assert.equal(riskVerdict(0.1, 0.5, 0.5), 'run');
    assert.equal(riskVerdict(0.1, 0.5), 'run', 'absent fail dimension changes nothing');
  });

  it('reads the env: off switches it off, a percentage moves the line, nonsense keeps the default', () => {
    assert.equal(riskEnabled({}), true);
    assert.equal(riskEnabled({ WOWLIDATOR_RISK: 'off' }), false);
    assert.equal(riskEnabled({ WOWLIDATOR_RISK: 'OFF ' }), false);
    assert.equal(riskThreshold({}), 0.5);
    assert.equal(riskThreshold({ WOWLIDATOR_RISK_THRESHOLD: '70' }), 0.7);
    assert.equal(riskThreshold({ WOWLIDATOR_RISK_THRESHOLD: '0' }), 0.5);
    assert.equal(riskThreshold({ WOWLIDATOR_RISK_THRESHOLD: 'lots' }), 0.5);
  });
});

describe('the signals — facts computed before any model is asked', () => {
  it('names a goto the repository declares no page route for, once per path', () => {
    const signals = riskSignals(request());
    const routes = signals.filter((s) => s.includes('declares no page route'));
    assert.equal(routes.length, 1);
    assert.match(routes[0]!, /step 4: goto \/en\/benefits\/plans\/archive/);
  });

  it('does not flag a declared route mounted below the deployment base path', () => {
    const signals = riskSignals(
      request({
        deploymentUrl: 'https://sit.example.test/humi/th/login',
        flow: { name: 'mounted-login', steps: [{ action: 'goto', url: 'https://sit.example.test/humi/th/login' }] },
      }),
    );
    assert.equal(signals.some((signal) => signal.includes('declares no page route')), false);
  });

  it('names a control label no document, the case, or the repository mentions', () => {
    const signals = riskSignals(request());
    assert.ok(signals.some((s) => s.includes('"Export to Excel"') && s.includes('no document')), signals.join('\n'));
    assert.ok(!signals.some((s) => s.includes('"Status"')), 'Status is in the document — not a signal');
  });

  it('flags a backend step when the backend is off, and an agent workflow step', () => {
    const signals = riskSignals(
      request({
        backend: false,
        flow: {
          name: 'x',
          steps: [
            { action: 'workflow', goal: 'open the archive page and sort it' },
            { action: 'expectStatus', status: 200 } as never,
          ],
        },
      }),
    );
    assert.ok(signals.some((s) => s.startsWith('step 1: an agent workflow step')));
    assert.ok(signals.some((s) => s.includes('step 2: expectStatus — a backend step')));
  });

  it('says when there is no evidence at all to check against', () => {
    const signals = riskSignals(request({ documents: [], repository: '', declaredRoutes: [] }));
    assert.ok(signals.includes('no background document was retrieved for this case'));
    assert.ok(signals.includes('no repository is indexed — routes cannot be checked'));
  });

  it('reads the names out of the selector forms the author writes', () => {
    assert.deepEqual(selectorNames('role=button[name="Save plan"]'), ['Save plan']);
    assert.deepEqual(selectorNames("role=heading[name='Benefit Plans' i]"), ['Benefit Plans']);
    assert.deepEqual(selectorNames('text="Total plans" >> nth=0'), ['Total plans']);
    assert.deepEqual(selectorNames('text=Benefits'), ['Benefits']);
    assert.deepEqual(selectorNames('tr:has-text("Medical")'), ['Medical']);
    assert.deepEqual(selectorNames('#submit'), []);
  });
});

describe('the prompt', () => {
  it('carries the case, every step numbered, the signals, the routes, the repository and the documents', () => {
    const req = request();
    const prompt = buildRiskPrompt(req, riskSignals(req));
    assert.match(prompt, /CASE: PL_05_02/);
    assert.match(prompt, /FLOW \(4 steps\):\n1\. \{"action":"goto"/);
    assert.match(prompt, /SIGNALS \(computed from the code — facts\):\n- step 3/);
    assert.match(prompt, /DECLARED PAGE ROUTES \(2\)/);
    assert.match(prompt, /REPOSITORY:\nroute \/\[locale\]\/benefits\/plans/);
    assert.match(prompt, /DOCUMENT "BE-UI-Fields.xlsx":\nBenefit Plans table/);
  });

  it('keeps the documents inside a budget rather than sending a spec whole', () => {
    const big = { name: 'spec.md', text: 'x'.repeat(50_000) };
    const prompt = buildRiskPrompt(request({ documents: [big, big, big, big, big] }), []);
    assert.ok(prompt.length < 12_000, String(prompt.length));
  });
});

describe('the model and the record', () => {
  it('turns the model answer into a fail-fast record above the line, with tokens and evidence kept', async () => {
    const model = new LlmRiskModel({
      model: jsonModel('mock-risk', { likelihood: 72, reasons: ['step 4: /archive is not a declared route'], missing: ['an archive page'] }, { inputTokens: 900, outputTokens: 40 }),
      id: 'mock:risk',
    });
    const risk = await assessDeadEndRisk(request(), { model });
    assert.ok(risk);
    assert.equal(risk.verdict, 'fail-fast');
    assert.equal(risk.likelihood, 0.72);
    assert.equal(risk.threshold, 0.5);
    assert.equal(risk.model, 'mock:risk');
    assert.equal(risk.inputTokens, 900);
    assert.deepEqual(risk.reasons, ['step 4: /archive is not a declared route']);
    assert.ok(risk.signals.length >= 2, 'the computed signals ride on the record');
    assert.match(describeRisk(risk), /^fail-fast: pre-run dead-end risk 72% > 50% — ran once, no healer, no reconstruction, no repair; the agent allowed once per step/);
  });

  it('a near-certain genuine fail fail-fasts on its own dimension, and the note names it', async () => {
    // PL_02_07-shaped: the sheet's Actual Result records Failed; a rerun
    // most likely fails the same way, and retries only re-prove it.
    const model = new LlmRiskModel({
      model: jsonModel('mock-risk', { likelihood: 15, failLikelihood: 85, reasons: ["the sheet's Actual Result records this case as Failed"], missing: [] }, { inputTokens: 1, outputTokens: 1 }),
      id: 'mock:risk',
    });
    const risk = await assessDeadEndRisk(request({ knownResult: 'failed' }), { model });
    assert.ok(risk);
    assert.equal(risk.verdict, 'fail-fast');
    assert.equal(risk.failLikelihood, 0.85);
    assert.ok(
      risk.signals.some((s) => s.includes('Actual Result records this case as FAILED')),
      risk.signals.join('|'),
    );
    assert.match(describeRisk(risk), /expected-fail risk 85% > 50%.*retries only re-prove/);
  });

  it('runs the ordinary way at or below the line, and says so', async () => {
    const model = new LlmRiskModel({ model: jsonModel('mock-risk', { likelihood: 50, reasons: [], missing: [] }, { inputTokens: 1, outputTokens: 1 }) });
    const risk = await assessDeadEndRisk(request(), { model, threshold: 0.5 });
    assert.equal(risk?.verdict, 'run');
    assert.match(describeRisk(risk!), /^pre-run dead-end risk 50%, expected-fail risk 0% — both ≤ 50%, ran with every retry path on/);
  });

  it('never throws — a judge that fails is a case that runs the ordinary way, logged once', async () => {
    const lines: string[] = [];
    const risk = await assessDeadEndRisk(request(), {
      model: { id: 'broken', assess: async () => { throw new Error('429 rate limited\nmore'); } },
      log: (line) => lines.push(line),
    });
    assert.equal(risk, null);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /risk assessment skipped for PL_05_02 .*: 429 rate limited — the case runs the ordinary way/);
  });
});

describe('the fail-fast run', () => {
  it('removes every RERUN path, keeps the agent once per step — and nothing else changed', () => {
    // Refined 2026-08-28: "on encountering risk, still allow agent only once
    // per step; if encountering failure, do not rerun". Once-per-step holds
    // by construction — stepRepair off means a step fails at most once, so
    // the ladder (and its one agent consult) walks at most once.
    const base = {
      cdpUrl: 'http://localhost:9222',
      healer: undefined,
      makeHealer: (() => null) as unknown as RunFlowOptions['makeHealer'],
      agent: {} as RunFlowOptions['agent'],
      agentAssist: true,
      stepRepair: {} as RunFlowOptions['stepRepair'],
      reviewJudge: {} as RunFlowOptions['reviewJudge'],
      backend: true,
      video: 'on',
    } as RunFlowOptions;
    const fast = failFastRunOptions(base);
    assert.equal(fast.healer, null, 'the healer is a model retry of the selector — off');
    assert.equal(fast.makeHealer, undefined);
    assert.equal(fast.agent, base.agent, 'the agent stays — one consult at the step that failed');
    assert.equal(fast.agentAssist, base.agentAssist, 'the assist rung is that one consult');
    assert.equal(fast.stepRepair, null, 'no reconstruction — a failed step is not rerun');
    assert.equal(fast.reviewJudge, base.reviewJudge, 'the review judge is cheap and a verdict, not a retry');
    assert.equal(fast.backend, true);
    assert.equal(fast.video, 'on');
    assert.equal(fast.cdpUrl, base.cdpUrl);
    assert.equal(
      fast.agentMaxSteps,
      AGENT_FAIL_FAST_MAX_STEPS,
      'the one shot the agent still gets is on a shorter leash, not an unbounded one (2026-09-02, HIR-EC-010)',
    );
  });

  it('never loosens an explicit tighter cap the caller already set', () => {
    const base = { cdpUrl: 'http://localhost:9222', agentMaxSteps: 6 } as RunFlowOptions;
    const fast = failFastRunOptions(base);
    assert.equal(fast.agentMaxSteps, 6, 'the caller already asked for something tighter — Math.min keeps it');
  });
});
