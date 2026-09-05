/**
 * Control plane: Just-In-Time selector healing.
 *
 * This module is only ever entered when the execution plane has already
 * failed, so every line here is on the expensive path. It captures the
 * Accessibility (AX) tree — small and semantic, unlike raw DOM — asks a model
 * for a replacement selector, *verifies* the replacement actually resolves in
 * the live page, and only then persists it to the cache.
 */

import type { LanguageModel } from 'ai';
import type { CDPSession, Page } from 'playwright';
import { z } from 'zod';

import { CacheManager, type HealedSelectorEntry } from '../cache/cache-manager.js';
import type { RejectedHeal } from '../engine/proof-bundle.js';
import { withQualifiedRole, withRelaxedRoleName } from '../engine/selector.js';
import { DETERMINISM_RULES, procedure, selfCheck } from '../providers/prompt-discipline.js';
import { fence, sanitizeInline } from '../providers/model-fence.js';
import { formatProbeReport, probeInteractions } from '../context/page-probe.js';
import type { HealHints, HealHintsProvider } from '../context/heal-hints.js';
import { focusTreeText } from '../context/retriever.js';
import {
  LlmFactory,
  generateStructuredForModel,
  type ModelSource,
} from '../providers/llm-factory.js';

export const DEFAULT_MAX_AX_NODES = 120;
/**
 * Tree lines the heal prompt keeps after relevance ranking (see
 * `buildUserPrompt`). Half the capture cap: generous enough that the intent's
 * neighbourhood survives, small enough to matter on the token bill.
 */
export const HEAL_TREE_MAX_LINES = 60;
export const DEFAULT_MIN_CONFIDENCE = 0.5;

/** Roles worth sending even when they carry no accessible name. */
export const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
]);

/** Roles that only add noise to the tree. */
const NOISE_ROLES = new Set(['generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak']);

export const HEAL_STRATEGIES = [
  'role',
  'text',
  'label',
  'placeholder',
  'testid',
  'css',
] as const;
export type HealStrategy = (typeof HEAL_STRATEGIES)[number];

const HealSuggestionSchema = z.object({
  selector: z
    .string()
    .describe('A single Playwright selector string that resolves the intended element.'),
  strategy: z.enum(HEAL_STRATEGIES).describe('Which locator family the selector uses.'),
  confidence: z.number().describe('Confidence between 0 and 1 that this is the right element.'),
  reasoning: z.string().describe('One sentence explaining the match.'),
});

