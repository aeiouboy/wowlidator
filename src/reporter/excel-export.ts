/**
 * The catalog-run Excel export (asked for 2026-09-02, widened 2026-09-07).
 *
 * Two shapes of the same workbook, both covering every planned case:
 *
 * - **one workbook per CASE**, `<report>-media/<case id>.xlsx` — what the
 *   catalog report's per-case `Export (Excel)` button downloads.
 * - **one workbook per RUN**, `<report>-cases.xlsx`, every case in one sheet
 *   with failed, review and blocked cases before passed cases.
 *
 * Each step is one row: what it did (action, description, selector), the
 * **Target column** — what that selector WAS on the page: role, name, where
 * it sat (`describeTarget`) — the result, the duration, the **Proof column** — the step's own log: expected
 * vs actual, how the selector resolved, a heal, an error — and the **Photo
 * column** with the step's screenshot embedded in the cell. Under every step
 * sits a video row linking into the case's recording, with the step's own
 * offset named — Excel cannot play an embedded webm, so the recording is
 * written out as a real file next to the workbook (`<report>-media/…`) and
 * the row's hyperlink opens it in the machine's own player. A file, not a
 * silent omission: "video attached under the step" that goes nowhere would be
 * a dead control pretending to be evidence.
 *
 * **A rerun updates, never accumulates.** Every name is derived from the run
 * key and the case id, so re-running a case overwrites its own workbook. The
 * old `<report>-passed.xlsx` is removed when the all-case workbook is written.
 *
 * The container is written by hand, same decision as `catalog/extract.ts`
 * reading one and `engine/webm.ts` cutting one: `node:zlib` supplies deflate
 * and crc32, and the workbook uses inline strings so there is no shared-string
 * table to keep consistent. The writer is tested against `extract.ts`'s own
 * zip READER — two independent implementations, so a workbook only the writer
 * itself can decode fails the suite.
 */

import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

import { describeDbChanges, describeTarget, describeValueSource, expectedActual, type ProofStep } from '../engine/proof-bundle.js';
import { catalogCaseExportName, verdictChipOf, type CatalogReportCase, type CatalogReportInput } from './catalog-report.js';
import { describeAgentAction, describeResolution, observedEvidence, stepKindFacts, stepTarget } from './step-facts.js';

/* ------------------------------------------------------------- zip writer */

export interface ZipInput {
  name: string;
  data: Buffer;
}

/**
 * Just enough ZIP to write an `.xlsx`: local headers with true sizes (no data
 * descriptors — the reader in `extract.ts` trusts the central directory, and
 * so does Excel), deflate when it helps, stored when it does not (a JPEG or a
 * webm re-deflated only grows).
 */
export function buildZip(files: readonly ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data) >>> 0;
    const deflated = deflateRawSync(file.data, { level: 9 });
    const useDeflate = deflated.length < file.data.length;
    const payload = useDeflate ? deflated : file.data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // extra, comment, disk, internal attrs, external attrs all zero (30..41)
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + payload.length;
  }
  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

/* ------------------------------------------------------------ xlsx pieces */

function xmlEsc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control characters are not legal in XML 1.0 and Excel refuses the file.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
}

const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'] as const;
const LAST_COL = COLS[COLS.length - 1];
/** 0-based index of the Photo column — where each screenshot is anchored. */
const PHOTO_COL = COLS.length - 1;
/** Height (points) of a row carrying an embedded screenshot. */
const PHOTO_ROW_HT = 110;
/**
 * Matches the HTML report's 15 MB routine-still allowance: it keeps the file
 * portable while failing-step screenshots remain exempt as the evidence a
 * reader needs first.
 */
export const EXCEL_IMAGE_BUDGET_BYTES = 15_000_000;

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 120) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

/** Style indexes into `styles.xml`'s cellXfs. */
const S = { wrap: 0, bold: 1, link: 2 } as const;

interface SheetImage {
  /** 0-based row the image's cell is on. */
  row: number;
  /** JPEG bytes. */
  data: Buffer;
  name: string;
}

interface SheetLink {
  /** `B7` — the cell carrying the hyperlink. */
  ref: string;
  /** Relative target, forward slashes. */
  target: string;
}

interface SheetBuild {
  rows: string[];
  merges: string[];
  images: SheetImage[];
  links: SheetLink[];
}

