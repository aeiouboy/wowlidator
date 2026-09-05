import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { z } from 'zod';

import {
  AGY_CLI_MODELS,
  AGY_CLI_PLACEHOLDER_KEY,
  DEFAULT_PROVIDER_MODELS,
  PROVIDERS,
  loadConfig,
} from '../src/config.js';
import { createAgyCli } from '../src/providers/agy-cli.js';

describe('the agy-cli provider registration', () => {
  it('is keyless and resolves a role to the balanced Gemini model', () => {
    // Given a role configured only with the provider name.
    const config = loadConfig({ WOWLIDATOR_GENERATOR_PROVIDER: 'agy-cli' });

    // When configuration resolves the provider defaults.
    const generator = config.roles.generator;

    // Then the signed-in CLI session satisfies the key gate and selects Gemini medium.
    assert.ok((PROVIDERS as readonly string[]).includes('agy-cli'));
    assert.equal(DEFAULT_PROVIDER_MODELS['agy-cli'], 'gemini-3.8-flash-medium');
    assert.equal(AGY_CLI_MODELS[0], 'gemini-3.8-flash-medium');
    assert.equal(generator.provider, 'agy-cli');
    assert.equal(generator.modelId, 'gemini-3.8-flash-medium');
    assert.deepEqual(config.apiKeys['agy-cli'], [AGY_CLI_PLACEHOLDER_KEY]);
  });
});

