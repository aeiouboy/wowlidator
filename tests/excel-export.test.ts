/**
 * The all-cases Excel export (`src/reporter/excel-export.ts`).
 *
 * Entirely unit-tier: the workbook is bytes built from ledger-shaped cases.
 * The zip container is verified with `catalog/extract.ts`'s own READER — an
 * independent implementation written against real `.xlsx` files, so a
 * workbook only the writer itself could decode fails here ("a reader tested
 * only against its own writer proves nothing", pointed the other way).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProofBundle, ProofStep } from '../src/engine/proof-bundle.js';
import type { CatalogReportCase, CatalogReportInput } from '../src/reporter/catalog-report.js';
import { extractWorkbookSheets, readZip } from '../src/catalog/extract.js';
import {
  buildCaseWorkbook,
  buildRunWorkbook,
  buildTextWorkbook,
  buildZip,
  EXCEL_IMAGE_BUDGET_BYTES,
  excelExportNames,
  passedCases,
  reportedCases,
  stepProof,
  writeRunExcel,
} from '../src/reporter/excel-export.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
const WEBM = Buffer.from('webm-bytes-stand-in');

function step(over: Partial<ProofStep>): ProofStep {
  return {
    index: 0, action: 'goto', intent: undefined, selector: null, resolvedSelector: null,
    resolution: null, status: 'passed', startedAt: '2026-09-02T04:00:00.000Z', durationMs: 350,
    url: 'http://localhost:3000/en/login',
    ...over,
  } as ProofStep;
}

function bundle(steps: ProofStep[], over: Partial<ProofBundle> = {}): ProofBundle {
  return {
    runId: 'r1', name: 'EC_01_01 first', status: 'passed',
    startedAt: '2026-09-02T04:00:00.000Z', finishedAt: '2026-09-02T04:01:00.000Z',
    durationMs: 60_000, cdpUrl: null, cachePath: null, healerModel: null,
    summary: { totalSteps: steps.length, passed: steps.length, failed: 0 } as ProofBundle['summary'],
    defects: [], steps,
    ...over,
  } as ProofBundle;
}

function kase(over: Partial<CatalogReportCase>): CatalogReportCase {
  return {
    id: 'EC_01_01', name: 'EC_01_01 login works', scenario: 'EC_01', verdict: 'passed',
    status: 'passed', reason: null, bundle: bundle([step({})]), history: [],
    ...over,
  };
}

function input(cases: CatalogReportCase[]): CatalogReportInput {
  return { title: 'ec10.csv', runKey: 'ec10-csv@2026-09-02T04:00:00.000Z', generatedAt: null, cases };
}

const filmed = () =>
  kase({
    bundle: bundle(
      [
        step({ index: 0, action: 'goto', intent: 'open the login page', videoOffsetMs: 0 }),
        step({
          index: 1,
          action: 'click',
          intent: 'press Sign in',
          selector: 'role=button[name="Sign in"]',
          videoOffsetMs: 2_500,
          screenshot: JPEG.toString('base64'),
        }),
      ],
      { video: { data: WEBM.toString('base64'), width: 960, height: 540 } as ProofBundle['video'] },
    ),
  });

function sheetOf(xlsx: Buffer): { entries: Map<string, Buffer>; sheet: string } {
  const entries = new Map(readZip(xlsx).map((e) => [e.name, e.data]));
  const sheet = entries.get('xl/worksheets/sheet1.xml')?.toString('utf8') ?? '';
  return { entries, sheet };
}

describe('what goes in', () => {
  it('orders every reported case failed, review, blocked, never-ran, passed and keeps input order within each group', () => {
    const cases = [
      filmed(),
      kase({ id: 'EC_01_02', name: 'EC_01_02 blocked', verdict: 'blocked', status: null, reason: 'provider quota', bundle: null }),
      kase({ id: 'EC_01_03', name: 'EC_01_03 failed first', verdict: 'failed', status: 'failed' }),
      kase({ id: 'EC_01_04', name: 'EC_01_04 pending', verdict: 'review', status: 'needs-review' }),
      kase({ id: 'EC_01_05', name: 'EC_01_05 failed second', verdict: 'failed', status: 'dead-end' }),
      kase({ id: 'EC_01_06', name: 'EC_01_06 never ran', verdict: 'never-ran', status: null, bundle: null }),
      kase({ id: 'EC_01_07', name: 'EC_01_07 passed second' }),
    ];
    assert.deepEqual(passedCases(input(cases)).map((c) => c.id), ['EC_01_01', 'EC_01_07']);
    assert.deepEqual(reportedCases(input(cases)).map((c) => c.id), [
      'EC_01_03', 'EC_01_05', 'EC_01_04', 'EC_01_02', 'EC_01_06', 'EC_01_01', 'EC_01_07',
    ]);
    const [sheet] = extractWorkbookSheets(buildRunWorkbook(input(cases), 'ec10-media').xlsx);
    assert.ok(sheet);
    assert.deepEqual(sheet.rows.filter((row) => row[0]?.startsWith('EC_')).map((row) => row.slice(0, 2)), [
      ['EC_01_03', 'failed'], ['EC_01_03', 'failed'],
      ['EC_01_05', 'failed'], ['EC_01_05', 'failed'],
      ['EC_01_04', 'review'], ['EC_01_04', 'review'],
      ['EC_01_02', 'blocked'],
      ['EC_01_06', 'never-ran'],
      ['EC_01_01', 'passed'], ['EC_01_01', 'passed'], ['EC_01_01', 'passed'],
      ['EC_01_07', 'passed'], ['EC_01_07', 'passed'],
    ]);
  });

  it('puts failed and blocked cases in the workbook with their band verdict and the blocked reason', () => {
    const failed = kase({ id: 'EC_01_02', name: 'broken save', verdict: 'failed', status: 'failed' });
    const blocked = kase({ id: 'EC_01_03', name: 'quota hold', verdict: 'blocked', status: null, reason: 'daily provider quota', bundle: null });
    const [sheet] = extractWorkbookSheets(buildRunWorkbook(input([blocked, failed]), 'm').xlsx);
    assert.ok(sheet);
    assert.ok(sheet.rows.some((row) => row.includes('EC_01_02 — broken save — failed')));
    assert.ok(sheet.rows.some((row) => row.includes('EC_01_03 — quota hold — blocked (no verdict) — daily provider quota')));
  });

  it('pass** is a pass and its Result cell says which', () => {
    const cases = [filmed(), kase({ id: 'EC_01_05', name: 'EC_01_05 rough', status: 'passed-with-issues' })];
    const { sheet } = sheetOf(buildRunWorkbook(input(cases), 'm').xlsx);
    assert.ok(sheet.includes('EC_01_05'));
    assert.ok(sheet.includes('pass**'));
  });

  it('one row per step, in the author’s words, superseded attempts excluded', () => {
    const c = kase({
      bundle: bundle([
        step({ index: 0, intent: 'open the login page' }),
        step({ index: 1, action: 'click', intent: 'a rescued attempt', superseded: true } as Partial<ProofStep>),
        step({ index: 1, action: 'click', intent: 'press Sign in' }),
      ]),
    });
    const { sheet } = sheetOf(buildRunWorkbook(input([c]), 'm').xlsx);
    assert.ok(sheet.includes('open the login page'));
    assert.ok(sheet.includes('press Sign in'));
    assert.ok(!sheet.includes('a rescued attempt'));
  });
});

describe('the photo column', () => {
  it('embeds the step’s screenshot as a real image part anchored to its own row', () => {
    const { entries, sheet } = sheetOf(buildRunWorkbook(input([filmed()]), 'm').xlsx);
    assert.deepEqual(entries.get('xl/media/image1.jpeg'), JPEG);
    const drawing = entries.get('xl/drawings/drawing1.xml')?.toString('utf8') ?? '';
    assert.ok(drawing.includes('r:embed="rId1"'));
    // Anchored to the Photo column (K, 0-based col 10) of the step's row.
    assert.ok(drawing.includes('<xdr:col>10</xdr:col>'));
    assert.ok(sheet.includes('<c r="K1"'), 'the Photo header is column K');
    assert.ok(sheet.includes('<drawing r:id='));
    const types = entries.get('[Content_Types].xml')?.toString('utf8') ?? '';
    assert.ok(types.includes('image/jpeg'));
  });

  it('a step with no still says where the evidence is instead of sitting blank', () => {
    const { sheet } = sheetOf(buildRunWorkbook(input([filmed()]), 'm').xlsx);
    assert.ok(sheet.includes('see the video row below'));
  });

  it('omits a routine screenshot past the Excel budget, retains a failure screenshot, and states the omitted count first', () => {
    const routine = Buffer.alloc(EXCEL_IMAGE_BUDGET_BYTES + 1, 0xaa).toString('base64');
    const failedShot = Buffer.from('failure-image').toString('base64');
    const passing = kase({ id: 'EC_01_02', bundle: bundle([step({ screenshot: routine })]) });
    const failed = kase({
      id: 'EC_01_03', verdict: 'failed', status: 'failed',
      bundle: bundle([step({ status: 'failed', screenshot: failedShot })], { status: 'failed' }),
    });
    const workbook = buildRunWorkbook(input([passing, failed]), 'm').xlsx;
    const { entries } = sheetOf(workbook);
    const [sheet] = extractWorkbookSheets(workbook);
    assert.ok(sheet);
    const firstRow = sheet.rows[0];
    assert.ok(firstRow);
    assert.ok(firstRow.some((cell) => cell.includes('1 routine screenshot(s) omitted')));
    assert.ok(sheet.rows.some((row) => row.includes('omitted for size — it stays in the proof bundle')));
    assert.equal([...entries.keys()].filter((name) => name.startsWith('xl/media/image')).length, 1);
    assert.deepEqual(entries.get('xl/media/image1.jpeg'), Buffer.from(failedShot, 'base64'));
  });
});

describe('the video row under every step', () => {
  it('every filmed step gets a row beneath it linking the recording, with the step’s offset named', () => {
    const { entries, sheet } = sheetOf(buildRunWorkbook(input([filmed()]), 'ec10-media').xlsx);
    const rels = entries.get('xl/worksheets/_rels/sheet1.xml.rels')?.toString('utf8') ?? '';
    const linkCount = (rels.match(/relationships\/hyperlink/g) ?? []).length;
    assert.equal(linkCount, 2); // one per step
    assert.ok(rels.includes('Target="ec10-media/ec-01-01.webm" TargetMode="External"'));
    assert.ok(sheet.includes('<hyperlinks>'));
    assert.ok(sheet.includes('this step starts at 2.5s in'));
  });

  it('hands the recording bytes out as a file for those rows to open', () => {
    const { videos } = buildRunWorkbook(input([filmed()]), 'm');
    assert.equal(videos.length, 1);
    assert.deepEqual(videos[0]!.bytes, WEBM);
  });

  it('a run with no recording gets no video rows and no dead links', () => {
    const { entries, sheet } = sheetOf(buildRunWorkbook(input([kase({})]), 'm').xlsx);
    assert.ok(!sheet.includes('<hyperlinks>'));
    assert.equal(entries.get('xl/worksheets/_rels/sheet1.xml.rels'), undefined);
  });
});

describe('the proof column', () => {
  it('carries the step’s own log: expected vs actual, how it resolved, a heal, an error', () => {
    const s = step({
      index: 2, action: 'expectText', selector: 'role=heading', resolvedSelector: 'role=heading[name="Plans"]',
      resolution: 'jit', detail: { expected: 'Plans', actual: 'Plans' },
      heal: { from: 'role=heading', to: 'role=heading[name="Plans"]', strategy: 'ax-tree', confidence: 0.9 },
    } as unknown as Partial<ProofStep>);
    const proof = stepProof(s);
    assert.ok(proof.includes('expected "Plans" · actual "Plans"'));
    assert.ok(proof.includes('resolved via jit'));
    assert.ok(proof.includes('resolved as role=heading[name="Plans"]'));
    assert.ok(proof.includes('healed → role=heading[name="Plans"] (ax-tree, 90%)'));
    assert.ok(proof.includes('at http://localhost:3000/en/login'));
    assert.ok(stepProof(step({ error: 'boom\nstack' } as Partial<ProofStep>)).includes('error: boom'));
    assert.ok(!stepProof(step({ error: 'boom\nstack' } as Partial<ProofStep>)).includes('stack'));
  });

  it('adds Verdict after Case and shifts every pre-existing column one position right', () => {
    const c = kase({ bundle: bundle([step({ index: 0, detail: { expected: 200, actual: 200 } } as Partial<ProofStep>)]) });
    const { sheet } = sheetOf(buildRunWorkbook(input([c]), 'm').xlsx);
    const [read] = extractWorkbookSheets(buildRunWorkbook(input([c]), 'm').xlsx);
    assert.ok(read);
    assert.deepEqual(read.rows[0], ['Case', 'Verdict', 'Step', 'Action', 'Description', 'Selector', 'Target', 'Result', 'Duration', 'Proof', 'Photo']);
    assert.ok(sheet.includes('<c r="G1" t="inlineStr" s="1"><is><t xml:space="preserve">Target</t>'));
    assert.ok(sheet.includes('<c r="J1" t="inlineStr" s="1"><is><t xml:space="preserve">Proof</t>'));
    assert.match(sheet, /<c r="J3"[^>]*><is><t xml:space="preserve">expected 200 · actual 200\n/);
  });

  it('names the target in its own column and in the proof log — what the selector WAS on the page', () => {
    const c = kase({
      bundle: bundle([
        step({
          index: 0, action: 'click', selector: 'role=button[name="Sign in"]', resolvedSelector: 'role=button[name="Sign in"]',
          target: { selector: 'role=button[name="Sign in"]', tag: 'button', role: 'button', name: 'Sign in', box: { x: 30, y: 200, width: 120, height: 40 } },
        } as Partial<ProofStep>),
      ]),
    });
    const { sheet } = sheetOf(buildRunWorkbook(input([c]), 'm').xlsx);
    assert.match(sheet, /<c r="G3"[^>]*><is><t xml:space="preserve">button &quot;Sign in&quot; · 120×40 at \(30,200\)<\/t>/);
    assert.ok(sheet.includes('target: button &quot;Sign in&quot; · 120×40 at (30,200)'));
    // A step with no element has an empty Target cell, not a placeholder.
    const bare = kase({ bundle: bundle([step({ index: 0 })]) });
    assert.ok(!sheetOf(buildRunWorkbook(input([bare]), 'm').xlsx).sheet.includes('<c r="G3"'));
  });
});

describe('one workbook per case', () => {
  it('holds that case alone, links its recording by bare file name, and is named for the case', () => {
    const { xlsx, videos, cases: n } = buildCaseWorkbook(filmed());
    assert.equal(n, 1);
    assert.deepEqual(videos.map((v) => v.file), ['ec-01-01.webm']);
    const { entries, sheet } = sheetOf(xlsx);
    assert.ok(sheet.includes('EC_01_01'));
    assert.ok(sheet.includes('press Sign in'));
    const rels = entries.get('xl/worksheets/_rels/sheet1.xml.rels')?.toString('utf8') ?? '';
    assert.ok(rels.includes('Target="ec-01-01.webm" TargetMode="External"'));
    assert.ok((entries.get('xl/workbook.xml')?.toString('utf8') ?? '').includes('name="ec-01-01"'));
    assert.deepEqual(entries.get('xl/media/image1.jpeg'), JPEG);
  });

  it('writes a failed case too', () => {
    const [sheet] = extractWorkbookSheets(buildCaseWorkbook(kase({ verdict: 'failed', status: 'failed' })).xlsx);
    assert.ok(sheet);
    assert.ok(sheet.rows.some((row) => row.includes('EC_01_01 login works — failed')));
  });
});

describe('the container', () => {
  it('round-trips through the independent zip reader, stored and deflated entries alike', () => {
    const files = [
      { name: 'a.xml', data: Buffer.from('<a>'.repeat(100)) }, // compresses
      { name: 'b.jpeg', data: JPEG }, // does not
    ];
    const back = new Map(readZip(buildZip(files)).map((e) => [e.name, e.data]));
    assert.deepEqual(back.get('a.xml'), files[0]!.data);
    assert.deepEqual(back.get('b.jpeg'), files[1]!.data);
  });

  it('a run with no cases still yields a workbook that says so, not a dead link', () => {
    const { sheet } = sheetOf(
      buildRunWorkbook(input([]), 'm').xlsx,
    );
    assert.ok(sheet.includes('No cases in this run.'));
  });

  it('escapes application text — a case name cannot become markup', () => {
    const c = kase({ name: 'EC_01_01 <script>alert("x")</script>' });
    const { sheet } = sheetOf(buildRunWorkbook(input([c]), 'm').xlsx);
    assert.ok(!sheet.includes('<script>'));
    assert.ok(sheet.includes('&lt;script&gt;'));
  });
});

describe('a text sheet through the same writer', () => {
  it('round-trips a preface, a bold header and wrapped rows through the independent xlsx reader', () => {
    const xlsx = buildTextWorkbook({
      sheetName: 'Findings',
      preface: 'Suggested severity is a stated rule.',
      header: ['Finding', 'Cases', 'Status as sealed'],
      rows: [['POST /v1/plans answered 500', 'EC_01_01 (failed)\nEC_01_02 (error)', 'failed: 1\nerror: 1'], ['<b>escaped</b>', '', 'x']],
      widths: [40, 20, 12],
    });
    const [sheet] = extractWorkbookSheets(xlsx);
    assert.equal(sheet!.name, 'Findings');
    assert.deepEqual(sheet!.rows[0], ['Suggested severity is a stated rule.']);
    assert.deepEqual(sheet!.rows[1], ['Finding', 'Cases', 'Status as sealed']);
    assert.deepEqual(sheet!.rows[2], ['POST /v1/plans answered 500', 'EC_01_01 (failed)\nEC_01_02 (error)', 'failed: 1\nerror: 1']);
    assert.deepEqual(sheet!.rows[3], ['<b>escaped</b>', '', 'x'], 'markup is data in the cell, not markup in the XML');
    const raw = new Map(readZip(xlsx).map((e) => [e.name, e.data])).get('xl/worksheets/sheet1.xml')!.toString('utf8');
    assert.ok(!raw.includes('<b>escaped'));
    assert.ok(raw.includes('<mergeCell ref="A1:C1"/>'), 'the preface spans the header columns');
  });

  it('refuses more columns than the writer has letters for', () => {
    assert.throws(() => buildTextWorkbook({ sheetName: 's', header: Array.from({ length: 12 }, (_, i) => `c${i}`), rows: [] }), /12 columns asked for/);
  });
});

describe('the writer', () => {
  it('writes <base>-cases.xlsx, removes stale <base>-passed.xlsx, writes a failed case workbook, and preserves a named recording', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wow-excel-'));
    const htmlPath = join(dir, 'ec10-csv-stamp.html');
    const oldPath = join(dir, 'ec10-csv-stamp-passed.xlsx');
    writeFileSync(oldPath, 'stale');
    const preserved = join(dir, 'ec10-csv-stamp-media', 'ec-01-02.webm');
    const failed = kase({
      id: 'EC_01_02', verdict: 'failed', status: 'failed',
      bundle: bundle(
        [step({ status: 'failed' })],
        { status: 'failed', video: { data: Buffer.from('new recording').toString('base64'), width: 960, height: 540 } as ProofBundle['video'] },
      ),
    });
    mkdirSync(join(dir, 'ec10-csv-stamp-media'));
    writeFileSync(preserved, 'html-spilled', { flag: 'w' });
    const result = await writeRunExcel(htmlPath, input([filmed(), failed]), new Set(['EC_01_02']));
    assert.equal(result.xlsxPath, join(dir, 'ec10-csv-stamp-cases.xlsx'));
    assert.equal(result.cases, 2);
    assert.ok(!existsSync(oldPath));
    assert.deepEqual(readFileSync(preserved, 'utf8'), 'html-spilled');
    const media = join(dir, 'ec10-csv-stamp-media', 'ec-01-01.webm');
    assert.deepEqual(result.videoPaths, [preserved, media]);
    assert.deepEqual(readFileSync(media), WEBM);
    assert.deepEqual(result.caseXlsxPaths, [
      join(dir, 'ec10-csv-stamp-media', 'ec-01-02.xlsx'),
      join(dir, 'ec10-csv-stamp-media', 'ec-01-01.xlsx'),
    ]);
    const firstCasePath = result.caseXlsxPaths[0];
    assert.ok(firstCasePath);
    assert.ok(existsSync(firstCasePath));
    assert.deepEqual(result.removed, [oldPath]);
    // The run workbook's links point down into the folder both live in…
    const rels = new Map(readZip(readFileSync(result.xlsxPath)).map((e) => [e.name, e.data]))
      .get('xl/worksheets/_rels/sheet1.xml.rels')!
      .toString('utf8');
    assert.ok(rels.includes('Target="ec10-csv-stamp-media/ec-01-01.webm"'));
    // …and the case workbook, already inside it, links by bare name.
    const filmedWorkbook = result.caseXlsxPaths.find((path) => path.endsWith('ec-01-01.xlsx'));
    assert.ok(filmedWorkbook);
    const caseRels = new Map(readZip(readFileSync(filmedWorkbook)).map((e) => [e.name, e.data]))
      .get('xl/worksheets/_rels/sheet1.xml.rels')!
      .toString('utf8');
    assert.ok(caseRels.includes('Target="ec-01-01.webm"'));
  });

  it('a rerun that goes red keeps the case workbook and recording as the failed run evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wow-excel-'));
    const htmlPath = join(dir, 'run.html');
    const first = await writeRunExcel(htmlPath, input([filmed()]));
    assert.equal(first.caseXlsxPaths.length, 1);
    const failedNow = kase({ verdict: 'failed', status: 'failed', bundle: bundle([step({ status: 'failed' })]) });
    const second = await writeRunExcel(htmlPath, input([failedNow]));
    assert.equal(second.caseXlsxPaths.length, 1);
    assert.ok(existsSync(join(dir, 'run-media', 'ec-01-01.xlsx')));
    assert.ok(existsSync(join(dir, 'run-media', 'ec-01-01.webm')));
  });

  it('a never-ran case still gets its per-case workbook', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wow-excel-'));
    const result = await writeRunExcel(join(dir, 'run.html'), input([kase({ verdict: 'never-ran', status: null, bundle: null })]));
    const casePath = result.caseXlsxPaths[0];
    assert.ok(casePath);
    assert.ok(existsSync(casePath));
  });

  it('derives its names from the report path, so a resume overwrites its own export', () => {
    const names = excelExportNames('/x/reports/run-key.html');
    assert.equal(names.xlsxPath, '/x/reports/run-key-cases.xlsx');
    assert.equal(names.mediaDir, '/x/reports/run-key-media');
    assert.equal(names.mediaDirName, 'run-key-media');
  });
});
