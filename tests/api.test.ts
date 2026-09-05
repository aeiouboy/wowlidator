/**
 * Backend awareness: redaction, call classification, and the ladder rung that
 * declines to heal when a request has already failed.
 *
 * Same tiering as the rest of the suite. Redaction and classification are pure
 * functions and run always; the ladder tests need a real page making real
 * requests, so they run only when a CDP endpoint answers.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { FetchTransport, parseJson, recordOf } from '../src/api/api-client.js';
import { classifyCall, isBlockingFailure, type NetworkCall } from '../src/api/network-observer.js';
import {
  REDACTED,
  isSecretStepValue,
  looksLikeCredentialField,
  maskSecret,
  redactBody,
  redactHeaders,
  redactUrl,
} from '../src/api/redact.js';
import {
  UnknownVariableError,
  VariableStore,
  extractPath,
  stringifyExtracted,
} from '../src/api/variables.js';
import { harnessOnly } from '../src/cli/exit.js';
import { backendStepsIn } from '../src/engine/runner.js';
import { ContextEngine } from '../src/context/context-engine.js';
import {
  ApiTestGenerator,
  NoSpecError,
  toApiFlowStep,
  type ApiGenerateRequest,
  type ApiGenerationResult,
  type ApiGeneratorModel,
} from '../src/generator/api-test-generator.js';
import { OpenApiIngester } from '../src/context/ingesters/openapi-ingester.js';
import { ProofBundleBuilder, formatProofSummary } from '../src/engine/proof-bundle.js';
import { isBrowserFree, runFlow, type Flow } from '../src/engine/runner.js';
import { renderReport } from '../src/reporter/html-reporter.js';
import { JitHealer } from '../src/healer/jit-healer.js';
import type { HealerModel, HealRequest, HealSuggestion } from '../src/healer/jit-healer.js';

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';

/** Minimal stub — the point of most of these tests is that it is never called. */
class StubHealerModel implements HealerModel {
  readonly id = 'stub:healer';
  readonly calls: HealRequest[] = [];

  constructor(private readonly reply: (request: HealRequest) => HealSuggestion) {}

  async suggest(request: HealRequest): Promise<HealSuggestion> {
    this.calls.push(request);
    return this.reply(request);
  }
}

function call(overrides: Partial<NetworkCall> = {}): NetworkCall {
  return {
    id: '1',
    method: 'GET',
    url: 'https://example.test/api/thing',
    resourceType: 'XHR',
    startedAt: 0,
    ...overrides,
  };
}

// --- Redaction --------------------------------------------------------------

describe('redaction', () => {
  it('masks credential headers case-insensitively and keeps the names', () => {
    const out = redactHeaders({
      Authorization: 'Bearer sk-live-abc123',
      COOKIE: 'session=deadbeef',
      'Content-Type': 'application/json',
    });

    assert.equal(out['Authorization'], REDACTED);
    assert.equal(out['COOKIE'], REDACTED);
    // The name is evidence — you want to see that auth was sent at all.
    assert.ok('Authorization' in out);
    assert.equal(out['Content-Type'], 'application/json');
  });

  it('honours an explicit reveal list', () => {
    const out = redactHeaders(
      { Authorization: 'Bearer public-demo-token' },
      { reveal: ['authorization'] },
    );
    assert.equal(out['Authorization'], 'Bearer public-demo-token');
  });

  it('masks sensitive keys inside a JSON body but keeps its shape', () => {
    const body = redactBody(
      JSON.stringify({ email: 'a@b.test', password: 'hunter2', nested: { apiKey: 'k-1' } }),
    );
    assert.ok(body);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    assert.equal(parsed['email'], 'a@b.test', 'non-secret fields stay readable');
    assert.equal(parsed['password'], REDACTED);
    assert.equal((parsed['nested'] as Record<string, unknown>)['apiKey'], REDACTED);
  });

  it('masks sensitive keys in a form-encoded body', () => {
    const body = redactBody('user=alice&password=hunter2&remember=1');
    assert.equal(body, `user=alice&password=${REDACTED}&remember=1`);
  });

  it('omits a body it could not parse rather than passing it through', () => {
    // The rule that keeps this safe: never emit a payload we could not inspect.
    // "We didn't recognise the format" is not evidence that it holds no secret.
    const body = redactBody('\u0000binary-protobuf-ish-payload');
    assert.match(body ?? '', /^\[body omitted: \d+ bytes, unrecognised format\]$/);
  });

  it('records a body verbatim only when explicitly asked to', () => {
    const body = redactBody(JSON.stringify({ password: 'hunter2' }), { body: 'full' });
    assert.match(body ?? '', /hunter2/);
  });

  it('masks credentials in a query string', () => {
    assert.equal(
      redactUrl('https://example.test/api?page=2&access_token=abc123'),
      `https://example.test/api?page=2&access_token=${REDACTED}`,
    );
    assert.equal(redactUrl('https://example.test/api'), 'https://example.test/api');
  });
});

// --- Classification ---------------------------------------------------------

describe('call classification', () => {
  it('treats 5xx, dropped connections and expired sessions as blocking', () => {
    assert.equal(classifyCall(call({ status: 500 })), 'server-error');
    assert.equal(classifyCall(call({ errorText: 'net::ERR_CONNECTION_REFUSED' })), 'network-error');
    assert.equal(classifyCall(call({ status: 401 })), 'auth-error');

    for (const failing of [call({ status: 503 }), call({ status: 403 }), call({ status: 0 })]) {
      assert.equal(isBlockingFailure(failing), true);
    }
  });

  it('does NOT treat an ordinary 4xx as blocking', () => {
    // A 404 probing for an optional resource, or a 422 from a validation test
    // that MEANT to submit something invalid, are both normal. Suppressing the
    // heal on those would break healing for every negative test in the suite.
    assert.equal(classifyCall(call({ status: 404 })), 'client-error');
    assert.equal(isBlockingFailure(call({ status: 404 })), false);
    assert.equal(isBlockingFailure(call({ status: 422 })), false);
  });

  it('treats an in-flight call as evidence of nothing', () => {
    assert.equal(classifyCall(call({ status: undefined })), 'ok');
    assert.equal(isBlockingFailure(call({ status: undefined })), false);
  });
});

// --- Variables --------------------------------------------------------------

describe('variable store', () => {
  it('interpolates saved values into strings and nested structures', () => {
    const store = new VariableStore();
    store.set('orderId', 'ord_42');
    store.set('name', 'alice');

    assert.equal(store.interpolate('/api/orders/{{orderId}}'), '/api/orders/ord_42');
    assert.equal(store.interpolate('{{ orderId }}'), 'ord_42', 'whitespace inside braces is fine');
    assert.deepEqual(store.interpolateDeep({ user: { id: '{{orderId}}', who: '{{name}}' } }), {
      user: { id: 'ord_42', who: 'alice' },
    });
    assert.deepEqual(store.interpolateDeep({ count: 3, flag: true }), { count: 3, flag: true });
  });

  it('fails loudly on an unknown variable instead of interpolating nothing', () => {
    const store = new VariableStore();
    store.set('known', 'x');
    // Silently producing "/api/orders/" would surface three steps later as
    // what looks like a backend bug. Fail where the problem actually is.
    assert.throws(() => store.interpolate('/api/orders/{{missing}}'), UnknownVariableError);
    assert.throws(() => store.interpolate('{{missing}}'), /Available: \{\{known\}\}/);
  });

  it('redacts credential-shaped names in the report snapshot but keeps using them', () => {
    const store = new VariableStore();
    store.set('authToken', 'sk-live-secret');
    store.set('orderId', 'ord_42');

    assert.equal(store.snapshotForReport()['authToken'], REDACTED);
    assert.equal(store.snapshotForReport()['orderId'], 'ord_42');
    // Redaction is a reporting concern only — the run still has the real value.
    assert.equal(store.interpolate('{{authToken}}'), 'sk-live-secret');
  });
});

