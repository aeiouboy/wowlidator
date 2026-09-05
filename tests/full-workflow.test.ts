/**
 * v2 verification: autonomous generation, multi-page agentic navigation, and
 * the HTML report.
 *
 * Same tiering as smoke.test.ts — everything that can run offline does, and
 * the browser tier is skipped with a printed reason when no CDP endpoint
 * answers. Model backends are stubbed by default; the contract tests pin the
 * AI SDK request/response shapes with MockLanguageModelV4.
 *
 *   npm test
 *   npx tsx --test --test-name-pattern "navigates two interstitials" tests/full-workflow.test.ts
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import { z } from 'zod';

import { jsonModel, scriptedModel } from './helpers.js';
import { MockLanguageModelV4 } from 'ai/test';

import { ProofBundleBuilder, type AgentRecord, type Defect } from '../src/engine/proof-bundle.js';
import {
  AGENT_HARNESS_STOPS,
  AgentBudgetError,
  AgentEvidenceError,
  agentLegComparison,
  agentLegFailure,
  classifyStepFailure,
  redactAgentRecord,
  runFlow,
  withPage,
  type Flow,
} from '../src/engine/runner.js';
import {
  LlmGeneratorModel,
  TestGenerator,
  inventedUrlReason,
  vacuousFormAssertion,
  type GenerateRequest,
  type GenerationResult,
  type GeneratorModel,
} from '../src/generator/test-generator.js';
import {
  LlmAgentModel,
  WorkflowAgent,
  type AgentDecision,
  type AgentModel,
  type AgentObservation,
} from '../src/orchestrator/workflow-agent.js';
import {
  DEFAULT_REPORT_DIR,
  defaultReportFilename,
  renderReport,
  reportGroupForUrl,
  resolveReportPath,
  slugify,
  writeHtmlReport,
} from '../src/reporter/html-reporter.js';
import { AGY_CLI_PLACEHOLDER_KEY, CLAUDE_CLI_PLACEHOLDER_KEY, CODEX_CLI_PLACEHOLDER_KEY, ConfigError, DEFAULT_ROLE_MODELS, loadConfig, DEFAULT_PROVIDER_MODELS, LOCAL_LLM_PLACEHOLDER_KEY } from '../src/config.js';
import { hasAssertion, hasStorableOrigin, type FlowStep } from '../src/engine/runner.js';
import {
  canonicalSelector,
  interactiveControls,
  meaningfulCoverage,
  parseRoleSelector,
} from '../src/coverage/ax-coverage.js';
import { analyseTrend, failureSignatures, type HistoryEntry } from '../src/history/run-history.js';
import { compareSnapshot, isVisualFailure } from '../src/visual/baseline.js';
import { PNG } from 'pngjs';
import {
  LlmFactory,
  MissingApiKeyError,
  StructuredOutputUnavailableError,
  generateStructured,
  promptSchemaInstruction,
  resetStructuredBreaker,
} from '../src/providers/llm-factory.js';

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';

/** A three-page workflow: landing → consent interstitial → details. */
const PAGES: Record<string, string> = {
  '/': `<h1>Benefits portal</h1>
    <button id="start" type="button">Start application</button>
    <script>document.getElementById('start').onclick=()=>location.href='/consent'</script>`,
  '/consent': `<h1>Consent required</h1>
    <p>Review the terms before continuing.</p>
    <button id="agree" type="button">I agree</button>
    <script>document.getElementById('agree').onclick=()=>location.href='/details'</script>`,
  '/details': `<h1>Application details</h1>
    <input id="applicant" aria-label="Applicant name" placeholder="Applicant name">
    <p id="stage">Stage: details</p>`,
  // A form the agent must fill the way a human does — a checkbox, a native
  // select, and a per-keystroke field. Each control reflects its state into a
  // visible text node so the test reads it back with a plain locator.
  '/form': `<h1>Benefit enrolment</h1>
    <label><input type="checkbox" id="paperless"> Go paperless</label>
    <span id="cbstate">paperless:off</span>
    <label for="plan">Plan</label>
    <select id="plan" aria-label="Plan">
      <option value="">Choose…</option>
      <option value="std">Standard</option>
      <option value="prm">Premium cover</option>
    </select>
    <span id="selstate">plan:none</span>
    <input id="dependant" aria-label="Dependant" placeholder="Dependant">
    <span id="typed">keystrokes: 0</span>
    <script>
      document.getElementById('paperless').addEventListener('change', function (e) {
        document.getElementById('cbstate').textContent = 'paperless:' + (e.target.checked ? 'on' : 'off');
      });
      document.getElementById('plan').addEventListener('change', function (e) {
        document.getElementById('selstate').textContent = 'plan:' + e.target.value;
      });
      var n = 0;
      document.getElementById('dependant').addEventListener('keydown', function () {
        document.getElementById('typed').textContent = 'keystrokes: ' + (++n);
      });
    </script>`,
};

