/**
 * The passed-cases Excel export (`src/reporter/excel-export.ts`).
 *
 * Entirely unit-tier: the workbook is bytes built from ledger-shaped cases.
 * The zip container is verified with `catalog/extract.ts`'s own READER — an
 * independent implementation written against real `.xlsx` files, so a
 * workbook only the writer itself could decode fails here ("a reader tested
 * only against its own writer proves nothing", pointed the other way).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProofBundle, ProofStep } from '../src/engine/proof-bundle.js';
import type { CatalogReportCase, CatalogReportInput } from '../src/reporter/catalog-report.js';
import { extractWorkbookSheets, readZip } from '../src/catalog/extract.js';
import {
  buildCaseWorkbook,
  buildPassedCasesWorkbook,
  buildTextWorkbook,
  buildZip,
  excelExportNames,
  passedCases,
  stepProof,
  writePassedCasesExcel,
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
  it('holds only the passed cases — failed, blocked, review and never-ran rows stay out', () => {
    const cases = [
      filmed(),
      kase({ id: 'EC_01_02', name: 'EC_01_02 broken', verdict: 'failed', status: 'failed' }),
      kase({ id: 'EC_01_03', name: 'EC_01_03 pending', verdict: 'review', status: 'needs-review' }),
      kase({ id: 'EC_01_04', name: 'EC_01_04 skipped', verdict: 'never-ran', status: null, bundle: null }),
    ];
    assert.deepEqual(passedCases(input(cases)).map((c) => c.id), ['EC_01_01']);
    const { sheet } = sheetOf(buildPassedCasesWorkbook(input(cases), 'ec10-media').xlsx);
    assert.ok(sheet.includes('EC_01_01'));
    for (const absent of ['EC_01_02', 'EC_01_03', 'EC_01_04']) assert.ok(!sheet.includes(absent), absent);
  });

  it('pass** is a pass and its Result cell says which', () => {
    const cases = [filmed(), kase({ id: 'EC_01_05', name: 'EC_01_05 rough', status: 'passed-with-issues' })];
    const { sheet } = sheetOf(buildPassedCasesWorkbook(input(cases), 'm').xlsx);
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
    const { sheet } = sheetOf(buildPassedCasesWorkbook(input([c]), 'm').xlsx);
    assert.ok(sheet.includes('open the login page'));
    assert.ok(sheet.includes('press Sign in'));
    assert.ok(!sheet.includes('a rescued attempt'));
  });
});

describe('the photo column', () => {
  it('embeds the step’s screenshot as a real image part anchored to its own row', () => {
    const { entries, sheet } = sheetOf(buildPassedCasesWorkbook(input([filmed()]), 'm').xlsx);
    assert.deepEqual(entries.get('xl/media/image1.jpeg'), JPEG);
    const drawing = entries.get('xl/drawings/drawing1.xml')?.toString('utf8') ?? '';
    assert.ok(drawing.includes('r:embed="rId1"'));
    // Anchored to the Photo column (J, 0-based col 9) of the step's row.
    assert.ok(drawing.includes('<xdr:col>9</xdr:col>'));
    assert.ok(sheet.includes('<c r="J1"'), 'the Photo header is column J');
    assert.ok(sheet.includes('<drawing r:id='));
    const types = entries.get('[Content_Types].xml')?.toString('utf8') ?? '';
    assert.ok(types.includes('image/jpeg'));
  });

  it('a step with no still says where the evidence is instead of sitting blank', () => {
    const { sheet } = sheetOf(buildPassedCasesWorkbook(input([filmed()]), 'm').xlsx);
    assert.ok(sheet.includes('see the video row below'));
  });
});

describe('the video row under every step', () => {
  it('every filmed step gets a row beneath it linking the recording, with the step’s offset named', () => {
    const { entries, sheet } = sheetOf(buildPassedCasesWorkbook(input([filmed()]), 'ec10-media').xlsx);
    const rels = entries.get('xl/worksheets/_rels/sheet1.xml.rels')?.toString('utf8') ?? '';
    const linkCount = (rels.match(/relationships\/hyperlink/g) ?? []).length;
    assert.equal(linkCount, 2); // one per step
    assert.ok(rels.includes('Target="ec10-media/ec-01-01.webm" TargetMode="External"'));
    assert.ok(sheet.includes('<hyperlinks>'));
    assert.ok(sheet.includes('this step starts at 2.5s in'));
  });

  it('hands the recording bytes out as a file for those rows to open', () => {
    const { videos } = buildPassedCasesWorkbook(input([filmed()]), 'm');
    assert.equal(videos.length, 1);
    assert.deepEqual(videos[0]!.bytes, WEBM);
  });

  it('a run with no recording gets no video rows and no dead links', () => {
    const { entries, sheet } = sheetOf(buildPassedCasesWorkbook(input([kase({})]), 'm').xlsx);
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

  it('is column I of every step row, after the Target and before the Photo', () => {
    const c = kase({ bundle: bundle([step({ index: 0, detail: { expected: 200, actual: 200 } } as Partial<ProofStep>)]) });
    const { sheet } = sheetOf(buildPassedCasesWorkbook(input([c]), 'm').xlsx);
    assert.ok(sheet.includes('<c r="F1" t="inlineStr" s="1"><is><t xml:space="preserve">Target</t>'));
    assert.ok(sheet.includes('<c r="I1" t="inlineStr" s="1"><is><t xml:space="preserve">Proof</t>'));
    assert.match(sheet, /<c r="I3"[^>]*><is><t xml:space="preserve">expected 200 · actual 200\n/);
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
    const { sheet } = sheetOf(buildPassedCasesWorkbook(input([c]), 'm').xlsx);
    assert.match(sheet, /<c r="F3"[^>]*><is><t xml:space="preserve">button &quot;Sign in&quot; · 120×40 at \(30,200\)<\/t>/);
    assert.ok(sheet.includes('target: button &quot;Sign in&quot; · 120×40 at (30,200)'));
    // A step with no element has an empty Target cell, not a placeholder.
    const bare = kase({ bundle: bundle([step({ index: 0 })]) });
    assert.ok(!sheetOf(buildPassedCasesWorkbook(input([bare]), 'm').xlsx).sheet.includes('<c r="F3"'));
  });
});

describe('one workbook per proved case', () => {
  it('holds that case alone, links its recording by bare file name, and is named for the case', () => {
    const { xlsx, videos, passedCases: n } = buildCaseWorkbook(filmed());
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

  it('refuses a case that did not pass — the report disables the button instead', () => {
    assert.throws(() => buildCaseWorkbook(kase({ verdict: 'failed', status: 'failed' })), /did not pass/);
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

  it('a run with no passed cases still yields a workbook that says so, not a dead link', () => {
    const { sheet } = sheetOf(
      buildPassedCasesWorkbook(input([kase({ verdict: 'failed', status: 'failed' })]), 'm').xlsx,
    );
    assert.ok(sheet.includes('No passed cases in this run.'));
  });

  it('escapes application text — a case name cannot become markup', () => {
    const c = kase({ name: 'EC_01_01 <script>alert("x")</script>' });
    const { sheet } = sheetOf(buildPassedCasesWorkbook(input([c]), 'm').xlsx);
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
    assert.throws(() => buildTextWorkbook({ sheetName: 's', header: Array.from({ length: 11 }, (_, i) => `c${i}`), rows: [] }), /11 columns asked for/);
  });
});

describe('the writer', () => {
  it('writes the run workbook beside the report, and under <base>-media/ each proved case’s workbook and recording', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wow-excel-'));
    const htmlPath = join(dir, 'ec10-csv-stamp.html');
    const result = await writePassedCasesExcel(htmlPath, input([filmed()]));
    assert.equal(result.xlsxPath, join(dir, 'ec10-csv-stamp-passed.xlsx'));
    assert.equal(result.passedCases, 1);
    const media = join(dir, 'ec10-csv-stamp-media', 'ec-01-01.webm');
    assert.deepEqual(result.videoPaths, [media]);
    assert.deepEqual(readFileSync(media), WEBM);
    assert.deepEqual(result.caseXlsxPaths, [join(dir, 'ec10-csv-stamp-media', 'ec-01-01.xlsx')]);
    assert.ok(existsSync(result.caseXlsxPaths[0]!));
    assert.deepEqual(result.removed, []);
    // The run workbook's links point down into the folder both live in…
    const rels = new Map(readZip(readFileSync(result.xlsxPath)).map((e) => [e.name, e.data]))
      .get('xl/worksheets/_rels/sheet1.xml.rels')!
      .toString('utf8');
    assert.ok(rels.includes('Target="ec10-csv-stamp-media/ec-01-01.webm"'));
    // …and the case workbook, already inside it, links by bare name.
    const caseRels = new Map(readZip(readFileSync(result.caseXlsxPaths[0]!)).map((e) => [e.name, e.data]))
      .get('xl/worksheets/_rels/sheet1.xml.rels')!
      .toString('utf8');
    assert.ok(caseRels.includes('Target="ec-01-01.webm"'));
  });

  it('a rerun that goes red takes the case’s export with it — a stale proof beside a failed row is a lie', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wow-excel-'));
    const htmlPath = join(dir, 'run.html');
    const first = await writePassedCasesExcel(htmlPath, input([filmed()]));
    assert.equal(first.caseXlsxPaths.length, 1);
    const failedNow = kase({ verdict: 'failed', status: 'failed', bundle: bundle([step({ status: 'failed' })]) });
    const second = await writePassedCasesExcel(htmlPath, input([failedNow]));
    assert.equal(second.caseXlsxPaths.length, 0);
    assert.deepEqual(second.removed.sort(), [join(dir, 'run-media', 'ec-01-01.webm'), join(dir, 'run-media', 'ec-01-01.xlsx')].sort());
    assert.ok(!existsSync(join(dir, 'run-media', 'ec-01-01.xlsx')));
    // Nothing to remove the second time round — the report simply says so.
    const third = await writePassedCasesExcel(htmlPath, input([failedNow]));
    assert.deepEqual(third.removed, []);
  });

  it('a run with nothing passed writes no media folder at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wow-excel-'));
    await writePassedCasesExcel(join(dir, 'run.html'), input([kase({ verdict: 'never-ran', status: null, bundle: null })]));
    assert.ok(!existsSync(join(dir, 'run-media')));
  });

  it('derives its names from the report path, so a resume overwrites its own export', () => {
    const names = excelExportNames('/x/reports/run-key.html');
    assert.equal(names.xlsxPath, '/x/reports/run-key-passed.xlsx');
    assert.equal(names.mediaDir, '/x/reports/run-key-media');
    assert.equal(names.mediaDirName, 'run-key-media');
  });
});
