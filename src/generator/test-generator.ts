/**
 * Autonomous test generation.
 *
 * Points a model at a page's accessibility tree and asks two things at once:
 * what should this page be tested for, and what is already wrong with it.
 * The first becomes runnable flows; the second becomes defects that appear in
 * the report without anyone having to write an assertion for them.
 *
 * The model never sees the DOM — same reasoning as the healer. The AX tree is
 * what a screen reader sees, which is exactly the right lens for spotting
 * missing labels and unreachable controls.
 */

import type { LanguageModel } from 'ai';
import type { Page } from 'playwright';
import { z } from 'zod';

import { lenientObject } from '../providers/model-output.js';

import { SELECTOR_SYNTAX_RULES, captureAxTree } from '../healer/jit-healer.js';
import { DETERMINISM_RULES, procedure, selfCheck } from '../providers/prompt-discipline.js';
import { fence, sanitizeInline } from '../providers/model-fence.js';
import {
  LlmFactory,
  generateStructuredForModel,
  type ModelSource,
} from '../providers/llm-factory.js';
import { hasAssertion } from '../engine/runner.js';
import { withQualifiedRole, withRelaxedRoleName, withStableGreeting } from '../engine/selector.js';
import { formatProbeReport, probeInteractions } from '../context/page-probe.js';
import type { Defect, DefectCategory, DefectSeverity } from '../engine/proof-bundle.js';
import type { Flow, FlowStep } from '../engine/runner.js';
import { toPromptContext } from '../context/query.js';
import type { ProjectGraph } from '../context/types.js';

/**
 * Generation sends the largest prompt in the system — a full AX tree in, a
 * whole suite out — so the `generator` role defaults to the provider with the
 * biggest free context window.
 */
export const DEFAULT_GENERATOR_MAX_NODES = 200;

export const TEST_KINDS = ['functional', 'edge-case', 'usability'] as const;
export type TestKind = (typeof TEST_KINDS)[number];

/**
 * How much the generator is allowed to change.
 *
 * `mutations` is the default (2026-09-02, by request): a human QA fills forms
 * with real data, submits them, creates and updates records, and the suite is
 * expected to do the same out of the box. `forms` narrows that to empty/invalid
 * submits only — the validation-focused negative-testing surface — and
 * `read-only` narrows it further to navigate-and-assert, for a page where even
 * an invalid submit is unwelcome. The knob stays: a run that must not write
 * still passes `--policy forms` / `--policy read-only`. DELETE appears at no
 * tier, and `mutations` still refuses purchases and bulk/irreversible ops.
 */
export const MUTATION_POLICIES = ['read-only', 'forms', 'mutations'] as const;
export type MutationPolicy = (typeof MUTATION_POLICIES)[number];
export const DEFAULT_MUTATION_POLICY: MutationPolicy = 'mutations';

const POLICY_RULES: Record<MutationPolicy, string> = {
  'read-only':
    '- Read-only and navigational actions ONLY. Do NOT submit any form, create, update, or delete.',
  forms:
    `- You MAY submit forms with EMPTY or INVALID input to exercise validation, and you SHOULD:
  negative testing is where most real defects live. Submit a required field empty, an
  out-of-range number, a malformed email, an over-length string.
- FILL EVERY field the form needs before submitting, except the one whose validation the
  case is about — a form missing an unrelated required field fails for the wrong reason,
  and a form missing any field may never submit at all. A field with NO accessible name
  (a password box whose label is not associated) sits next to a named one in the tree:
  address it positionally as role=textbox >> nth=N.
- After an invalid submit, assert the SPECIFIC failure the user would see:
    expectVisible on the error element, or expectText naming words from the message.
  Asserting only that the URL is unchanged is NOT acceptable — a page that silently
  does nothing passes that check just as easily as one that correctly rejects the
  input, so it distinguishes nothing and is worse than no assertion. For the same
  reason, expectValue of the very value you just typed proves NOTHING: the field
  holding your input is what happens whether validation works or not.
- Do NOT submit VALID data that would create or modify a record.
- NEVER delete, purchase, or perform a bulk operation.`,
  mutations:
    `- You MAY submit forms with valid data to create or update records, and you MAY submit
  invalid data to exercise validation. Assert the resulting state either way.
- NEVER delete, purchase, or perform a bulk or irreversible operation.`,
};

