/**
 * Run history and trend analysis.
 *
 * A single proof bundle answers "did this pass". It cannot answer the question
 * a person actually asks when a build goes red: *is this newly broken, or has
 * it been broken for a week?* Those demand completely different responses, and
 * without history the suite cannot tell them apart.
 *
 * Storage is an append-only JSONL index — one line per run, cheap to append,
 * trivially greppable, and safe to truncate at any point.
 */

import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { ProofBundle, RunStatus } from '../engine/proof-bundle.js';
import { isPassing } from '../engine/proof-bundle.js';
import { HistoryEntrySchema } from '../artifacts/schemas.js';

export const DEFAULT_HISTORY_PATH = '.wowlidator/history.jsonl';
/** Runs inspected when classifying a result. */
export const DEFAULT_HISTORY_WINDOW = 20;

/** One line of the history index. */
export interface HistoryEntry {
  runId: string;
  name: string;
  status: RunStatus;
  finishedAt: string;
  durationMs: number;
  passed: number;
  failed: number;
  jitHeals: number;
  defects: number;
  /** Coverage ratio at the time of the run, 0–1. */
  coverage?: number | undefined;
  /** `action:selector` for each failed step — the shape of the failure. */
  failedSteps: string[];
}

export type TrendVerdict =
  | 'first-run'
  | 'newly-broken'
  | 'still-broken'
  | 'newly-fixed'
  | 'stable'
  | 'flaky';

export interface RunTrend {
  verdict: TrendVerdict;
  /** Consecutive prior runs that failed, before this one. */
  consecutiveFailures: number;
  /** ISO timestamp of the first failure in the current broken streak. */
  brokenSince?: string | undefined;
  /** Pass/fail flips inside the window — high means unreliable. */
  flips: number;
  /** Prior runs considered. */
  sampleSize: number;
  /** Steps failing now that were not failing in the previous run. */
  newFailures: string[];
  /** Coverage change against the previous run, in percentage points. */
  coverageDelta?: number | undefined;
  message: string;
}

/** Signature of every failed step, used to compare one run against another. */
export function failureSignatures(bundle: ProofBundle): string[] {
  return bundle.steps
    .filter((step) => step.status !== 'passed' && !step.superseded)
    .map((step) => `${step.action}:${step.selector ?? '-'}`);
}

export function toHistoryEntry(bundle: ProofBundle): HistoryEntry {
  return {
    runId: bundle.runId,
    name: bundle.name,
    status: bundle.status,
    finishedAt: bundle.finishedAt,
    durationMs: bundle.durationMs,
    passed: bundle.summary.passed,
    failed: bundle.summary.failed,
    jitHeals: bundle.summary.jitHeals,
    defects: bundle.summary.defects,
    coverage: bundle.coverage?.ratio ?? undefined,
    failedSteps: failureSignatures(bundle),
  };
}

/** In-process serialisation of appends, one chain per history file. */
const appendChain = new Map<string, Promise<void>>();

export class RunHistory {
  readonly filePath: string;

  constructor(filePath: string = DEFAULT_HISTORY_PATH) {
    this.filePath = resolve(filePath);
  }