export interface HealSuggestion {
  selector: string;
  strategy: HealStrategy;
  confidence: number;
  reasoning: string;
  /** Populated by model implementations that report usage. */
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

export interface HealRequest {
  /** The selector that failed in the execution plane. */
  failedSelector: string;
  /** Author-supplied description of what the selector is meant to target. */
  intent?: string | undefined;
  /** The action being attempted (`click`, `fill`, …). */
  action: string;
  url: string;
  /** Pre-formatted, pruned accessibility tree. */
  axTree: string;
  /**
   * The test case the failed step serves — claim, expected output, persona —
   * stamped on the flow at authoring (`Flow.caseContext`). Context for
   * matching intent against the tree, never a licence to change the claim.
   */
  caseContext?: string | undefined;
  /** Controls revealed by opening disclosures (menus, dialogs). */
  interactions?: string | undefined;
  /**
   * Why the original selector failed, verbatim from the execution plane —
   * e.g. a Playwright timeout ("not found") vs a strict-mode violation
   * ("resolved to 126 elements"). Those are different problems with
   * different right answers; without this the model can't tell them apart.
   */
  failureReason?: string | undefined;
  /**
   * Candidates already proposed and found wanting.
   *
   * Without this a weak model has no way to know it is repeating itself, and
   * the commonest failure is the flattest one: it returns *the selector that
   * just failed*. Seen live on a page whose "Create Leave Request" button does
   * not exist — the model echoed `role=button[name="Create Leave Request" i]`
   * straight back, the healer verified it, and the step spent a model call and
   * a five-second timeout to arrive exactly where it started.
   */
  rejected?: readonly string[] | undefined;
  /**
   * The value the step is trying to put in, for `fill`/`type`/`selectOption`
   * (EH-13, 2026-09-03). Without it the model proposed a static text that
   * merely mentioned the value; with it the prompt says the replacement must
   * be the control that TAKES the value. Absent for every other action, so
   * prompts for those are byte-identical to what they were.
   */
  entry?: string | undefined;
}

/** Pluggable model backend, so tests can inject a deterministic stub. */
export interface HealerModel {
  readonly id: string;
  suggest(request: HealRequest): Promise<HealSuggestion>;
}

/**
 * Selector syntax rules, shared by every prompt that asks a model for a
 * Playwright selector.
 *
 * The `role=` prefix warning is not padding. Live models drop it and emit
 * `button[name="Sign in"]`, which Playwright reads as *CSS* — a `<button>`
 * with an HTML `name` attribute — and which silently matches nothing on a
 * normal page. It is the single most common failure mode observed here.
 */
export const SELECTOR_SYNTAX_RULES = `Selector syntax (Playwright \`page.locator()\`):

Prefer, in order:
1. role=ROLE[name="ACCESSIBLE NAME"]   e.g. role=button[name="Sign in"]
2. text=EXACT VISIBLE TEXT             e.g. text=Sign in
3. [placeholder="..."] or [aria-label="..."]
4. [data-testid="..."]
5. A minimal CSS selector

CRITICAL — the \`role=\` prefix is mandatory when using a role and name:
  CORRECT:   role=button[name="Sign in"]
  WRONG:     button[name="Sign in"]      <- this is CSS; it looks for an HTML
                                            name attribute and matches nothing
  WRONG:     role=button[name=Sign in]   <- the name must be quoted
  WRONG:     getByRole('button', ...)    <- this is API syntax, not a selector

CRITICAL — to pick one of several identical matches (e.g. a repeated per-row
button in a table), append \` >> nth=N\` (zero-based) to the selector string.
Never append a Locator *method call* like \`.first()\`/\`.nth()\`/\`.last()\` — those
are JavaScript API methods, not selector syntax, and \`page.locator()\` will
reject them outright:
  CORRECT:   role=button[name="Edit"] >> nth=0
  WRONG:     role=button[name="Edit"].first()   <- not a real selector, never
                                                    resolves

CANONICAL FORM — one way to write each thing, so the same tree yields the same
selector every time:
- A control with a role and a name in the tree is ALWAYS written as
  role=ROLE[name="NAME"], the name copied verbatim from the tree.
- The same role and name repeated: append \` >> nth=N\`, counting the matches in
  tree order from 0.
- A textbox the tree shows with NO name: input[type="password"] when it is
  the password field of a sign-in form (the one nameless textbox beside an
  identity field or under a "Password" label), otherwise role=textbox >> nth=N,
  N counted among the tree's textboxes in order.
- Never a bare tag or attribute selector for something the tree names — never
  button, input, [type="submit"], or a class or id the tree does not show.
- text=… only for static text that has no role of its own; quoted
  (text="exact") for a literal token, unquoted for a phrase.

Rules:
- Return exactly one selector string. No code fences, no explanation inside it.
- Use only roles, names, and attributes that appear in the accessibility tree
  provided. Never invent an id, class, or test id.
- The selector must identify one element, not a group.`;

const SYSTEM_PROMPT = `You repair broken selectors for a Playwright test runner.

You receive the accessibility (AX) tree of a live page and one selector that failed to resolve. Return the single best replacement selector for the element the author intended.

${SELECTOR_SYNTAX_RULES}

You are repairing a *selector*, not choosing a *new action*. The replacement must
be the same control the author meant, doing the same thing. A different control
that happens to be prominent is a wrong answer, not a fallback.

If the failure reason says the selector matched more than one element ("strict
mode violation") rather than none, the original selector was probably fine — it
found the right kind of control, there's just more than one of it (e.g. a
per-row button repeated down a table). The original selector text often still
appears verbatim in the tree that many times. Don't invent a different selector
for this case; narrow the existing one with \` >> nth=N\` (see selector syntax
above). Picking \`nth=0\` for an author intent that doesn't name a specific row,
record, or item is a reasonable, low-risk choice — say so in your reasoning.
Only drop to low confidence here when the intent clearly needs a *specific* one
of the matches (a named row, a particular record) and nothing in the tree or
the intent tells you which.

Return a confidence below 0.3, and say so in your reasoning, whenever:
- nothing in the tree performs the action the author described;
- the closest candidate does something materially different (submitting instead
  of paginating, navigating away instead of filtering);
- the tree looks like a different page than the author expected — a login form,
  an error page, an empty state, a consent screen;
- the selector matched several elements and the author's intent needs one
  specific one of them, but nothing available says which.

That last case is the important one. If the page has changed underneath the
test, the problem is navigation or authentication, not the selector, and no
selector can fix it. Reporting low confidence lets the run fail honestly.
Never substitute the page's "primary action" for a control that is absent.

The failed selector's role and name are the AUTHOR'S GUESS at the control, not a
description of it. They are often written from a different page, an older build,
or a written spec — so the element you are looking for may well have a different
role and a different name from the one that failed. Match the author's *intent*
against what the tree actually contains: an intent of "the Create Order
button" is served by a link named "Orders New order" when that is what this
page offers to do the job.

Returning the selector that just failed is never an answer. If nothing in the
tree can serve the intent, say so with a low confidence rather than repeating
it.

Two idioms this application family uses, and how they appear in the tree:
- A custom select is a \`button "<Label>" value="<chosen>"\` (it has a popup;
  the value is what it currently shows). For an action that CHOOSES a value,
  propose that BUTTON. Its options are not in the tree while it is closed and
  must never be proposed; a \`role=option\` selector cannot be repaired here.
- A read-only textbox named by its placeholder (\`textbox "Select date" readonly\`)
  is a display shell over the real input. Propose the editable
  \`textbox "<Field label>"\` beside it, never the shell.
- A required field is marked \`required\` in the tree — an asterisk on the page.

${DETERMINISM_RULES}

${procedure('HOW TO CHOOSE THE REPLACEMENT', [
  'Read the author intent (and the failed selector\'s role and name as a hint to it). Decide what the control DOES: submits, opens, filters, navigates, asserts text.',
  'If the failure was a strict-mode violation (several matches), keep the failed selector and append " >> nth=N"; pick N from the intent, else nth=0 and say so.',
  'Otherwise, look in the tree for a control with the SAME role and a name that means the same thing (case, spacing, punctuation and a translation may differ). If exactly one exists, that is the answer, in canonical form.',
  'If none, look for a control with a DIFFERENT role that does the same job (a link where the author guessed a button). If exactly one, that is the answer; say the role changed.',
  'If several candidates remain equally plausible and the intent does not distinguish them, take the FIRST in tree order and say so — never a different one on a different run.',
  'If nothing serves the intent, or the tree is a different page (sign-in, error, consent, empty state), answer with confidence below 0.3 and say which.',
])}

${selfCheck([
  'The selector is in canonical form and every token of it appears in the tree.',
  'It is not the failed selector, and not one listed as already rejected.',
  'It identifies ONE element (or a group, only for a counting step).',
  'The control it names does what the author intent says — not the page\'s primary action, not a neighbour.',
  'The confidence is between 0 and 1, and is below 0.3 whenever step 6 applied.',
])}`;

/**
 * How many times to ask for a repair before giving up.
 *
 * One was the original, and one is too few for the failure that actually
 * happens: the model returns something unusable — most often the failed
 * selector verbatim — and the step dies with a repair budget that was never
 * really spent. Each pass costs a model call, so this stays small; the value
 * is entirely in the *second* ask, which is the first one that knows what did
 * not work.
 */
const HEAL_ATTEMPTS = 3;

/**
 * The healer could not repair the selector, and here is everything it tried.
 *
 * `rejectedHeals` is the point of the class existing: a refused candidate is
 * what the model *saw on the page* — frequently the diagnosis itself (the
 * proposal for PB-02-01's final step was the page's "Access Denied" heading)
 * — and throwing it away as a message substring is how that run's report came
 * to blame selectors for an authorization failure.
 */
export class HealFailedError extends Error {
  readonly rejectedHeals: RejectedHeal[];

