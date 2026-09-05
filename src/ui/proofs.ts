/**
 * Reading proof bundles off disk, for wowUI.
 *
 * The control panel's other browse tabs read one file each — the history
 * JSONL, the cache JSON. wowUI is built around the bundles themselves, because
 * they are the only artefact that carries *evidence*: a step's screenshot, the
 * calls the page made while it was waiting, the repair the healer proposed.
 * The rendered HTML report has all of that too, but as a document to look at
 * rather than data to group, so a "which of these eleven runs of this flow was
 * the one that broke" view cannot be built out of it.
 *
 * Two things here exist because a bundle is big:
 *
 * - **The list never carries steps.** A run with screenshots on every step is
 *   comfortably a few megabytes, and the list view shows none of it. `toCard`
 *   is the projection, and `/api/proofs` returns nothing else.
 * - **Parsed bundles are cached on `path + mtime + size`.** The page polls, and
 *   re-reading a directory of multi-megabyte JSON every few seconds to
 *   redisplay the same numbers would make the panel the slowest thing on the
 *   machine. A changed file has a changed signature, so a stale card is not a
 *   failure mode this can have.
 *
 * A run is addressed by its `runId`, never by a path from the client. The
 * lookup goes through the index this module builds, so there is no join of
 * user input onto a directory to get wrong — the same reasoning that keeps
 * `isAllowed` in `server.ts`, applied by making the question not arise.
 */

