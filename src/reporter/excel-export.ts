/**
 * The passed-cases Excel export (asked for 2026-09-02, per case the same day).
 *
 * Two shapes of the same workbook, both holding ONLY cases whose verdict is
 * `passed` (`pass**` included — it IS a pass, and the Result column says
 * which):
 *
 * - **one workbook per PROVED CASE**, `<report>-media/<case id>.xlsx` — what
 *   the catalog report's per-case `Export (Excel)` button downloads. A case
 *   that did not pass has no file and a disabled button: the export is the
 *   proof, and there is no proof to hand over for a case that failed.
 * - **one workbook per RUN**, `<report>-passed.xlsx`, every passed case in
 *   one sheet — the header link on the report.
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
 * key and the case id, so re-running a case overwrites its own workbook — and
 * a case that passed once and fails on the rerun loses its file, because the
 * report now says it did not pass and a stale "proof" beside it would say
 * otherwise.
 *
 * The container is written by hand, same decision as `catalog/extract.ts`
 * reading one and `engine/webm.ts` cutting one: `node:zlib` supplies deflate
 * and crc32, and the workbook uses inline strings so there is no shared-string
 * table to keep consistent. The writer is tested against `extract.ts`'s own
 * zip READER — two independent implementations, so a workbook only the writer
 * itself can decode fails the suite.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

import { describeDbChanges, describeTarget, describeValueSource, expectedActual, type ProofStep } from '../engine/proof-bundle.js';
import { catalogCaseExportName, type CatalogReportCase, type CatalogReportInput } from './catalog-report.js';
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

const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] as const;
const LAST_COL = COLS[COLS.length - 1];
/** 0-based index of the Photo column — where each screenshot is anchored. */
const PHOTO_COL = COLS.length - 1;
/** Height (points) of a row carrying an embedded screenshot. */
const PHOTO_ROW_HT = 110;

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

/** A row of one merged cell spanning B..H (A keeps the case id column clear). */
function bandRow(build: SheetBuild, r: number, text: string, style: number, link?: string): void {
  const ref = `B${r}`;
  build.rows.push(rowXml(r, textCell(ref, text, style)));
  build.merges.push(`B${r}:${LAST_COL}${r}`);
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
): number {
  const hasPhoto = typeof step.screenshot === 'string' && step.screenshot !== '';
  const cells =
    textCell(`A${r}`, c.id, S.wrap) +
    numberCell(`B${r}`, step.index, S.wrap) +
    textCell(`C${r}`, step.action, S.wrap) +
    textCell(`D${r}`, step.intent ?? '', S.wrap) +
    // The Selector column says what the step was aimed at — for a kind with
    // no single selector, the record's own account (`stepTarget`), never blank.
    textCell(`E${r}`, stepTarget(step) ?? '', S.wrap) +
    textCell(`F${r}`, describeTarget(step.target) ?? '', S.wrap) +
    textCell(`G${r}`, step.status + (step.heal ? ' (healed)' : ''), S.wrap) +
    textCell(`H${r}`, fmtMs(step.durationMs), S.wrap) +
    textCell(`I${r}`, stepProof(step), S.wrap) +
    (hasPhoto ? '' : textCell(`J${r}`, videoHref === null ? '—' : 'see the video row below', S.wrap));
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
  passedCases: number;
}

/** `<case id slug>.webm` — the recording's file name inside the media directory. */
export function caseVideoFile(caseId: string): string {
  return `${catalogCaseExportName(caseId)}.webm`;
}

function headerRow(build: SheetBuild): void {
  build.rows.push(
    rowXml(
      1,
      textCell('A1', 'Case', S.bold) +
        textCell('B1', 'Step', S.bold) +
        textCell('C1', 'Action', S.bold) +
        textCell('D1', 'Description', S.bold) +
        textCell('E1', 'Selector', S.bold) +
        textCell('F1', 'Target', S.bold) +
        textCell('G1', 'Result', S.bold) +
        textCell('H1', 'Duration', S.bold) +
        textCell('I1', 'Proof', S.bold) +
        textCell('J1', 'Photo', S.bold),
    ),
  );
}

/**
 * The rows of one case: a bold case band, then one row per step (superseded
 * attempts excluded, same rule as the HTML) with the screenshot in the Photo
 * column and the video row beneath. `videoDir` is where the recording will
 * sit RELATIVE to the workbook — `''` when they share a folder.
 */
function caseRows(build: SheetBuild, videos: CaseVideoFile[], c: CatalogReportCase, videoDir: string, r: number): number {
  const video = c.bundle?.video;
  let videoHref: string | null = null;
  if (typeof video?.data === 'string' && video.data !== '') {
    const file = caseVideoFile(c.id);
    videos.push({ caseId: c.id, file, bytes: Buffer.from(video.data, 'base64') });
    videoHref = videoDir === '' ? file : `${videoDir}/${file}`;
  }
  const status = c.status === 'passed-with-issues' ? 'pass**' : (c.status ?? 'passed');
  bandRow(build, r, `${c.id === c.name ? c.id : `${c.id} — ${c.name}`} (${status})`, S.bold);
  r += 1;
  const steps = (c.bundle?.steps ?? []).filter((s) => !s.superseded);
  if (steps.length === 0) {
    bandRow(build, r, 'No steps were recorded for this case.', S.wrap);
    r += 1;
  }
  for (const step of steps) r = stepRows(build, c, step, r, videoHref);
  return r;
}

