import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { z } from 'zod';

import {
  CODEX_CLI_MODELS,
  CODEX_CLI_PLACEHOLDER_KEY,
  DEFAULT_PROVIDER_MODELS,
  PROVIDERS,
  loadConfig,
} from '../src/config.js';
import { createCodexCli } from '../src/providers/codex-cli.js';

describe('the codex-cli provider registration', () => {
  it('is keyless and resolves a role to the balanced Codex model', () => {
    // Given a role configured only with the provider name.
    const config = loadConfig({ WOWLIDATOR_GENERATOR_PROVIDER: 'codex-cli' });

    // When configuration resolves the provider defaults.
    const generator = config.roles.generator;

    // Then the signed-in CLI session satisfies the key gate and selects Terra.
    assert.ok((PROVIDERS as readonly string[]).includes('codex-cli'));
    assert.equal(DEFAULT_PROVIDER_MODELS['codex-cli'], 'gpt-5.6-terra');
    assert.deepEqual(CODEX_CLI_MODELS, ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
    assert.equal(generator.provider, 'codex-cli');
    assert.equal(generator.modelId, 'gpt-5.6-terra');
    assert.deepEqual(config.apiKeys['codex-cli'], [CODEX_CLI_PLACEHOLDER_KEY]);
  });
});

describe('createCodexCli', () => {
  it('exposes a Vercel AI SDK v4 language model', () => {
    // Given Codex CLI model settings.
    const model = createCodexCli({ modelId: 'gpt-5.6-luna', effort: 'low' });

    // When the model metadata is inspected, then it identifies the adapter.
    assert.equal(model.specificationVersion, 'v4');
    assert.equal(model.provider, 'codex-cli');
    assert.equal(model.modelId, 'gpt-5.6-luna');
  });

  it('returns schema-constrained output and token usage from codex exec', async () => {
    // Given a fake Codex executable that records argv and emits the documented JSONL event.
    const dir = mkdtempSync(join(tmpdir(), 'wowlidator-fake-codex-'));
    const binary = join(dir, 'fake-codex.cjs');
    const argsPath = join(dir, 'args.json');
    writeFileSync(
      binary,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
let input = '';
if (process.env.CODEX_THREAD_ID) process.exit(17);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.FAKE_CODEX_ARGS_PATH, JSON.stringify({ args, input }));
  const outputAt = args.indexOf('-o');
  fs.writeFileSync(args[outputAt + 1], JSON.stringify({ answer: 'ok' }));
  process.stdout.write(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 20, cached_input_tokens: 5, cache_write_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 },
  }) + '\\n');
});
`,
      'utf8',
    );
    chmodSync(binary, 0o755);
    process.env['FAKE_CODEX_ARGS_PATH'] = argsPath;
    const previousThreadId = process.env['CODEX_THREAD_ID'];
    process.env['CODEX_THREAD_ID'] = 'parent-thread';

    try {
      const model = createCodexCli({
        modelId: 'gpt-5.6-luna',
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

      // Then the final message and JSONL usage map onto the AI SDK contract.
      assert.deepEqual(result.content, [{ type: 'text', text: '{"answer":"ok"}' }]);
      assert.equal(result.usage.inputTokens.total, 22);
      assert.equal(result.usage.inputTokens.noCache, 15);
      assert.equal(result.usage.inputTokens.cacheRead, 5);
      assert.equal(result.usage.inputTokens.cacheWrite, 2);
      assert.equal(result.usage.outputTokens.total, 3);
      assert.equal(result.usage.outputTokens.reasoning, 1);

      const invocation = z
        .object({ args: z.array(z.string()), input: z.string() })
        .parse(JSON.parse(readFileSync(argsPath, 'utf8')));
      const { args } = invocation;
      assert.deepEqual(args.slice(0, 2), ['exec', '--ephemeral']);
      assert.ok(args.includes('--json'));
      assert.ok(args.includes('--output-schema'));
      assert.ok(args.includes('--ignore-user-config'));
      assert.ok(args.includes('--ignore-rules'));
      assert.ok(args.includes('--skip-git-repo-check'));
      assert.ok(args.includes('model_reasoning_effort="low"'));
      assert.equal(invocation.input, 'Return a structured answer.\n\nAnswer now.');
      assert.ok(!args.includes(invocation.input));
    } finally {
      delete process.env['FAKE_CODEX_ARGS_PATH'];
      if (previousThreadId === undefined) delete process.env['CODEX_THREAD_ID'];
      else process.env['CODEX_THREAD_ID'] = previousThreadId;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('surfaces structured CLI errors written to stdout', async () => {
    // Given: a Codex process rejects a schema through its JSONL channel and writes no stderr.
    const dir = mkdtempSync(join(tmpdir(), 'wowlidator-fake-codex-error-'));
    const binary = join(dir, 'fake-codex-error.cjs');
    writeFileSync(
      binary,
      `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'error', message: 'Invalid output schema: unsupported keyword' }) + '\\n');
  process.exitCode = 1;
});
`,
      'utf8',
    );
    chmodSync(binary, 0o755);

    try {
      const model = createCodexCli({
        modelId: 'gpt-5.6-luna',
        binary,
        timeoutMs: 5_000,
      });

      // When: the adapter receives the non-zero process result.
      const generation = Promise.resolve(
        model.doGenerate({
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'Answer now.' }] }],
        }),
      );

      // Then: the rejection preserves the useful stdout error instead of a generic failure.
      await assert.rejects(generation, /Invalid output schema: unsupported keyword/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