/** Also the repair model's vocabulary — see `GeneratedStepSchema`. Named to match `AUTHOR_ACTIONS`/`AGENT_ACTIONS`. */
export const GENERATOR_ACTIONS = [
  'goto',
  'click',
  'fill',
  'selectOption',
  'check',
  'uncheck',
  'type',
  'waitFor',
  'expectText',
  'expectVisible',
  'expectHidden',
  'expectEnabled',
  'expectDisabled',
  'expectCount',
  'expectUrl',
  'expectValue',
  'expectScrollable',
  'saveCount',
  'saveText',
] as const;

/**
 * Flat step shape rather than a discriminated union: structured outputs handle
 * a flat object with every field required far more reliably than `anyOf` over
 * five variants. Unused fields come back as empty strings and are dropped in
 * `toFlowStep` below.
 *
 * Exported for reuse by `src/repair/flow-repair-model.ts`: flow repair needs
 * the exact same flat-schema-narrowed-in-code shape for the same reason
 * (free-tier structured output reliability), and duplicating this narrowing
 * logic would just be a second copy to keep in sync.
 */
export const GeneratedStepSchema = lenientObject({
  action: z.enum(GENERATOR_ACTIONS),
  selector: z.string().describe('Playwright selector. Empty string for goto.'),
  value: z
    .string()
    .describe(
      'Text for fill or type, the visible label of the option for selectOption, or expected substring for expectText. Else empty.',
    ),
  url: z.string().describe('Path for goto, relative to the page. Else empty.'),
  intent: z.string().describe('What this step is checking, in plain language.'),
});

const GeneratedCaseSchema = lenientObject({
  name: z.string(),
  kind: z.enum(TEST_KINDS),
  rationale: z.string().describe('Why this case is worth running.'),
  steps: z.array(GeneratedStepSchema),
});

const GeneratedDefectSchema = lenientObject({
  title: z.string(),
  detail: z.string(),
  severity: z.enum(['high', 'medium', 'low']),
  category: z.enum(['functional', 'usability', 'accessibility']),
  selector: z.string().describe('Where the problem is. Empty if page-wide.'),
});

const GenerationSchema = lenientObject({
  cases: z.array(GeneratedCaseSchema),
  defects: z.array(GeneratedDefectSchema),
});

export interface GeneratedCase {
  name: string;
  kind: TestKind;
  rationale: string;
  flow: Flow;
}

export interface RejectedCase {
  name: string;
  kind: TestKind;
  reason: string;
}

export interface GeneratedSuite {
  sourceUrl: string;
  model: string;
  generatedAt: string;
  cases: GeneratedCase[];
  /**
   * Cases the model produced that were discarded, with the reason. Surfaced
   * rather than silently dropped — a generator that keeps emitting
   * assertion-free cases is a prompt problem you want to see.
   */
  rejected: RejectedCase[];
  defects: Defect[];
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  latencyMs: number;
}

export interface GenerateRequest {
  url: string;
  axTree: string;
  /**
   * Controls that exist only after an interaction (`probeInteractions`). Kept
   * separate from `axTree`: "behind this menu" and "on the page" are different
   * claims, and a case that confuses them clicks a menu item without opening
   * the menu first.
   */
  interactions?: string | undefined;
  /** Free-text steer, e.g. "focus on the filter controls". */
  focus?: string | undefined;
  maxCases: number;
  /** How much the generated suite is allowed to change. */
  policy?: MutationPolicy | undefined;
  /**
   * A `toPromptContext` slice of the repository context graph for this page —
   * what it renders, what that renders in turn, what already covers it.
   * Omitted when no `ContextEngine` graph was supplied to `TestGenerator`, or
   * when the graph has no route matching this URL.
   */
  projectContext?: string | undefined;
  /**
   * Why cases from an earlier attempt were rejected — the healer's `rejected`
   * seam applied to generation: a model cannot stop writing vacuous form
   * assertions unless the next ask names the ones it wrote.
   */
  feedback?: readonly string[] | undefined;
}