import { open, readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { ProofBundle, RunStatus, TierSummary } from '../engine/proof-bundle.js';
import { effectiveStatus, isPassing } from '../engine/proof-bundle.js';
import { harnessOnly, neverRan } from '../cli/exit.js';
import { parseProofBundle } from '../artifacts/schemas.js';
import { provenanceExtras } from '../reporter/step-facts.js';

/** Bundles read for one listing. Beyond this, the oldest are not shown. */
const DEFAULT_LIMIT = 150;

/** Where a hidden run's bundle file goes — inside the proof dir, skipped by the walk. */
export const ARCHIVED_DIR = 'archived';

/** A bundle larger than this is listed but not parsed — something is wrong with it. */
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

/**
 * What the list view needs, and nothing that would make it heavy.
 *
 * Every field is either shown on a row or decides how the row looks. The steps,
 * the screenshots, the network calls and the heal records stay on disk until
 * someone opens a run.
 */
export interface ProofCard {
  runId: string;
  name: string;
  /** The pre-rename name, when a person renamed this run in the panel. */
  renamedFrom: string | null;
  status: RunStatus;
  quarantined: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totalSteps: number;
  passed: number;
  failed: number;
  defects: number;
  /** Repairs that cost tokens. A row whose count is climbing is drifting. */
  jitHeals: number;
  /**
   * The run's whole runtime model bill — heals, agent turns, data retries and
   * reconstruction asks, from `summary`. Authoring spend is not here: it
   * belongs to the pass, not to any one run of a flow.
   */
  inputTokens: number;
  outputTokens: number;
  /**
   * What a session-billed provider charged for this run, when one ran it —
   * see `ProofSummary.session`. Absent on an API-key run, where there is no
   * session to gauge.
   */
  session?: ProofBundle['summary']['session'];
  caseRetries: number;
  cacheHits: number;
  dialogsDismissed: number;
  networkFailures: number;
  /** Steps that declined to heal because a request had already failed. */
  backendBlocked: number;
  frontend: TierSummary;
  backend: TierSummary;
  /** The ruling on a needs-review run, when one has been made. `by` names
   *  the model when the auto-review judge ruled; absent = a human. */
  review: { verdict: string; at: string; by?: string | undefined } | null;
  /** How many steps carry an `unsure` proof — the parts awaiting the ruling. */
  unsureSteps: number;
  /** 'positive' | 'negative' | null — what the test means to prove. */
  polarity: string | null;
  polaritySource: string | null;
  /** The pre-run dead-end risk, when one was judged — `fail-fast` ran once with retries off. */
  risk: { likelihood: number; failLikelihood?: number | undefined; verdict: 'run' | 'fail-fast'; reason: string | null } | null;
  /** The system-error diagnosis, when one ran: which layer broke, and the fix if any. */
  diagnosis: { origin: string; confidence: number; fix: string | null; reasoning: string } | null;
  /** 0–1, or null when the page had no controls to measure against. */
  coverage: number | null;
  trend: string | null;
  trendMessage: string | null;
  /** Set when a model wrote this flow rather than a person. */
  generatedBy: {
    model: string;
    sourceUrl: string;
    kind: string;
    generatedAt: string;
    /** The sheet's recorded Actual Result for this case — accuracy's ground
     *  truth: `passed` / `failed`, or `blocked` (the sheet's Blocked / Pending
     *  deploy, CG-01 — disclosed, never scored). Null when the sheet recorded
     *  no verdict for the row. */
    knownResult: string | null;
    source: string | null;
    /** A sheet's scenario and the row's test-case title, when authored from one. */
    scenario: string | null;
    caseTitle: string | null;
    /** The sheet's own spelling of the case id when the run qualified it
     *  (`BE:PL_03_01` → `PL_03_01`, CG-04); the sheet and category the row
     *  came from; whether every Expected line was record-only (CG-09). Read
     *  structurally from the stamp — null / false until the catalog plane
     *  writes them. */
    sheetCaseId: string | null;
    sheet: string | null;
    category: string | null;
    recordOnly: boolean;
    /** The catalog run's unique key (`<catalog>@<stamp>`) — shown on the
     *  group so a reader can match the run list to a ledger, and shared by
     *  every resume of the same run. Null for pre-key bundles. */
    runKey: string | null;
  } | null;
  /**
   * The run's open question is the SHEET's wording vs the page's rendering —
   * a deliberate-design-vs-spec call for BA triage, not a machine verdict.
   * EN-2 audit: 29 of 31 real QA fails were this class.
   */
  specQuestion: boolean;
  /**
   * Why this run delivered NO verdict about the application, when it did
   * not — the suite loop's own rule (`neverRan` ?? `harnessOnly`,
   * `cli/exit.ts`), the one that scores the case `blocked` on a catalog
   * ledger. Null when the run passed, or when some step actually contradicted
   * a claim. Carried so a row can say in words that nothing was proved and
   * quote the recorded reason (a session that never held, a database that was
   * never configured) under the chip — the same function the CLI applies,
   * never a second rule.
   */
  noVerdict: string | null;
  /** Whether opening this run will show any pictures. */
  hasEvidence: boolean;
  error: string | null;
  path: string;
  /**
   * The rendered HTML report for this run, when one is on disk.
   *
   * `path` is the proof BUNDLE — raw JSON, which is what every "open" button in
   * wowUI used to serve. Opening a run therefore showed the machine's record
   * and never the document written for a person to read. The two files are
   * written side by side (`writeProofBundle` then `writeHtmlReport`) but
   * nothing linked them: the bundle carries no report path, and the report's
   * name is slugged from the case, so neither can be derived from the other.
   * Resolved instead by `indexReports`, which reads each report's own header.
   * Null when no report was written (a `--json` run) or the file has since
   * moved.
   */
  reportPath: string | null;
}

export interface ProofIndex {
  cards: ProofCard[];
  /** `runId` → the file it was read from. The only path→run mapping wowUI has. */
  paths: Map<string, string>;
  dir: string;
  /** Files that are JSON but not a bundle, or unreadable. Reported, not hidden. */
  skipped: number;
}

export function toCard(bundle: ProofBundle, path: string, reportPath: string | null = null): ProofCard {
  return {
    runId: bundle.runId,
    reportPath,
    name: bundle.name,
    renamedFrom: bundle.renamedFrom ?? null,
    status: bundle.status,
    quarantined: bundle.quarantined === true,
    startedAt: bundle.caseStartedAt ?? bundle.startedAt,
    finishedAt: bundle.finishedAt,
    // The case span when the suite loop stamped one — pickup through every
    // repair attempt — else the single flow attempt. The card must show the
    // time a person actually waited, not the shortest attempt.
    durationMs: bundle.caseDurationMs ?? bundle.durationMs,
    totalSteps: bundle.summary.totalSteps,
    passed: bundle.summary.passed,
    failed: bundle.summary.failed,
    defects: bundle.summary.defects,
    jitHeals: bundle.summary.jitHeals,
    inputTokens: bundle.summary.inputTokens,
    outputTokens: bundle.summary.outputTokens,
    ...(bundle.summary.session === undefined ? {} : { session: bundle.summary.session }),
    caseRetries: bundle.summary.caseRetries,
    cacheHits: bundle.summary.cacheHits,
    dialogsDismissed: bundle.summary.dialogsDismissed,
    networkFailures: bundle.summary.networkFailures,
    backendBlocked: bundle.summary.backendBlocked,
    frontend: bundle.summary.frontend,
    backend: bundle.summary.backend,
    review:
      bundle.review === undefined
        ? null
        : { verdict: bundle.review.verdict, at: bundle.review.at, by: bundle.review.by },
    unsureSteps: bundle.steps.filter((s) => s.unsure !== undefined && !s.superseded).length,
    polarity: bundle.polarity ?? null,
    polaritySource: bundle.polaritySource ?? null,
    risk: bundle.risk === undefined ? null : { likelihood: bundle.risk.likelihood, ...(bundle.risk.failLikelihood === undefined ? {} : { failLikelihood: bundle.risk.failLikelihood }), verdict: bundle.risk.verdict, reason: bundle.risk.reasons[0] ?? bundle.risk.missing[0] ?? null },
    diagnosis: bundle.diagnosis === undefined ? null : { origin: bundle.diagnosis.origin, confidence: bundle.diagnosis.confidence, fix: bundle.diagnosis.fix, reasoning: bundle.diagnosis.reasoning },
    coverage: bundle.coverage?.ratio ?? null,
    trend: bundle.trend?.verdict ?? null,
    trendMessage: bundle.trend?.message ?? null,
    generatedBy:
      bundle.generatedBy === undefined
        ? null
        : {
            model: bundle.generatedBy.model,
            sourceUrl: bundle.generatedBy.sourceUrl,
            kind: bundle.generatedBy.kind,
            // Both carried for grouping: the batch's identity and its label.
            generatedAt: bundle.generatedBy.generatedAt,
            knownResult: bundle.generatedBy.knownResult ?? null,
            source: bundle.generatedBy.source ?? null,
            scenario: bundle.generatedBy.scenario ?? null,
            caseTitle: bundle.generatedBy.caseTitle ?? null,
            runKey: bundle.generatedBy.runKey ?? null,
            sheetCaseId: provenanceExtras(bundle).sheetCaseId,
            sheet: provenanceExtras(bundle).sheet,
            category: provenanceExtras(bundle).category,
            recordOnly: provenanceExtras(bundle).recordOnly,
          },
    // A filmed run has evidence for every step even when only its failures
    // carry a still, so asking about screenshots alone would report the
    // richest runs as having none.
    hasEvidence:
      bundle.video?.data !== undefined || bundle.steps.some((s) => s.screenshot !== undefined),
    specQuestion: bundle.specQuestion === true,
    noVerdict: neverRan(bundle) ?? harnessOnly(bundle),
    error: bundle.error ?? null,
    path,
  };
}

/**
 * Enough of a bundle to be worth showing — and to be SCORED: the panel
 * derives verdicts, families and the no-verdict line from a bundle's
 * statuses, so a file whose step status is not one the engine writes is not
 * a bundle with a typo, it is an artifact the panel must not rank. Parsed by
 * `ProofBundleSchema` (`src/artifacts/schemas.ts`, Phase C); a file that
 * fails is skipped exactly as a non-bundle JSON always was.
 */
function looksLikeBundle(value: unknown): value is ProofBundle {
  return parseProofBundle(value).ok;
}

interface CacheEntry {
  signature: string;
  bundle: ProofBundle;
}

/**
 * Bundles already parsed, keyed by path.
 *
 * Module-level rather than per-request: the page polls, and the point of the
 * cache is that the second poll costs a `stat` per file instead of a parse.
 */
const cache = new Map<string, CacheEntry>();

async function readBundle(path: string, signature: string): Promise<ProofBundle | null> {
  const cached = cache.get(path);
  if (cached?.signature === signature) return cached.bundle;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
  if (!looksLikeBundle(parsed)) return null;

  cache.set(path, { signature, bundle: parsed });
  return parsed;
}

/**
 * Every bundle under `dir`, newest first.
 *
 * The walk is shallow and bounded because the proof directory is ours: bundles
 * land in it directly, and a deep tree there means someone has pointed the
 * config at a directory that is not one.
 */
/**
 * How much of a report to read when looking for its run id.
 *
 * The id sits in the header block — `run <code>…</code>` under the title —
 * which lands about 25 KB in on a real report, after the inlined CSS. The rest
 * of the file is screenshots as data URIs and runs to megabytes, so reading
 * whole reports to build this map would be hundreds of MB for a link. 96 KB is
 * a wide margin over the observed offset and still cheap.
 */
const REPORT_HEAD_BYTES = 96 * 1024;

/** `run <code>76dbb6cb-…</code>` — the report naming the run it renders. */
const REPORT_RUN_ID = /run <code>([A-Za-z0-9._-]+)<\/code>/;

/**
 * Map every rendered report under `dir` to the run it belongs to.
 *
 * Matched on the report's OWN statement of its run id, never on its file name:
 * the name is slugged from the case title, so two runs of one case collide and
 * a renamed run stops matching entirely. Reading the header is the only
 * reliable link between the two files.
 *
 * Best-effort throughout — an unreadable or oddly-shaped report is skipped, and
 * a run simply has no report link. A broken link would be worse than none.
 */
export async function indexReports(dir: string): Promise<Map<string, string>> {
  const byRunId = new Map<string, string>();
  const root = resolve(dir);

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > 3 || byRunId.size > 2000) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.name.endsWith('.html')) continue;
      let head = '';
      try {
        const handle = await open(full, 'r');
        try {
          const buffer = Buffer.alloc(REPORT_HEAD_BYTES);
          const { bytesRead } = await handle.read(buffer, 0, REPORT_HEAD_BYTES, 0);
          head = buffer.subarray(0, bytesRead).toString('utf8');
        } finally {
          await handle.close();
        }
      } catch {
        continue;
      }
      const runId = REPORT_RUN_ID.exec(head)?.[1];
      // First writer wins: reports are walked newest-directory-first only by
      // accident, so a duplicate would otherwise flip between refreshes. A
      // suite index (`index.html`) names no run and is skipped by the regex.
      if (runId !== undefined && !byRunId.has(runId)) byRunId.set(runId, full);
    }
  }

  await walk(root, 0);
  return byRunId;
}

