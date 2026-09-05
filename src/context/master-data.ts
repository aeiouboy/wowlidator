/**
 * Master-data grounding, first rung: does the CODE a test-case sheet names
 * exist in the application's own master, is it free, and can a person reach
 * it in the UI's picker?
 *
 * A sheet gives entity codes (a position, a company, a cost centre); the UI
 * picker shows NAMES, and a picker over a large master may load only its
 * first page and search client-side within it. Measured on one application
 * (2026-09-05): a picker loaded 500 of 5,364 rows and searched by name; 29 of
 * a sheet's 100 codes — 151 rows — were unreachable although every one of
 * them existed and was vacant. A run authored from those rows fails at the
 * picker, and the failure reads like a selector problem. This module answers
 * the question BEFORE anything is authored, from a declared lookup and the
 * application's own list endpoint.
 *
 * Read-only by design. Nothing here authors, blocks, or mutates: `groundCodes`
 * is pure, the fetcher only GETs, and the command that wires them prints a
 * report and exits 0. Every fetched page is data — read through JSON paths,
 * compared as strings, never interpreted as an instruction.
 *
 * The declaration is a persisted artifact and is PARSED, never asserted
 * (`MASTER_DATA_DECLARATION_SCHEMA`): a missing `code` path is refused with the
 * path named, and descriptive fields an older file never carried pass through.
 * No application literal lives here — examples belong in tests/fixtures.
 */

import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import type { ApiTransport } from '../api/api-client.js';
import { parseJson } from '../api/api-client.js';

// --- the declaration -------------------------------------------------------------

/**
 * One lookup: which Test Data fields it grounds, where the master's list
 * endpoint is, and how to read a row of it.
 */
export const MASTER_DATA_LOOKUP_SCHEMA = z.object({
  /** Test Data field names this lookup grounds, e.g. `['Position', 'Position Code']`. Matched with spacing and case ignored. */
  field: z.array(z.string().min(1)).min(1),
  /**
   * Path template, resolved against the app URL. `{Name}` tokens are bound
   * from the same row's Test Data pairs (`{Company}` ← `Company = …`); `{page}`
   * is the 1-based page number.
   */
  url: z.string().min(1),
  /** JSON path to the row array in one page, e.g. `data.rows`. Empty = the response itself. */
  rows: z.string(),
  /** JSON path to a has-next-page boolean. Absent: one page only. */
  next: z.string().min(1).optional(),
  /** JSON path in a row to the code the sheet names. */
  code: z.string().min(1),
  /** JSON path in a row to the display label; may carry a locale key (`name.en`). */
  label: z.string().min(1),
  /** Row JSON paths to report beside each code, e.g. `vacant`, `headcount`. */
  facts: z.array(z.string().min(1)).optional(),
  /**
   * The fact whose truthy value means one use of the row consumes it (a vacant
   * position is filled by one hire). A code with it true and wanted by two or
   * more rows is contended: the second row finds it gone.
   */
  consumable: z.string().min(1).optional(),
  /** How many rows the UI picker loads. Given, `reachable` = index < uiPageSize in page-1 order. */
  uiPageSize: z.number().int().positive().optional(),
});

export const MASTER_DATA_DECLARATION_SCHEMA = z.array(MASTER_DATA_LOOKUP_SCHEMA).min(1);

export type MasterDataLookup = z.infer<typeof MASTER_DATA_LOOKUP_SCHEMA>;

/**
 * Parse a declaration read from disk. The reason names the first issue's
 * path (`lookups[1].code: …`) so a person can find the line.
 */
export function parseMasterDataDeclaration(
  raw: unknown,
): { ok: true; lookups: MasterDataLookup[] } | { ok: false; reason: string } {
  const result = MASTER_DATA_DECLARATION_SCHEMA.safeParse(raw);
  if (result.success) return { ok: true, lookups: result.data };
  const issue = result.error.issues[0];
  if (issue === undefined) return { ok: false, reason: 'not a master-data declaration' };
  return { ok: false, reason: `${describeIssuePath(issue.path)}: ${issue.message}` };
}

function describeIssuePath(path: readonly PropertyKey[]): string {
  let text = 'lookups';
  for (const segment of path) {
    text += typeof segment === 'number' ? `[${segment}]` : `.${String(segment)}`;
  }
  return text;
}