export interface GenerationResult {
  cases: Array<{ name: string; kind: TestKind; rationale: string; steps: FlowStep[] }>;
  defects: Array<Omit<Defect, 'id' | 'source'>>;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

/** Pluggable backend, so the suite can be tested without a network call. */
export interface GeneratorModel {
  readonly id: string;
  generate(request: GenerateRequest): Promise<GenerationResult>;
}

const buildSystemPrompt = (policy: MutationPolicy): string => `You design UI test suites by reading a page's accessibility (AX) tree.

Produce two things.

**cases** — runnable test flows. Cover three kinds:
- functional: the page's main happy paths (filter, paginate, search, open a record)
- edge-case: boundary and empty conditions (submit an empty required field, paginate past the last page, clear a filter that is already clear, very long input)
- usability: flows that expose friction (a control that gives no feedback, a destructive action with no confirmation)

Actions available:
- goto        navigate. Path in "url".
- click       press a control.
- fill        type into a field. Text in "value".
- selectOption  choose a dropdown option. The option's VISIBLE LABEL in "value",
              the dropdown control itself in "selector". Works on a native
              select and on a custom combobox alike — never fill a dropdown,
              and never click it open to guess at its items: this one step
              opens it and picks.
- check / uncheck  tick or untick a checkbox, radio, or toggle. Prefer these
              over click when the point is the resulting state — they verify
              the state actually changed.
- type        type key by key, firing real keyboard events. Use INSTEAD of
              fill only for fields that react per keystroke (autocomplete,
              typeahead, masked input); fill is faster everywhere else.
- waitFor     wait for an element to become visible.
- expectText  element's text contains "value".
- expectVisible / expectHidden        element is / is not visible.
- expectEnabled / expectDisabled      control is / is not interactive.
- expectCount element matches exactly "value" elements (a number as a string,
              or a {{variable}} saved earlier by saveCount/saveText).
- saveCount   read HOW MANY elements match into a variable named "value"; a later
              expectCount/expectText carrying {{that-name}} compares it. Use it for
              any claim that two readings agree or that a number did not change —
              asserting one side exists proves no agreement.
- saveText    read the element's visible text into a variable named "value".
- expectUrl   current URL contains "value". When asserting where a link goes, take
              the path from that link's url= in the tree — never from its visible
              label. A card's label and its destination often differ — "Reports"
              can point at /analytics/overview —
              and a guessed path is a test that fails for the wrong reason.
- expectValue an input's current value equals "value".
- expectScrollable  the page, or a container if you give a selector, can really be
              scrolled: content overflows AND the scroll position moves. Worth a
              usability case wherever a list or panel continues past the fold —
              content nobody can reach passes every other assertion ever written.

**Every case MUST contain at least one expect* step.** A case that only clicks
and navigates proves nothing: it passes whether or not the feature works, which
is worse than having no test. State what should be true after the interaction,
and assert it.

Prefer asserting an observable *consequence* over asserting the thing you just
did. After clicking Next, assert the page indicator changed — not that the Next
button still exists.

An assertion must be able to FAIL. Never assert that a selector contains the very
text used to find it (expectText on text=Foo with value "Foo" is a tautology), and
never assert a value you just typed unless the point is that it survives a reload.
Before emitting an assertion, ask: what broken behaviour would this catch? If the
answer is "none", write a different assertion.

- Leave unused fields as empty strings.
${POLICY_RULES[policy]}

${DETERMINISM_RULES}

${procedure('HOW TO BUILD THE SUITE', [
  'Inventory the page from the tree: its forms (fields + submit), its navigation (links with url=), its lists/tables (repeated rows), its filters/toggles. Only what the tree shows.',
  'For each inventoried thing, in TREE ORDER, decide the one functional case that proves it works, then the one edge case the policy allows, then a usability case only where the tree shows friction. Stop at the case limit; earlier things in the tree win.',
  'Name each case "<kind>: <what it proves>" using the control\'s own accessible name — the same control always yields the same name.',
  'For each case: the fewest steps that reach the claim, then the assertion that would FAIL if it did not hold. Every selector in canonical form from the tree.',
  'List defects last, only those the tree positively shows.',
])}

${SELECTOR_SYNTAX_RULES}

${selfCheck([
  'Every case has at least one expect* step that would fail if the feature were broken.',
  'No case asserts a value it just typed, and no expectText repeats the text used to find the element.',
  'Every selector token appears in the tree, in canonical form; every expectUrl fragment comes from a url= in the tree.',
  'Cases follow tree order, and no two cases prove the same thing.',
  'The policy\'s limits are respected: nothing submits valid data under read-only, nothing writes under forms, nothing deletes ever.',
])}

If a "Project context" section is present below, it describes what this route
renders, what that component uses, and what already covers it, drawn from a
static index of the repository — not from the page itself. Use it to ground
case names in real component/route terms and to avoid duplicating a flow that
already exists; never treat it as a substitute for the AX tree, which is the
only source of truth for what selectors actually exist right now.

**defects** — problems visible in the AX tree itself, with no run required. Look for: controls with no accessible name, inputs with no label, disabled controls with no explanation, duplicate ambiguous names, images or icons carrying meaning without text, headings that skip levels, focusable elements with generic roles.

Report only what the tree actually shows. If the page looks clean, return an empty defects array — do not invent problems to seem thorough.

If the tree ends with a TRUNCATED notice it is INCOMPLETE. Never report a defect
whose evidence is that something is missing — no accessible name, no focusable
control, no label — because the missing thing may simply be past the cut. Only
report defects you can see positively stated in the nodes shown.`;

function buildUserPrompt(request: GenerateRequest): string {
  // Fenced at assembly (`src/providers/model-fence.ts`): the tree and the
  // repository index are third-party text, and this prompt asks the model to
  // write the tests — the one place a forged instruction would be cheapest to
  // obey. `request.axTree` itself is untouched; only the prompt string is.
  const lines = [
    `Page URL: ${sanitizeInline(request.url)}`,
    `Generate at most ${request.maxCases} test cases.`,
  ];
  if (request.focus) lines.push(`Focus area: ${sanitizeInline(request.focus)}`);
  if (request.projectContext) lines.push('', fence('repository', request.projectContext));
  lines.push('', 'Accessibility tree:', fence('page', request.axTree));
  if (request.interactions) lines.push('', fence('page', request.interactions));
  // Rejection feedback last — the tree and context above stay a byte-identical
  // prefix across retries, so a provider's implicit prompt cache can bill the
  // resent capture at cache rates.
  if (request.feedback?.length) {
    lines.push(
      '',
      'Cases from your previous attempt were REJECTED. Do not repeat these mistakes:',
      ...request.feedback.map((entry) => `  - ${sanitizeInline(entry)}`),
    );
  }
  return lines.join('\n');
}

export interface LlmGeneratorModelOptions {
  /** A concrete AI SDK model. Omit to resolve the `generator` role from config. */
  model?: LanguageModel | undefined;
  id?: string | undefined;
  maxOutputTokens?: number | undefined;
  maxRetries?: number | undefined;
  factory?: LlmFactory | undefined;
}

export class LlmGeneratorModel implements GeneratorModel {
  readonly id: string;

