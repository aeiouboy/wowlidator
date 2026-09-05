/**
 * Pre-run dead-end risk: one small model call, after a case is authored and
 * before a browser is spent on it, that estimates how likely the run is to end
 * as a DEAD-END or ERROR rather than a verdict — judged against the ground
 * truth the author was given: the case (what the sheet asks), the flow (what
 * was written), the documents (what the product specifies) and the repository
 * (what the code declares: routes, components, tables).
 *
 * Why it exists (be100, 2026-08-28): a case whose flow needs a page the app
 * does not have, or a label the spec words differently, cannot be healed into
 * passing — but the machinery tries anyway: the ladder's heal rung, the agent
 * rung, in-run step reconstruction, then `--repair`'s three attempts, each a
 * model call and a minute of browser. A dead-end that costs one run is a fact;
 * a dead-end that costs four runs and six model calls is the same fact, paid
 * for four times. So a case judged above the threshold runs ONCE with every
 * RERUN path off (`failFastRunOptions`): no healer, no reconstruction, no
 * repair loop — the agent stays, once per step (refined 2026-08-28: a
 * workflow leg has exactly one executor, and the assist rung is one consult
 * at the step that failed). Its verdict is recorded exactly as any other
 * run's; only the retries are withheld.
 *
 * Honest about what it is: an estimate, from the same evidence the author had.
 * It is recorded on the proof (`bundle.risk`) so a reader can see WHY a case
 * ran fail-fast and disagree — `WOWLIDATOR_RISK=off` turns it off, and
 * `WOWLIDATOR_RISK_THRESHOLD` moves the line. Deterministic signals
 * (`riskSignals`) are computed first and handed to the model as evidence, so a
 * route the repository does not declare is a fact in the prompt, not something
 * the model has to notice.
 */

import type { LanguageModel } from 'ai';
import { z } from 'zod';

import type { DeadEndRisk } from '../engine/proof-bundle.js';
import type { Flow, FlowStep } from '../engine/runner.js';
import { pathnameOf, routeIsDeclared } from '../context/route-match.js';
import { LlmFactory, generateStructuredForModel, type ModelSource } from '../providers/llm-factory.js';
import { DETERMINISM_RULES, procedure } from '../providers/prompt-discipline.js';

export type { DeadEndRisk } from '../engine/proof-bundle.js';

/** Above this likelihood a case runs fail-fast. "More than 50%" — strictly above. */
export const DEFAULT_RISK_THRESHOLD = 0.5;
const DOC_EXCERPT_CHARS = 3_000;
const DOCS_BUDGET_CHARS = 10_000;
const REPO_BUDGET_CHARS = 4_000;
const MAX_SIGNALS = 12;

/** `WOWLIDATOR_RISK=off` disables the assessment; anything else keeps it on. */
export function riskEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['WOWLIDATOR_RISK'] ?? '').trim().toLowerCase() !== 'off';
}

/** `WOWLIDATOR_RISK_THRESHOLD` as a percentage (1–99); the default otherwise. */
export function riskThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number((env['WOWLIDATOR_RISK_THRESHOLD'] ?? '').trim());
  if (!Number.isFinite(raw) || raw < 1 || raw > 99) return DEFAULT_RISK_THRESHOLD;
  return raw / 100;
}

export function riskVerdict(
  likelihood: number,
  threshold: number,
  /** The second dimension (2026-08-28): a near-certain genuine FAIL fail-fasts too. */
  failLikelihood = 0,
): DeadEndRisk['verdict'] {
  return likelihood > threshold || failLikelihood > threshold ? 'fail-fast' : 'run';
}

export interface RiskDocument {
  name: string;
  text: string;
}

export interface RiskRequest {
  /** `<caseId> <title>` — how the case is named everywhere else. */
  caseName: string;
  /** The sheet's own words: steps, expected result, preconditions, test data. */
  caseText: string;
  flow: Flow;
  /** The background documents the author read — already ranked for this case. */
  documents: readonly RiskDocument[];
  /** The repository slice the author read (routes, components, tables), or ''. */
  repository: string;
  /** Page routes the repository declares; empty = no repository indexed. */
  declaredRoutes: readonly string[];
  deploymentUrl?: string | undefined;
  /** Whether backend steps may run at all this pass. */
  backend: boolean;
  /**
   * The sheet's own recorded Actual Result, when it holds one. `blocked` is
   * the sheet's Blocked / Pending deploy (CG-01, `sheetVerdict`): the tester
   * could not reach the claim either, which is evidence for a dead-end, not
   * for a fail.
   */
  knownResult?: 'passed' | 'failed' | 'blocked' | undefined;
}

