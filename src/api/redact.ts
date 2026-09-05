/**
 * Redaction for anything that reaches a proof bundle carrying a secret.
 *
 * This is load-bearing, not a nicety. The HTML report is deliberately
 * self-contained — inline CSS, inline JS, screenshots as `data:` URIs, "opens
 * off a USB stick" — which is exactly what makes it easy to email, attach to a
 * ticket, or drop in a shared drive. A `request` step can carry a session
 * cookie, a bearer token, and a password in a login body all in one step, and
 * a `fill` step carries whatever the flow typed. So the default is redact, and
 * revealing anything is per-request and explicit.
 *
 * **The typed-value half was missing until 2026-08-18, and the omission was
 * the wider of the two.** This module was written for `src/api/`'s HTTP
 * payloads, and an earlier version of this comment claimed that before it
 * "nothing that landed in a bundle could carry a credential" — false for as
 * long as `fill` has existed. Measured on a real bundle on disk:
 * `{"action":"fill","selector":"input[type=\"password\"]","detail":{"value":"admin2026"}}`.
 * Every login flow wrote its password to `.wowlidator/proofs/<runId>.json` and
 * into the emailable report. `maskSecret` / `looksLikeCredentialField` below
 * are that half; the runner applies them at the same recording boundary.
 *
 * **Screenshots and video are out of scope, and no redaction here changes
 * that.** A password typed into a field that does not mask it on screen is in
 * the frame and in the recording. `--video off` and `--screenshots off` are the
 * only controls for that; saying so is better than implying a guarantee this
 * module cannot give.
 *
 * The rule that keeps it honest: **never emit a payload we could not inspect.**
 * An opaque body (not JSON, not form-encoded) is replaced with a description of
 * its size and type rather than passed through, because "we didn't recognise
 * the format" is not evidence that it holds no secret.
 */

export const REDACTED = '[redacted]';

/**
 * Headers whose value is a credential essentially by definition.
 *
 * Compared case-insensitively — HTTP header names are case-insensitive, and
 * CDP reports them however the page happened to send them.
 */
export const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-amz-security-token',
  'x-goog-api-key',
]);

/**
 * Body/query keys whose *value* is masked.
 *
 * Matched case-insensitively as a substring, so `newPassword`, `api_key` and
 * `accessToken` are all covered without enumerating every casing convention.
 */
const SENSITIVE_KEY_PATTERNS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'credential',
  'private_key',
  'privatekey',
  'session',
  'ssn',
  'creditcard',
  'credit_card',
  'cardnumber',
  'card_number',
  'cvv',
  'pin',
];

/** How much of a payload to keep. */
export interface RedactionPolicy {
  /** `redact` masks known credential headers; `all` masks every header value. */
  headers?: 'redact' | 'all' | undefined;
  /**
   * `keys` — mask sensitive keys inside a recognised body, omit unrecognised
   * bodies entirely. `off` — record no body at all. `full` — record verbatim,
   * for a request the author has explicitly marked as carrying nothing secret.
   */
  body?: 'keys' | 'off' | 'full' | undefined;
  /** Header names to pass through untouched despite the rules above. */
  reveal?: readonly string[] | undefined;
  /** Bodies longer than this are truncated with a marker. */
  maxBodyChars?: number | undefined;
}

/**
 * Spelled out rather than derived with `Required<RedactionPolicy>`: the policy
 * fields are declared `?: T | undefined` because `exactOptionalPropertyTypes`
 * is on, and `Required` only strips the `?` — the `| undefined` survives, so
 * every read of a "required" default would still be possibly-undefined.
 */
interface ResolvedRedaction {
  headers: 'redact' | 'all';
  body: 'keys' | 'off' | 'full';
  reveal: readonly string[];
  maxBodyChars: number;
}

export const DEFAULT_REDACTION: ResolvedRedaction = {
  headers: 'redact',
  body: 'keys',
  reveal: [],
  maxBodyChars: 2_000,
};

/**
 * Both sides are normalised the same way — separators stripped — so that
 * `api_key`, `api-key`, `apiKey` and `API KEY` all match the one pattern.
 * Normalising only the pattern (as an earlier version did) meant `api_key`
 * silently failed to match `apikey` and shipped a live key into a report.
 */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, '');
}

/**
 * Exported for the consumers that redact *non*-HTTP payloads on the same rule
 * — a database row's column names (`src/db/redact-row.ts`) carry credentials
 * exactly as often as a body's keys do, and a second heuristic would drift.
 */
export function isSensitiveKey(key: string): boolean {
  const normalised = normaliseKey(key);
  return SENSITIVE_KEY_PATTERNS.some((pattern) => normalised.includes(normaliseKey(pattern)));
}

/** Mask credential headers. Header *names* are always kept — they're evidence. */
export function redactHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  policy: RedactionPolicy = {},
): Record<string, string> {
  if (!headers) return {};
  const mode = policy.headers ?? DEFAULT_REDACTION.headers;
  const reveal = new Set((policy.reveal ?? []).map((name) => name.toLowerCase()));

  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (reveal.has(lower)) {
      out[name] = value;
      continue;
    }
    out[name] = mode === 'all' || SENSITIVE_HEADERS.has(lower) ? REDACTED : value;
  }
  return out;
}

/** Recursively mask sensitive keys in a parsed JSON value. */
function redactJson(value: unknown, depth = 0): unknown {
  if (depth > 12) return value; // pathological nesting isn't worth walking
  if (Array.isArray(value)) return value.map((item) => redactJson(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redactJson(inner, depth + 1);
    }
    return out;
  }
  return value;
}