function textCell(ref: string, value: string, style: number): string {
  if (value === '') return '';
  return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xmlEsc(value)}</t></is></c>`;
}

function numberCell(ref: string, value: number, style: number): string {
  return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
}

function rowXml(r: number, cells: string, ht?: number): string {
  const height = ht === undefined ? '' : ` ht="${ht}" customHeight="1"`;
  return `<row r="${r}"${height}>${cells}</row>`;
}

/** A row of one merged cell spanning C..K (A and B keep Case and Verdict clear). */
function bandRow(build: SheetBuild, r: number, text: string, style: number, link?: string): void {
  const ref = `C${r}`;
  build.rows.push(rowXml(r, textCell(ref, text, style)));
  build.merges.push(`C${r}:${LAST_COL}${r}`);
  if (link !== undefined) build.links.push({ ref, target: link });
}

export interface CaseVideoFile {
  caseId: string;
  /** File name inside the media directory. */
  file: string;
  bytes: Buffer;
}

/** The passed cases of a catalog run — `pass**` included, it IS a pass. */
export function passedCases(input: CatalogReportInput): CatalogReportCase[] {
  return input.cases.filter((c) => c.verdict === 'passed');
}

export function reportedCases(input: CatalogReportInput): CatalogReportCase[] {
  const ordered = ['failed', 'review', 'blocked', 'never-ran', 'passed'] as const;
  const known = ordered.flatMap((verdict) => input.cases.filter((c) => c.verdict === verdict));
  const other = input.cases.filter((c) => !ordered.some((verdict) => c.verdict === verdict));
  return [...known, ...other];
}

interface ImagePlan {
  included: ReadonlySet<ProofStep>;
  omitted: number;
}

function imagePlan(cases: readonly CatalogReportCase[]): ImagePlan {
  const included = new Set<ProofStep>();
  let routineLeft = EXCEL_IMAGE_BUDGET_BYTES;
  let omitted = 0;
  const steps = cases.flatMap((c) => (c.bundle?.steps ?? []).filter((step) => !step.superseded));
  for (const step of steps) {
    if (!step.screenshot || step.status === 'passed' || step.status === 'skipped') continue;
    included.add(step);
  }
  for (const step of steps) {
    if (!step.screenshot || included.has(step)) continue;
    if (routineLeft >= step.screenshot.length) {
      routineLeft -= step.screenshot.length;
      included.add(step);
    } else {
      omitted += 1;
    }
  }
  return { included, omitted };
}

/**
 * The step's own log, as the Proof column carries it: what the assertion
 * compared, how the selector was found, what healed or broke. One line per
 * fact, in the order a reader checks them.
 */
export function stepProof(step: ProofStep): string {
  const lines: string[] = [];
  const comparison = expectedActual(step);
  if (comparison !== null) lines.push(comparison);
  // The kind's own facts — the alternatives of an either/or, an upload's
  // file NAMES, a sign-in's persona LABEL, the author's timeout. A workbook
  // is handed over as the proof; it must carry what the step WAS and never
  // a credential (see `step-facts.ts`).
  for (const fact of stepKindFacts(step)) lines.push(`${fact.label}: ${fact.value.replace(/\n/g, '; ')}`);
  const target = describeTarget(step.target);
  if (target !== null) lines.push(`target: ${target}`);
  const valueFrom = describeValueSource(step);
  if (valueFrom !== null) lines.push(`value source: ${valueFrom}`);
  // `resolved via <rung>` stays the first words (pinned) — the plain-language
  // label follows, so `reveal` and `scroll` explain themselves in the cell.
  const how = describeResolution(step.resolution);
  if (how !== null) lines.push(`resolved via ${step.resolution} — ${how.label}`);
  if (step.resolvedSelector && step.resolvedSelector !== step.selector) lines.push(`resolved as ${step.resolvedSelector}`);
  if (step.heal) lines.push(`healed → ${step.heal.to} (${step.heal.strategy}, ${(step.heal.confidence * 100).toFixed(0)}%)`);
  if (step.blocked) {
    // The typed hold (Phase B): the one fact a sheet reader needs from this
    // step is that it is not a finding.
    lines.push(`held (${step.blocked.reason}, ${step.blocked.rule}) — no verdict about the application: ${step.blocked.message}`);
  }
  if (step.agent) {
    lines.push(`agent: ${step.agent.summary ?? ''} (${step.agent.turns} turn(s))`.trim());
    // The turns that carry meaning beyond a click: what was saved for later
    // steps, where the session ended, and what the harness withheld. Every
    // other turn is in the bundle.
    for (const a of step.agent.actions ?? []) {
      if (a.outcome?.kind === 'blocked') {
        lines.push(`agent ${a.action} held (${a.outcome.reason}): ${a.outcome.message}`);
        continue;
      }
      if (a.action !== 'save' && a.action !== 'signOut') continue;
      const { target: aimed, note } = describeAgentAction(a);
      lines.push(`agent ${a.action}: ${aimed}${note ? ` — ${note}` : ''}`);
    }
  }
  for (const o of observedEvidence(step)) lines.push(`observed: ${JSON.stringify(o.text)}${o.selector ? ` from ${o.selector}` : ''}`);
  for (const line of describeDbChanges(step.dbChanges)) lines.push(line);
  if (step.dbProbeError) lines.push(`db baseline probe failed: ${step.dbProbeError}`);
  if (step.url) lines.push(`at ${step.url}`);
  if (step.error) lines.push(`error: ${step.error.split('\n')[0] ?? step.error}`);
  return lines.join('\n');
}

function stepRows(
  build: SheetBuild,
  c: CatalogReportCase,
  step: ProofStep,
  r: number,
  videoHref: string | null,
  images: ImagePlan,
): number {
  const hasScreenshot = typeof step.screenshot === 'string' && step.screenshot !== '';
  const hasPhoto = hasScreenshot && images.included.has(step);
  const cells =
    textCell(`A${r}`, c.id, S.wrap) +
    textCell(`B${r}`, c.verdict, S.wrap) +
    numberCell(`C${r}`, step.index, S.wrap) +
    textCell(`D${r}`, step.action, S.wrap) +
    textCell(`E${r}`, step.intent ?? '', S.wrap) +
    // The Selector column says what the step was aimed at — for a kind with
    // no single selector, the record's own account (`stepTarget`), never blank.
    textCell(`F${r}`, stepTarget(step) ?? '', S.wrap) +
    textCell(`G${r}`, describeTarget(step.target) ?? '', S.wrap) +
    textCell(`H${r}`, step.status + (step.heal ? ' (healed)' : ''), S.wrap) +
    textCell(`I${r}`, fmtMs(step.durationMs), S.wrap) +
    textCell(`J${r}`, stepProof(step), S.wrap) +
    (hasPhoto
      ? ''
      : textCell(
          `K${r}`,
          hasScreenshot ? 'omitted for size — it stays in the proof bundle' : videoHref === null ? '—' : 'see the video row below',
          S.wrap,
        ));
  build.rows.push(rowXml(r, cells, hasPhoto ? PHOTO_ROW_HT : undefined));
  if (hasPhoto) {
    build.images.push({
      row: r - 1,
      data: Buffer.from(step.screenshot as string, 'base64'),
      name: `${c.id} step ${step.index}`,
    });
  }
  r += 1;
  // The video row under the step: one recording per run, addressed per step —
  // the link opens the file, the text names where in it this step begins.
  if (videoHref !== null) {
    const at = step.videoOffsetMs === undefined ? '' : ` — this step starts at ${fmtMs(step.videoOffsetMs)} in`;
    bandRow(build, r, `▶ video: ${videoHref}${at}`, S.link, videoHref);
    r += 1;
  }
  return r;
}

export interface WorkbookBuild {
  xlsx: Buffer;
  videos: CaseVideoFile[];
  cases: number;
  embeddedImages: number;
  omittedImages: number;
}

/** `<case id slug>.webm` — the recording's file name inside the media directory. */
export function caseVideoFile(caseId: string): string {
  return `${catalogCaseExportName(caseId)}.webm`;
}

function headerRow(build: SheetBuild, r: number): void {
  build.rows.push(
    rowXml(
      r,
      textCell(`A${r}`, 'Case', S.bold) +
        textCell(`B${r}`, 'Verdict', S.bold) +
        textCell(`C${r}`, 'Step', S.bold) +
        textCell(`D${r}`, 'Action', S.bold) +
        textCell(`E${r}`, 'Description', S.bold) +
        textCell(`F${r}`, 'Selector', S.bold) +
        textCell(`G${r}`, 'Target', S.bold) +
        textCell(`H${r}`, 'Result', S.bold) +
        textCell(`I${r}`, 'Duration', S.bold) +
        textCell(`J${r}`, 'Proof', S.bold) +
        textCell(`K${r}`, 'Photo', S.bold),
    ),
  );
}

function bandVerdict(c: CatalogReportCase): string {
  const chip = verdictChipOf(c).label;
  if (c.verdict === 'blocked') return 'blocked (no verdict)';
  if (c.verdict === 'review') return chip === 'recorded only' ? chip : 'proved-? (a human must rule)';
  if (c.verdict === 'never-ran') return 'never ran (no verdict)';
  if (c.verdict === 'failed') return chip === 'system error' ? 'failed (system error)' : 'failed';
  if (c.verdict === 'passed' && chip === 'pass**') return 'passed (pass**)';
  return chip;
}

/**
 * The rows of one case: a bold case band, then one row per step (superseded
 * attempts excluded, same rule as the HTML) with the screenshot in the Photo
 * column and the video row beneath. `videoDir` is where the recording will
 * sit RELATIVE to the workbook — `''` when they share a folder.
 */
function caseRows(
  build: SheetBuild,
  videos: CaseVideoFile[],
  c: CatalogReportCase,
  videoDir: string,
  r: number,
  images: ImagePlan,
): number {
  const video = c.bundle?.video;
  let videoHref: string | null = null;
  if (typeof video?.data === 'string' && video.data !== '') {
    const file = caseVideoFile(c.id);
    videos.push({ caseId: c.id, file, bytes: Buffer.from(video.data, 'base64') });
    videoHref = videoDir === '' ? file : `${videoDir}/${file}`;
  }
  const verdict = bandVerdict(c);
  const reason = c.verdict === 'blocked' && c.reason ? ` — ${c.reason}` : '';
  const trimmedName = c.name.trim();
  const name = trimmedName === c.id || trimmedName.startsWith(`${c.id} `) ? trimmedName : `${c.id} — ${trimmedName}`;
  const cells = textCell(`A${r}`, c.id, S.bold) + textCell(`B${r}`, c.verdict, S.bold) + textCell(`C${r}`, `${name} — ${verdict}${reason}`, S.bold);
  build.rows.push(rowXml(r, cells));
  build.merges.push(`C${r}:${LAST_COL}${r}`);
  r += 1;
  const steps = (c.bundle?.steps ?? []).filter((s) => !s.superseded);
  if (steps.length === 0) {
    bandRow(build, r, 'No steps were recorded for this case.', S.wrap);
    r += 1;
  }
  for (const step of steps) r = stepRows(build, c, step, r, videoHref, images);
  return r;
}

/**
 * The run's workbook: header row, then every case in attention order. The
 * recordings live in `<mediaDirName>/` beside the workbook, so the links
 * point down into it.
 */
export function buildRunWorkbook(input: CatalogReportInput, mediaDirName: string): WorkbookBuild {
  const cases = reportedCases(input);
  const build: SheetBuild = { rows: [], merges: [], images: [], links: [] };
  const videos: CaseVideoFile[] = [];
  const images = imagePlan(cases);
  let r = 1;
  if (images.omitted > 0) {
    build.rows.push(rowXml(r, textCell(`A${r}`, `${images.omitted} routine screenshot(s) omitted for size — every one stays in its proof bundle.`, S.wrap)));
    build.merges.push(`A${r}:${LAST_COL}${r}`);
    r += 1;
  }
  headerRow(build, r);
  r += 1;
  if (cases.length === 0) {
    bandRow(build, r, 'No cases in this run.', S.wrap);
    r += 1;
  }
  for (const c of cases) r = caseRows(build, videos, c, mediaDirName, r, images);
  return {
    xlsx: buildZip(workbookParts(build, 'Run cases')),
    videos,
    cases: cases.length,
    embeddedImages: build.images.length,
    omittedImages: images.omitted,
  };
}

/**
 * One case as its own workbook — the file the report's per-case
 * `Export (Excel)` button downloads. It sits IN the media directory, beside
 * the case's own recording, so the video rows link by bare file name.
 *
 */
export function buildCaseWorkbook(c: CatalogReportCase): WorkbookBuild {
  const build: SheetBuild = { rows: [], merges: [], images: [], links: [] };
  const videos: CaseVideoFile[] = [];
  const images = imagePlan([c]);
  let r = 1;
  if (images.omitted > 0) {
    build.rows.push(rowXml(r, textCell(`A${r}`, `${images.omitted} routine screenshot(s) omitted for size — every one stays in its proof bundle.`, S.wrap)));
    build.merges.push(`A${r}:${LAST_COL}${r}`);
    r += 1;
  }
  headerRow(build, r);
  caseRows(build, videos, c, '', r + 1, images);
  return {
    xlsx: buildZip(workbookParts(build, catalogCaseExportName(c.id).slice(0, 31))),
    videos,
    cases: 1,
    embeddedImages: build.images.length,
    omittedImages: images.omitted,
  };
}

/** The column widths of the step workbooks — Case, Verdict, Step, Action, Description, Selector, Target, Result, Duration, Proof, Photo. */
const STEP_SHEET_WIDTHS = [14, 12, 6, 16, 44, 36, 34, 14, 10, 46, 45] as const;

export interface TextWorkbookInput {
  sheetName: string;
  /** One sentence written alone in the first row, above the header — a rule or a headline the reader needs before the columns. */
  preface?: string | undefined;
  header: readonly string[];
  rows: readonly (readonly string[])[];
  /** Column widths, one per header column; the step sheet's when omitted. */
  widths?: readonly number[] | undefined;
}

/**
 * A plain text sheet through the same writer as the step workbooks — header
 * row bold, every cell wrapped, no images, no links. What the findings
 * export (`findings-export.ts`) is built with; at most `COLS.length` columns.
 */
export function buildTextWorkbook(input: TextWorkbookInput): Buffer {
  if (input.header.length > COLS.length) {
    throw new Error(`buildTextWorkbook: ${input.header.length} columns asked for, ${COLS.length} available`);
  }
  const build: SheetBuild = { rows: [], merges: [], images: [], links: [] };
  let r = 1;
  if (input.preface !== undefined && input.preface !== '') {
    build.rows.push(rowXml(r, textCell(`A${r}`, input.preface, S.wrap)));
    build.merges.push(`A${r}:${COLS[input.header.length - 1]}${r}`);
    r += 1;
  }
  const cells = (values: readonly string[], style: number, row: number): string =>
    values.map((value, i) => textCell(`${COLS[i]}${row}`, value, style)).join('');
  build.rows.push(rowXml(r, cells(input.header, S.bold, r)));
  r += 1;
  for (const row of input.rows) {
    build.rows.push(rowXml(r, cells(row.slice(0, input.header.length), S.wrap, r)));
    r += 1;
  }
  return buildZip(workbookParts(build, input.sheetName.slice(0, 31), input.widths ?? STEP_SHEET_WIDTHS.slice(0, input.header.length)));
}

function workbookParts(build: SheetBuild, sheetName: string, widths: readonly number[] = STEP_SHEET_WIDTHS): ZipInput[] {
  const hasImages = build.images.length > 0;
  const xml = (body: string): Buffer => Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`, 'utf8');

  const contentTypes = xml(
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      (hasImages ? '<Default Extension="jpeg" ContentType="image/jpeg"/>' : '') +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      (hasImages ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : '') +
      '</Types>',
  );

  const rootRels = xml(
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
  );

  const workbook = xml(
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets><sheet name="${xmlEsc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );

  const workbookRels = xml(
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>',
  );

  const styles = xml(
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="3">' +
      '<font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
      '<font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font>' +
      '</fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="3">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf>' +
      '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf>' +
      '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>',
  );

  // Sheet relationship ids: the drawing first (when present), hyperlinks after.
  const sheetRels: string[] = [];
  let relId = 1;
  const drawingRelId = hasImages ? `rId${relId++}` : null;
  if (drawingRelId !== null) {
    sheetRels.push(
      `<Relationship Id="${drawingRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>`,
    );
  }
  const linkXml: string[] = [];
  for (const link of build.links) {
    const id = `rId${relId++}`;
    sheetRels.push(
      `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEsc(
        link.target,
      )}" TargetMode="External"/>`,
    );
    linkXml.push(`<hyperlink ref="${link.ref}" r:id="${id}"/>`);
  }

  const cols = widths
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join('');
  const sheet = xml(
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<cols>${cols}</cols>` +
      `<sheetData>${build.rows.join('')}</sheetData>` +
      (build.merges.length === 0
        ? ''
        : `<mergeCells count="${build.merges.length}">${build.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`) +
      (linkXml.length === 0 ? '' : `<hyperlinks>${linkXml.join('')}</hyperlinks>`) +
      (drawingRelId === null ? '' : `<drawing r:id="${drawingRelId}"/>`) +
      '</worksheet>',
  );

  const parts: ZipInput[] = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: styles },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ];
  if (sheetRels.length > 0) {
    parts.push({
      name: 'xl/worksheets/_rels/sheet1.xml.rels',
      data: xml(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels.join('')}</Relationships>`,
      ),
    });
  }
  if (hasImages) {
    // Each anchor fills the Photo cell of its own row.
    const anchors = build.images
      .map((img, i) => {
        const rel = `rId${i + 1}`;
        return (
          '<xdr:twoCellAnchor editAs="oneCell">' +
          `<xdr:from><xdr:col>${PHOTO_COL}</xdr:col><xdr:colOff>9525</xdr:colOff><xdr:row>${img.row}</xdr:row><xdr:rowOff>9525</xdr:rowOff></xdr:from>` +
          `<xdr:to><xdr:col>${PHOTO_COL + 1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${img.row + 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
          '<xdr:pic>' +
          `<xdr:nvPicPr><xdr:cNvPr id="${i + 2}" name="${xmlEsc(img.name)}"/><xdr:cNvPicPr/></xdr:nvPicPr>` +
          `<xdr:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
          '<xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>' +
          '</xdr:pic><xdr:clientData/></xdr:twoCellAnchor>'
        );
      })
      .join('');
    parts.push({
      name: 'xl/drawings/drawing1.xml',
      data: xml(
        '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
          'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
          `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>`,
      ),
    });
    parts.push({
      name: 'xl/drawings/_rels/drawing1.xml.rels',
      data: xml(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          build.images
            .map(
              (_, i) =>
                `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${i + 1}.jpeg"/>`,
            )
            .join('') +
          '</Relationships>',
      ),
    });
    build.images.forEach((img, i) => parts.push({ name: `xl/media/image${i + 1}.jpeg`, data: img.data }));
  }
  return parts;
}

