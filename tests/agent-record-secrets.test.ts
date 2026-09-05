import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AgentAction, AgentRecord, StepDecision } from '../src/engine/proof-bundle.js';
import { redactAgentRecord, redactStepDecision } from '../src/engine/runner.js';

const PASSWORD = 'raw-password-2026';

function action(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    index: 0,
    action: 'paste',
    selector: 'input[type="password"]',
    value: PASSWORD,
    url: `https://app.test/login?echo=${PASSWORD}`,
    reasoning: `paste ${PASSWORD}`,
    ok: true,
    error: `page rejected ${PASSWORD}`,
    observed: PASSWORD,
    durationMs: 10,
    ...overrides,
  };
}

function record(actions: AgentAction[]): AgentRecord {
  return {
    goal: `sign in using ${PASSWORD}`,
    model: 'test:agent',
    success: false,
    summary: `could not use ${PASSWORD}`,
    actions,
    observations: [{ selector: '#status', text: PASSWORD, url: `https://app.test/${PASSWORD}` }],
    turns: 1,
    maxSteps: 2,
    latencyMs: 10,
    settledEvidence: `field contained ${PASSWORD}`,
  };
}

describe('agent records are safe to persist', () => {
  it('removes a pasted password from every serialized record field', () => {
    const safe = redactAgentRecord(record([action()]));
    const serialized = JSON.stringify(safe);
    assert.doesNotMatch(serialized, new RegExp(PASSWORD));
    assert.match(serialized, /••••/);
  });

  it('masks a supplied secret even when the selector is not password-shaped', () => {
    const token = 'run-scoped-secret';
    const safe = redactAgentRecord(
      record([action({ action: 'fill', selector: '#opaque-field', value: token })]),
      new Set([token]),
    );
    assert.doesNotMatch(JSON.stringify(safe), new RegExp(token));
  });

  it('does not rewrite the live record or ordinary input values', () => {
    const ordinary = action({ action: 'fill', selector: 'role=textbox[name="Search"]', value: 'PL_03_18' });
    const original = record([ordinary]);
    const safe = redactAgentRecord(original);
    assert.equal(safe.actions[0]?.value, 'PL_03_18');
    assert.equal(original.actions[0]?.value, 'PL_03_18');
  });

  it('removes the same secret from a nested step decision', () => {
    const decision: StepDecision = {
      observed: `password field holds ${PASSWORD}`,
      decided: `paste input[type="password"] = ${PASSWORD}`,
      because: `needed ${PASSWORD}`,
      actions: [action()],
      resolved: true,
      model: 'test:agent',
    };
    assert.doesNotMatch(JSON.stringify(redactStepDecision(decision)), new RegExp(PASSWORD));
  });
});
