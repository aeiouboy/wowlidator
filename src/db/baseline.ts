/**
 * The database baseline: detect → snapshot → compare → restore (2026-09-02).
 *
 * A catalog run writes to the application's database on purpose — that is
 * what a create-hire case does — and the data it leaves behind is the next
 * run's rotten fixture (the be100 counts drifting from 75/68 after every QA
 * pass is the recorded example). The user asked for the tool to own this:
 * before the run, work out which tables the authored flows are about; take a
 * snapshot of exactly those; while the run goes, show on every backend step
 * what it did to them, compared to that snapshot; and when the run is done,
 * put the tables back.
 *
 * Four pure-ish pieces, one file, so the rules can be read in one sitting:
 *
 * - **Detection** (`detectBaselineTables`) is deterministic, no model call.
 *   A table is under test when a DB step names it, when its name appears as
 *   a whole word in a case's text, when it is FK-connected to one that does
 *   (the live schema's own `references`, and the indexed graph's FK pairs),
 *   or when the operator names it. Every table carries its `why`, printed at
 *   run start — a snapshot of a table nobody can explain is a snapshot nobody
 *   trusts.
 * - **Snapshot** (`takeBaseline`) reads every row of every detected table,
 *   bounded by `maxRows` (a table over the bound is refused by name, never
 *   waited on), and records the same server-side content hash the probe
 *   uses, so "changed since the baseline" is one comparison of two strings.
 *   Real values are kept — a restore needs them — in a LOCAL file that is
 *   never embedded in a report; everything report-facing goes through
 *   `redact-row.ts`.
 * - **Probe** (`probeTables`, `diffAgainstBaseline`) is one cheap statement per
 *   table: `count(*)` plus an `md5(string_agg(row_to_json(t)::text …))`. A
 *   changed table gets a bounded row-level diff keyed on the primary key.
 *   Evidence, never a verdict: a failed probe is a line on the step.
 * - **Restore** (`restoreBaseline`) is the only writer in `src/db/` and it is
 *   fenced three ways: it needs a separate connection string
 *   (`WOWLIDATOR_DB_RESTORE_URL` — the read-only session stays read-only), it
 *   touches the baseline's tables and nothing else, and every statement is
 *   handed to the caller's logger BEFORE it runs. One transaction, children
 *   deleted before parents, parents inserted before children, rolled back on
 *   the first error, then re-probed through the READ-ONLY client and each
 *   table's hash compared to the baseline. A mismatch is an environment
 *   fact, never an application defect.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { Flow } from '../engine/runner.js';
import type { StepDbChange } from '../engine/proof-bundle.js';
import { redactRow } from './redact-row.js';
import { BaselineSchema, parseArtifact } from '../artifacts/schemas.js';
import type { DbClient, DbSchema, DbTable } from './client.js';

/** Same escape as `db-actions.ts`'s `quoteIdent`; local so `src/db` never imports upward. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** The `table` field of every DB step in a flow, `when` branches included. */
/** Every table a flow's DB steps name outright — the surest source, and the one a plan row cannot supply. */
export function tablesNamedBySteps(flow: Flow): string[] {
  const out: string[] = [];
  const walk = (steps: readonly unknown[]): void => {
    for (const step of steps) {
      if (typeof step !== 'object' || step === null) continue;
      const s = step as { table?: unknown; then?: unknown[]; else?: unknown[] };
      if (typeof s.table === 'string' && s.table !== '') out.push(s.table);
      if (Array.isArray(s.then)) walk(s.then);
      if (Array.isArray(s.else)) walk(s.else);
    }
  };
  walk([...(flow.setup ?? []), ...flow.steps, ...(flow.teardown ?? [])]);
  return out;
}

/* ------------------------------------------------------------------ mode */

export type BaselineMode = 'off' | 'snapshot' | 'restore';

/**
 * `auto` is the default and means "as much as the configuration allows":
 * nothing without a read-only URL, snapshot-and-compare with one, restore too
 * when a restore URL is also set. An explicit `restore` without a restore URL
 * degrades to `snapshot` and says so through `note`, rather than failing a
 * run that was otherwise ready to go.
 */