function page(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>wowlidator v2 fixture</title></head><body>${body}</body></html>`;
}

function startFixture(): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const body = PAGES[path];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page(body ?? '<h1>Not found</h1>'));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

async function stopFixture(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function cdpAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Deterministic navigation policy standing in for the model. */
class StubAgentModel implements AgentModel {
  readonly id = 'stub-agent';
  readonly seen: AgentObservation[] = [];

  async decide(observation: AgentObservation): Promise<AgentDecision> {
    this.seen.push(observation);
    const base = { selector: '', value: '', url: '' };

    if (observation.axTree.includes('Application details')) {
      return { ...base, action: 'finish', reasoning: 'the details heading is on screen' };
    }
    if (observation.axTree.includes('I agree')) {
      return {
        ...base,
        action: 'click',
        selector: 'role=button[name="I agree"]',
        reasoning: 'consent interstitial blocks the way',
        inputTokens: 300,
        outputTokens: 20,
      };
    }
    if (observation.axTree.includes('Start application')) {
      return {
        ...base,
        action: 'click',
        selector: 'role=button[name="Start application"]',
        reasoning: 'begin the application from the landing page',
        inputTokens: 280,
        outputTokens: 18,
      };
    }
    return { ...base, action: 'fail', reasoning: 'nothing recognisable on this page' };
  }
}

// --- Offline: visual regression --------------------------------------------

/** Solid-colour PNG, with one optional differently-coloured block. */
function png(w: number, h: number, rgb: [number, number, number], blot = 0): Buffer {
  const image = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (w * y + x) << 2;
      const inBlot = x < blot && y < blot;
      image.data[i] = inBlot ? 255 - rgb[0] : rgb[0];
      image.data[i + 1] = inBlot ? 255 - rgb[1] : rgb[1];
      image.data[i + 2] = inBlot ? 255 - rgb[2] : rgb[2];
      image.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(image);
}

describe('visual regression', () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-visual-'));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a baseline on first run and says nothing was verified', async () => {
    const path = join(dir, 'first.png');
    const result = await compareSnapshot(png(40, 40, [10, 120, 200]), path, 'first');
    assert.equal(result.outcome, 'created');
    assert.equal(isVisualFailure(result), false, 'a first run must not fail the build');
    assert.match(result.message, /nothing was verified/);
    assert.ok(await readFile(path));
  });

  it('matches an identical render', async () => {
    const path = join(dir, 'same.png');
    const shot = png(40, 40, [10, 120, 200]);
    await compareSnapshot(shot, path, 'same');
    const result = await compareSnapshot(shot, path, 'same');
    assert.equal(result.outcome, 'matched');
    assert.equal(result.changedPixels, 0);
  });

  it('flags drift and attaches a diff image', async () => {
    const path = join(dir, 'drift.png');
    await compareSnapshot(png(40, 40, [10, 120, 200]), path, 'drift');
    // A 20x20 inverted block over a 40x40 image = 25% of pixels.
    const result = await compareSnapshot(png(40, 40, [10, 120, 200], 20), path, 'drift');

    assert.equal(result.outcome, 'changed');
    assert.equal(isVisualFailure(result), true);
    assert.equal(result.changedPixels, 400);
    assert.ok((result.diffRatio ?? 0) > 0.2);
    assert.ok(result.diffImage, 'a diff image is the whole point of the failure');
    assert.ok(result.actualImage);
  });

  it('reports a viewport change as size-mismatch rather than noise', async () => {
    const path = join(dir, 'resize.png');
    await compareSnapshot(png(40, 40, [0, 0, 0]), path, 'resize');
    const result = await compareSnapshot(png(60, 40, [0, 0, 0]), path, 'resize');
    assert.equal(result.outcome, 'size-mismatch');
    assert.match(result.message, /40×40.*60×40/);
  });

  it('rewrites the baseline when asked', async () => {
    const path = join(dir, 'update.png');
    await compareSnapshot(png(40, 40, [0, 0, 0]), path, 'update');
    const result = await compareSnapshot(png(40, 40, [255, 255, 255]), path, 'update', {
      updateBaseline: true,
    });
    assert.equal(result.outcome, 'created');
    // The new baseline must now be authoritative.
    const after = await compareSnapshot(png(40, 40, [255, 255, 255]), path, 'update');
    assert.equal(after.outcome, 'matched');
  });
});

// --- Offline: history + trend ----------------------------------------------

describe('run history', () => {
  const base = {
    runId: 'r',
    name: 'flow',
    finishedAt: '2026-07-29T00:00:00.000Z',
    durationMs: 100,
    passed: 1,
    failed: 0,
    jitHeals: 0,
    defects: 0,
    failedSteps: [] as string[],
  };
  const entry = (status: 'passed' | 'failed' | 'error' | 'dead-end', i: number, failedSteps: string[] = []): HistoryEntry => ({
    ...base,
    runId: `r${i}`,
    status,
    failedSteps,
    finishedAt: `2026-07-29T00:0${i}:00.000Z`,
  });

  function bundle(status: 'passed' | 'failed', failedSteps: string[] = []) {
    const b = new ProofBundleBuilder({ name: 'flow' });
    const common = { startedAt: base.finishedAt, durationMs: 5, url: 'https://x.test' };
    b.addStep({
      action: 'click',
      selector: failedSteps[0]?.split(':')[1] ?? '#ok',
      resolvedSelector: null,
      resolution: null,
      status: status === 'failed' ? 'failed' : 'passed',
      ...common,
    });
    return b.finish();
  }

  it('says nothing on a first run rather than guessing', () => {
    const t = analyseTrend(bundle('passed'), []);
    assert.equal(t.verdict, 'first-run');
    assert.equal(t.sampleSize, 0);
  });

  it('never claims "the previous run passed" over a prior that errored — the PB-02-01 shape', () => {
    // The exact bundle shape that produced the fabrication: current run
    // dead-end (recorded as failed here), single prior with status `error`.
    // The old walk only recognised the literal status 'failed', stopped at
    // the error entry, and declared newly-broken with a pass nobody observed.
    const t = analyseTrend(bundle('failed', ['fill:role=textbox >> nth=1']), [
      entry('error', 1, ['fill:role=textbox >> nth=1']),
    ]);
    assert.equal(t.verdict, 'still-broken');
    assert.equal(t.consecutiveFailures, 1);
    assert.doesNotMatch(t.message, /previous run passed/);

    // And an error → dead-end history is two ways of failing, not a flip.
    const steady = analyseTrend(bundle('failed'), [
      entry('error', 1),
      entry('dead-end', 2),
      entry('error', 3),
    ]);
    assert.notEqual(steady.verdict, 'flaky');
    assert.equal(steady.flips, 0);
  });

  it('distinguishes newly broken from long broken', () => {
    const fresh = analyseTrend(bundle('failed', ['click:#x']), [entry('passed', 1), entry('passed', 2)]);
    assert.equal(fresh.verdict, 'newly-broken');
    assert.equal(fresh.consecutiveFailures, 0);

    const stale = analyseTrend(bundle('failed', ['click:#x']), [
      entry('failed', 1, ['click:#x']),
      entry('failed', 2, ['click:#x']),
    ]);
    assert.equal(stale.verdict, 'still-broken');
    assert.equal(stale.consecutiveFailures, 2);
    assert.equal(stale.brokenSince, '2026-07-29T00:01:00.000Z');
    assert.deepEqual(stale.newFailures, [], 'the same failure is not a new one');
  });

  it('reports a fix', () => {
    const t = analyseTrend(bundle('passed'), [entry('failed', 1), entry('failed', 2)]);
    assert.equal(t.verdict, 'newly-fixed');
    assert.equal(t.consecutiveFailures, 2);
  });

  it('calls an alternating suite flaky even when it just passed', () => {
    // A green run inside an unstable history is not trustworthy, and saying
    // "stable" would hide exactly the thing worth knowing.
    const t = analyseTrend(bundle('passed'), [
      entry('passed', 1),
      entry('failed', 2),
      entry('passed', 3),
      entry('failed', 4),
    ]);
    assert.equal(t.verdict, 'flaky');
    assert.ok(t.flips >= 2);
  });

  it('signs failures by action and selector', () => {
    assert.deepEqual(failureSignatures(bundle('failed', ['click:#gone'])), ['click:#gone']);
  });
});

// --- Offline: assertion discipline + coverage ------------------------------

describe('assertion discipline', () => {
  it('recognises a flow that proves nothing', () => {
    const noop: FlowStep[] = [
      { action: 'goto', url: '/' },
      { action: 'click', selector: 'role=button[name="Next"]' },
    ];
    assert.equal(hasAssertion(noop), false, 'click-only flows assert nothing');

    const real: FlowStep[] = [...noop, { action: 'expectUrl', value: '/page/2' }];
    assert.equal(hasAssertion(real), true);
  });

  it('counts every expect* action as an assertion', () => {
    const cases: FlowStep[][] = [
      [{ action: 'expectVisible', selector: 'x' }],
      [{ action: 'expectHidden', selector: 'x' }],
      [{ action: 'expectEnabled', selector: 'x' }],
      [{ action: 'expectDisabled', selector: 'x' }],
      [{ action: 'expectCount', selector: 'x', count: 3 }],
      [{ action: 'expectValue', selector: 'x', value: 'v' }],
      [{ action: 'expectAttribute', selector: 'x', name: 'a', value: 'v' }],
    ];
    for (const steps of cases) {
      assert.equal(hasAssertion(steps), true, `${steps[0]?.action} should count`);
    }
  });

  it('does not count state seeding as an assertion', () => {
    assert.equal(
      hasAssertion([
        { action: 'setLocalStorage', key: 'auth', value: '{}' },
        { action: 'clearStorage' },
      ]),
      false,
    );
  });
});

describe('which pages have storage at all', () => {
  it('is only http and https — everything else has an opaque origin', () => {
    assert.equal(hasStorableOrigin('http://localhost:3000/th/admin/hire'), true);
    assert.equal(hasStorableOrigin('https://example.test/'), true);
    // Where every page starts, and where a flow sits until its first goto.
    assert.equal(hasStorableOrigin('about:blank'), false);
    assert.equal(hasStorableOrigin('file:///tmp/page.html'), false);
    assert.equal(hasStorableOrigin('data:text/html,<h1>hi</h1>'), false);
    assert.equal(hasStorableOrigin('chrome://newtab/'), false);
    assert.equal(hasStorableOrigin(''), false, 'an unparseable url is not an origin');
  });
});

describe('meaningfulCoverage', () => {
  const step = (url: string, resolved: string | null) =>
    ({ resolvedSelector: resolved, url }) as { resolvedSelector: string | null; url: string | null };

  it('is meaningful for a single-page run — the designed use', () => {
    const bundle = {
      coverage: { total: 12 },
      steps: [step('http://app/page', 'role=button[name="Next"]'), step('http://app/page?tab=2', '#x')],
    };
    assert.equal(meaningfulCoverage(bundle), true, 'query strings do not make a second page');
  });

  it('is meaningless for a multi-page journey — the inventory is the final page only', () => {
    // "1/72 (1%)" on a login → navigate → detail journey is not a low score,
    // it is a category error: the denominator is one page's controls, the
    // numerator drew selectors from every page the flow crossed.
    const bundle = {
      coverage: { total: 72 },
      steps: [
        step('http://app/login', 'role=textbox[name="Email"]'),
        step('http://app/workflows/probation', 'role=link[name="PB-001"]'),
      ],
    };
    assert.equal(meaningfulCoverage(bundle), false);
  });

  it('is meaningless with no coverage, or an empty inventory', () => {
    assert.equal(meaningfulCoverage({ steps: [] }), false);
    assert.equal(meaningfulCoverage({ coverage: { total: 0 }, steps: [] }), false);
  });
});

describe('ax coverage', () => {
  // `url` is required on AxNode since links started carrying their href; none
  // of these controls is a link, so it is empty everywhere.
  const tree = [
    { role: 'heading', name: 'Benefit Plan Catalog', value: '', description: '', disabled: false, checked: false, url: '' },
    { role: 'button', name: 'Next', value: '', description: '', disabled: false, checked: false, url: '' },
    { role: 'button', name: 'Previous', value: '', description: '', disabled: true, checked: false, url: '' },
    { role: 'button', name: 'Clear filters', value: '', description: '', disabled: false, checked: false, url: '' },
    { role: 'searchbox', name: 'Search benefit name', value: '', description: '', disabled: true, checked: false, url: '' },
    // A duplicate role+name pair is indistinguishable to a selector.
    { role: 'button', name: 'Next', value: '', description: '', disabled: false, checked: false, url: '' },
  ];

  it('counts only operable controls, deduplicated', () => {
    const controls = interactiveControls(tree);
    // heading is not interactive; the duplicate Next collapses.
    assert.deepEqual(
      controls.map((c) => c.selector),
      [
        'role=button[name="Next"]',
        'role=button[name="Previous"]',
        'role=button[name="Clear filters"]',
        'role=searchbox[name="Search benefit name"]',
      ],
    );
    assert.equal(controls.find((c) => c.name === 'Previous')?.disabled, true);
  });

  it('round-trips role selectors', () => {
    assert.deepEqual(parseRoleSelector('role=button[name="Next"]'), {
      role: 'button',
      name: 'Next',
    });
    assert.deepEqual(parseRoleSelector('role=table'), { role: 'table', name: '' });
    assert.equal(canonicalSelector('button', 'Next'), 'role=button[name="Next"]');
  });

  it('refuses to attribute a CSS selector to a control', () => {
    // Coverage must understate rather than overstate: a CSS selector carries
    // no role or name, so it cannot be credited against a tree node.
    assert.equal(parseRoleSelector('.pagination__next'), null);
    assert.equal(parseRoleSelector('#plan-catalog-title'), null);
    assert.equal(parseRoleSelector('text=Next'), null);
  });
});

// --- Offline: report destination resolution --------------------------------

describe('report destinations', () => {
  const ctx = {
    runId: 'abc-123',
    name: 'Benefit Plan Catalog · browse',
    status: 'passed',
    now: new Date('2026-07-29T04:33:08.123Z'),
  };

  it('defaults to the report directory, not the current file', () => {
    const path = resolveReportPath({}, ctx);
    assert.equal(path, resolve(DEFAULT_REPORT_DIR, 'wowlidator-report.html'));
  });

  it('honours an explicit file path', () => {
    const path = resolveReportPath({ path: '/tmp/out/my-report.html' }, ctx);
    assert.equal(path, '/tmp/out/my-report.html');
  });

  it('treats a trailing separator as a directory', () => {
    const path = resolveReportPath({ path: '/tmp/out/' }, ctx);
    assert.equal(path, '/tmp/out/wowlidator-report.html');
  });

  it('writes into an existing directory rather than overwriting it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wowlidator-dest-'));
    try {
      const path = resolveReportPath({ path: dir }, ctx);
      assert.equal(path, join(dir, 'wowlidator-report.html'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('expands placeholders', () => {
    const path = resolveReportPath(
      { path: '/tmp/r/{date}/{status}-{name}-{runId}.html' },
      ctx,
    );
    assert.equal(path, '/tmp/r/2026-07-29/passed-benefit-plan-catalog-browse-abc-123.html');
  });

  it('uses a filesystem-safe timestamp', () => {
    const path = resolveReportPath({ path: '/tmp/{timestamp}.html' }, ctx);
    assert.equal(path, '/tmp/2026-07-29T04-33-08.html');
    assert.doesNotMatch(path, /:/, 'colons break Windows paths');
  });

  it('numbers multi-case reports and keeps them distinct', () => {
    const a = resolveReportPath(
      { dir: '/tmp/r' },
      { ...ctx, index: 1, kind: 'functional', name: 'Paginate the catalog' },
    );
    const b = resolveReportPath(
      { dir: '/tmp/r' },
      { ...ctx, index: 2, kind: 'edge-case', name: 'Clear an empty filter' },
    );
    assert.equal(a, '/tmp/r/wowlidator-report-01-functional-paginate-the-catalog.html');
    assert.equal(b, '/tmp/r/wowlidator-report-02-edge-case-clear-an-empty-filter.html');
    assert.notEqual(a, b);
  });

  it('resolves a relative template against the report dir', () => {
    const path = resolveReportPath({ path: '{name}.html', dir: '/tmp/r' }, ctx);
    assert.equal(path, '/tmp/r/benefit-plan-catalog-browse.html');
  });

  it('returns null when reporting is disabled', () => {
    assert.equal(resolveReportPath({ enabled: false, path: '/tmp/x.html' }, ctx), null);
  });

  /**
   * Case names come from a model. A generated case called `../../etc/passwd`
   * must not be able to steer a write outside the target directory.
   */
  it('cannot be steered out of the target directory by a hostile name', () => {
    const hostile = { ...ctx, name: '../../../../etc/passwd', kind: '../..' };
    const path = resolveReportPath({ path: '{name}.html', dir: '/tmp/r' }, hostile);
    assert.ok(path);
    assert.ok(path.startsWith('/tmp/r/'), `escaped the target dir: ${path}`);
    assert.doesNotMatch(path, /\.\./);

    const viaDefault = resolveReportPath({ dir: '/tmp/r' }, { ...hostile, index: 1 });
    assert.ok(viaDefault?.startsWith('/tmp/r/'), `escaped via filename: ${viaDefault}`);
  });

  it('groups a run into a folder so one command does not spill loose files', () => {
    const grouped = { ...ctx, group: 'en/admin/benefits/rules', index: 1, kind: 'functional' };
    const path = resolveReportPath({ dir: '/tmp/r' }, grouped);
    // Folder carries the page; the filename drops the now-redundant prefix.
    assert.equal(path, '/tmp/r/en-admin-benefits-rules/01-functional-benefit-plan-catalog-browse.html');
  });

  it('names a single grouped report after the flow, not "report"', () => {
    // Two flows can target the same page; a fixed `report.html` would collide.
    const path = resolveReportPath({ dir: '/tmp/r' }, { ...ctx, group: 'products' });
    assert.equal(path, '/tmp/r/products/benefit-plan-catalog-browse.html');

    const other = resolveReportPath(
      { dir: '/tmp/r' },
      { ...ctx, name: 'checkout smoke', group: 'products' },
    );
    assert.notEqual(path, other);
  });

  it('keeps grouped cases from the same page distinct', () => {
    const base = { ...ctx, group: 'products' };
    const first = resolveReportPath({ dir: '/tmp/r' }, { ...base, index: 1, kind: 'functional' });
    const second = resolveReportPath({ dir: '/tmp/r' }, { ...base, index: 2, kind: 'edge-case' });
    assert.notEqual(first, second);
    assert.ok(first?.includes('/products/'));
    assert.ok(second?.includes('/products/'));
  });

  it('leaves ungrouped runs exactly where they were', () => {
    // Grouping must be additive: a run with no group keeps its old path.
    assert.equal(resolveReportPath({ dir: '/tmp/r' }, ctx), '/tmp/r/wowlidator-report.html');
    assert.equal(
      resolveReportPath({ dir: '/tmp/r' }, { ...ctx, index: 3, kind: 'usability' }),
      '/tmp/r/wowlidator-report-03-usability-benefit-plan-catalog-browse.html',
    );
  });

  it('still honours an explicit file path, group or not', () => {
    // Naming a file is an instruction, not a suggestion — do not nest it.
    const path = resolveReportPath({ path: '/tmp/out/my-report.html' }, { ...ctx, group: 'products' });
    assert.equal(path, '/tmp/out/my-report.html');
  });

  it('cannot be steered out of the reports directory by a hostile group', () => {
    const hostile = { ...ctx, group: '../../../../etc', index: 1 };
    const path = resolveReportPath({ dir: '/tmp/r' }, hostile);
    assert.ok(path?.startsWith('/tmp/r/'), `escaped the target dir: ${path}`);
    assert.doesNotMatch(path ?? '', /\.\./);
  });

  it('names a group folder after the page under test', () => {
    assert.equal(reportGroupForUrl('http://localhost:3000/en/admin/benefits/rules'), 'en-admin-benefits-rules');
    assert.equal(reportGroupForUrl('https://app.example.com/products?page=2'), 'products');
    // No path to speak of, so the host is the only thing that distinguishes it.
    assert.equal(reportGroupForUrl('http://localhost:3000/'), 'localhost-3000');
    assert.equal(reportGroupForUrl('not a url'), 'not-a-url');
  });

  it('slugifies unsafe and non-latin text to something usable', () => {
    assert.equal(slugify('Benefit Plan Catalog'), 'benefit-plan-catalog');
    assert.equal(slugify('../../etc/passwd'), 'etc-passwd');
    assert.equal(slugify('ไทย'), 'report', 'non-latin collapses to a safe fallback');
    assert.equal(slugify(''), 'report');
    assert.ok(slugify('x'.repeat(200)).length <= 48);
  });

  it('names a single-report run without index noise', () => {
    assert.equal(defaultReportFilename(ctx), 'wowlidator-report.html');
  });
});

// --- Offline: config + provider routing ------------------------------------

describe('asking a schema-in-prompt provider for an instance, not the schema', () => {
  // Providers with no structured-output channel are told the schema in prose.
  // How that is worded decides whether GLM 4.7 answers with data or replies
  // with the schema itself, answers tucked into `const` fields — which is
  // valid JSON, satisfies `json_object` mode, and fails zod on every field.
  // Measured on glm-4.7-flash against the generator's nested schema: 3/8 with
  // the old wording, 8/8 with this one.
  const nested = z.object({
    name: z.string(),
    steps: z.array(z.object({ action: z.string(), selector: z.string() })),
  });

  it('says the reply is data described by the schema, never the schema itself', () => {
    const text = promptSchemaInstruction(nested);
    assert.match(text, /never the schema itself/i);
    assert.match(text, /DATA/);
  });

  it('names the keywords a schema echo would contain, so the failure is ruled out', () => {
    // The distinctive shape of the wrong answer. Listing the keywords is what
    // turns "please do the right thing" into an instruction with a check in it.
    const text = promptSchemaInstruction(nested);
    for (const keyword of ['$schema', 'properties', 'items', 'required', 'const']) {
      assert.ok(text.includes(`"${keyword}"`), `the instruction does not rule out ${keyword}`);
    }
  });

  it('drops $schema from the embedded schema, which invites the echo', () => {
    const text = promptSchemaInstruction(nested);
    const embedded = text.slice(text.indexOf('{'));
    const parsed = JSON.parse(embedded) as Record<string, unknown>;
    assert.equal('$schema' in parsed, false, '$schema reads as a document to reproduce');
    // Still a usable schema — the point is to drop the invitation, not the
    // information the model actually needs.
    assert.ok('properties' in parsed);
    assert.deepEqual(Object.keys(parsed['properties'] as object), ['name', 'steps']);
  });

  it('still carries the nested shape the model has to produce', () => {
    const text = promptSchemaInstruction(nested);
    assert.match(text, /"action"/);
    assert.match(text, /"selector"/);
  });
});

describe('form-case generation honesty', () => {
  const goodCase = {
    name: 'malformed email shows validation',
    kind: 'edge-case' as const,
    rationale: 'negative path',
    steps: [
      { action: 'goto', url: '/login' },
      { action: 'fill', selector: 'role=textbox[name="Email" i]', value: 'not-an-email' },
      { action: 'click', selector: 'role=button[name="Sign in" i]' },
      { action: 'expectVisible', selector: 'text=Enter a valid email' },
    ] as FlowStep[],
  };
  const vacuousCase = {
    ...goodCase,
    name: 'vacuous form case',
    steps: [
      { action: 'goto', url: '/login' },
      { action: 'fill', selector: 'role=textbox[name="Email" i]', value: 'not-an-email' },
      { action: 'click', selector: 'role=button[name="Sign in" i]' },
      { action: 'expectValue', selector: 'role=textbox[name="Email" i]', value: 'not-an-email' },
    ] as FlowStep[],
  };

  it('refuses a generated expectUrl the tree does not vouch for', () => {
    const tree = 'link "OT Request" url="http://localhost:3000/en/overtime"';
    const guessed: FlowStep[] = [
      { action: 'click', selector: 'role=link[name="OT Request" i]' },
      { action: 'expectUrl', value: 'time-attendance' },
    ];
    const grounded: FlowStep[] = [
      { action: 'click', selector: 'role=link[name="OT Request" i]' },
      { action: 'expectUrl', value: 'overtime' },
    ];
    assert.match(inventedUrlReason(guessed, tree) ?? '', /derived from a label/);
    assert.equal(inventedUrlReason(grounded, tree), null);
  });

  it('names a form case whose assertions cannot fail', () => {
    // The live shape: fill, submit, then assert your own typed value — which
    // holds whether or not validation exists at all.
    assert.match(vacuousFormAssertion(vacuousCase.steps) ?? '', /cannot fail|asserts only its own typed value/);
    assert.equal(vacuousFormAssertion(goodCase.steps), null, 'a real validation assertion is fine');
    // Cases that never fill, or never submit, are not form cases.
    assert.equal(vacuousFormAssertion(goodCase.steps.filter((s) => s.action !== 'fill')), null);
    assert.equal(vacuousFormAssertion(vacuousCase.steps.filter((s) => s.action !== 'click')), null);
  });

});

describe('a response cut at the output budget', () => {
  // The live failure, 2026-08-19: a thinking model spent the budget on hidden
  // reasoning, the JSON arrived cut off, and — at temperature 0 — the re-ask
  // repeated the identical request and was cut identically, three times, and
  // then the circuit breaker put a whole catalog run down. A length cut is
  // deterministic; only a bigger budget can change it.
  it('is re-asked with a bigger budget, not the same one', async () => {
    resetStructuredBreaker();
    const budgets: number[] = [];
    const model = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'thinker',
      doGenerate: async (options) => {
        budgets.push(options.maxOutputTokens ?? -1);
        const cut = budgets.length === 1;
        return {
          content: [{ type: 'text', text: cut ? '{"ok": "yes' : '{"ok": "yes"}' }],
          finishReason: { unified: cut ? 'length' : 'stop', raw: cut ? 'length' : 'stop' },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 5, text: 5, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    const result = await generateStructured({
      model,
      modelLabel: 'mock:thinker',
      schema: z.object({ ok: z.string() }),
      system: 's',
      prompt: 'p',
      maxOutputTokens: 1024,
      maxRetries: 0,
    });
    assert.equal(result.object.ok, 'yes');
    assert.deepEqual(budgets, [1024, 2048], 'the second ask doubles the budget');
    resetStructuredBreaker();
  });

  it('never grows the budget for a failure that was not a cut', async () => {
    resetStructuredBreaker();
    const budgets: number[] = [];
    const model = scriptedModel('mock:prose', ['not json at all', { ok: 'yes' }]);
    const original = model.doGenerate;
    (model as unknown as { doGenerate: typeof original }).doGenerate = async (options) => {
      budgets.push(options.maxOutputTokens ?? -1);
      return original(options);
    };
    const result = await generateStructured({
      model,
      modelLabel: 'mock:prose',
      schema: z.object({ ok: z.string() }),
      system: 's',
      prompt: 'p',
      maxOutputTokens: 1024,
      maxRetries: 0,
    });
    assert.equal(result.object.ok, 'yes');
    assert.deepEqual(budgets, [1024, 1024], 'a prose reply is re-asked at the same budget');
    resetStructuredBreaker();
  });
});

describe('structured-output circuit breaker', () => {
  it('declares a model broken after two exhausted cycles, and stops paying it', async () => {
    resetStructuredBreaker();
    let asks = 0;
    const model = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'never-json',
      doGenerate: async () => {
        asks += 1;
        return {
          content: [{ type: 'text', text: 'I cannot do JSON, sorry!' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 5, text: 5, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    const request = {
      model,
      modelLabel: 'mock:never-json',
      schema: z.object({ ok: z.string() }),
      system: 's',
      prompt: 'p',
      maxRetries: 0,
    };

    // Two full cycles: each exhausts the re-ask budget and is a typed
    // SYSTEM failure, never a generic error.
    for (let cycle = 0; cycle < 2; cycle++) {
      await assert.rejects(
        () => generateStructured(request),
        (error: unknown) =>
          error instanceof StructuredOutputUnavailableError &&
          /failed to produce a valid structured response/.test(error.message),
      );
    }
    const paid = asks;

    // The third call trips the open circuit: immediate, clearly worded, and
    // the model is not asked even once more.
    await assert.rejects(
      () => generateStructured(request),
      (error: unknown) =>
        error instanceof StructuredOutputUnavailableError &&
        /circuit is open/.test(error.message) &&
        /SYSTEM failure/.test(error.message),
    );
    assert.equal(asks, paid, 'an open circuit spends nothing');
    resetStructuredBreaker();
  });

  it('opens per ROLE, not per model — a sibling role on the same model is still asked', async () => {
    // be100, 2026-08-28: generator and agent both on claude-cli:sonnet; two
    // bad authoring rows opened the breaker for the LABEL and the agent was
    // refused without a call. The key is task@label now.
    resetStructuredBreaker();
    let asks = 0;
    const neverJson = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'shared',
      doGenerate: async () => {
        asks += 1;
        return {
          content: [{ type: 'text', text: '{"steps":[]}' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 5, text: 5, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    const base = {
      model: neverJson,
      modelLabel: 'mock:shared',
      schema: z.object({ steps: z.array(z.string()).min(1) }),
      system: 's',
      prompt: 'p',
      maxRetries: 0,
    };
    for (let cycle = 0; cycle < 2; cycle++) {
      await assert.rejects(() => generateStructured({ ...base, task: 'generator' }), (e: unknown) =>
        e instanceof StructuredOutputUnavailableError &&
        // The evidence is on the FIRST line, where every consumer reads it.
        /model text began: "\{\\"steps\\":\[\]\}"/.test(e.message.split('\n')[0] ?? '') &&
        /rejected steps: too_small/.test(e.message.split('\n')[0] ?? ''),
      );
    }
    await assert.rejects(() => generateStructured({ ...base, task: 'generator' }), /circuit is open for the generator role/);
    const before = asks;
    // The healer shares the model and is NOT switched off by the generator.
    await assert.rejects(() => generateStructured({ ...base, task: 'healer' }), /failed to produce a valid structured response/);
    assert.ok(asks > before, 'the healer was actually asked');
    resetStructuredBreaker();
  });

  it('is classified as an environment failure by the exit contract', async () => {
    const { classifyError, EXIT } = await import('../src/cli/exit.js');
    assert.equal(
      classifyError(new Error('openrouter:google/gemini-3.6-flash failed to produce a valid structured response: …')),
      EXIT.environment,
    );
    // A provider that refused the call (quota, rate limit) is environment too —
    // worded apart from "could not do JSON", because the fix is different.
    assert.equal(
      classifyError(new Error('groq:openai/gpt-oss-120b could not be asked — the provider refused the call (rate limit, quota, or credential): Rate limit reached')),
      EXIT.environment,
    );
    assert.equal(
      classifyError(new Error('mock structured-output circuit is open: …')),
      EXIT.environment,
    );
  });
});

describe('config & llm-factory', () => {
  it('defaults each role to its intended provider', () => {
    const config = loadConfig({});
    assert.equal(config.roles.healer.provider, 'groq', 'healer wants the fastest tier');
    assert.equal(config.roles.generator.provider, 'google', 'generator wants the biggest context');
    assert.equal(config.roles.agent.provider, DEFAULT_ROLE_MODELS.agent.provider);
    assert.equal(config.roles.generator.modelId, DEFAULT_ROLE_MODELS.generator.modelId);
    // No keys present, so nothing should claim to be resolvable — except the
    // two providers that need none: the local server, and the Claude CLI,
    // which carries the operator's own signed-in session. Each keeps a
    // placeholder so a role pointed at it passes every "has a key" gate,
    // rather than being modelled as a provider whose credential is missing.
    assert.deepEqual(config.apiKeys, {
      local: [LOCAL_LLM_PLACEHOLDER_KEY],
      'claude-cli': [CLAUDE_CLI_PLACEHOLDER_KEY],
      'claude-tty': [CLAUDE_CLI_PLACEHOLDER_KEY],
      'claude-cloud': [CLAUDE_CLI_PLACEHOLDER_KEY],
      'codex-cli': [CODEX_CLI_PLACEHOLDER_KEY],
      'agy-cli': [AGY_CLI_PLACEHOLDER_KEY],
    });
  });

  it('lets any role be re-pointed at any provider', () => {
    const config = loadConfig({
      WOWLIDATOR_GENERATOR_PROVIDER: 'groq',
      WOWLIDATOR_GENERATOR_MODEL: 'some-other-model',
      // Pointed away from the defaults so one role provably lacks a key.
      WOWLIDATOR_AGENT_PROVIDER: 'openrouter',
      GROQ_API_KEY: 'gsk_test',
    });
    assert.equal(config.roles.generator.provider, 'groq');
    assert.equal(config.roles.generator.modelId, 'some-other-model');

    const factory = new LlmFactory(config);
    assert.equal(factory.canResolve('generator'), true);
    // healer also routes to groq by default, so it shares the key.
    assert.equal(factory.canResolve('healer'), true);
    assert.equal(factory.canResolve('agent'), false, 'no OpenRouter key was set');

    const resolved = factory.forRole('generator');
    assert.equal(resolved.id, 'groq:some-other-model');
    // Resolution is memoised — the same object comes back.
    assert.equal(factory.forRole('generator'), resolved);
  });

  it('gives a re-pointed provider its own default model, never another provider\'s', () => {
    // Live: `WOWLIDATOR_GENERATOR_PROVIDER=zai` alone resolved to
    // `zai:gemini-3.6-flash` — the generator role's Google default — and the
    // provider read as broken when only the id was.
    const config = loadConfig({ WOWLIDATOR_GENERATOR_PROVIDER: 'zai', WOWLIDATOR_AGENT_PROVIDER: 'zai' });
    assert.equal(config.roles.generator.provider, 'zai');
    assert.equal(config.roles.generator.modelId, DEFAULT_PROVIDER_MODELS.zai);
    assert.equal(config.roles.agent.modelId, DEFAULT_PROVIDER_MODELS.zai);
    // A role left on its own provider keeps its own, role-specific default.
    assert.equal(config.roles.healer.modelId, DEFAULT_ROLE_MODELS.healer.modelId);
  });

  it('rejects an unknown provider rather than failing later', () => {
    assert.throws(
      () => loadConfig({ WOWLIDATOR_HEALER_PROVIDER: 'not-a-provider' }),
      (error: unknown) => error instanceof ConfigError,
    );
  });

  it('treats an empty env var as unset', () => {
    const config = loadConfig({ GROQ_API_KEY: '   ' });
    assert.equal(config.apiKeys.groq, undefined);
  });

  it('explains how to fix a missing key instead of failing at request time', () => {
    const factory = new LlmFactory(loadConfig({}));
    assert.throws(
      () => factory.forRole('agent'),
      (error: unknown) => {
        assert.ok(error instanceof MissingApiKeyError);
        assert.equal(error.role, 'agent');
        assert.equal(error.provider, DEFAULT_ROLE_MODELS.agent.provider);
        assert.match(error.message, /GROQ_API_KEY/);
        assert.match(error.message, /WOWLIDATOR_AGENT_PROVIDER/);
        return true;
      },
    );
  });
});

// --- Offline: generator model contract -------------------------------------

describe('LlmGeneratorModel', () => {
  it('parses a generated suite and drops unusable steps', async () => {
    const model = jsonModel(
      'mock-generator',
      {
                  cases: [
                    {
                      name: 'Paginate to the last page',
                      kind: 'edge-case',
                      rationale: 'boundary behaviour at the end of the list',
                      steps: [
                        { action: 'goto', selector: '', value: '', url: '/', intent: 'open the list' },
                        { action: 'click', selector: 'role=button[name="Next"]', value: '', url: '', intent: 'advance a page' },
                        // Unusable: expectText with no value. Must be dropped.
                        { action: 'expectText', selector: 'body', value: '', url: '', intent: 'broken step' },
                      ],
                    },
                  ],
                  defects: [
                    {
                      title: 'Search box has no accessible name',
                      detail: 'The searchbox exposes no label, so screen readers announce nothing.',
                      severity: 'high',
                      category: 'accessibility',
                      selector: 'role=searchbox',
                    },
                  ],
                },
      { inputTokens: 1800, outputTokens: 420 },
    );

    const generator = new LlmGeneratorModel({ model, id: 'google:mock-generator' });
    const request: GenerateRequest = {
      url: 'https://example.test/list',
      axTree: 'button "Next"\nsearchbox',
      maxCases: 6,
    };
    const result: GenerationResult = await generator.generate(request);

    assert.equal(result.cases.length, 1);
    const [testCase] = result.cases;
    assert.ok(testCase);
    assert.equal(testCase.kind, 'edge-case');
    // The malformed expectText step is filtered out; the other two survive.
    assert.equal(testCase.steps.length, 2);
    assert.deepEqual(testCase.steps[0], { action: 'goto', url: '/' });
    assert.equal(testCase.steps[1]?.action, 'click');

    assert.equal(result.defects.length, 1);
    assert.equal(result.defects[0]?.severity, 'high');
    assert.equal(result.defects[0]?.category, 'accessibility');
    assert.equal(result.inputTokens, 1800);
    assert.equal(result.outputTokens, 420);

    const call = model.doGenerateCalls[0];
    assert.ok(call);
    assert.equal(call.responseFormat?.type, 'json');
    assert.match(JSON.stringify(call.prompt), /Next/);
  });
});

// --- Offline: agent model contract -----------------------------------------

describe('LlmAgentModel', () => {
  it('returns one structured decision per turn', async () => {
    const model = jsonModel(
      'mock-agent',
      {
                  action: 'click',
                  selector: 'role=button[name="I agree"]',
                  value: '',
                  url: '',
                  reasoning: 'the consent gate must be cleared first',
                },
      { inputTokens: 900, outputTokens: 40 },
    );

    const agentModel = new LlmAgentModel({ model, id: 'openrouter:mock-agent' });
    const decision = await agentModel.decide({
      goal: 'reach the application details page',
      url: 'https://example.test/consent',
      axTree: 'button "I agree"',
      history: ['click role=button[name="Start application"] - ok'],
      stepsRemaining: 6,
    });

    assert.equal(decision.action, 'click');
    // Relaxed on the way out of the agent: the model is quoting names from
    // the AX tree, whose case Playwright's matcher does not honour.
    assert.equal(decision.selector, 'role=button[name="I agree" i]');
    assert.equal(decision.inputTokens, 900);

    // Goal, history, and tree must all reach the model or it cannot reason.
    const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    assert.match(prompt, /GOAL: reach the application details page/);
    assert.match(prompt, /Start application/);
    assert.match(prompt, /I agree/);
  });
});

// --- Offline: HTML reporter ------------------------------------------------

describe('html-reporter', () => {
  function syntheticBundle() {
    const builder = new ProofBundleBuilder({
      name: 'v2 report fixture',
      healerModel: 'claude-haiku-4-5',
      generatedBy: {
        model: 'claude-opus-5',
        generatedAt: '2026-07-29T00:00:00.000Z',
        sourceUrl: 'https://example.test/plans',
        kind: 'edge-case',
        rationale: 'boundary behaviour at the end of the list',
      },
    });
    const base = { startedAt: '2026-07-29T00:00:00.000Z', durationMs: 42, url: 'https://example.test/plans' };

    builder.addStep({
      action: 'click',
      intent: 'Open the plan comparison table',
      selector: '#a',
      resolvedSelector: '#a',
      resolution: 'fast',
      status: 'passed',
      ...base,
    });
    builder.addStep({
      action: 'click',
      selector: '#login',
      resolvedSelector: 'role=button[name="Sign in"]',
      resolution: 'jit',
      status: 'passed',
      ...base,
      heal: {
        from: '#login',
        to: 'role=button[name="Sign in"]',
        strategy: 'role',
        confidence: 0.94,
        reasoning: 'only button with that accessible name',
        model: 'claude-haiku-4-5',
        latencyMs: 810,
        inputTokens: 640,
        outputTokens: 48,
      },
      // 1x1 JPEG, enough to prove the data URI is wired up.
      screenshot: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
    });
    builder.addStep({
      action: 'workflow',
      selector: null,
      resolvedSelector: null,
      resolution: null,
      status: 'passed',
      ...base,
      detail: { goal: 'reach the details page' },
      agent: {
        goal: 'reach the details page',
        model: 'stub-agent',
        success: true,
        summary: 'the details heading is on screen',
        turns: 3,
        maxSteps: 8,
        latencyMs: 1200,
        inputTokens: 580,
        outputTokens: 38,
        actions: [
          { index: 0, action: 'click', selector: 'role=button[name="Start application"]', value: null, url: 'https://example.test/', reasoning: 'begin', ok: true, durationMs: 120 },
          { index: 1, action: 'click', selector: 'role=button[name="I agree"]', value: null, url: 'https://example.test/consent', reasoning: 'consent gate', ok: true, durationMs: 140 },
        ],
      },
    });
    builder.addStep({ action: 'click', selector: '#gone', resolvedSelector: null, resolution: null, status: 'failed', ...base, error: 'locator.click: Timeout 2000ms exceeded.' });

    const injected: Defect = {
      id: 'gen-1',
      source: 'generator',
      severity: 'high',
      category: 'accessibility',
      title: '<script>alert("xss")</script> unlabelled control',
      detail: 'A searchbox exposes no accessible name.',
      selector: 'role=searchbox',
    };
    builder.addDefect(injected);
    return builder.finish();
  }

  it('renders a self-contained document with heal, agent, and defect evidence', () => {
    const html = renderReport(syntheticBundle());

    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<style>/, 'CSS must be inlined');
    // Self-contained: nothing may be fetched at view time.
    assert.doesNotMatch(html, /<script\s+src=/i);
    assert.doesNotMatch(html, /<link\s[^>]*rel=["']stylesheet/i);
    assert.doesNotMatch(html, /https?:\/\/(?!example\.test)/, 'no external hosts');

    // The three things the report exists to surface.
    assert.match(html, /JIT healer repaired this selector/);
    assert.match(html, /role=button\[name=&quot;Sign in&quot;\]/);
    assert.match(html, /Workflow agent took over/);
    assert.match(html, /reach the details page/);
    assert.match(html, /Autonomously generated/);
    assert.match(html, /data:image\/jpeg;base64,/, 'screenshot must be embedded');

    // Summary numbers.
    assert.match(html, /steps passed/);
    assert.match(html, /agent takeovers/);

    // The author's own words from flow.json, surfaced verbatim — not
    // regenerated, and shown once (not duplicated in the generic detail list).
    // They lead the step now: a reader triaging a red run wants "what was this
    // step for" before "which selector expressed it".
    assert.match(html, /<span class="headline">Open the plan comparison table<\/span>/);
    const occurrences = html.split('Open the plan comparison table').length - 1;
    assert.equal(occurrences, 1);
  });

  it('escapes untrusted page and model text', () => {
    const html = renderReport(syntheticBundle());
    assert.doesNotMatch(html, /<script>alert\("xss"\)<\/script>/, 'defect title must be escaped');
    assert.match(html, /&lt;script&gt;alert\(&quot;xss&quot;\)&lt;\/script&gt;/);
  });

  it('writes the report to disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wowlidator-report-'));
    try {
      const target = join(dir, 'wowlidator-report.html');
      const written = await writeHtmlReport(syntheticBundle(), target);
      assert.equal(written, target);
      const onDisk = await readFile(target, 'utf8');
      assert.match(onDisk, /wowlidator report|v2 report fixture/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// --- Browser tier ----------------------------------------------------------

const browserReady = await cdpAvailable(CDP_URL);
const skipBrowser = browserReady
  ? false
  : `no CDP endpoint at ${CDP_URL} — start Chrome with --remote-debugging-port=9222 (npm run chrome)`;

describe('workflow agent (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;

  before(async () => {
    ({ server, origin } = await startFixture());
  });
  after(async () => {
    await stopFixture(server);
  });

  it('navigates two interstitials to reach the goal', async () => {
    const model = new StubAgentModel();
    const agent = new WorkflowAgent({ model, maxSteps: 6 });

    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'reach the application details page');
    });

    assert.equal(result.success, true, result.summary);
    // landing -> consent -> details, then finish. The consent interstitial
    // is the loop's to clear (2026-08-25): a gate on a consent URL with a
    // name-gated accept control costs no model turn, on any turn — and
    // since the journey was under way, the agent stays where the accept
    // lands rather than being returned to the landing page.
    assert.equal(result.turns, 2);
    assert.equal(result.actions.length, 3);
    assert.equal(result.actions[0]?.action, 'click');
    assert.equal(result.actions[1]?.action, 'click');
    assert.match(result.actions[1]?.reasoning ?? '', /consent gate/, 'cleared by the loop, not the model');
    assert.equal(result.actions[2]?.action, 'finish');
    assert.ok(result.actions.every((a) => a.ok));
    assert.equal(model.seen.length, 2, 'the model never saw the consent page');
    assert.equal(result.inputTokens, 280, 'only the landing click was a model turn');

    // History must accumulate, or the model cannot avoid repeating itself:
    // the second turn reads the landing click and the gate the loop cleared.
    assert.equal(model.seen[0]?.history.length, 0);
    assert.equal(model.seen[1]?.history.length, 2);
    assert.match(model.seen[1]?.history[1] ?? '', /cleared a consent gate on turn 2/);
  });

  it('fills a form like a human — check, selectOption by label, and per-keystroke type', async () => {
    const script: AgentDecision[] = [
      { action: 'check', selector: 'role=checkbox[name="Go paperless" i]', value: '', url: '', reasoning: 'opt in' },
      { action: 'selectOption', selector: 'role=combobox[name="Plan" i]', value: 'Premium cover', url: '', reasoning: 'pick the plan' },
      { action: 'type', selector: 'role=textbox[name="Dependant" i]', value: 'Rae', url: '', reasoning: 'name the dependant' },
      { action: 'finish', selector: '', value: '', url: '', reasoning: 'the form is filled' },
    ];
    let turn = 0;
    const model: AgentModel = {
      id: 'form-filler',
      async decide() {
        return script[turn++] ?? { action: 'fail', selector: '', value: '', url: '', reasoning: 'script exhausted' };
      },
    };
    const agent = new WorkflowAgent({ model, maxSteps: 8, actionTimeoutMs: 2_000 });

    const state = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/form`, { waitUntil: 'domcontentloaded' });
      const result = await agent.run(page, 'enrol the applicant — go paperless, choose Premium cover, and add dependant Rae');
      assert.equal(result.success, true, result.summary);
      assert.ok(result.actions.every((a) => a.ok), `every action landed: ${result.summary}`);
      return {
        cb: (await page.locator('#cbstate').textContent())?.trim(),
        sel: (await page.locator('#selstate').textContent())?.trim(),
        keystrokes: Number(((await page.locator('#typed').textContent()) ?? '').split(' ')[1]),
      };
    });

    assert.equal(state.cb, 'paperless:on', 'check ticked the box and fired change');
    assert.equal(state.sel, 'plan:prm', 'selectOption chose by visible label');
    // "Rae" is 3 characters; a capital letter also fires a Shift keydown, so
    // the count is per-character, not exactly the string length — `fill`
    // would have fired none of these.
    assert.ok(state.keystrokes >= 3, `type fired a real keydown per character (saw ${state.keystrokes})`);
  });

  it('refuses to navigate off the starting origin', async () => {
    const model: AgentModel = {
      id: 'off-origin',
      async decide() {
        return {
          action: 'goto',
          selector: '',
          value: '',
          url: 'https://example.com/',
          reasoning: 'wandering off',
        };
      },
    };
    const agent = new WorkflowAgent({ model, maxSteps: 2 });

    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'go somewhere else entirely');
    });

    assert.equal(result.success, false);
    assert.ok(result.actions.length > 0);
    assert.equal(result.actions[0]?.ok, false);
    assert.match(String(result.actions[0]?.error), /refusing to navigate off-origin/);
  });

  it('gives up within its step budget rather than looping', async () => {
    const model: AgentModel = {
      id: 'never-finishes',
      async decide() {
        return {
          action: 'click',
          selector: 'role=button[name="Start application"]',
          value: '',
          url: '',
          reasoning: 'try again',
        };
      },
    };
    // Short action timeout: this test is about the budget, not about waiting.
    const agent = new WorkflowAgent({ model, maxSteps: 3, actionTimeoutMs: 1_000 });

    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'unreachable goal');
    });

    assert.equal(result.success, false);
    assert.equal(result.turns, 3, 'must stop at maxSteps');
    assert.match(result.summary, /gave up after 3 turns/);
  });
});