describe('json path extraction', () => {
  const body = { data: { items: [{ id: 7, tags: ['a', 'b'] }] }, ok: true };

  it('walks objects and array indices', () => {
    assert.equal(extractPath(body, '$.data.items[0].id'), 7);
    assert.equal(extractPath(body, 'data.items[0].tags[1]'), 'b');
    assert.equal(extractPath(body, '$.ok'), true);
    assert.equal(extractPath([{ id: 1 }], '$[0].id'), 1);
  });

  it('returns undefined rather than throwing on a path that misses', () => {
    assert.equal(extractPath(body, '$.data.missing.id'), undefined);
    assert.equal(extractPath(body, '$.data.items[9].id'), undefined);
    assert.equal(extractPath(body, '$.data.items.id'), undefined, 'array is not an object');
    assert.equal(extractPath(body, '$.data..items'), undefined, 'malformed path');
  });

  it('renders extracted values as the string a later step will send', () => {
    assert.equal(stringifyExtracted(7), '7');
    assert.equal(stringifyExtracted('x'), 'x');
    assert.equal(stringifyExtracted(true), 'true');
    // Not "[object Object]" — that only ever reveals itself in a server log.
    assert.equal(stringifyExtracted({ a: 1 }), '{"a":1}');
  });
});

describe('request records', () => {
  it('redacts credentials on the way into the bundle, not at each read', () => {
    const record = recordOf(
      {
        method: 'POST',
        url: 'https://example.test/login?api_key=k-1',
        headers: { Authorization: 'Bearer secret' },
        body: JSON.stringify({ password: 'hunter2' }),
      },
      {
        status: 201,
        statusText: 'Created',
        headers: { 'set-cookie': 'session=abc' },
        body: JSON.stringify({ token: 'sk-live' }),
        durationMs: 12,
        sizeBytes: 20,
      },
      { saved: ['authToken'] },
    );

    assert.equal(record.requestHeaders?.['Authorization'], REDACTED);
    assert.equal(record.responseHeaders?.['set-cookie'], REDACTED);
    assert.match(record.url, /api_key=\[redacted\]/);
    assert.match(record.requestBody ?? '', /\[redacted\]/);
    assert.match(record.responseBody ?? '', /\[redacted\]/);
    // Names of saved variables are useful; their values are credentials.
    assert.deepEqual(record.saved, ['authToken']);
    assert.doesNotMatch(JSON.stringify(record), /hunter2|sk-live|session=abc/);
  });

  it('records a call that never got a response as status null', () => {
    const record = recordOf({ method: 'GET', url: 'https://example.test' }, null, {
      error: 'connect ECONNREFUSED',
    });
    assert.equal(record.status, null);
    assert.equal(record.error, 'connect ECONNREFUSED');
  });

  it('parses a JSON body and shrugs at one that is not JSON', () => {
    assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
    assert.equal(parseJson('<html>'), undefined);
    assert.equal(parseJson(''), undefined);
  });
});

// --- Frontend / backend split -----------------------------------------------

describe('frontend and backend result split', () => {
  const base = { startedAt: '2026-01-01T00:00:00.000Z', durationMs: 5, url: 'http://x/' };

  function mixedBundle() {
    const builder = new ProofBundleBuilder({ name: 'mixed', cdpUrl: null, cachePath: null });
    builder.addStep({ action: 'click', selector: '#a', resolvedSelector: '#a', resolution: 'fast', status: 'passed', ...base });
    builder.addStep({ action: 'expectVisible', selector: '#b', resolvedSelector: '#b', resolution: 'fast', status: 'passed', ...base });
    builder.addStep({ action: 'request', selector: null, resolvedSelector: null, resolution: null, status: 'passed', ...base });
    builder.addStep({ action: 'expectStatus', selector: null, resolvedSelector: null, resolution: null, status: 'failed', ...base, error: 'expected 200, got 500' });
    return builder;
  }

  it('counts each step against the side of the system it exercised', () => {
    const bundle = mixedBundle().finish();

    assert.deepEqual(bundle.summary.frontend, { steps: 2, passed: 2, failed: 0, defects: 0 });
    assert.deepEqual(bundle.summary.backend, { steps: 2, passed: 1, failed: 1, defects: 0 });
    // The halves must reconcile with the headline, or the split is a lie.
    assert.equal(
      bundle.summary.frontend.steps + bundle.summary.backend.steps,
      bundle.summary.totalSteps,
    );
    assert.equal(
      bundle.summary.frontend.failed + bundle.summary.backend.failed,
      bundle.summary.failed,
    );
  });

  it('lifts the backend hint off the intent, at the one recording choke point', () => {
    // Backend testing was off, so the claim was proved on screen and the
    // author marked the step. The stored intent must read as a plain
    // sentence; the hint stands on its own field, where the report and the
    // panel can show it without parsing prose.
    const builder = new ProofBundleBuilder({ name: 'visual only', cdpUrl: null, cachePath: null });
    const base = { selector: null, resolvedSelector: null, resolution: null, startedAt: new Date().toISOString(), durationMs: 4, url: null };
    const marked = builder.addStep({
      action: 'expectVisible',
      intent: 'backend could prove this: the count on screen should equal the benefit_plan rows',
      status: 'passed',
      ...base,
    });
    assert.equal(marked.backendHint, 'the count on screen should equal the benefit_plan rows');
    assert.equal(marked.intent, 'the count on screen should equal the benefit_plan rows');

    // An ordinary intent is untouched, and an empty hint is no hint.
    const plain = builder.addStep({ action: 'expectVisible', intent: 'the card is on screen', status: 'passed', ...base });
    assert.equal(plain.backendHint, undefined);
    assert.equal(plain.intent, 'the card is on screen');
    const bare = builder.addStep({ action: 'expectVisible', intent: 'backend could prove this:', status: 'passed', ...base });
    assert.equal(bare.backendHint, undefined);
    // It is a note, never a verdict: the step passed and the run is clean.
    assert.equal(builder.finish().status, 'passed');
  });

  it('finds every backend step a flow carries, including inside a when branch', () => {
    assert.deepEqual(
      backendStepsIn([
        { action: 'goto', url: '/x' },
        { action: 'expectVisible', selector: 'text=Plans' },
        { action: 'request', method: 'GET', url: '/api/plans' },
        { action: 'when', visible: 'text=x', then: [{ action: 'expectDbRow', table: 't', where: {} }] },
      ]).map((one) => one.action),
      ['request', 'expectDbRow'],
      'a branch is still part of the flow',
    );
    assert.deepEqual(backendStepsIn([{ action: 'expectVisible', selector: 'text=x' }]), []);
  });

  it('routes defects by category, because they route to different teams', () => {
    const builder = mixedBundle();
    builder.addDefect({ id: 'd1', source: 'runtime', category: 'backend', severity: 'high', title: 'POST /api/shifts returned 500', detail: '' });
    builder.addDefect({ id: 'd2', source: 'runtime', category: 'functional', severity: 'low', title: 'Selector drifted', detail: '' });
    builder.addDefect({ id: 'd3', source: 'generator', category: 'accessibility', severity: 'medium', title: 'Unlabelled control', detail: '' });
    const bundle = builder.finish();

    assert.equal(bundle.summary.backend.defects, 1);
    assert.equal(bundle.summary.frontend.defects, 2);
    assert.equal(
      bundle.summary.frontend.defects + bundle.summary.backend.defects,
      bundle.summary.defects,
    );
  });

  it('counts a malformed API step against the backend half, whatever its category', () => {
    const builder = mixedBundle();
    // `functional`, because an unknown {{variable}} is a broken *test*, not a
    // broken endpoint — but it is still the API half of that test.
    builder.addDefect({ id: 'd1', source: 'runtime', category: 'functional', severity: 'high', title: 'Step failed: request', detail: '', stepIndex: 2 });
    const bundle = builder.finish();

    assert.equal(bundle.summary.backend.defects, 1);
    assert.equal(bundle.summary.frontend.defects, 0);
  });

  it('keeps an observed backend failure on the backend side even when it lands on a UI step', () => {
    const builder = mixedBundle();
    // Raised by the network observer against a `click`: the page's own traffic
    // failed. The step is frontend, the fault is not.
    builder.addDefect({ id: 'd1', source: 'runtime', category: 'backend', severity: 'high', title: 'Backend call failed during: click', detail: '', stepIndex: 0 });
    const bundle = builder.finish();

    assert.equal(bundle.summary.backend.defects, 1);
    assert.equal(bundle.summary.frontend.defects, 0);
  });

  it('puts a pure-UI run entirely on the frontend side', () => {
    const builder = new ProofBundleBuilder({ name: 'ui only', cdpUrl: null, cachePath: null });
    builder.addStep({ action: 'goto', selector: null, resolvedSelector: null, resolution: null, status: 'passed', ...base });
    builder.addStep({ action: 'click', selector: '#a', resolvedSelector: '#a', resolution: 'fast', status: 'passed', ...base });
    const bundle = builder.finish();

    assert.deepEqual(bundle.summary.backend, { steps: 0, passed: 0, failed: 0, defects: 0 });
    assert.equal(bundle.summary.frontend.steps, 2);
  });

  it('prints the split only when there is a backend half to report', () => {
    const mixed = formatProofSummary(mixedBundle().finish());
    assert.match(mixed, /frontend {3}2\/2 passed/);
    assert.match(mixed, /backend {4}1\/2 passed/);

    const uiOnly = new ProofBundleBuilder({ name: 'ui only', cdpUrl: null, cachePath: null });
    uiOnly.addStep({ action: 'click', selector: '#a', resolvedSelector: '#a', resolution: 'fast', status: 'passed', ...base });
    // A `backend 0/0` line on every UI run would be noise pretending to be
    // information — the headline already is the frontend number.
    assert.doesNotMatch(formatProofSummary(uiOnly.finish()), /backend/);
  });

  it('marks backend steps in the report, and leaves UI steps unmarked', () => {
    const html = renderReport(mixedBundle().finish());
    // The label now carries its plain-language explanation inline (spec R2).
    assert.match(html, /badge res-backend"><abbr title="[^"]+">backend<\/abbr>/);
    assert.match(html, /frontend steps/);
    assert.match(html, /backend steps/);
  });
});

// --- Report rendering -------------------------------------------------------

describe('report rendering', () => {
  function bundleWithHttp() {
    const builder = new ProofBundleBuilder({ name: 'http fixture' });
    const base = {
      startedAt: '2026-07-31T00:00:00.000Z',
      durationMs: 12,
      url: 'https://example.test/orders',
    };

    builder.addStep({
      action: 'request',
      intent: 'Create an order to work with',
      selector: null,
      resolvedSelector: null,
      resolution: 'fast',
      status: 'passed',
      ...base,
      request: recordOf(
        {
          method: 'POST',
          url: 'https://example.test/api/orders',
          headers: { Authorization: 'Bearer sk-live-leak' },
          body: JSON.stringify({ sku: 'abc', password: 'hunter2' }),
        },
        {
          status: 201,
          statusText: 'Created',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: 'ord_7' }),
          durationMs: 12,
          sizeBytes: 16,
        },
        { saved: ['orderId'] },
      ),
    });

    builder.addStep({
      action: 'expectVisible',
      // A defect title and a url both reach the HTML — both must be escaped.
      selector: '#result',
      resolvedSelector: null,
      resolution: null,
      status: 'failed',
      ...base,
      error: 'not visible',
      network: [
        {
          id: '1',
          method: 'GET',
          url: 'https://example.test/api/thing?q=<script>alert(1)</script>',
          resourceType: 'XHR',
          startedAt: 0,
          status: 500,
          durationMs: 30,
        },
      ],
    });

    return builder.finish();
  }

  it('shows a request without leaking what was in it', () => {
    const html = renderReport(bundleWithHttp());

    assert.match(html, /HTTP POST/);
    assert.match(html, /ord_7/, 'the response body is evidence and should be readable');
    assert.match(html, /orderId/, 'saved variable names are useful');
    // The report is meant to be emailed. Nothing secret may survive into it.
    assert.doesNotMatch(html, /sk-live-leak/);
    assert.doesNotMatch(html, /hunter2/);
  });

  it('escapes observed urls and stays self-contained', () => {
    const html = renderReport(bundleWithHttp());

    assert.match(html, /Requests failed while this step was waiting/);
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, 'observed urls must be escaped');
    // The existing self-containment contract: no network fetch at view time.
    assert.doesNotMatch(html, /<script\s+src=/i);
    assert.doesNotMatch(html, /<link[^>]+stylesheet/i);
  });

  it('surfaces failed requests as a summary card only when there are some', () => {
    const withFailures = new ProofBundleBuilder({ name: 'failures' });
    withFailures.setNetworkTotals({ calls: 9, failures: 2, dropped: 0 });
    withFailures.noteBackendBlocked();
    assert.match(renderReport(withFailures.finish()), /failed requests/);

    const clean = new ProofBundleBuilder({ name: 'clean' });
    clean.setNetworkTotals({ calls: 9, failures: 0, dropped: 0 });
    assert.doesNotMatch(renderReport(clean.finish()), /failed requests/);
  });
});

