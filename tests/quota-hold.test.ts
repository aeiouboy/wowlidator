/**
 * The quota hold's policy is one pure function; the process-wide state
 * around it is exercised without any network — `ensureQuotaHold` is only
 * checked for what it refuses to arm.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_QUOTA_HOLD_PERCENT,
  QUOTA_HOLD_HYSTERESIS,
  quotaHoldDecision,
  quotaHoldPercent,
  spendsClaudeWindow,
  ensureQuotaHold,
  quotaHolding,
  stopQuotaHold,
} from '../src/cli/quota-hold.js';
import type { WowlidatorConfig } from '../src/config.js';

const T = 85;

describe('quotaHoldDecision', () => {
  it('holds at the threshold and stays held just under it', () => {
    assert.equal(quotaHoldDecision(false, { percent: 84, resetsAt: null }, T), false);
    assert.equal(quotaHoldDecision(false, { percent: 85, resetsAt: null }, T), true);
    assert.equal(quotaHoldDecision(true, { percent: 82, resetsAt: null }, T), true, 'inside the hysteresis band');
    assert.equal(quotaHoldDecision(true, { percent: T - QUOTA_HOLD_HYSTERESIS - 1, resetsAt: null }, T), false);
  });

  it('a reset that has passed reopens the lanes; one still ahead does not', () => {
    const now = Date.parse('2026-09-05T12:30:00Z');
    assert.equal(quotaHoldDecision(true, { percent: 4, resetsAt: '2026-09-05T12:20:00Z' }, T, now), false);
    assert.equal(quotaHoldDecision(true, { percent: 90, resetsAt: '2026-09-05T12:20:00Z' }, T, now), true, 'reset passed but the number says otherwise — trust the number');
    assert.equal(quotaHoldDecision(true, { percent: 83, resetsAt: '2026-09-05T13:20:00Z' }, T, now), true);
  });

  it('an unavailable reading changes nothing either way', () => {
    assert.equal(quotaHoldDecision(false, { percent: null, resetsAt: null }, T), false);
    assert.equal(quotaHoldDecision(true, { percent: null, resetsAt: null }, T), true);
  });
});

describe('quotaHoldPercent', () => {
  it('default, a number, or off', () => {
    assert.equal(quotaHoldPercent({}), DEFAULT_QUOTA_HOLD_PERCENT);
    assert.equal(quotaHoldPercent({ WOWLIDATOR_QUOTA_HOLD_PERCENT: '70' }), 70);
    assert.equal(quotaHoldPercent({ WOWLIDATOR_QUOTA_HOLD_PERCENT: 'off' }), null);
    assert.equal(quotaHoldPercent({ WOWLIDATOR_QUOTA_HOLD_PERCENT: '0' }), null);
    assert.equal(quotaHoldPercent({ WOWLIDATOR_QUOTA_HOLD_PERCENT: '250' }), DEFAULT_QUOTA_HOLD_PERCENT, 'nonsense falls back to the default, never to off');
  });
});

describe('arming', () => {
  const roles = (provider: string): WowlidatorConfig =>
    ({ roles: { generator: { provider, modelId: 'x' }, agent: { provider: 'groq', modelId: 'x' } } }) as unknown as WowlidatorConfig;

  it('only a suite that spends the window arms a hold', () => {
    assert.equal(spendsClaudeWindow(roles('claude-cli')), true);
    assert.equal(spendsClaudeWindow(roles('groq')), false);
    assert.equal(ensureQuotaHold(roles('groq'), undefined, {}), false);
    assert.equal(quotaHolding(), false);
    assert.equal(ensureQuotaHold(roles('claude-cli'), undefined, { WOWLIDATOR_QUOTA_HOLD_PERCENT: 'off' }), false);
    stopQuotaHold();
  });
});