describe('generation → multi-page run → report (CDP)', { skip: skipBrowser }, () => {
  it('rejects a vacuous form case and re-asks with the reason — the good attempt wins', async () => {
    const { server, origin } = await startFixture();
    try {
      const vacuous = {
        name: 'vacuous form case',
        kind: 'edge-case' as const,
        rationale: 'first try',
        steps: [
          { action: 'goto', url: '/', value: '', selector: '', key: '', intent: 'open' },
          { action: 'fill', selector: 'role=textbox[name="Applicant name" i]', value: 'x', url: '', key: '', intent: 'type' },
          { action: 'click', selector: 'role=button[name="Start application" i]', value: '', url: '', key: '', intent: 'submit' },
          { action: 'expectValue', selector: 'role=textbox[name="Applicant name" i]', value: 'x', url: '', key: '', intent: 'vacuous' },
        ],
      };
      const good = {
        ...vacuous,
        name: 'validation shows',
        rationale: 'second try',
        steps: [
          ...vacuous.steps.slice(0, 3),
          { action: 'expectVisible', selector: 'role=heading[name="Consent required" i]', value: '', url: '', key: '', intent: 'real check' },
        ],
      };
      const requests: GenerateRequest[] = [];
      const model: GeneratorModel = {
        id: 'stub:generator',
        async generate(request) {
          requests.push(request);
          const raw = requests.length === 1 ? vacuous : good;
          return {
            cases: [{
              name: raw.name,
              kind: raw.kind,
              rationale: raw.rationale,
              steps: raw.steps as never,
            }],
            defects: [],
          } as never;
        },
      };

      const suite = await withPage(CDP_URL, async (page) => {
        await page.goto(`${origin}/details`, { waitUntil: 'domcontentloaded' });
        return new TestGenerator({ model }).generate(page);
      });

      assert.equal(requests.length, 2, 'the rejection must earn one informed re-ask');
      assert.match(requests[1]?.feedback?.[0] ?? '', /asserts only its own typed value/);
      assert.equal(suite.cases.length, 1);
      assert.equal(suite.cases[0]?.name, 'validation shows');
      assert.equal(suite.rejected.length, 0, 'the better attempt is the one reported');
    } finally {
      await stopFixture(server);
    }
  });

  it('re-asks when the model returns zero cases — an empty reply is a failed attempt, not a done one', async () => {
    const { server, origin } = await startFixture();
    try {
      const good = {
        name: 'validation shows',
        kind: 'edge-case' as const,
        rationale: 'second try',
        steps: [
          { action: 'goto', url: '/', value: '', selector: '', key: '', intent: 'open' },
          { action: 'fill', selector: 'role=textbox[name="Applicant name" i]', value: 'x', url: '', key: '', intent: 'type' },
          { action: 'click', selector: 'role=button[name="Start application" i]', value: '', url: '', key: '', intent: 'submit' },
          { action: 'expectVisible', selector: 'role=heading[name="Consent required" i]', value: '', url: '', key: '', intent: 'real check' },
        ],
      };
      const requests: GenerateRequest[] = [];
      const model: GeneratorModel = {
        id: 'stub:generator',
        async generate(request) {
          requests.push(request);
          if (requests.length === 1) return { cases: [], defects: [] } as never;
          return {
            cases: [{ name: good.name, kind: good.kind, rationale: good.rationale, steps: good.steps as never }],
            defects: [],
          } as never;
        },
      };

      const suite = await withPage(CDP_URL, async (page) => {
        await page.goto(`${origin}/details`, { waitUntil: 'domcontentloaded' });
        return new TestGenerator({ model }).generate(page);
      });

      assert.equal(requests.length, 2, 'zero cases must earn one informed re-ask');
      assert.match(requests[1]?.feedback?.[0] ?? '', /returned NO cases/);
      assert.equal(suite.cases.length, 1);
      assert.equal(suite.cases[0]?.name, 'validation shows');
    } finally {
      await stopFixture(server);
    }
  });

  let server: Server;
  let origin: string;
  let dir: string;

  before(async () => {
    ({ server, origin } = await startFixture());
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-v2-'));
  });
  after(async () => {
    await stopFixture(server);
    await rm(dir, { recursive: true, force: true });
  });

  it('generates a suite from the live page', async () => {
    const model: GeneratorModel = {
      id: 'stub-generator',
      async generate(request: GenerateRequest): Promise<GenerationResult> {
        // Prove the generator actually read the page it was pointed at.
        assert.match(request.axTree, /Benefits portal/);
        assert.match(request.url, /127\.0\.0\.1/);
        return {
          cases: [
            {
              name: 'Reach application details through the consent gate',
              kind: 'functional',
              rationale: 'the main path a user must complete',
              steps: [
                { action: 'goto', url: '/' },
                { action: 'workflow', goal: 'reach the application details page' },
                {
                  action: 'expectText',
                  selector: 'body',
                  value: 'Stage: details',
                  intent: 'confirm the final stage rendered',
                },
              ],
            },
          ],
          defects: [
            {
              title: 'Consent screen offers no decline path',
              detail: 'The interstitial exposes only "I agree" — a user cannot refuse.',
              severity: 'medium',
              category: 'usability',
              selector: 'role=button[name="I agree"]',
            },
          ],
          inputTokens: 2100,
          outputTokens: 380,
        };
      },
    };

    const suite = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
      return new TestGenerator({ model }).generate(page);
    });

    assert.equal(suite.cases.length, 1);
    assert.equal(suite.cases[0]?.flow.baseUrl, origin, 'baseUrl derived from the scanned page');
    assert.equal(suite.defects.length, 1);
    assert.equal(suite.defects[0]?.id, 'gen-1');
    assert.equal(suite.defects[0]?.source, 'generator');
    assert.equal(suite.model, 'stub-generator');
  });

  it('runs a generated multi-page flow and reports it end to end', async () => {
    const flow: Flow = {
      name: 'Reach application details through the consent gate',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'workflow', goal: 'reach the application details page' },
        { action: 'expectText', selector: 'body', value: 'Stage: details', intent: 'final stage' },
      ],
    };

    const generatorDefects: Defect[] = [
      {
        id: 'gen-1',
        source: 'generator',
        severity: 'medium',
        category: 'usability',
        title: 'Consent screen offers no decline path',
        detail: 'The interstitial exposes only "I agree".',
        selector: 'role=button[name="I agree"]',
      },
    ];

    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'cache.json'),
      screenshots: 'all',
      healer: null,
      agent: new WorkflowAgent({ model: new StubAgentModel(), maxSteps: 6 }),
      defects: generatorDefects,
      generatedBy: {
        model: 'stub-generator',
        generatedAt: new Date().toISOString(),
        sourceUrl: `${origin}/`,
        kind: 'functional',
        rationale: 'the main path a user must complete',
      },
    });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'multi-page run should pass');
    assert.equal(bundle.summary.agentTakeovers, 1);
    assert.equal(bundle.summary.totalSteps, 3);

    const agentStep = bundle.steps.find((step) => step.action === 'workflow');
    assert.ok(agentStep);
    assert.equal(agentStep.agent?.success, true);
    assert.equal(agentStep.agent?.actions.length, 3);
    // The agent's token spend must roll into the run summary. One model
    // turn (the landing click, 280 in); the consent interstitial is cleared
    // by the loop and the finish carries no tokens.
    assert.equal(bundle.summary.inputTokens, 280);

    // The final assertion ran on /details, which only the agent could reach.
    const finalStep = bundle.steps.at(-1);
    assert.equal(finalStep?.status, 'passed');
    assert.match(String(finalStep?.url), /\/details$/);

    // Generator defects survive into the run's report.
    assert.equal(bundle.defects.length, 1);
    assert.equal(bundle.defects[0]?.source, 'generator');
    assert.equal(bundle.generatedBy?.model, 'stub-generator');

    assert.ok(
      bundle.steps.some((step) => step.screenshot !== undefined),
      'screenshots:"all" must attach visual evidence',
    );

    const reportPath = await writeHtmlReport(bundle, join(dir, 'wowlidator-report.html'));
    const html = await readFile(reportPath, 'utf8');
    assert.match(html, /Workflow agent took over/);
    assert.match(html, /reach the application details page/);
    assert.match(html, /Consent screen offers no decline path/);
    assert.match(html, /data:image\/jpeg;base64,/);
    assert.match(html, /Autonomously generated/);
  });

  it('fails the step cleanly when a workflow goal is unreachable', async () => {
    const bundle = await runFlow(
      {
        name: 'unreachable goal',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/details' },
          { action: 'workflow', goal: 'purchase a yacht' },
        ],
      },
      {
        cdpUrl: CDP_URL,
        cachePath: join(dir, 'cache2.json'),
        screenshots: 'off',
        healer: null,
        agent: new WorkflowAgent({
          model: {
            id: 'always-fails',
            async decide() {
              return {
                action: 'fail',
                selector: '',
                value: '',
                url: '',
                reasoning: 'no yacht controls on this page',
              };
            },
          },
          maxSteps: 3,
        }),
      },
    );

    // A workflow that gave up is an `error` in the run taxonomy — the goal
    // went unanswered, which is not the same claim as "the app failed a check".
    assert.equal(bundle.status, 'error');
    const step = bundle.steps.find((s) => s.action === 'workflow');
    assert.equal(step?.status, 'error');
    assert.equal(step?.agent?.success, false);
    // A failed goal must show up as a defect, not just a red step.
    assert.ok(bundle.defects.some((d) => d.severity === 'high' && d.source === 'runtime'));
  });

  it('fails clearly when a workflow step has no agent configured', async () => {
    const bundle = await runFlow(
      {
        name: 'no agent configured',
        baseUrl: origin,
        steps: [
          { action: 'goto', url: '/' },
          { action: 'workflow', goal: 'reach the application details page' },
        ],
      },
      {
        cdpUrl: CDP_URL,
        cachePath: join(dir, 'cache3.json'),
        screenshots: 'off',
        healer: null,
        agent: null,
      },
    );

    assert.equal(bundle.status, 'error');
    assert.match(String(bundle.error), /needs the multi-page agent/);
  });
});