describe('createAgyCli', () => {
  it('exposes a Vercel AI SDK v4 language model', () => {
    // Given Agy CLI model settings.
    const model = createAgyCli({ modelId: 'gemini-3.8-flash-low', effort: 'low' });

    // When the model metadata is inspected, then it identifies the adapter.
    assert.equal(model.specificationVersion, 'v4');
    assert.equal(model.provider, 'agy-cli');
    assert.equal(model.modelId, 'gemini-3.8-flash-low');
  });

  it('returns schema-constrained output and token usage from Agy stream JSON', async () => {
    // Given a fake Agy executable that records stdin and emits the documented result event.
    const dir = mkdtempSync(join(tmpdir(), 'wowlidator-fake-agy-'));
    const binary = join(dir, 'fake-agy.cjs');
    const invocationPath = join(dir, 'invocation.json');
    writeFileSync(
      binary,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const schemaAt = args.indexOf('--json-schema');
  const schema = schemaAt < 0 ? null : fs.readFileSync(args[schemaAt + 1], 'utf8');
  fs.writeFileSync(process.env.FAKE_AGY_INVOCATION_PATH, JSON.stringify({ args, input, schema }));
  process.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'fake', init: { model: 'gemini-3.8-flash-low' } }) + '\\n');
  process.stdout.write(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: 'fake',
      status: 'SUCCESS',
      response: '{"answer":"ok"}',
      structured_output: { answer: 'ok' },
      duration_seconds: 1,
      num_turns: 1,
      usage: { input_tokens: 20, output_tokens: 3, thinking_tokens: 1, cache_read_tokens: 5, total_tokens: 24 },
    },
  }) + '\\n');
});
`,
      'utf8',
    );
    chmodSync(binary, 0o755);
    process.env['FAKE_AGY_INVOCATION_PATH'] = invocationPath;

    try {
      const model = createAgyCli({
        modelId: 'gemini-3.8-flash-low',
        effort: 'low',
        binary,
        timeoutMs: 5_000,
      });
      const call: LanguageModelV4CallOptions = {
        prompt: [
          { role: 'system', content: 'Return a structured answer.' },
          { role: 'user', content: [{ type: 'text', text: 'Answer now.' }] },
        ],
        responseFormat: {
          type: 'json',
          schema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
            additionalProperties: false,
          },
        },
      };

      // When the adapter generates through the subprocess.
      const result = await model.doGenerate(call);

      // Then the final structured output and usage map onto the AI SDK contract.
      assert.deepEqual(result.content, [{ type: 'text', text: '{"answer":"ok"}' }]);
      assert.equal(result.usage.inputTokens.total, 20);
      assert.equal(result.usage.inputTokens.noCache, 15);
      assert.equal(result.usage.inputTokens.cacheRead, 5);
      assert.equal(result.usage.inputTokens.cacheWrite, 0);
      assert.equal(result.usage.outputTokens.total, 4);
      assert.equal(result.usage.outputTokens.reasoning, 1);

      const invocation = z
        .object({ args: z.array(z.string()), input: z.string(), schema: z.string() })
        .parse(JSON.parse(readFileSync(invocationPath, 'utf8')));
      assert.ok(invocation.args.includes('--input-format'));
      assert.ok(invocation.args.includes('stream-json'));
      assert.ok(invocation.args.includes('--json-schema'));
      assert.ok(invocation.args.includes('--sandbox'));
      assert.ok(invocation.args.includes('--disable-slash-commands'));
      assert.ok(invocation.args.includes('gemini-3.8-flash-low'));
      assert.ok(invocation.args.includes('low'));
      assert.ok(!invocation.args.some((arg) => arg.includes('Return a structured answer.')));
      assert.deepEqual(JSON.parse(invocation.input.trim()), {
        event: 'user',
        message: { content: 'Return a structured answer.\n\nAnswer now.' },
      });
      assert.deepEqual(JSON.parse(invocation.schema), call.responseFormat?.type === 'json' ? call.responseFormat.schema : undefined);
    } finally {
      delete process.env['FAKE_AGY_INVOCATION_PATH'];
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits effort for Claude models that Agy rejects when effort is present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wowlidator-fake-agy-claude-'));
    const binary = join(dir, 'fake-agy.cjs');
    const invocationPath = join(dir, 'invocation.json');
    writeFileSync(
      binary,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
process.stdin.resume();
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.FAKE_AGY_INVOCATION_PATH, JSON.stringify({ args }));
  process.stdout.write(JSON.stringify({ event: 'result', result: {
    status: 'SUCCESS', response: 'ok',
    usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 }
  } }) + '\\n');
});
`,
      'utf8',
    );
    chmodSync(binary, 0o755);
    process.env['FAKE_AGY_INVOCATION_PATH'] = invocationPath;

    try {
      const model = createAgyCli({ modelId: 'claude-sonnet-4-6', effort: 'high', binary, timeoutMs: 5_000 });
      await model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Answer now.' }] }],
      });

      const invocation = z.object({ args: z.array(z.string()) }).parse(JSON.parse(readFileSync(invocationPath, 'utf8')));
      assert.ok(invocation.args.includes('claude-sonnet-4-6'));
      assert.ok(!invocation.args.includes('--effort'));
    } finally {
      delete process.env['FAKE_AGY_INVOCATION_PATH'];
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('surfaces structured CLI errors written to stdout', async () => {
    // Given an Agy process that rejects the turn through its result event.
    const dir = mkdtempSync(join(tmpdir(), 'wowlidator-fake-agy-error-'));
    const binary = join(dir, 'fake-agy-error.cjs');
    writeFileSync(
      binary,
      `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: 'fake',
      status: 'ERROR',
      response: '',
      error: 'Invalid output schema: unsupported keyword',
      duration_seconds: 0,
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
    },
  }) + '\\n');
  process.exitCode = 1;
});
`,
      'utf8',
    );
    chmodSync(binary, 0o755);

    try {
      const model = createAgyCli({ modelId: 'gemini-3.8-flash-low', binary, timeoutMs: 5_000 });

      // When the adapter receives the non-zero process result.
      const generation = Promise.resolve(
        model.doGenerate({
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'Answer now.' }] }],
        }),
      );

      // Then the rejection preserves the useful result error.
      await assert.rejects(generation, /Invalid output schema: unsupported keyword/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
