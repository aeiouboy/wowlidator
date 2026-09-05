/**
 * Control plane: propose a targeted fix for a flow step that just failed.
 *
 * Reuses the `generator` role rather than adding a fifth LLM role — the job
 * shape is the same one `generator` already does (a big prompt in: the whole
 * flow, the failure trail, the AX tree at the moment of failure; a small
 * structured shape out). See `flow-repair-loop.ts` for how a proposal
 * actually gets applied and retried — this module only asks the question.
 */

import type { LanguageModel } from 'ai';
import { z } from 'zod';

import { lenientObject } from '../providers/model-output.js';

import { GENERATOR_ACTIONS, GeneratedStepSchema, toFlowStep } from '../generator/test-generator.js';
import { SELECTOR_SYNTAX_RULES } from '../healer/jit-healer.js';
import { DETERMINISM_RULES, procedure, selfCheck } from '../providers/prompt-discipline.js';
import { fence, sanitizeInline } from '../providers/model-fence.js';
import { LlmFactory, generateStructuredForModel, type ModelSource } from '../providers/llm-factory.js';
import type { Flow, FlowStep } from '../engine/runner.js';

const RepairSchema = lenientObject({
  canFix: z
    .boolean()
    .describe(
      'Whether a plausible fix exists given the evidence. False if the failure looks ' +
        'unrecoverable — the app is genuinely broken, not the flow.',
    ),
  insertBefore: z
    .array(GeneratedStepSchema)
    .describe(
      'Step(s) to run before retrying the failed step — e.g. dismiss a popup, wait for ' +
        'something to load, fix a missed precondition. Empty array if none are needed.',
    ),
  replacement: GeneratedStepSchema.describe(
    'The failed step, corrected if it needs to be. Identical to the original if the fix is ' +
      'entirely in insertBefore and the step itself was fine.',
  ),
  rewriteFollowing: z
    .array(GeneratedStepSchema)
    .describe(
      'ONLY when the prompt lists the steps that follow the failed one: a full replacement for ' +
        'ALL of them, in order. Empty array to keep them exactly as they are — which is the ' +
        'right answer whenever the failure is contained in the one step.',
    ),
  reasoning: z.string().describe('One or two sentences: what went wrong and why this fix addresses it.'),
});

/**
 * What an agent found when it went back to the page and reinvestigated the
 * failed step live — see `FlowRepairLoop`'s reinvestigation option. Kept as
 * its own labelled section in the prompt, apart from the AX tree: "what an
 * agent did and saw" and "what the page shows now" are different claims, the
 * same separation `page-probe.ts` keeps between a probe report and the tree.
 */
export interface RepairInvestigation {
  /** The agent's own account of what it found (or why it gave up). */
  summary: string;
  /** Whether the agent reported reaching its investigation goal. */
  succeeded: boolean;
  /** One line per action taken, with its outcome. */
  actions: string[];
}

export interface RepairRequest {
  flow: Flow;
  /** The step that failed. */
  failedStep: FlowStep;
  /** Where it lives in `flow` — which array, and at what index. */
  section: 'setup' | 'steps';
  index: number;
  /** The escalation ladder's attempts trail / error message. */
  error: string;
  axTree: string;
  url: string;
  /** 1-based — which repair attempt this is. */
  attempt: number;
  /** What earlier attempts tried and how they went, so the model doesn't repeat a failed fix. */
  history: Array<{ attempt: number; summary: string; outcome: string }>;
  /** Live findings from an agent that reinvestigated the failed step. Absent when none ran. */
  investigation?: RepairInvestigation | undefined;
  /**
   * The steps after the failed one in the same section — supplied only when
   * the caller allows regenerating the flow from the failed step onward.
   * Its presence is the permission: with it absent, the prompt never even
   * describes the tail, so a model cannot be talked into rewriting steps the
   * caller said were off-limits.
   */
  followingSteps?: FlowStep[] | undefined;
}