  constructor(message: string, rejectedHeals: RejectedHeal[]) {
    super(message);
    this.name = 'HealFailedError';
    this.rejectedHeals = rejectedHeals;
  }
}

/**
 * The healer never got an answer — the provider failed, not the page.
 *
 * Its own type because the two must never be confused downstream: "the model
 * could not be asked" says nothing about whether the control exists, and
 * recording it as a resolution failure blames the application for an outage.
 * (PB-02-01's first heal died on "No object generated" and the step read as
 * "the control is absent".)
 */
export class HealUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'HealUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** Actions that put a value into a control — the ones `HealRequest.entry` speaks for. */
const ENTRY_ACTIONS: ReadonlySet<string> = new Set(['fill', 'type', 'selectOption', 'fillRetry', 'paste']);

/**
 * Actions whose target need not be visible for the repair to be right: a
 * count may include hidden items, and an absence claim is about hidden-ness
 * itself. Every other action acts on or reads a visible element, so a heal
 * that resolves only hidden ones (a portal option of a closed list, a control
 * in a collapsed section) is not a repair — the runner's re-run at the
 * healed timeout then fails and deletes the entry, 5 s verify + 10 s run
 * wasted (EH-13, 2026-09-03).
 */
const HIDDEN_OK_ACTIONS: ReadonlySet<string> = new Set(['expectCount', 'saveCount', 'expectHidden', 'expectAttribute']);

/**
 * Actions that act on the element and so need Playwright's own visibility
 * (a non-empty box, nothing hiding it). A presence or read step is held to
 * the weaker "rendered" bar: an EMPTY container proposed for an `expectText`
 * that is still waiting on its XHR is a legitimate repair (tests/api.test.ts
 * "still heals normally when the failing request is an ordinary 4xx"), while
 * a `display: none` one — a closed list's option, a collapsed section's
 * control — is not.
 */
const ACTING_ACTIONS: ReadonlySet<string> = new Set([
  'click', 'fill', 'type', 'paste', 'selectOption', 'check', 'uncheck', 'press', 'scrollTo', 'fillRetry', 'upload',
]);

/** Whether two selectors are the same repair, ignoring case-flag and spacing noise. */
function sameSelector(a: string, b: string): boolean {
  const normal = (value: string) =>
    value.trim().replace(/\s+i\]/g, ']').replace(/\s+/g, ' ').toLowerCase();
  return normal(a) === normal(b);
}