/* ---------------------------------------------------------------- writer */

export interface ExcelExportResult {
  xlsxPath: string;
  videoPaths: string[];
  /** One workbook per planned case, under the media directory. */
  caseXlsxPaths: string[];
  /** Legacy run workbooks removed after the all-case workbook is written. */
  removed: string[];
  cases: number;
  embeddedImages: number;
  omittedImages: number;
}

/** `reports/<base>.html` → the names its Excel export uses. */
export function excelExportNames(htmlReportPath: string): { xlsxPath: string; mediaDir: string; mediaDirName: string } {
  const base = htmlReportPath.replace(/\.html$/, '');
  return { xlsxPath: `${base}-cases.xlsx`, mediaDir: `${base}-media`, mediaDirName: `${basename(base)}-media` };
}

/**
 * Writes, beside the HTML report:
 * - `<base>-cases.xlsx` — the run's workbook, every planned case;
 * - `<base>-media/<case id>.xlsx` — one workbook per case, what the
 *   report's per-case button downloads;
 * - `<base>-media/<case id>.webm` — each case's recording as a real
 *   file both workbooks hyperlink to (relative, so the folder travels whole).
 *
 * The legacy `<base>-passed.xlsx` is removed so two run workbooks cannot
 * disagree. Per-case workbooks and recordings are retained for every verdict.
 */