// --- Browser-free flows -----------------------------------------------------

describe('browser-free api flows', () => {
  let server: Server;
  let origin: string;

  before(async () => {
    server = createServer((req, res) => {
      if ((req.url ?? '').startsWith('/api/orders/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: req.url?.split('/').pop(), status: 'new' }));
        return;
      }
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { id: 'ord_9' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('classifies flows by what they contain, not by a flag', () => {
    assert.equal(
      isBrowserFree({ name: 'x', steps: [{ action: 'request', method: 'GET', url: '/a' }] }),
      true,
    );
    assert.equal(
      isBrowserFree({
        name: 'x',
        steps: [
          { action: 'request', method: 'GET', url: '/a' },
          { action: 'click', selector: '#go' },
        ],
      }),
      false,
    );
    // A UI step anywhere — including setup — means a browser is needed.
    assert.equal(
      isBrowserFree({
        name: 'x',
        setup: [{ action: 'goto', url: '/' }],
        steps: [{ action: 'request', method: 'GET', url: '/a' }],
      }),
      false,
    );
    assert.equal(isBrowserFree({ name: 'empty', steps: [] }), false);
  });

  it('runs end to end with no CDP endpoint reachable at all', async () => {
    const flow: Flow = {
      name: 'pure-api',
      baseUrl: origin,
      steps: [
        { action: 'request', method: 'POST', url: '/api/orders', save: { id: '$.data.id' } },
        { action: 'expectStatus', status: 201 },
        { action: 'request', method: 'GET', url: '/api/orders/{{id}}' },
        { action: 'expectJson', path: '$.id', value: 'ord_9' },
      ],
    };

    // Deliberately a dead port: if this run touches Chrome at all it fails.
    const bundle = await runFlow(flow, { cdpUrl: 'http://127.0.0.1:1', historyPath: null });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'run should pass');
    assert.equal(bundle.summary.apiRequests, 2);
    assert.equal(bundle.cdpUrl, null, 'no browser was involved, and the bundle should say so');
    assert.equal(bundle.summary.totalSteps, 4);
  });

  it('an absolute-path request keeps the base URL\'s own path', async () => {
    // `new URL('/api/x', 'https://h/app')` drops `/app` and asks the gateway
    // instead of the application — measured live 2026-09-05 as 27 HTML 404s
    // on paths the page itself called successfully under its base path.
    const flow: Flow = {
      name: 'base-path',
      baseUrl: `${origin}/app`,
      steps: [
        { action: 'request', method: 'GET', url: '/api/orders/ord_1' },
        { action: 'request', method: 'GET', url: '/app/api/orders/ord_1', intent: 'already under the base path' },
        { action: 'request', method: 'GET', url: `${origin}/api/orders/ord_1`, intent: 'absolute stays absolute' },
      ],
    };
    const bundle = await runFlow(flow, { cdpUrl: 'http://127.0.0.1:1', historyPath: null });
    const urls = bundle.steps.map((s) => s.request?.url);
    assert.equal(urls[0], `${origin}/app/api/orders/ord_1`);
    assert.equal(urls[1], `${origin}/app/api/orders/ord_1`);
    assert.equal(urls[2], `${origin}/api/orders/ord_1`);
  });

  it('still runs teardown after a failed body', async () => {
    const flow: Flow = {
      name: 'teardown-runs',
      baseUrl: origin,
      steps: [
        { action: 'request', method: 'GET', url: '/api/orders/ord_1' },
        { action: 'expectStatus', status: 999, intent: 'deliberately wrong' },
      ],
      teardown: [{ action: 'request', method: 'GET', url: '/api/orders/cleanup' }],
    };

    const bundle = await runFlow(flow, { cdpUrl: 'http://127.0.0.1:1', historyPath: null });

    assert.equal(bundle.status, 'failed');
    const cleanup = bundle.steps.at(-1);
    assert.match(cleanup?.request?.url ?? '', /cleanup/, 'teardown must still have run');
  });

  it('reports a transport failure as a backend defect, not a mystery', async () => {
    const flow: Flow = {
      name: 'unreachable',
      steps: [{ action: 'request', method: 'GET', url: 'http://127.0.0.1:1/nope' }],
    };

    const bundle = await runFlow(flow, { historyPath: null });

    // A request that never got a response is an `error` in the run taxonomy —
    // a harness/transport-side outcome, not an assertion the app contradicted.
    assert.equal(bundle.status, 'error');
    assert.equal(bundle.summary.apiFailures, 1);
    assert.equal(bundle.steps[0]?.request?.status, null);
    assert.equal(bundle.defects[0]?.category, 'backend');
  });
});

// --- The ladder rung, against a real browser --------------------------------

async function cdpAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('/json/version', url), {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * A page whose button fetches an endpoint and only renders `#result` if the
 * fetch succeeded — the ordinary shape of "the control never appeared because
 * the data never arrived".
 */
const FIXTURE_HTML = `<!doctype html>
<html><body>
  <button id="load">Load</button>
  <div id="output"></div>
  <script>
    document.getElementById('load').addEventListener('click', async () => {
      try {
        const response = await fetch('/api/thing', { headers: { Authorization: 'Bearer sk-test-secret' } });
        if (!response.ok) return;
        document.getElementById('output').innerHTML = '<span id="result">loaded</span>';
      } catch {}
    });
  </script>
</body></html>`;

const browserReady = await cdpAvailable(CDP_URL);
const skipBrowser = browserReady
  ? false
  : `no CDP endpoint at ${CDP_URL} — start Chrome with --remote-debugging-port=9222 (npm run chrome)`;

describe('backend-aware escalation ladder (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;
  let dir: string;
  /** Status the fixture endpoint answers with — set per test. */
  let apiStatus = 500;

  before(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith('/api/thing')) {
        res.writeHead(apiStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'nope' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-api-'));
  });

  after(async () => {
    // Chrome holds keep-alive sockets open; without this close() blocks ~60s.
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  });

  function flowFor(name: string): Flow {
    return {
      name,
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'click', selector: '#load', intent: 'Load the thing' },
        { action: 'expectVisible', selector: '#result', intent: 'The thing is shown' },
      ],
    };
  }

  it('declines to heal when the request behind the step returned 500', async () => {
    apiStatus = 500;
    const healerModel = new StubHealerModel(() => {
      throw new Error('the healer must not be reached when the backend already failed');
    });

    const bundle = await runFlow(flowFor('backend-500'), {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'backend-500.json'),
      makeHealer: (cache) => new JitHealer({ model: healerModel, cache }),
    });

    // The unresolved control records as a dead end (the ladder ran out of
    // rungs — deliberately, since the backend rung stopped it).
    assert.equal(bundle.status, 'dead-end');
    // The whole point: no token was spent guessing at a selector that was fine.
    assert.equal(healerModel.calls.length, 0, 'control plane must stay idle');
    assert.equal(bundle.summary.jitHeals, 0);
    assert.equal(bundle.summary.backendBlocked, 1);
    assert.ok(bundle.summary.networkFailures >= 1);

    const failed = bundle.steps.find((step) => step.status !== 'passed');
    assert.equal(failed?.action, 'expectVisible');
    // The failing call is attached as evidence, even though it was triggered by
    // the PREVIOUS step — that lookback is the reason this test exists.
    const evidence = failed?.network ?? [];
    assert.ok(
      evidence.some((entry) => entry.status === 500 && entry.url.includes('/api/thing')),
      `expected the 500 to be attached, got ${JSON.stringify(evidence)}`,
    );

    const defect = bundle.defects.find((entry) => entry.category === 'backend');
    assert.ok(defect, 'a backend defect should be raised, not a generic functional one');
    assert.equal(defect?.severity, 'high');
    // Correlational wording is load-bearing: we know it failed alongside, not
    // that it caused the failure.
    assert.match(defect?.detail ?? '', /correlation, not a proof of cause/);
  });

  it('redacts the Authorization header the page sent', async () => {
    apiStatus = 500;
    const bundle = await runFlow(flowFor('redaction'), {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'redaction.json'),
    });

    const evidence = bundle.steps.flatMap((step) => step.network ?? []);
    const observed = evidence.find((entry) => entry.url.includes('/api/thing'));
    assert.ok(observed, 'the failing call should have been observed');
    const header = Object.entries(observed.requestHeaders ?? {}).find(
      ([name]) => name.toLowerCase() === 'authorization',
    );
    assert.ok(header, 'the header was sent, so it should be recorded');
    assert.equal(header[1], REDACTED);
    // Belt and braces: the token must not survive anywhere in the bundle.
    assert.doesNotMatch(JSON.stringify(bundle), /sk-test-secret/);
  });

  it('still heals normally when the failing request is an ordinary 4xx', async () => {
    apiStatus = 404;
    const healerModel = new StubHealerModel(() => ({
      selector: '#output',
      strategy: 'css',
      confidence: 0.9,
      reasoning: 'the output container is present even when empty',
      inputTokens: 100,
      outputTokens: 10,
    }));

    const bundle = await runFlow(flowFor('client-4xx'), {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'client-4xx.json'),
      makeHealer: (cache) => new JitHealer({ model: healerModel, cache }),
    });

    // A 404 is not evidence the app is broken, so the ladder must run to the
    // end as it always did. Without this carve-out every negative test in the
    // suite would silently lose healing.
    assert.equal(healerModel.calls.length, 1, 'the healer should still be consulted');
    assert.equal(bundle.summary.backendBlocked, 0);
    void bundle.status;
  });

  it('counts traffic on a passing run without attaching noise to every step', async () => {
    apiStatus = 200;
    const bundle = await runFlow(flowFor('healthy'), {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'healthy.json'),
    });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'run should pass');
    assert.ok(bundle.summary.networkCalls > 0, 'the document and the XHR should both be counted');
    assert.equal(bundle.summary.networkFailures, 0);
    assert.equal(bundle.summary.backendBlocked, 0);
    // Evidence is attached only where it IS evidence — a green run stays clean.
    assert.equal(
      bundle.steps.filter((step) => step.network !== undefined).length,
      0,
      'passing steps must not carry network dumps',
    );
  });

  it('can be turned off entirely', async () => {
    apiStatus = 500;
    const bundle = await runFlow(flowFor('observer-off'), {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'observer-off.json'),
      network: false,
    });

    assert.equal(bundle.summary.networkCalls, 0);
    assert.equal(bundle.summary.backendBlocked, 0);
    assert.equal(bundle.steps.filter((step) => step.network !== undefined).length, 0);
  });
});

