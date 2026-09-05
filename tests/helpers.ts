/**
 * Shared test helpers.
 *
 * Not named `*.test.ts` on purpose — the runner glob is `tests/*.test.ts`, so
 * this file is imported, never executed as a suite.
 */

import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';

/**
 * A mock model that answers every call with one JSON payload.
 *
 * This is the seam that keeps the whole suite offline: it stands in for
 * whichever free provider a role is routed to, while still exercising the real
 * `generateObject` path — schema enforcement, prompt assembly, usage mapping.
 */
export function jsonModel(
  modelId: string,
  payload: unknown,
  usage: { inputTokens: number; outputTokens: number; cacheRead?: number | undefined },
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId,
    doGenerate: async (): Promise<LanguageModelV4GenerateResult> => ({
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: {
          total: usage.inputTokens,
          noCache: usage.inputTokens - (usage.cacheRead ?? 0),
          cacheRead: usage.cacheRead ?? 0,
          cacheWrite: 0,
        },
        outputTokens: { total: usage.outputTokens, text: usage.outputTokens, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}

/**
 * A model whose replies are scripted, one per call.
 *
 * For the failure modes that only exist *across* attempts: a provider that
 * returns an unusable object and then a good one on the same prompt is the
 * whole reason `generateStructured` re-asks, and a mock with one fixed answer
 * cannot express it. The last entry repeats once the script runs out, so a
 * "never recovers" case is one entry long.
 */
export function scriptedModel(
  modelId: string,
  replies: readonly (unknown | string)[],
): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId,
    doGenerate: async (): Promise<LanguageModelV4GenerateResult> => {
      const reply = replies[Math.min(call, replies.length - 1)];
      call += 1;
      return {
        content: [{ type: 'text', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}

/** How many times a scripted model was actually asked. */
export function callsTo(model: MockLanguageModelV4): number {
  return (model as unknown as { doGenerateCalls: unknown[] }).doGenerateCalls.length;
}

/** A model that replies with prose instead of JSON — the free-tier failure mode. */
export function nonJsonModel(modelId: string, text = 'I cannot do JSON, sorry!'): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId,
    doGenerate: async (): Promise<LanguageModelV4GenerateResult> => ({
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}