export function buildUserPrompt(request: HealRequest, hints?: HealHints): string {
  // FENCED at assembly, never at the source: the tree, the repository hints
  // and the background slices are all third-party text, and the one thing a
  // repair must not do is propose a selector out of a rewritten tree. Only
  // the prompt string is sanitised — `focusTreeText` below, `selectorGrounded`
  // and the cache all keep reading the tree as the page wrote it. The failed
  // selector and the action are the harness's own and go in as they are.
  const lines = [
    `Page URL: ${sanitizeInline(request.url)}`,
    `Attempted action: ${request.action}`,
    `Failed selector: ${request.failedSelector}`,
  ];
  if (request.failureReason) lines.push(`Why it failed: ${sanitizeInline(request.failureReason)}`);
  if (request.intent) lines.push(`Author intent: ${sanitizeInline(request.intent)}`);
  if (request.caseContext) {
    // A block, not a folded line: this is the same `Flow.caseContext` card the
    // agent is shown, it runs to many lines, and an inline bound would cut a
    // long one silently. Same source label as the agent gives it, so the
    // fencing is one thing across the roles rather than per-prompt taste.
    lines.push(
      'The test case this step serves (context, not the thing to repair):',
      fence('catalog', request.caseContext),
    );
  }
  // Advisory context, before the tree so every re-ask of this heal keeps a
  // byte-identical prefix (`rejected` alone grows between attempts). Framing
  // only: the tree below is the page, and a candidate must come from it.
  if (hints?.repoHints) {
    lines.push(
      '',
      'What the repository declares about this page (advisory — the accessibility tree below is the page as it stands, and your candidate must come from it):',
      fence('repository', hints.repoHints),
    );
  }
  if (hints?.background) {
    lines.push(
      '',
      'Background documents matching this step (context for intent, never candidate material):',
      fence('repository', hints.background),
    );
  }
  if (request.action === 'expectCount') {
    lines.push(
      'This is a COUNTING step: the replacement must match ALL the items being ' +
        'counted — a group, not one element. The "identify one element" rule does ' +
        'not apply here. Propose the selector for the repeated items themselves ' +
        '(e.g. the buttons inside the group container the tree shows).',
    );
  }
  if (request.entry !== undefined && ENTRY_ACTIONS.has(request.action)) {
    lines.push(
      `This step ENTERS a value (${JSON.stringify(request.entry)}): the replacement must be ` +
        'the control that takes it — a textbox, a select button, a combobox — never a static text.',
    );
  }
  // The tree ranked against what the step was trying to do, not just capped
  // in capture order. The blind cap kept the first `DEFAULT_MAX_AX_NODES`
  // interactive nodes; on a dense page that spends most of the healer's
  // ~3.2k-token bill (measured, be100) on controls the intent never named,
  // while the answer can sit past the cut. Deterministic (BM25, ties in
  // document order), so every re-ask still shares a byte-identical prefix.
  const focusQuery = [request.failedSelector, request.intent ?? '', request.caseContext ?? '']
    .join(' ')
    .trim();
  const tree =
    focusQuery === ''
      ? request.axTree
      : focusTreeText(request.axTree, focusQuery, HEAL_TREE_MAX_LINES).text;
  lines.push('', 'Accessibility tree:', fence('page', tree));
  if (request.interactions) {
    lines.push('', 'Controls revealed by opening disclosures on page:', fence('page', request.interactions));
  }
  // The rejected list is the only part that grows between attempts; keeping it
  // after the tree leaves attempts 1-3 sharing a byte-identical prefix, which a
  // provider's implicit prompt cache bills at cache rates.
  if (request.rejected?.length) {
    lines.push(
      '',
      'Already tried and rejected — do NOT propose any of these again:',
      ...request.rejected.map((entry) => `  - ${sanitizeInline(entry)}`),
    );
  }
  return lines.join('\n');
}

export interface LlmHealerModelOptions {
  /** A concrete AI SDK model. Omit to resolve the `healer` role from config. */
  model?: LanguageModel | undefined;
  /** Label recorded in the cache and report, e.g. `groq:llama-3.3-70b-versatile`. */
  id?: string | undefined;
  maxOutputTokens?: number | undefined;
  maxRetries?: number | undefined;
  factory?: LlmFactory | undefined;
  /**
   * BM25-retrieved advisory context per repair — repository declarations for
   * the failing page and background-document slices (`healHintsFrom`).
   * Consulted synchronously per heal; absent, the prompt is what it was.
   */
  hints?: HealHintsProvider | undefined;
}

/**
 * Default backend: one structured-output call per repair, through whichever
 * provider the `healer` role points at.
 *
 * Repair is small, well-scoped, and latency-sensitive — the answer is already
 * in the AX tree, so the job is extraction, not reasoning. That makes it the
 * right fit for the fastest free tier rather than the smartest one.
 */
export class LlmHealerModel implements HealerModel {
  readonly id: string;

  readonly #source: ModelSource;
  readonly #maxOutputTokens: number;
  readonly #maxRetries: number;
  readonly #hints: HealHintsProvider | undefined;