export interface RepairProposal {
  canFix: boolean;
  insertBefore: FlowStep[];
  replacement: FlowStep;
  /** Replacement for every step after the failed one; empty or absent = keep them. */
  rewriteFollowing?: FlowStep[] | undefined;
  reasoning: string;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

/** Pluggable model backend, so tests can inject a deterministic stub. */
export interface FlowRepairModel {
  readonly id: string;
  repair(request: RepairRequest): Promise<RepairProposal>;
  /**
   * Whether this backend's output schema can express a step with this action
   * at all. `RepairSchema` is built on `GeneratedStepSchema`, whose `action`
   * enum is `GENERATOR_ACTIONS` — no DB, HTTP or workflow actions. Asked to
   * repair an `expectDbRow` step, the model echoes the action, zod rejects
   * it, and at temperature 0 the identical mismatch repeats until the
   * structured-output breaker opens and takes the whole suite down (be100,
   * 2026-08-23: six echoed `expectDbRow` repairs opened the breaker and 90+
   * cases were blocked against a model that was answering fine). Callers
   * must not ask a question the schema refuses every answer to. Optional so
   * scripted test stubs are unaffected; absent means "ask away".
   */
  canExpress?(action: string): boolean;
}

/** The one answer `canExpress` gives for the LLM-backed model. */
export function repairSchemaCanExpress(action: string): boolean {
  return (GENERATOR_ACTIONS as readonly string[]).includes(action);
}

const SYSTEM_PROMPT = `A UI test flow just failed at one step. You propose a targeted fix — not a
rewrite of the whole flow. You may:
- insert one or more new steps immediately before the failing step (dismiss an unexpected popup,
  wait for something to load, fix a missed precondition), and/or
- replace the failing step itself (a different selector, a different action, a different value).

Every step before the failing one is untouched — you cannot see them, and your fix must not need
to change them. Do not try to solve anything other than the one failure described below.

If — and only if — the prompt lists the steps that FOLLOW the failed one, you may additionally
put a complete rewrite of all of them in "rewriteFollowing", regenerated against the evidence in
front of you. Do this only when the failure shows they were written against a page that does not
exist — a wrong assumption that the following steps inherit. If they still make sense once the
failed step is fixed, leave "rewriteFollowing" as an empty array. When no following steps are
listed, "rewriteFollowing" must be empty.

If the prompt carries an agent's live investigation of the failure, treat it as the strongest
evidence you have: the agent drove the real page. Actions it took successfully to reveal the
target (opening a menu, waiting, scrolling) are exactly what belongs in "insertBefore".

Actions available for "insertBefore" entries and for "replacement": ${GENERATOR_ACTIONS.join(', ')}.
Leave unused fields as empty strings.

${SELECTOR_SYNTAX_RULES}

Set "canFix" to false, and explain why in "reasoning", when the evidence doesn't support a fix:
the app looks genuinely broken, the page is on an unexpected origin, or nothing in the tree
resembles what the failed step needed. A wrong guess that makes the flow appear to pass while
testing the wrong thing is worse than reporting the failure honestly.

${DETERMINISM_RULES}

${procedure('HOW TO DIAGNOSE, THEN FIX', [
  'Classify the failure from the error text and the tree, in this order: (a) WRONG PAGE STATE — the tree is a sign-in page, a consent page, an error page, an empty state, or a dialog is open; (b) CONTROL EXISTS UNDER ANOTHER NAME/ROLE — the intent is served by a node in the tree; (c) CONTROL NOT RENDERED YET — the tree looks half-built or the failure is a timeout on a page that just navigated; (d) DATA — the value typed was refused (already exists, invalid); (e) APP BROKEN — the intended control is absent and the page is otherwise complete.',
  '(a) → insertBefore the steps that reach the right state (a goto, a click that closes the dialog, a clickIfVisible on the consent accept); keep the failing step as it was. (b) → replace only the selector, canonical form. (c) → insertBefore ONE waitFor on the control, or on the container the tree names; nothing else. (d) → replace only the value. (e) → canFix false.',
  'An assertion is never rewritten into a different claim: you may prepare the page before it, never change what it asserts.',
  'Rewrite the following steps ONLY when they are listed AND the diagnosis is (a) with a page that will never come — and then regenerate them against the tree in front of you, in canonical selectors, keeping their assertions\' meaning.',
])}

${selfCheck([
  'The fix touches only the failing step and what goes immediately before it.',
  'Every selector in insertBefore and replacement is in canonical form and appears in the tree.',
  'If the failing step was an assertion, its claim is unchanged.',
  'rewriteFollowing is empty unless following steps were listed and the diagnosis called for it.',
  'canFix is false whenever the diagnosis was APP BROKEN or the tree is on an unexpected origin.',
])}`;

function buildUserPrompt(request: RepairRequest): string {
  // The tree is fenced and the page-derived one-liners are bounded
  // (`src/providers/model-fence.ts`). The failed step and the following steps
  // are the flow's own JSON — the harness wrote them, and rewriting them here
  // would be rewriting the thing under repair.
  const lines = [
    `Page URL: ${sanitizeInline(request.url)}`,
    `Failed step (${request.section}[${request.index}]): ${JSON.stringify(request.failedStep)}`,
    `Failure: ${sanitizeInline(request.error)}`,
    `Repair attempt: ${request.attempt}`,
  ];
  if (request.history.length > 0) {
    lines.push('', 'Earlier attempts on this same failure:');
    for (const h of request.history) {
      lines.push(`  attempt ${h.attempt}: ${sanitizeInline(h.summary)} — ${sanitizeInline(h.outcome)}`);
    }
  }
  if (request.investigation) {
    const inv = request.investigation;
    lines.push(
      '',
      `Agent reinvestigation of this failure (${inv.succeeded ? 'reached its goal' : 'did not reach its goal'}):`,
      `  ${sanitizeInline(inv.summary)}`,
    );
    if (inv.actions.length > 0) {
      lines.push('  What the agent did, in order:');
      for (const action of inv.actions) lines.push(`    - ${sanitizeInline(action)}`);
    }
  }
  if (request.followingSteps && request.followingSteps.length > 0) {
    lines.push(
      '',
      'Steps that follow the failed one (you may rewrite ALL of them via "rewriteFollowing", or keep them by leaving it empty):',
    );
    request.followingSteps.forEach((step, i) => {
      lines.push(`  ${request.index + 1 + i}. ${JSON.stringify(step)}`);
    });
  }
  lines.push('', 'Accessibility tree at the moment of failure:', fence('page', request.axTree));
  return lines.join('\n');
}

export interface LlmFlowRepairModelOptions {
  /** A concrete AI SDK model. Omit to resolve the `generator` role from config. */
  model?: LanguageModel | undefined;
  id?: string | undefined;
  maxOutputTokens?: number | undefined;
  maxRetries?: number | undefined;
  factory?: LlmFactory | undefined;
}

/**
 * Default backend: one structured-output call, through whichever provider
 * the `generator` role points at.
 *
 * `id` is resolved lazily, on first read, not in the constructor — the same
 * fix applied to `LlmDataModel` after it caused a real bug (constructing the
 * class must never, by itself, demand an API key).
 */
export class LlmFlowRepairModel implements FlowRepairModel {
  readonly #source: ModelSource;
  readonly #maxOutputTokens: number;
  readonly #maxRetries: number;
  readonly #explicitId: string | undefined;

