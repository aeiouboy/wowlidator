/**
 * Findings — the catalog run's non-passing cases folded onto their ROOT
 * CAUSES (asked for 2026-09-05).
 *
 * A run whose 70 non-passing cases share five root causes used to read as 70
 * independent verdicts, and a reader had to open each to learn that the same
 * endpoint answered 500 to every one. This module is the deterministic
 * projection that leads the report instead: N findings, M of K non-passing
 * cases, U that could not be clustered — every one still listed, none
 * dropped.
 *
 * Three rules, all load-bearing:
 *
 * - **A signature is computed ONLY from typed fields.** The first
 *   non-superseded failing step of each case's bundle yields a key from its
 *   `action`, `selector`, `url`, `request.{method,url,status}`,
 *   `detail.expected/actual`, `blocked.{reason,rule}` and the agent record's
 *   typed `endedBy` / `listbox` fields. Never from a message, a model's
 *   reasoning or a bundle summary: the same root cause is worded in one
 *   language on one case and another on the next, and a key built from prose
 *   would split what is one cause into as many findings as there are
 *   wordings. `tests/findings.test.ts` greps this file for those fields.
 * - **No status is rewritten.** A finding lists its members with the statuses
 *   the ledger sealed — `failed`, `error`, `dead-end` — counted as recorded.
 *   The projection groups; it never relabels (see `src/reporter/CLAUDE.md`).
 * - **Nothing is hidden.** A case with no signature is `unclustered` and
 *   counted; a `never ran` case is folded into one list, not left out; a
 *   dependent (`depends on X …`) is listed under X's finding when X has one
 *   and under `unclustered` otherwise.
 *
 * Pure: no model, no I/O, no imports from the control plane. The agent's
 * optional `endedBy` / `listbox` fields are read through a LOCAL structural
 * type (`AgentShape`) — they are being added to the bundle types in a
 * parallel change, and this file must compile and behave with or without
 * them, so it never imports their names.
 */

import type { ProofStep } from '../engine/proof-bundle.js';
import { verdictFamily } from '../engine/proof-bundle.js';
import type { CatalogReportCase } from './catalog-report.js';
import { stepTarget } from './step-facts.js';

export type FindingKind = 'api' | 'url' | 'control' | 'hold' | 'agent' | 'authoring' | 'other';

/** One member of a finding: the case and its verdict exactly as the ledger sealed it. */
export interface FindingCase {
  id: string;
  /** The bundle's own status when there was one (`failed`, `error`, `dead-end`, …), verbatim. */
  status: string | null;
  /** `failed | blocked | review | …`, verbatim. */
  verdict: string;
  /**
   * Set when the case was folded in as a DEPENDENT: its own reason begins
   * `depends on <X>` and X is a member of this finding. Its own status is
   * still shown as sealed; this only says why it is listed here.
   */
  dependsOn?: string | undefined;
}

export interface FindingEvidence {
  label: string;
  value: string;
}

export interface Finding {
  /** The signature every member shares — `api:POST /x → 500`. Stable, so a rerun keeps the same key. */
  key: string;
  kind: FindingKind;
  /** One plain sentence naming the cause, a pure function of the key's parts. */
  title: string;
  cases: FindingCase[];
  /** The page path (or request path) the cause was met at, when the signature has one. */
  where?: string | undefined;
  /** What the step asked for — the expected status, URL, or the selector it wanted. */
  asked?: string | undefined;
  /** What the page or endpoint offered instead. */
  offered?: string | undefined;
  /** Typed facts from the FIRST member's failing step — the sample a reader checks the title against. */
  evidence: FindingEvidence[];
}

/** The whole projection the report and the export render. */
export interface FindingsSummary {
  findings: Finding[];
  /** Non-passing cases with no signature and no prerequisite that has one. Counted, never dropped. */
  unclustered: FindingCase[];
  /** Cases that never ran — folded into one list by the report. */
  neverRan: FindingCase[];
  /** K — every case that is neither passed nor never-ran. */
  nonPassing: number;
  /** M — the non-passing cases some finding accounts for (dependents included). */
  clustered: number;
}

