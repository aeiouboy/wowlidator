/**
 * The catalog report (`src/reporter/catalog-report.ts`).
 *
 * Mostly unit-tier: the render is a pure function over ledger-shaped cases,
 * and every claim the page makes (grouping, embedding, the two panes, export)
 * is a string here.
 *
 * One tier above it, gated on CDP: **that the embedded recording actually
 * plays.** No string check can prove that. Chrome refuses a `data:` video
 * silently — the element sits at `readyState 0` with no error, which reads
 * exactly like a corrupt file — and the whole Blob indirection exists because
 * of it. A test that asserted only the markup would pass on a report whose
 * every player spins forever, which is the bug this feature was written to
 * fix. It runs against the real `tests/fixtures/recording.webm`, on the same
 * "a reader tested only against its own writer proves nothing" rule as the
 * `.xlsx` and `.pdf` there.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProofBundle, ProofStep } from '../src/engine/proof-bundle.js';
import {
  RECORDING_BUDGET_BYTES,
  REPORT_HTML_CEILING_BYTES,
  SCREENSHOT_BUDGET_BYTES,
  catalogHeadline,
  catalogReportPath,
  renderCatalogReport,
  verdictChipOf,
  type CatalogReportCase,
} from '../src/reporter/catalog-report.js';

function step(over: Partial<ProofStep>): ProofStep {
  return {
    index: 0, action: 'goto', intent: undefined, selector: null, resolvedSelector: null,
    resolution: null, status: 'passed', startedAt: '2026-08-31T04:00:00.000Z', durationMs: 350,
    url: 'http://localhost:3000/en/login',
    ...over,
  } as ProofStep;
}

function bundle(steps: ProofStep[], over: Partial<ProofBundle> = {}): ProofBundle {
  return {
    runId: 'r1', name: 'PL_02_01 first', status: 'passed',
    startedAt: '2026-08-31T04:00:00.000Z', finishedAt: '2026-08-31T04:01:00.000Z',
    durationMs: 60_000, caseDurationMs: 61_000, cdpUrl: null, cachePath: null, healerModel: null,
    summary: { totalSteps: steps.length, passed: steps.length, failed: 0 } as ProofBundle['summary'],
    defects: [], steps,
    ...over,
  } as ProofBundle;
}

function kase(over: Partial<CatalogReportCase>): CatalogReportCase {
  return {
    id: 'PL_02_01', name: 'PL_02_01 first', scenario: 'PL_02', verdict: 'passed',
    status: 'passed', reason: null, bundle: bundle([step({})]), history: [],
    ...over,
  };
}

describe('grouping and coverage', () => {
  it('groups by scenario with a passed-count; a never-ran case is counted and folded, a blocked one with no bundle is a row', () => {
    const html = renderCatalogReport({
      title: 'be100', runKey: 'be100-csv@2026', generatedAt: null,
      cases: [
        kase({}),
        kase({ id: 'PL_02_02', name: 'PL_02_02 second', verdict: 'never-ran', status: null, bundle: null }),
        kase({ id: 'PL_02_03', name: 'PL_02_03 third', verdict: 'blocked', status: null, bundle: null, reason: 'the run was paused' }),
        kase({ id: 'PL_06_01', name: 'PL_06_01 other', scenario: 'PL_06' }),
      ],
    });
    assert.match(html, /<section class="scenario"><div class="shead">PL_02/);
    assert.match(html, /PL_06/);
    assert.match(html, /1 of 3 passed/);
    assert.match(html, />never ran</);
    // The never-ran row lives in the fold (its id still in the DOM), the blocked row is a section of its own.
    assert.match(html, /<details class="never-ran"[^>]*>[\s\S]*PL_02_02/);
    assert.match(html, /No steps were recorded — the run was paused/);
  });

  it('the chip follows the two-family taxonomy', () => {
    assert.equal(verdictChipOf(kase({ verdict: 'failed', status: 'dead-end' })).label, 'test failed (dead-end)');
    assert.equal(verdictChipOf(kase({ verdict: 'failed', status: 'error' })).label, 'system error');
    assert.equal(verdictChipOf(kase({ verdict: 'passed', status: 'passed-with-issues' })).label, 'pass**');
    assert.equal(verdictChipOf(kase({ verdict: 'review', status: 'needs-review' })).label, 'needs review');
  });
});

describe('catalog headline', () => {
  it('folds chip classifications into four exclusive headline buckets', () => {
    const headline = catalogHeadline([
      kase({ verdict: 'passed', status: 'passed' }),
      kase({ id: 'PL_02_02', verdict: 'passed', status: 'passed-with-issues' }),
      kase({ id: 'PL_02_03', verdict: 'failed', status: 'failed' }),
      kase({ id: 'PL_02_04', verdict: 'failed', status: 'dead-end' }),
      kase({ id: 'PL_02_05', verdict: 'review', status: 'needs-review' }),
      kase({ id: 'PL_02_06', verdict: 'blocked', status: null, bundle: null }),
      kase({ id: 'PL_02_07', verdict: 'failed', status: 'error' }),
      kase({ id: 'PL_02_08', verdict: 'never-ran', status: null, bundle: null }),
    ]);

    assert.deepEqual(headline, { passed: 2, failed: 2, review: 1, noVerdict: 3, decided: 4, total: 8 });
    assert.equal(headline.passed + headline.failed + headline.review + headline.noVerdict, headline.total);
  });

  it('reports the live-run mix as 27 decided cases and a rounded 30% pass rate', () => {
    const cases = [
      ...Array.from({ length: 8 }, (_, index) => kase({ id: `PASS_${index}`, verdict: 'passed' })),
      ...Array.from({ length: 19 }, (_, index) => kase({ id: `FAIL_${index}`, verdict: 'failed', status: 'failed' })),
      ...Array.from({ length: 2 }, (_, index) => kase({ id: `REVIEW_${index}`, verdict: 'review', status: 'needs-review' })),
      ...Array.from({ length: 280 }, (_, index) => kase({ id: `BLOCKED_${index}`, verdict: 'blocked', status: null, bundle: null })),
    ];

    assert.equal(catalogHeadline(cases).decided, 27);
    const html = renderCatalogReport({ title: 't', runKey: null, generatedAt: null, cases });
    assert.match(html, /pass rate 30% — 8 of 27 cases that reached a verdict/);
    assert.match(html, /headline-count review"><b>2<\/b><span>review<\/span>/);
  });

  it('renders the headline above the original tally and always renders verdict coverage', () => {
    const html = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [
        kase({}),
        kase({ id: 'PL_02_02', verdict: 'failed', status: 'dead-end' }),
        kase({ id: 'PL_02_03', verdict: 'blocked', status: null, bundle: null }),
      ],
    });

    assert.match(html, /class="headline"[\s\S]*>1<[^>]*>[\s\S]*passed[\s\S]*>1<[^>]*>[\s\S]*failed[\s\S]*>1<[^>]*>[\s\S]*no verdict/);
    assert.match(html, /pass rate 50% — 1 of 2 cases that reached a verdict/);
    assert.match(html, /2 of 3 cases have a verdict \(67%\)/);
    assert.ok(html.indexOf('class="headline"') < html.indexOf('class="tally"'));
    assert.match(html, /class="tally"[\s\S]*test failed \(dead-end\): <b>1<\/b>/);

    const undecided = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [kase({ verdict: 'never-ran', status: null, bundle: null })],
    });
    assert.doesNotMatch(undecided, /pass rate/);
    assert.match(undecided, /0 of 1 cases have a verdict \(0%\)/);
  });

  it('renders an all-passed run with 100% pass rate and coverage', () => {
    const html = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [kase({}), kase({ id: 'PL_02_02' })],
    });

    assert.match(html, /pass rate 100% — 2 of 2 cases that reached a verdict/);
    assert.match(html, /2 of 2 cases have a verdict \(100%\)/);
    assert.doesNotMatch(html, /headline-count review/);
  });
});

describe('the two panes', () => {
  it('left holds expandable steps with detail; right holds the time record with the slow budget named', () => {
    const html = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [kase({
        history: ['newly broken — passed until yesterday'],
        bundle: bundle([
          step({ index: 0, intent: 'open the page' }),
          step({ index: 1, action: 'click', selector: 'role=button[name="Save" i]', status: 'failed', durationMs: 2500, error: 'no element matches' }),
        ], { status: 'failed', notes: ['pre-run dead-end risk 20%'] }),
        verdict: 'failed', status: 'failed',
      })],
    });
    assert.match(html, /class="steps-pane"/);
    assert.match(html, /class="time-pane"/);
    assert.match(html, /<details class="step no"/);
    assert.match(html, /no element matches/);
    assert.match(html, /Time record — /);
    assert.match(html, /tbar slow broke/);
    assert.match(html, /2s fast-path budget/);
    assert.match(html, /From the run history/);
    assert.match(html, /newly broken — passed until yesterday/);
    assert.match(html, /Run notes/);
  });
});

describe('embedded evidence and the budget', () => {
  it('embeds screenshots as data URIs; a failure still is embedded past the budget, a routine one is omitted with a note', () => {
    const big = 'A'.repeat(SCREENSHOT_BUDGET_BYTES + 10);
    const html = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [
        kase({ bundle: bundle([step({ screenshot: big })]) }), // routine, over budget alone
        kase({
          id: 'PL_02_03', name: 'PL_02_03 f', verdict: 'failed', status: 'failed',
          bundle: bundle([step({ status: 'failed', screenshot: 'FAILSHOT' })], { status: 'failed' }),
        }),
      ],
    });
    assert.match(html, /data:image\/jpeg;base64,FAILSHOT/, 'failure stills always embed');
    assert.ok(!html.includes(big), 'the over-budget routine still is not embedded');
    assert.match(html, /omitted for size — it stays in the proof bundle/);
    assert.match(html, /routine screenshot\(s\) omitted/);
  });

  it('keeps a small report byte-identical when the optional spill sink is unused', () => {
    const input = {
      title: 't', runKey: null, generatedAt: null,
      cases: [kase({ bundle: bundle([step({ screenshot: 'SMALLSHOT' })]) })],
    };
    const withoutSink = renderCatalogReport(input);
    const withUnusedSink = renderCatalogReport({
      ...input,
      spillScreenshot: () => {
        throw new Error('a small report must not call the spill sink');
      },
    });

    assert.equal(withUnusedSink, withoutSink);
    assert.equal((withUnusedSink.match(/data:image/g) ?? []).length, 1);
    assert.ok(!withUnusedSink.includes('shots/'));
  });

  it('spills a routine screenshot after the inline budget and links the returned relative href', () => {
    const routine = 'QUJD'.repeat(250_000);
    const spilled = 'SPILL'.repeat(200_000);
    const calls: Array<{ caseId: string; stepIndex: number; base64: string }> = [];
    const cases = Array.from({ length: 16 }, (_, index) => {
      const id = `PL_02_${String(index + 1).padStart(2, '0')}`;
      return kase({
        id,
        name: `${id} case`,
        bundle: bundle([step({ index: index === 15 ? 7 : 0, screenshot: index === 15 ? spilled : routine })]),
      });
    });

    const html = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null, cases,
      spillScreenshot: (caseId, stepIndex, base64) => {
        calls.push({ caseId, stepIndex, base64 });
        return 't-media/shots/pl-02-16-7.jpg';
      },
    });

    assert.deepEqual(calls, [{ caseId: 'PL_02_16', stepIndex: 7, base64: spilled }]);
    assert.match(html, /src="t-media\/shots\/pl-02-16-7\.jpg"/);
    assert.ok(!html.includes(`data:image/jpeg;base64,${spilled}`));
  });

  it('keeps a failure inline after routine budget is spent, but spills one that would cross the hard ceiling', () => {
    const routine = 'A'.repeat(SCREENSHOT_BUDGET_BYTES + 1);
    const sinkCalls: string[] = [];
    const prioritized = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [
        kase({ bundle: bundle([step({ screenshot: routine })]) }),
        kase({
          id: 'PL_02_02', name: 'PL_02_02 failed', verdict: 'failed', status: 'failed',
          bundle: bundle([step({ status: 'failed', screenshot: 'FAILSHOT' })], { status: 'failed' }),
        }),
      ],
      spillScreenshot: (caseId) => {
        sinkCalls.push(caseId);
        return `t-media/shots/${caseId}.jpg`;
      },
    });
    assert.deepEqual(sinkCalls, ['PL_02_01']);
    assert.match(prioritized, /data:image\/jpeg;base64,FAILSHOT/);

    const overCeiling = 'A'.repeat(REPORT_HTML_CEILING_BYTES + 1);
    const ceilingCalls: string[] = [];
    const capped = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [kase({
        id: 'PL_02_03', name: 'PL_02_03 failed', verdict: 'failed', status: 'failed',
        bundle: bundle([step({ status: 'failed', screenshot: overCeiling })], { status: 'failed' }),
      })],
      spillScreenshot: (caseId) => {
        ceilingCalls.push(caseId);
        return 't-media/shots/ceiling.jpg';
      },
    });
    assert.deepEqual(ceilingCalls, ['PL_02_03']);
    assert.match(capped, /src="t-media\/shots\/ceiling\.jpg"/);
    assert.doesNotMatch(capped, /data:image\/jpeg;base64,/);
  });

  it('falls back to the proof-bundle omission when the spill sink cannot take a screenshot', () => {
    const html = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [kase({ bundle: bundle([step({ screenshot: 'A'.repeat(SCREENSHOT_BUDGET_BYTES + 1) })]) })],
      spillScreenshot: () => null,
    });

    assert.match(html, /omitted for size — it stays in the proof bundle/);
    assert.match(html, /routine screenshot\(s\) omitted/);
  });

  it('adds the beside-this-file spill count only when a screenshot spilled', () => {
    const input = {
      title: 't', runKey: null, generatedAt: null,
      cases: [kase({ bundle: bundle([step({ screenshot: 'A'.repeat(SCREENSHOT_BUDGET_BYTES + 1) })]) })],
    };
    const withoutSpill = renderCatalogReport(input);
    const withSpill = renderCatalogReport({
      ...input,
      spillScreenshot: () => 't-media/shots/pl-02-01-0.jpg',
    });

    assert.ok(!withoutSpill.includes('screenshot(s) written beside this file'));
    assert.match(withSpill, /1 screenshot\(s\) written beside this file in t-media\/shots\//);
  });
});

describe('export', () => {
  it('a case exports to its own workbook, relative to this file, beside the recording', () => {
    const html = renderCatalogReport({ title: 't', runKey: 'pl-02@2026-08-31T04:00:00.000Z', generatedAt: null, cases: [kase({})] });
    assert.match(html, /<a class="btn export-case" download href="pl-02-2026-08-31t04-00-00-000z-media\/pl-02-01\.xlsx"/);
    assert.match(html, /Export \(Excel\)/);
    // The link must not toggle the case open as a side effect of downloading.
    assert.match(html, /export-case" download href="[^"]+" onclick="event\.stopPropagation\(\)"/);
  });

  it('failed, blocked, and review cases link their own workbooks too', () => {
    for (const verdict of ['failed', 'blocked', 'review'] as const) {
      const html = renderCatalogReport({
        title: 't', runKey: null, generatedAt: null,
        cases: [kase({ verdict, status: 'failed', bundle: bundle([step({ status: 'failed' })]) })],
      });
      assert.match(html, /<a class="btn export-case" download href="t-media\/pl-02-01\.xlsx"/, verdict);
    }
    // A never-ran case has no section at all, so no button either — and no workbook link.
    const folded = renderCatalogReport({ title: 't', runKey: null, generatedAt: null, cases: [kase({ verdict: 'never-ran', status: null, bundle: null })] });
    assert.ok(!folded.includes('export-case'));
    assert.ok(!folded.includes('pl-02-01.xlsx'));
  });

  it('the header links the run workbook and still exports the whole catalog client-side', () => {
    const html = renderCatalogReport({ title: 't', runKey: 'pl-02@2026-08-31T04:00:00.000Z', generatedAt: null, cases: [kase({})] });
    assert.match(html, /function exportCatalog\(/);
    assert.match(html, /Export catalog/);
    assert.match(html, /href="pl-02-2026-08-31t04-00-00-000z-cases\.xlsx"/);
  });

  it('a live report says it is in progress and reloads itself; a finished one does neither', () => {
    const cases = [kase({}), kase({ id: 'PL_02_02', name: 'PL_02_02 later', verdict: 'never-ran', status: null, bundle: null })];
    const live = renderCatalogReport({ title: 't', runKey: null, generatedAt: null, cases, live: true });
    assert.match(live, /in progress — 1 of 2 case\(s\) finished/);
    assert.match(live, /<meta http-equiv="refresh" content="60"\/>/);
    const done = renderCatalogReport({ title: 't', runKey: null, generatedAt: null, cases });
    assert.ok(!done.includes('http-equiv="refresh"'));
    assert.ok(!done.includes('in progress'));
  });
});

describe('safety and paths', () => {
  it('escapes case names — application text cannot become markup', () => {
    const html = renderCatalogReport({
      title: '<script>x</script>', runKey: null, generatedAt: null,
      cases: [kase({ name: 'PL_02_01 <img src=x onerror=alert(1)>' })],
    });
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes('<script>x</script>'));
  });

  it('the path is reports/<runKey slug>.html, stable per run key', () => {
    const p = catalogReportPath('be100-csv@2026-08-31T03:33:23.997Z', 'be100', '/tmp/x');
    assert.match(p, /^\/tmp\/x\/reports\/be100-csv-2026-08-31t03-33-23-997z\.html$/);
    assert.equal(catalogReportPath(null, 'My Catalog', '/tmp/x'), '/tmp/x/reports/my-catalog.html');
  });
});

/* -------------------------------------------------------------- findings */

