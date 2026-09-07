import type { FetchJson } from './master-data.js';
import type { ProjectGraph } from './types.js';

const LOOKUP_SEGMENTS: readonly string[] = [
  'lookup',
  'lookups',
  'master',
  'reference',
  'ref-data',
  'options',
];
const CODE_WORDS = ['value', 'code', 'key', 'id'] as const;
const LABEL_WORDS = ['name', 'label', 'title', 'text', 'description'] as const;

export const MAX_PROBE_DEPTH = 3;

export interface LookupOperation {
  readonly path: string;
  readonly field: string;
}

export interface LookupShape {
  readonly rows: string;
  readonly code: string;
  readonly label: string;
}

export type LookupDiscovery =
  | {
      readonly path: string;
      readonly field: string;
      readonly shape: LookupShape;
      /** The base that actually answered — the declaration's url is written under it. */
      readonly base: string;
    }
  | { readonly path: string; readonly field: string; readonly unknown: string };

function wordsIn(value: string): readonly string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
}

/**
 * The singular of a plural path segment, by English's own spelling rules and
 * no word list.
 *
 * Measured against the indexed application's fourteen lookups: a bare "drop a
 * trailing s" turns `companies` into `Companie` and — applied to every word
 * rather than the head noun — `time-status-mapping` into `Time Statu
 * Mapping`. The field name has to match the sheet's own Test Data column, and
 * `Company` is exactly what the sheet writes.
 */
function singular(word: string): string {
  if (/ies$/i.test(word) && word.length > 4) return `${word.slice(0, -3)}y`;
  // `status`, `campus`, `address`: an s that is part of the word, not a plural.
  if (/(?:ss|us|is)$/i.test(word)) return word;
  if (/(?:ss|x|z|ch|sh)es$/i.test(word)) return word.slice(0, -2);
  return word.endsWith('s') ? word.slice(0, -1) : word;
}

function fieldFrom(path: string): string {
  const pathOnly = path.split(/[?#]/, 1)[0] ?? path;
  const segment = pathOnly.split('/').filter((part) => part !== '').at(-1) ?? pathOnly;
  const words = segment.split(/[-_]/).filter((word) => word !== '');
  return words
    // Only the HEAD noun is singularised — the last word is what the segment
    // counts, and `time-status-mapping` is one mapping of many statuses.
    .map((word, at) => (at === words.length - 1 ? singular(word) : word))
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export function lookupOperations(graph: Pick<ProjectGraph, 'nodes'>): LookupOperation[] {
  const byPath = new Map<string, LookupOperation>();
  for (const node of graph.nodes) {
    if (node.kind !== 'operation') continue;
    const path = /^GET\s+(\S+)$/.exec(node.name)?.[1];
    if (path === undefined) continue;
    const pathOnly = path.split(/[?#]/, 1)[0] ?? path;
    const segments = pathOnly
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => segment.toLowerCase());
    if (!segments.some((segment) => LOOKUP_SEGMENTS.includes(segment))) continue;
    if (!byPath.has(path)) byPath.set(path, { path, field: fieldFrom(path) });
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rowArray(value: unknown): readonly Record<string, unknown>[] | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isRecord)) return null;
  return value;
}

interface ArrayPath {
  readonly path: string;
  readonly rows: readonly Record<string, unknown>[];
}

interface ProbeEntry {
  readonly value: unknown;
  readonly path: string;
  readonly depth: number;
}

function arrayPath(body: unknown): ArrayPath | null {
  const queue: ProbeEntry[] = [{ value: body, path: '', depth: 0 }];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current === undefined) continue;
    const rows = rowArray(current.value);
    if (rows !== null) return { path: current.path, rows };
    if (current.depth >= MAX_PROBE_DEPTH || !isRecord(current.value)) continue;
    for (const [key, value] of Object.entries(current.value)) {
      const path = current.path === '' ? key : `${current.path}.${key}`;
      queue.push({ value, path, depth: current.depth + 1 });
    }
  }
  return null;
}

function scalarFields(row: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.entries(row)
    .filter((entry) => typeof entry[1] === 'string' || typeof entry[1] === 'number')
    .map((entry) => entry[0]);
}

function firstMatching(
  fields: readonly string[],
  priorities: readonly string[],
): string | undefined {
  for (const priority of priorities) {
    const field = fields.find((candidate) => wordsIn(candidate).includes(priority));
    if (field !== undefined) return field;
  }
  return undefined;
}

function uniqueShortField(
  rows: readonly Record<string, unknown>[],
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const values = rows.map((row) => row[field]);
    if (!values.every((value) => typeof value === 'string' || typeof value === 'number')) continue;
    const texts = values.map(String);
    if (texts.every((value) => value.length <= 32) && new Set(texts).size === rows.length) return field;
  }
  return undefined;
}

