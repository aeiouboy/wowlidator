/**
 * The API actions themselves, factored out of `SmartRunner`.
 *
 * They live here rather than on the runner because they are the one group of
 * actions that does not need a browser at all. `SmartRunner` delegates to this
 * class for mixed UI+API flows; `runApiFlow` uses it directly for flows that
 * never open Chrome. One implementation, two callers — the alternative was a
 * second copy of the same request/save/assert logic that would drift.
 *
 * Nothing here touches `Page`. That constraint is the whole point, so keep it:
 * if a capability added here needs the page, it belongs on the runner instead.
 */

import type { ProofBundleBuilder } from '../engine/proof-bundle.js';
import type { DefectCategory, DefectSeverity } from '../engine/proof-bundle.js';
import { parseJson, recordOf, type ApiRequestSpec, type ApiResponse, type ApiTransport } from './api-client.js';
import type { RedactionPolicy } from './redact.js';
import { UnknownVariableError, VariableStore, extractPath, stringifyExtracted } from './variables.js';

/**
 * An assertion ran before any `request` step — a flow-ordering fault, not a
 * response the application gave. Its own class (matched by name in the
 * runner's `classifyStepFailure`, like `DbUnavailableError`) so the step
 * scores `error`, never `failed`: the application was never contacted, and a
 * backend defect about it sent a reader hunting an endpoint no one called.
 */
export class NoResponseError extends Error {
  override readonly name = 'NoResponseError';
}

/**
 * The endpoint exists and refused the METHOD — 405, or 501 for a method it
 * does not implement. A fault of the flow's own making, in the same family as
 * `UnknownVariableError`: it says the test asked the wrong way, never that
 * the application is wrong.
 *
 * Live (be100 PL_03_03, 2026-08-25): `GET /api/benefit-plans` against a
 * handler exporting POST, PUT and DELETE only. The run filed a `high`
 * `backend` defect and a `high` `functional` one, and the case was scored a
 * failure — against an application answering exactly as written. The prose
 * was already right ("check the spec before filing one"); it lived inside the
 * error message, where no verdict could read it. As a NAME it reaches
 * `classifyStepFailure` (scored `error`, so `harnessOnly` records the case
 * blocked — no verdict — rather than a defect) and the reconstruction guard
 * (no rewrite of the step can give a handler a method it does not export).
 *
 * The authoring lint `unindexedRequestMethod` is the other half: with the
 * repository's operations indexed, this shape is refused before it ever runs.
 */
export class MethodRefusedError extends Error {
  override readonly name = 'MethodRefusedError';
}

/** Whether a status is a method-level refusal: the endpoint is there, the verb is not. */
export function methodRefused(status: number): boolean {
  return status === 405 || status === 501;
}

/** A `request` step's parameters, as authored in a `.flow.json`. */
export interface FlowRequestSpec {
  method: string;
  /** Relative urls resolve against `Flow.baseUrl`, same as `goto`. */
  url: string;
  headers?: Record<string, string> | undefined;
  /** An object is JSON-encoded; a string is sent verbatim. */
  body?: unknown;
  /** `{ orderId: '$.data.id' }` — variable name to JSON path. */
  save?: Record<string, string> | undefined;
  timeoutMs?: number | undefined;
  /** Loosen redaction for this call only, e.g. to record a public response. */
  redaction?: RedactionPolicy | undefined;
  intent?: string | undefined;
  /**
   * Set by the flow executor from `Flow.baseUrl`.
   *
   * Resolved *after* interpolation, not before: `new URL()` percent-encodes
   * `{{orderId}}` into `%7B%7BorderId%7D%7D`, so resolving first turns every
   * placeholder in a relative url into literal garbage that reaches the server.
   */
  baseUrl?: string | undefined;
}

export interface ApiActionsOptions {
  transport: ApiTransport;
  bundle: ProofBundleBuilder;
  /**
   * The run's variable store. Injected when the run has more than one action
   * family saving and reading `{{name}}`s — a `request` step saves `orderId`
   * and an `expectDbRow` keys on it, which only works if both families hold
   * the same store. Omitted, a private one is created (the original
   * behaviour, kept for embedders and tests).
   */
  variables?: VariableStore | undefined;
  redaction?: RedactionPolicy | undefined;
  /** The page's url, when there is a page. Recorded on each step. */
  currentUrl?: (() => string | null) | undefined;
  /** Report a defect through the owner's numbering, so ids stay unique. */
  recordDefect?:
    | ((category: DefectCategory, severity: DefectSeverity, title: string, detail: string) => void)
    | undefined;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message;
  return String(error);
}