/**
 * The block under the tally (2026-09-05, `findings.ts`): root causes first,
 * every member linked to its section, statuses exactly as sealed, and the
 * never-ran remainder as ONE list rather than a section each.
 */
describe('findings lead the report', () => {
  const apiFailure = (id: string, status: string, path: string): CatalogReportCase =>
    kase({
      id, name: `${id} api`, scenario: 'BE_01', verdict: 'failed', status,
      bundle: bundle(
        [
          step({ index: 0, action: 'request', url: null, request: { method: 'POST', url: `http://api.test${path}`, status: 500, durationMs: 80 } } as Partial<ProofStep>),
          step({ index: 1, action: 'expectStatus', url: null, status: status === 'error' ? 'error' : 'failed', detail: { expected: [201], actual: '500 Internal Server Error' } }),
        ],
        { status: status as ProofBundle['status'] },
      ),
    });
  const urlFailure = (id: string): CatalogReportCase =>
    kase({
      id, name: `${id} url`, scenario: 'UI_01', verdict: 'failed', status: 'failed',
      bundle: bundle([step({ index: 0, action: 'expectUrl', status: 'failed', url: 'http://app.test/en/login', detail: { expected: '/plans', actual: 'http://app.test/en/login' } })], { status: 'failed' }),
    });
  const anchorOf = (id: string): string => id.toLowerCase().replace(/_/g, '-');

  it('states the exact count line, links every member to its section, and shows statuses as the ledger sealed them', () => {
    const html = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [
        apiFailure('BE_01_01', 'failed', '/v1/plans'),
        apiFailure('BE_01_02', 'error', '/v1/plans'),
        urlFailure('UI_01_01'),
        kase({ id: 'UI_01_02', name: 'UI_01_02 lone', scenario: 'UI_01', verdict: 'failed', status: 'failed', bundle: bundle([step({ status: 'failed' })], { status: 'failed' }) }),
        kase({}),
      ],
    });
    const block = html.match(/<section class="findings" id="findings">[\s\S]*?<\/section>/)?.[0] ?? '';
    assert.ok(block !== '', 'the block exists');
    assert.ok(block.includes('2 findings account for 3 of 4 non-passing cases · 1 unclustered'), block.slice(0, 400));
    for (const id of ['BE_01_01', 'BE_01_02', 'UI_01_01', 'UI_01_02']) {
      assert.ok(block.includes(`<a href="#case-${anchorOf(id)}">${id}</a>`), `${id} links to its section`);
      assert.ok(html.includes(`<details class="case" id="case-${anchorOf(id)}"`), `${id} has a section`);
    }
    assert.ok(block.includes('POST /v1/plans answered 500'));
    // The sealed status, not a relabel: the error case reads `error` and is counted as one.
    assert.match(block, /BE_01_02<\/a> <code class="sealed">error<\/code>/);
    assert.ok(block.includes('2 cases · failed: 1 · error: 1'));
    assert.ok(block.includes('<span class="fkind">api</span>'));
    assert.ok(block.includes('<details class="finding unclustered">'));
    assert.ok(!block.includes('PL_02_01'), 'a passed case is in no finding');
  });

  it('a run with nothing failed has no findings block', () => {
    const html = renderCatalogReport({ title: 't', runKey: null, generatedAt: null, cases: [kase({})] });
    assert.ok(!html.includes('<section class="findings"'));
  });

  it('a dependent is listed under its prerequisite\'s finding, marked', () => {
    const html = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [
        apiFailure('BE_01_01', 'failed', '/v1/plans'),
        kase({ id: 'BE_01_02', name: 'BE_01_02 dep', scenario: 'BE_01', verdict: 'blocked', status: null, bundle: null, reason: 'depends on BE_01_01 which failed' }),
      ],
    });
    const block = html.match(/<section class="findings" id="findings">[\s\S]*?<\/section>/)?.[0] ?? '';
    assert.ok(block.includes('1 finding account for 2 of 2 non-passing cases · 0 unclustered'));
    assert.match(block, /BE_01_02<\/a> <code class="sealed">blocked<\/code> <em[^>]*>↳ depends on BE_01_01<\/em>/);
  });

  it('252 never-ran cases render as ONE details block listing every id, and no section each', () => {
    const neverRan = Array.from({ length: 252 }, (_, i) =>
      kase({
        id: `NR_${String(Math.floor(i / 20) + 1).padStart(2, '0')}_${String((i % 20) + 1).padStart(2, '0')}`,
        name: `never ${i}`, scenario: `NR_${Math.floor(i / 20) + 1}`, verdict: 'never-ran', status: null, bundle: null,
      }),
    );
    const html = renderCatalogReport({ title: 't', runKey: null, generatedAt: null, cases: [kase({}), ...neverRan] });
    assert.equal((html.match(/<details class="never-ran"/g) ?? []).length, 1);
    const fold = html.match(/<details class="never-ran"[\s\S]*?<\/details>/)?.[0] ?? '';
    assert.ok(fold.includes('252 cases never ran'));
    assert.ok(fold.includes('>NR_07_13<'), 'a sampled id is in the list');
    assert.equal((fold.match(/class="nid"/g) ?? []).length, 252, 'every id is in the DOM');
    assert.equal((html.match(/<details class="case"/g) ?? []).length, 1, 'only the case that ran has a section');
    assert.ok(!html.includes('<details class="case" id="case-nr-07-13"'), 'no per-case section for a never-ran row');
    assert.match(html, /never ran: <b>252<\/b>/, 'the tally still counts them');
  });
});