export async function writeRunExcel(
  htmlReportPath: string,
  input: CatalogReportInput,
  preserveVideoCaseIds: ReadonlySet<string> = new Set(),
): Promise<ExcelExportResult> {
  const { xlsxPath, mediaDir, mediaDirName } = excelExportNames(htmlReportPath);
  const workbook = buildRunWorkbook(input, mediaDirName);
  const { xlsx, videos } = workbook;
  await mkdir(dirname(xlsxPath), { recursive: true });
  await writeFile(xlsxPath, xlsx);
  const videoPaths: string[] = [];
  const caseXlsxPaths: string[] = [];
  const cases = reportedCases(input);
  if (videos.length > 0 || cases.length > 0) await mkdir(mediaDir, { recursive: true });
  for (const video of videos) {
    const path = join(mediaDir, video.file);
    const alreadyPreserved = preserveVideoCaseIds.has(video.caseId) && await access(path).then(() => true, () => false);
    if (!alreadyPreserved) await writeFile(path, video.bytes);
    videoPaths.push(path);
  }
  for (const c of cases) {
    const path = join(mediaDir, `${catalogCaseExportName(c.id)}.xlsx`);
    await writeFile(path, buildCaseWorkbook(c).xlsx);
    caseXlsxPaths.push(path);
  }
  const removed: string[] = [];
  const stalePassedPath = htmlReportPath.replace(/\.html$/, '-passed.xlsx');
  const staleRemoved = await rm(stalePassedPath, { force: false }).then(() => true, () => false);
  if (staleRemoved) removed.push(stalePassedPath);
  return {
    xlsxPath,
    videoPaths,
    caseXlsxPaths,
    removed,
    cases: workbook.cases,
    embeddedImages: workbook.embeddedImages,
    omittedImages: workbook.omittedImages,
  };
}
