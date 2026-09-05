/**
 * The live catalog report (`src/cli/catalog-live-report.ts`).
 *
 * Entirely unit-tier: a ledger in memory, proof bundles as JSON in a temp
 * directory, the report and workbooks written under a temp `reports/`. What
 * is proved here is the LIFECYCLE — the file exists before any verdict, each
 * finished case replaces its row, a rerun updates in place and takes a
 * no-longer-passing case's export with it, concurrent refreshes never tear
 * the file — not the rendering, which `catalog-report.test.ts` covers.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProofBundle, ProofStep } from '../src/engine/proof-bundle.js';
import {
  CatalogLiveReport,
  buildCatalogReportCases,
  scenarioFromId,
  writeCatalogArtifacts,
} from '../src/cli/catalog-live-report.js';
import { newLedger, recordOutcome, type SuiteLedger } from '../src/cli/suite-progress.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

function step(over: Partial<ProofStep>): ProofStep {
  return {
    index: 0, action: 'goto', intent: undefined, selector: null, resolvedSelector: null,
    resolution: null, status: 'passed', startedAt: '2026-09-02T04:00:00.000Z', durationMs: 350,
    url: 'http://localhost:3000/en/login',
    ...over,
  } as ProofStep;
}

function bundle(name: string, status: 'passed' | 'failed', over: Partial<ProofBundle> = {}): ProofBundle {
  const steps = [step({ intent: 'open the page', screenshot: JPEG.toString('base64') } as Partial<ProofStep>)];
  return {
    runId: `r-${name.split(' ')[0]}`, name, status,
    startedAt: '2026-09-02T04:00:00.000Z', finishedAt: '2026-09-02T04:01:00.000Z',
    durationMs: 60_000, cdpUrl: null, cachePath: null, healerModel: null,
    summary: { totalSteps: 1, passed: status === 'passed' ? 1 : 0, failed: status === 'passed' ? 0 : 1 } as ProofBundle['summary'],
    defects: [], steps,
    ...over,
  } as ProofBundle;
}

function fixture(): { cwd: string; ledger: SuiteLedger; live: CatalogLiveReport; errors: string[] } {
  const cwd = mkdtempSync(join(tmpdir(), 'wow-live-'));
  const ledger = newLedger('be100.csv', ['BE_01_01', 'BE_01_02', 'BE_02_01']);
  ledger.runKey = 'be100-csv@2026-09-02T04:00:00.000Z';
  const errors: string[] = [];
  const live = new CatalogLiveReport({ ledger: () => ledger, cwd, onError: (m) => errors.push(m) });
  return { cwd, ledger, live, errors };
}

const reportPath = (cwd: string): string => join(cwd, 'reports', 'be100-csv-2026-09-02t04-00-00-000z.html');
const mediaDir = (cwd: string): string => join(cwd, 'reports', 'be100-csv-2026-09-02t04-00-00-000z-media');

describe('the report exists before any verdict', () => {
  it('is written at start with every planned case a never-ran row, marked in progress', async () => {
    const { cwd, live } = fixture();
    const first = await live.refresh();
    assert.ok(first !== null);
    assert.equal(first.htmlPath, reportPath(cwd));
    const html = readFileSync(reportPath(cwd), 'utf8');
    for (const id of ['BE_01_01', 'BE_01_02', 'BE_02_01']) assert.ok(html.includes(id), id);
    assert.match(html, /never ran: <b>3<\/b>/);
    assert.match(html, /in progress — 0 of 3/);
    assert.match(html, /http-equiv="refresh"/);
    // The run workbook exists too, saying there is nothing in it yet; no media folder.
    assert.ok(existsSync(first.excel.xlsxPath));
    assert.ok(!existsSync(mediaDir(cwd)));
    // And the findings export, beside the report from the first write.
    assert.equal(first.findings.markdownPath, join(cwd, 'reports', 'be100-csv-2026-09-02t04-00-00-000z-findings.md'));
    assert.ok(existsSync(first.findings.markdownPath));
    assert.ok(existsSync(first.findings.xlsxPath));
    assert.equal(first.findings.findings, 0);
  });
});

describe('the findings export rides with the report', () => {
  it('`wowlidator report`\'s path — writeCatalogArtifacts over a fixture ledger — writes <base>-findings.md from the ledgers alone', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'wow-live-'));
    const ledger = newLedger('be100.csv', ['BE_01_01', 'BE_01_02', 'BE_02_01']);
    ledger.runKey = 'be100-csv@2026-09-02T04:00:00.000Z';
    // Two cases that met the same 500 on the same endpoint, their bundles on disk as an earlier pass left them.
    for (const id of ['BE_01_01', 'BE_01_02']) {
      const failed = bundle(`${id} create`, 'failed', {
        steps: [
          step({ index: 0, action: 'request', url: null, request: { method: 'POST', url: 'http://api.test/v1/plans', status: 500, durationMs: 50 } } as Partial<ProofStep>),
          step({ index: 1, action: 'expectStatus', url: null, status: 'failed', detail: { expected: [201], actual: '500 Internal Server Error' } }),
        ],
      });
      const proofPath = join(cwd, `${id}.json`);
      writeFileSync(proofPath, JSON.stringify(failed), 'utf8');
      recordOutcome(ledger, { name: failed.name, verdict: 'failed', bundle: failed, reason: 'step 1 broke' }, { proofPath });
    }
    const cases = await buildCatalogReportCases(ledger, async (id) => {
      const proofPath = ledger.outcomes[id]?.proofPath;
      return typeof proofPath === 'string' ? (JSON.parse(readFileSync(proofPath, 'utf8')) as ProofBundle) : null;
    });
    const artifacts = await writeCatalogArtifacts({ title: ledger.title, runKey: ledger.runKey, generatedAt: null, cases }, cwd);
    const mdPath = artifacts.htmlPath.replace(/\.html$/, '-findings.md');
    assert.equal(artifacts.findings.markdownPath, mdPath);
    assert.ok(existsSync(mdPath));
    const md = readFileSync(mdPath, 'utf8');
    assert.ok(md.includes('1 finding account for 2 of 2 non-passing cases · 0 unclustered'));
    assert.ok(md.includes('POST /v1/plans answered 500'));
    assert.ok(md.includes('BE_01_01 (failed), BE_01_02 (failed)'));
    assert.ok(md.includes('Never ran (1)'));
    assert.ok(existsSync(artifacts.findings.xlsxPath));
    // The HTML leads with the same finding.
    const html = readFileSync(artifacts.htmlPath, 'utf8');
    assert.ok(html.includes('1 finding account for 2 of 2 non-passing cases · 0 unclustered'));
  });
});

describe('each finished case replaces its row', () => {
  it('a pass gets its verdict, its evidence and its own workbook; the file is the same one', async () => {
    const { cwd, ledger, live } = fixture();
    await live.refresh();
    const passed = bundle('BE_01_01 create a plan', 'passed');
    recordOutcome(ledger, { name: passed.name, verdict: 'passed', bundle: passed }, {});
    live.record(passed.name, passed);
    await live.refresh();
    const html = readFileSync(reportPath(cwd), 'utf8');
    assert.match(html, /passed: <b>1<\/b>/);
    assert.match(html, /never ran: <b>2<\/b>/);
    assert.match(html, /in progress — 1 of 3/);
    assert.ok(html.includes('data:image/jpeg;base64,'), 'the screenshot is in the report');
    assert.ok(html.includes('be100-csv-2026-09-02t04-00-00-000z-media/be-01-01.xlsx'), 'the export link');
    assert.ok(existsSync(join(mediaDir(cwd), 'be-01-01.xlsx')), 'the per-case workbook');
    assert.deepEqual(readdirSync(join(cwd, 'reports')).filter((f) => f.endsWith('.html')), ['be100-csv-2026-09-02t04-00-00-000z.html']);
  });

  it('a failure gets its row and a disabled export, and no workbook', async () => {
    const { cwd, ledger, live } = fixture();
    const failed = bundle('BE_01_02 delete a plan', 'failed');
    recordOutcome(ledger, { name: failed.name, verdict: 'failed', bundle: failed, reason: 'step 0 broke' }, {});
    live.record(failed.name, failed);
    await live.refresh();
    const html = readFileSync(reportPath(cwd), 'utf8');
    assert.match(html, /test failed: <b>1<\/b>/);
    assert.match(html, /<button class="btn export-case" type="button" disabled/);
    assert.ok(!existsSync(join(mediaDir(cwd), 'be-01-02.xlsx')));
  });

  it('the final refresh drops the in-progress marker', async () => {
    const { cwd, live } = fixture();
    await live.refresh();
    await live.refresh(true);
    const html = readFileSync(reportPath(cwd), 'utf8');
    assert.ok(!html.includes('http-equiv="refresh"'));
    assert.ok(!html.includes('in progress'));
  });
});

describe('a rerun updates in place', () => {
  it('a case that passed and now fails loses its export; the report is still one file', async () => {
    const { cwd, ledger, live } = fixture();
    const passed = bundle('BE_01_01 create a plan', 'passed');
    recordOutcome(ledger, { name: passed.name, verdict: 'passed', bundle: passed }, {});
    live.record(passed.name, passed);
    await live.refresh();
    assert.ok(existsSync(join(mediaDir(cwd), 'be-01-01.xlsx')));

    const failed = bundle('BE_01_01 create a plan', 'failed');
    recordOutcome(ledger, { name: failed.name, verdict: 'failed', bundle: failed, reason: 'gone red' }, {});
    live.record(failed.name, failed);
    const result = await live.refresh();
    assert.ok(result !== null);
    assert.deepEqual(result.excel.removed, [join(mediaDir(cwd), 'be-01-01.xlsx')]);
    assert.ok(!existsSync(join(mediaDir(cwd), 'be-01-01.xlsx')));
    const html = readFileSync(reportPath(cwd), 'utf8');
    assert.match(html, /test failed: <b>1<\/b>/);
    assert.ok(!html.includes('passed: <b>'));
    assert.equal(readdirSync(join(cwd, 'reports')).filter((f) => f.endsWith('.html')).length, 1);
  });

  it('a resume reads an earlier pass’s bundle from the ledger’s proofPath, so the report answers for the whole catalog', async () => {
    const { cwd, ledger, live } = fixture();
    const earlier = bundle('BE_02_01 list plans', 'passed');
    const proofPath = join(cwd, 'earlier.json');
    writeFileSync(proofPath, JSON.stringify(earlier), 'utf8');
    recordOutcome(ledger, { name: earlier.name, verdict: 'passed', bundle: earlier }, { proofPath });
    // Nothing recorded in memory: this process never ran BE_02_01.
    await live.refresh();
    const html = readFileSync(reportPath(cwd), 'utf8');
    assert.match(html, /passed: <b>1<\/b>/);
    assert.ok(html.includes('data:image/jpeg;base64,'), 'the carried evidence is embedded');
    assert.ok(existsSync(join(mediaDir(cwd), 'be-02-01.xlsx')));
  });

  it('a proof file that is gone leaves a row with its verdict and no evidence, never an error', async () => {
    const { cwd, ledger, live, errors } = fixture();
    recordOutcome(ledger, { name: 'BE_02_01 list plans', verdict: 'passed', bundle: null }, { proofPath: join(cwd, 'missing.json') });
    await live.refresh();
    assert.deepEqual(errors, []);
    const html = readFileSync(reportPath(cwd), 'utf8');
    assert.match(html, /passed: <b>1<\/b>/);
    assert.ok(html.includes('No steps were recorded'));
  });
});

describe('concurrency', () => {
  it('overlapping refreshes collapse into one more write, and settle waits for all of them', async () => {
    const { cwd, ledger, live } = fixture();
    const a = bundle('BE_01_01 a', 'passed');
    const b = bundle('BE_01_02 b', 'passed');
    recordOutcome(ledger, { name: a.name, verdict: 'passed', bundle: a }, {});
    live.record(a.name, a);
    const p1 = live.refresh();
    recordOutcome(ledger, { name: b.name, verdict: 'passed', bundle: b }, {});
    live.record(b.name, b);
    const p2 = live.refresh();
    const p3 = live.refresh();
    await Promise.all([p1, p2, p3]);
    await live.settle();
    const html = readFileSync(reportPath(cwd), 'utf8');
    // The trailing write saw both cases.
    assert.match(html, /passed: <b>2<\/b>/);
    assert.ok(existsSync(join(mediaDir(cwd), 'be-01-01.xlsx')));
    assert.ok(existsSync(join(mediaDir(cwd), 'be-01-02.xlsx')));
  });

  it('a write that fails is reported, not thrown', async () => {
    const ledger = newLedger('x', ['A_01_01']);
    ledger.runKey = 'x@1';
    const errors: string[] = [];
    // A file where the reports directory should be — mkdir will refuse.
    const cwd = mkdtempSync(join(tmpdir(), 'wow-live-'));
    writeFileSync(join(cwd, 'reports'), 'not a directory', 'utf8');
    const live = new CatalogLiveReport({ ledger: () => ledger, cwd, onError: (m) => errors.push(m) });
    const result = await live.refresh();
    assert.equal(result, null);
    assert.equal(errors.length, 1);
  });
});

describe('the rows', () => {
  it('scenario falls back to the id prefix, and the order is the plan order', async () => {
    assert.equal(scenarioFromId('PL_06_05'), 'PL_06');
    assert.equal(scenarioFromId('HIR-EC-010'), 'HIR-EC', 'a dashed id groups by its family, not under "ungrouped"');
    assert.equal(scenarioFromId('42'), 'ungrouped');
    const ledger = newLedger('t', ['B_01_01', 'A_01_01']);
    const cases = await buildCatalogReportCases(ledger, async () => null);
    assert.deepEqual(cases.map((c) => c.id), ['B_01_01', 'A_01_01']);
    assert.deepEqual(cases.map((c) => c.verdict), ['never-ran', 'never-ran']);
  });
});
