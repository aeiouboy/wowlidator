/**
 * The agent's static contract is byte-stable and capability-honest (Phase C,
 * 2026-09-05). Unit tier: no browser; the one model call is a mock.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_ACTIONS,
  LlmAgentModel,
  agentContract,
  buildUserPrompt,
  type AgentObservation,
} from '../src/orchestrator/workflow-agent.js';
import { jsonModel } from './helpers.js';

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

const TREE = `RootWebArea "Plans" url="http://x.test/en/plans"
heading "Plans"
button "Create Plan"`;

function observation(overrides: Partial<AgentObservation> = {}): AgentObservation {
  return {
    goal: 'open the Create Plan dialog',
    url: 'http://x.test/en/plans',
    axTree: TREE,
    caseContext: 'PL_02_01 — the Create Plan dialog opens',
    history: [],
    stepsRemaining: 10,
    ...overrides,
  };
}

describe('agentContract — one configuration, one set of bytes', () => {
  it('hands back the same system string and schema instance for equal options', () => {
    const a = agentContract({ dbCount: true, skills: ['tables-and-pagination', 'auth-and-consent'] });
    const b = agentContract({ dbCount: true, skills: ['auth-and-consent', 'tables-and-pagination'] });
    assert.equal(a.system, b.system);
    assert.equal(a.schema, b.schema, 'order of ids does not make a new contract');
    assert.notEqual(a.system, agentContract({ dbCount: true, skills: [] }).system);
    assert.notEqual(a.schema, agentContract({ dbCount: false, skills: ['auth-and-consent', 'tables-and-pagination'] }).schema, 'a different capability is a different contract');
  });

  it('withdraws dbCount from the schema and the descriptions together, without touching AGENT_ACTIONS', () => {
    const on = agentContract({ dbCount: true, skills: [] });
    const off = agentContract({ dbCount: false, skills: [] });
    const decision = { action: 'dbCount', selector: 'benefit_plan', value: '', url: '', reasoning: 'count', next: [] };
    assert.equal(on.schema.safeParse(decision).success, true);
    assert.equal(off.schema.safeParse(decision).success, false);
    assert.equal(off.schema.safeParse({ ...decision, action: 'click', selector: 'role=button[name="Create Plan"]' }).success, true);
    assert.ok(!off.actions.includes('dbCount'));
    assert.ok(on.actions.includes('dbCount'));
    assert.ok(AGENT_ACTIONS.includes('dbCount'), 'the vocabulary itself is unchanged');
    assert.ok(!off.system.includes('dbCount'));
    assert.ok(!JSON.stringify(off.schema.safeParse({ ...decision, action: 'click' })).includes('dbCount'));
  });

  it('keeps the policy blocks in every variant', () => {
    for (const options of [
      { dbCount: true, skills: [] },
      { dbCount: false, skills: [] },
      { dbCount: true, skills: ['auth-and-consent', 'forms-and-required-fields', 'tables-and-pagination', 'date-pickers', 'wizards'] },
    ]) {
      const { system } = agentContract(options);
      assert.ok(system.includes('WHAT THE LOOP WILL REFUSE'), JSON.stringify(options));
      assert.ok(system.includes('\nRules:\n'), JSON.stringify(options));
      assert.ok(system.includes('Do not take destructive actions'), JSON.stringify(options));
    }
  });
});

describe('buildUserPrompt — stable-first', () => {
  it('shares its prefix through the end of the tree when only the per-turn parts change', () => {
    const first = buildUserPrompt(observation());
    const later = buildUserPrompt(
      observation({
        url: 'http://x.test/en/plans?step=2',
        history: ['click role=button[name="Create Plan"] — ok, still at http://x.test/en/plans'],
        stepsRemaining: 7,
        feedback: 'you already did that',
      }),
    );
    const treeEnd = first.indexOf('Accessibility tree:') + 'Accessibility tree:'.length + TREE.length;
    assert.ok(treeEnd > 0);
    assert.ok(commonPrefixLength(first, later) >= treeEnd, `prefix ${commonPrefixLength(first, later)} < tree end ${treeEnd}`);
  });
});

describe('LlmAgentModel — cache telemetry', () => {
  it('reports the provider\'s cache reads on the decision', async () => {
    const model = jsonModel(
      'mock-agent-cache',
      { action: 'click', selector: 'role=button[name="Create Plan"]', value: '', url: '', reasoning: 'open it', next: [] },
      { inputTokens: 900, outputTokens: 20, cacheRead: 850 },
    );
    const agent = new LlmAgentModel({ model, id: 'mock:agent-cache' });
    const decision = await agent.decide(observation({ dbCount: true, skills: ['tables-and-pagination'] }));
    assert.equal(decision.action, 'click');
    assert.equal(decision.inputTokens, 900);
    assert.equal(decision.cachedInputTokens, 850);
  });
});
