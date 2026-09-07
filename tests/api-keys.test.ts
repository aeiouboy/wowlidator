/**
 * API keys: rotating off a dead one, and what the panel may say about them.
 *
 * Unit tier — no provider, no network, no cost. `LlmFactory` takes injected
 * builders precisely so this can be exercised against a stub.
 *
 * Two halves of one feature, deliberately tested apart because they fail
 * differently: `LlmFactory.callWithFailover` decides when a *run* abandons a
 * key, and `KeySelection` decides which key a run *starts* on and what a
 * browser is allowed to know about any of them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { APICallError, type LanguageModel } from 'ai';

import { loadConfig, type WowlidatorConfig } from '../src/config.js';
import {
  AllKeysExhaustedError,
  LlmFactory,
  MissingApiKeyError,
  isKeyExhaustedError,
} from '../src/providers/llm-factory.js';
import { providerFailureLine } from '../src/cli/run-cases.js';
import { KeySelection, KeySelectionError, maskKey } from '../src/ui/keys.js';

/** A config with a chosen number of Groq keys, everything else defaulted. */
function configWith(keys: string[]): WowlidatorConfig {
  return loadConfig({
    GROQ_API_KEY: keys.join(','),
    WOWLIDATOR_HEALER_PROVIDER: 'groq',
    WOWLIDATOR_DATA_PROVIDER: 'groq',
  });
}

/** A stub "model" that is really just the key it was built from. */
function keyRecordingFactory(config: WowlidatorConfig): {
  factory: LlmFactory;
  used: string[];
} {
  const used: string[] = [];
  const factory = new LlmFactory(config, {
    groq: (apiKey, modelId) => {
      used.push(apiKey);
      return { apiKey, modelId } as unknown as LanguageModel;
    },
  });
  return { factory, used };
}

function rateLimited(): Error {
  return new APICallError({
    message: 'Rate limit reached for model',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 429,
  });
}

describe('what counts as the key being the problem', () => {
  it('rotates on auth, quota and rate limits', () => {
    assert.equal(isKeyExhaustedError(rateLimited()), true);
    assert.equal(isKeyExhaustedError(new Error('401 Unauthorized')), true);
    assert.equal(isKeyExhaustedError(new Error('You exceeded your current quota')), true);
    assert.equal(isKeyExhaustedError(new Error('RESOURCE_EXHAUSTED')), true);
    assert.equal(isKeyExhaustedError(new Error('invalid_api_key')), true);
  });

  it('does not rotate on anything else', () => {
    // Spending a second key's quota on a call that was never going to work
    // would waste it and hide which model actually failed.
    assert.equal(isKeyExhaustedError(new Error('model does not support JSON schema')), false);
    assert.equal(isKeyExhaustedError(new Error('connect ECONNREFUSED')), false);
  });

  it('sees through the wrapper generateStructured puts around a failure', () => {
    const wrapped = new Error('groq:llama failed to produce a valid structured response', {
      cause: rateLimited(),
    });
    assert.equal(isKeyExhaustedError(wrapped), true);
  });
});