  constructor(options: LlmHealerModelOptions = {}) {
    this.#hints = options.hints;
    if (options.model) {
      this.#source = { model: options.model };
      this.id = options.id ?? 'custom:healer';
      this.#maxRetries = options.maxRetries ?? 2;
    } else {
      const factory = options.factory ?? new LlmFactory();
      this.#source = { factory, role: 'healer' };
      this.id = options.id ?? factory.forRole('healer').id;
      this.#maxRetries = options.maxRetries ?? factory.maxRetries;
    }
    this.#maxOutputTokens = options.maxOutputTokens ?? 1024;
  }

  async suggest(request: HealRequest): Promise<HealSuggestion> {
    const hints = this.#hints?.({
      url: request.url,
      selector: request.failedSelector,
      intent: request.intent,
      caseContext: request.caseContext,
    });
    const { object, inputTokens, outputTokens } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      schema: HealSuggestionSchema,
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(request, hints),
      maxOutputTokens: this.#maxOutputTokens,
      maxRetries: this.#maxRetries,
    });

    return {
      selector: object.selector,
      strategy: object.strategy,
      // Smaller models routinely return 0–100 or >1 here; clamp rather than trust.
      confidence: Math.min(1, Math.max(0, object.confidence)),
      reasoning: object.reasoning,
      inputTokens,
      outputTokens,
    };
  }
}

// --- Accessibility tree capture -------------------------------------------

interface CdpAxValue {
  value?: unknown;
}

interface CdpAxProperty {
  name: string;
  value?: CdpAxValue;
}

interface CdpAxNode {
  nodeId: string;
  ignored?: boolean;
  role?: CdpAxValue;
  name?: CdpAxValue;
  description?: CdpAxValue;
  value?: CdpAxValue;
  properties?: CdpAxProperty[];
  /** The DOM node behind this AX node — what `DOM.resolveNode` takes. */
  backendDOMNodeId?: number;
}

interface CdpAxTreeResponse {
  nodes: CdpAxNode[];
}

function asText(value: CdpAxValue | undefined): string {
  return typeof value?.value === 'string' ? value.value.replace(/\s+/g, ' ').trim() : '';
}

function propertyFlag(node: CdpAxNode, name: string): boolean {
  return node.properties?.some((p) => p.name === name && p.value?.value === true) ?? false;
}

function propertyText(node: CdpAxNode, name: string): string {
  const property = node.properties?.find((p) => p.name === name);
  return typeof property?.value?.value === 'string' ? property.value.value : '';
}

/**
 * Pull the AX tree over CDP and flatten it into a compact, token-cheap listing.
 *
 * Uses CDP directly rather than Playwright's deprecated `page.accessibility`
 * snapshot, and prunes aggressively: ignored nodes, structural noise, and
 * unnamed non-interactive nodes never reach the model.
 */
export async function captureAxTree(page: Page, maxNodes = DEFAULT_MAX_AX_NODES): Promise<string> {
  const { nodes, truncated, total } = await captureAxTreeDetailed(page, maxNodes);
  if (nodes.length === 0) return '(no accessible elements found)';

  const body = nodes.map(formatAxNode).join('\n');
  if (!truncated) return body;

  // Absence of evidence is not evidence of absence. Without this notice a
  // model will confidently report "this page has no X" when X was simply
  // past the node budget — observed producing a false accessibility defect
  // on a table whose row buttons had been truncated away.
  return (
    `${body}\n` +
    `[TREE TRUNCATED: showing ${nodes.length} of ${total} nodes. Elements may exist ` +
    `that are not listed. Do NOT conclude anything is missing or absent from this tree.]`
  );
}

export interface AxCapture {
  nodes: AxNode[];
  /** True when the node budget cut the tree short. */
  truncated: boolean;
  /** Nodes that survived pruning, before the budget was applied. */
  total: number;
}

/**
 * Capture with truncation metadata.
 *
 * When the budget bites, interactive controls are kept in preference to
 * `StaticText`: a real page is mostly text, and spending the budget on prose
 * while dropping the buttons is exactly backwards for both healing and
 * coverage.
 */
async function captureAxTreeDetailed(
  page: Page,
  maxNodes = DEFAULT_MAX_AX_NODES,
): Promise<AxCapture> {
  const all = await captureAxNodes(page, Number.MAX_SAFE_INTEGER);
  if (all.length <= maxNodes) return { nodes: all, truncated: false, total: all.length };

  const interactive = all.filter((n) => INTERACTIVE_ROLES.has(n.role));
  const rest = all.filter((n) => !INTERACTIVE_ROLES.has(n.role));
  const kept = [...interactive.slice(0, maxNodes), ...rest].slice(0, maxNodes);

  // Restore document order so the tree still reads like the page.
  const order = new Map(all.map((n, i) => [n, i]));
  kept.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

  return { nodes: kept, truncated: true, total: all.length };
}