function redactForm(body: string): string {
  const params = body.split('&').map((pair) => {
    const index = pair.indexOf('=');
    if (index < 0) return pair;
    const key = pair.slice(0, index);
    return isSensitiveKey(decodeURIComponent(key)) ? `${key}=${REDACTED}` : pair;
  });
  return params.join('&');
}

function looksLikeForm(body: string): boolean {
  return /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(body.trim());
}

/**
 * Redact a request or response body.
 *
 * Returns `undefined` when nothing should be recorded, so callers can leave the
 * field off the record entirely rather than storing an empty string that reads
 * like "the body was empty".
 */
export function redactBody(
  body: string | undefined,
  policy: RedactionPolicy = {},
): string | undefined {
  if (body === undefined || body === '') return undefined;
  const mode = policy.body ?? DEFAULT_REDACTION.body;
  if (mode === 'off') return undefined;

  const max = policy.maxBodyChars ?? DEFAULT_REDACTION.maxBodyChars;
  if (mode === 'full') return truncate(body, max);

  // 'keys' — we will only emit something we were able to parse and inspect.
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return truncate(JSON.stringify(redactJson(JSON.parse(trimmed)), null, 2), max);
    } catch {
      return `[body omitted: ${byteLength(body)} bytes of malformed JSON]`;
    }
  }
  if (looksLikeForm(trimmed)) return truncate(redactForm(trimmed), max);

  return `[body omitted: ${byteLength(body)} bytes, unrecognised format]`;
}

/** Mask sensitive query-string values in a URL, keeping the shape readable. */
export function redactUrl(url: string): string {
  const split = url.indexOf('?');
  if (split < 0) return url;
  const query = url.slice(split + 1);
  const hashAt = query.indexOf('#');
  const search = hashAt < 0 ? query : query.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : query.slice(hashAt);
  return `${url.slice(0, split)}?${redactForm(search)}${hash}`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated, ${text.length} chars total]`;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

// --- Typed values -----------------------------------------------------------

/**
 * What a masked value looks like in a record.
 *
 * Mask, never drop. A reader still needs to know that a value was typed and
 * roughly what shape it had — the same compromise `redactBody` makes when it
 * replaces an unrecognised body with its size and type rather than removing
 * the field. A step whose `value` simply vanished reads like a step that
 * typed nothing.
 */
export const SECRET_MASK = '••••';

/** Pure: the mask plus the length, and nothing else about the value. */
export function maskSecret(value: string): string {
  return `${SECRET_MASK} (${value.length} chars)`;
}

/**
 * Does this step look like it is typing a credential, judged from the step
 * rather than from the value?
 *
 * The **fallback** only. The reliable evidence is the field's own
 * `type="password"`, which is a fact about the document; this is what remains
 * when the DOM cannot answer — most often because the step failed to resolve
 * at all, where the value was never typed anywhere and yet is still recorded.
 *
 * Deliberately narrower than the authoring-side `isCredentialFill`, which also
 * treats the taught `role=textbox >> nth=N` idiom as credential-shaped. That
 * idiom addresses *any* nameless textbox — `nth=0` is the email field in the
 * very same login form — so masking on it would destroy exactly the evidence a
 * later assertion depends on (this codebase's own rule: identify a record by a
 * value the flow typed). The real password behind that idiom is caught by the
 * `type="password"` read, and a credential the person supplied through `--as`
 * is masked unconditionally wherever it lands, so the narrow form loses
 * nothing that matters.
 */
export function looksLikeCredentialField(selector: string, intent?: string): boolean {
  return /password|passwd|pwd/i.test(`${selector} ${intent ?? ''}`);
}

/** Everything the masking decision needs, and nothing it can look up itself. */
export interface StepValueContext {
  action: string;
  selector: string;
  intent?: string | undefined;
  value: string;
  /**
   * Did the resolved field report `type="password"`? `null` means the DOM
   * could not answer — gone, detached, not an input, or the read threw — and
   * is deliberately distinct from `false`, so silence falls back to the
   * wording heuristic instead of being read as a denial.
   */
  fieldIsPassword: boolean | null;
  /** Values the person named as secret via `--as`. Exact-match, never substring. */
  secretValues: ReadonlySet<string>;
}

/**
 * Should this typed value be masked in the record?
 *
 * Pure, so the whole decision is testable without a browser; the runner does
 * the one DOM read and hands the answer in. Evidence first, wording second:
 *
 *   1. a value the person supplied through `--as` — unconditional, any field,
 *      any action. Their statement outranks anything inferred here.
 *   2. the field's own `type="password"` — a fact about the document.
 *   3. `looksLikeCredentialField` — the fallback for when the DOM cannot
 *      answer, which is most often a step that never resolved and whose value
 *      was therefore typed nowhere, yet is still written to the record.
 *
 * Rules 2 and 3 apply only to the actions that type into a field. A
 * `selectOption` value is a visible dropdown label, and a boundary table's
 * values are the step's own evidence — masking either would destroy what the
 * record exists to show.
 */
export function isSecretStepValue(context: StepValueContext): boolean {
  if (context.value === '') return false;
  if (context.secretValues.has(context.value)) return true;
  if (context.action !== 'fill' && context.action !== 'type' && context.action !== 'paste') return false;
  return (
    context.fieldIsPassword ?? looksLikeCredentialField(context.selector, context.intent)
  );
}