export async function readProofIndex(
  dir: string,
  limit = DEFAULT_LIMIT,
  reportDir?: string,
): Promise<ProofIndex> {
  const root = resolve(dir);
  // One walk for the whole index, not one per card: the map is built before the
  // bundles are read and every card looks its own report up by run id.
  const reports = reportDir === undefined ? new Map<string, string>() : await indexReports(reportDir);
  const files: { path: string; signature: string; mtimeMs: number }[] = [];

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > 3) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        // Runs hidden from the panel live in `archived/` — still on disk,
        // still openable by hand, just not listed. Moving the file back out
        // is the undo, and the panel's hide toast says exactly where it went.
        if (entry.name === ARCHIVED_DIR) continue;
        await walk(full, depth + 1);
      } else if (entry.name.endsWith('.json')) {
        const info = await stat(full).catch(() => null);
        if (!info || info.size > MAX_BUNDLE_BYTES) continue;
        files.push({ path: full, signature: `${info.mtimeMs}:${info.size}`, mtimeMs: info.mtimeMs });
      }
    }
  }
  await walk(root, 0);

  // Newest by mtime decides *which* runs are shown; `finishedAt` decides the
  // order they are shown in. A bundle copied onto the machine has a recent
  // mtime and an old finish time, and both of those are the truth about it.
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const considered = files.slice(0, limit);

  const cards: ProofCard[] = [];
  const paths = new Map<string, string>();
  let skipped = 0;

  for (const file of considered) {
    const bundle = await readBundle(file.path, file.signature);
    if (bundle === null) {
      skipped += 1;
      continue;
    }
    cards.push(toCard(bundle, file.path, reports.get(bundle.runId) ?? null));
    paths.set(bundle.runId, file.path);
  }

  cards.sort((a, b) => (b.finishedAt || b.startedAt).localeCompare(a.finishedAt || a.startedAt));
  return { cards, paths, dir: root, skipped };
}