/**
 * Read and parse a declaration file. Throws an error naming the file and the
 * first issue — the typed unavailable result of a reader at the file seam.
 */
export async function readMasterDataDeclaration(path: string): Promise<MasterDataLookup[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`cannot read master-data declaration ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`master-data declaration ${path} is not JSON`);
  }
  const parsed = parseMasterDataDeclaration(raw);
  if (!parsed.ok) throw new Error(`master-data declaration ${path}: ${parsed.reason}`);
  return parsed.lookups;
}

// --- JSON paths ------------------------------------------------------------------

/**
 * Read a dotted path (`data.rows`, `items[0].code`, `name.en`) out of a
 * value. Undefined when any segment is missing; the empty path is the value.
 */
export function readPath(value: unknown, path: string): unknown {
  if (path.trim() === '') return value;
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (segment === '') continue;
    const indexed = /^([^[\]]*)((?:\[\d+\])+)$/.exec(segment);
    const name = indexed === null ? segment : indexed[1]!;
    if (name !== '') {
      if (current === null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[name];
    }
    if (indexed !== null) {
      for (const match of indexed[2]!.matchAll(/\[(\d+)\]/g)) {
        if (!Array.isArray(current)) return undefined;
        current = current[Number(match[1])];
      }
    }
  }
  return current;
}

/**
 * A row's label at the declared path. A string is itself; a number is
 * printed; an object (a locale map the path did not descend into) yields its
 * first string value, so `label: 'name'` over `{en:'A', de:'B'}` still shows
 * something a person can match against the picker.
 */
export function labelAt(row: unknown, path: string): string | undefined {
  const value = readPath(row, path);
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const inner of Object.values(value as Record<string, unknown>)) {
      if (typeof inner === 'string') return inner;
    }
  }
  return undefined;
}

/** A code as a comparable string: trimmed, numbers printed. */
export function codeText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return undefined;
}

// --- grounding (pure) -----------------------------------------------------------

export interface GroundedCode {
  code: string;
  found: boolean;
  label?: string | undefined;
  /** The declared facts, by their path, for a found code. */
  facts?: Record<string, unknown> | undefined;
  /** Position in page-1 order across every fetched page, 0-based. */
  index?: number | undefined;
  /** Only when the lookup declares `uiPageSize`. */
  reachable?: boolean | undefined;
  /** How many wanted entries named this code. */
  sharedBy: number;
  /** The `consumable` fact read as a boolean, when declared and found. */
  consumable?: boolean | undefined;
}

/**
 * Ground the codes a sheet wants against the rows a lookup returned, in
 * page-1 order. Pure: no fetch, no model. One result per distinct wanted
 * code, in first-wanted order; `sharedBy` counts the wanted list's
 * repetitions, which is what tells two rows they want the same thing.
 */
export function groundCodes(
  lookup: Pick<MasterDataLookup, 'code' | 'label' | 'facts' | 'consumable' | 'uiPageSize'>,
  rows: readonly unknown[],
  wantedCodes: readonly string[],
): GroundedCode[] {
  const byCode = new Map<string, { index: number; row: unknown }>();
  rows.forEach((row, index) => {
    const code = codeText(readPath(row, lookup.code));
    if (code !== undefined && code !== '' && !byCode.has(code)) byCode.set(code, { index, row });
  });

  const wanted = new Map<string, number>();
  for (const raw of wantedCodes) {
    const code = raw.trim();
    if (code === '') continue;
    wanted.set(code, (wanted.get(code) ?? 0) + 1);
  }

  const out: GroundedCode[] = [];
  for (const [code, sharedBy] of wanted) {
    const hit = byCode.get(code);
    if (hit === undefined) {
      out.push({ code, found: false, sharedBy });
      continue;
    }
    const grounded: GroundedCode = { code, found: true, sharedBy, index: hit.index };
    const label = labelAt(hit.row, lookup.label);
    if (label !== undefined) grounded.label = label;
    if (lookup.facts !== undefined && lookup.facts.length > 0) {
      const facts: Record<string, unknown> = {};
      for (const path of lookup.facts) facts[path] = readPath(hit.row, path);
      grounded.facts = facts;
    }
    if (lookup.uiPageSize !== undefined) grounded.reachable = hit.index < lookup.uiPageSize;
    if (lookup.consumable !== undefined) grounded.consumable = Boolean(readPath(hit.row, lookup.consumable));
    out.push(grounded);
  }
  return out;
}

// --- binding and fetching -------------------------------------------------------

const TOKEN = /\{([^{}]+)\}/g;
const squash = (value: string): string => value.replace(/\s+/g, '').toLowerCase();

/** Do two field names name the same thing? Spacing and case ignored. */
export function sameField(a: string, b: string): boolean {
  return squash(a) === squash(b);
}

/**
 * Bind a template's tokens. `{page}` (any case) is the page number; every
 * other `{Name}` is looked up in `bindings` with spacing and case ignored,
 * and URL-encoded. Missing tokens are named, not guessed.
 */
export function bindTemplate(
  template: string,
  bindings: Readonly<Record<string, string>>,
  page: number,
): { ok: true; url: string } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const byKey = new Map(Object.entries(bindings).map(([key, value]) => [squash(key), value]));
  const url = template.replace(TOKEN, (whole, name: string) => {
    if (squash(name) === 'page') return String(page);
    const value = byKey.get(squash(name));
    if (value === undefined) {
      missing.push(name);
      return whole;
    }
    return encodeURIComponent(value);
  });
  return missing.length === 0 ? { ok: true, url } : { ok: false, missing };
}

/** The tokens a template binds from a row, `{page}` excluded, as written. */
export function templateTokens(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(TOKEN)) {
    const name = match[1]!;
    if (squash(name) !== 'page' && !names.some((n) => sameField(n, name))) names.push(name);
  }
  return names;
}

/** Resolve a bound path against the app URL; an absolute template is left as it is. */
export function resolveLookupUrl(bound: string, appUrl: string | undefined): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(bound) || appUrl === undefined) return bound;
  return new URL(bound, appUrl.endsWith('/') ? appUrl : `${appUrl}/`).toString();
}

/**
 * The injected transport: a URL in, its JSON out. Must THROW on a non-2xx or
 * non-JSON answer — the fetcher turns the throw into an `unknown` lookup with
 * the reason, and nothing above it ever sees an exception.
 */
export type FetchJson = (url: string) => Promise<unknown>;

/** `FetchJson` over the HTTP execution plane's own seam (browser cookies or Node fetch). */
export function fetchJsonThrough(transport: ApiTransport): FetchJson {
  return async (url) => {
    const response = await transport.send({ method: 'GET', url, headers: { accept: 'application/json' } });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
    }
    const parsed = parseJson(response.body);
    if (parsed === undefined) throw new Error('the answer was not JSON');
    return parsed;
  };
}

/** A runaway `next` that never turns false ends here, as an unknown lookup rather than a hang. */
export const MAX_LOOKUP_PAGES = 500;

export type LookupFetch =
  | { status: 'ok'; rows: unknown[]; pages: number; urls: string[] }
  | { status: 'unknown'; reason: string; urls: string[] };

/**
 * Pages a lookup until `next` is false, memoising each bound URL for the life
 * of the fetcher — one command, one fetch per distinct page whatever the
 * number of rows that need it. Never throws.
 */
export class LookupFetcher {
  readonly #fetchJson: FetchJson;
  readonly #memo = new Map<string, Promise<unknown>>();

  constructor(fetchJson: FetchJson) {
    this.#fetchJson = fetchJson;
  }

  /** The URLs fetched so far, in first-request order. */
  get urls(): string[] {
    return [...this.#memo.keys()];
  }

  async fetch(
    lookup: MasterDataLookup,
    bindings: Readonly<Record<string, string>>,
    appUrl?: string | undefined,
  ): Promise<LookupFetch> {
    const rows: unknown[] = [];
    const urls: string[] = [];
    for (let page = 1; page <= MAX_LOOKUP_PAGES; page += 1) {
      const bound = bindTemplate(lookup.url, bindings, page);
      if (!bound.ok) return { status: 'unknown', reason: `unbound token(s): ${bound.missing.join(', ')}`, urls };
      const url = resolveLookupUrl(bound.url, appUrl);
      urls.push(url);
      let body: unknown;
      try {
        body = await this.#memoised(url);
      } catch (error) {
        return { status: 'unknown', reason: `${url}: ${error instanceof Error ? error.message : String(error)}`, urls };
      }
      const pageRows = readPath(body, lookup.rows);
      if (!Array.isArray(pageRows)) {
        return { status: 'unknown', reason: `${url}: '${lookup.rows}' is not an array in the answer`, urls };
      }
      rows.push(...pageRows);
      if (lookup.next === undefined) return { status: 'ok', rows, pages: page, urls };
      if (readPath(body, lookup.next) !== true || pageRows.length === 0) return { status: 'ok', rows, pages: page, urls };
    }
    return { status: 'unknown', reason: `'${lookup.next}' never turned false in ${MAX_LOOKUP_PAGES} pages`, urls };
  }

  #memoised(url: string): Promise<unknown> {
    let pending = this.#memo.get(url);
    if (pending === undefined) {
      pending = this.#fetchJson(url);
      // A failed page is not remembered: the next asker gets to try again.
      pending.catch(() => this.#memo.delete(url));
      this.#memo.set(url, pending);
    }
    return pending;
  }
}

// --- from a catalog's Test Data to lookups --------------------------------------

/** What the command reads off one sheet row: its id and its Test Data pairs. */
export interface CaseData {
  caseId: string;
  pairs: readonly { key: string; value: string }[];
}

/** One row wanting one code through one lookup, with the tokens its own pairs bind. */
export interface CodeUse {
  caseId: string;
  field: string;
  code: string;
  bindings: Record<string, string>;
  /** Tokens the template needs that this row's pairs do not carry. */
  missing: string[];
}

/** The rows grouped by (lookup, bound tokens): one fetch, one grounding, per group. */
export interface LookupPlan {
  lookup: MasterDataLookup;
  bindings: Record<string, string>;
  uses: CodeUse[];
}

/** The pairs of a row that name one of the lookup's fields. */
function usesIn(lookup: MasterDataLookup, row: CaseData): CodeUse[] {
  const tokens = templateTokens(lookup.url);
  const bindings: Record<string, string> = {};
  const missing: string[] = [];
  for (const token of tokens) {
    const pair = row.pairs.find((p) => sameField(p.key, token) && p.value.trim() !== '');
    if (pair === undefined) missing.push(token);
    else bindings[token] = pair.value.trim();
  }
  const uses: CodeUse[] = [];
  const seen = new Set<string>();
  for (const pair of row.pairs) {
    if (!lookup.field.some((f) => sameField(f, pair.key))) continue;
    const code = pair.value.trim();
    if (code === '' || seen.has(code)) continue;
    seen.add(code);
    uses.push({ caseId: row.caseId, field: pair.key, code, bindings: { ...bindings }, missing: [...missing] });
  }
  return uses;
}

/**
 * Plan the fetches: every (lookup, distinct bound tokens) once. A row whose
 * pairs cannot bind a token lands in its own `missing` group, reported as
 * unbound rather than fetched with a guess.
 */
export function planLookups(lookups: readonly MasterDataLookup[], cases: readonly CaseData[]): LookupPlan[] {
  const plans: LookupPlan[] = [];
  for (const lookup of lookups) {
    const groups = new Map<string, LookupPlan>();
    for (const row of cases) {
      for (const use of usesIn(lookup, row)) {
        const key = use.missing.length > 0
          ? `missing:${use.missing.join(',')}`
          : JSON.stringify(Object.entries(use.bindings).map(([k, v]) => [squash(k), v]).sort());
        let plan = groups.get(key);
        if (plan === undefined) {
          plan = { lookup, bindings: use.bindings, uses: [] };
          groups.set(key, plan);
        }
        plan.uses.push(use);
      }
    }
    plans.push(...groups.values());
  }
  return plans;
}

// --- the result --------------------------------------------------------------------

export interface CodeReport extends Partial<Omit<GroundedCode, 'code' | 'sharedBy'>> {
  code: string;
  /** The sheet rows (case ids) that name the code, in sheet order. */
  cases: string[];
  sharedBy: number;
}

export interface LookupGrounding {
  field: string[];
  bindings: Record<string, string>;
  /** `unbound`: a row's pairs did not carry a token the template needs. */
  status: 'ok' | 'unknown' | 'unbound';
  reason?: string | undefined;
  urls: string[];
  pages?: number | undefined;
  rowsFetched?: number | undefined;
  uiPageSize?: number | undefined;
  consumable?: string | undefined;
  codes: CodeReport[];
}

/** Fetch and ground one planned group. Never throws. */
export async function groundPlan(plan: LookupPlan, fetcher: LookupFetcher, appUrl?: string | undefined): Promise<LookupGrounding> {
  const base: LookupGrounding = {
    field: [...plan.lookup.field],
    bindings: { ...plan.bindings },
    status: 'ok',
    urls: [],
    uiPageSize: plan.lookup.uiPageSize,
    consumable: plan.lookup.consumable,
    codes: [],
  };
  const casesByCode = new Map<string, string[]>();
  for (const use of plan.uses) {
    const cases = casesByCode.get(use.code) ?? [];
    if (!cases.includes(use.caseId)) cases.push(use.caseId);
    casesByCode.set(use.code, cases);
  }
  const missing = plan.uses[0]?.missing ?? [];
  if (missing.length > 0) {
    base.status = 'unbound';
    base.reason = `token(s) ${missing.map((m) => `{${m}}`).join(', ')} not in these rows' Test Data`;
    base.codes = [...casesByCode].map(([code, cases]) => ({ code, cases, sharedBy: cases.length }));
    return base;
  }
  const fetched = await fetcher.fetch(plan.lookup, plan.bindings, appUrl);
  base.urls = fetched.urls;
  if (fetched.status === 'unknown') {
    base.status = 'unknown';
    base.reason = fetched.reason;
    base.codes = [...casesByCode].map(([code, cases]) => ({ code, cases, sharedBy: cases.length }));
    return base;
  }
  base.pages = fetched.pages;
  base.rowsFetched = fetched.rows.length;
  // One wanted entry per (row, code), so `sharedBy` counts rows.
  const wanted = plan.uses.map((use) => use.code);
  base.codes = groundCodes(plan.lookup, fetched.rows, wanted).map((grounded) => ({
    ...grounded,
    cases: casesByCode.get(grounded.code) ?? [],
  }));
  return base;
}

