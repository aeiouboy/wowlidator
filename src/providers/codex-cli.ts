import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
} from '@ai-sdk/provider';
import { z } from 'zod';

import { flattenPrompt } from './claude-cli.js';

export const CODEX_CLI_TIMEOUT_MS = 15 * 60 * 1000;

const PARENT_CODEX_SESSION_ENV = [
  'CODEX_APP_TOOLS_PIPE_PATH',
  'CODEX_CI',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
  'CODEX_PERMISSION_PROFILE',
  'CODEX_SAGE_BACKFILL_TRACKER_TAB_REUSE',
  'CODEX_SESSION_ID',
  'CODEX_SHELL',
  'CODEX_THREAD_ID',
] as const;

const TurnCompletedSchema = z.object({
  type: z.literal('turn.completed'),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    cached_input_tokens: z.number().int().nonnegative().default(0),
    cache_write_input_tokens: z.number().int().nonnegative().default(0),
    output_tokens: z.number().int().nonnegative(),
    reasoning_output_tokens: z.number().int().nonnegative().default(0),
  }),
});

const ErrorEventSchema = z.object({
  type: z.literal('error'),
  message: z.string().min(1),
});

type CodexUsage = z.infer<typeof TurnCompletedSchema>['usage'];

export class CodexCliError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CodexCliError';
  }
}

function usageOf(stdout: string): CodexUsage {
  let completed: CodexUsage | undefined;
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new CodexCliError('codex exec returned malformed JSONL', error);
    }
    const parsed = TurnCompletedSchema.safeParse(event);
    if (parsed.success) completed = parsed.data.usage;
  }
  if (completed === undefined) {
    throw new CodexCliError('codex exec completed without a turn.completed usage event');
  }
  return completed;
}

function errorOf(stdout: string): string {
  let detail = '';
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = ErrorEventSchema.safeParse(JSON.parse(line));
      if (parsed.success) detail = parsed.data.message;
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  return detail;
}

function childEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of PARENT_CODEX_SESSION_ENV) delete env[name];
  return env;
}

interface CodexExecution {
  readonly binary: string;
  readonly args: readonly string[];
  readonly input: string;
  readonly cwd: string;
  readonly timeout: number;
}

function executeCodex(options: CodexExecution): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      options.binary,
      options.args,
      {
        cwd: options.cwd,
        env: childEnvironment(),
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
          new CodexCliError(
            detail === '' ? 'codex exec failed' : `codex exec failed: ${detail}`,
            error,
          ),
        );
      },
    );
    child.stdin?.end(options.input);
  });
}

export interface CodexCliOptions {
  modelId: string;
  effort?: string | undefined;
  binary?: string | undefined;
  timeoutMs?: number | undefined;
}

export function createCodexCli(options: CodexCliOptions): LanguageModelV4 {
  const binary = options.binary ?? 'codex';
  const effort = options.effort ?? 'medium';
  const timeout = options.timeoutMs ?? CODEX_CLI_TIMEOUT_MS;

  return {
    specificationVersion: 'v4',
    provider: 'codex-cli',
    modelId: options.modelId,
    supportedUrls: {},

    async doGenerate(call: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
      const directory = await mkdtemp(join(tmpdir(), 'wowlidator-codex-'));
      const outputPath = join(directory, 'answer.txt');
      try {
        const { system, text } = flattenPrompt(call.prompt);
        const prompt = system === '' ? text : `${system}\n\n${text}`;
        const args = [
          'exec',
          '--ephemeral',
          '--json',
          '--sandbox',
          'read-only',
          '--ignore-user-config',
          '--ignore-rules',
          '--skip-git-repo-check',
          '--color',
          'never',
          '-C',
          directory,
          '-m',
          options.modelId,
          '-c',
          `model_reasoning_effort="${effort}"`,
          '-c',
          'project_doc_max_bytes=0',
          '-o',
          outputPath,
        ];

        if (call.responseFormat?.type === 'json' && call.responseFormat.schema !== undefined) {
          const schemaPath = join(directory, 'schema.json');
          await writeFile(schemaPath, JSON.stringify(call.responseFormat.schema), 'utf8');
          args.push('--output-schema', schemaPath);
        }
        const stdout = await executeCodex({ binary, args, input: prompt, cwd: directory, timeout });
        const usage = usageOf(stdout);
        const answer = await readFile(outputPath, 'utf8');
        return {
          content: answer === '' ? [] : [{ type: 'text', text: answer }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: {
              total: usage.input_tokens + usage.cache_write_input_tokens,
              noCache: Math.max(0, usage.input_tokens - usage.cached_input_tokens),
              cacheRead: usage.cached_input_tokens,
              cacheWrite: usage.cache_write_input_tokens,
            },
            outputTokens: {
              total: usage.output_tokens,
              text: Math.max(0, usage.output_tokens - usage.reasoning_output_tokens),
              reasoning: usage.reasoning_output_tokens,
            },
          },
          warnings: [],
        };
      } catch (error) {
        if (error instanceof CodexCliError) throw error;
        throw new CodexCliError(`codex-cli:${options.modelId} failed`, error);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },

    doStream(): never {
      throw new CodexCliError('codex-cli does not stream; this system never asks it to');
    },
  };
}