export function resolveBaselineMode(
  requested: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { mode: BaselineMode; note: string | null } {
  const asked = (requested ?? env['WOWLIDATOR_DB_BASELINE'] ?? 'auto').trim().toLowerCase();
  const hasRead = (env['WOWLIDATOR_DB_URL'] ?? '').trim() !== '';
  const hasRestore = (env['WOWLIDATOR_DB_RESTORE_URL'] ?? '').trim() !== '';
  if (asked === 'off') return { mode: 'off', note: null };
  if (!hasRead) {
    return {
      mode: 'off',
      note: asked === 'auto' ? null : `--db-baseline ${asked} needs WOWLIDATOR_DB_URL — nothing to snapshot`,
    };
  }
  if (asked === 'snapshot') return { mode: 'snapshot', note: null };
  if (asked === 'restore') {
    return hasRestore
      ? { mode: 'restore', note: null }
      : { mode: 'snapshot', note: 'WOWLIDATOR_DB_RESTORE_URL is not set — snapshot and compare only, no restore' };
  }
  if (asked !== 'auto') {
    return { mode: hasRestore ? 'restore' : 'snapshot', note: `unknown --db-baseline "${asked}" — treated as auto` };
  }
  return { mode: hasRestore ? 'restore' : 'snapshot', note: null };
}

/* ------------------------------------------------------------- detection */

export interface DetectedTable {
  /** As introspection names it: bare for the current schema, `schema.table` otherwise. */
  table: string;
  /** One line per source that named it — what the run start prints. */
  why: string[];
}

export interface DetectInput {
  /** The case name the flow runs under (`HIR-EC-006 …`). */
  name: string;
  /**
   * The authored flow, when there is one. Absent for a PLAN row: a pipelined
   * catalog authors while it runs, and the snapshot has to precede the first
   * write, so detection runs on what the sheet says before any flow exists.
   * Source (a) — a DB step naming its table — needs a flow; sources (b), (c)
   * and (d) do not.
   */
  flow?: Flow | undefined;
  /**
   * The case's own words when there is no flow yet: the sheet row's test
   * case, steps, test data, expected output and note, joined. Read by source
   * (b) exactly as a flow's intents are.
   */
  text?: string | undefined;
}

export interface DetectOptions {
  /** `[from, to]` table pairs from the indexed graph (see `fkPairsFromGraph`). */
  fkPairs?: readonly (readonly [string, string])[] | undefined;
  /** Operator additions (`--db-baseline-tables`, `WOWLIDATOR_DB_BASELINE_TABLES`). */
  extra?: readonly string[] | undefined;
  /** Follow FK edges from the named tables (default true). */
  followFks?: boolean | undefined;
}

/** Bare name of `schema.table`, lower-cased. */
function bareOf(table: string): string {
  const parts = table.toLowerCase().split('.');
  return parts[parts.length - 1] ?? table.toLowerCase();
}

/**
 * Resolve an authored or spoken name to the schema's own spelling. `schema.t`
 * must match exactly; a bare `t` matches a table whose bare name is `t` — in
 * the current schema first, else the single table of that name anywhere.
 */
function resolveTable(name: string, schema: DbSchema | null): string | null {
  const wanted = name.trim().toLowerCase();
  if (wanted === '') return null;
  if (schema === null) return name.trim();
  const exact = schema.tables.find((t) => t.name.toLowerCase() === wanted);
  if (exact !== undefined) return exact.name;
  if (wanted.includes('.')) return null;
  const bare = schema.tables.filter((t) => bareOf(t.name) === wanted);
  if (bare.length === 1) return bare[0]!.name;
  return null;
}

/** Every string a case's flow says about itself — where table names are looked for. */
function caseText(input: DetectInput): string {
  const flow = (input.flow ?? { name: input.name, steps: [] }) as Flow & {
    caseContext?: string | undefined;
    claim?: string | undefined;
  };
  const parts: string[] = [input.name, flow.name, flow.caseContext ?? '', flow.claim ?? '', input.text ?? ''];
  const walk = (steps: readonly unknown[]): void => {
    for (const step of steps) {
      if (typeof step !== 'object' || step === null) continue;
      const s = step as { intent?: unknown; goal?: unknown; then?: unknown[]; else?: unknown[] };
      if (typeof s.intent === 'string') parts.push(s.intent);
      if (typeof s.goal === 'string') parts.push(s.goal);
      if (Array.isArray(s.then)) walk(s.then);
      if (Array.isArray(s.else)) walk(s.else);
    }
  };
  walk([...(flow.setup ?? []), ...flow.steps, ...(flow.teardown ?? [])]);
  return parts.join('\n').toLowerCase();
}

/**
 * A bare table name is looked for in prose only when it is specific enough
 * to be one: `employee_grade` (an underscore) or `attendance` (eight letters
 * or more). `user`, `role`, `plan` would match half the sentences in a
 * catalog and snapshot half the database.
 */
function proseWorthy(bare: string): boolean {
  return bare.includes('_') || bare.length >= 8;
}

function wordRegex(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'i');
}