/** A run id that could not be anything but a file name. */
const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;

async function loadIfBundle(path: string): Promise<ProofBundle | null> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size > MAX_BUNDLE_BYTES) return null;
  return readBundle(path, `${info.mtimeMs}:${info.size}`);
}

/**
 * One run, in full — steps, screenshots, heals and all.
 *
 * A bundle is written as `<proof dir>/<runId>.json`, so the fast path is to
 * look for exactly that, and it is only taken for a run id that cannot be a
 * path: no separator, no `..`, nothing to normalise. Anything else falls back
 * to the index, where the run id is matched against a bundle's *contents*
 * rather than against a file name — so a renamed or nested bundle still opens
 * and a crafted id still cannot reach outside the directory.
 */
export async function readProof(dir: string, runId: string): Promise<ProofBundle | null> {
  return (await readProofWithPath(dir, runId))?.bundle ?? null;
}

/**
 * The bundle AND the file it lives in — for the one write the panel makes to
 * a bundle: a human's `review` ruling on a `needs-review` run. Same
 * resolution rules as `readProof`: the id is never joined onto the directory
 * except in the shape that cannot be a path.
 */
export async function readProofWithPath(
  dir: string,
  runId: string,
): Promise<{ bundle: ProofBundle; path: string } | null> {
  const root = resolve(dir);
  if (SAFE_RUN_ID.test(runId)) {
    const directPath = join(root, `${runId}.json`);
    const direct = await loadIfBundle(directPath);
    if (direct?.runId === runId) return { bundle: direct, path: directPath };
  }

  const index = await readProofIndex(root, Number.MAX_SAFE_INTEGER);
  const path = index.paths.get(runId);
  if (path === undefined) return null;
  const bundle = await loadIfBundle(path);
  return bundle === null ? null : { bundle, path };
}

