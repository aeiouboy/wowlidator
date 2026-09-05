/**
 * Action authority — what may change the application, and on whose word.
 *
 * Phase B of docs/research/commerce-agents-patterns.md (2026-09-05). The loop
 * already refused an unscoped destructive click and an off-origin goto; what
 * it did not have was **observed provenance** (an identifier in the goal is
 * not proof that this session ever saw the row, or still sees it) and a
 * **host-supplied mutation policy** (which categories a batch may perform,
 * and which irreversible ones need an approval the goal text cannot
 * manufacture). Both live here, pure, so they are tested without a browser.
 *
 * Three rules, applied in this order by `gateMutation` before ANY browser
 * mutation of a governed category:
 *  1. capability — the policy's `deny` list wins; an `allow` list, when
 *     present, is exhaustive;
 *  2. provenance — for an irreversible category, every identifier the
 *     selector scopes to must have been observed in this session AND be in
 *     the latest snapshot the harness captured (`TargetProvenance`, fed only
 *     from accessibility captures — never from goal text, model output or the
 *     selector itself);
 *  3. approval — an irreversible action needs a pre-approved manifest entry
 *     (`policy.approved`) or the host's explicit `approve` hook to say yes.
 *
 * With no policy configured, capability is unrestricted but approval is not:
 * an irreversible action still needs the host's explicit approval hook. Goal
 * text and model output can never manufacture approval.
 */

import type {
  BlockedOutcome,
  MutationCategory,
  ProvenanceFacts,
} from '../engine/proof-bundle.js';
import type { AxNode } from '../healer/jit-healer.js';
import { DESTRUCTIVE_NAME, goalIdentifiers, selectorCarries, targetName, type DecisionLike } from './agent-guards.js';
import { z } from 'zod';

export const MUTATION_CATEGORIES = ['submit', 'delete', 'approve'] as const satisfies readonly MutationCategory[];

/** The categories that cannot be undone on an authoritative database — the ones provenance and approval gate. */
export const IRREVERSIBLE_CATEGORIES: ReadonlySet<MutationCategory> = new Set(['delete', 'approve']);

/** A manifest entry: "this category may run, on this target (or any)". */
export interface ApprovedMutation {
  readonly category: MutationCategory;
  /** The identifier the approval is for; `*` or absent means any target in the category. */
  readonly target?: string | undefined;
}

/**
 * The host's manifest for a run. Serialisable on purpose: a SIT batch supplies
 * it once (`WOWLIDATOR_MUTATION_POLICY`, a panel form, an MCP argument) and
 * never sees a modal per case.
 */
export interface MutationPolicy {
  /** When present, the ONLY categories that may run. */
  readonly allow?: readonly MutationCategory[] | undefined;
  /** Categories that never run. Wins over `allow`. */
  readonly deny?: readonly MutationCategory[] | undefined;
  /** Pre-approved irreversible actions. */
  readonly approved?: readonly ApprovedMutation[] | undefined;
  /** Where the policy came from, for the record (`env`, `cli`, `panel`, …). */
  readonly source?: string | undefined;
}

/** What the gate asks a host to approve, when a policy names no manifest entry for it. */
export interface MutationRequest {
  readonly category: MutationCategory;
  readonly targets: readonly string[];
  readonly selector: string;
  readonly url: string;
  readonly goal: string;
}

/** The host's explicit yes/no. Never derived from the goal or the model. */
export type ApproveMutation = (request: MutationRequest) => Promise<boolean> | boolean;

// --- classification ----------------------------------------------------------

/** Approve / reject, in English and in the sheets' Thai. */
const APPROVE_NAME = /^(?:(approve|reject|authori[sz]e)\b|(อนุมัติ|ไม่อนุมัติ|ปฏิเสธ))/i;
/** A form's commit. `Confirm` alone is here too — the second half of a delete carries its own verb. */
const SUBMIT_NAME = /^(?:(submit|save|create|confirm|pay|checkout|publish|send|post)\b|(ส่ง|บันทึก|ยืนยัน|สร้าง|ชำระ))/i;