/**
 * `clearStorage` before the first `goto`.
 *
 * A model reliably opens `setup` with it — it reads as ordinary hygiene — and
 * storage is origin-scoped, so on `about:blank` it used to throw
 * `SecurityError: Access is denied for this document` and abort the flow at step
 * 0. Every case authored from one catalog failed that way, each reporting a
 * high-severity frontend defect about a page none of them had visited.
 */
describe('clearing storage before there is an origin (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;
  let dir: string;

  before(async () => {
    ({ server, origin } = await startFixture());
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-storage-'));
  });
  after(async () => {
    await stopFixture(server);
    await rm(dir, { recursive: true, force: true });
  });

  it('has nothing to clear on a page that has not navigated, and says so', async () => {
    const bundle = await runFlow(
      {
        name: 'clearStorage opens the setup',
        baseUrl: origin,
        // The exact shape that failed: hygiene first, navigation second.
        setup: [{ action: 'clearStorage' }, { action: 'goto', url: '/' }],
        steps: [
          { action: 'expectText', selector: 'body', value: 'Benefits portal', intent: 'the page' },
        ],
      },
      { cdpUrl: CDP_URL, cachePath: join(dir, 'cache.json'), screenshots: 'off', healer: null },
    );

    assert.equal(bundle.status, 'passed', bundle.error ?? 'setup must not abort on a blank page');
    // The assertion is the point: it proves the body ran at all.
    assert.equal(bundle.steps.at(-1)?.status, 'passed');
    // Skipped, not silently passed — a reader must be able to tell which it was.
    const cleared = bundle.steps.find((step) => step.action === 'clearStorage');
    assert.match(String(cleared?.detail?.['cleared']), /nothing/);
    assert.equal(bundle.defects.length, 0, 'no defect about a page nobody visited');
  });

  it('really clears storage once there is an origin to clear', async () => {
    // The guard must not turn the action into a no-op where it has work to do.
    const bundle = await runFlow(
      {
        name: 'clearStorage after a goto',
        baseUrl: origin,
        setup: [
          { action: 'goto', url: '/' },
          { action: 'setLocalStorage', key: 'session', value: 'seeded' },
          { action: 'clearStorage' },
        ],
        steps: [{ action: 'expectText', selector: 'body', value: 'Benefits portal' }],
      },
      { cdpUrl: CDP_URL, cachePath: join(dir, 'cache2.json'), screenshots: 'off', healer: null },
    );

    assert.equal(bundle.status, 'passed', bundle.error ?? 'clearing a real origin must work');
    const cleared = bundle.steps.find((step) => step.action === 'clearStorage');
    assert.equal(cleared?.detail?.['cleared'], undefined, 'it did the real thing here');

    const left = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
      return page.evaluate(() => globalThis.localStorage.getItem('session'));
    });
    assert.equal(left, null, 'the seeded key must be gone');
  });
});

