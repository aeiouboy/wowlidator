/**
 * Durable replay memory must be secret-safe and schema-valid — unit-tier, no
 * browser and no model.
 *
 * Two facts, both about what ends up on disk:
 *
 * - `scriptOf` is the single writer for BOTH persistence paths — the healed-
 *   selector cache (`#remember` → `cacheAgentMemory`) and the flow file's own
 *   `script` field (`withWorkflowScripts`). A successful agent `fill` of a
 *   password used to travel into both in the clear, while the human-facing
 *   done ledger masked it. This file is the regression the design note asked
 *   for: no raw password bytes in either sink.
 * - A replay script read back off disk is parsed, not asserted. It was written
 *   by another process, it can be edited by hand, and what comes out of it is
 *   replayed against a live application.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CacheManager } from '../src/cache/cache-manager.js';
import type { AgentAction, AgentRecord } from '../src/engine/proof-bundle.js';
import type { Flow } from '../src/engine/runner.js';
import { withWorkflowScripts } from '../src/cli/case-plan.js';
import { cacheAgentMemory, scriptOf } from '../src/orchestrator/workflow-agent.js';

/** The very password `src/api/redact.ts` measured leaking out of a real bundle. */
const PASSWORD = 'admin2026';

function action(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    index: 0,
    action: 'click',
    selector: 'role=button[name="Next"]',
    value: '',
    url: 'https://app.example.com/en/login',
    reasoning: 'move on',
    ok: true,
    durationMs: 12,
    ...overrides,
  };
}

/** A sign-in journey: the email, the password, the submit. */
const SIGN_IN: AgentAction[] = [
  action({ index: 0, action: 'fill', selector: 'role=textbox[name="Email"]', value: 'hrbp@example.com' }),
  action({ index: 1, action: 'fill', selector: 'input[type="password"]', value: PASSWORD }),
  action({ index: 2, action: 'click', selector: 'role=button[name="Sign in"]' }),
];

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    goal: 'sign in as the HRBP and open /en/employees',
    model: 'test:agent',
    success: true,
    summary: 'reached /en/employees',
    actions: SIGN_IN,
    turns: 3,
    maxSteps: null,
    latencyMs: 100,
    ...overrides,
  };
}

function memoryCache(): CacheManager {
  // No `load()`: the file is never read, so this is an in-memory cache with
  // the real merge, key and strategy behaviour.
  return new CacheManager({ filePath: '.wowlidator/never-written.json', warn: false });
}