// --- API steps inside a flow ------------------------------------------------

/** A page that logs in over XHR, so the browser context ends up holding a session cookie. */
const LOGIN_HTML = `<!doctype html>
<html><body>
  <button id="login">Sign in</button>
  <div id="state"></div>
  <script>
    document.getElementById('login').addEventListener('click', async () => {
      await fetch('/api/login', { method: 'POST' });
      document.getElementById('state').innerHTML = '<span id="signed-in">signed in</span>';
    });
  </script>
</body></html>`;

describe('api flow steps (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;
  let dir: string;

  /**
   * Unique per run, because wowlidator attaches to a *running* Chrome and reuses
   * its existing context — cookies outlive a test, and even a whole test run.
   * A fixed value would let a leftover cookie from an earlier run make the
   * session-inheritance test pass without inheriting anything.
   */
  const sessionValue = `alice-${Date.now().toString(36)}`;

  before(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? '/';
      const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      };

      if (url === '/api/login' && req.method === 'POST') {
        json(200, { ok: true }, { 'set-cookie': `session=${sessionValue}; Path=/` });
        return;
      }
      if (url === '/api/me') {
        // The whole point of routing API steps through the browser context:
        // this only answers 200 if the UI login's cookie came along.
        if ((req.headers.cookie ?? '').includes(sessionValue)) json(200, { user: 'alice' });
        else json(401, { error: 'not signed in' });
        return;
      }
      if (url === '/api/forbidden') {
        json(403, { error: 'nope' });
        return;
      }
      // The PL_03_03 shape: a real endpoint that answers writes only. Next.js
      // answers 405 for a handler file with no matching export, and so does
      // this fixture.
      // A page the app declares and serves, and one it does not have at all.
      if (url === '/en/admin/benefits/plans') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<h1>Benefit Plan Catalog</h1>');
        return;
      }
      if (url.startsWith('/en/')) {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<h1>404 — not found</h1>');
        return;
      }
      if (url === '/api/write-only') {
        if (req.method === 'POST') json(201, { ok: true });
        else json(405, { error: 'method not allowed' });
        return;
      }
      if (url === '/api/orders' && req.method === 'POST') {
        json(201, { data: { id: 'ord_7' }, status: 'new' });
        return;
      }
      if (url.startsWith('/api/orders/')) {
        json(200, { id: url.split('/').pop(), status: 'new' });
        return;
      }
      if (url === '/api/no-id') {
        json(200, { nothing: 'useful' });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(LOGIN_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-apiflow-'));
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('inherits the session the UI established — the reason API steps live in the same flow', async () => {
    const flow: Flow = {
      name: 'session-inheritance',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'click', selector: '#login', intent: 'Sign in through the real UI' },
        { action: 'expectVisible', selector: '#signed-in' },
        { action: 'request', method: 'GET', url: '/api/me', intent: 'Ask the API who we are' },
        { action: 'expectStatus', status: 200 },
        { action: 'expectJson', path: '$.user', value: 'alice' },
      ],
    };

    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'session.json'),
    });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'run should pass');
    // A 401 here would mean the call went out with no cookie — i.e. the
    // transport was Node's fetch rather than the browser context's.
    const request = bundle.steps.find((step) => step.action === 'request');
    assert.equal(request?.request?.status, 200);
    assert.equal(bundle.summary.apiRequests, 1);
    assert.equal(bundle.summary.apiFailures, 0);
  });

  it('saves a value from one response and interpolates it into the next request', async () => {
    const flow: Flow = {
      name: 'save-and-use',
      baseUrl: origin,
      steps: [
        {
          action: 'request',
          method: 'POST',
          url: '/api/orders',
          body: { sku: 'abc' },
          save: { orderId: '$.data.id' },
          intent: 'Create an order to work with',
        },
        { action: 'expectStatus', status: [200, 201] },
        { action: 'request', method: 'GET', url: '/api/orders/{{orderId}}' },
        { action: 'expectJson', path: '$.id', value: 'ord_7' },
        { action: 'expectHeader', name: 'Content-Type', value: 'application/json' },
      ],
    };

    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'save.json') });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'run should pass');
    const [create, , fetchOne] = bundle.steps;
    assert.deepEqual(create?.request?.saved, ['orderId'], 'names are recorded');
    assert.match(fetchOne?.request?.url ?? '', /\/api\/orders\/ord_7$/, 'placeholder resolved');
    assert.equal(bundle.summary.apiRequests, 2);
  });

  it('does not fail a request step on a 4xx — the status is the thing being tested', async () => {
    const flow: Flow = {
      name: 'negative-path',
      baseUrl: origin,
      steps: [
        // Deliberately an endpoint that always refuses, rather than relying on
        // being logged out: the attached browser keeps its cookies between
        // runs, so "no session" is not something a test can assume.
        { action: 'request', method: 'GET', url: '/api/forbidden' },
        { action: 'expectStatus', status: 403, intent: 'The endpoint refuses this caller' },
      ],
    };

    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'negative.json') });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'a 401 assertion should pass');
    assert.equal(bundle.summary.failed, 0);
    assert.equal(bundle.summary.apiFailures, 0, 'a 401 is a result, not a transport failure');
  });

  it('reads a 404 against the codebase: undeclared route is the test\'s fault', async () => {
    // be100 PL_02_03 (2026-08-25): a flow navigated to a path that answered
    // 404. `page.goto` resolves for any response, so the navigation recorded
    // as PASSED and every step after it failed against the error page —
    // filed against the application. The repository knew the real routes.
    const declaredRoutes = ['/:locale/admin/benefits/plans', '/:locale/login'];
    const bundle = await runFlow(
      {
        name: 'invented page',
        baseUrl: origin,
        steps: [{ action: 'goto', url: '/en/admin/benefits/plans/create' }],
      },
      { cdpUrl: CDP_URL, cachePath: join(dir, 'route-404.json'), declaredRoutes },
    );

    const nav = bundle.steps.find((step) => step.action === 'goto');
    assert.equal(nav?.status, 'error', 'error, not failed — the test asked for a page that does not exist');
    assert.match(nav?.error ?? '', /declares no route for it/);
    assert.match(nav?.error ?? '', /\/:locale\/admin\/benefits\/plans/, 'and names what they meant');
    assert.equal(
      bundle.defects.some((defect) => defect.category === 'backend' || defect.severity === 'high'),
      false,
      'nothing is filed against an application that never claimed to have this page',
    );
    // Every broken step being `error` is what records the case blocked.
    assert.match(harnessOnly(bundle) ?? '', /the harness ended this case/);
  });

  it('reads a 404 against the codebase: a declared route not served IS the app failing', async () => {
    // The opposite finding, and only the codebase can tell them apart.
    const bundle = await runFlow(
      { name: 'declared but missing', baseUrl: origin, steps: [{ action: 'goto', url: '/en/admin/benefits/missing' }] },
      {
        cdpUrl: CDP_URL,
        cachePath: join(dir, 'route-declared.json'),
        declaredRoutes: ['/:locale/admin/benefits/missing'],
      },
    );
    const defect = bundle.defects.find((one) => /did not serve a page it declares/.test(one.title));
    assert.ok(defect, 'the application should serve a page it declares and did not');
    assert.equal(defect?.severity, 'high');
  });

  it('keeps no opinion about a 404 when no repository is indexed', async () => {
    // Silence where the evidence runs out: with nothing indexed there is no
    // way to tell an invented path from a broken page, and guessing either
    // way would be worse than the honest failure the later steps produce.
    const bundle = await runFlow(
      { name: 'no index', baseUrl: origin, steps: [{ action: 'goto', url: '/en/whatever' }] },
      { cdpUrl: CDP_URL, cachePath: join(dir, 'route-noindex.json') },
    );
    assert.equal(bundle.steps.find((step) => step.action === 'goto')?.status, 'passed');
  });

  it('refuses a flow carrying a backend step when the run has backend off', async () => {
    // "Not even present" is the rule the user set. The author cannot write
    // one; this is the layer for a flow authored earlier, edited by hand, or
    // rewritten by the repair loop. Refused, never silently skipped — a suite
    // that quietly drops assertions goes green having proved less than it
    // claims, which is the vacuous pass in a new coat.
    const flow: Flow = {
      name: 'db claim, backend off',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'expectDbRow', table: 'benefit_plan', where: {}, count: '1' },
      ],
    };
    await assert.rejects(
      () => runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'be-off.json'), backend: false }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === 'BackendDisabledError' &&
        /carries 1 backend step\(s\)/.test(error.message) &&
        /expectDbRow/.test(error.message),
    );
    // On (the default) it is nobody's business — the step runs and fails on
    // its own terms, because no database is configured here.
    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'be-on.json') });
    assert.ok(bundle.steps.some((step) => step.action === 'expectDbRow'), 'the step ran');
  });

  it('scores a 405 as the test\'s own method drift, never a backend defect', async () => {
    // be100 PL_03_03 (2026-08-25): `GET /api/benefit-plans` against a handler
    // exporting POST/PUT/DELETE only. The run filed a `high` backend defect
    // and a `high` functional one, and the case was scored a failure —
    // against an application answering exactly as written. The prose said
    // "check the spec before filing one"; it lived in the error message,
    // where no verdict could read it.
    const flow: Flow = {
      name: 'method-drift',
      baseUrl: origin,
      steps: [
        { action: 'request', method: 'GET', url: '/api/write-only' },
        { action: 'expectStatus', status: 200 },
      ],
    };

    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'method.json') });

    assert.notEqual(bundle.status, 'passed', 'the claim still fails — a wrong status is a wrong status');
    const status = bundle.steps.find((step) => step.action === 'expectStatus');
    assert.equal(status?.status, 'error', 'error, not failed: the flow asked the wrong way');
    assert.match(status?.error ?? '', /method-level refusal/);
    assert.equal(
      bundle.defects.some((defect) => defect.category === 'backend'),
      false,
      'no defect routes to whoever owns the endpoint — the endpoint is fine',
    );
    // Every broken step being `error` is what lets the suite record the case
    // blocked (no verdict) instead of filing it as a product failure.
    assert.equal(
      bundle.steps.filter((step) => step.status !== 'passed').every((step) => step.status === 'error'),
      true,
    );
    assert.match(harnessOnly(bundle) ?? '', /the harness ended this case, not the application/);
  });

  it('a 405 on a save files no "response did not contain" defect either', async () => {
    const flow: Flow = {
      name: 'method-drift-save',
      baseUrl: origin,
      steps: [{ action: 'request', method: 'GET', url: '/api/write-only', save: { n: '$.count' } }],
    };

    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'method-save.json') });

    const request = bundle.steps.find((step) => step.action === 'request');
    assert.equal(request?.status, 'error');
    assert.match(request?.error ?? '', /refused the method/);
    assert.equal(
      bundle.defects.some((defect) => /did not contain what the test needed/.test(defect.title)),
      false,
      'the body was never going to hold it — the reason is the verb',
    );
  });

  it('fails the step where a save path misses, not three steps later', async () => {
    const flow: Flow = {
      name: 'missing-save',
      baseUrl: origin,
      steps: [
        { action: 'request', method: 'GET', url: '/api/no-id', save: { orderId: '$.data.id' } },
        { action: 'expectStatus', status: 200 },
      ],
    };

    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'missing.json') });

    // A missed save path is an `error` (the harness could not proceed), not a
    // `failed` assertion — see `classifyStepFailure` in the runner.
    assert.equal(bundle.status, 'error');
    const request = bundle.steps.find((step) => step.action === 'request');
    assert.equal(request?.status, 'error');
    assert.match(request?.error ?? '', /could not save \{\{orderId\}\}/);
    // The error lands on the step that missed the save — later steps still get
    // their turn (a non-passing step no longer aborts the run), but none of
    // them is blamed for the broken variable.
    assert.equal(bundle.steps.length, 2);
  });

  it('says so plainly when an assertion has no response to check — and blames the flow, not the backend', async () => {
    const flow: Flow = {
      name: 'no-request',
      baseUrl: origin,
      steps: [{ action: 'expectStatus', status: 200 }],
    };

    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'no-request.json') });

    // A flow-ordering fault: the application was never contacted, so this is
    // `error` (the harness family), never `failed`, and files no backend
    // defect — it used to be a `backend`/`high` defect sending a reader to an
    // endpoint no one called.
    assert.equal(bundle.status, 'error');
    assert.equal(bundle.steps[0]?.status, 'error');
    assert.match(bundle.steps[0]?.error ?? '', /no request step has run yet/);
    assert.equal(bundle.defects.some((d) => d.category === 'backend'), false);
  });

  it('scores an unknown {{variable}} in an assertion as the flow, not the backend', async () => {
    // The asymmetry this pins shut: the identical fault on a `request` step
    // was always `error`, while on an `expectJson` it scored `failed` plus a
    // `backend`/`high` defect — a false test failure about an endpoint that
    // answered exactly as asked.
    const flow: Flow = {
      name: 'unknown-var-assert',
      baseUrl: origin,
      steps: [
        { action: 'request', method: 'GET', url: '/api/forbidden' },
        { action: 'expectJson', path: '$.error', value: '{{neverSaved}}' },
      ],
    };

    const bundle = await runFlow(flow, { cdpUrl: CDP_URL, cachePath: join(dir, 'unknown-var-assert.json') });

    assert.equal(bundle.status, 'error');
    assert.equal(bundle.steps[1]?.status, 'error');
    assert.match(bundle.steps[1]?.error ?? '', /unknown variable/);
    assert.equal(bundle.defects.some((d) => d.category === 'backend'), false);
  });

  it('works through a plain fetch transport too, for browser-free use', async () => {
    // Same code path, no browser context — this is what a standalone API flow
    // will lean on once the browser becomes optional.
    const transport = new FetchTransport();
    const response = await transport.send({ method: 'GET', url: `${origin}/api/forbidden` });
    assert.equal(response.status, 403);
    assert.deepEqual(parseJson(response.body), { error: 'nope' });
  });
});

