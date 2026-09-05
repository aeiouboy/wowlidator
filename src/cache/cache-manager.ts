/**
 * Persistent store for selectors repaired by the JIT healer.
 *
 * The cache is the bridge between the two planes: the control plane writes a
 * repair once (paying tokens), and every subsequent run resolves it from disk
 * at $0 cost. Keys are scoped by page URL so the same selector string can heal
 * differently on different screens.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { HealedSelectorCacheFileSchema, HealedSelectorEntrySchema, parseArtifact } from '../artifacts/schemas.js';

export const CACHE_FILE_VERSION = 1;
export const DEFAULT_CACHE_FILENAME = 'healed-selectors.json';

/** A single repaired selector, as persisted to `healed-selectors.json`. */
export interface HealedSelectorEntry {
  /** Cache key — `${scopedUrl} :: ${original}`. */
  key: string;
  /** The selector the test author wrote, which stopped resolving. */
  original: string;
  /** The replacement selector the healer produced and verified. */
  healed: string;
  /** Which locator family the healer chose (role, text, css, …). */
  strategy: string;
  /** Page URL, normalised by `scopeUrl` (origin + pathname + page-naming params). */
  url: string;
  /** Healer self-reported confidence, clamped to 0–1. */
  confidence: number;
  /** One-line justification, kept for human review of the cache file. */
  reasoning: string;
  /** Model id that produced the repair, e.g. `claude-haiku-4-5`. */
  model: string;
  healedAt: string;
  lastUsedAt: string;
  /** Number of runs that resolved this entry from cache. */
  hits: number;
}

export interface HealedSelectorCacheFile {
  version: number;
  updatedAt: string;
  entries: Record<string, HealedSelectorEntry>;
}

/**
 * The entries of a cache file that may be replayed, judged one by one. A
 * file that is not an object at all throws — the caller treats that exactly
 * as an unreadable file; an entry that fails the schema is dropped and, when
 * warnings are on, named once on stderr.
 */
function readCacheEntries(parsed: unknown, filePath: string, warn: boolean): [string, HealedSelectorEntry][] {
  const file = parseArtifact<{ entries?: Record<string, unknown> | undefined }>(HealedSelectorCacheFileSchema, parsed);
  if (!file.ok) throw new Error(file.issue);
  const out: [string, HealedSelectorEntry][] = [];
  for (const [key, entry] of Object.entries(file.value.entries ?? {})) {
    const one = parseArtifact<HealedSelectorEntry>(HealedSelectorEntrySchema, entry);
    if (one.ok) {
      out.push([key, one.value]);
    } else if (warn) {
      process.stderr.write(`[wowlidator] dropping corrupt selector cache entry ${JSON.stringify(key)} in ${filePath}: ${one.issue}\n`);
    }
  }
  return out;
}

export interface CacheManagerOptions {
  /** Path to the JSON cache file. Defaults to `./healed-selectors.json`. */
  filePath?: string;
  /** Emit a warning to stderr when the cache file is unreadable. Default true. */
  warn?: boolean;
}

/**
 * Query parameters that name a different PAGE, not a different view of the
 * same one. humi's hire wizard keys its two forms as `?step=1` / `?step=2`
 * on one route (ec10 HIR-EC-002, 2026-09-03): a repair or a dead-end memo
 * recorded for `role=textbox[name="Select date"] >> nth=0` on step 1 was
 * served on step 2 — a stale cached heal cost the healed timeout and a
 * delete, and the step-1 memo made the same selector on step 2 fail after
 * one fast attempt although step 2 is a different form. The BE import wizard
 * and any tab strip keyed by query have the same shape.
 */
export const SCOPE_PARAMS: readonly string[] = ['step', 'tab', 'page', 'view', 'section'];

/**
 * Reduce a URL to `origin + pathname` (+ the page-naming query params, sorted)
 * so tracking and navigation noise (`?next=/home`, `?utm_source=…`) does not
 * fragment the cache while `?step=2` still keys its own page. Same function
 * behind the healed-selector cache key, the runner's dead-end memo and the
 * agent's replay key, so all three agree on what "this page" means.
 */