  readonly #source: ModelSource;
  readonly #maxOutputTokens: number;
  readonly #maxRetries: number;

  constructor(options: LlmGeneratorModelOptions = {}) {
    if (options.model) {
      this.#source = { model: options.model };
      this.id = options.id ?? 'custom:generator';
      this.#maxRetries = options.maxRetries ?? 2;
    } else {
      const factory = options.factory ?? new LlmFactory();
      this.#source = { factory, role: 'generator' };
      this.id = options.id ?? factory.forRole('generator').id;
      this.#maxRetries = options.maxRetries ?? factory.maxRetries;
    }
    this.#maxOutputTokens = options.maxOutputTokens ?? 8192;
  }

  async generate(request: GenerateRequest): Promise<GenerationResult> {
    const { object, inputTokens, outputTokens } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      schema: GenerationSchema,
      system: buildSystemPrompt(request.policy ?? DEFAULT_MUTATION_POLICY),
      prompt: buildUserPrompt(request),
      maxOutputTokens: this.#maxOutputTokens,
      maxRetries: this.#maxRetries,
    });

    return {
      // The cap is re-applied here: models routinely ignore "at most N".
      cases: object.cases.slice(0, request.maxCases).map((testCase) => ({
        name: testCase.name,
        kind: testCase.kind,
        rationale: testCase.rationale,
        steps: testCase.steps.map(toFlowStep).filter((step): step is FlowStep => step !== null),
      })),
      defects: object.defects.map((defect) => ({
        title: defect.title,
        detail: defect.detail,
        severity: defect.severity as DefectSeverity,
        category: defect.category as DefectCategory,
        selector: defect.selector === '' ? undefined : defect.selector,
      })),
      inputTokens,
      outputTokens,
    };
  }
}