/** One pruned accessibility node. */
export interface AxNode {
  role: string;
  name: string;
  value: string;
  description: string;
  disabled: boolean;
  checked: boolean;
  /**
   * A field the user cannot type into. Surfaced (2026-09-02) because the
   * commonest date-picker idiom is a read-only display named by its
   * placeholder drawn over the real `type="date"` input the label points at —
   * four `textbox "Select date"` lines on one form, and nothing told the
   * generator or the agent which of them could take a value. Optional so
   * hand-built nodes and older captures keep their shape.
   */
  readonly?: boolean | undefined;
  /**
   * The control must be filled before the form submits — CDP's `required`
   * property (`aria-required` or the attribute). Surfaced (OA-6, 2026-09-03)
   * because ~300 rows say "กรอกข้อมูล Mandatory อื่นให้ครบถ้วน" and delegate
   * the required set to the tester's eyes; without it the agent could not
   * tell an asterisked field from an optional one. Optional so hand-built
   * nodes and older captures keep their shape.
   */
  required?: boolean | undefined;
  /**
   * Where a link points, when Chrome reports one.
   *
   * Captured because it is the difference between a generated navigation
   * assertion being evidence and being a guess: a model that can only see the
   * label "E-Patient" writes `expectUrl "e-patient"`, and the route is
   * `/benefits-hub/referral`. The URL was sitting in the tree the whole time.
   */
  url: string;
}

/**
 * Structured form of the pruned AX tree.
 *
 * The healer wants this flattened into text; coverage measurement wants the
 * nodes themselves. Both read the same pruning rules, so what the model sees
 * and what coverage counts can never drift apart.
 */
export async function captureAxNodes(
  page: Page,
  maxNodes = DEFAULT_MAX_AX_NODES,
): Promise<AxNode[]> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Accessibility.enable');
    const tree = (await session.send('Accessibility.getFullAXTree')) as unknown as CdpAxTreeResponse;

    const nodes: AxNode[] = [];
    let popupReads = 0;
    for (const node of tree.nodes ?? []) {
      if (nodes.length >= maxNodes) break;
      if (node.ignored) continue;

      const role = asText(node.role);
      if (!role || NOISE_ROLES.has(role)) continue;

      const name = asText(node.name);
      if (!name && !INTERACTIVE_ROLES.has(role)) continue;

      let value = asText(node.value);
      // **A popup button's visible text is its value.** A hand-rolled select
      // (`button[aria-haspopup=listbox]` named by its label, showing the
      // chosen option as its text) reaches the tree as `button "Gender"` and
      // nothing more: the label is the name, and a button has no value. So
      // the agent could not see what was selected, and the goal-evidence check
      // refused a finish the page had earned — Gender WAS "Female" (ec10
      // HIR-EC-002, 2026-09-02, both legs). One DOM read per such button,
      // bounded, so the tree reads `button "Gender" value="Female"`.
      if (
        value === '' &&
        role === 'button' &&
        node.backendDOMNodeId !== undefined &&
        popupReads < MAX_POPUP_VALUE_READS &&
        propertyText(node, 'hasPopup') !== '' &&
        propertyText(node, 'hasPopup') !== 'false'
      ) {
        popupReads += 1;
        value = await popupButtonText(session, node.backendDOMNodeId);
      }

      nodes.push({
        role,
        name,
        value,
        description: asText(node.description),
        disabled: propertyFlag(node, 'disabled'),
        checked: propertyFlag(node, 'checked'),
        ...(propertyFlag(node, 'readonly') ? { readonly: true } : {}),
        ...(propertyFlag(node, 'required') ? { required: true } : {}),
        url: propertyText(node, 'url'),
      });
    }

    return nodes;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/** How many popup buttons one capture will read the DOM for — a bound on CDP round trips, not a feature. */
const MAX_POPUP_VALUE_READS = 60;

/**
 * The visible text of the DOM node behind an AX node, trimmed of the caret
 * glyph a select draws after its value. Empty when the read fails for any
 * reason: a value the tree cannot show is what it showed before.
 */
async function popupButtonText(session: CDPSession, backendNodeId: number): Promise<string> {
  try {
    const { object } = (await session.send('DOM.resolveNode', { backendNodeId })) as unknown as {
      object: { objectId?: string };
    };
    if (object.objectId === undefined) return '';
    const { result } = (await session.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration:
        'function () { return String(this.innerText || this.textContent || "").replace(/[\\u25BE\\u25BC\\u2304\\u02C5]/g, " ").replace(/\\s+/g, " ").trim().slice(0, 120); }',
      returnByValue: true,
    })) as unknown as { result: { value?: unknown } };
    await session.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => undefined);
    return typeof result.value === 'string' ? result.value : '';
  } catch {
    return '';
  }
}