/** Drop the parsed-bundle cache. Exists so a test does not inherit one. */
export function clearProofCache(): void {
  cache.clear();
}

/**
 * One run group: everything a single authoring pass produced.
 *
 * A catalog is not one test, it is a document that becomes a case per approved
 * claim, and each case is its own run with its own bundle. Listed flat they are
 * six unrelated rows that happen to share a prefix, and the question a reader
 * actually has — *how did that catalog do?* — cannot be answered by looking.
 */
export interface RunGroup {
  /** Stable across polls, so an open group stays open across a re-render. */
  id: string;
  /** The document, when one is recorded; otherwise what else is known. */
  title: string;
  /** `catalog`, `generated`, or `run` for anything nobody authored as a batch. */
  kind: string;
  /** When the authoring pass ran. Null for ungrouped runs. */
  authoredAt: string | null;
  /**
   * The catalog run's unique key, when its bundles carry one. Display only:
   * the grouping key stays `generatedAt`, because bundles written before the
   * key existed (and carried into a resume) share only the stamp — and the
   * key embeds the stamp, so the two group identically anyway.
   */
  runKey: string | null;
  /** Earliest start and latest finish across the runs in it. */
  startedAt: string;
  finishedAt: string;
  runs: ProofCard[];
  total: number;
  passed: number;
  /**
   * Runs the SUBJECT failed (`testFailed` in `verdictKind`). Counted apart
   * from `review` (proved-? or recorded only, awaiting a person) and
   * `noVerdict` (the harness alone broke): the first cut lumped every
   * non-pass here, and a catalog whose harness fell over on twenty rows read
   * as twenty product defects.
   */
  failed: number;
  review: number;
  noVerdict: number;
  /** Cases the sheet itself recorded as Blocked / Pending — disclosed on the group, never scored. */
  sheetBlocked: number;
  defects: number;
  /** Wall-clock and runtime model tokens summed over EVERY run in the group —
   *  the pass's real cost, retries included, not just its latest verdicts. */
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * Every verdict by kind, with its share of the group. `failed` above is the
   * coarse "not passing" count; this is the split a reader asks for — proved,
   * failed, dead-end, error, proved-? — each as a count and a percentage of
   * `total`, quarantined runs included in the denominator and in none of the
   * numerators.
   */
  tally: VerdictTally;
  /**
   * How often the group's verdicts agree with the sheet's own recorded
   * results (the Actual Result column) — one verdict per case, retries
   * collapsed, rows the sheet left unverdicted disclosed as unscored. See
   * `groupAccuracy`.
   */
  accuracy: AccuracyScore;
  /** The group's runs by the sheet scenario they belong to, sheet order. */
  scenarios: ScenarioGroup[];
}