/* --------------------------------------------------------------- helpers */

/** `https://host/a/b?x=1` → `/a/b`; a bare path stays a path; anything else verbatim. */
export function pathnameOf(url: string | null | undefined): string {
  if (typeof url !== 'string' || url === '') return '';
  try {
    return new URL(url).pathname || '/';
  } catch {
    const cut = url.search(/[?#]/);
    return cut === -1 ? url : url.slice(0, cut);
  }
}

/** The failing step the signature is read from: the first non-superseded step that did not pass. */
export function firstFailingStep(steps: readonly ProofStep[] | undefined): { step: ProofStep; at: number } | null {
  if (steps === undefined) return null;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    if (step.superseded === true) continue;
    if (step.status !== 'passed' && step.status !== 'skipped') return { step, at: i };
  }
  return null;
}

/** The latest `request` step before `at` — what an `expectStatus`/`expectJson` asserted against. */
function latestRequestBefore(steps: readonly ProofStep[], at: number): ProofStep | null {
  for (let i = at; i >= 0; i -= 1) {
    const step = steps[i]!;
    if (step.superseded === true) continue;
    if (step.request !== undefined) return step;
  }
  return null;
}

/**
 * The agent record's OPTIONAL typed fields, spelled structurally. `endedBy`
 * names why the loop stopped (`stall`, `no-progress`, `finish`, …); a
 * `listbox` on an action records the dropdown that action opened — what
 * triggered it and what it showed. Both absent on older records and on a
 * build that has not yet added them; every read tolerates that.
 */
interface ListboxShape {
  trigger?: unknown;
  value?: unknown;
  shownCount?: unknown;
  shownHead?: unknown;
}
interface AgentShape {
  endedBy?: unknown;
  urlAfter?: unknown;
  actions?: unknown;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function agentFacts(agent: unknown): { endedBy: string | null; urlAfter: string | null; listbox: ListboxShape | null } {
  if (typeof agent !== 'object' || agent === null) return { endedBy: null, urlAfter: null, listbox: null };
  const shape = agent as AgentShape;
  let listbox: ListboxShape | null = null;
  if (Array.isArray(shape.actions)) {
    // The LAST action that opened a listbox — the dropdown the leg ended on.
    for (const action of shape.actions) {
      const candidate = (action as { listbox?: unknown } | null)?.listbox;
      if (typeof candidate === 'object' && candidate !== null) listbox = candidate as ListboxShape;
    }
  }
  return { endedBy: str(shape.endedBy), urlAfter: str(shape.urlAfter), listbox };
}

/** `detail.expected` as one line: an `expectStatus` records an array of allowed statuses. */
function expectedOf(detail: Record<string, unknown> | undefined): string | null {
  const raw = detail?.['expected'];
  if (raw === undefined || raw === null) return null;
  if (Array.isArray(raw)) return raw.map((v) => String(v)).join(' or ');
  return typeof raw === 'string' ? raw : JSON.stringify(raw);
}

function actualOf(detail: Record<string, unknown> | undefined): string | null {
  const raw = detail?.['actual'];
  if (raw === undefined || raw === null) return null;
  return typeof raw === 'string' ? raw : JSON.stringify(raw);
}

/** A step whose selector never resolved: a dead end, or a miss with no rung that answered. */
function unresolvedControl(step: ProofStep): boolean {
  if (step.status === 'dead-end') return true;
  return step.selector !== null && step.selector !== '' && step.resolution === null && (step.resolvedSelector === null || step.resolvedSelector === '');
}

/** The reason's `authoring refused` text without its attempt counter — a counter is not a cause. */
function authoringReason(reason: string): string {
  return reason
    .replace(/^authoring refused(?:\s*\(attempt \d+\))?:?\s*/i, '')
    .trim()
    .slice(0, 60);
}

/** `depends on X, which …` → `X`; null when the reason is not a dependency line. */
export function dependencyOf(reason: string | null | undefined): string | null {
  if (typeof reason !== 'string') return null;
  const m = reason.match(/^depends on\s+([^\s,]+)/);
  return m?.[1] ?? null;
}

/* ------------------------------------------------------------- signature */

interface Signature {
  key: string;
  kind: FindingKind;
  title: string;
  where?: string | undefined;
  asked?: string | undefined;
  offered?: string | undefined;
  evidence: FindingEvidence[];
}

const evidence = (label: string, value: string | number | null | undefined): FindingEvidence[] =>
  value === null || value === undefined || value === '' ? [] : [{ label, value: String(value) }];

/**
 * The signature of one case, or null when its typed fields name no cause.
 * Exported so a test can ask the question directly.
 */
export function signatureOf(c: CatalogReportCase): Signature | null {
  const steps = c.bundle?.steps;
  const failing = firstFailingStep(steps);
  if (failing === null) {
    const reason = c.reason ?? '';
    if (/^authoring refused/i.test(reason)) {
      const head = authoringReason(reason);
      return {
        key: `authoring:${head}`,
        kind: 'authoring',
        title: `authoring refused to write the case: ${head}`,
        evidence: evidence('reason', reason),
      };
    }
    return null;
  }
  const { step, at } = failing;
  const stepLine = `#${step.index} ${step.action}`;

  // A hold outranks every other reading: the harness withheld the action, so
  // nothing about the application was established (Phase B).
  if (step.blocked !== undefined) {
    const b = step.blocked;
    return {
      key: `hold:${b.reason}/${b.rule}`,
      kind: 'hold',
      title: `held by the harness — ${b.reason} (${b.rule}); no verdict about the application`,
      where: pathnameOf(step.url) || undefined,
      asked: b.category === 'ordinary' ? undefined : `a ${b.category} action${b.target ? ` on ${b.target}` : ''}`,
      evidence: [
        ...evidence('step', stepLine),
        ...evidence('reason', b.reason),
        ...evidence('rule', b.rule),
        ...evidence('category', b.category),
        ...evidence('target', b.target),
        ...evidence('policy source', b.policySource),
        ...evidence('message', b.message),
      ],
    };
  }

  if (step.action === 'expectStatus' || step.action === 'expectJson') {
    const request = latestRequestBefore(steps ?? [], at)?.request ?? step.request;
    if (request !== undefined) {
      const path = pathnameOf(request.url);
      const status = request.status === null ? 'no response' : String(request.status);
      const asked = expectedOf(step.detail);
      const offered = actualOf(step.detail);
      return {
        key: `api:${request.method.toUpperCase()} ${path} → ${status}`,
        kind: 'api',
        title: `${request.method.toUpperCase()} ${path} answered ${status}`,
        where: path,
        asked: asked === null ? undefined : step.action === 'expectJson' ? `${String(step.detail?.['path'] ?? '')} = ${asked}`.trim() : `status ${asked}`,
        offered: offered ?? undefined,
        evidence: [
          ...evidence('step', stepLine),
          ...evidence('request', `${request.method.toUpperCase()} ${request.url}`),
          ...evidence('status', status),
          ...evidence('expected', asked),
          ...evidence('actual', offered),
        ],
      };
    }
  }

  if (step.action === 'expectUrl') {
    const expected = expectedOf(step.detail) ?? '';
    const actual = actualOf(step.detail);
    const landed = pathnameOf(actual);
    return {
      key: `url:${expected} → ${landed}`,
      kind: 'url',
      title: `expected the URL to contain ${JSON.stringify(expected)}, landed on ${landed || 'an unknown page'}`,
      where: landed || undefined,
      asked: expected || undefined,
      offered: actual ?? undefined,
      evidence: [...evidence('step', stepLine), ...evidence('expected', expected), ...evidence('actual', actual)],
    };
  }

  if (step.action === 'workflow') {
    const { endedBy, urlAfter, listbox } = agentFacts(step.agent);
    const path = pathnameOf(urlAfter ?? step.url);
    const trigger = str(listbox?.trigger) ?? '';
    const ended = endedBy ?? 'workflow';
    // `agent:<endedBy>:<trigger> @ <path>`; with no listbox in the record the
    // trigger segment is left out, so an older bundle still yields the coarse
    // `agent:workflow @ <path>`.
    return {
      key: `agent:${ended}${trigger === '' ? '' : `:${trigger}`} @ ${path}`,
      kind: 'agent',
      title: `the agent leg ended (${ended})${trigger ? ` on the ${JSON.stringify(trigger)} listbox` : ''} at ${path || 'an unknown page'}`,
      where: path || undefined,
      asked: trigger || undefined,
      offered:
        listbox === null
          ? undefined
          : [str(listbox.value) ? `value ${JSON.stringify(listbox.value)}` : null, typeof listbox.shownCount === 'number' ? `${listbox.shownCount} option(s) shown` : null]
              .filter((s): s is string => s !== null)
              .join(' · ') || undefined,
      evidence: [
        ...evidence('step', stepLine),
        ...evidence('ended by', ended),
        ...evidence('listbox trigger', trigger),
        ...evidence('listbox value', str(listbox?.value)),
        ...evidence('options shown', typeof listbox?.shownCount === 'number' ? listbox.shownCount : null),
        ...evidence('first options', Array.isArray(listbox?.shownHead) ? listbox.shownHead.map((v) => String(v)).join(', ') : str(listbox?.shownHead)),
        ...evidence('url', urlAfter ?? step.url),
      ],
    };
  }

  const selector = step.selector ?? stepTarget(step);
  if (selector !== null && selector !== '' && unresolvedControl(step)) {
    const path = pathnameOf(step.url);
    return {
      key: `control:${selector} @ ${path}`,
      kind: 'control',
      title: `${selector} could not be found at ${path || 'an unknown page'}`,
      where: path || undefined,
      asked: selector,
      evidence: [...evidence('step', stepLine), ...evidence('selector', selector), ...evidence('url', step.url)],
    };
  }

  if (selector !== null && selector !== '') {
    // The control was found and the claim about it failed: same action, same
    // control, same page is one cause across cases.
    const path = pathnameOf(step.url);
    const asked = expectedOf(step.detail);
    const offered = actualOf(step.detail);
    return {
      key: `other:${step.action} ${selector} @ ${path}`,
      kind: 'other',
      title: `${step.action} on ${selector} did not hold at ${path || 'an unknown page'}`,
      where: path || undefined,
      asked: asked ?? undefined,
      offered: offered ?? undefined,
      evidence: [
        ...evidence('step', stepLine),
        ...evidence('selector', selector),
        ...evidence('expected', asked),
        ...evidence('actual', offered),
        ...evidence('url', step.url),
      ],
    };
  }
  return null;
}

/* ------------------------------------------------------------ projection */

const memberOf = (c: CatalogReportCase, dependsOn?: string): FindingCase => ({
  id: c.id,
  status: c.status,
  verdict: c.verdict,
  ...(dependsOn === undefined ? {} : { dependsOn }),
});

/**
 * The full projection: findings, the unclustered remainder, the never-ran
 * fold and the counts the report's headline states.
 */
export function buildFindingsSummary(cases: readonly CatalogReportCase[]): FindingsSummary {
  const byKey = new Map<string, Finding>();
  const keyOfCase = new Map<string, string>();
  const neverRan: FindingCase[] = [];
  const pending: CatalogReportCase[] = [];
  let nonPassing = 0;

  for (const c of cases) {
    if (c.verdict === 'never-ran') {
      neverRan.push(memberOf(c));
      continue;
    }
    if (c.verdict === 'passed') continue;
    nonPassing += 1;
    const sig = signatureOf(c);
    if (sig === null) {
      pending.push(c);
      continue;
    }
    let finding = byKey.get(sig.key);
    if (finding === undefined) {
      finding = {
        key: sig.key,
        kind: sig.kind,
        title: sig.title,
        cases: [],
        where: sig.where,
        asked: sig.asked,
        offered: sig.offered,
        evidence: sig.evidence,
      };
      byKey.set(sig.key, finding);
    }
    finding.cases.push(memberOf(c));
    keyOfCase.set(c.id, sig.key);
  }

  // Dependents: `depends on X …` joins X's finding when X has one — following
  // a chain of dependents until a member with a signature is met, bounded so
  // a cycle the scheduler already reported cannot loop here.
  const byId = new Map(cases.map((c) => [c.id, c] as const));
  const unclustered: FindingCase[] = [];
  for (const c of pending) {
    let on = dependencyOf(c.reason);
    let key: string | undefined;
    for (let hops = 0; on !== null && hops < 8; hops += 1) {
      key = keyOfCase.get(on);
      if (key !== undefined) break;
      on = dependencyOf(byId.get(on)?.reason);
    }
    const root = dependencyOf(c.reason);
    if (key !== undefined && root !== null) {
      byKey.get(key)!.cases.push(memberOf(c, root));
      keyOfCase.set(c.id, key);
    } else {
      unclustered.push(memberOf(c));
    }
  }

  const findings = [...byKey.values()].sort((a, b) => b.cases.length - a.cases.length || a.key.localeCompare(b.key));
  const clustered = findings.reduce((sum, f) => sum + f.cases.length, 0);
  return { findings, unclustered, neverRan, nonPassing, clustered };
}

/** The findings alone — the signature the report and export share; see `buildFindingsSummary` for the counts. */
export function buildFindings(cases: readonly CatalogReportCase[]): Finding[] {
  return buildFindingsSummary(cases).findings;
}

/** `N findings account for M of K non-passing cases · U unclustered` — the one line the report and the export share. */
export function findingsHeadline(summary: Pick<FindingsSummary, 'findings' | 'clustered' | 'nonPassing' | 'unclustered'>): string {
  const n = summary.findings.length;
  return (
    `${n} finding${n === 1 ? '' : 's'} account for ${summary.clustered} of ${summary.nonPassing} non-passing case${summary.nonPassing === 1 ? '' : 's'}` +
    ` · ${summary.unclustered.length} unclustered`
  );
}

/** `failed: 2 · error: 1` — the members' sealed statuses counted, never changed. */
export function statusCounts(members: readonly FindingCase[]): { status: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const m of members) {
    const label = m.status ?? m.verdict;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([status, count]) => ({ status, count }));
}

/**
 * A member whose verdict says nothing about the application: the harness
 * broke (`error`, the system family), held the action, or never wrote the
 * case. What `suggestedSeverity` calls harness-only.
 */
export function harnessOnly(finding: Finding, member: FindingCase): boolean {
  if (finding.kind === 'hold' || finding.kind === 'authoring') return true;
  return member.status !== null && verdictFamily(member.status) === 'system-error';
}

export type SuggestedSeverity = 'high' | 'medium' | 'low';

/**
 * The stated rule the export prints at its head (see `SEVERITY_RULE`):
 * low when every member is harness-only; else high when the finding covers
 * three or more cases or blocks a dependency chain; else medium.
 * A suggestion for triage, never a verdict about the run.
 */
export function suggestedSeverity(finding: Finding): SuggestedSeverity {
  if (finding.cases.length > 0 && finding.cases.every((m) => harnessOnly(finding, m))) return 'low';
  if (finding.cases.length >= 3 || finding.cases.some((m) => m.dependsOn !== undefined)) return 'high';
  return 'medium';
}

export const SEVERITY_RULE =
  'Suggested severity is a stated rule, not a judgement: HIGH when a finding covers 3 or more cases or blocks a dependency chain ' +
  '(a case listed under it because it depends on a member); MEDIUM for 1–2 cases; LOW when every member is harness-only ' +
  '(a system error, a hold by the harness, or an authoring refusal — none of which is a verdict about the application). ' +
  'Statuses are shown exactly as the run sealed them.';