/**
 * Resolve a step's URL against the flow's `baseUrl`, keeping the
 * deployment's base path under an absolute path. Shared with the engine's
 * `goto` (2026-09-05 smoke: an authored `goto /th/admin/hire` under
 * `https://h/humi` resolved to the gateway's 404, the same drop this fixed
 * for request steps the same day).
 */
export function resolveUrl(url: string, baseUrl: string | undefined): string {
  if (!baseUrl) return url;
  try {
    const base = new URL(baseUrl);
    const basePath = base.pathname.replace(/\/+$/, '');
    // A base URL that carries the deployment's path (`https://h/humi`) must
    // keep it under an absolute-path request (`/api/x` → `/humi/api/x`):
    // `new URL('/api/x', 'https://h/humi')` would drop it and ask the
    // gateway instead of the application. A request that already starts
    // with the base path, or is absolute, is left alone.
    if (basePath !== '' && url.startsWith('/') && !url.startsWith(`${basePath}/`) && url !== basePath) {
      return new URL(`${basePath}${url}`, base.origin).toString();
    }
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

export class ApiActions {
  /** Values saved by `request` steps, for `{{name}}` interpolation later. */
  readonly variables: VariableStore;

  #transport: ApiTransport;
  readonly #bundle: ProofBundleBuilder;
  readonly #redaction: RedactionPolicy;
  readonly #currentUrl: () => string | null;
  readonly #recordDefect: (
    category: DefectCategory,
    severity: DefectSeverity,
    title: string,
    detail: string,
  ) => void;

  /** The most recent response — what `expectStatus`/`expectJson` assert against. */
  #lastResponse: ApiResponse | null = null;

  /**
   * Swap the transport — a browser transport is bound to one context's
   * cookie jar, and a run that switches persona (one Chrome per person) must
   * send its next `request` as the person now active, not the first one.
   */
  setTransport(transport: ApiTransport): void {
    this.#transport = transport;
  }

  constructor(options: ApiActionsOptions) {
    this.variables = options.variables ?? new VariableStore();
    this.#transport = options.transport;
    this.#bundle = options.bundle;
    this.#redaction = options.redaction ?? {};
    this.#currentUrl = options.currentUrl ?? (() => null);
    this.#recordDefect = options.recordDefect ?? (() => undefined);
  }

  get lastResponse(): ApiResponse | null {
    return this.#lastResponse;
  }

  /**
   * Make an HTTP call as part of the flow.
   *
   * **A non-2xx does not fail this step.** The status is a result to assert on
   * with `expectStatus`, not an exception — otherwise no test could exercise
   * an error path, and negative testing at the `forms`/`mutations` tiers would
   * be impossible. Only a call that never produced a response at all
   * (connection refused, timeout) fails here.
   */
  async request(spec: FlowRequestSpec): Promise<void> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const intent = spec.intent;
    const redaction = spec.redaction ?? this.#redaction;

    let sent: ApiRequestSpec;
    try {
      sent = this.#buildRequest(spec);
    } catch (error) {
      // An unknown {{variable}} or an unserialisable body — fail at the point
      // of use, naming the thing that's missing.
      const message = describe(error);
      this.#record('request', intent, startedAt, started, {
        status: 'failed',
        detail: { method: spec.method, url: spec.url, intent },
        error: message,
      });
      this.#recordDefect('functional', 'high', 'Step failed: request', message);
      throw new Error(message);
    }

    let response: ApiResponse;
    try {
      response = await this.#transport.send(sent);
    } catch (error) {
      const message = describe(error);
      this.#record('request', intent, startedAt, started, {
        status: 'failed',
        detail: { method: sent.method, url: sent.url, intent },
        request: recordOf(sent, null, { redaction, error: message }),
        error: message,
      });
      this.#recordDefect(
        'backend',
        'high',
        `Request never completed: ${sent.method} ${sent.url}`,
        message,
      );
      throw new Error(message);
    }

    this.#lastResponse = response;

    // Extraction happens after the call and can fail it: a test that asked to
    // save `$.id` and got a body without one is broken *here*, not three steps
    // later where the missing value would surface as a mangled URL.
    const saved: string[] = [];
    let saveError: string | undefined;
    if (spec.save) {
      const parsed = parseJson(response.body);
      for (const [name, path] of Object.entries(spec.save)) {
        const value = parsed === undefined ? undefined : extractPath(parsed, path);
        if (value === undefined) {
          saveError =
            `could not save {{${name}}}: "${path}" did not resolve in the response body ` +
            `(status ${response.status}, ${response.sizeBytes} bytes)`;
          // A refused request cannot carry the body the save expects, so the
          // missing path is a consequence, not the finding — seen live as a
          // 405 with 0 bytes filed as "response did not contain what the test
          // needed", which sent a reader into the body of a response that was
          // never going to have one.
          if (response.status >= 400) {
            saveError +=
              ` — the request itself was refused (${response.status} ${response.statusText}); ` +
              'the missing path is a consequence of that, not a finding about the body';
          }
          break;
        }
        this.variables.set(name, stringifyExtracted(value));
        saved.push(name);
      }
    }

    // A method the endpoint does not offer is named as such in the RECORD
    // too, not only in what is thrown: the record is what the report and the
    // reader see, and "the response did not contain $.count" sends them into
    // a body that was never going to have one.
    const methodDrift = saveError !== undefined && methodRefused(response.status);
    if (methodDrift) {
      saveError =
        `${sent.method} ${sent.url} — the endpoint refused the method ` +
        `(${response.status} ${response.statusText}); it exists but does not answer ${sent.method}. ` +
        "This is the test's own method drifting from the endpoint, not a finding about the " +
        `application. ${saveError}`;
    }

    this.#record('request', intent, startedAt, started, {
      status: saveError ? 'failed' : 'passed',
      detail: { method: sent.method, url: sent.url, status: response.status, intent },
      request: recordOf(sent, response, { redaction, saved, error: saveError }),
      error: saveError,
    });

    if (saveError) {
      // A method the endpoint does not offer files no defect against anyone:
      // the body the save wanted was never going to exist, and the reason is
      // the request's own verb. Same rule as `UnknownVariableError` below in
      // `#assert` — the step still fails loudly, and scores `error`.
      if (methodDrift) throw new MethodRefusedError(saveError);
      this.#recordDefect(
        'functional',
        'high',
        `Response did not contain what the test needed: ${sent.method} ${sent.url}`,
        saveError,
      );
      throw new Error(saveError);
    }
  }

  /** Assert the last response's status. Accepts one status or a set of them. */
  async expectStatus(expected: number | readonly number[], intent?: string): Promise<void> {
    const allowed = typeof expected === 'number' ? [expected] : [...expected];
    const detail: Record<string, unknown> = { expected: allowed, intent };
    await this.#assert('expectStatus', detail, intent, () => {
      const response = this.#requireResponse('expectStatus');
      detail['actual'] = `${response.status} ${response.statusText}`.trim();
      if (!allowed.includes(response.status)) {
        // 405/501 are method-level refusals: the endpoint exists but was asked
        // the wrong way, which in practice is the TEST's own method drifting
        // from the spec, not a backend defect. Measured live (BE catalogs,
        // 2026-08-24): every 405 seen at this step was an authored method the
        // API never offered, filed as a backend failure. The claim still
        // fails — a wrong status is a wrong status — but the message says
        // where to look first.
        // Typed, not merely worded (2026-08-25): as prose inside the message
        // this reached a reader and no verdict, and PL_03_03 filed the
        // `backend`/`high` defect anyway. `MethodRefusedError` is rethrown by
        // `#assert` before any defect is recorded.
        if (methodRefused(response.status)) {
          throw new MethodRefusedError(
            `expected status ${allowed.join(' or ')}, got ${response.status} ${response.statusText}` +
              ' — a method-level refusal means the request\'s own method is wrong (test drift from the ' +
              'endpoint\'s spec), not a backend defect; the endpoint exists and does not answer this verb',
          );
        }
        throw new Error(
          `expected status ${allowed.join(' or ')}, got ${response.status} ${response.statusText}`,
        );
      }
    });
  }

  /**
   * Assert something about the last response's JSON body.
   *
   * `value` checks equality; omitting it checks only that the path resolves —
   * useful for a server-assigned id whose exact value is unknowable.
   */
  async expectJson(
    path: string,
    options: { value?: string | undefined; intent?: string | undefined } = {},
  ): Promise<void> {
    const detail: Record<string, unknown> = { path, expected: options.value, intent: options.intent };
    await this.#assert(
      'expectJson',
      detail,
      options.intent,
      () => {
        const response = this.#requireResponse('expectJson');
        const parsed = parseJson(response.body);
        if (parsed === undefined) {
          throw new Error(`response body is not JSON (status ${response.status})`);
        }
        const actual = extractPath(parsed, path);
        if (actual === undefined) {
          detail['actual'] = '(path did not resolve)';
          throw new Error(`"${path}" did not resolve in the response body`);
        }
        detail['actual'] = stringifyExtracted(actual);
        if (options.value === undefined) detail['expected'] = `"${path}" resolves`;
        if (options.value !== undefined) {
          const rendered = stringifyExtracted(actual);
          const expected = this.variables.interpolate(options.value);
          if (rendered !== expected) {
            throw new Error(
              `expected "${path}" to be ${JSON.stringify(expected)}, got ${JSON.stringify(rendered)}`,
            );
          }
        }
      },
    );
  }

  /** Assert a response header. Names are compared case-insensitively. */
  async expectHeader(name: string, value: string, intent?: string): Promise<void> {
    const detail: Record<string, unknown> = { header: name, expected: value, intent };
    await this.#assert('expectHeader', detail, intent, () => {
      const response = this.#requireResponse('expectHeader');
      const actual = response.headers[name.toLowerCase()];
      const expected = this.variables.interpolate(value);
      detail['actual'] = actual ?? '(header absent)';
      if (actual === undefined) throw new Error(`response has no ${name} header`);
      if (actual !== expected) {
        throw new Error(
          `expected ${name} to be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        );
      }
    });
  }

  #requireResponse(action: string): ApiResponse {
    if (!this.#lastResponse) {
      throw new NoResponseError(
        `${action} has nothing to assert against — no request step has run yet`,
      );
    }
    return this.#lastResponse;
  }

  /** Interpolate and serialise a flow's request spec into a transport call. */
  #buildRequest(spec: FlowRequestSpec): ApiRequestSpec {
    const headers = this.variables.interpolateDeep({ ...(spec.headers ?? {}) });
    let body: string | undefined;

    if (typeof spec.body === 'string') {
      body = this.variables.interpolate(spec.body);
    } else if (spec.body !== undefined && spec.body !== null) {
      body = JSON.stringify(this.variables.interpolateDeep(spec.body));
      // Only defaulted, never overridden — an author who set their own content
      // type meant it.
      if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json';
      }
    }

    return {
      method: spec.method.toUpperCase(),
      url: resolveUrl(this.variables.interpolate(spec.url), spec.baseUrl),
      headers,
      body,
      timeoutMs: spec.timeoutMs,
    };
  }

  /**
   * Run an assertion and record it.
   *
   * These have no selector, so — exactly like `expectUrl` and the storage
   * actions — there is nothing the healer could repair and no reason to walk
   * the escalation ladder.
   */
  async #assert(
    action: string,
    detail: Record<string, unknown>,
    intent: string | undefined,
    check: () => void,
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    try {
      check();
      this.#record(action, intent, startedAt, started, { status: 'passed', detail });
    } catch (error) {
      const message = describe(error);
      this.#record(action, intent, startedAt, started, {
        status: 'failed',
        detail,
        error: message,
      });
      // A fault of the FLOW's own making files no defect against anyone: an
      // unknown {{variable}} (nothing saved it) and an assertion with no
      // request before it say nothing about the endpoint — measured live as
      // `backend`/`high` defects that sent readers hunting an API the run
      // never reached. The step still fails loudly; the runner's
      // `classifyStepFailure` scores both `error` by name.
      if (
        error instanceof UnknownVariableError ||
        error instanceof NoResponseError ||
        error instanceof MethodRefusedError
      ) {
        throw error;
      }
      // `backend`, not `functional`: there is no selector, no page, and
      // nothing a test author can repair — a failed HTTP assertion routes to
      // whoever owns the endpoint. It is also what keeps the proof bundle's
      // frontend/backend defect split honest.
      this.#recordDefect('backend', 'high', `Assertion failed: ${action}`, message);
      throw error;
    }
  }

  #record(
    action: string,
    intent: string | undefined,
    startedAt: string,
    started: number,
    fields: {
      status: 'passed' | 'failed';
      detail?: Record<string, unknown> | undefined;
      request?: ReturnType<typeof recordOf> | undefined;
      error?: string | undefined;
    },
  ): void {
    this.#bundle.addStep({
      action,
      intent,
      selector: null,
      resolvedSelector: null,
      // Null, not 'fast'. These steps are free, but `fastPath` counts selector
      // resolutions on a page, and an HTTP call resolved nothing — crediting
      // it would put backend work inside a frontend number. Same rule that
      // already gives `goto` and `workflow` a null resolution.
      resolution: null,
      status: fields.status,
      startedAt,
      durationMs: Date.now() - started,
      url: this.#currentUrl(),
      detail: fields.detail,
      request: fields.request,
      error: fields.error,
    });
  }
}
