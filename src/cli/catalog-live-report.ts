/**
 * The catalog report as a LIVE document (asked for 2026-09-02).
 *
 * The report used to be written once, at the suite roll-up. Now it exists
 * from the moment the run starts — every planned case a `never ran` row — and
 * is rewritten after each case finishes, so the panel's Report button opens
 * the current state of the catalog at any point of the run, not a file that
 * appears an hour later. Alongside it, `excel-export.ts` writes the run
 * workbook and one workbook per planned case.
 *
 * Everything is derived from the LEDGER (`suite-progress.ts`): the plan, each
 * verdict, where each proof bundle landed. A bundle is read from memory when
 * this process produced it and from its `proofPath` when an earlier pass did,
 * which is what makes a resume's report answer for the whole catalog under
 * one run key rather than for the subset this process ran — and what lets
 * `wowlidator report` rebuild the same file from disk with no run at all.
 *
 * Writes are serialised and coalesced: cases finish concurrently, the file
 * carries every screenshot inline or beside the HTML, and two writers racing
 * on one path would leave a torn report. A refresh requested in flight runs
 * once more after it, never in parallel. Never fatal: a report that cannot be
 * written must not fail the suite that earned the verdicts.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ProofBundle } from '../engine/proof-bundle.js';
import { RunHistory, analyseTrend, formatTrend } from '../history/run-history.js';
import {
  catalogReportPath,
  catalogCaseExportName,
  catalogMediaDirName,
  renderCatalogReport,
  writeCatalogReport,
  type CatalogReportCase,
  type CatalogReportInput,
} from '../reporter/catalog-report.js';
import { caseVideoFile, writeRunExcel, type ExcelExportResult } from '../reporter/excel-export.js';
import { writeFindingsExports, type FindingsExportResult } from '../reporter/findings-export.js';
import { caseIdOf, type SuiteLedger } from './suite-progress.js';

/**
 * The `PL_06` a planned id `PL_06_05` belongs to, when nothing better is
 * known — or the `HIR-EC` family of a dashed id `HIR-EC-006`. Only a
 * fallback: a case that ran carries the sheet's own scenario in its bundle
 * (`generatedBy.scenario`), and `buildCatalogReportCases` prefers that.
 * Before the dashed form was read (2026-09-05), a 269-scenario catalog
 * rebuilt with `wowlidator report` showed every case under "ungrouped".
 */
export function scenarioFromId(id: string): string {
  return id.match(/^([A-Za-z]+_\d+)/)?.[1] ?? id.match(/^([A-Za-z]+(?:-[A-Za-z]+)+)-\d+/)?.[1] ?? 'ungrouped';
}

/**
 * One case row per planned id, in plan order. `bundleOf` answers from memory
 * or disk; `historyOf` supplies the explanation lines (trend, heal pressure)
 * for a case that has a bundle.
 */
export async function buildCatalogReportCases(
  ledger: SuiteLedger,
  bundleOf: (id: string) => Promise<ProofBundle | null>,
  scenarioOf: (id: string) => string = scenarioFromId,
  historyOf: (bundle: ProofBundle) => Promise<readonly string[]> = async () => [],
): Promise<CatalogReportCase[]> {
  const cases: CatalogReportCase[] = [];
  for (const id of ledger.planned) {
    const outcome = ledger.outcomes[id];
    const bundle = outcome === undefined ? null : await bundleOf(id);
    // The sheet's scenario travels in the bundle; the id-shape guess is for a
    // case that never ran (no bundle) and for a caller with no plan in hand.
    const named = scenarioOf(id);
    const fromBundle = bundle?.generatedBy?.scenario;
    const scenarioId = ledger.authored?.[id]?.scenarioId ?? bundle?.generatedBy?.scenarioId;
    cases.push({
      id,
      scenarioId,
      name: outcome?.name ?? id,
      scenario: named !== 'ungrouped' ? named : (fromBundle ?? named),
      verdict: outcome === undefined ? 'never-ran' : outcome.verdict,
      status: outcome?.status ?? null,
      reason: outcome?.reason ?? null,
      bundle,
      history: bundle === null ? [] : await historyOf(bundle),
    });
  }
  return cases;
}