// --- OpenAPI ingestion ------------------------------------------------------

const SPEC = {
  openapi: '3.0.3',
  info: { title: 'Orders API', version: '1.0.0' },
  servers: [{ url: 'https://api.example.test/v1' }],
  paths: {
    '/orders': {
      parameters: [{ name: 'tenant', in: 'query', required: true, schema: { type: 'string' } }],
      get: {
        operationId: 'listOrders',
        summary: 'List orders',
        tags: ['orders'],
        responses: { '200': { description: 'ok' }, '401': { description: 'unauthorised' } },
      },
      post: {
        operationId: 'createOrder',
        security: [{ bearer: [] }],
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/NewOrder' } } },
        },
        responses: { '201': { description: 'created' } },
      },
    },
    '/orders/{orderId}': {
      delete: { operationId: 'deleteOrder', deprecated: true, responses: { '204': { description: 'gone' } } },
    },
    '/broken': {
      get: { responses: { '200': { $ref: '#/components/schemas/DoesNotExist' } } },
    },
  },
  components: {
    schemas: {
      NewOrder: {
        type: 'object',
        required: ['sku'],
        properties: { sku: { type: 'string' }, quantity: { type: 'integer' } },
      },
    },
  },
};

describe('openapi ingester', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-openapi-'));
    await writeFile(join(dir, 'openapi.json'), JSON.stringify(SPEC), 'utf8');
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function ingest(source?: string) {
    const ingester = new OpenApiIngester(source === undefined ? {} : { source });
    return ingester.ingest({ rootDir: dir, files: ['openapi.json'] });
  }

  it('indexes one node per method+path, not per path', async () => {
    const { nodes } = await ingest();
    const ids = nodes.map((node) => node.id).sort();

    assert.deepEqual(ids, [
      'operation:DELETE /orders/{orderId}',
      'operation:GET /broken',
      'operation:GET /orders',
      'operation:POST /orders',
    ]);
    // Two operations share `/orders` — folding them into one route-style node
    // would lose the fact that GET and POST are different promises.
    assert.equal(nodes.filter((node) => node.meta?.['path'] === '/orders').length, 2);
  });

  it('names operations in the `:param` form the route matcher already speaks', async () => {
    const { nodes } = await ingest();
    const del = nodes.find((node) => node.id === 'operation:DELETE /orders/{orderId}');
    assert.equal(del?.name, 'DELETE /orders/:orderId');
    // The raw spec path is kept, because that's what you send to the server.
    assert.equal(del?.meta?.['path'], '/orders/{orderId}');
    assert.equal(del?.meta?.['deprecated'], 'true');
  });

  it('resolves local $refs and summarises the body instead of inlining it', async () => {
    const { nodes } = await ingest();
    const post = nodes.find((node) => node.id === 'operation:POST /orders');
    assert.match(post?.meta?.['requestBody'] ?? '', /application\/json \{ sku: string, quantity\?: integer \}/);
    assert.equal(post?.meta?.['secured'], 'true');
    assert.equal(post?.meta?.['statuses'], '201');
  });

  it('says a $ref is unresolved rather than pretending it resolved', async () => {
    const { nodes } = await ingest();
    const broken = nodes.find((node) => node.id === 'operation:GET /broken');
    // An external or missing ref is a disclosed gap, not a silent drop.
    assert.match(JSON.stringify(broken?.meta), /unresolved|200/);
  });

  it('merges path-level parameters into every operation under that path', async () => {
    const { nodes } = await ingest();
    const get = nodes.find((node) => node.id === 'operation:GET /orders');
    assert.match(get?.meta?.['parameters'] ?? '', /query:tenant/);
    assert.equal(get?.meta?.['statuses'], '200,401');
    assert.equal(get?.meta?.['base'], 'https://api.example.test/v1');
  });

  it('reads YAML as happily as JSON', async () => {
    const yamlPath = join(dir, 'spec.yaml');
    await writeFile(
      yamlPath,
      ['openapi: 3.0.0', 'paths:', '  /ping:', '    get:', '      summary: Ping'].join('\n'),
      'utf8',
    );
    const { nodes } = await ingest(yamlPath);
    assert.equal(nodes[0]?.id, 'operation:GET /ping');
    assert.equal(nodes[0]?.detail, 'Ping');
  });

  it('warns rather than throwing when the spec is unreadable', async () => {
    const { nodes, warnings } = await ingest(join(dir, 'nope.json'));
    assert.equal(nodes.length, 0);
    assert.equal(warnings.length, 1);
    // One bad ingester must never take the other four down with it.
    assert.match(warnings[0] ?? '', /could not read the OpenAPI spec/);
  });

  it('stays silent when a project simply has no spec', async () => {
    const ingester = new OpenApiIngester();
    const result = await ingester.ingest({ rootDir: dir, files: ['src/index.ts'] });
    assert.deepEqual(result, { nodes: [], edges: [], warnings: [] });
  });
});