/** `col -> parent.col` → `parent`. */
function referencedTable(reference: string): string | null {
  const arrow = reference.indexOf('->');
  if (arrow === -1) return null;
  const target = reference.slice(arrow + 2).trim();
  const dot = target.lastIndexOf('.');
  return dot === -1 ? target : target.slice(0, dot);
}

/**
 * The tables a run is about, in first-named order, each with its reasons.
 * Deterministic: the same flows and schema always give the same list.
 */
export function detectBaselineTables(
  inputs: readonly DetectInput[],
  schema: DbSchema | null,
  options: DetectOptions = {},
): DetectedTable[] {
  const found = new Map<string, string[]>();
  const add = (table: string, why: string): void => {
    const list = found.get(table);
    if (list === undefined) found.set(table, [why]);
    else if (!list.includes(why)) list.push(why);
  };

  for (const input of inputs) {
    // (a) DB steps name their table outright.
    for (const named of tablesNamedBySteps(input.flow ?? { name: input.name, steps: [] })) {
      const resolved = resolveTable(named, schema);
      if (resolved !== null) add(resolved, `named by a DB step of ${input.name.split(/\s+/, 1)[0]}`);
    }
    // (b) The schema's own names, as whole words in what the case says.
    if (schema !== null) {
      const text = caseText(input);
      for (const table of schema.tables) {
        const qualified = table.name.toLowerCase();
        const bare = bareOf(table.name);
        if (qualified.includes('.') && wordRegex(qualified).test(text)) {
          add(table.name, `spoken of in ${input.name.split(/\s+/, 1)[0]}`);
        } else if (proseWorthy(bare) && wordRegex(bare).test(text)) {
          add(table.name, `spoken of in ${input.name.split(/\s+/, 1)[0]}`);
        }
      }
    }
  }

  // (d) Operator additions — always honoured, resolved to the schema's spelling when it knows them.
  for (const extra of options.extra ?? []) {
    const resolved = resolveTable(extra, schema) ?? extra.trim();
    if (resolved !== '') add(resolved, 'named by the operator (--db-baseline-tables)');
  }

  // (c) One FK hop from everything named so far, both directions: a parent a
  // named table points at, and every child that points at a named table —
  // the rows a create-case inserts into the child are what would stop a
  // restore's DELETE of the parent.
  if (options.followFks !== false) {
    const named = [...found.keys()];
    const byName = new Map<string, DbTable>();
    for (const t of schema?.tables ?? []) byName.set(t.name.toLowerCase(), t);
    for (const name of named) {
      const table = byName.get(name.toLowerCase());
      if (table !== undefined) {
        for (const ref of table.references) {
          const parent = referencedTable(ref);
          const resolved = parent === null ? null : resolveTable(parent, schema);
          if (resolved !== null) add(resolved, `${name} references it`);
        }
      }
      for (const other of schema?.tables ?? []) {
        if (other.name === name) continue;
        for (const ref of other.references) {
          const parent = referencedTable(ref);
          const resolved = parent === null ? null : resolveTable(parent, schema);
          if (resolved === name) add(other.name, `references ${name}`);
        }
      }
      for (const [from, to] of options.fkPairs ?? []) {
        const a = resolveTable(from, schema);
        const b = resolveTable(to, schema);
        if (a === name && b !== null) add(b, `${name} references it (indexed graph)`);
        if (b === name && a !== null) add(a, `references ${name} (indexed graph)`);
      }
    }
  }

  return [...found.entries()].map(([table, why]) => ({ table, why }));
}