export interface CatalogArtifacts {
  htmlPath: string;
  excel: ExcelExportResult;
  /** `<base>-findings.md` and `<base>-findings.xlsx` — the root causes, model-free (`reporter/findings-export.ts`). */
  findings: FindingsExportResult;
}

/**
 * Render and write the report, its workbooks and the findings export — the
 * one place all of them happen, so `wowlidator report` rebuilds every file
 * from the ledgers on disk without a re-run.
 */
export async function writeCatalogArtifacts(input: CatalogReportInput, cwd?: string): Promise<CatalogArtifacts> {
  const htmlPath = catalogReportPath(input.runKey, input.title, cwd);
  const mediaDirName = catalogMediaDirName(input.runKey, input.title);
  const mediaDir = join(dirname(htmlPath), mediaDirName);
  const shotsDir = join(dirname(htmlPath), mediaDirName, 'shots');
  const excelVideoCases = new Set(
    input.cases
      .filter((c) => typeof c.bundle?.video?.data === 'string' && c.bundle.video.data !== '')
      .map((c) => c.id),
  );
  const spilledRecordingCases = new Set<string>();
  let shotsDirReady = false;
  const spillScreenshot = (caseId: string, stepIndex: number, base64: string): string | null => {
    try {
      if (!shotsDirReady) {
        mkdirSync(shotsDir, { recursive: true });
        shotsDirReady = true;
      }
      const fileName = `${catalogCaseExportName(caseId)}-${stepIndex}.jpg`;
      writeFileSync(join(shotsDir, fileName), Buffer.from(base64, 'base64'));
      return `${mediaDirName}/shots/${fileName}`;
    } catch {
      return null;
    }
  };
  const spillRecording = (caseId: string, base64: string): string | null => {
    try {
      const fileName = caseVideoFile(caseId);
      const path = join(mediaDir, fileName);
      if (!excelVideoCases.has(caseId)) {
        mkdirSync(mediaDir, { recursive: true });
        writeFileSync(path, Buffer.from(base64, 'base64'));
      }
      if (!excelVideoCases.has(caseId)) spilledRecordingCases.add(caseId);
      return `${mediaDirName}/${fileName}`;
    } catch {
      return null;
    }
  };
  await writeCatalogReport(htmlPath, renderCatalogReport({ ...input, spillScreenshot, spillRecording }));
  const excel = await writeRunExcel(htmlPath, input, spilledRecordingCases);
  const findings = await writeFindingsExports(htmlPath, input);
  return { htmlPath, excel, findings };
}

/** The history lines the report explains a case with, from the run log. */
export async function historyLinesFor(history: RunHistory, bundle: ProofBundle): Promise<string[]> {
  try {
    const prior = await history.forFlow(bundle.name);
    const trend = analyseTrend(bundle, prior.slice(0, -1));
    const lines = [formatTrend(trend)];
    const heals = prior.reduce((sum, e) => sum + e.jitHeals, 0);
    if (heals > 0) lines.push(`${heals} heal(s) paid across the recorded runs — the selectors are drifting`);
    return lines;
  } catch {
    return [];
  }
}

export interface CatalogLiveReportOptions {
  /** The ledger as it stands now — read at every refresh, never copied. */
  ledger: () => SuiteLedger;
  /** The scenario a planned id belongs to (`PL_06`); the id's prefix otherwise. */
  scenarioOf?: ((id: string) => string | undefined) | undefined;
  /** The run log, when history is on — supplies the per-case explanations. */
  history?: RunHistory | null | undefined;
  /** Where a failure to write is reported. */
  onError?: ((message: string) => void) | undefined;
  /** Working directory the `reports/` folder is resolved under. */
  cwd?: string | undefined;
}