function isLabelValue(value: unknown): boolean {
  if (typeof value === 'string') return true;
  if (!isRecord(value)) return false;
  const values = Object.values(value);
  return values.length > 0 && values.every((entry) => typeof entry === 'string');
}

export function inferShape(body: unknown): LookupShape | null {
  const found = arrayPath(body);
  if (found === null) return null;
  const first = found.rows[0];
  if (first === undefined) return null;
  const scalar = scalarFields(first);
  const code = firstMatching(scalar, CODE_WORDS) ?? uniqueShortField(found.rows, scalar);
  if (code === undefined) return null;
  const labels = Object.keys(first).filter(
    (field) => field !== code && isLabelValue(first[field]),
  );
  const label = firstMatching(labels, LABEL_WORDS) ?? labels[0];
  if (label === undefined) return null;
  return { rows: found.path, code, label };
}

/**
 * Every base an operation path might be served under, most likely first.
 *
 * An indexed path is app-relative (`/api/ec-api/…`), and a deployment may add
 * a Next.js `basePath` in front of it. The value is an environment variable
 * where the application is built, so neither the repo nor the URL declares it
 * — but the deployment URL carries it as its own first segment. Live
 * (2026-09-07): `/api/…` returned nginx's HTML 404 and `/humi/api/…` returned
 * the application's JSON. So the prefix is tried too, and which one answered
 * is reported rather than assumed.
 */
export function candidateBases(baseUrl: string): string[] {
  const url = new URL(baseUrl);
  const first = url.pathname.split('/').filter((part) => part !== '')[0];
  const bases = [url.origin];
  if (first !== undefined) bases.push(`${url.origin}/${first}`);
  return bases;
}

export async function discoverLookups(
  operations: readonly LookupOperation[],
  fetchJson: FetchJson,
  options: { readonly baseUrl: string },
): Promise<LookupDiscovery[]> {
  const bases = candidateBases(options.baseUrl);
  const results: LookupDiscovery[] = [];
  for (const operation of operations) {
    const reasons: string[] = [];
    let settled: LookupDiscovery | null = null;
    for (const base of bases) {
      try {
        const url = `${base}${operation.path}`;
        const body = await fetchJson(url);
        const shape = inferShape(body);
        if (shape !== null) {
          settled = { ...operation, shape, base };
          break;
        }
        // A JSON answer with no rows is still an ANSWER: the endpoint is
        // there and it is telling us something — usually which parameter it
        // wants. Carry its own words, not the status code.
        reasons.push(`${base}: ${answerReason(body)}`);
      } catch (error) {
        reasons.push(`${base}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    results.push(settled ?? { ...operation, unknown: reasons.join(' · ') || 'no answer' });
  }
  return results;
}

/** What a JSON answer that carried no rows says about itself. */
function answerReason(body: unknown): string {
  if (isRecord(body)) {
    const message = body['message'];
    const code = body['errorCode'];
    if (typeof message === 'string' && message.trim() !== '') {
      return typeof code === 'string' ? `${code}: ${message}` : message;
    }
  }
  return 'no non-empty array of objects found';
}
