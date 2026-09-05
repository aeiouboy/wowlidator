/**
 * Machine-readable output and the suite index (specs A1, R3).
 *
 * All unit-tier: both are pure functions of bundles the rest of the suite
 * already knows how to build. The redaction test is the one that matters most
 * — a new output format is a new way for a credential to escape, and "we only
 * tested the HTML" is exactly how that happens.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProofBundleBuilder, type ProofBundle } from '../src/engine/proof-bundle.js';
import { renderCtrf, renderJUnit } from '../src/reporter/machine-report.js';
import { rankEntries, renderSuiteIndex } from '../src/reporter/suite-index.js';
import { recordOf } from '../src/api/api-client.js';

const base = { startedAt: '2026-08-03T10:00:00.000Z', durationMs: 250, url: 'http://app/x' };

function bundleOf(name: string, build: (b: ProofBundleBuilder) => void): ProofBundle {
  const builder = new ProofBundleBuilder({ name, cdpUrl: null, cachePath: null });
  build(builder);
  return builder.finish();
}

const passing = bundleOf('happy path', (b) => {
  b.addStep({ action: 'goto', selector: null, resolvedSelector: null, resolution: null, status: 'passed', ...base });
  b.addStep({
    action: 'click',
    intent: 'Press the filter',
    selector: '#f',
    resolvedSelector: '#f',
    resolution: 'fast',
    status: 'passed',
    ...base,
  });
});

const failing = bundleOf('probation filter', (b) => {
  b.addStep({ action: 'goto', selector: null, resolvedSelector: null, resolution: null, status: 'passed', ...base });
  b.addStep({
    action: 'expectStatus',
    intent: 'The endpoint answers',
    selector: null,
    resolvedSelector: null,
    resolution: null,
    status: 'failed',
    ...base,
    error: 'expected status 200, got 500 Internal Server Error\n  detail line',
  });
});

describe('junit xml', () => {
  it('maps a skipped proof step to neutral JUnit and CTRF results', () => {
    const skipped = bundleOf('failed leg tail', (b) => {
      b.recordSkipped({ action: 'expectVisible', selector: 'text=Order' } as never, 'not run: depends on step 1');
    });
    assert.equal(skipped.summary.passed, 0);
    assert.equal(skipped.summary.failed, 0);
    const xml = renderJUnit([skipped]);
    assert.match(xml, /<skipped message="not run: depends on step 1"\/|<skipped message="not run: depends on step 1"\/>/);
    assert.match(xml, /failures="0" skipped="1"/);
    const ctrf = renderCtrf([skipped]);
    assert.equal(ctrf.results.tests[0]?.status, 'skipped');
    assert.equal(ctrf.results.summary.skipped, 1);
    assert.equal(ctrf.results.summary.failed, 0);
    assert.equal(ctrf.results.summary.passed, 0);
  });
  it('emits one testcase per step, named by the author intent', () => {
    const xml = renderJUnit([passing]);
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<testsuites name="wowlidator" tests="2" failures="0"/);
    assert.match(xml, /<testcase name="Press the filter"/);
  });

  it('separates the frontend and backend halves by classname', () => {
    // The whole point of the split reaching CI: a dashboard can group by it.
    const xml = renderJUnit([failing]);
    assert.match(xml, /classname="wowlidator\.backend\.probation filter"/);
    assert.match(xml, /classname="wowlidator\.frontend\.probation filter"/);
  });

  it('carries the failure message and the full trace', () => {
    const xml = renderJUnit([failing]);
    assert.match(xml, /<failure message="expected status 200, got 500 Internal Server Error"/);
    assert.match(xml, /detail line/);
    assert.match(xml, /failures="1"/);
  });

  it('records the verdict and owner as properties, so CI need not open the HTML', () => {
    const xml = renderJUnit([failing]);
    assert.match(xml, /<property name="wowlidator\.owner" value="backend"\/>/);
    assert.match(xml, /<property name="wowlidator\.verdict" value="[^"]+"\/>/);
  });

  it('reports a quarantined failure as skipped, not as a failure', () => {
    const quarantined: ProofBundle = { ...failing, quarantined: true };
    const xml = renderJUnit([quarantined]);
    assert.match(xml, /<skipped message="quarantined \(known flaky\)/);
    assert.ok(!/<failure /.test(xml), 'a quarantined case must not redden the pipeline');
    assert.match(xml, /failures="0" skipped="1"/);
  });

  it('escapes markup and strips characters XML cannot carry', () => {
    const nasty = bundleOf('<script>alert("x")</script>', (b) => {
      b.addStep({
        action: 'click',
        intent: 'quote " and & and  bell',
        selector: '#a',
        resolvedSelector: null,
        resolution: null,
        status: 'failed',
        ...base,
        error: 'boom <tag> & "quoted"',
      });
    });
    const xml = renderJUnit([nasty]);
    assert.ok(!/<script>/.test(xml));
    assert.ok(!//.test(xml), 'control characters would make the document unparseable');
    assert.match(xml, /&amp;/);
  });

  it('never lets a credential reach the output', () => {
    // Same guarantee the HTML report has, asserted here too: a new format is a
    // new escape route, and inheriting redaction is only true if tested.
    const withAuth = bundleOf('authed', (b) => {
      b.addStep({
        action: 'request',
        selector: null,
        resolvedSelector: null,
        resolution: null,
        status: 'passed',
        ...base,
        request: recordOf(
          {
            method: 'GET',
            url: 'https://api.example.com/orders',
            headers: { authorization: 'Bearer super-secret-token' },
          },
          { status: 200, statusText: 'OK', headers: {}, body: '{"ok":true}', sizeBytes: 11, durationMs: 5 },
          {},
        ),
      });
    });

    const xml = renderJUnit([withAuth]);
    const ctrf = JSON.stringify(renderCtrf([withAuth]));
    assert.ok(!xml.includes('super-secret-token'), 'token leaked into JUnit');
    assert.ok(!ctrf.includes('super-secret-token'), 'token leaked into CTRF');
  });
});

describe('ctrf json', () => {
  it('summarises across bundles and keeps wowlidator specifics under extra', () => {
    const report = renderCtrf([passing, failing]);
    assert.equal(report.results.tool.name, 'wowlidator');
    assert.equal(report.results.summary.tests, 4);
    assert.equal(report.results.summary.failed, 1);
    assert.equal(report.results.summary.passed, 3);

    const runs = report.results.extra['runs'] as { name: string; owner: string | null }[];
    assert.equal(runs.length, 2);
    assert.equal(runs[1]?.owner, 'backend');
  });

  it('names the suite by run and side', () => {
    const report = renderCtrf([failing]);
    const backend = report.results.tests.find((t) => t.status === 'failed');
    assert.equal(backend?.suite, 'probation filter / backend');
    assert.match(backend?.trace ?? '', /detail line/);
  });
});

describe('suite index', () => {
  const entries = [
    { bundle: passing, reportPath: '/reports/group/02-happy.html' },
    { bundle: failing, reportPath: '/reports/group/01-probation.html' },
  ];

  it('puts failures first — the only ordering that helps', () => {
    const ranked = rankEntries(entries);
    assert.equal(ranked[0]?.bundle.name, 'probation filter');
  });

  it('links relatively, so the folder survives being moved or zipped', () => {
    const html = renderSuiteIndex(entries, { indexPath: '/reports/group/index.html' });
    assert.match(html, /href="01-probation\.html"/);
    assert.ok(!html.includes('/reports/group/01-probation.html'), 'absolute path in a link');
  });

  it('rolls up the counts and explains each case in one line', () => {
    const html = renderSuiteIndex(entries, { indexPath: '/reports/group/index.html' });
    assert.match(html, /1\/2<\/div><div class="k">cases passed/);
    assert.match(html, /the endpoint did not answer as expected/);
  });

  it('escapes case names', () => {
    const evil = bundleOf('<img src=x onerror=alert(1)>', (b) => {
      b.addStep({ action: 'goto', selector: null, resolvedSelector: null, resolution: null, status: 'passed', ...base });
    });
    const html = renderSuiteIndex([{ bundle: evil, reportPath: '/r/x.html' }], {
      indexPath: '/r/index.html',
    });
    assert.ok(!/<img src=x/.test(html));
    assert.match(html, /&lt;img/);
  });

  it('renders an empty suite without pretending it passed', () => {
    const html = renderSuiteIndex([], { indexPath: '/r/index.html' });
    assert.match(html, /No cases were run/);
  });

  // A case that never produced a verdict has no bundle and no report, and it is
  // still one of the cases that was listed. Leaving it out is the silent
  // truncation this codebase refuses everywhere else.
  it('lists a case that never ran, and counts it in the denominator', () => {
    const html = renderSuiteIndex(entries, {
      indexPath: '/reports/group/index.html',
      blocked: [{ name: 'export produces a CSV', reason: 'browser has been closed' }],
    });

    assert.match(html, /export produces a CSV/);
    assert.match(html, /browser has been closed/);
    // 1 of 3, not 1 of 2: the two that ran are not the whole suite.
    assert.match(html, /1\/3<\/div><div class="k">cases passed/);
    assert.match(html, /3 cases/);
    assert.match(html, /<div class="k">never ran<\/div>/);
  });

  it('does not call a blocked case a failure, or give it a link', () => {
    const html = renderSuiteIndex([], {
      indexPath: '/r/index.html',
      blocked: [{ name: 'claim 5', reason: 'CDP connection refused' }],
    });

    // Blocked is its own verdict: nothing was proved about the application, so
    // scoring it red would file the harness's gap as a product defect.
    assert.match(html, /<span class="pill blocked">blocked<\/span>/);
    assert.equal(/<a class="case"/.test(html), false, 'there is no report to link to');
    assert.match(html, /proves nothing either way/);
  });

  it('escapes a blocked case name and its reason', () => {
    const html = renderSuiteIndex([], {
      indexPath: '/r/index.html',
      blocked: [{ name: '<img src=x onerror=alert(1)>', reason: '<script>alert(2)</script>' }],
    });
    assert.ok(!/<img src=x/.test(html));
    assert.ok(!/<script>alert\(2\)/.test(html));
    assert.match(html, /&lt;img/);
  });
});