  /**
   * Read the index. A corrupt line is skipped rather than aborting — history
   * is diagnostic, and a truncated write must never break a run.
   */
  async load(): Promise<HistoryEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      return [];
    }

    const entries: HistoryEntry[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        // Parsed, not asserted (Phase C): a line's status feeds the trend
        // and the quarantine, so a status outside the engine's own set is a
        // line to skip, exactly as an unparseable one always was.
        const parsed = HistoryEntrySchema.safeParse(JSON.parse(line));
        if (parsed.success) entries.push(parsed.data as HistoryEntry);
      } catch {
        continue;
      }
    }
    return entries;
  }

  /** Prior runs of the same flow, oldest first. */
  async forFlow(name: string, limit = DEFAULT_HISTORY_WINDOW): Promise<HistoryEntry[]> {
    const all = await this.load();
    return all.filter((entry) => entry.name === name).slice(-limit);
  }

  async append(bundle: ProofBundle): Promise<void> {
    // Serialised per file within the process: a suite's cases finish
    // concurrently now, and two appends of one line each are almost always
    // fine on a local disk — "almost" is not a property a run history should
    // rest on, when a chained promise makes it certain for nothing.
    const previous = appendChain.get(this.filePath) ?? Promise.resolve();
    const mine = previous.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(toHistoryEntry(bundle))}\n`, 'utf8');
    });
    appendChain.set(this.filePath, mine.catch(() => undefined));
    await mine;
  }

  /**
   * Forget every run, and report how many were forgotten.
   *
   * The file is removed rather than emptied, so the next `append` recreates it
   * through the same path that creates it on a fresh checkout — one code path
   * for "no history yet" instead of two.
   *
   * Trends restart from `first-run` afterwards, which is the honest answer: a
   * cleared index cannot tell newly-broken from still-broken, and inventing a
   * verdict from no evidence is the one thing this file exists to prevent.
   */
  async clear(): Promise<number> {
    const forgotten = (await this.load()).length;
    await rm(this.filePath, { force: true });
    return forgotten;
  }
}

/**
 * Classify a run against its predecessors.
 *
 * `flaky` outranks the pass/fail verdicts on purpose: a suite that alternates
 * is untrustworthy whichever side of the coin it landed on this time, and
 * saying "passed" would hide that.
 */
export function analyseTrend(bundle: ProofBundle, previous: readonly HistoryEntry[]): RunTrend {
  const priors = previous.filter((entry) => entry.runId !== bundle.runId);
  const nowFailed = !isPassing(bundle.status);
  const signatures = failureSignatures(bundle);

  if (priors.length === 0) {
    return {
      verdict: 'first-run',
      consecutiveFailures: 0,
      flips: 0,
      sampleSize: 0,
      newFailures: signatures,
      message: 'first recorded run — nothing to compare against',
    };
  }

  // Every non-pass status is a failure to a trend — `failed`, `error` and
  // `dead-end` are different accounts of a run that did not succeed, not
  // different outcomes. Comparing raw statuses here once declared a run
  // "newly broken — the previous run passed" when the previous run had
  // status `error`: the walk below stopped at the first non-`failed` entry
  // and fabricated a pass nobody observed. (Seen live in PB-02-01.)
  const passedOf = (status: string | undefined): boolean => status !== undefined && isPassing(status);

  let flips = 0;
  for (let i = 1; i < priors.length; i += 1) {
    // Pass/fail flips only: an `error` → `dead-end` transition is two ways of
    // failing, not instability.
    if (passedOf(priors[i]?.status) !== passedOf(priors[i - 1]?.status)) flips += 1;
  }

  let consecutiveFailures = 0;
  let brokenSince: string | undefined;
  for (let i = priors.length - 1; i >= 0; i -= 1) {
    const entry = priors[i];
    if (entry === undefined || passedOf(entry.status)) break;
    consecutiveFailures += 1;
    brokenSince = entry.finishedAt;
  }

  const last = priors[priors.length - 1];
  // The claim "the previous run passed" may only ever be made about a pass
  // that is actually in the sample.
  const lastObservedPass = last !== undefined && passedOf(last.status);
  const previousFailures = new Set(last?.failedSteps ?? []);
  const newFailures = signatures.filter((sig) => !previousFailures.has(sig));

  const coverageDelta =
    bundle.coverage?.ratio != null && last?.coverage != null
      ? Math.round((bundle.coverage.ratio - last.coverage) * 1000) / 10
      : undefined;

  // Two or more flips across the window means the result is not reproducible.
  if (flips >= 2) {
    return {
      verdict: 'flaky',
      consecutiveFailures,
      brokenSince,
      flips,
      sampleSize: priors.length,
      newFailures,
      coverageDelta,
      message:
        `unstable: ${flips} pass/fail flips across the last ${priors.length} runs. ` +
        'Treat this result as unreliable until the flake is fixed.',
    };
  }

  if (nowFailed && lastObservedPass) {
    return {
      verdict: 'newly-broken',
      consecutiveFailures: 0,
      flips,
      sampleSize: priors.length,
      newFailures,
      coverageDelta,
      message: `newly broken — the previous run passed. Regression is in the latest change.`,
    };
  }

  if (nowFailed) {
    return {
      verdict: 'still-broken',
      consecutiveFailures,
      brokenSince,
      flips,
      sampleSize: priors.length,
      newFailures,
      coverageDelta,
      message:
        `broken for ${consecutiveFailures + 1} consecutive run(s)` +
        (brokenSince ? `, since ${brokenSince}` : '') +
        (newFailures.length > 0 ? `; ${newFailures.length} new failure(s) this run` : ''),
    };
  }

  if (consecutiveFailures > 0) {
    return {
      verdict: 'newly-fixed',
      consecutiveFailures,
      brokenSince,
      flips,
      sampleSize: priors.length,
      newFailures: [],
      coverageDelta,
      message: `fixed — was failing for ${consecutiveFailures} run(s)`,
    };
  }

  return {
    verdict: 'stable',
    consecutiveFailures: 0,
    flips,
    sampleSize: priors.length,
    newFailures: [],
    coverageDelta,
    message: `stable across the last ${priors.length} run(s)`,
  };
}

/** One-line summary for the CLI. */
export function formatTrend(trend: RunTrend): string {
  const delta =
    trend.coverageDelta === undefined || trend.coverageDelta === 0
      ? ''
      : ` | coverage ${trend.coverageDelta > 0 ? '+' : ''}${trend.coverageDelta}pp`;
  return `trend      ${trend.verdict} — ${trend.message}${delta}`;
}