export function mutationCategoryFromName(name: string): MutationCategory | null {
  const trimmed = name.trim();
  if (DESTRUCTIVE_NAME.test(trimmed)) return 'delete';
  if (APPROVE_NAME.test(trimmed)) return 'approve';
  if (SUBMIT_NAME.test(trimmed)) return 'submit';
  return null;
}

export function controlNameFromAriaSnapshot(snapshot: string): string | null {
  const root = snapshot.split('\n').find((line) => line.trim() !== '')?.trim();
  if (root === undefined) return null;
  const encoded = /^-\s+\S+(?:\s+\[[^\]]+\])*\s+"((?:\\.|[^"])*)"/.exec(root)?.[1];
  if (encoded === undefined) return null;
  try {
    const decoded: unknown = JSON.parse(`"${encoded}"`);
    return typeof decoded === 'string' && decoded.trim() !== '' ? decoded.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The mutation category of a decision, or null for an ordinary action.
 *
 * Only an activation with a selector can be one — `click`, or a `press` aimed
 * at a control (a bare key to whatever has focus names no target). The
 * category is read off the accessible name of the control the click LANDS
 * on (`targetName`: the last named role segment), the same reading
 * `unscopedDestructiveClick` uses, so the two guards never disagree about
 * which button is the destructive one.
 */
export function mutationCategoryOf(decision: DecisionLike): MutationCategory | null {
  if (decision.action !== 'click' && decision.action !== 'press') return null;
  if (decision.selector.trim() === '') return null;
  const name = targetName(decision.selector);
  if (name === null) return null;
  return mutationCategoryFromName(name);
}

/**
 * The identifiers a mutation is scoped to — what provenance must vouch for.
 *
 * Every named segment of the selector EXCEPT the control's own verb
 * (`role=row[name="PL_03_18"] >> role=button[name="Delete"]` → `PL_03_18`;
 * `text=SIT_DUP_DOC >> xpath=.. >> role=button[name="ปิดใช้งาน"]` →
 * `SIT_DUP_DOC`), plus any identifier the goal names that the selector
 * carries. The goal is consulted for WHAT to look for, never for whether it
 * was seen — that answer comes from the ledger alone. A selector that scopes
 * to nothing yields no target and is held before an irreversible action.
 */
export function mutationTargets(decision: DecisionLike, goal: string): string[] {
  const verb = (targetName(decision.selector) ?? '').trim().toLowerCase();
  const targets: string[] = [];
  for (const m of decision.selector.matchAll(/\[name=(?:"([^"]+)"|'([^']+)')|text="?([^">]+?)"?(?=\s*>>|\s*$)/g)) {
    const name = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (name === '' || name.toLowerCase() === verb) continue;
    targets.push(name);
  }
  for (const id of goalIdentifiers(goal)) {
    if (selectorCarries(decision.selector, id) && !targets.some((t) => t.toLowerCase() === id.toLowerCase())) targets.push(id);
  }
  return targets;
}

// --- the provenance ledger ---------------------------------------------------

/** One captured page state, reduced to the texts a target could be matched against. */
interface Snapshot {
  texts: Set<string>;
  at: string;
  url: string;
}

function snapshotOf(nodes: readonly AxNode[], url: string): Snapshot {
  const texts = new Set<string>();
  for (const node of nodes) {
    for (const text of [node.name, node.value, node.description]) {
      const folded = text.trim().toLowerCase();
      if (folded !== '') texts.add(folded);
    }
  }
  return { texts, at: new Date().toISOString(), url };
}

/** The same word-wise rule `selectorGrounded` applies, against one node's text. */
function textShows(text: string, needle: string): boolean {
  if (text.includes(needle)) return true;
  const words = needle.split(/\s+/).filter((w) => w.length > 1);
  return words.length > 0 && words.every((w) => text.includes(w));
}

function anyShows(texts: ReadonlySet<string>, target: string): boolean {
  const needle = target.trim().toLowerCase();
  if (needle === '') return false;
  for (const text of texts) if (textShows(text, needle)) return true;
  return false;
}

/**
 * What this session has SEEN, from harness observations only.
 *
 * Fed by the loop from every accessibility capture it makes (`observe`), and
 * from nothing else: not the goal, not the model's reasoning, not a selector
 * it emitted. Reset at the top of every `run()` — a row seen by the previous
 * leg, or the previous case, is not a row this leg has seen. `latest` is the
 * most recent capture, and a gated mutation is judged against that one
 * specifically, so a row that scrolled away, was filtered out, or was
 * already deleted is not acted on because it was once on screen.
 */
export class TargetProvenance {
  #seen = new Set<string>();
  #latest: Snapshot | null = null;

  reset(): void {
    this.#seen = new Set();
    this.#latest = null;
  }

  /** Record a capture. `url` is the page it was taken on. */
  observe(nodes: readonly AxNode[], url: string): void {
    const snapshot = snapshotOf(nodes, url);
    for (const text of snapshot.texts) this.#seen.add(text);
    this.#latest = snapshot;
  }

  /** Has anything captured this session shown the target? */
  observedThisSession(target: string): boolean {
    return anyShows(this.#seen, target);
  }

  /** Is the target in the most recent capture? False when nothing was captured yet. */
  inLatestSnapshot(target: string): boolean {
    return this.#latest !== null && anyShows(this.#latest.texts, target);
  }

  /** The facts about a set of targets, for the record. */
  facts(targets: readonly string[]): ProvenanceFacts {
    return {
      targets: [...targets],
      observedThisSession: targets.filter((t) => this.observedThisSession(t)),
      inLatestSnapshot: targets.filter((t) => this.inLatestSnapshot(t)),
      latestSnapshotAt: this.#latest?.at ?? null,
      latestSnapshotUrl: this.#latest?.url ?? null,
    };
  }
}

// --- the gate ----------------------------------------------------------------

export interface MutationGateInput {
  readonly decision: DecisionLike;
  readonly goal: string;
  readonly url: string;
  readonly policy: MutationPolicy | null;
  readonly provenance: TargetProvenance;
  readonly observedControlName?: string | null | undefined;
  /** The host's approval hook, when one is wired. */
  readonly approve?: ApproveMutation | undefined;
}

function approvedByManifest(policy: MutationPolicy | null, category: MutationCategory, targets: readonly string[]): boolean {
  for (const entry of policy?.approved ?? []) {
    if (entry.category !== category) continue;
    const target = (entry.target ?? '*').trim();
    if (target === '*' || target === '') return true;
    if (targets.some((t) => t.toLowerCase() === target.toLowerCase())) return true;
  }
  return false;
}

function held(
  input: MutationGateInput,
  category: MutationCategory,
  targets: readonly string[],
  rule: BlockedOutcome['rule'],
  reason: BlockedOutcome['reason'],
  message: string,
  withProvenance: boolean,
): BlockedOutcome {
  return {
    kind: 'blocked',
    reason,
    rule,
    message,
    category,
    target: targets[0] ?? null,
    policySource: input.policy?.source ?? (input.policy === null ? null : 'unspecified'),
    ...(withProvenance ? { provenance: input.provenance.facts(targets) } : {}),
  };
}

/**
 * Why this mutation must not run, or null when it may.
 *
 * Pure apart from the `approve` hook, which is the one thing here that is
 * allowed to be a question to a person. The category is judged first (a
 * static fact about the run), provenance second (a fact about the page, read
 * off the latest capture the caller made — the caller refreshes it right
 * before asking), approval last (a fact about the host). An ordinary action
 * returns null without touching any of them, which is what keeps every
 * click, fill and goto exactly as fast and as free as before.
 */
export async function gateMutation(input: MutationGateInput): Promise<BlockedOutcome | null> {
  const observedCategory = input.observedControlName === undefined || input.observedControlName === null
    ? null
    : mutationCategoryFromName(input.observedControlName);
  const category = observedCategory ?? mutationCategoryOf(input.decision);
  if (category === null) return null;
  const targets = mutationTargets(input.decision, input.goal);
  const policy = input.policy;

  if (policy !== null) {
    if (policy.deny?.includes(category)) {
      return held(
        input, category, targets, 'policy-deny', 'capability',
        `the run's mutation policy denies "${category}" — "${input.decision.selector}" would ${category} and was not performed`,
        false,
      );
    }
    if (policy.allow !== undefined && !policy.allow.includes(category)) {
      return held(
        input, category, targets, 'policy-allow-list', 'capability',
        `the run's mutation policy allows only ${policy.allow.length === 0 ? 'no mutation category' : policy.allow.join(', ')} — "${input.decision.selector}" would ${category} and was not performed`,
        false,
      );
    }
  }

  if (!IRREVERSIBLE_CATEGORIES.has(category)) return null;

  if (targets.length === 0) {
    return held(
      input, category, targets, 'destructive-unscoped', 'provenance',
      `the ${category} control ${JSON.stringify(input.observedControlName ?? input.decision.selector)} is not scoped to a record identifier — select the row or record explicitly; no action was performed`,
      true,
    );
  }

  for (const target of targets) {
    if (!input.provenance.observedThisSession(target)) {
      return held(
        input, category, [target, ...targets.filter((t) => t !== target)], 'target-never-observed', 'provenance',
        `"${target}" has not been observed on any page this session — a ${category} scoped to it cannot be verified against something the harness never saw; find the row on the page first, or call fail`,
        true,
      );
    }
    if (!input.provenance.inLatestSnapshot(target)) {
      return held(
        input, category, [target, ...targets.filter((t) => t !== target)], 'target-not-in-latest-snapshot', 'provenance',
        `"${target}" was on the page earlier but is not in the latest snapshot — a ${category} must act on what is showing now; bring the row back into view, or call fail`,
        true,
      );
    }
  }

  if (approvedByManifest(policy, category, targets)) return null;
  if (input.approve !== undefined) {
    const yes = await input.approve({
      category,
      targets,
      selector: input.decision.selector,
      url: input.url,
      goal: input.goal,
    });
    if (yes) return null;
    return held(
      input, category, targets, 'approval-refused', 'approval',
      `the host refused to approve this ${category} of ${targets.map((t) => JSON.stringify(t)).join(', ')}`,
      true,
    );
  }
  return held(
    input, category, targets, 'approval-missing', 'approval',
    `a ${category} is irreversible and this run's mutation policy pre-approves none for ${targets.map((t) => JSON.stringify(t)).join(', ')} — add an "approved" entry to the policy (category "${category}", target "${targets[0] ?? '*'}" or "*"), or have the host approve it`,
    true,
  );
}

// --- the manifest, parsed ----------------------------------------------------

export const MUTATION_POLICY_ENV = 'WOWLIDATOR_MUTATION_POLICY';

/** A policy that could not be read is a configuration fault, and fails before any run starts. */
export class MutationPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MutationPolicyError';
  }
}

const MutationCategorySchema = z.enum(MUTATION_CATEGORIES);
const ApprovedMutationSchema = z.object({
  category: MutationCategorySchema,
  target: z.string().min(1).optional(),
}).strict();
const MutationPolicySchema = z.object({
  allow: z.array(MutationCategorySchema).optional(),
  deny: z.array(MutationCategorySchema).optional(),
  approved: z.array(ApprovedMutationSchema).optional(),
}).strict();

/**
 * Parse a manifest from JSON text. Strict: an unknown category, a
 * non-object, a malformed approval entry are each a fault, because a policy
 * that silently dropped its `deny` list would be worse than none.
 */
export function parseMutationPolicy(text: string, source = 'manifest'): MutationPolicy {
  const where = `mutation policy (${source}) is not valid`;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new MutationPolicyError(`${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = MutationPolicySchema.safeParse(raw);
  if (!parsed.success) throw new MutationPolicyError(`${where}: ${z.prettifyError(parsed.error)}`);
  return { ...parsed.data, source };
}

/** The policy `WOWLIDATOR_MUTATION_POLICY` names, or null when unset. Throws `MutationPolicyError` on a bad one. */
export function mutationPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): MutationPolicy | null {
  const text = env[MUTATION_POLICY_ENV]?.trim();
  if (text === undefined || text === '') return null;
  return parseMutationPolicy(text, 'env');
}