export interface AccuracyScore {
  /** Cases whose latest verdict agrees with the sheet's recorded result. */
  agreed: number;
  /** Cases the sheet recorded a result for (Passed/Failed, Re-Test included). */
  scored: number;
  /** Cases with no recorded result (blank, Cancelled, Pending) — disclosed, never scored. */
  unscored: number;
  /** agreed / scored, rounded. 0 when nothing is scored. */
  percent: number;
}

/**
 * Two families, not five words (2026-08-27): `testFailed` is the subject
 * missing the case's expectation — a contradicted assertion OR a dead-ended
 * control the flow needed (`dead-end` was a separate red word that read as a
 * third kind of outcome and never was); `systemError` is the harness breaking
 * internally, no verdict delivered. Machine statuses are unchanged
 * underneath — see `verdictFamily` in engine/proof-bundle.ts, the one rule.
 */
export type VerdictKind = 'passed' | 'testFailed' | 'systemError' | 'needsReview';

export type VerdictTally = Record<VerdictKind, { count: number; percent: number }>;

export interface ScenarioGroup {
  /** Stable across polls: the group's id plus the scenario label. */
  id: string;
  /** The sheet's scenario (`<id> <title>`), or `ungrouped` when none was recorded. */
  title: string;
  runs: ProofCard[];
  tally: VerdictTally;
}

/** Which tally bucket a run's acted-on status lands in. Null = counted in neither. */
export function verdictKind(card: ProofCard): VerdictKind | null {
  if (card.quarantined) return null;
  const status = effectiveStatus({
    status: card.status,
    review: card.review === null ? undefined : { verdict: card.review.verdict as 'proved' | 'failed', at: card.review.at },
  });
  if (isPassing(status)) return 'passed';
  if (status === 'error') return 'systemError';
  if (status === 'needs-review') return 'needsReview';
  // failed, dead-end: the subject missed the case's expectation.
  return 'testFailed';
}

/** Counts and percentages over `cards`. Percentages are of the whole list, rounded. */
export function tallyVerdicts(cards: readonly ProofCard[]): VerdictTally {
  const counts: Record<VerdictKind, number> = { passed: 0, testFailed: 0, systemError: 0, needsReview: 0 };
  for (const card of cards) {
    const kind = verdictKind(card);
    if (kind !== null) counts[kind] += 1;
  }
  const total = cards.length;
  const pct = (n: number): number => (total === 0 ? 0 : Math.round((n / total) * 100));
  return {
    passed: { count: counts.passed, percent: pct(counts.passed) },
    testFailed: { count: counts.testFailed, percent: pct(counts.testFailed) },
    systemError: { count: counts.systemError, percent: pct(counts.systemError) },
    needsReview: { count: counts.needsReview, percent: pct(counts.needsReview) },
  };
}