export function formatAxNode(node: AxNode): string {
  const parts = [node.role];
  if (node.name) parts.push(JSON.stringify(node.name));
  if (node.value) parts.push(`value=${JSON.stringify(node.value)}`);
  // Only for things that navigate — on any other node it is noise, and the
  // tree's token budget is the healer's cost per repair.
  if (node.url) parts.push(`url=${JSON.stringify(node.url)}`);
  if (node.description && node.description !== node.name) {
    parts.push(`desc=${JSON.stringify(node.description)}`);
  }
  if (node.disabled) parts.push('disabled');
  if (node.checked) parts.push('checked');
  // Printed so a reader of the tree — model or lint — can tell the shell from
  // the input: `textbox "Select date" readonly` beside `textbox "Hire Date"`.
  if (node.readonly) parts.push('readonly');
  // An asterisked field, as the tree can say it — what a "fill every
  // mandatory field" goal works down.
  if (node.required) parts.push('required');
  return parts.join(' ');
}

// --- Healer ----------------------------------------------------------------

export interface JitHealerOptions {
  model: HealerModel;
  cache: CacheManager;
  /** Nodes sent to the model. Lower = cheaper, higher = more context. */
  maxAxNodes?: number | undefined;
  /** Suggestions below this confidence are rejected outright. */
  minConfidence?: number | undefined;
  /** How long to wait when verifying a candidate selector, in ms. */
  verifyTimeoutMs?: number | undefined;
}

export interface HealOutcome {
  selector: string;
  suggestion: HealSuggestion;
  entry: HealedSelectorEntry;
  /** Wall-clock time of the whole repair, including AX capture and verification. */
  latencyMs: number;
}

export interface HealInput {
  page: Page;
  action: string;
  selector: string;
  intent?: string | undefined;
  /** Why the fast/cache attempts failed, passed straight through to `HealRequest`. */
  failureReason?: string | undefined;
  /** The test case the step serves, passed straight through to `HealRequest`. */
  caseContext?: string | undefined;
  /** The value an entry step is putting in, passed straight through to `HealRequest.entry`. */
  entry?: string | undefined;
}

export class JitHealer {
  readonly model: HealerModel;

  readonly #cache: CacheManager;
  readonly #maxAxNodes: number;
  readonly #minConfidence: number;
  readonly #verifyTimeoutMs: number;

  constructor(options: JitHealerOptions) {
    this.model = options.model;
    this.#cache = options.cache;
    this.#maxAxNodes = options.maxAxNodes ?? DEFAULT_MAX_AX_NODES;
    this.#minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    this.#verifyTimeoutMs = options.verifyTimeoutMs ?? 5_000;
  }

  /**
   * Repair one selector. Throws if the model declines, returns low confidence,
   * or proposes something that doesn't resolve — callers should surface the
   * original failure alongside this one.
   */
  async heal(input: HealInput): Promise<HealOutcome> {
    const startedMs = Date.now();
    const url = input.page.url();
    const axTree = await captureAxTree(input.page, this.#maxAxNodes);

    // Probe disclosures once upfront. Many navigation controls — sidebars,
    // dropdown menus, "more" buttons — are only in the AX tree after their
    // trigger is clicked. The model cannot pick a selector for something it
    // cannot see. Failures are swallowed (a probe must never abort a repair).
    let interactions: string | undefined;
    try {
      const report = await probeInteractions(input.page);
      const formatted = formatProbeReport(report);
      if (formatted) interactions = formatted;
    } catch {
      // Safe to ignore — disclosure probing is a best-effort enrichment.
    }

    // A rejected candidate is evidence, and re-asking without it is how a weak
    // model spends three calls proposing the same thing. Each pass is told
    // exactly what was tried and why it did not work — and every rejection is
    // also kept as data (`rejectedHeals`), because a refused proposal is what
    // the model saw on the page, which is frequently the diagnosis itself.
    const rejected: string[] = [];
    const rejectedHeals: RejectedHeal[] = [];
    const refuse = (
      suggestion: HealSuggestion,
      proposed: string,
      because: string,
    ): void => {
      rejected.push(`${proposed} — ${because}`);
      rejectedHeals.push({
        proposed,
        confidence: suggestion.confidence,
        reasoning: suggestion.reasoning,
        rejectedBecause: because,
      });
    };

    let suggestion!: Awaited<ReturnType<HealerModel['suggest']>>;
    let candidate = '';
    for (let attempt = 1; attempt <= HEAL_ATTEMPTS; attempt++) {
      try {
        suggestion = await this.model.suggest({
          failedSelector: input.selector,
          intent: input.intent,
          action: input.action,
          url,
          axTree,
          caseContext: input.caseContext,
          interactions,
          failureReason: input.failureReason,
          rejected,
          ...(input.entry === undefined ? {} : { entry: input.entry }),
        });
      } catch (error) {
        // The model never answered — a provider fact, not a page fact. Typed
        // apart so no consumer can read "the machinery failed" as "the
        // control is absent". Key rotation already happened inside the
        // factory if the failure looked like the key; whatever escapes here
        // is not worth a second identical ask.
        throw new HealUnavailableError(
          `healer unavailable: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
          error,
        );
      }

      // The model copies names out of the tree we just handed it, and those
      // names carry CSS `text-transform` that Playwright's matcher does not
      // apply — so a candidate can be exactly right and still resolve to
      // nothing. Relax case before verifying, or the healer spends a call and
      // then rejects its own correct answer. See `src/engine/selector.ts`.
      // Qualify first, then relax: relaxing only recognises `[name=…]` on a
      // role selector, so a bare `button[name="Save"]` has to become one first.
      candidate = withRelaxedRoleName(withQualifiedRole(suggestion.selector));

      // **The echo.** Proposing the selector that just failed is the single
      // commonest thing a weak model does here, and it is not a repair — it is
      // the same step again, for a model call and a verification timeout. Cut
      // it before either is spent, and tell the next pass. Checked BEFORE the
      // confidence gate on purpose: an echo scored on confidence reports
      // "confidence too low" and hides that the model had nothing new to say
      // — which is the actual finding. (Seen in PB-02-01, where echoes
      // differing only by the case flag were reported as low confidence.)
      if (sameSelector(candidate, input.selector)) {
        refuse(suggestion, candidate, 'this is the selector that already failed');
        if (attempt === HEAL_ATTEMPTS) {
          throw new HealFailedError(
            `healer proposed the selector that had already failed ("${input.selector}") ` +
              `on every one of ${HEAL_ATTEMPTS} attempt(s) — nothing on this page serves ` +
              `the author's intent`,
            rejectedHeals,
          );
        }
        continue;
      }

      if (suggestion.confidence < this.#minConfidence) {
        // An honest decline, not a retry candidate: the prompt tells the
        // model to answer with low confidence when nothing in the tree serves
        // the intent, and re-asking would only pressure it to be less honest.
        refuse(
          suggestion,
          candidate,
          `confidence ${suggestion.confidence.toFixed(2)} below threshold ${this.#minConfidence}`,
        );
        throw new HealFailedError(
          `healer confidence ${suggestion.confidence.toFixed(2)} below threshold ` +
            `${this.#minConfidence} for "${input.selector}" (proposed "${suggestion.selector}")`,
          rejectedHeals,
        );
      }

      try {
        await this.#verify(
          input.page,
          candidate,
          input.action === 'expectCount',
          HIDDEN_OK_ACTIONS.has(input.action) ? 'attached' : ACTING_ACTIONS.has(input.action) ? 'visible' : 'rendered',
        );
        break;
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        refuse(suggestion, candidate, why);
        if (attempt === HEAL_ATTEMPTS) {
          throw new HealFailedError(why, rejectedHeals);
        }
      }
    }

