import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
} from '@ai-sdk/provider';
import { z } from 'zod';

import { flattenPrompt } from './claude-cli.js';

export const AGY_CLI_TIMEOUT_MS = 15 * 60 * 1000;

const AgyUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  thinking_tokens: z.number().int().nonnegative().default(0),
  cache_read_tokens: z.number().int().nonnegative().default(0),
  total_tokens: z.number().int().nonnegative(),
});

const AgyResultEventSchema = z.object({
  event: z.literal('result'),
  result: z.object({
    status: z.enum(['SUCCESS', 'ERROR']),
    response: z.string(),
    structured_output: z.json().optional(),
    error: z.string().min(1).optional(),
    usage: AgyUsageSchema,
  }),
});

type AgyResult = z.infer<typeof AgyResultEventSchema>['result'];

export class AgyCliError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AgyCliError';
  }
}

function resultOf(stdout: string): AgyResult {
  let result: AgyResult | undefined;
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new AgyCliError('agy returned malformed stream JSON', error);
    }
    const parsed = AgyResultEventSchema.safeParse(event);
    if (parsed.success) result = parsed.data.result;
  }
  if (result === undefined) {
    throw new AgyCliError('agy completed without a result event');
  }
  return result;
}

function errorOf(stdout: string): string {
  try {
    const result = resultOf(stdout);
    return result.status === 'ERROR' ? (result.error ?? 'agy reported an unsuccessful turn') : '';
  } catch (error) {
    if (error instanceof AgyCliError) return '';
    throw error;
  }
}

interface AgyExecution {
  readonly binary: string;
  readonly args: readonly string[];
  readonly input: string;
  readonly cwd: string;
  readonly timeout: number;
}

function executeAgy(options: AgyExecution): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      options.binary,
      options.args,
      {
        cwd: options.cwd,
        timeout: options.timeout,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        const detail = stderr.trim() || errorOf(stdout);
        reject(
          new AgyCliError(
            detail === '' ? 'agy failed' : `agy failed: ${detail}`,
            error,
          ),
        );
      },
    );
    child.stdin?.end(options.input);
  });
}

export interface AgyCliOptions {
  readonly modelId: string;
  readonly effort?: string | undefined;
  readonly binary?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

function supportsEffort(modelId: string): boolean {
  return !modelId.startsWith('claude-');
}

export function createAgyCli(options: AgyCliOptions): LanguageModelV4 {
  const binary = options.binary ?? 'agy';
  const effort = options.effort ?? 'medium';
  const timeout = options.timeoutMs ?? AGY_CLI_TIMEOUT_MS;

  return {
    specificationVersion: 'v4',
    provider: 'agy-cli',
    modelId: options.modelId,
    supportedUrls: {},

    async doGenerate(call: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
      const directory = await mkdtemp(join(tmpdir(), 'wowlidator-agy-'));
      try {
        const { system, text } = flattenPrompt(call.prompt);
        const prompt = system === '' ? text : `${system}\n\n${text}`;
        const args = [
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--model',
          options.modelId,
          ...(supportsEffort(options.modelId) ? ['--effort', effort] : []),
          '--sandbox',
          '--disable-slash-commands',
          '--print-timeout',
          `${Math.ceil(timeout / 1000)}s`,
        ];

        if (call.responseFormat?.type === 'json' && call.responseFormat.schema !== undefined) {
          const schemaPath = join(directory, 'schema.json');
          await writeFile(schemaPath, JSON.stringify(call.responseFormat.schema), 'utf8');
          args.push('--json-schema', schemaPath);
        }

        const input = `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`;
        const stdout = await executeAgy({ binary, args, input, cwd: directory, timeout });
        const result = resultOf(stdout);
        if (result.status === 'ERROR') {
          throw new AgyCliError(result.error ?? 'agy reported an unsuccessful turn');
        }
        const answer = result.structured_output === undefined
          ? result.response.trim()
          : JSON.stringify(result.structured_output);
        const reasoningTokens = result.usage.thinking_tokens;
        return {
          content: answer === '' ? [] : [{ type: 'text', text: answer }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: {
              total: result.usage.input_tokens,
              noCache: Math.max(0, result.usage.input_tokens - result.usage.cache_read_tokens),
              cacheRead: result.usage.cache_read_tokens,
              cacheWrite: 0,
            },
            outputTokens: {
              total: result.usage.output_tokens + reasoningTokens,
              text: result.usage.output_tokens,
              reasoning: reasoningTokens,
            },
          },
          warnings: [],
        };
      } catch (error) {
        if (error instanceof AgyCliError) throw error;
        throw new AgyCliError(`agy-cli:${options.modelId} failed`, error);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },

    doStream(): never {
      throw new AgyCliError('agy-cli does not stream; this system never asks it to');
    },
  };
}