describe('a run moving off a dead key', () => {
  it('tries the next key, and stays on the one that worked', async () => {
    const config = configWith(['dead-1', 'dead-2', 'good-3']);
    const { factory, used } = keyRecordingFactory(config);

    let attempts = 0;
    const answer = await factory.callWithFailover('healer', async (resolved) => {
      attempts += 1;
      const key = (resolved.model as unknown as { apiKey: string }).apiKey;
      if (key !== 'good-3') throw rateLimited();
      return key;
    });

    assert.equal(answer, 'good-3');
    assert.equal(attempts, 3);
    assert.deepEqual(used, ['dead-1', 'dead-2', 'good-3']);
    assert.equal(factory.activeKeyIndex('groq'), 2, 'the working key stays active');
  });

  it('never re-probes a dead key on the next call', async () => {
    const config = configWith(['dead-1', 'good-2']);
    const { factory, used } = keyRecordingFactory(config);

    const call = (): Promise<string> =>
      factory.callWithFailover('healer', async (resolved) => {
        const key = (resolved.model as unknown as { apiKey: string }).apiKey;
        if (key === 'dead-1') throw rateLimited();
        return key;
      });

    await call();
    used.length = 0;
    await call();
    assert.deepEqual(used, ['good-2'], 'the second call starts where the first ended');
  });

  it('shares the move with every role on the same provider', async () => {
    // The healer and the data role are both on Groq here. Discovering the same
    // dead key twice would cost a second wasted request for no information.
    const config = configWith(['dead-1', 'good-2']);
    const { factory, used } = keyRecordingFactory(config);

    await factory.callWithFailover('healer', async (resolved) => {
      const key = (resolved.model as unknown as { apiKey: string }).apiKey;
      if (key === 'dead-1') throw rateLimited();
      return key;
    });
    used.length = 0;
    await factory.callWithFailover('data', async (resolved) => resolved.model);
    assert.deepEqual(used, ['good-2']);
  });

  it('does not rotate when the failure was not about the key', async () => {
    const config = configWith(['key-1', 'key-2']);
    const { factory, used } = keyRecordingFactory(config);

    await assert.rejects(
      factory.callWithFailover('healer', async () => {
        throw new Error('model does not support JSON schema');
      }),
      /does not support JSON schema/,
    );
    assert.deepEqual(used, ['key-1'], 'the second key was never spent');
    assert.equal(factory.activeKeyIndex('groq'), 0);
    assert.equal(providerFailureLine(factory.providerFailures()), 'provider failures: healer 1 (each degraded one step, never the verdict)');
  });

  it('prints no provider-failure line before a failure is recorded', () => {
    const { factory } = keyRecordingFactory(configWith(['key-1']));
    assert.equal(providerFailureLine(factory.providerFailures()), null);
  });

  it('reports every key it tried once they are all gone', async () => {
    const config = configWith(['dead-1', 'dead-2']);
    const { factory } = keyRecordingFactory(config);

    await assert.rejects(
      factory.callWithFailover('healer', async () => {
        throw rateLimited();
      }),
      (error: unknown) => {
        assert.ok(error instanceof AllKeysExhaustedError);
        assert.equal(error.attempts.length, 2, 'both failures are carried, not just the last');
        assert.match(error.message, /key 1:/);
        assert.match(error.message, /key 2:/);
        return true;
      },
    );
  });

  it('says what to set when there is no key at all', async () => {
    const config = loadConfig({ WOWLIDATOR_HEALER_PROVIDER: 'groq' });
    const factory = new LlmFactory(config, {});
    await assert.rejects(
      factory.callWithFailover('healer', async () => 'never runs'),
      (error: unknown) => error instanceof MissingApiKeyError,
    );
  });
});

describe('what the panel may say about a key', () => {
  it('shows enough to recognise a key and never enough to use it', () => {
    const key = 'gsk_liveKEYvalue0123456789abcdef';
    const mask = maskKey(key);
    assert.equal(mask, 'gsk_…cdef');
    assert.equal(mask.includes('liveKEYvalue'), false);
    // Head tells providers apart, tail tells two keys of one provider apart.
    assert.notEqual(maskKey(key), maskKey('gsk_liveKEYvalue0123456789abXXXX'));
  });

  it('refuses to show most of a key that is too short to split', () => {
    assert.equal(maskKey('short'), '•••••');
    assert.doesNotMatch(maskKey('short'), /s|h|o|r|t/);
  });

  it('never puts a key value in what it sends the browser', () => {
    const config = configWith(['gsk_liveKEYvalue0123456789abcdef', 'gsk_secondKEY0123456789abcdef']);
    const described = JSON.stringify(new KeySelection().describe(config));
    assert.doesNotMatch(described, /liveKEYvalue|secondKEY/);
    assert.match(described, /gsk_…cdef/);
  });

  it('names which key each role would start on', () => {
    const selection = new KeySelection();
    const config = configWith(['gsk_aaaaaaaaaaaaaaaaaaaa1111', 'gsk_bbbbbbbbbbbbbbbbbbbb2222']);
    selection.select('groq', 1, config);

    const healer = selection.describe(config).roles.find((role) => role.role === 'healer');
    assert.equal(healer?.activeMask, 'gsk_…2222');
    assert.equal(healer?.keyCount, 2);
  });
});

describe('choosing where a run starts', () => {
  const config = configWith(['key-one-11111111', 'key-two-22222222', 'key-three-3333333']);

  it('puts the chosen key first and keeps the rest behind it', () => {
    // The whole point: the run starts where you said, and failover still has
    // somewhere to go when that key turns out to be the problem too.
    const selection = new KeySelection();
    selection.select('groq', 1, config);
    assert.deepEqual(selection.envOverlay(config), {
      GROQ_API_KEY: 'key-two-22222222,key-one-11111111,key-three-3333333',
    });
  });

  it('says nothing about a provider nobody touched', () => {
    assert.deepEqual(new KeySelection().envOverlay(config), {});
  });

  it('refuses an index that is not a key', () => {
    const selection = new KeySelection();
    for (const index of [3, -1, 1.5, Number.NaN]) {
      assert.throws(() => selection.select('groq', index, config), KeySelectionError, String(index));
    }
    assert.throws(
      () => selection.select('openrouter', 0, config),
      /no OpenRouter key is configured/,
    );
  });

  it('forgets a selection that a reload left pointing at nothing', () => {
    const selection = new KeySelection();
    selection.select('groq', 2, config);
    selection.prune(configWith(['key-one-11111111']));
    assert.equal(selection.activeIndex('groq'), 0);
  });
});