export interface RiskAssessment {
  /** 0–1. */
  likelihood: number;
  /** 0–1: a genuine FAIL — the application contradicting the claim. */
  failLikelihood: number;
  reasons: string[];
  missing: string[];
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

export interface RiskModel {
  readonly id: string;
  assess(request: RiskRequest, signals: readonly string[]): Promise<RiskAssessment>;
}

/* ------------------------------------------------------------ signals */

function stepsOf(flow: Flow): FlowStep[] {
  const out: FlowStep[] = [];
  const walk = (steps: readonly FlowStep[] | undefined): void => {
    for (const step of steps ?? []) {
      out.push(step);
      if (step.action === 'when') {
        walk(step.then);
        walk(step.else);
      }
    }
  };
  walk(flow.setup);
  walk(flow.steps);
  return out;
}

/** The human-readable name a selector asks the page for, when it names one. */
export function selectorNames(selector: string): string[] {
  const names: string[] = [];
  for (const m of selector.matchAll(/name=(?:"([^"]+)"|'([^']+)')/g)) names.push((m[1] ?? m[2])!);
  for (const m of selector.matchAll(/(?:^|\s|>>\s*)text=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/g)) {
    names.push((m[1] ?? m[2] ?? m[3])!);
  }
  for (const m of selector.matchAll(/:has-text\((?:"([^"]+)"|'([^']+)')\)/g)) names.push((m[1] ?? m[2])!);
  return names.map((n) => n.replace(/^\/|\/i?$/g, '').trim()).filter((n) => n.length >= 2);
}

function fold(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Facts about the flow that need no model: a page the repository does not
 * declare, a control name no evidence mentions, a backend step with the
 * backend off, an agent step. Each is one line the model is handed as
 * evidence — and each is the kind of thing that ends a run as a dead-end.
 */
export function riskSignals(request: RiskRequest): string[] {
  const signals: string[] = [];
  const steps = stepsOf(request.flow);
  const corpus = fold([request.caseText, request.repository, ...request.documents.map((d) => d.text)].join('\n'));

  const seenRoutes = new Set<string>();
  const seenNames = new Set<string>();
  steps.forEach((step, index) => {
    const at = `step ${index + 1}`;
    if (step.action === 'goto' && request.declaredRoutes.length > 0) {
      const path = pathnameOf(step.url);
      if (path !== undefined && !seenRoutes.has(path)) {
        seenRoutes.add(path);
        if (routeIsDeclared(path, request.declaredRoutes, request.deploymentUrl) === false) {
          signals.push(`${at}: goto ${path} — the repository declares no page route for this path`);
        }
      }
    }
    if (step.action === 'workflow') {
      signals.push(`${at}: an agent workflow step ("${step.goal.slice(0, 80)}") — the agent must find its own way`);
    }
    if (!request.backend && /^(request|expectStatus|expectJson|expectHeader|expectCalls|dbSnapshot|expectDb)/.test(step.action)) {
      signals.push(`${at}: ${step.action} — a backend step, and the backend is off this pass`);
    }
    // The one selector, or an either/or step's several (CG-08) — each
    // alternative names a label the page must render for that branch.
    const selectors: string[] = [];
    if ('selector' in step && typeof step.selector === 'string') selectors.push(step.selector);
    if (step.action === 'expectAnyVisible') selectors.push(...step.selectors);
    for (const selector of selectors) {
      for (const name of selectorNames(selector)) {
        const key = fold(name);
        if (seenNames.has(key)) continue;
        seenNames.add(key);
        if (!corpus.includes(key)) {
          signals.push(`${at}: the selector asks for "${name}" — a label no document, the case, or the repository mentions`);
        }
      }
    }
  });
  if (request.knownResult === 'failed') {
    signals.push(
      "the sheet's own Actual Result records this case as FAILED — a known defect the tester already hit; a rerun most likely fails the same way",
    );
  }
  if (request.knownResult === 'blocked') {
    signals.push(
      "the sheet's own Actual Result records this case as BLOCKED — the tester could not reach the claim either (a missing page, a pending deploy); a run most likely dead-ends before its assertions",
    );
  }
  if (/known\s*fail|failed\s+\d{4,}/i.test(request.caseText)) {
    signals.push('the case notes cite a recorded failure/defect — evidence the application does not satisfy this claim today');
  }
  if (request.documents.length === 0) signals.push('no background document was retrieved for this case');
  if (request.repository === '' && request.declaredRoutes.length === 0) signals.push('no repository is indexed — routes cannot be checked');
  return signals.slice(0, MAX_SIGNALS);
}

/* ------------------------------------------------------------- the model */

const RiskSchema = z.object({
  likelihood: z
    .number()
    .min(0)
    .max(100)
    .describe('0–100: how likely this run ends as a dead-end or error instead of a pass/fail verdict.'),
  // Optional on the wire — a smaller model that drops the second number
  // yields 0 (no expected-fail evidence), never a refused answer.
  failLikelihood: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe('0–100: how likely this run ends in a GENUINE FAIL — the application contradicting the claim.'),
  reasons: z.array(z.string()).max(4).describe('Up to four, each citing its evidence: a step number, a document name, a route.'),
  missing: z.array(z.string()).max(4).describe('What the flow needs that NO evidence shows exists. Empty when everything is accounted for.'),
});

const SYSTEM_PROMPT = `You estimate, BEFORE a browser is spent, how likely an authored UI test is to end as a
DEAD-END or ERROR rather than a verdict. You are given the case (what the sheet asks), the flow
(what was written for it), signals computed from the code (facts, not guesses), the documents the
product is specified in, and the repository's declarations. The documents and the repository are the
ground truth: what they do not describe, the page most likely does not offer.

A DEAD-END is a control or content the flow needs that the page will never provide: a route the
repository does not declare; a menu, column, button or heading no document names (or names with
different wording — the flow asks for the sheet's wording, the page shows the spec's); a dialog
the flow expects that the feature does not open; a value that needs data the case never sets up;
an agent workflow whose goal names a page the application lacks.
An ERROR is the harness breaking: a backend step with no backend; a variable never defined; a
request to an endpoint no spec lists.
A FAIL is NOT either of those: a claim the page can answer, even by contradicting it, is a
verdict. Do not raise "likelihood" because the expectation looks wrong — raise it only when the
run cannot reach a point where the expectation is checked.

You ALSO estimate "failLikelihood" — a separate number: how likely the run, having reached its
assertions, ends in a GENUINE FAIL because the application contradicts the claim. Evidence for a
high failLikelihood: the sheet's own Actual Result recorded as Failed (a signal states this when
so); a note citing a defect number or "known fail"; documents that describe behaviour contrary to
the expected output. A near-certain fail is a fact the first run proves — retries, healing and
repair only re-prove it at full price, so it is throttled the same way a dead-end is. A negative
test EXPECTED to pass (asserting an error message appears) is NOT a likely fail — read what the
case intends.

Calibration for likelihood: 0–20 everything the flow needs is declared or described; 30–50 one
needed thing is unsupported by the evidence but plausible; 60–80 a needed control or label is
absent from every document and the repository; 85–100 the flow targets a page or feature the
evidence says does not exist. For failLikelihood: 0–20 nothing suggests the claim fails; 40–60
documents partially contradict the expected output; 70–95 the sheet records Failed or a note
cites a live defect. Signals marked as facts weigh more than your reading of prose.

${DETERMINISM_RULES}

${procedure('HOW TO JUDGE', [
  'List what the flow NEEDS from the page: each goto path, each named control, each dialog/table/column asserted, each agent goal.',
  'For each need, find it in the signals, the documents or the repository. A need found nowhere is "missing".',
  'Weigh the missing needs by how early they occur and whether a later step depends on them — a missing first page dooms everything after it.',
  'Set the likelihood from the calibration bands, then write reasons that each cite a step number and the evidence checked.',
])}`;

function clip(text: string, max: number): string {
  const folded = text.replace(/\r/g, '').trim();
  return folded.length <= max ? folded : folded.slice(0, max - 1) + '…';
}

export function buildRiskPrompt(request: RiskRequest, signals: readonly string[]): string {
  const steps = stepsOf(request.flow).map((step, i) => `${i + 1}. ${JSON.stringify(step)}`.slice(0, 300));
  const lines: string[] = [];
  lines.push(`CASE: ${request.caseName}`);
  if (request.knownResult !== undefined) {
    lines.push(`SHEET'S RECORDED ACTUAL RESULT: ${request.knownResult.toUpperCase()}`);
  }
  lines.push(clip(request.caseText, 2_000));
  lines.push('');
  lines.push(`FLOW (${steps.length} steps):`);
  lines.push(...steps);
  lines.push('');
  lines.push('SIGNALS (computed from the code — facts):');
  lines.push(...(signals.length ? signals.map((s) => `- ${s}`) : ['- none']));
  if (request.declaredRoutes.length > 0) {
    lines.push('');
    lines.push(`DECLARED PAGE ROUTES (${request.declaredRoutes.length}): ${request.declaredRoutes.slice(0, 60).join('  ')}`);
  }
  if (request.repository !== '') {
    lines.push('');
    lines.push('REPOSITORY:');
    lines.push(clip(request.repository, REPO_BUDGET_CHARS));
  }
  lines.push('');
  if (request.documents.length === 0) lines.push('DOCUMENTS: none retrieved');
  let spent = 0;
  for (const doc of request.documents) {
    if (spent >= DOCS_BUDGET_CHARS) break;
    const excerpt = clip(doc.text, Math.min(DOC_EXCERPT_CHARS, DOCS_BUDGET_CHARS - spent));
    spent += excerpt.length;
    lines.push(`DOCUMENT "${doc.name}":`);
    lines.push(excerpt);
    lines.push('');
  }
  return lines.join('\n');
}

export interface LlmRiskModelOptions {
  model?: LanguageModel | undefined;
  id?: string | undefined;
  factory?: LlmFactory | undefined;
  maxOutputTokens?: number | undefined;
  maxRetries?: number | undefined;
}

/** The generator role judges: it wrote the flow, so it is on the model that read this evidence. */
export class LlmRiskModel implements RiskModel {
  readonly #source: ModelSource;
  readonly #explicitId: string | undefined;
  readonly #maxOutputTokens: number;
  readonly #maxRetries: number;

  constructor(options: LlmRiskModelOptions = {}) {
    if (options.model) {
      this.#source = { model: options.model };
      this.#explicitId = options.id ?? 'custom:risk';
      this.#maxRetries = options.maxRetries ?? 2;
    } else {
      const factory = options.factory ?? new LlmFactory();
      this.#source = { factory, role: 'generator' };
      this.#explicitId = options.id;
      this.#maxRetries = options.maxRetries ?? factory.maxRetries;
    }
    this.#maxOutputTokens = options.maxOutputTokens ?? 500;
  }

  get id(): string {
    if (this.#explicitId !== undefined) return this.#explicitId;
    return 'factory' in this.#source ? this.#source.factory.forRole('generator').id : 'custom:risk';
  }

  async assess(request: RiskRequest, signals: readonly string[]): Promise<RiskAssessment> {
    const { object, inputTokens, outputTokens } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      schema: RiskSchema,
      system: SYSTEM_PROMPT,
      prompt: buildRiskPrompt(request, signals),
      maxOutputTokens: this.#maxOutputTokens,
      maxRetries: this.#maxRetries,
      task: 'risk',
    });
    return {
      likelihood: Math.max(0, Math.min(1, object.likelihood / 100)),
      failLikelihood: Math.max(0, Math.min(1, (object.failLikelihood ?? 0) / 100)),
      reasons: object.reasons.map((r) => r.trim()).filter((r) => r !== ''),
      missing: object.missing.map((r) => r.trim()).filter((r) => r !== ''),
      inputTokens,
      outputTokens,
    };
  }
}

/* ------------------------------------------------------------ assessing */

export interface AssessRiskOptions {
  model: RiskModel;
  threshold?: number | undefined;
  log?: ((line: string) => void) | undefined;
}

/**
 * Signals, then the model, then a record. Never throws: an assessment that
 * fails is a case that runs the ordinary way — the retries exist for exactly
 * the runs nobody could judge in advance — and the failure is logged once.
 */
export async function assessDeadEndRisk(request: RiskRequest, options: AssessRiskOptions): Promise<DeadEndRisk | null> {
  const threshold = options.threshold ?? riskThreshold();
  const signals = riskSignals(request);
  try {
    const result = await options.model.assess(request, signals);
    const verdict = riskVerdict(result.likelihood, threshold, result.failLikelihood);
    return {
      likelihood: result.likelihood,
      failLikelihood: result.failLikelihood,
      threshold,
      verdict,
      reasons: result.reasons,
      missing: result.missing,
      signals,
      model: options.model.id,
      at: new Date().toISOString(),
      ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
      ...(result.outputTokens === undefined ? {} : { outputTokens: result.outputTokens }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    options.log?.(`  ! risk assessment skipped for ${request.caseName}: ${message} — the case runs the ordinary way`);
    return null;
  }
}

/** One line for the run log, and the note the proof carries. */
export function describeRisk(risk: DeadEndRisk): string {
  const pct = Math.round(risk.likelihood * 100);
  const failPct = Math.round((risk.failLikelihood ?? 0) * 100);
  const bar = Math.round(risk.threshold * 100);
  const line = risk.reasons[0] ?? risk.missing[0] ?? risk.signals[0] ?? 'no reason given';
  if (risk.verdict === 'fail-fast') {
    // Name the dimension that tripped — a reader deciding whether to disagree
    // needs to know WHICH estimate held the retries back.
    const which =
      risk.likelihood > risk.threshold
        ? `dead-end risk ${pct}% > ${bar}%`
        : `expected-fail risk ${failPct}% > ${bar}% (a near-certain fail is a fact retries only re-prove)`;
    return `fail-fast: pre-run ${which} — ran once, no healer, no reconstruction, no repair; the agent allowed once per step (${line})`;
  }
  return `pre-run dead-end risk ${pct}%, expected-fail risk ${failPct}% — both ≤ ${bar}%, ran with every retry path on (${line})`;
}