describe('a durable script never carries a credential', () => {
  it('suppresses the whole script of a journey that typed a password', () => {
    const steps = scriptOf(SIGN_IN);
    assert.deepEqual(steps, [], 'nothing is remembered from a journey with a secret in it');
    assert.doesNotMatch(JSON.stringify(steps), new RegExp(PASSWORD));
  });

  it('writes nothing into the healed-selector cache for such a journey', () => {
    const cache = memoryCache();
    const memory = cacheAgentMemory(cache);
    const key = 'https://app.example.com/en/login :: workflow :: sign in';

    const steps = scriptOf(SIGN_IN);
    // `#remember`'s own rule, stated here because the method is private: an
    // empty list is never written. Suppressing the script therefore suppresses
    // the cache entry, with no second guard to keep in step.
    if (steps.length > 0) memory.set(key, steps, 'test:agent');

    assert.equal(cache.get(key), undefined);
    assert.equal(memory.get(key), undefined);
  });

  it('leaves no password byte in the cache file that is actually written', async () => {
    // The exit condition, checked against the artifact rather than against the
    // in-memory map: flush a real cache file and read its bytes back.
    const dir = await mkdtemp(join(tmpdir(), 'wowlidator-replay-'));
    try {
      const cache = new CacheManager({ filePath: join(dir, 'cache.json'), warn: false });
      const memory = cacheAgentMemory(cache);
      const key = 'https://app.example.com/en/login :: workflow :: sign in';
      const steps = scriptOf(SIGN_IN);
      if (steps.length > 0) memory.set(key, steps, 'test:agent');
      // One ordinary entry beside it, so the file is genuinely written.
      memory.set(
        'https://app.example.com/en/plans :: workflow :: open the plan',
        scriptOf([action({ action: 'click', selector: 'role=button[name="Open"]' })]),
        'test:agent',
      );
      await cache.flush();
      const written = await readFile(join(dir, 'cache.json'), 'utf8');
      assert.match(written, /workflow-replay/, 'the file really holds a replay');
      assert.doesNotMatch(written, new RegExp(PASSWORD));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stamps no script onto the flow file for such a journey', () => {
    const flow: Flow = {
      name: 'sign in',
      steps: [{ action: 'workflow', goal: 'sign in as the HRBP and open /en/employees' }],
    };
    const rewritten = withWorkflowScripts(flow, [record()]);
    assert.equal(rewritten, null, 'nothing changed, so there is nothing to write');
  });

  it('catches a password typed key-by-key, and one pasted in', () => {
    for (const kind of ['type', 'paste'] as const) {
      const typed = [
        action({ index: 0, action: kind, selector: 'input[type="password"]', value: PASSWORD }),
        action({ index: 1, action: 'click', selector: 'role=button[name="Sign in"]' }),
      ];
      assert.deepEqual(scriptOf(typed), [], kind);
    }
  });

  it('catches the field named rather than typed', () => {
    for (const selector of [
      'role=textbox[name="Password"]',
      '#passwd',
      'input[name="pwd"]',
      'role=textbox[name="รหัสผ่าน" i] >> nth=0 >> input[type="PASSWORD"]',
    ]) {
      const typed = [action({ action: 'fill', selector, value: PASSWORD })];
      assert.deepEqual(scriptOf(typed), [], selector);
    }
  });

  it('still remembers an ordinary journey in full', () => {
    const ordinary: AgentAction[] = [
      action({ index: 0, action: 'fill', selector: 'role=textbox[name="Search"]', value: 'PL_03_18' }),
      action({ index: 1, action: 'click', selector: 'role=button[name="Search"]' }),
      action({ index: 2, action: 'goto', url: 'https://app.example.com/en/plans' }),
      action({ index: 3, action: 'wait' }),
      action({ index: 4, action: 'finish' }),
      action({ index: 5, action: 'click', selector: 'role=button[name="Nope"]', ok: false }),
    ];
    assert.deepEqual(scriptOf(ordinary), [
      { action: 'fill', selector: 'role=textbox[name="Search"]', value: 'PL_03_18', url: '' },
      { action: 'click', selector: 'role=button[name="Search"]', value: '', url: '' },
      { action: 'goto', selector: 'role=button[name="Next"]', value: '', url: 'https://app.example.com/en/plans' },
    ]);
  });

  it('does not mistake a dropdown label or a key name for a secret', () => {
    const notSecrets: AgentAction[] = [
      action({ index: 0, action: 'selectOption', selector: 'role=combobox[name="Password policy"]', value: 'Strict' }),
      action({ index: 1, action: 'press', selector: 'input[type="password"]', value: 'Enter' }),
    ];
    assert.equal(scriptOf(notSecrets).length, 2);
  });
});

describe('a replay script is parsed at the read boundary', () => {
  const key = 'https://app.example.com/en/plans :: workflow :: open the plan';

  function plant(healed: string): CacheManager {
    const cache = memoryCache();
    cache.set({
      key,
      original: 'open the plan',
      healed,
      strategy: 'workflow-replay',
      url: 'https://app.example.com/en/plans',
      confidence: 1,
      reasoning: 'planted by a test',
      model: 'test:agent',
    });
    return cache;
  }

  it('returns a well-formed script', () => {
    const steps = [{ action: 'click', selector: 'role=button[name="Open"]', value: '', url: '' }];
    assert.deepEqual(cacheAgentMemory(plant(JSON.stringify(steps))).get(key), steps);
  });

  it('refuses an action kind this build does not know', () => {
    const steps = [{ action: 'sudo', selector: 'role=button[name="Open"]', value: '', url: '' }];
    assert.equal(cacheAgentMemory(plant(JSON.stringify(steps))).get(key), undefined);
  });

  it('refuses a step whose fields are the wrong type', () => {
    for (const step of [
      { action: 'click', selector: 7, value: '', url: '' },
      { action: 'click', selector: 'x', url: '' },
      { action: 'click', selector: 'x', value: null, url: '' },
      'click role=button',
      null,
    ]) {
      assert.equal(
        cacheAgentMemory(plant(JSON.stringify([step]))).get(key),
        undefined,
        JSON.stringify(step),
      );
    }
  });

  it('refuses a value longer than any real journey types', () => {
    const steps = [{ action: 'fill', selector: 'x', value: 'a'.repeat(4_001), url: '' }];
    assert.equal(cacheAgentMemory(plant(JSON.stringify(steps))).get(key), undefined);
  });

  it('refuses an entry that is not an array at all, and unreadable JSON', () => {
    assert.equal(cacheAgentMemory(plant('{"action":"click"}')).get(key), undefined);
    assert.equal(cacheAgentMemory(plant('not json at all')).get(key), undefined);
    assert.equal(cacheAgentMemory(plant('null')).get(key), undefined);
  });

  it('ignores an entry that is not a replay at all', () => {
    const cache = memoryCache();
    cache.set({
      key,
      original: 'role=button[name="Open"]',
      healed: 'role=button[name="Open plan"]',
      strategy: 'ax-name',
      url: 'https://app.example.com/en/plans',
      confidence: 0.9,
      reasoning: 'an ordinary heal',
      model: 'test:healer',
    });
    assert.equal(cacheAgentMemory(cache).get(key), undefined);
  });
});