/**
 * Agreement with the sheet's own recorded results — the only accuracy the
 * catalog can actually state.
 *
 * The Positive/Negative column says what a case MEANS to prove, so it cannot
 * score a run: a negative case is still *expected to pass* (the app refusing
 * bad input is the pass). The ground truth is the sheet's Actual Result — a
 * person ran every case by hand and wrote down what happened — and accuracy
 * is how often wowlidator's verdict matches theirs: passed where they saw
 * Passed, failed where they saw Failed (a bug ticket on the row). A dead-end
 * or error run agrees with nothing — it delivered no verdict, and counting it
 * as agreement would reward the harness for breaking.
 *
 * One verdict per case, the latest: the list arrives newest-first, so the
 * first run seen under a name stands — a retried case is one case, not five
 * chances. Passing means the acted-on verdict (`verdictKind`), so a human
 * ruling counts and a quarantined run scores as agreement with nothing.
 * Cases whose row recorded no verdict (blank, Cancelled, Pending confirm,
 * Re-Testing) are disclosed as `unscored`, never invented into either side.
 */
export function groupAccuracy(cards: readonly ProofCard[]): AccuracyScore {
  const latest = new Map<string, ProofCard>();
  for (const card of cards) if (!latest.has(card.name)) latest.set(card.name, card);
  let agreed = 0;
  let scored = 0;
  let unscored = 0;
  for (const card of latest.values()) {
    const known = card.generatedBy?.knownResult ?? null;
    // Only a recorded pass or fail is ground truth. `blocked` (the sheet's
    // Blocked / Pending deploy, CG-01) is a row the sheet could not score
    // either — disclosed as unscored here, counted on the group as
    // `sheetBlocked`, never invented into agreement or disagreement.
    if (known !== 'passed' && known !== 'failed') {
      unscored += 1;
      continue;
    }
    scored += 1;
    const verdict = verdictKind(card);
    // Family semantics (2026-08-27): a dead-end is the subject missing the
    // case's expectation, so it agrees with a human-recorded Failed exactly
    // as a contradicted assertion does. Only a systemError still agrees with
    // nothing — the harness broke and no verdict was delivered.
    if ((verdict === 'passed' && known === 'passed') || (verdict === 'testFailed' && known === 'failed')) {
      agreed += 1;
    }
  }
  return { agreed, scored, unscored, percent: scored === 0 ? 0 : Math.round((agreed / scored) * 100) };
}

const NO_SCENARIO = 'ungrouped';

/**
 * A case id at the head of a run's name — `PL_02_03 …`, `TC-12-4 …`,
 * `DB_07 …` — two or more segments of letters/digits joined by `_` or `-`.
 * Sheets number cases inside their scenario, so the id less its last segment
 * names the scenario (`PL_02`). Used only when the run carries no stamp:
 * bundles written before `GenerationProvenance.scenario` existed.
 */
