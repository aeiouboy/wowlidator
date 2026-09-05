/**
 * The auto-review judge — a model ruling on proved-?, above a confidence bar.
 *
 * proved-? exists because whether "Create Benefit Plan" satisfies a claim
 * written "Create Plan" is a decision, not a measurement. The judge does not
 * change that; it changes WHO makes the routine decisions. Asked for by the
 * person running this (2026-08-24): when the model — reading the retrieved
 * case context (the sheet's own claim, expected output and notes stamped on
 * the flow as `Flow.caseContext`) beside each expected-vs-actual pair — judges
 * the claim satisfied at `AUTO_PROVE_CONFIDENCE` (0.7) or better, the run is
 * ruled **proved** without waiting for a human.
 *
 * Three rails keep the shortcut honest:
 *
 * - **The ruling is labelled as the model's** (`review.by` carries the model,
 *   plus its confidence and reasoning). A human ruling carries no `by`, and
 *   the panel lets a human REPLACE a model ruling — never the reverse.
 * - **Below the bar, nothing changes**: the run stays proved-? for a human,
 *   with the judge's opinion recorded as a note — a 0.65 is information, not
 *   a verdict. At the bar it rules both ways (see `autoReviewRuling`): a
 *   confident "no" stamps failed, labelled as the model's and replaceable by
 *   a human, because the gate now sends every wording mismatch here and an
 *   unruled far miss would sit at proved-? forever.
 * - **A judge fault never changes a verdict.** No key, a provider error, an
 *   unusable answer — the run is exactly the proved-? it was, the capture-
 *   pilot degradation rule.
 *
 * One small call per proved-? run (they are rare by construction), on the
 * `agent` role. `WOWLIDATOR_AUTO_PROVE=off` disables;
 * `WOWLIDATOR_AUTO_PROVE_CONFIDENCE` moves the bar.
 */

import { z } from 'zod';

import { lenientObject } from '../providers/model-output.js';
import {
  LlmFactory,
  generateStructuredForModel,
  type ModelSource,
} from '../providers/llm-factory.js';
import { DETERMINISM_RULES, procedure } from '../providers/prompt-discipline.js';
import { fence, sanitizeInline } from '../providers/model-fence.js';
import type { ProofBundle } from './proof-bundle.js';

/** The bar a model ruling must clear to stand as `proved`. */
export const AUTO_PROVE_CONFIDENCE = envConfidence() ?? 0.7;

function envConfidence(): number | null {
  const raw = process.env['WOWLIDATOR_AUTO_PROVE_CONFIDENCE'];
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : null;
}

export interface ReviewPair {
  intent?: string | undefined;
  expected: string;
  actual: string;
}

export interface ReviewJudgeInput {
  flowName: string;
  /** `Flow.caseContext` — the retrieved claim/expected/notes, when stamped. */
  caseContext?: string | undefined;
  pairs: readonly ReviewPair[];
}

export interface ReviewJudgement {
  satisfied: boolean;
  /** Clamped to 0–1 in code — the schema is never the guard. */
  confidence: number;
  reasoning: string;
}

/** Pluggable, so tests inject a deterministic stub — the `HealerModel` seam. */
export interface ReviewJudge {
  readonly id: string;
  judge(input: ReviewJudgeInput): Promise<ReviewJudgement>;
}

const JudgementSchema = lenientObject({
  satisfied: z
    .enum(['yes', 'no'])
    .describe('yes ONLY if every pair\'s actual genuinely satisfies its expected claim.'),
  confidence: z.number().describe('0 to 1: how sure you are of the satisfied answer.'),
  reasoning: z.string().describe('One sentence per pair: why it does or does not satisfy the claim.'),
});

const SYSTEM_PROMPT = `You rule on failed comparisons in UI test results.

Each pair below is an assertion that FAILED an exact comparison: the claim the
test asserted (expected) and what the page actually rendered (actual). Some
pairs are wording near-misses, some are genuinely different things — you rule
on both. The test case's own context, when given, is the specification's
wording — the authority on what the claim MEANS.

Rule "yes" only when the actual is the same fact as the expected — a longer
rendering, an added prefix like an application name, the same message inside a
sentence, the same content in another language the specification allows. Rule
"no" when any pair differs in substance: a different number, a different
entity, a different outcome, a negation, a page that plainly is not what the
claim describes. When the context contradicts the actual, that is a "no".
Confidence carries your ruling either way — a sure "no" is as valuable as a
sure "yes".

${DETERMINISM_RULES}

${procedure('HOW TO RULE', [
  'For each pair, name the FACT the expected asserts (which record, which message, which state).',
  'Check the actual states the same fact — extra words around it are rendering, a changed word inside it is substance.',
  'Check the case context does not contradict the actual (a note saying the feature was removed or renamed decides).',
  'satisfied = yes only if EVERY pair passes; confidence reflects the weakest pair.',
])}`;