/**
 * A form case whose assertions cannot fail: it fills, submits, and then
 * checks only its own typed value or the URL. The field still holding your
 * input and the URL staying put are what happens WHETHER OR NOT validation
 * works, so the case distinguishes nothing — seen live on a login form,
 * where "Attempt submission with malformed email" asserted
 * `expectValue = "invalid-email-format"` and would have passed against a
 * page with no validation at all. Returns why it is vacuous, or null.
 */
export function vacuousFormAssertion(steps: readonly FlowStep[]): string | null {
  // `type` and `selectOption` put a value into a field the same way `fill`
  // does, so asserting your own typed/selected value back is equally vacuous.
  const filled = new Set(
    steps
      .filter(
        (step) => step.action === 'fill' || step.action === 'type' || step.action === 'selectOption',
      )
      .map((step) => (step as { selector: string }).selector),
  );
  if (filled.size === 0) return null;
  const submitted = steps.some((step) => step.action === 'click');
  if (!submitted) return null;
  const assertions = steps.filter((step) =>
    (ASSERTION_GENERATOR_ACTIONS as readonly string[]).includes(step.action),
  );
  if (assertions.length === 0) return null;
  const vacuous = assertions.every((step) => {
    if (step.action === 'expectUrl') return true;
    if (step.action === 'expectValue') {
      return filled.has((step as { selector: string }).selector);
    }
    return false;
  });
  if (!vacuous) return null;
  return (
    'fills and submits a form but asserts only its own typed value or the URL — ' +
    'both hold whether or not validation works. Assert the validation message ' +
    '(expectVisible/expectText on the error) or the resulting state instead.'
  );
}

/**
 * An `expectUrl` fragment that appears in none of the tree's `url=` attributes
 * and in no `goto` of the case is a path derived from a label — the habit
 * that asserted "time-attendance" against a card routing to `/en/overtime`
 * (live) and filed a high defect against an app that navigated correctly.
 * Same truncation honesty as every tree-grounded lint.
 */