/* -------------------------------------------------------------- snapshot */

export const DEFAULT_BASELINE_MAX_ROWS = 50_000;

export function baselineMaxRows(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env['WOWLIDATOR_DB_BASELINE_MAX_ROWS'] ?? '');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_BASELINE_MAX_ROWS;
}

export interface BaselineTable {
  table: string;
  why: string[];
  columns: string[];
  pk: string[];
  /** `col -> parent.col` lines, for ordering the restore. */
  references: string[];
  rowCount: number;
  /** Server-side content hash — the same statement `probeTables` runs. */
  hash: string;
  /** False when the table has no primary key (compared, never restored) or was over the bound. */
  restorable: boolean;
  /** Why it is not restorable, when it is not. */
  reason?: string | undefined;
  /** Every row, as the driver returned it (bytea encoded — see `encodeCell`). */
  rows: Record<string, unknown>[];
}

export interface Baseline {
  version: 1;
  takenAt: string;
  runKey: string | null;
  tables: BaselineTable[];
}

/** `"schema"."table"` — the table already passed the schema gate. */
export function quoteTable(name: string): string {
  return name.split('.').map(quoteIdent).join('.');
}

/** The probe statement: row count and a content hash, ordered so it is stable. */
export function probeSql(table: string): string {
  return (
    `SELECT count(*) AS n, md5(coalesce(string_agg(row_to_json(t)::text, '' ORDER BY row_to_json(t)::text), '')) AS h ` +
    `FROM ${quoteTable(table)} t`
  );
}

export interface TableProbe {
  table: string;
  rowCount: number;
  hash: string;
}

export async function probeTables(client: DbClient, tables: readonly string[]): Promise<TableProbe[]> {
  const out: TableProbe[] = [];
  for (const table of tables) {
    const result = await client.query(probeSql(table), []);
    const row = result.rows[0] ?? {};
    out.push({ table, rowCount: Number(row['n'] ?? 0), hash: String(row['h'] ?? '') });
  }
  return out;
}

const BYTEA_KEY = '__wowlidator_bytea';

/** Persistable form of one cell: bytes as base64 under a marker key, everything else as JSON carries it. */
function encodeCell(value: unknown): unknown {
  if (value instanceof Uint8Array) return { [BYTEA_KEY]: Buffer.from(value).toString('base64') };
  if (value instanceof Date) return value.toISOString();
  return value;
}

function decodeCell(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && BYTEA_KEY in (value as Record<string, unknown>)) {
    return Buffer.from(String((value as Record<string, unknown>)[BYTEA_KEY]), 'base64');
  }
  return value;
}

function encodeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = encodeCell(v);
  return out;
}

export interface TakeBaselineOptions {
  maxRows?: number | undefined;
  runKey?: string | null | undefined;
  now?: (() => string) | undefined;
}

/**
 * Read every detected table. Over the bound, a table is kept in the baseline
 * with its count and hash — so the compare still works — but marked not
 * restorable, with the reason; the alternative was a snapshot that takes an
 * hour or a run that never starts.
 */
