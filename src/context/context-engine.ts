/**
 * Orchestrates the ingesters into one `ProjectGraph` and caches it to disk.
 *
 * Deliberately not incremental per-file: a full rebuild is plain filesystem
 * walking plus syntactic parsing, no model call, so it costs milliseconds on
 * a project this shape targets. What IS worth avoiding is redoing that work
 * when nothing changed — `signature` is a cheap composite of every walked
 * file's size and mtime, and a matching signature short-circuits straight to
 * the cached graph without touching an ingester.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';
import type { Dirent } from 'node:fs';

import { matchesCall, matchesRoutePattern, pathnameOf } from './route-match.js';
import { ManifestIngester } from './ingesters/manifest-ingester.js';
import { ComponentIngester } from './ingesters/component-ingester.js';
import { RouteIngester } from './ingesters/route-ingester.js';
import { TestIngester } from './ingesters/test-ingester.js';
import { OpenApiIngester } from './ingesters/openapi-ingester.js';
import { SchemaIngester } from './ingesters/schema-ingester.js';
import { MessageIngester } from './ingesters/message-ingester.js';
import { ProjectGraphSchema, parseArtifact, type ArtifactParse } from '../artifacts/schemas.js';
import {
  PROJECT_GRAPH_VERSION,
  type IngestContext,
  type IngestResult,
  type Ingester,
  type ProjectEdge,
  type ProjectGraph,
  type ProjectGraphSource,
  type ProjectNode,
} from './types.js';

export const DEFAULT_CONTEXT_CACHE_FILE = '.wowlidator/context-graph.json';

const IGNORED_DIR_NAMES = new Set(['node_modules', 'dist', 'build', 'out', 'coverage']);
/** A time/resource budget for the walk itself, same spirit as the AX-tree node cap. */
const MAX_WALK_FILES = 20_000;

async function walkFiles(rootDir: string): Promise<{ files: string[]; truncated: boolean }> {
  const out: string[] = [];
  const stack: string[] = [''];
  let truncated = false;

  while (stack.length > 0) {
    if (out.length >= MAX_WALK_FILES) {
      truncated = true;
      break;
    }
    const dir = stack.pop();
    if (dir === undefined) break;

    let entries: Dirent[];
    try {
      entries = await readdir(posix.join(rootDir, dir), { withFileTypes: true });
    } catch {
      continue; // unreadable dir (permissions, race) — skip rather than abort the whole walk
    }

    for (const entry of entries) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(entry.name) || entry.name.startsWith('.')) continue;
        stack.push(rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }

  return { files: out.sort(), truncated };
}

async function computeSignature(rootDir: string, files: readonly string[]): Promise<string> {
  const hash = createHash('sha1');
  for (const file of files) {
    try {
      const info = await stat(posix.join(rootDir, file));
      hash.update(`${file}:${info.size}:${info.mtimeMs}\n`);
    } catch {
      hash.update(`${file}:missing\n`);
    }
  }
  return hash.digest('hex');
}

// The pure matchers moved to `route-match.ts` (a leaf module, so the
// `expectCalls` assertion can use them without loading the ingesters); the
// re-export keeps every existing import of this module working.
export { matchesCall, matchesRoutePattern, pathnameOf } from './route-match.js';

/**
 * Cross-ingester linking pass: a `wowlidator-flow` test node records the URLs it
 * navigates to (the one thing we can read reliably out of our own flow
 * format); this matches those against route node names to produce `covers`
 * edges, so the graph can answer "does anything already test this route?"
 */