export function inventedUrlReason(
  steps: readonly FlowStep[],
  axTree: string | undefined,
): string | null {
  if (!axTree || axTree.includes('TREE TRUNCATED')) return null;
  const gotoUrls = steps
    .filter((step) => step.action === 'goto')
    .map((step) => (step as { url: string }).url);
  for (const step of steps) {
    if (step.action !== 'expectUrl') continue;
    const expected = (step as { value: string }).value;
    if (expected === '') continue;
    if (axTree.includes(expected) || gotoUrls.some((url) => url.includes(expected))) continue;
    return (
      `expects the URL to contain "${expected}", which appears in none of the tree's ` +
      "url= attributes and in no goto of the case — a path derived from a label. Take " +
      'expected URLs from the url= of the control being clicked, or assert visible ' +
      'content of the destination instead.'
    );
  }
  return null;
}

/** The generator-vocabulary actions that count as assertions, for the lint above. */
const ASSERTION_GENERATOR_ACTIONS = [
  'expectText',
  'expectVisible',
  'expectHidden',
  'expectEnabled',
  'expectDisabled',
  'expectCount',
  'expectUrl',
  'expectValue',
  'expectScrollable',
  'saveCount',
  'saveText',
] as const;

/** Narrow the flat generated shape back into the runner's step union. Exported — see `GeneratedStepSchema`. */
export function toFlowStep(raw: z.infer<typeof GeneratedStepSchema>): FlowStep | null {
  const intent = raw.intent === '' ? undefined : raw.intent;
  // The model copies accessible names out of the AX tree, and Chrome's names
  // are case-transformed where CSS says so while Playwright's matcher is not —
  // see `src/engine/selector.ts`. Relaxing case here, at the one point every
  // generated step is narrowed, means the flow written to disk is a selector
  // that actually resolves rather than one the runner has to rescue.
  // And a time-of-day greeting is written as the name after it: the page
  // chooses the greeting by the clock, so it is never the fact a step proves.
  const selector = raw.selector === '' ? '' : withStableGreeting(withRelaxedRoleName(withQualifiedRole(raw.selector)));
  switch (raw.action) {
    case 'goto':
      return raw.url === '' ? null : { action: 'goto', url: raw.url };
    case 'click':
      return selector === '' ? null : { action: 'click', selector, intent };
    case 'waitFor':
      return selector === '' ? null : { action: 'waitFor', selector, intent };
    case 'fill':
      return selector === '' ? null : { action: 'fill', selector, value: raw.value, intent };
    case 'selectOption':
      return selector === '' || raw.value === ''
        ? null
        : { action: 'selectOption', selector, value: raw.value, intent };
    case 'check':
      return selector === '' ? null : { action: 'check', selector, intent };
    case 'uncheck':
      return selector === '' ? null : { action: 'uncheck', selector, intent };
    case 'type':
      return selector === '' || raw.value === ''
        ? null
        : { action: 'type', selector, value: raw.value, intent };
    case 'expectText':
      return selector === '' || raw.value === ''
        ? null
        : { action: 'expectText', selector, value: raw.value, intent };
    case 'expectVisible':
      return selector === '' ? null : { action: 'expectVisible', selector, intent };
    case 'expectHidden':
      return selector === '' ? null : { action: 'expectHidden', selector, intent };
    case 'expectEnabled':
      return selector === '' ? null : { action: 'expectEnabled', selector, intent };
    case 'expectDisabled':
      return selector === '' ? null : { action: 'expectDisabled', selector, intent };
    case 'expectCount': {
      // The schema carries every field as a string; digits or a {{variable}}
      // saved by saveCount/saveText — anything else is unusable rather than
      // something to guess at.
      if (/^\{\{[\w.-]+\}\}$/.test(raw.value.trim())) {
        return selector === '' ? null : { action: 'expectCount', selector, count: raw.value.trim(), intent };
      }
      const count = Number(raw.value);
      return selector === '' || !Number.isInteger(count) || count < 0
        ? null
        : { action: 'expectCount', selector, count, intent };
    }
    case 'saveCount':
      return selector === '' || raw.value.trim() === ''
        ? null
        : { action: 'saveCount', selector, as: raw.value.trim(), intent };
    case 'saveText':
      return selector === '' || raw.value.trim() === ''
        ? null
        : { action: 'saveText', selector, as: raw.value.trim(), intent };
    case 'expectUrl':
      return raw.value === '' ? null : { action: 'expectUrl', value: raw.value, intent };
    case 'expectValue':
      return selector === '' || raw.value === ''
        ? null
        : { action: 'expectValue', selector, value: raw.value, intent };
    case 'expectScrollable':
      // No selector means the page itself, which is the common case — so an
      // empty one narrows to `undefined` rather than dropping the step.
      return { action: 'expectScrollable', selector: selector === '' ? undefined : selector, intent };
    default:
      return null;
  }
}