export function scopeUrl(url: string, keep: readonly string[] = SCOPE_PARAMS): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, '') : parsed.pathname;
    const kept = [...parsed.searchParams.entries()]
      .filter(([name]) => keep.includes(name))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`);
    return `${parsed.origin}${path}${kept.length > 0 ? `?${kept.join('&')}` : ''}`;
  } catch {
    return url;
  }
}

/** In-process serialisation of flushes, one chain per cache file. */
const flushChain = new Map<string, Promise<void>>();
let flushCounter = 0;

export class CacheManager {
  readonly filePath: string;

  readonly #warn: boolean;
  #entries = new Map<string, HealedSelectorEntry>();
  #dirty = false;
  #loaded = false;
  /** Keys this instance set, used or deleted since its last flush. */
  readonly #touched = new Set<string>();
  /** `clear()` was called: the next flush must not resurrect the file's entries. */
  #cleared = false;

  constructor(options: CacheManagerOptions = {}) {
    this.filePath = resolve(options.filePath ?? DEFAULT_CACHE_FILENAME);
    this.#warn = options.warn ?? true;
  }

  /** Build the cache key for a selector observed on a given page. */
  static key(url: string, selector: string): string {
    return `${scopeUrl(url)} :: ${selector}`;
  }

  /**
   * Read the cache file into memory. Missing files start empty; malformed
   * files are reported and ignored rather than aborting a test run.
   */
  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;

    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    try {
      // Parsed, not asserted (Phase C): every entry is a selector that will
      // be replayed against a live page, so an entry missing the fields the
      // replay reads is dropped on its own — the rest of the cache survives,
      // as a hand-edited file with one bad line always should have.
      for (const [key, entry] of readCacheEntries(JSON.parse(raw), this.filePath, this.#warn)) {
        this.#entries.set(key, entry);
      }
    } catch (error) {
      if (this.#warn) {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[wowlidator] ignoring unreadable selector cache at ${this.filePath}: ${detail}\n`,
        );
      }
    }
  }

  get(key: string): HealedSelectorEntry | undefined {
    return this.#entries.get(key);
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  /** Insert or replace an entry. Resets the hit counter for a new repair. */
  set(entry: Omit<HealedSelectorEntry, 'healedAt' | 'lastUsedAt' | 'hits'>): HealedSelectorEntry {
    const now = new Date().toISOString();
    const stored: HealedSelectorEntry = { ...entry, healedAt: now, lastUsedAt: now, hits: 0 };
    this.#entries.set(entry.key, stored);
    this.#touched.add(entry.key);
    this.#dirty = true;
    return stored;
  }

  /** Mark a cached repair as used by the current run. */
  recordUse(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    entry.hits += 1;
    entry.lastUsedAt = new Date().toISOString();
    this.#touched.add(key);
    this.#dirty = true;
  }

  delete(key: string): boolean {
    const deleted = this.#entries.delete(key);
    if (deleted) {
      this.#touched.add(key);
      this.#dirty = true;
    }
    return deleted;
  }

  clear(): void {
    if (this.#entries.size === 0) return;
    for (const key of this.#entries.keys()) this.#touched.add(key);
    this.#entries.clear();
    this.#cleared = true;
    this.#dirty = true;
  }

  entries(): HealedSelectorEntry[] {
    return [...this.#entries.values()];
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * Persist to disk if anything changed. Writes via temp file + rename, and
   * **merges with what is on disk first**.
   *
   * A suite runs its cases concurrently now, and each case holds its own
   * `CacheManager` loaded at its own start. Two of them healing two different
   * selectors used to race: whichever flushed second wrote its snapshot of the
   * file over the first one's, and a repair that had just been paid for was
   * gone before the next run could use it. Worse, the temp file was named by
   * process id — identical for every case in one process — so concurrent
   * flushes wrote through the same path and one of the renames could move a
   * half-written file into place.
   *
   * So a flush re-reads the file, takes every entry it holds, and lays this
   * instance's **own changes** over the top — only the keys it set, used or
   * deleted. Another case's repair survives; a stale copy of an entry this
   * instance never touched cannot clobber a newer one. Flushes to one path are
   * also serialised within the process, and the temp name carries a counter,
   * so the rename is always of a file this flush alone wrote.
   */
  async flush(): Promise<void> {
    if (!this.#dirty) return;
    const previous = flushChain.get(this.filePath) ?? Promise.resolve();
    const mine = previous.then(() => this.#flushNow());
    flushChain.set(this.filePath, mine.catch(() => undefined));
    await mine;
  }

  async #flushNow(): Promise<void> {
    // What is on disk now — possibly written by a sibling case since we
    // loaded. A missing or unreadable file contributes nothing, exactly as it
    // does at load time.
    const onDisk = new Map<string, HealedSelectorEntry>();
    if (!this.#cleared) {
      try {
        for (const [key, entry] of readCacheEntries(JSON.parse(await readFile(this.filePath, 'utf8')), this.filePath, false)) {
          onDisk.set(key, entry);
        }
      } catch {
        // Nothing to merge with.
      }
    }
    // Our changes win for the keys we changed; everything else is whatever the
    // file says, which is at least as new as what we loaded.
    for (const key of this.#touched) {
      const mine = this.#entries.get(key);
      if (mine === undefined) onDisk.delete(key);
      else onDisk.set(key, mine);
    }
    // Keep memory in step with what was written, so a second flush merges
    // against the same picture.
    for (const [key, entry] of onDisk) if (!this.#touched.has(key)) this.#entries.set(key, entry);

    const payload: HealedSelectorCacheFile = {
      version: CACHE_FILE_VERSION,
      updatedAt: new Date().toISOString(),
      entries: Object.fromEntries([...onDisk.entries()].sort(([a], [b]) => a.localeCompare(b))),
    };

    await mkdir(dirname(this.filePath), { recursive: true });
    flushCounter += 1;
    const tmp = `${this.filePath}.${process.pid}.${flushCounter}.tmp`;
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await rename(tmp, this.filePath);
    this.#dirty = false;
    this.#cleared = false;
    this.#touched.clear();
  }
}