function linkCoverage(nodes: Map<string, ProjectNode>, edges: ProjectEdge[]): void {
  const routes = [...nodes.values()].filter((node) => node.kind === 'route');
  const operations = [...nodes.values()].filter((node) => node.kind === 'operation');
  const tables = [...nodes.values()].filter((node) => node.kind === 'table');
  if (routes.length === 0 && operations.length === 0 && tables.length === 0) return;

  const seen = new Set(edges.map((edge) => `${edge.from}>${edge.kind}>${edge.to}`));
  const link = (from: string, to: string): void => {
    const key = `${from}>covers>${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, kind: 'covers' });
  };

  for (const test of nodes.values()) {
    if (test.kind !== 'test') continue;

    const urls = (test.meta?.urls ?? '').split(',').filter((url) => url !== '');
    for (const url of urls) {
      const path = pathnameOf(url);
      if (path === undefined) continue;
      for (const route of routes) {
        if (matchesRoutePattern(path, route.name)) link(test.id, route.id);
      }
    }

    // The same idea one layer down: a `request` step records `METHOD url`, and
    // an operation node's name is `METHOD /path/:param`, so the same matcher
    // answers "does anything already test this endpoint?" The method must
    // match exactly — `GET /orders` and `DELETE /orders` are different
    // promises, and crediting one for the other would overstate coverage in
    // precisely the way `ax-coverage.ts` refuses to. The composition itself
    // lives in `route-match.ts` as `matchesCall`, shared with `expectCalls`.
    const calls = (test.meta?.calls ?? '').split(',').filter((call) => call !== '');
    for (const call of calls) {
      const spaceAt = call.indexOf(' ');
      if (spaceAt < 0) continue;
      const method = call.slice(0, spaceAt);
      const rest = call.slice(spaceAt + 1);
      for (const operation of operations) {
        const [opMethod, opPattern] = operation.name.split(' ');
        if (opMethod === undefined || opPattern === undefined) continue;
        if (matchesCall(method, rest, opMethod, opPattern)) link(test.id, operation.id);
      }
    }

    // One layer further down again: a DB step records the table it checked,
    // and a `table` node's name is the table. Same "does anything already
    // verify this?" answer, for the schema ingester's inventory.
    const checks = (test.meta?.checks ?? '').split(',').filter((table) => table !== '');
    for (const table of checks) {
      for (const node of tables) {
        if (node.name === table) link(test.id, node.id);
      }
    }
  }
}

function mergeGraph(
  rootDir: string,
  signature: string,
  results: ReadonlyArray<{ id: string; result: IngestResult }>,
): ProjectGraph {
  const nodes = new Map<string, ProjectNode>();
  const sources: ProjectGraphSource[] = [];
  const rawEdges: ProjectEdge[] = [];

  for (const { id, result } of results) {
    const warnings = [...result.warnings];
    let nodeCount = 0;
    for (const node of result.nodes) {
      if (nodes.has(node.id)) {
        warnings.push(`duplicate node id "${node.id}" from ingester "${id}" — kept the first`);
        continue;
      }
      nodes.set(node.id, node);
      nodeCount += 1;
    }
    rawEdges.push(...result.edges);
    sources.push({ id, nodes: nodeCount, edges: result.edges.length, warnings });
  }

  // An edge whose endpoint was never indexed is dropped, not guessed at — the
  // same "understate, never overstate" rule `ax-coverage.ts` follows.
  const seenEdges = new Set<string>();
  const edges: ProjectEdge[] = [];
  let dangling = 0;
  for (const edge of rawEdges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      dangling += 1;
      continue;
    }
    const key = `${edge.from}>${edge.kind}>${edge.to}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push(edge);
  }
  if (dangling > 0) {
    sources.push({
      id: 'merge',
      nodes: 0,
      edges: 0,
      warnings: [`dropped ${dangling} edge(s) whose endpoint(s) were never indexed`],
    });
  }

  linkCoverage(nodes, edges);

  return {
    version: PROJECT_GRAPH_VERSION,
    rootDir,
    generatedAt: new Date().toISOString(),
    signature,
    nodes: [...nodes.values()],
    edges,
    sources,
  };
}