    const entry = this.#cache.set({
      key: CacheManager.key(url, input.selector),
      original: input.selector,
      healed: candidate,
      strategy: suggestion.strategy,
      url: url,
      confidence: suggestion.confidence,
      reasoning: suggestion.reasoning,
      model: this.model.id,
    });

    return { selector: candidate, suggestion, entry, latencyMs: Date.now() - startedMs };
  }

  /**
   * A repair is only worth caching if it resolves to exactly one element —
   * except for a counting step, where matching several is the entire point:
   * `expectCount role=radio, 4` repaired onto the four toggle buttons the
   * page actually renders MUST match four, and rejecting that as ambiguous
   * made healing a count selector structurally impossible (PB-02-01's radio
   * count could never be repaired, whatever the model proposed).
   */
  async #verify(
    page: Page,
    selector: string,
    countable: boolean,
    need: 'attached' | 'rendered' | 'visible' = 'visible',
  ): Promise<void> {
    let count: number;
    try {
      await page.locator(selector).first().waitFor({
        state: 'attached',
        timeout: this.#verifyTimeoutMs,
      });
      count = await page.locator(selector).count();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`healed selector "${selector}" did not resolve: ${detail}`);
    }

    if (count > 1 && !countable) {
      throw new Error(`healed selector "${selector}" is ambiguous — matched ${count} elements`);
    }
    // Attached is not enough for a step that clicks, fills or reads: a
    // hidden-only match passes here and fails the re-run at the healed
    // timeout. Say so now, so the re-ask knows the candidate is off-screen.
    if (need === 'attached') return;
    let shown = 0;
    if (need === 'visible') {
      shown = await page.locator(selector).filter({ visible: true }).count().catch(() => 0);
    } else {
      // Rendered: not under `display: none` / `visibility: hidden` / `hidden`,
      // an empty box allowed. `checkVisibility` is exactly that question.
      const flags = await page
        .locator(selector)
        .evaluateAll((els) =>
          (els as unknown as { checkVisibility?: (o: { visibilityProperty: boolean }) => boolean; getClientRects(): ArrayLike<unknown> }[]).map(
            (el) => (typeof el.checkVisibility === 'function' ? el.checkVisibility({ visibilityProperty: true }) : el.getClientRects().length > 0),
          ),
        )
        .catch(() => [] as boolean[]);
      shown = flags.filter(Boolean).length;
    }
    if (shown === 0) {
      throw new Error(
        `healed selector "${selector}" matched ${count} element(s), none visible — a hidden control cannot serve this step`,
      );
    }
  }
}