export async function takeBaseline(
  client: DbClient,
  detected: readonly DetectedTable[],
  schema: DbSchema,
  options: TakeBaselineOptions = {},
): Promise<Baseline> {
  const maxRows = options.maxRows ?? baselineMaxRows();
  const tables: BaselineTable[] = [];
  for (const { table, why } of detected) {
    const meta = schema.tables.find((t) => t.name === table);
    if (meta === undefined) {
      tables.push({
        table, why, columns: [], pk: [], references: [], rowCount: 0, hash: '',
        restorable: false, reason: 'not in the introspected schema', rows: [],
      });
      continue;
    }
    const [probe] = await probeTables(client, [table]);
    const rowCount = probe?.rowCount ?? 0;
    const hash = probe?.hash ?? '';
    const base = { table, why, columns: meta.columns.map((c) => c.name), pk: meta.pk, references: meta.references, rowCount, hash };
    if (rowCount > maxRows) {
      tables.push({ ...base, restorable: false, reason: `${rowCount} rows is over the ${maxRows}-row bound (WOWLIDATOR_DB_BASELINE_MAX_ROWS)`, rows: [] });
      continue;
    }
    const rows = (await client.query(`SELECT * FROM ${quoteTable(table)} t ORDER BY row_to_json(t)::text`, [])).rows;
    tables.push({
      ...base,
      restorable: meta.pk.length > 0,
      ...(meta.pk.length > 0 ? {} : { reason: 'no primary key — compared, never restored' }),
      rows: rows.map(encodeRow),
    });
  }
  return { version: 1, takenAt: (options.now ?? (() => new Date().toISOString()))(), runKey: options.runKey ?? null, tables };
}

export const BASELINE_DIR = '.wowlidator/db-baselines';

export function baselinePath(runKey: string | null, cwd = process.cwd()): string {
  const slug = (runKey ?? 'baseline').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'baseline';
  return resolve(cwd, BASELINE_DIR, `${slug}.json`);
}

export async function writeBaseline(path: string, baseline: Baseline): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(baseline), 'utf8');
  return path;
}

export async function readBaseline(path: string): Promise<Baseline> {
  // Parsed, not asserted (Phase C): this file is what `db restore` writes
  // BACK into the database, so a table without its key columns or its rows
  // is refused outright rather than restored as far as it goes.
  const parsed = parseArtifact<Baseline>(BaselineSchema, JSON.parse(await readFile(path, 'utf8')));
  if (!parsed.ok) throw new Error(`${path} is not a wowlidator db baseline (${parsed.issue})`);
  return parsed.value;
}

/* --------------------------------------------------------------- compare */

/** The values of a row's key columns, as one string — what rows are matched on. */
function keyOf(row: Record<string, unknown>, pk: readonly string[]): string {
  return JSON.stringify(pk.map((c) => encodeCell(row[c])));
}

function sameRow(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(encodeRow(a)) === JSON.stringify(encodeRow(b));
}

export const DIFF_SAMPLE_MAX = 20;

/**
 * One table's change against its baseline, keyed on the primary key when it
 * has one (inserted / deleted / updated, a bounded redacted sample), counts
 * only when it does not.
 */
export function diffRows(
  base: BaselineTable,
  current: readonly Record<string, unknown>[],
  currentProbe: TableProbe,
): StepDbChange {
  const change: StepDbChange = {
    table: base.table,
    baselineRows: base.rowCount,
    rows: currentProbe.rowCount,
    changed: currentProbe.hash !== base.hash,
  };
  if (!change.changed || base.pk.length === 0 || (base.rows.length === 0 && base.rowCount > 0)) return change;
  const before = new Map(base.rows.map((r) => [keyOf(r, base.pk), r] as const));
  const after = new Map(current.map((r) => [keyOf(r, base.pk), r] as const));
  let inserted = 0;
  let deleted = 0;
  let updated = 0;
  const sample: NonNullable<StepDbChange['sample']> = [];
  const push = (kind: 'inserted' | 'deleted' | 'updated', key: string, row: Record<string, unknown>): void => {
    if (sample.length < DIFF_SAMPLE_MAX) sample.push({ kind, key, row: redactRow(row) });
  };
  for (const [key, row] of after) {
    const prior = before.get(key);
    if (prior === undefined) {
      inserted += 1;
      push('inserted', key, row);
    } else if (!sameRow(prior, row)) {
      updated += 1;
      push('updated', key, row);
    }
  }
  for (const [key, row] of before) {
    if (!after.has(key)) {
      deleted += 1;
      push('deleted', key, row);
    }
  }
  return { ...change, inserted, deleted, updated, sample };
}