export interface ContextEngineOptions {
  /** Project to index. Defaults to the current working directory. */
  rootDir?: string | undefined;
  /** Where the graph is cached. Defaults to `.wowlidator/context-graph.json`. */
  cacheFile?: string | undefined;
  /** Override the ingester set — mainly for tests. Defaults to all five built-ins. */
  ingesters?: Ingester[] | undefined;
  /**
   * OpenAPI/Swagger spec to index: a path (absolute or project-relative) or an
   * `http(s)` URL. Omit and the ingester looks for a conventionally-named spec
   * among the walked files.
   */
  openApiSpec?: string | undefined;
  /**
   * Database schema to index: a `.sql` DDL or `.prisma` file. Omit and the
   * schema ingester looks for a conventionally-named file, then falls back to
   * live introspection when `dbUrl` is set.
   */
  dbSchema?: string | undefined;
  /** Connection string for introspection fallback (usually `WOWLIDATOR_DB_URL`). */
  dbUrl?: string | undefined;
  /** Allow a non-loopback `dbUrl` — see `connectDb`'s guard. */
  dbRemoteOk?: boolean | undefined;
  /** Emit a warning to stderr when the cache file is unreadable. Default true. */
  warn?: boolean | undefined;
}

export class ContextEngine {
  readonly rootDir: string;
  readonly cacheFile: string;

  readonly #ingesters: Ingester[];
  readonly #warn: boolean;

  constructor(options: ContextEngineOptions = {}) {
    this.rootDir = resolve(options.rootDir ?? '.');
    this.cacheFile = resolve(options.cacheFile ?? DEFAULT_CONTEXT_CACHE_FILE);
    this.#ingesters = options.ingesters ?? [
      new ManifestIngester(),
      new ComponentIngester(),
      new RouteIngester(),
      new TestIngester(),
      // The application's own words (i18n catalogs) — the one kind of fact
      // the structural ingesters never carried. See message-ingester.ts.
      new MessageIngester(),
      new OpenApiIngester(options.openApiSpec === undefined ? {} : { source: options.openApiSpec }),
      new SchemaIngester({
        source: options.dbSchema,
        dbUrl: options.dbUrl,
        dbRemoteOk: options.dbRemoteOk,
      }),
    ];
    this.#warn = options.warn ?? true;
  }

  /** Read the cached graph without rebuilding. `null` if none exists or it's unreadable. */
  async load(): Promise<ProjectGraph | null> {
    let raw: string;
    try {
      raw = await readFile(this.cacheFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    // Parsed, not asserted (Phase C): the graph's nodes name routes and
    // tables the generator writes tests against, so a node of a kind this
    // build does not know is an artifact to rebuild, not one to read around.
    let parsed: ArtifactParse<ProjectGraph>;
    try {
      parsed = parseArtifact<ProjectGraph>(ProjectGraphSchema, JSON.parse(raw));
    } catch (error) {
      parsed = { ok: false, issue: error instanceof Error ? error.message : String(error) };
    }
    if (parsed.ok) return parsed.value;
    if (this.#warn) {
      process.stderr.write(`[wowlidator] ignoring unreadable context graph at ${this.cacheFile}: ${parsed.issue}\n`);
    }
    return null;
  }

  /**
   * Build (or reuse) the project graph. A matching `signature` against the
   * cached graph short-circuits to it; pass `force: true` to always rebuild.
   */
  async build(options: { force?: boolean } = {}): Promise<ProjectGraph> {
    const { files, truncated } = await walkFiles(this.rootDir);
    const signature = await computeSignature(this.rootDir, files);

    if (options.force !== true) {
      const cached = await this.load();
      if (cached && cached.signature === signature) return cached;
    }

    const ctx: IngestContext = { rootDir: this.rootDir, files };
    const results = await Promise.all(
      this.#ingesters.map(async (ingester) => {
        try {
          return { id: ingester.id, result: await ingester.ingest(ctx) };
        } catch (error) {
          const warnings = [`ingester crashed: ${error instanceof Error ? error.message : String(error)}`];
          const result: IngestResult = { nodes: [], edges: [], warnings };
          return { id: ingester.id, result };
        }
      }),
    );

    if (truncated) {
      results.push({
        id: 'walk',
        result: { nodes: [], edges: [], warnings: [`file walk hit the ${MAX_WALK_FILES}-file cap — some files were not indexed`] },
      });
    }

    const graph = mergeGraph(this.rootDir, signature, results);
    await this.#persist(graph);
    return graph;
  }

  async #persist(graph: ProjectGraph): Promise<void> {
    await mkdir(dirname(this.cacheFile), { recursive: true });
    const tmp = `${this.cacheFile}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
    await rename(tmp, this.cacheFile);
  }
}