export interface TestGeneratorOptions {
  model: GeneratorModel;
  maxCases?: number | undefined;
  maxAxNodes?: number | undefined;
  /** Default `read-only`; opt in explicitly to negative/mutation testing. */
  policy?: MutationPolicy | undefined;
  /**
   * A pre-built repository context graph (see `src/context/`). Purely
   * additive: omit it and generation behaves exactly as before — an AX tree
   * in, a suite out, no project awareness. When supplied, the slice relevant
   * to the page's URL is included in the prompt.
   */
  projectGraph?: ProjectGraph | undefined;
  /** Called at each generation lifecycle event — for live progress output. */
  onLog?: ((line: string) => void) | undefined;
  /** Open the page's menus and disclosures before generating. Default false. */
  probe?: boolean | undefined;
  maxProbes?: number | undefined;
}

export class TestGenerator {
  readonly model: GeneratorModel;

  readonly #maxCases: number;
  readonly #maxAxNodes: number;
  readonly #policy: MutationPolicy;
  readonly #projectGraph: ProjectGraph | undefined;
  readonly #onLog: ((line: string) => void) | undefined;
  readonly #probe: boolean;
  readonly #maxProbes: number | undefined;

  constructor(options: TestGeneratorOptions) {
    this.model = options.model;
    this.#maxCases = options.maxCases ?? 6;
    this.#maxAxNodes = options.maxAxNodes ?? DEFAULT_GENERATOR_MAX_NODES;
    this.#policy = options.policy ?? DEFAULT_MUTATION_POLICY;
    this.#projectGraph = options.projectGraph;
    this.#onLog = options.onLog;
    this.#probe = options.probe ?? false;
    this.#maxProbes = options.maxProbes;
  }

