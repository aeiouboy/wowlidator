/**
 * The bench's arithmetic, pure (2026-09-05).
 *
 * There was no number that said whether a change to authoring, the agent or
 * the verdict logic made verdicts better or worse. This module computes one
 * from a LABELLED SET of frozen proof bundles: for each bundle a person has
 * ruled what the case really was (`BenchTruth`); the bundle says what the
 * harness filed. Precision is the share of what the harness filed as a
 * defect that a person would accept as one — the number a QA agent is judged
 * on, because a bug report nobody accepts costs a reader's trust.
 *
 * Nothing here relabels a bundle: `effectiveStatus` is asked the way every
 * other consumer asks it, and a human ruling on a needs-review outranks the
 * machine's deferral exactly as it does in the report. Cost is read from
 * whatever the bundle recorded — agent turns and tokens, the diagnosis and
 * risk judges' tokens, the page's own calls — and every field is read
 * defensively, because a bundle written by an older build may lack any of
 * them. No model, no browser, no file: the runner (`run.ts`) does the I/O.
 */

import { effectiveStatus, type ProofBundle } from '../engine/proof-bundle.js';
import { BENCH_TRUTHS, type BenchTruth } from './labels.js';

export interface BenchEntry {
  truth: BenchTruth;
  bundle: ProofBundle;
}

/** Totals summed over the set, and the same divided by the number of cases. */
export interface BenchCost {
  /** Model turns the agent legs consumed. */
  modelTurns: number;
  /** Input tokens across agent legs, the error-diagnosis judge and the dead-end-risk judge. */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens the provider served from its prompt cache (agent legs). */
  cachedInputTokens: number;
  /** HTTP calls the page itself made while agent legs ran (`detail.callsMade`). */
  pageCalls: number;
  /** Wall clock: `caseDurationMs` when the suite loop recorded it, else `durationMs`. */
  durationMs: number;
  /** Calls billed to a session provider (`summary.session`, the Claude CLI), when the run used one. */
  sessionCalls: number;
  /** What that session was charged, in USD — the number a person can check against their account. */
  sessionCostUsd: number;
}

export interface BenchScore {
  cases: number;
  /** Bundles the harness FILED as a defect: effective status `failed`, or ≥1 recorded defect. */
  filedDefects: number;
  /** Filed defects a person also labelled `real-defect`. */
  truePositives: number;
  /** `truePositives / filedDefects`; null when nothing was filed. */
  precision: number | null;
  /** Cases labelled `real-defect` that the harness did not file. */
  missedDefects: number;
  /** `truePositives / labelled real-defect`; null when none were labelled. */
  recall: number | null;
  /** How many cases carry each truth (every truth present, zero when none). */
  byTruth: Record<BenchTruth, number>;
  /** How many bundles carry each effective status, as recorded. */
  byStatus: Record<string, number>;
  /**
   * `bundle.diagnosis.origin` against the labelled truth: `confusion[origin][truth]`
   * is how many bundles the diagnosis judge blamed on `origin` that a person
   * ruled `truth`. Bundles with no diagnosis sit under `NO_DIAGNOSIS`.
   */
  confusion: Record<string, Partial<Record<BenchTruth, number>>>;
  costTotal: BenchCost;
  costPerCase: BenchCost;
}

/** The confusion row for bundles the diagnosis judge never ran on. */
export const NO_DIAGNOSIS = '(none)';

const ZERO_COST: BenchCost = {
  modelTurns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  pageCalls: 0,
  durationMs: 0,
  sessionCalls: 0,
  sessionCostUsd: 0,
};

/** A finite number, or 0 — the bundle may not carry the field, or may carry junk. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Did the harness file this bundle as a defect a reader would open? */
export function isFiledDefect(bundle: ProofBundle): boolean {
  if (effectiveStatus(bundle) === 'failed') return true;
  return Array.isArray(bundle.defects) && bundle.defects.length >= 1;
}

/** Everything the bundle recorded that cost tokens, turns or time. */
export function costOf(bundle: ProofBundle): BenchCost {
  const cost: BenchCost = { ...ZERO_COST };
  for (const step of Array.isArray(bundle.steps) ? bundle.steps : []) {
    const agent = step.agent;
    const detail = step.detail ?? {};
    if (agent !== undefined) {
      cost.modelTurns += num(agent.turns);
      cost.inputTokens += num(agent.inputTokens);
      cost.outputTokens += num(agent.outputTokens);
      // The leg's cached tokens are lifted into `detail` too; count them once.
      cost.cachedInputTokens += num(agent.cachedInputTokens ?? detail['cachedInputTokens']);
    } else {
      // An older bundle may carry the leg's numbers on the step detail only.
      cost.modelTurns += num(detail['turns']);
      cost.cachedInputTokens += num(detail['cachedInputTokens']);
    }
    cost.pageCalls += num(detail['callsMade']);
  }
  cost.inputTokens += num(bundle.diagnosis?.inputTokens) + num(bundle.risk?.inputTokens);
  cost.outputTokens += num(bundle.diagnosis?.outputTokens) + num(bundle.risk?.outputTokens);
  cost.durationMs += num(bundle.caseDurationMs ?? bundle.durationMs);
  const session = bundle.summary?.session;
  if (session !== undefined && session !== null && typeof session === 'object') {
    cost.sessionCalls += num(session.calls);
    cost.sessionCostUsd += num(session.costUsd);
  }
  return cost;
}