export class CatalogLiveReport {
  readonly #options: CatalogLiveReportOptions;
  /** Bundles this process produced, by planned id. */
  readonly #bundles = new Map<string, ProofBundle>();
  /** Bundles re-read from an earlier pass's proof file, by proof path. */
  readonly #fromDisk = new Map<string, ProofBundle | null>();
  /** History explanations, computed once per recorded bundle. */
  readonly #history = new Map<string, readonly string[]>();
  #inFlight: Promise<CatalogArtifacts | null> | null = null;
  #again = false;
  #final = false;
  #last: CatalogArtifacts | null = null;

  constructor(options: CatalogLiveReportOptions) {
    this.#options = options;
  }

  /** The artifacts of the most recent successful write. */
  get last(): CatalogArtifacts | null {
    return this.#last;
  }

  /**
   * A case finished in this process. Its bundle is the freshest evidence
   * there is, so it outranks whatever the ledger's proof path says.
   */
  record(name: string, bundle: ProofBundle | null): void {
    const id = caseIdOf(name);
    if (bundle === null) {
      this.#bundles.delete(id);
      this.#history.delete(id);
      return;
    }
    this.#bundles.set(id, bundle);
    this.#history.delete(id);
  }

  /**
   * Rewrite the report from the ledger as it stands. Concurrent calls
   * collapse into one more write after the current one; `final` marks the
   * run as over so the page stops reloading itself.
   */
  refresh(final = false): Promise<CatalogArtifacts | null> {
    if (final) this.#final = true;
    if (this.#inFlight !== null) {
      this.#again = true;
      return this.#inFlight.then(() => this.#last);
    }
    this.#inFlight = this.#write().finally(() => {
      this.#inFlight = null;
      if (this.#again) {
        this.#again = false;
        void this.refresh();
      }
    });
    return this.#inFlight;
  }

  /** Wait for every pending write — what the roll-up does before it prints paths. */
  async settle(): Promise<CatalogArtifacts | null> {
    while (this.#inFlight !== null) await this.#inFlight;
    return this.#last;
  }

  async #bundleOf(id: string): Promise<ProofBundle | null> {
    const fresh = this.#bundles.get(id);
    if (fresh !== undefined) return fresh;
    const proofPath = this.#options.ledger().outcomes[id]?.proofPath;
    if (typeof proofPath !== 'string' || proofPath === '') return null;
    if (!this.#fromDisk.has(proofPath)) {
      const bundle = await readFile(proofPath, 'utf8')
        .then((text) => JSON.parse(text) as ProofBundle)
        .catch(() => null);
      this.#fromDisk.set(proofPath, bundle);
    }
    return this.#fromDisk.get(proofPath) ?? null;
  }

  async #historyOf(bundle: ProofBundle): Promise<readonly string[]> {
    const history = this.#options.history;
    if (history === null || history === undefined) return [];
    const id = caseIdOf(bundle.name);
    const known = this.#history.get(id);
    if (known !== undefined) return known;
    const lines = await historyLinesFor(history, bundle);
    this.#history.set(id, lines);
    return lines;
  }

  async #write(): Promise<CatalogArtifacts | null> {
    try {
      const ledger = this.#options.ledger();
      const cases = await buildCatalogReportCases(
        ledger,
        (id) => this.#bundleOf(id),
        (id) => this.#options.scenarioOf?.(id) ?? scenarioFromId(id),
        (bundle) => this.#historyOf(bundle),
      );
      const input: CatalogReportInput = {
        title: ledger.title,
        runKey: ledger.runKey,
        generatedAt: ledger.generatedAt,
        cases,
        live: !this.#final,
      };
      this.#last = await writeCatalogArtifacts(input, this.#options.cwd);
      return this.#last;
    } catch (error) {
      this.#options.onError?.(error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error));
      return null;
    }
  }
}