  /**
   * Scan the page as it currently stands and return runnable flows plus static
   * defects. The page is not mutated — generation is pure observation.
   */
  async generate(page: Page, focus?: string): Promise<GeneratedSuite> {
    const startedMs = Date.now();
    const url = page.url();
    this.#onLog?.(`reading ${url}…`);
    const axTree = await captureAxTree(page, this.#maxAxNodes);

    // Opt-in — see `src/context/page-probe.ts`. It clicks the page's
    // disclosures, so it is a change to on-screen state even though it never
    // submits anything, and that is a decision for the caller to make.
    let interactions: string | undefined;
    if (this.#probe) {
      this.#onLog?.('opening menus and disclosures to see what they reveal…');
      const report = await probeInteractions(page, { maxProbes: this.#maxProbes });
      for (const warning of report.warnings) this.#onLog?.(`probe: ${warning}`);
      const formatted = formatProbeReport(report);
      if (formatted) {
        interactions = formatted;
        this.#onLog?.(`found ${report.probes.length} disclosure(s) with hidden controls`);
      }
    }

    const projectContext = this.#projectGraph ? toPromptContext(this.#projectGraph, { url }) : '';

    // Ask → validate → one informed re-ask, the healer's rule applied to
    // generation: the model cannot stop writing vacuous form assertions
    // unless the next ask names the ones it wrote. The better attempt wins —
    // feedback must never make the result worse.
    const baseUrl = originOf(url);
    const attempts: { cases: GeneratedCase[]; rejected: RejectedCase[]; result: GenerationResult }[] = [];
    const feedback: string[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      this.#onLog?.(
        attempt === 1
          ? `asking the generator role for test cases…`
          : `re-asking with the rejections as feedback…`,
      );
      const result = await this.model.generate({
        url,
        axTree,
        interactions,
        focus,
        maxCases: this.#maxCases,
        policy: this.#policy,
        projectContext: projectContext === '' ? undefined : projectContext,
        ...(feedback.length > 0 ? { feedback } : {}),
      });

      const cases: GeneratedCase[] = [];
      const rejected: RejectedCase[] = [];
      for (const testCase of result.cases) {
        // A case that asserts nothing passes whether or not the feature works.
        // Shipping one is worse than shipping no test, because it displaces
        // the manual check that would have caught the bug. A form case whose
        // only assertions cannot fail is the same hazard wearing a fill step.
        const reason =
          testCase.steps.length === 0
            ? 'no usable steps survived validation'
            : !hasAssertion(testCase.steps)
              ? 'no assertion — the case would pass without proving anything'
              : (vacuousFormAssertion(testCase.steps) ?? inventedUrlReason(testCase.steps, axTree));

        if (reason !== null) {
          rejected.push({ name: testCase.name, kind: testCase.kind, reason });
          continue;
        }

        cases.push({
          name: testCase.name,
          kind: testCase.kind,
          rationale: testCase.rationale,
          flow: { name: testCase.name, baseUrl, steps: testCase.steps },
        });
      }

      attempts.push({ cases, rejected, result });
      // Stop only when this attempt produced usable cases AND nothing was
      // rejected. Zero usable cases is a failed attempt, not a finished one:
      // the informed re-ask exists for exactly this, but an empty
      // `result.cases` also leaves `rejected` empty, so the old
      // `rejected.length === 0` check mistook "the model returned nothing" for
      // "the model got it right" and broke without ever re-asking.
      if (cases.length > 0 && rejected.length === 0) break;
      if (cases.length === 0 && rejected.length === 0) {
        feedback.push(
          'Your previous attempt returned NO cases. If the page exposes any usable control, form or link, ' +
            'return at least one runnable case with an assertion that would fail if that feature were broken.',
        );
      }
      feedback.push(...rejected.map((r) => `"${r.name}": ${r.reason}`));
    }

    // The better attempt wins — a re-ask must never make the result worse:
    // more usable cases first, then fewer rejected on a tie, then the earlier
    // attempt (reduce keeps `a` when neither is strictly better).
    const best = attempts.reduce((a, b) => {
      if (b.cases.length !== a.cases.length) return b.cases.length > a.cases.length ? b : a;
      return b.rejected.length < a.rejected.length ? b : a;
    });
    const { cases, rejected, result } = best;

    const defects: Defect[] = result.defects.map((defect, index) => ({
      id: `gen-${index + 1}`,
      source: 'generator',
      severity: defect.severity,
      category: defect.category,
      title: defect.title,
      detail: defect.detail,
      selector: defect.selector,
    }));

    this.#onLog?.(
      `got ${cases.length} case(s)${rejected.length > 0 ? `, ${rejected.length} rejected` : ''} and ${defects.length} defect(s)`,
    );

    return {
      sourceUrl: url,
      model: this.model.id,
      generatedAt: new Date().toISOString(),
      cases,
      rejected,
      defects,
      // Both attempts' spend, not just the winner's — the meter reports what
      // was paid, never what was kept.
      inputTokens: attempts.reduce((total, entry) => total + (entry.result.inputTokens ?? 0), 0),
      outputTokens: attempts.reduce((total, entry) => total + (entry.result.outputTokens ?? 0), 0),
      latencyMs: Date.now() - startedMs,
    };
  }
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