  constructor(options: LlmFlowRepairModelOptions = {}) {
    if (options.model) {
      this.#source = { model: options.model };
      this.#explicitId = options.id ?? 'custom:repair';
      this.#maxRetries = options.maxRetries ?? 2;
    } else {
      const factory = options.factory ?? new LlmFactory();
      this.#source = { factory, role: 'generator' };
      this.#explicitId = options.id;
      this.#maxRetries = options.maxRetries ?? factory.maxRetries;
    }
    this.#maxOutputTokens = options.maxOutputTokens ?? 2048;
  }

  canExpress(action: string): boolean {
    return repairSchemaCanExpress(action);
  }

  get id(): string {
    if (this.#explicitId !== undefined) return this.#explicitId;
    return 'factory' in this.#source ? this.#source.factory.forRole('generator').id : 'custom:repair';
  }

  async repair(request: RepairRequest): Promise<RepairProposal> {
    const { object, inputTokens, outputTokens } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      schema: RepairSchema,
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(request),
      maxOutputTokens: this.#maxOutputTokens,
      maxRetries: this.#maxRetries,
    });

    const insertBefore = object.insertBefore
      .map(toFlowStep)
      .filter((step): step is FlowStep => step !== null);
    const replacement = toFlowStep(object.replacement) ?? request.failedStep;
    // Structural, not polite: with no followingSteps offered, a tail rewrite
    // was never on the table, so anything the model put there is discarded.
    const rewriteFollowing = request.followingSteps?.length
      ? object.rewriteFollowing.map(toFlowStep).filter((step): step is FlowStep => step !== null)
      : [];

    return {
      canFix: object.canFix,
      insertBefore,
      replacement,
      rewriteFollowing,
      reasoning: object.reasoning,
      inputTokens,
      outputTokens,
    };
  }
}