const CASE_ID_RE = /^([A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+)(?=\s|$)/;

export function inferredScenario(name: string): string | null {
  const id = CASE_ID_RE.exec(name)?.[1];
  if (id === undefined) return null;
  const cut = Math.max(id.lastIndexOf('_'), id.lastIndexOf('-'));
  return cut <= 0 ? null : id.slice(0, cut);
}

export function inferredCaseTitle(name: string): string | null {
  const id = CASE_ID_RE.exec(name)?.[1];
  if (id === undefined) return null;
  const rest = name.slice(id.length).trim();
  return rest === '' ? null : rest;
}

/** The stamp when there is one, the name's own case id otherwise. */
export function scenarioOf(card: Pick<ProofCard, 'name' | 'generatedBy'>): string {
  return card.generatedBy?.scenario ?? inferredScenario(card.name) ?? NO_SCENARIO;
}

/** Split a group's runs by scenario, keeping first-seen order (the sheet's). */
export function groupScenarios(groupId: string, runs: readonly ProofCard[]): ScenarioGroup[] {
  const map = new Map<string, ProofCard[]>();
  for (const card of runs) {
    const title = scenarioOf(card);
    const list = map.get(title);
    if (list === undefined) map.set(title, [card]);
    else list.push(card);
  }
  return [...map.entries()].map(([title, cards]) => ({
    id: `${groupId}|${title}`,
    title,
    runs: cards,
    tally: tallyVerdicts(cards),
  }));
}

/**
 * Group runs by the authoring pass that produced them.
 *
 * The key is `generatedBy.generatedAt` — the moment the pass ran — and not the
 * document's name, which is the whole point: **running the same catalog again
 * makes a new group.** A name-keyed grouping would pile this morning's six
 * cases on top of last night's six and report twelve runs of a six-case
 * catalog, with a pass rate averaged across two different versions of the
 * application. Measured on the proof directory this was written against: five
 * passes of one catalog, `generatedAt` distinct for every one of them.
 *
 * A run with no provenance — `wow run some.flow.json`, a hand-written flow — is
 * its own group of one rather than being swept into a shared "other" bucket:
 * those runs are unrelated to each other, and saying so is cheaper than
 * implying a relationship that does not exist.
 *
 * Groups come back newest-first, and so do the runs inside them, which is the
 * order the list already arrives in.
 */
export function groupRuns(cards: readonly ProofCard[]): RunGroup[] {
  const groups = new Map<string, RunGroup>();

  for (const card of cards) {
    const provenance = card.generatedBy;
    const batch = provenance?.generatedAt ?? null;
    const id = batch === null ? `run:${card.runId}` : `batch:${batch}`;

    let group = groups.get(id);
    if (group === undefined) {
      group = {
        id,
        title:
          provenance === null || provenance === undefined
            ? card.name
            : (provenance.source ?? provenance.sourceUrl),
        kind: provenance?.kind ?? 'run',
        authoredAt: batch,
        runKey: provenance?.runKey ?? null,
        startedAt: card.startedAt,
        finishedAt: card.finishedAt,
        runs: [],
        total: 0,
        passed: 0,
        failed: 0,
        review: 0,
        noVerdict: 0,
        sheetBlocked: 0,
        defects: 0,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        tally: tallyVerdicts([]),
        accuracy: groupAccuracy([]),
        scenarios: [],
      };
      groups.set(id, group);
    }

    group.runs.push(card);
    // Any bundle of the pass may be the one that carries the key — bundles
    // from before the key existed carry none, and a resume adds keyed ones.
    group.runKey ??= provenance?.runKey ?? null;
    group.total += 1;
    // A quarantined run is reported in full and counted as neither: the flag
    // exists so a known-flaky result cannot be read as a verdict either way.
    // The other four buckets follow `verdictKind` — the acted-on status, so a
    // ruled proved-? counts where the ruling put it.
    const kind = verdictKind(card);
    if (kind === 'passed') group.passed += 1;
    else if (kind === 'testFailed') group.failed += 1;
    else if (kind === 'needsReview') group.review += 1;
    else if (kind === 'systemError') group.noVerdict += 1;
    if (card.generatedBy?.knownResult === 'blocked') group.sheetBlocked += 1;
    group.defects += card.defects;
    group.durationMs += card.durationMs;
    group.inputTokens += card.inputTokens;
    group.outputTokens += card.outputTokens;
    if (card.startedAt < group.startedAt) group.startedAt = card.startedAt;
    if (card.finishedAt > group.finishedAt) group.finishedAt = card.finishedAt;
  }

  for (const group of groups.values()) {
    group.tally = tallyVerdicts(group.runs);
    group.accuracy = groupAccuracy(group.runs);
    group.scenarios = groupScenarios(group.id, group.runs);
  }
  return [...groups.values()].sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1));
}