export class LlmReviewJudge implements ReviewJudge {
  readonly #source: ModelSource;
  readonly #explicitId: string | undefined;
  readonly #maxRetries: number;

  constructor(options: { factory?: LlmFactory; model?: unknown; id?: string } = {}) {
    if (options.model) {
      this.#source = { model: options.model as never };
      this.#explicitId = options.id ?? 'custom:review-judge';
      this.#maxRetries = 1;
    } else {
      const factory = options.factory ?? new LlmFactory();
      this.#source = { factory, role: 'agent' };
      this.#explicitId = options.id;
      this.#maxRetries = factory.maxRetries;
    }
  }

  // Lazy, the `LlmDataModel` rule: constructing the judge must never itself
  // demand an API key — most runs never reach proved-?.
  get id(): string {
    if (this.#explicitId !== undefined) return this.#explicitId;
    return 'factory' in this.#source ? this.#source.factory.forRole('agent').id : 'custom:review-judge';
  }

  async judge(input: ReviewJudgeInput): Promise<ReviewJudgement> {
    // The pairs are page text against sheet text — both third-party, and this
    // judge can turn a failed comparison into a pass. Fenced and bounded at
    // assembly (`src/providers/model-fence.ts`); the bundle's own copies of
    // `expected`/`actual` are untouched, so the verdict still cites what the
    // page actually held.
    const lines = [`Flow: ${sanitizeInline(input.flowName)}`];
    if (input.caseContext) {
      lines.push('', 'THE TEST CASE (the specification\'s own wording):', fence('catalog', input.caseContext));
    }
    lines.push('', 'THE PAIRS THAT FAILED EXACT COMPARISON:');
    for (const [index, pair] of input.pairs.entries()) {
      lines.push(
        `${index + 1}. ${pair.intent ? `${sanitizeInline(pair.intent)} — ` : ''}` +
          `expected ${JSON.stringify(sanitizeInline(pair.expected))}, ` +
          `the page holds ${JSON.stringify(sanitizeInline(pair.actual))}`,
      );
    }
    const { object } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      task: 'auto-review',
      schema: JudgementSchema,
      system: SYSTEM_PROMPT,
      prompt: lines.join('\n'),
      maxOutputTokens: 1024,
      maxRetries: this.#maxRetries,
    });
    // "Never trust a number": smaller models return 0–100, strings, 1.4.
    const raw = Number(object.confidence);
    const confidence = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw > 1 ? raw / 100 : raw)) : 0;
    return { satisfied: object.satisfied === 'yes', confidence, reasoning: object.reasoning };
  }
}

/** The unsure steps' expected/actual pairs, ready for the judge. */
export function reviewPairs(bundle: ProofBundle): ReviewPair[] {
  return bundle.steps
    .filter((s) => !s.superseded && s.unsure !== undefined)
    .map((s) => ({
      intent: s.intent,
      expected: String(s.detail?.['expected'] ?? ''),
      actual: String(s.detail?.['actual'] ?? ''),
    }))
    .filter((p) => p.expected !== '' && p.actual !== '');
}

/**
 * The pure decision: the review to stamp, or null to leave the human's queue
 * untouched. Anything below the bar (either answer) and no pairs at all are
 * null — a 0.65 is information, not a verdict.
 *
 * **The judge rules BOTH ways at the bar since 2026-08-24.** It used to only
 * resolve doubt upward ("a wrong 'failed' from a model would file a defect no
 * human looked at") — defensible while only ≥50%-overlap near-misses reached
 * it. The gate is now every wording mismatch (`nearMiss`, broadened the same
 * day at the person's request: the agent judges anything the deterministic
 * comparison cannot rule), and with far misses flowing in, a confident "no"
 * left unruled would park every genuine wording failure at proved-? forever.
 * The rails that keep a model "failed" honest: it is labelled as the model's
 * (`by`, confidence, reasoning), it lists red in the panel — where failures
 * are exactly what people look at — and a human ruling REPLACES it, never
 * the reverse.
 */
export function autoReviewRuling(
  judgement: ReviewJudgement,
  judgeId: string,
  threshold = AUTO_PROVE_CONFIDENCE,
): NonNullable<ProofBundle['review']> | null {
  if (judgement.confidence < threshold) return null;
  return {
    verdict: judgement.satisfied ? 'proved' : 'failed',
    at: new Date().toISOString(),
    by: judgeId,
    confidence: judgement.confidence,
    reasoning: judgement.reasoning,
  };
}