export interface GroundingSummary {
  lookups: number;
  /** Lookups that could not be read (`unknown`) or bound (`unbound`). */
  unknownLookups: number;
  codes: number;
  rows: number;
  notFound: { codes: number; rows: number; first: string[] };
  unreachable: { codes: number; rows: number; first: string[] };
  /** Consumable codes wanted by two or more rows. */
  contended: { codes: number; rows: number; first: string[] };
  urls: string[];
}

const FIRST_N = 5;

/** Counts over every grounding, for the summary and the finding. */
export function summarizeGrounding(results: readonly LookupGrounding[]): GroundingSummary {
  const summary: GroundingSummary = {
    lookups: results.length,
    unknownLookups: results.filter((r) => r.status !== 'ok').length,
    codes: 0,
    rows: 0,
    notFound: { codes: 0, rows: 0, first: [] },
    unreachable: { codes: 0, rows: 0, first: [] },
    contended: { codes: 0, rows: 0, first: [] },
    urls: [...new Set(results.flatMap((r) => r.urls))],
  };
  const rows = new Set<string>();
  const tally = (bucket: GroundingSummary['notFound'], code: CodeReport): void => {
    bucket.codes += 1;
    bucket.rows += code.cases.length;
    if (bucket.first.length < FIRST_N) bucket.first.push(code.code);
  };
  for (const result of results) {
    for (const code of result.codes) {
      summary.codes += 1;
      for (const id of code.cases) rows.add(id);
      if (result.status !== 'ok') continue;
      if (code.found === false) tally(summary.notFound, code);
      if (code.reachable === false) tally(summary.unreachable, code);
      if (code.consumable === true && code.sharedBy >= 2) tally(summary.contended, code);
    }
  }
  summary.rows = rows.size;
  return summary;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const firstOf = (bucket: { codes: number; first: string[] }): string =>
  bucket.first.length === 0 ? '' : ` (${bucket.first.join(', ')}${bucket.codes > bucket.first.length ? `, +${bucket.codes - bucket.first.length} more` : ''})`;

/**
 * The suite-level FINDING: one paragraph naming the counts and the first
 * codes, for a later task to attach to the catalog report. Informs a person;
 * it never changes a run or a verdict.
 */
export function describeGroundingFinding(results: readonly LookupGrounding[]): string {
  if (results.length === 0) return 'Master data: no lookup applied to any row.';
  const s = summarizeGrounding(results);
  const parts: string[] = [
    `Master data: ${plural(s.codes, 'code')} named by ${plural(s.rows, 'row')} checked through ${plural(s.lookups, 'lookup')}.`,
  ];
  if (s.notFound.codes > 0) {
    parts.push(`${plural(s.notFound.codes, 'code')} in ${plural(s.notFound.rows, 'row')} ${s.notFound.codes === 1 ? 'is' : 'are'} not in the master${firstOf(s.notFound)}.`);
  }
  if (s.unreachable.codes > 0) {
    const one = s.unreachable.codes === 1;
    parts.push(
      `${plural(s.unreachable.codes, 'code')} in ${plural(s.unreachable.rows, 'row')} ${one ? 'exists but sits' : 'exist but sit'} beyond the rows the UI picker loads, so a person cannot pick ${one ? 'it' : 'them'}${firstOf(s.unreachable)}.`,
    );
  }
  if (s.contended.codes > 0) {
    parts.push(
      `${plural(s.contended.codes, 'consumable code')} ${s.contended.codes === 1 ? 'is' : 'are'} wanted by two or more rows (${plural(s.contended.rows, 'row')}) — the second use finds it taken${firstOf(s.contended)}.`,
    );
  }
  if (s.unknownLookups > 0) {
    parts.push(`${plural(s.unknownLookups, 'lookup')} could not be read; ${s.unknownLookups === 1 ? 'its' : 'their'} codes are unverified, not missing.`);
  }
  if (parts.length === 1) parts.push('Every code was found and reachable.');
  return parts.join(' ');
}

const cell = (value: unknown): string => {
  if (value === undefined) return '-';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return JSON.stringify(value);
};

/** The text report: a table per lookup, then the summary. */
export function renderGroundingReport(results: readonly LookupGrounding[]): string {
  const lines: string[] = [];
  for (const result of results) {
    const where = Object.entries(result.bindings).map(([k, v]) => `${k}=${v}`).join(', ');
    lines.push(`${result.field.join(' / ')}${where === '' ? '' : ` [${where}]`}`);
    if (result.status !== 'ok') {
      lines.push(`  ${result.status}: ${result.reason ?? ''}`);
      lines.push(`  ${plural(result.codes.length, 'code')} unverified: ${result.codes.map((c) => c.code).join(', ')}`);
      lines.push('');
      continue;
    }
    lines.push(
      `  ${result.rowsFetched} row(s) over ${plural(result.pages ?? 0, 'page')}` +
        (result.uiPageSize === undefined ? '' : `; the UI picker loads ${result.uiPageSize}`),
    );
    const factPaths = result.codes.find((c) => c.facts !== undefined)?.facts;
    const header = ['code', 'rows', 'found', 'label', ...Object.keys(factPaths ?? {}), ...(result.uiPageSize === undefined ? [] : ['reachable'])];
    const table = result.codes.map((code) => [
      code.code,
      String(code.cases.length),
      cell(code.found),
      cell(code.label),
      ...Object.keys(factPaths ?? {}).map((path) => cell(code.facts?.[path])),
      ...(result.uiPageSize === undefined ? [] : [cell(code.reachable)]),
    ]);
    const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i]!.length)));
    const render = (row: string[]): string => `  ${row.map((c, i) => c.padEnd(widths[i]!)).join('  ')}`;
    lines.push(render(header), ...table.map(render), '');
  }
  const s = summarizeGrounding(results);
  lines.push(
    `summary: ${plural(s.codes, 'code')} / ${plural(s.rows, 'row')} checked; ` +
      `${s.notFound.codes} code(s) / ${s.notFound.rows} row(s) not found; ` +
      `${s.unreachable.codes} code(s) / ${s.unreachable.rows} row(s) unreachable; ` +
      `${s.contended.codes} consumable code(s) shared by 2+ rows` +
      (s.unknownLookups > 0 ? `; ${s.unknownLookups} lookup(s) unread` : ''),
  );
  if (s.urls.length > 0) lines.push('lookups used:', ...s.urls.map((u) => `  ${u}`));
  return `${lines.join('\n')}\n`;
}