// ---------------------------------------------------------------------------
// Three classes of failed workflow leg, by the source of the evidence (task C3).
// Pure over a hand-written record — no browser, no model.
// ---------------------------------------------------------------------------

describe('a failed workflow leg is classed by the source of its evidence', () => {
  const record = (over: Partial<AgentRecord>): AgentRecord => ({
    goal: 'set Employee Group to "Z - Nothing"',
    model: 'stub',
    success: false,
    summary: 'agent stopped',
    actions: [],
    turns: 3,
    maxSteps: 12,
    latencyMs: 900,
    ...over,
  });
  const listboxMiss = {
    index: 0,
    action: 'selectOption',
    selector: 'role=button[name="Employee Group" i]',
    value: 'Z - Nothing',
    url: 'http://x.test/en/form',
    reasoning: 'pick the group',
    ok: false,
    error: 'opened "Employee Group" but no option named "Z - Nothing" appeared',
    durationMs: 40,
    listbox: {
      trigger: 'Employee Group',
      value: 'Z - Nothing',
      shownCount: 9,
      shownHead: ['A - Alpha', 'B - Bravo', 'C - Charlie', 'D - Delta', 'E - Echo', 'F - Foxtrot', 'G - Golf', 'H - Hotel'],
      filtered: false,
      searchedEmpty: null,
    },
  };

  it("the page's own enumeration (cannot-offer) is an AgentEvidenceError that classifies to failed, with expected and actual", () => {
    const error = agentLegFailure(
      record({ endedBy: 'cannot-offer', actions: [listboxMiss], summary: 'agent stopped: the goal\'s Employee Group = "Z - Nothing" is not among the 9 option(s)' }),
    );
    assert.ok(error instanceof AgentEvidenceError);
    assert.equal(error.name, 'AgentEvidenceError');
    assert.equal(error.expected, 'Z - Nothing');
    assert.match(error.actual, /^"Employee Group" offered 9 option\(s\): "A - Alpha", .*"H - Hotel", …$/);
    assert.match(error.message, /^workflow agent failed on the page's own evidence: /);
    assert.equal(classifyStepFailure('workflow', error), 'failed');

    // The same pair the runner writes onto the step's detail, where
    // `expectedActual()` reads it like an assertion's.
    const comparison = agentLegComparison(record({ endedBy: 'cannot-offer', actions: [listboxMiss] }));
    assert.deepEqual(comparison, { expected: 'Z - Nothing', actual: error.actual });
    assert.equal(agentLegComparison(record({ endedBy: 'cannot-offer' })), null, 'no listbox action, no pair');
    assert.equal(
      agentLegComparison(record({ actions: [{ ...listboxMiss, listbox: { ...listboxMiss.listbox, shownCount: 0, shownHead: [] } }] }))?.actual,
      '"Employee Group" offered no options',
    );
  });

  it('every harness stop is an AgentBudgetError that still classifies to error, naming the limit', () => {
    for (const endedBy of AGENT_HARNESS_STOPS) {
      const error = agentLegFailure(record({ endedBy, summary: `agent stopped (${endedBy})` }));
      assert.ok(error instanceof AgentBudgetError, endedBy);
      assert.equal(error.name, 'AgentBudgetError');
      assert.equal(error.endedBy, endedBy);
      assert.match(error.message, /^workflow agent stopped by a harness limit \(/, endedBy);
      assert.match(error.message, /not a fact about the application/, endedBy);
      assert.equal(classifyStepFailure('workflow', error), 'error', endedBy);
    }
    assert.match(agentLegFailure(record({ endedBy: 'budget', maxSteps: 12 })).message, /the 12-turn ceiling/);
    assert.match(agentLegFailure(record({ endedBy: 'budget', maxSteps: null })).message, /the turn ceiling/);
    assert.match(agentLegFailure(record({ endedBy: 'stalled' })).message, /repeated on an unchanged page/);
    assert.match(agentLegFailure(record({ endedBy: 'no-progress' })).message, /nothing advanced/);
  });

  it("the model's own fail, a contradicted finish and a record from an older build stay the untyped error", () => {
    for (const over of [
      { endedBy: 'fail' as const, unreachable: { claim: 'no such group', urlAfter: 'http://x.test/en/form', headingsAfter: ['Employment'] } },
      { endedBy: 'contradicted' as const },
      {},
    ]) {
      const error = agentLegFailure(record({ ...over, summary: 'agent reported the goal is unreachable: no such group' }));
      assert.equal(error.name, 'Error', JSON.stringify(over));
      assert.equal(error.message, 'workflow agent failed: agent reported the goal is unreachable: no such group');
      assert.equal(classifyStepFailure('workflow', error), 'error');
    }
  });

  it('redaction masks the claim and the listbox value, and keeps the typed fields', () => {
    const safe = redactAgentRecord(
      record({
        endedBy: 'fail',
        unreachable: {
          claim: 'typed hunter2 into the password box and it was refused',
          urlAfter: 'http://x.test/en/form?pw=hunter2',
          headingsAfter: ['Sign in'],
        },
        actions: [{ ...listboxMiss, listbox: { ...listboxMiss.listbox, value: 'hunter2' } }],
      }),
      new Set(['hunter2']),
    );
    assert.equal(safe.endedBy, 'fail');
    assert.ok(!safe.unreachable?.claim.includes('hunter2'), safe.unreachable?.claim);
    assert.ok(!safe.unreachable?.urlAfter.includes('hunter2'));
    assert.deepEqual(safe.unreachable?.headingsAfter, ['Sign in']);
    assert.ok(!(safe.actions[0]?.listbox?.value ?? '').includes('hunter2'));
    assert.equal(safe.actions[0]?.listbox?.shownCount, 9, 'the observed facts are untouched');
  });
});