/* --------------------------------------------------------- the recording */

/**
 * The film, and why it has to be here (2026-08-31). The runner's screenshot
 * default is video-aware: while it is filming, stills are taken only at
 * failures, because the film covers the rest. Measured on be100-rip's bundles,
 * that is exactly what they hold — all 13 non-passing cases carry stills and
 * 18 of 19 passing ones carry none. A report that dropped the recording
 * therefore left a reader with no evidence at all for every case that worked.
 */
const withVideo = (over: Partial<CatalogReportCase>, data: string, over2: Partial<ProofBundle> = {}): CatalogReportCase =>
  kase({
    ...over,
    bundle: bundle([step({}), step({ index: 1, action: 'click', videoOffsetMs: 2110 })], {
      video: { data, width: 960, height: 540 },
      ...over2,
    } as Partial<ProofBundle>),
  });

describe('the recording in the page', () => {
  const render = (cases: CatalogReportCase[]): string =>
    renderCatalogReport({ title: 't', runKey: null, generatedAt: null, cases });

  it('carries the bytes on an attribute, never as a data: URI', () => {
    const html = render([withVideo({ id: 'A' }, 'QUJD')]);
    // Chrome will not load a `data:` video — the element sits at readyState 0
    // forever with no error, which reads exactly like a corrupt recording.
    assert.match(html, /<video[^>]*data-webm="QUJD"/);
    assert.doesNotMatch(html, /src="data:video/);
    assert.match(html, /wowHydrateVideo/, 'and the page carries what turns it into a Blob');
  });

  it('keeps a small report byte-identical when both optional spill sinks are unused', () => {
    const input = {
      title: 't', runKey: null, generatedAt: null,
      cases: [withVideo({ id: 'A' }, 'QUJD')],
    };
    const current = renderCatalogReport(input);
    const withUnusedSinks = renderCatalogReport({
      ...input,
      spillScreenshot: () => {
        throw new Error('a small report must not spill screenshots');
      },
      spillRecording: () => {
        throw new Error('a small report must not spill recordings');
      },
    });

    assert.equal(withUnusedSinks, current);
    assert.match(withUnusedSinks, /<video[^>]*data-webm="QUJD"/);
    assert.doesNotMatch(withUnusedSinks, /<video[^>]* src=/);
  });

  it('spills an over-budget recording to a file-backed video and preserves the failure offset', () => {
    const recording = 'V'.repeat(RECORDING_BUDGET_BYTES + 1);
    const calls: Array<{ caseId: string; base64: string }> = [];
    const html = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [kase({
        id: 'PL_02_03', verdict: 'failed', status: 'failed',
        bundle: bundle([step({ status: 'failed', videoOffsetMs: 4500 })], {
          status: 'failed',
          video: { data: recording, width: 960, height: 540 },
        } as Partial<ProofBundle>),
      })],
      spillRecording: (caseId, base64) => {
        calls.push({ caseId, base64 });
        return 't-media/pl-02-03.webm';
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.caseId, 'PL_02_03');
    assert.ok(calls[0]?.base64 === recording);
    assert.match(html, /<video[^>]* src="t-media\/pl-02-03\.webm"[^>]*data-failure-offset="4\.50"/);
    assert.doesNotMatch(html, /<video[^>]*data-webm=/);
  });

  it('spills both media kinds when their shared inline total reaches the hard ceiling', () => {
    const firstRecording = 'V'.repeat(RECORDING_BUDGET_BYTES);
    const crossingScreenshot = 'S'.repeat(REPORT_HTML_CEILING_BYTES - RECORDING_BUDGET_BYTES + 1);
    const screenshotCalls: string[] = [];
    const recordingCalls: string[] = [];
    const html = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [
        withVideo({ id: 'PL_02_01' }, firstRecording),
        kase({
          id: 'PL_02_02', verdict: 'failed', status: 'failed',
          bundle: bundle([step({ status: 'failed', screenshot: crossingScreenshot })], {
            status: 'failed',
            video: { data: 'NEXT', width: 960, height: 540 },
          } as Partial<ProofBundle>),
        }),
      ],
      spillScreenshot: (caseId) => {
        screenshotCalls.push(caseId);
        return 't-media/shots/pl-02-02-0.jpg';
      },
      spillRecording: (caseId) => {
        recordingCalls.push(caseId);
        return 't-media/pl-02-02.webm';
      },
    });

    assert.deepEqual(recordingCalls, ['PL_02_02']);
    assert.deepEqual(screenshotCalls, ['PL_02_02']);
    assert.match(html, /src="t-media\/pl-02-02\.webm"/);
    assert.match(html, /src="t-media\/shots\/pl-02-02-0\.jpg"/);
    assert.match(html, /1 screenshot\(s\) written beside this file[^<]* · 1 recording\(s\) written beside this file/);
  });

  it('uses the existing recording omission wording when its sink returns null', () => {
    const html = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [withVideo({ id: 'A' }, 'V'.repeat(RECORDING_BUDGET_BYTES + 1))],
      spillRecording: () => null,
    });

    assert.match(html, /the recording could not be embedded/);
    assert.doesNotMatch(html, /<video/);
  });

  it('does not decode until the case is opened', () => {
    const html = render([withVideo({ id: 'A' }, 'QUJD')]);
    assert.match(html, /preload="none"/);
    assert.match(html, /addEventListener\('toggle'/);
  });

  it('gives every filmed step a cue into the same file, on the summary where it can be seen', () => {
    const html = render([withVideo({ id: 'A' }, 'QUJD')]);
    assert.match(html, /data-seek="2\.11"/);
    // In the collapsed body a reader has to expand each step to discover that
    // seeking exists at all; a control nobody can see is not a control.
    const summary = /<summary>(?:(?!<\/summary>).)*data-seek/s;
    assert.match(html, summary);
  });

  it('opens a broken case ON the failure — the frame the recording was kept for', () => {
    const html = render([
      kase({
        id: 'A', verdict: 'failed',
        bundle: bundle([step({ index: 0, status: 'failed', videoOffsetMs: 4500 })], {
          video: { data: 'QUJD', width: 960, height: 540 },
        } as Partial<ProofBundle>),
      }),
    ]);
    assert.match(html, /data-failure-offset="4\.50"/);
  });

  it('keeps the old unlimited inline behaviour when no recording sink is supplied', () => {
    const html = renderCatalogReport({
      title: 't', runKey: null, generatedAt: null,
      cases: [withVideo({ id: 'A' }, 'x'.repeat(30_000_000))],
    });
    assert.match(html, /data-webm="x/);
    assert.doesNotMatch(html, /left out to keep this file portable/);
    assert.match(html, /data-seek=/);
  });

  it('says a recording FAILED differently from one that was never made', () => {
    const html = render([
      kase({
        id: 'A',
        bundle: bundle([step({})], {
          video: { data: '', width: 0, height: 0, omitted: 'the recording was 90MB' },
        } as Partial<ProofBundle>),
      }),
    ]);
    assert.match(html, /the recording was 90MB/);
  });

  it('an exported catalog takes the player and the bytes with it', () => {
    const html = render([withVideo({ id: 'A' }, 'QUJD')]);
    // The player rides the page as a value too, so a copy of the document
    // carries it; without it an export is a dead player in a file said to
    // hold the evidence.
    assert.match(html, /var WOW_PLAYER = /);
    // A Blob URL means nothing in another document, so it must be stripped…
    assert.match(html, /function wowStripBlobs/);
    // …while the base64 stays put, which is what makes the export playable.
    assert.match(html, /data-webm deliberately STAYS/);
  });
});