function addCost(into: BenchCost, cost: BenchCost): void {
  for (const key of Object.keys(ZERO_COST) as (keyof BenchCost)[]) into[key] += cost[key];
}

function divideCost(cost: BenchCost, by: number): BenchCost {
  const out: BenchCost = { ...ZERO_COST };
  if (by <= 0) return out;
  for (const key of Object.keys(ZERO_COST) as (keyof BenchCost)[]) out[key] = cost[key] / by;
  return out;
}

function emptyByTruth(): Record<BenchTruth, number> {
  const out = {} as Record<BenchTruth, number>;
  for (const truth of BENCH_TRUTHS) out[truth] = 0;
  return out;
}

export function scoreBench(entries: readonly BenchEntry[]): BenchScore {
  const byTruth = emptyByTruth();
  const byStatus: Record<string, number> = {};
  const confusion: Record<string, Partial<Record<BenchTruth, number>>> = {};
  const costTotal: BenchCost = { ...ZERO_COST };
  let filedDefects = 0;
  let truePositives = 0;
  let missedDefects = 0;

  for (const { truth, bundle } of entries) {
    byTruth[truth] += 1;
    const status = String(effectiveStatus(bundle));
    byStatus[status] = (byStatus[status] ?? 0) + 1;

    const filed = isFiledDefect(bundle);
    if (filed) {
      filedDefects += 1;
      if (truth === 'real-defect') truePositives += 1;
    } else if (truth === 'real-defect') {
      missedDefects += 1;
    }

    const origin =
      typeof bundle.diagnosis?.origin === 'string' && bundle.diagnosis.origin !== ''
        ? bundle.diagnosis.origin
        : NO_DIAGNOSIS;
    const row = (confusion[origin] ??= {});
    row[truth] = (row[truth] ?? 0) + 1;

    addCost(costTotal, costOf(bundle));
  }

  const labelledReal = byTruth['real-defect'];
  return {
    cases: entries.length,
    filedDefects,
    truePositives,
    precision: filedDefects > 0 ? truePositives / filedDefects : null,
    missedDefects,
    recall: labelledReal > 0 ? truePositives / labelledReal : null,
    byTruth,
    byStatus,
    confusion,
    costTotal,
    costPerCase: divideCost(costTotal, entries.length),
  };
}

// --- stability ---------------------------------------------------------------

/**
 * Given the repeated bundles of each case (one inner array per case, as
 * `--rerun-case` produces), the share of cases whose effective status is not
 * the same on every run. A case run once cannot flip and counts as stable;
 * an empty inner array is not a case. 0 when there are no cases.
 */
export function flipRate(runs: readonly (readonly ProofBundle[])[]): number {
  const cases = runs.filter((bundles) => bundles.length > 0);
  if (cases.length === 0) return 0;
  const flipped = cases.filter((bundles) => {
    const statuses = new Set(bundles.map((bundle) => String(effectiveStatus(bundle))));
    return statuses.size > 1;
  }).length;
  return flipped / cases.length;
}

// --- comparing two scores ----------------------------------------------------

/** The subtraction `--baseline` prints: current minus baseline, field by field. */
export interface BenchDelta {
  cases: number;
  filedDefects: number;
  truePositives: number;
  /** null when either side had nothing filed. */
  precision: number | null;
  recall: number | null;
  costPerCase: BenchCost;
}

type Comparable = Pick<BenchScore, 'cases' | 'filedDefects' | 'truePositives' | 'precision' | 'recall' | 'costPerCase'>;

export function diffScores(baseline: Comparable, current: Comparable): BenchDelta {
  const cost: BenchCost = { ...ZERO_COST };
  for (const key of Object.keys(ZERO_COST) as (keyof BenchCost)[]) {
    cost[key] = num(current.costPerCase[key]) - num(baseline.costPerCase[key]);
  }
  return {
    cases: current.cases - baseline.cases,
    filedDefects: current.filedDefects - baseline.filedDefects,
    truePositives: current.truePositives - baseline.truePositives,
    precision:
      current.precision !== null && baseline.precision !== null ? current.precision - baseline.precision : null,
    recall: current.recall !== null && baseline.recall !== null ? current.recall - baseline.recall : null,
    costPerCase: cost,
  };
}