/**
 * What every baseline table looks like now, against the baseline. Cheap on
 * an unchanged table (one probe statement); a changed table is read once
 * more for the row-level diff, within the same bound as the snapshot.
 */
export async function diffAgainstBaseline(
  client: DbClient,
  baseline: Baseline,
  maxRows: number = baselineMaxRows(),
): Promise<StepDbChange[]> {
  const probes = await probeTables(client, baseline.tables.map((t) => t.table));
  const out: StepDbChange[] = [];
  for (const base of baseline.tables) {
    const probe = probes.find((p) => p.table === base.table)!;
    if (probe.hash === base.hash) {
      out.push({ table: base.table, baselineRows: base.rowCount, rows: probe.rowCount, changed: false });
      continue;
    }
    const current =
      base.pk.length > 0 && probe.rowCount <= maxRows && base.rows.length > 0
        ? (await client.query(`SELECT * FROM ${quoteTable(base.table)} t ORDER BY row_to_json(t)::text`, [])).rows
        : [];
    out.push(diffRows(base, current, probe));
  }
  return out;
}

/**
 * The runner's seam: something with one method that answers "what changed
 * against the baseline, right now". Stubbed in tests; the real one wraps a
 * read-only `DbClient` and a `Baseline`.
 */
export interface DbBaselineProbe {
  probe(): Promise<StepDbChange[]>;
  /** What the bundle records about the baseline itself (no values). */
  summary(): { tables: string[]; takenAt: string };
}

export function baselineProbe(client: DbClient, baseline: Baseline, maxRows?: number): DbBaselineProbe {
  return {
    probe: () => diffAgainstBaseline(client, baseline, maxRows),
    summary: () => ({ tables: baseline.tables.map((t) => t.table), takenAt: baseline.takenAt }),
  };
}

/* --------------------------------------------------------------- restore */

export interface RestoreOptions {
  /** Every statement, before it runs. Where the CLI writes stderr. */
  onStatement?: ((sql: string) => void) | undefined;
  /** Rows per INSERT. */
  batch?: number | undefined;
}

export interface RestoreResult {
  ok: boolean;
  /** Tables put back. */
  restored: string[];
  /** Tables the baseline could not restore, with why. */
  skipped: { table: string; reason: string }[];
  /** After the restore: tables whose hash still differs from the baseline. */
  mismatched: { table: string; expected: string; actual: string }[];
  detail: string;
  at: string;
}

/**
 * Order tables so that children (tables whose `references` point at another
 * table in the set) come first. Used forwards for DELETE, reversed for INSERT.
 */
export function childFirst(tables: readonly BaselineTable[]): BaselineTable[] {
  const names = new Set(tables.map((t) => t.table));
  const parentsOf = (t: BaselineTable): string[] =>
    t.references.map(referencedTable).filter((p): p is string => p !== null && names.has(p) && p !== t.table);
  const out: BaselineTable[] = [];
  const seen = new Set<string>();
  const visit = (t: BaselineTable, stack: Set<string>): void => {
    if (seen.has(t.table)) return;
    if (stack.has(t.table)) return; // a cycle — order within it does not matter under deferred constraints
    stack.add(t.table);
    // Everything that references THIS table goes before it.
    for (const other of tables) {
      if (other.table !== t.table && parentsOf(other).includes(t.table)) visit(other, stack);
    }
    seen.add(t.table);
    out.push(t);
  };
  for (const t of tables) visit(t, new Set());
  return out;
}

/**
 * The statements a restore runs, in order, with their parameters — pure, so
 * the plan itself is what the unit tier asserts on (allowlist, order,
 * OVERRIDING SYSTEM VALUE, batching). Sequences are handled separately and
 * best-effort by `restoreBaseline`.
 */