/**
 * The run's workbook: header row, then every passed case in turn. The
 * recordings live in `<mediaDirName>/` beside the workbook, so the links
 * point down into it.
 */
export function buildPassedCasesWorkbook(input: CatalogReportInput, mediaDirName: string): WorkbookBuild {
  const cases = passedCases(input);
  const build: SheetBuild = { rows: [], merges: [], images: [], links: [] };
  const videos: CaseVideoFile[] = [];
  headerRow(build);
  let r = 2;
  if (cases.length === 0) {
    bandRow(build, r, 'No passed cases in this run.', S.wrap);
    r += 1;
  }
  for (const c of cases) r = caseRows(build, videos, c, mediaDirName, r);
  return { xlsx: buildZip(workbookParts(build, 'Passed cases')), videos, passedCases: cases.length };
}

/**
 * One proved case as its own workbook — the file the report's per-case
 * `Export (Excel)` button downloads. It sits IN the media directory, beside
 * the case's own recording, so the video rows link by bare file name.
 *
 * Only a passed case has one; asking for any other verdict is a programming
 * error, not a case to render — the report disables the button instead.
 */
export function buildCaseWorkbook(c: CatalogReportCase): WorkbookBuild {
  if (c.verdict !== 'passed') {
    throw new Error(`buildCaseWorkbook: ${c.id} did not pass (${c.verdict}) — only a proved case exports`);
  }
  const build: SheetBuild = { rows: [], merges: [], images: [], links: [] };
  const videos: CaseVideoFile[] = [];
  headerRow(build);
  caseRows(build, videos, c, '', 2);
  return { xlsx: buildZip(workbookParts(build, catalogCaseExportName(c.id).slice(0, 31))), videos, passedCases: 1 };
}

/** The column widths of the step workbooks — Case, Step, Action, Description, Selector, Target, Result, Duration, Proof, Photo. */
const STEP_SHEET_WIDTHS = [14, 6, 16, 44, 36, 34, 14, 10, 46, 45] as const;

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
  /** One workbook per proved case, under the media directory. */
  caseXlsxPaths: string[];
  /** Per-case files removed because the case no longer passes (a rerun went red). */
  removed: string[];
  passedCases: number;
}

/** `reports/<base>.html` → the names its Excel export uses. */
export function excelExportNames(htmlReportPath: string): { xlsxPath: string; mediaDir: string; mediaDirName: string } {
  const base = htmlReportPath.replace(/\.html$/, '');
  return { xlsxPath: `${base}-passed.xlsx`, mediaDir: `${base}-media`, mediaDirName: `${basename(base)}-media` };
}

/**
 * Writes, beside the HTML report:
 * - `<base>-passed.xlsx` — the run's workbook, every passed case;
 * - `<base>-media/<case id>.xlsx` — one workbook per proved case, what the
 *   report's per-case button downloads;
 * - `<base>-media/<case id>.webm` — each passed case's recording as a real
 *   file both workbooks hyperlink to (relative, so the folder travels whole).
 *
 * And removes the per-case workbook and recording of any case on the report
 * that is NOT passed: a case that passed on an earlier pass and failed on the
 * rerun must not keep a "proof" file the report contradicts. The media
 * directory is created only when there is something to put in it.
 */
export async function writePassedCasesExcel(
  htmlReportPath: string,
  input: CatalogReportInput,
  preserveVideoCaseIds: ReadonlySet<string> = new Set(),
): Promise<ExcelExportResult> {
  const { xlsxPath, mediaDir, mediaDirName } = excelExportNames(htmlReportPath);
  const { xlsx, videos, passedCases: count } = buildPassedCasesWorkbook(input, mediaDirName);
  await mkdir(dirname(xlsxPath), { recursive: true });
  await writeFile(xlsxPath, xlsx);
  const videoPaths: string[] = [];
  const caseXlsxPaths: string[] = [];
  const passed = passedCases(input);
  if (videos.length > 0 || passed.length > 0) await mkdir(mediaDir, { recursive: true });
  for (const video of videos) {
    const path = join(mediaDir, video.file);
    await writeFile(path, video.bytes);
    videoPaths.push(path);
  }
  for (const c of passed) {
    const path = join(mediaDir, `${catalogCaseExportName(c.id)}.xlsx`);
    await writeFile(path, buildCaseWorkbook(c).xlsx);
    caseXlsxPaths.push(path);
  }
  const removed: string[] = [];
  for (const c of input.cases) {
    if (c.verdict === 'passed') continue;
    const stalePaths = [join(mediaDir, `${catalogCaseExportName(c.id)}.xlsx`)];
    if (!preserveVideoCaseIds.has(c.id)) stalePaths.push(join(mediaDir, caseVideoFile(c.id)));
    for (const stale of stalePaths) {
      const gone = await rm(stale, { force: false }).then(() => true, () => false);
      if (gone) removed.push(stale);
    }
  }
  return { xlsxPath, videoPaths, caseXlsxPaths, removed, passedCases: count };
}