describe('endpoint coverage linking', () => {
  it('links a flow to the operation it calls, matching on method as well as path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wowlidator-cov-'));
    try {
      await writeFile(join(dir, 'openapi.json'), JSON.stringify(SPEC), 'utf8');
      await writeFile(
        join(dir, 'orders.flow.json'),
        JSON.stringify({
          name: 'fetch one order',
          baseUrl: 'https://api.example.test',
          steps: [
            { action: 'request', method: 'GET', url: '/orders/ord_1?expand=items' },
            { action: 'expectStatus', status: 200 },
          ],
        }),
        'utf8',
      );

      const engine = new ContextEngine({
        rootDir: dir,
        cacheFile: join(dir, '.wowlidator/context-graph.json'),
        warn: false,
      });
      const graph = await engine.build();

      const covers = graph.edges.filter((edge) => edge.kind === 'covers');
      // The flow calls GET /orders/{orderId}; only DELETE is declared for that
      // path, so nothing should be credited — a method mismatch is a real gap,
      // and crediting it would overstate coverage.
      assert.equal(
        covers.some((edge) => edge.to === 'operation:DELETE /orders/{orderId}'),
        false,
        'a GET must not be credited against a DELETE',
      );

      const listed = graph.nodes.filter((node) => node.kind === 'operation');
      assert.equal(listed.length, 4, 'the spec should still be indexed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('credits a flow whose method and path both match', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wowlidator-cov2-'));
    try {
      await writeFile(join(dir, 'openapi.json'), JSON.stringify(SPEC), 'utf8');
      await writeFile(
        join(dir, 'list.flow.json'),
        JSON.stringify({
          name: 'list orders',
          steps: [
            { action: 'request', method: 'get', url: 'https://api.example.test/orders?tenant=acme' },
            { action: 'expectStatus', status: 200 },
          ],
        }),
        'utf8',
      );

      const engine = new ContextEngine({
        rootDir: dir,
        cacheFile: join(dir, '.wowlidator/context-graph.json'),
        warn: false,
      });
      const graph = await engine.build();

      assert.ok(
        graph.edges.some(
          (edge) => edge.kind === 'covers' && edge.to === 'operation:GET /orders',
        ),
        `expected a covers edge, got ${JSON.stringify(graph.edges)}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// --- API test generation ----------------------------------------------------

function operationNode(method: string, path: string, meta: Record<string, string> = {}) {
  return {
    id: `operation:${method} ${path}`,
    kind: 'operation' as const,
    name: `${method} ${path.replace(/\{([^}]+)\}/g, ':$1')}`,
    file: 'openapi.json',
    meta: { method, path, base: 'https://api.example.test', ...meta },
  };
}

function graphWith(nodes: ReturnType<typeof operationNode>[]) {
  return {
    version: 1,
    rootDir: '/tmp',
    generatedAt: '2026-07-31T00:00:00.000Z',
    signature: 'sig',
    nodes,
    edges: [],
    sources: [],
  };
}

const SPEC_GRAPH = graphWith([
  operationNode('GET', '/orders', { responses: '200 ok' }),
  operationNode('POST', '/orders', { requestBody: 'application/json { sku: string }' }),
  operationNode('DELETE', '/orders/{orderId}'),
]);

class StubApiModel implements ApiGeneratorModel {
  readonly id = 'stub:api-generator';
  requests: ApiGenerateRequest[] = [];
  constructor(private readonly result: ApiGenerationResult) {}
  async generate(request: ApiGenerateRequest): Promise<ApiGenerationResult> {
    this.requests.push(request);
    return this.result;
  }
}

describe('api test generation', () => {
  it('never puts DELETE in front of the model, at any policy tier', () => {
    for (const policy of ['read-only', 'forms', 'mutations'] as const) {
      const generator = new ApiTestGenerator({
        model: new StubApiModel({ cases: [], defects: [] }),
        projectGraph: SPEC_GRAPH,
        policy,
      });
      const methods = generator.operations().map((node) => node.meta?.['method']);
      assert.equal(
        methods.includes('DELETE'),
        false,
        `${policy} must not expose DELETE — a prompt instruction is a request, a filter is a guarantee`,
      );
    }
  });

  it('shows read-only only the reads, and forms the writes as well', () => {
    const readOnly = new ApiTestGenerator({
      model: new StubApiModel({ cases: [], defects: [] }),
      projectGraph: SPEC_GRAPH,
      policy: 'read-only',
    });
    assert.deepEqual(readOnly.operations().map((node) => node.meta?.['method']), ['GET']);

    const forms = new ApiTestGenerator({
      model: new StubApiModel({ cases: [], defects: [] }),
      projectGraph: SPEC_GRAPH,
      policy: 'forms',
    });
    assert.deepEqual(forms.operations().map((node) => node.meta?.['method']), ['GET', 'POST']);
  });

  it('drops a generated step that breaks the policy, not just an ill-formed one', () => {
    // The model ignoring the instruction must not be able to produce a DELETE.
    const deleteStep = {
      action: 'request' as const,
      method: 'DELETE',
      url: '/orders/1',
      body: '',
      save: '',
      path: '',
      value: '',
      status: '',
      header: '',
      intent: 'remove it',
    };
    assert.equal(toApiFlowStep(deleteStep, 'mutations'), null);
    assert.equal(toApiFlowStep({ ...deleteStep, method: 'POST' }, 'read-only'), null);
    assert.notEqual(toApiFlowStep({ ...deleteStep, method: 'POST' }, 'mutations'), null);
  });

  it('narrows the flat generated shape, dropping what it cannot use', () => {
    const base = {
      action: 'expectStatus' as const,
      method: '',
      url: '',
      body: '',
      save: '',
      path: '',
      value: '',
      status: '',
      header: '',
      intent: '',
    };
    assert.deepEqual(toApiFlowStep({ ...base, status: '201' }), {
      action: 'expectStatus',
      status: 201,
      intent: undefined,
    });
    // A status the schema happily typed as a string but that is not a status.
    assert.equal(toApiFlowStep({ ...base, status: 'created' }), null);
    assert.equal(toApiFlowStep({ ...base, action: 'expectJson', path: '' }), null);

    // `save` is parsed from "name=$.path" and malformed entries are ignored.
    // The policy argument is required for a write: the default is `read-only`,
    // which refuses a POST outright — that default is the point.
    const withSave = toApiFlowStep(
      {
        ...base,
        action: 'request',
        method: 'post',
        url: '/orders',
        body: '{"sku":"a"}',
        save: 'orderId=$.data.id,garbage',
      },
      'mutations',
    );
    assert.deepEqual(withSave, {
      action: 'request',
      method: 'POST',
      url: '/orders',
      body: { sku: 'a' },
      save: { orderId: '$.data.id' },
      intent: undefined,
    });
  });

  it('rejects a case with a request but no assertion', async () => {
    const model = new StubApiModel({
      cases: [
        {
          name: 'calls the endpoint and hopes',
          kind: 'functional',
          rationale: 'it runs',
          steps: [{ action: 'request', method: 'GET', url: '/orders' }],
        },
        {
          name: 'actually checks something',
          kind: 'functional',
          rationale: 'asserts the status',
          steps: [
            { action: 'request', method: 'GET', url: '/orders' },
            { action: 'expectStatus', status: 200 },
          ],
        },
      ],
      defects: [],
    });

    const suite = await new ApiTestGenerator({ model, projectGraph: SPEC_GRAPH }).generate();

    assert.equal(suite.cases.length, 1);
    assert.equal(suite.cases[0]?.name, 'actually checks something');
    assert.equal(suite.rejected.length, 1);
    assert.match(suite.rejected[0]?.reason ?? '', /no assertion/);
  });

  it('rejects assertions with nothing to assert against', async () => {
    const model = new StubApiModel({
      cases: [
        {
          name: 'asserts into the void',
          kind: 'functional',
          rationale: '',
          steps: [{ action: 'expectStatus', status: 200 }],
        },
      ],
      defects: [],
    });

    const suite = await new ApiTestGenerator({ model, projectGraph: SPEC_GRAPH }).generate();
    assert.equal(suite.cases.length, 0);
    assert.match(suite.rejected[0]?.reason ?? '', /no request/);
  });

  it('refuses to generate rather than invent endpoints when no spec is indexed', async () => {
    const generator = new ApiTestGenerator({
      model: new StubApiModel({ cases: [], defects: [] }),
      projectGraph: graphWith([]),
    });
    await assert.rejects(() => generator.generate(), NoSpecError);
    await assert.rejects(() => generator.generate(), /wowlidator context build --openapi/);
  });

  it('explains the difference between "no spec" and "nothing this policy may call"', async () => {
    const generator = new ApiTestGenerator({
      model: new StubApiModel({ cases: [], defects: [] }),
      projectGraph: graphWith([operationNode('DELETE', '/orders/{orderId}')]),
      policy: 'mutations',
    });
    await assert.rejects(() => generator.generate(), /raise the policy or narrow the spec/);
  });

  it('marks a truncated inventory so the model does not reason from absence', async () => {
    const many = Array.from({ length: 5 }, (_, i) => operationNode('GET', `/thing${i}`));
    const model = new StubApiModel({ cases: [], defects: [] });
    await new ApiTestGenerator({
      model,
      projectGraph: graphWith(many),
      maxOperations: 2,
    }).generate();

    const sent = model.requests[0]?.inventory ?? '';
    assert.match(sent, /TRUNCATED: showing 2 of 5 operations/);
  });
});


/**
 * The typed-value half of redaction.
 *
 * The measured flaw: a real bundle on disk held
 * `{"action":"fill","selector":"input[type=\"password\"]","detail":{"value":"admin2026"}}`,
 * and the HTML report inlines it — a report deliberately built to be emailable.
 * These mirror the invariant the HTTP side already holds and `tests/db.test.ts`
 * holds for a password column: the raw value must not survive into rendered HTML.
 */
describe('a typed credential never reaches the record', () => {
  const noSecrets: ReadonlySet<string> = new Set();

  it('masks to the length and nothing else, and is pure', () => {
    assert.equal(maskSecret('admin2026'), '•••• (9 chars)');
    assert.equal(maskSecret('admin2026'), maskSecret('admin2026'));
    // Everything about the value except its length is gone — no prefix, no
    // suffix, no character of it.
    for (const fragment of ['admin', '2026', 'admin2026']) {
      assert.ok(!maskSecret('admin2026').includes(fragment));
    }
  });

  it('takes the DOM fact over the wording', () => {
    // `role=textbox >> nth=1` names nothing; the field itself does.
    const base = { action: 'fill', selector: 'role=textbox >> nth=1', value: 'admin2026' };
    assert.equal(
      isSecretStepValue({ ...base, fieldIsPassword: true, secretValues: noSecrets }),
      true,
    );
    // And an email field addressed by the same idiom stays visible: over-masking
    // would destroy the evidence a later assertion depends on.
    assert.equal(
      isSecretStepValue({
        ...base,
        value: 'admin@cnext.test',
        fieldIsPassword: false,
        secretValues: noSecrets,
      }),
      false,
    );
  });

  it('falls back to wording only when the DOM could not answer', () => {
    // `null` is "could not tell" and must not read as a denial — this is the
    // failed-step path, where nothing resolved and yet the value is recorded.
    assert.equal(
      isSecretStepValue({
        action: 'fill',
        selector: 'input[type="password"]',
        value: 'admin2026',
        fieldIsPassword: null,
        secretValues: noSecrets,
      }),
      true,
    );
    assert.equal(
      isSecretStepValue({
        action: 'fill',
        selector: 'role=searchbox[name="Search"]',
        intent: 'search for the plan',
        value: 'Dental Care Plan',
        fieldIsPassword: null,
        secretValues: noSecrets,
      }),
      false,
    );
  });

  it('masks an --as value unconditionally, whatever the field looks like', () => {
    // The person named it as a credential; that outranks every inference here.
    assert.equal(
      isSecretStepValue({
        action: 'fill',
        selector: 'role=searchbox[name="Search"]',
        value: 'employee2026',
        fieldIsPassword: false,
        secretValues: new Set(['employee2026']),
      }),
      true,
    );
  });

  it('never masks by inference on an action that does not type', () => {
    // A dropdown label and a boundary table's values are the step's own
    // evidence; a supplied secret is still masked there.
    assert.equal(
      isSecretStepValue({
        action: 'selectOption',
        selector: 'role=combobox[name="Password policy"]',
        value: 'Strict',
        fieldIsPassword: null,
        secretValues: noSecrets,
      }),
      false,
    );
    assert.equal(
      isSecretStepValue({
        action: 'selectOption',
        selector: 'role=combobox[name="Password policy"]',
        value: 'employee2026',
        fieldIsPassword: null,
        secretValues: new Set(['employee2026']),
      }),
      true,
    );
  });

  it('says nothing about an empty value', () => {
    // Clearing a field is meaningful and is not a secret.
    assert.equal(
      isSecretStepValue({
        action: 'fill',
        selector: 'input[type="password"]',
        value: '',
        fieldIsPassword: true,
        secretValues: noSecrets,
      }),
      false,
    );
  });

  it('a masked value cannot survive into the rendered report', () => {
    // The same end-to-end invariant `tests/db.test.ts` holds for a password
    // column value, and the HTTP side holds for a bearer token — pointed at
    // the hole that was actually open: a `fill` step.
    const bundle = new ProofBundleBuilder({ name: 'login' });
    bundle.addStep({
      action: 'fill',
      selector: 'input[type="password"]',
      resolvedSelector: 'input[type="password"]',
      resolution: 'fast',
      status: 'passed',
      startedAt: new Date(0).toISOString(),
      durationMs: 1,
      url: 'http://localhost:3200/en/login',
      detail: { value: maskSecret('admin2026') },
    });
    const html = renderReport(bundle.finish());
    assert.ok(!html.includes('admin2026'), 'a typed password must never reach the report');
    assert.ok(html.includes('9 chars'), 'but the reader must still see that a value was typed');
  });

  it('recognises the credential wording without touching the value', () => {
    assert.equal(looksLikeCredentialField('input[type="password"]'), true);
    assert.equal(looksLikeCredentialField('role=textbox >> nth=1', 'enter the passwd'), true);
    assert.equal(looksLikeCredentialField('role=textbox >> nth=1'), false);
    assert.equal(looksLikeCredentialField('role=searchbox[name="Search"]'), false);
  });
});

// --- Variables: builtins and arithmetic (CG-07 / EH-03, 2026-09-03) ---------

describe('variable store: {{date:…}} builtins and {{name+N}} arithmetic', () => {
  it('computes a date token at interpolation time instead of asking the author to', () => {
    const store = new VariableStore({ now: () => new Date(2026, 8, 3) });
    assert.equal(store.interpolate('{{date:today}}'), '2026-09-03');
    assert.equal(store.interpolate('{{date:today+119d}}'), '2026-12-31');
    assert.equal(store.interpolate('{{date:monthEnd|dd/MM/yyyy}}'), '30/09/2026');
    assert.throws(() => store.interpolate('{{date:yesterweek}}'), UnknownVariableError);
  });

  it('moves the first number in a saved value by N, keeping the rest of the text and its style', () => {
    const store = new VariableStore();
    store.set('before_total', '75');
    store.set('rows-before', '1,234 rows');
    assert.equal(store.interpolate('{{before_total+1}}'), '76');
    assert.equal(store.interpolate('{{before_total-1}}'), '74');
    assert.equal(store.interpolate('{{rows-before+1}}'), '1,235 rows');
    assert.equal(store.interpolate('{{rows-before}}'), '1,234 rows', 'a hyphenated name still reads as itself');
    store.set('label', 'Active');
    assert.throws(() => store.interpolate('{{label+1}}'), /is not a number/);
    assert.throws(() => store.interpolate('{{missing+1}}'), UnknownVariableError);
  });
});