export function restorePlan(baseline: Baseline, batch = 200): { sql: string; params: unknown[] }[] {
  const restorable = baseline.tables.filter((t) => t.restorable);
  const ordered = childFirst(restorable);
  const plan: { sql: string; params: unknown[] }[] = [
    { sql: 'BEGIN', params: [] },
    { sql: 'SET CONSTRAINTS ALL DEFERRED', params: [] },
  ];
  for (const t of ordered) plan.push({ sql: `DELETE FROM ${quoteTable(t.table)}`, params: [] });
  for (const t of [...ordered].reverse()) {
    const cols = t.columns;
    if (cols.length === 0) continue;
    for (let i = 0; i < t.rows.length; i += batch) {
      const rows = t.rows.slice(i, i + batch);
      const params: unknown[] = [];
      const tuples = rows.map((row) => {
        const holes = cols.map((c) => {
          params.push(decodeCell(row[c]) ?? null);
          return `$${params.length}`;
        });
        return `(${holes.join(', ')})`;
      });
      plan.push({
        sql: `INSERT INTO ${quoteTable(t.table)} (${cols.map(quoteIdent).join(', ')}) OVERRIDING SYSTEM VALUE VALUES ${tuples.join(', ')}`,
        params,
      });
    }
  }
  plan.push({ sql: 'COMMIT', params: [] });
  return plan;
}

/**
 * Put the tables back, verify through the read-only client. `writable` must
 * be the restore connection (`connectDbWritable`); `reader` the ordinary one.
 */
export async function restoreBaseline(
  writable: DbClient,
  reader: DbClient,
  baseline: Baseline,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  const at = new Date().toISOString();
  const skipped = baseline.tables
    .filter((t) => !t.restorable)
    .map((t) => ({ table: t.table, reason: t.reason ?? 'not restorable' }));
  const restorable = baseline.tables.filter((t) => t.restorable);
  if (restorable.length === 0) {
    return { ok: false, restored: [], skipped, mismatched: [], detail: 'nothing restorable in the baseline', at };
  }
  const plan = restorePlan(baseline, options.batch);
  try {
    for (const { sql, params } of plan) {
      options.onStatement?.(sql.length > 200 ? `${sql.slice(0, 200)}… (${params.length} value(s))` : sql);
      await writable.query(sql, params);
    }
  } catch (error) {
    options.onStatement?.('ROLLBACK');
    await writable.query('ROLLBACK', []).catch(() => undefined);
    const detail = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
    return { ok: false, restored: [], skipped, mismatched: [], detail: `restore rolled back: ${detail}`, at };
  }
  // Sequences: best effort, each in its own statement, never fatal — a
  // serial that is behind max(pk) makes the NEXT insert fail, which is a
  // worse thing to leave behind than a warning.
  for (const t of restorable) {
    for (const col of t.pk) {
      const sql =
        `SELECT setval(s, GREATEST((SELECT max(${quoteIdent(col)})::bigint FROM ${quoteTable(t.table)}), 1)) ` +
        `FROM pg_get_serial_sequence($1, $2) s WHERE s IS NOT NULL`;
      options.onStatement?.(`${sql} -- [${t.table}, ${col}]`);
      await writable.query(sql, [t.table, col]).catch(() => undefined);
    }
  }
  const probes = await probeTables(reader, restorable.map((t) => t.table));
  const mismatched = restorable
    .map((t) => ({ t, p: probes.find((p) => p.table === t.table) }))
    .filter(({ t, p }) => p === undefined || p.hash !== t.hash)
    .map(({ t, p }) => ({ table: t.table, expected: t.hash, actual: p?.hash ?? '' }));
  const restored = restorable.map((t) => t.table);
  const ok = mismatched.length === 0;
  return {
    ok,
    restored,
    skipped,
    mismatched,
    detail: ok
      ? `${restored.length} table(s) back to baseline · verified` + (skipped.length > 0 ? ` · ${skipped.length} not restorable: ${skipped.map((s) => s.table).join(', ')}` : '')
      : `restore ran but ${mismatched.length} table(s) still differ from the baseline: ${mismatched.map((m) => m.table).join(', ')}`,
    at,
  };
}
