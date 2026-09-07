/**
 * Files in and files out — the two things a browser test does with the disk.
 *
 * `setInputFiles` appeared nowhere in the engine (EH-08, 2026-09-03), so the
 * ~110 upload rows (BE Bulk Import PL_10_07..57 / RU_09_07..57, consent
 * attachments CNS-EC-003.., leave medical certificates ML_01_05/06) and the
 * ~26 download rows (Download Sample CSV / Export — PL_10_06, PL_11_*,
 * RU_10_*) had no step to be authored as. The `upload` / `download` steps
 * (FlowStep union, executeStep, MCP schema, authoring narrowers, data-locks)
 * are the runner's and generator's halves; this is the browser half.
 *
 * How a file gets in, in order of how little the page has to cooperate:
 *
 * 1. the element IS `input[type=file]` → `setInputFiles` on it;
 * 2. it contains one (humi's AttachmentDropzone / FileUploadField hide the
 *    input behind a "Click or drag file here" surface) → the first one;
 * 3. it is a `<label for>` or carries `aria-controls` naming one → that one;
 * 4. else the native chooser: arm `filechooser`, click, hand the paths over —
 *    the page's own handler runs exactly as it would for a person.
 *
 * A missing fixture is a HARNESS fault (`FixtureMissingError`, `error`, never
 * an application defect): the test cannot be run, the app was never asked.
 */
import { stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';

import type { Download, Locator, Page } from 'playwright';

export interface AttachedFile {
  name: string;
  bytes: number;
  path: string;
}

export interface AttachResult {
  via: 'input' | 'descendant' | 'label-for' | 'aria-controls' | 'filechooser';
  files: AttachedFile[];
}

export interface AttachOptions {
  /** How long to wait for the element / the chooser. */
  timeout?: number | undefined;
  /** What relative paths resolve against — the flow's own directory, usually. */
  baseDir?: string | undefined;
}

/** A fixture the flow names is not on disk — the run cannot proceed, the app is not at fault. */
export class FixtureMissingError extends Error {
  override readonly name = 'FixtureMissingError';
  readonly path: string;
  constructor(path: string, cause?: unknown) {
    super(`fixture file not found: ${path} — the test names a file that is not on disk (a harness fault, not an application defect)`);
    this.path = path;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Resolve and stat every path, failing on the first that is not a file. */
export async function resolveFixtures(files: readonly string[], baseDir?: string): Promise<AttachedFile[]> {
  const out: AttachedFile[] = [];
  for (const file of files) {
    const path = isAbsolute(file) ? file : resolve(baseDir ?? process.cwd(), file);
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new FixtureMissingError(path);
      out.push({ name: basename(path), bytes: info.size, path });
    } catch (error) {
      if (error instanceof FixtureMissingError) throw error;
      throw new FixtureMissingError(path, error);
    }
  }
  return out;
}

/** What the resolved element is, read in one evaluate. */
async function describeElement(
  locator: Locator,
  timeout: number,
): Promise<{ tag: string; type: string; forId: string | null; controls: string | null }> {
  return locator.first().evaluate(
    (el) => {
      const node = el as unknown as { tagName: string; getAttribute(name: string): string | null };
      return {
        tag: node.tagName.toLowerCase(),
        type: (node.getAttribute('type') ?? '').toLowerCase(),
        forId: node.getAttribute('for'),
        controls: node.getAttribute('aria-controls'),
      };
    },
    undefined,
    { timeout },
  );
}

function byId(page: Page, id: string): Locator {
  return page.locator(`[id="${id.replace(/"/g, '\\"')}"]`);
}

/**
 * Attach `files` through whatever `locator` resolves to — the input itself,
 * a dropzone hiding one, a label for one, or a button that opens the native
 * chooser. `locator` may resolve to a hidden element: a file input usually
 * is one.
 */
export async function attachFiles(
  page: Page,
  locator: Locator,
  files: readonly string[],
  options: AttachOptions = {},
): Promise<AttachResult> {
  const timeout = options.timeout ?? 2_000;
  const resolved = await resolveFixtures(files, options.baseDir);
  const paths = resolved.map((f) => f.path);

  await locator.first().waitFor({ state: 'attached', timeout });
  const facts = await describeElement(locator, timeout);

  if (facts.tag === 'input' && facts.type === 'file') {
    await locator.first().setInputFiles(paths, { timeout });
    return { via: 'input', files: resolved };
  }
  const inside = locator.first().locator('input[type="file"]');
  if ((await inside.count()) > 0) {
    await inside.first().setInputFiles(paths, { timeout });
    return { via: 'descendant', files: resolved };
  }
  if (facts.tag === 'label' && facts.forId) {
    const target = byId(page, facts.forId);
    if ((await target.count()) > 0 && (await describeElement(target, timeout)).type === 'file') {
      await target.first().setInputFiles(paths, { timeout });
      return { via: 'label-for', files: resolved };
    }
  }
  if (facts.controls) {
    for (const id of facts.controls.split(/\s+/).filter((s) => s !== '')) {
      const target = byId(page, id);
      if ((await target.count()) > 0 && (await describeElement(target, timeout)).type === 'file') {
        await target.first().setInputFiles(paths, { timeout });
        return { via: 'aria-controls', files: resolved };
      }
    }
  }
  // The native chooser: what a person's click opens. Armed BEFORE the click,
  // or the event is missed; the page's own change handler runs on setFiles.
  //
  // **Its handler is attached at creation, not after the click.** The `.catch`
  // used to sit on the line after `await click`, so a chooser that timed out
  // while the click was still running rejected with nothing listening — an
  // unhandled rejection, which takes the whole process down. Live (run 18):
  // `page.waitForEvent: Timeout 2000ms exceeded` killed a run at step 63 of
  // 76, losing the verdict and the report for a step that should merely have
  // failed. The timeout here is the step's own, and a healed step's is short.
  let refused: unknown;
  const chooser = page
    .waitForEvent('filechooser', { timeout })
    .catch((error: unknown) => {
      refused = error;
      return null;
    });
  await locator.first().click({ timeout });
  const opened = await chooser;
  if (opened === null) {
    throw new Error(
      `no file input under the element and clicking it opened no file chooser within ${timeout} ms: ${
        refused instanceof Error ? refused.message.split('\n')[0] : String(refused)
      }`,
    );
  }
  await opened.setFiles(paths);
  return { via: 'filechooser', files: resolved };
}

export interface CapturedDownload {
  /** Where the file was saved. */
  path: string;
  /** The name the server or the page suggested. */
  filename: string;
  bytes: number;
  /** The URL the download came from, when the browser knows it. */
  url: string;
}

export interface CaptureDownloadOptions {
  /** Directory to save into — `<reports>/<run>-media/downloads` on the runner's side. */
  dir: string;
  /** How long to wait for the download to begin. */
  timeout?: number | undefined;
  /** Override the saved file's name. */
  as?: string | undefined;
}

/**
 * Arm the `download` event, run `trigger` (usually a click), save what
 * arrives. Playwright never saves a download unless asked, so an unarmed
 * click simply loses the file; this is the arming.
 */
export async function captureDownload(
  page: Page,
  trigger: () => Promise<void>,
  options: CaptureDownloadOptions,
): Promise<CapturedDownload> {
  const timeout = options.timeout ?? 10_000;
  const pending: Promise<Download> = page.waitForEvent('download', { timeout });
  await trigger();
  const download = await pending.catch((error: unknown) => {
    throw new Error(
      `no download started within ${timeout} ms of the action: ${
        error instanceof Error ? error.message.split('\n')[0] : String(error)
      }`,
    );
  });
  const filename = options.as ?? download.suggestedFilename();
  const path = join(options.dir, filename);
  await download.saveAs(path);
  const info = await stat(path);
  return { path, filename, bytes: info.size, url: download.url() };
}