/* ------------------------------------------------- does it actually play */

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';

async function cdpAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

const browserReady = await cdpAvailable(CDP_URL);
const skipBrowser = browserReady
  ? false
  : `no CDP endpoint at ${CDP_URL} — start Chrome with --remote-debugging-port=9222 (npm run chrome)`;

describe('the recording plays (CDP)', { skip: skipBrowser }, () => {
  it('decodes on open, seeks from a step, and never toggles that step doing it', async () => {
    const { chromium } = await import('playwright');
    const webm = readFileSync(join(import.meta.dirname, 'fixtures', 'recording.webm')).toString('base64');
    const html = renderCatalogReport({
      title: 'plays', runKey: null, generatedAt: null,
      cases: [
        kase({
          id: 'A', verdict: 'failed',
          bundle: bundle(
            [step({ index: 0, videoOffsetMs: 0 }), step({ index: 1, action: 'click', videoOffsetMs: 500 })],
            { video: { data: webm, width: 960, height: 540 } } as Partial<ProofBundle>,
          ),
        }),
      ],
    });
    const file = join(mkdtempSync(join(tmpdir(), 'wow-catalog-')), 'report.html');
    writeFileSync(file, html, 'utf8');

    const browser = await chromium.connectOverCDP(CDP_URL);
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    try {
      await page.goto(`file://${file}`);
      // Nothing is decoded at load: a catalog holds dozens of these, and
      // building every Blob on first paint would stall the page to make
      // players nobody opened.
      assert.equal(await page.locator('video[data-wow-ready]').count(), 0);

      const kase1 = page.locator('details.case').first();
      await kase1.locator('> summary').click();
      // The test config has no DOM lib (tsconfig pins `types: ["node"]`), so
      // the page-side shapes are spelled structurally, as `src/` does.
      type VideoLike = { readyState: number; src: string; duration: number; currentTime: number; getAttribute(name: string): string | null };
      await page.waitForFunction(
        () => ((globalThis as { document?: { querySelector(sel: string): VideoLike | null } }).document?.querySelector('video')?.readyState ?? 0) >= 2,
        undefined,
        { timeout: 15_000 },
      );
      const video = kase1.locator('video').first();
      const state = await video.evaluate((el: VideoLike) => ({
        blob: el.src.startsWith('blob:'),
        duration: el.duration,
        kept: (el.getAttribute('data-webm') ?? '').length,
      }));
      assert.equal(state.blob, true, 'a Blob URL, because Chrome will not load a data: video');
      assert.ok(state.duration > 0, `the recording has a duration (${state.duration})`);
      assert.ok(state.kept > 0, 'and the base64 stays put, so an export of this case is playable');

      const seek = kase1.locator('button.seek').nth(1);
      assert.equal(await seek.isVisible(), true, 'the cue is on the summary, where a reader can see it');
      await seek.click();
      await page.waitForTimeout(500);
      assert.ok(
        (await video.evaluate((el: VideoLike) => el.currentTime)) > 0,
        'clicking a step cue moves the film',
      );
      assert.equal(
        await kase1.locator('details.step').nth(1).evaluate((el: { open: boolean }) => el.open),
        false,
        'and playing the film does not expand the step as a side effect',
      );
      assert.deepEqual(errors, []);
    } finally {
      await page.close().catch(() => undefined);
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  });
});
