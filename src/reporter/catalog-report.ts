/**
 * The catalog report — one self-contained HTML file per catalog RUN, written
 * into the local `reports/` folder (asked for 2026-08-31).
 *
 * What makes it different from the per-case report and the suite index:
 * - **Every planned case of the catalog is on it**, grouped by scenario —
 *   including the ones that never ran (a report of 13 rows for a 108-row
 *   catalog reads as a 13-row catalog).
 * - **It is one file while the evidence fits**: screenshots are embedded as
 *   data URIs until the inline budget is spent, then written beside the HTML
 *   when the artifact writer supplies a spill sink. A sink-less pure render
 *   keeps the old inline-or-omit behaviour for small runs and tests.
 * - **The film is here too, and it is the evidence a passing case has**
 *   (2026-08-31). The runner's screenshot default is video-aware: while it is
 *   filming, stills are taken only at failures, because the film covers the
 *   rest. Measured on be100-rip, that is exactly what the bundles hold — all
 *   13 non-passing cases carry stills and 18 of 19 passing ones carry none —
 *   so a report that dropped the recording left a reader with no evidence at
 *   all for every case that worked. Recordings embed while their inline
 *   budget lasts, then become relative `.webm` links beside the report. An
 *   inline recording is decoded only when its case is opened.
 * - **A case opens into a two-pane view**: LEFT the steps, each expandable
 *   into its full detail (intent, selector, resolution, error, heal, agent
 *   turns, screenshot) plus an explanation drawn from the run history (trend,
 *   how long it has been broken, whether the same step shape failed before);
 *   RIGHT the time record — one bar per step against the fast-path budget,
 *   with the slowest steps called out.
 * - **Export from the page itself**: every reported case has an `Export (Excel)`
 *   button that downloads the case's own workbook — one row per step, the
 *   step's log in a Proof column, its screenshot in a Photo column, the
 *   recording linked under every step (`excel-export.ts` writes it beside
 *   this file as the run goes). The header exports the whole catalog file
 *   (client-side Blob + anchor, no server) and links the run's all-case
 *   workbook.
 * - **It is written when the run STARTS and rewritten after every case**
 *   (2026-09-02, `cli/catalog-live-report.ts`): the file exists — every
 *   planned case a `never ran` row — before the first case has a verdict,
 *   and each finished case replaces its row in place. A rerun of the same
 *   catalog run (same run key) updates the same file, never a new one.
 * - **It leads with FINDINGS** (2026-09-05, `findings.ts`): under the tally,
 *   "N findings account for M of K non-passing cases · U unclustered", one
 *   `<details>` per root cause listing its member cases (linked to their
 *   sections) with the statuses AS SEALED, counted and never changed. The
 *   signature is a pure function of the failing step's typed fields — never
 *   of a message — so seventy cases that met one 500 read as one finding.
 *   `never ran` cases fold into ONE list with the count on its summary line
 *   instead of a full section each; every id is still in the DOM.
 *
 * Pure render (`renderCatalogReport`) + one writer (`writeCatalogReport`), the
 * `html-reporter.ts` split, so `tests/catalog-report.test.ts` runs at the
 * unit tier against strings.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { ProofBundle, ProofStep } from '../engine/proof-bundle.js';
import { describeDbChanges, describeTarget, verdictFamily } from '../engine/proof-bundle.js';
import { grimTheme } from './theme.js';
import { slugify } from './html-reporter.js';
import { buildFindingsSummary, findingsHeadline, statusCounts, type Finding, type FindingCase, type FindingsSummary } from './findings.js';
import {
  countVerdicts,
  describeAgentAction,
  describeResolution,
  describeValueSource,
  describeVerdictCounts,
  displayCaseId,
  observedEvidence,
  provenanceExtras,
  recordOnlyCase,
  recordedCaptures,
  sheetLabel,
  stepKindFacts,
  stepTarget,
} from './step-facts.js';

export const CATALOG_REPORT_DIR = 'reports';
/** Routine screenshots are embedded until this many bytes of base64 are spent. */
export const SCREENSHOT_BUDGET_BYTES = 15_000_000;
/** Recordings are the largest single bundle value, so their inline allowance is deliberately small. */
export const RECORDING_BUDGET_BYTES = 20_000_000;
/**
 * Hard cap for inline screenshot base64. 350 MB leaves roughly 160 MB below
 * V8's ~512 MB maximum string length for the report's markup and recordings.
 */
export const REPORT_HTML_CEILING_BYTES = 350_000_000;
/** A step at or over the fast-path budget is worth a reader's eye. */
const SLOW_STEP_MS = 2_000;

export interface CatalogReportCase {
  /** `PL_06_05` — the planned id. */
  id: string;
  /** The QA sheet's Scenario ID label; never a case identity or lookup key. */
  scenarioId?: string | undefined;
  /** Full name when known (`PL_06_05 ตรวจสอบ…`); the id stands in otherwise. */
  name: string;
  /** Scenario the sheet groups it under (`PL_06`). */
  scenario: string;
  /** `passed | failed | blocked | review | never-ran`. */
  verdict: string;
  /** The bundle's own status when there was a bundle (`dead-end`, `error`…). */
  status: string | null;
  reason: string | null;
  bundle: ProofBundle | null;
  /**
   * Explanations drawn from the generated history, one line each — trend
   * ("broken for the last 5 runs"), prior failure shapes, heal pressure.
   */
  history: readonly string[];
  /**
   * The sheet's own spelling of the id when `id` was qualified (CG-04:
   * `BE:PL_03_01` runs as one case, the sheet still says `PL_03_01`), and the
   * workbook sheet / category the row came from. Optional — a ledger written
   * before the parser recorded them carries none, and the bundle's own
   * provenance stamp is read as the fallback (`provenanceExtras`).
   */
  sheetCaseId?: string | undefined;
  sheet?: string | undefined;
  category?: string | undefined;
}

/** The sheet-side identity of a case: the row's own fields first, the bundle's stamp second. */
function sheetIdentity(c: CatalogReportCase): { sheetCaseId: string | null; label: string | null } {
  const stamped = provenanceExtras(c.bundle);
  const label = sheetLabel({ sheet: c.sheet ?? stamped.sheet, category: c.category ?? stamped.category });
  return { sheetCaseId: c.sheetCaseId ?? stamped.sheetCaseId, label };
}

export interface CatalogReportInput {
  title: string;
  runKey: string | null;
  generatedAt: string | null;
  cases: readonly CatalogReportCase[];
  /**
   * True while the run that produces this report is still going: the page
   * says so and reloads itself, since rows are still being filled in.
   */
  live?: boolean | undefined;
  /**
   * Where a screenshot goes when the inline budget is spent: it is handed the
   * case id, the step index and the base64, and returns the href to link, or
   * null when it cannot take it (then the report says the shot stays in the
   * proof bundle, exactly as today). Absent means inline-or-omit, the old
   * behaviour, which is what every small run and every test gets by default.
   */
  spillScreenshot?: ((caseId: string, stepIndex: number, base64: string) => string | null) | undefined;
  /**
   * Where a recording goes when it is not carried inline: handed the case id
   * and the base64 webm, returns the href to play from, or null when it
   * cannot take it (then the report says the recording is in the proof
   * bundle). Absent means inline, the old behaviour.
   */
  spillRecording?: ((caseId: string, base64: string) => string | null) | undefined;
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 120) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

/** The chip class + label a verdict renders as — the two-family taxonomy. */
export function verdictChipOf(c: CatalogReportCase): { cls: string; label: string } {
  if (c.verdict === 'never-ran') return { cls: 'never', label: 'never ran' };
  if (c.verdict === 'blocked') return { cls: 'never', label: 'blocked' };
  // Two reasons a case ends in review, two colours: a wording near-miss a
  // human must rule on (proved-?), and a case the sheet gave no oracle for —
  // wholly record-only, judged by its captures (CG-09). The second is not a
  // "needs review" of anything the machine claimed; it claimed nothing.
  if (c.verdict === 'review') return recordOnlyCase(c) ? { cls: 'record', label: 'recorded only' } : { cls: 'review', label: 'needs review' };
  if (c.verdict === 'passed') return { cls: 'pass', label: c.status === 'passed-with-issues' ? 'pass**' : 'passed' };
  const family = c.status === null ? 'test-failed' : verdictFamily(c.status);
  return family === 'system-error'
    ? { cls: 'error', label: 'system error' }
    : { cls: 'fail', label: c.status === 'dead-end' ? 'test failed (dead-end)' : 'test failed' };
}

export interface CatalogHeadline {
  readonly passed: number;
  readonly failed: number;
  readonly review: number;
  readonly noVerdict: number;
  readonly decided: number;
  readonly total: number;
}

export function catalogHeadline(cases: readonly CatalogReportCase[]): CatalogHeadline {
  let passed = 0;
  let failed = 0;
  let review = 0;
  let noVerdict = 0;
  for (const c of cases) {
    const { cls } = verdictChipOf(c);
    if (cls === 'pass') passed += 1;
    else if (cls === 'fail') failed += 1;
    else if (cls === 'review' || cls === 'record') review += 1;
    else noVerdict += 1;
  }
  return { passed, failed, review, noVerdict, decided: passed + failed, total: cases.length };
}

/* ------------------------------------------------------------ step detail */

interface MediaBudget {
  screenshotLeft: number;
  recordingLeft: number;
  inline: number;
  screenshotsSpilled: number;
  screenshotsOmitted: number;
  recordingsSpilled: number;
  recordingsOmitted: number;
  spillScreenshot: CatalogReportInput['spillScreenshot'];
  spillRecording: CatalogReportInput['spillRecording'];
}

function stepDetail(step: ProofStep, budget: MediaBudget, caseId: string): string {
  const rows: string[] = [];
  const row = (label: string, value: string | null | undefined, mono = true): void => {
    if (value === null || value === undefined || value === '') return;
    rows.push(`<div class="kv"><span>${esc(label)}</span><${mono ? 'code' : 'span'}>${esc(value)}</${mono ? 'code' : 'span'}></div>`);
  };
  row('intent', step.intent, false);
  row('selector', step.selector ?? stepTarget(step));
  // The kind's own facts: an either/or's alternatives, an upload's file
  // names, a sign-in's persona label, the author's timeout. Rendered as rows
  // so a step with no `selector` is still a step a reader can read.
  for (const fact of stepKindFacts(step)) row(fact.label, fact.value);
  if (step.resolvedSelector && step.resolvedSelector !== step.selector) row('resolved as', step.resolvedSelector);
  // The rung by name, then what it did — `reveal` and `scroll` are one-line
  // explanations here, not words a reader has to look up.
  const how = describeResolution(step.resolution);
  if (how !== null) row('resolution', `${step.resolution} — ${how.label}: ${how.explanation}`, false);
  // What the selector WAS: role, name, where it sat — and the red rectangle
  // in the still below is drawn around exactly this box.
  row('target', describeTarget(step.target), false);
  // Where the typed value came from when the sheet did not say — `generated`
  // is the one a reader must weigh.
  row('value', describeValueSource(step), false);
  row('url', step.url);
  for (const line of describeDbChanges(step.dbChanges)) row('db', line, false);
  if (step.dbProbeError) row('db probe', step.dbProbeError, false);
  if (step.error) rows.push(`<div class="kv err"><span>error</span><code>${esc(step.error)}</code></div>`);
  if (step.heal) {
    rows.push(
      `<div class="kv heal"><span>healed</span><code>${esc(step.heal.to)}</code>` +
        `<em>${esc(step.heal.strategy)} · confidence ${(step.heal.confidence * 100).toFixed(0)}%</em></div>`,
    );
  }
  if (step.agent) {
    const a = step.agent;
    // Each turn by what it was aimed at — `save` names the variable it filled,
    // `signOut` has no selector, `read` quotes what it saw (`describeAgentAction`).
    const turns = (a.actions ?? [])
      .map((t) => {
        const { target, note } = describeAgentAction(t);
        // A held action is a hold, not a miss: the typed outcome says the
        // harness withheld it (Phase B), and the line says so first.
        const held = t.outcome?.kind === 'blocked' ? `<em>held · ${esc(t.outcome.reason)}</em> ` : '';
        return `<li class="${t.ok ? 'ok' : 'no'}">${held}${esc(t.action)} <code>${esc(target)}</code>${note ? ` <em>${esc(note)}</em>` : ''}${t.error ? ` — ${esc(t.error)}` : ''}</li>`;
      })
      .join('');
    rows.push(
      (a.blocked === undefined
        ? ''
        : `<div class="kv held"><span>held</span><span>${esc(a.blocked.reason)} · ${esc(a.blocked.rule)} — no verdict about the application</span></div>`) +
        `<div class="agent"><div class="kv"><span>agent</span><span>${esc(a.summary ?? '')} (${a.turns} turn(s))</span></div>` +
        (turns === '' ? '' : `<ol class="turns">${turns}</ol>`) +
        '</div>',
    );
  }
  // What the agent READ off the page on an observe-and-record leg — the
  // evidence such a leg has (OA-14), quoted verbatim with where it was read.
  const observed = observedEvidence(step);
  if (observed.length > 0) {
    rows.push(
      `<div class="observed"><div class="kv"><span>observed</span><span>${observed.length} value(s) read off the page</span></div><ul class="turns">` +
        observed
          .map((o) => `<li><code>${esc(o.text)}</code>${o.selector ? ` <em>from ${esc(o.selector)}</em>` : ''}${o.url ? ` <em>at ${esc(o.url)}</em>` : ''}</li>`)
          .join('') +
        '</ul></div>',
    );
  }
  if (step.screenshot) {
    const isFailure = step.status !== 'passed' && step.status !== 'skipped';
    const size = step.screenshot.length;
    const withinCeiling = budget.inline + size <= REPORT_HTML_CEILING_BYTES;
    if (withinCeiling && (isFailure || budget.screenshotLeft >= size)) {
      if (!isFailure) budget.screenshotLeft -= size;
      budget.inline += size;
      rows.push(
        `<figure class="shot"><img loading="lazy" alt="step ${step.index} screenshot" src="data:image/jpeg;base64,${step.screenshot}"/></figure>`,
      );
    } else {
      const href = budget.spillScreenshot?.(caseId, step.index, step.screenshot) ?? null;
      if (href === null) {
        budget.screenshotsOmitted += 1;
        rows.push('<div class="kv muted"><span>screenshot</span><span>omitted for size — it stays in the proof bundle</span></div>');
      } else {
        budget.screenshotsSpilled += 1;
        rows.push(
          `<figure class="shot"><img loading="lazy" alt="step ${step.index} screenshot" src="${esc(href)}"/></figure>`,
        );
      }
    }
  }
  return rows.join('');
}

/**
 * The run on film, inside the case that produced it.
 *
 * **Inline base64 rides on an attribute and becomes a Blob URL in the page**,
 * as it does in `html-reporter.ts`: Chrome's media stack will not load a
 * `data:` video. A spilled recording is already a real `.webm` file, so its
 * relative `src` is left alone and needs no Blob indirection.
 *
 * **Inline recordings hydrate when the case is opened, not at load.** A
 * catalog holds dozens; decoding every one on first paint would stall the
 * page to build players nobody opened.
 */
function videoBlock(c: CatalogReportCase, budget: MediaBudget): { html: string; playable: boolean } {
  const video = c.bundle?.video;
  if (!video) return { html: '', playable: false };
  if (!video.data) {
    return {
      html: `<figure class="rec"><figcaption>Recording</figcaption><div class="muted">${esc(
        video.omitted ?? 'the recording could not be embedded',
      )}</div></figure>`,
      playable: false,
    };
  }
  const steps = c.bundle?.steps ?? [];
  const failing = steps.find((s) => s.status !== 'passed' && s.status !== 'skipped' && !s.superseded && s.videoOffsetMs !== undefined);
  const failureOffset = failing?.videoOffsetMs !== undefined
    ? ` data-failure-offset="${(failing.videoOffsetMs / 1000).toFixed(2)}"`
    : '';
  const size = video.data.length;
  const spillRecording = budget.spillRecording;
  const inline = spillRecording === undefined || (
    budget.recordingLeft >= size && budget.inline + size <= REPORT_HTML_CEILING_BYTES
  );
  if (inline) {
    budget.inline += size;
    if (spillRecording !== undefined) budget.recordingLeft -= size;
    return {
      html:
        `<figure class="rec">` +
        `<figcaption>Recording — the run as it happened<span class="hint">each step has “play from here”</span></figcaption>` +
        `<video controls preload="none" width="${esc(video.width)}" height="${esc(video.height)}"` +
        ` data-webm="${esc(video.data)}"${failureOffset}></video></figure>`,
      playable: true,
    };
  }
  const href = spillRecording(c.id, video.data);
  if (href === null) {
    budget.recordingsOmitted += 1;
    return {
      html: '<figure class="rec"><figcaption>Recording</figcaption><div class="muted">the recording could not be embedded — it stays in the proof bundle</div></figure>',
      playable: false,
    };
  }
  budget.recordingsSpilled += 1;
  return {
    html:
    `<figure class="rec">` +
    `<figcaption>Recording — the run as it happened<span class="hint">each step has “play from here”</span></figcaption>` +
    `<video controls preload="none" width="${esc(video.width)}" height="${esc(video.height)}"` +
    ` src="${esc(href)}"${failureOffset}></video></figure>`,
    playable: true,
  };
}

/**
 * The control that turns one recording into per-step evidence: every step in
 * the list is a cue point into the same file, so a reader never scrubs.
 *
 * It lives on the step's SUMMARY, not in its body. Measured in a browser: in
 * the body it is inside a collapsed `<details>`, so a reader has to expand
 * every step to discover that seeking exists at all — a control nobody can see
 * is not a control. The click handler calls `preventDefault`, which is what
 * stops a button inside a `<summary>` from toggling the step open as a side
 * effect of playing the film.
 */
function seekControl(step: ProofStep, hasVideo: boolean): string {
  if (!hasVideo || step.videoOffsetMs === undefined) return '';
  return `<button class="seek" type="button" data-seek="${(step.videoOffsetMs / 1000).toFixed(2)}">▶ play from here (${esc(
    fmtMs(step.videoOffsetMs),
  )} in)</button>`;
}

/* ------------------------------------------------------------- one case */

function historyBlock(lines: readonly string[]): string {
  if (lines.length === 0) return '';
  return (
    '<div class="history"><div class="cap">From the run history</div>' +
    lines.map((l) => `<div class="hline">${esc(l)}</div>`).join('') +
    '</div>'
  );
}

function timePane(steps: readonly ProofStep[]): string {
  const counted = steps.filter((s) => !s.superseded);
  const max = Math.max(1, ...counted.map((s) => s.durationMs));
  const total = counted.reduce((sum, s) => sum + s.durationMs, 0);
  const bars = counted
    .map((s) => {
      const width = Math.max(2, Math.round((s.durationMs / max) * 100));
      const slow = s.durationMs >= SLOW_STEP_MS ? ' slow' : '';
      const failed = s.status !== 'passed' && s.status !== 'skipped' ? ' broke' : '';
      return (
        `<div class="trow" data-step="${s.index}"><span class="tname">${s.index} ${esc(s.action)}</span>` +
        `<span class="tbar${slow}${failed}" style="width:${width}%"></span>` +
        `<span class="tms${slow}">${esc(fmtMs(s.durationMs))}</span></div>`
      );
    })
    .join('');
  const slowest = [...counted].sort((a, b) => b.durationMs - a.durationMs).slice(0, 3);
  return (
    `<div class="cap">Time record — ${esc(fmtMs(total))} across ${counted.length} step(s)</div>${bars}` +
    `<div class="tfoot">slowest: ${slowest.map((s) => `#${s.index} ${esc(s.action)} ${esc(fmtMs(s.durationMs))}`).join(' · ')}` +
    ` · amber = at/over the ${SLOW_STEP_MS / 1000}s fast-path budget</div>`
  );
}

/**
 * The per-case export: a download link to the case's own workbook. Relative
 * to this file, so it works wherever the reports folder travels — and via
 * wowUI's `/reports/` route, which serves the folder as a folder for exactly
 * this reason.
 */
function exportControl(c: CatalogReportCase, input: CatalogReportInput): string {
  const href = `${catalogMediaDirName(input.runKey, input.title)}/${catalogCaseExportName(c.id)}.xlsx`;
  return (
    `<a class="btn export-case" download href="${esc(href)}" onclick="event.stopPropagation()"` +
    ` title="This case as a workbook: one row per step, the step's log in the Proof column, its screenshot in the Photo column, the recording linked under every step">Export (Excel)</a>`
  );
}

function caseSection(c: CatalogReportCase, input: CatalogReportInput, budget: MediaBudget): string {
  const chip = verdictChipOf(c);
  const anchor = caseAnchor(c.id);
  const bundle = c.bundle;
  const steps = bundle?.steps ?? [];
  const video = videoBlock(c, budget);
  const film = video.html;
  // Seek buttons only where there is something to seek IN: a recording that
  // was never made would give a reader a control that silently does nothing.
  const hasVideo = video.playable;
  const left =
    steps.length === 0
      ? `<div class="muted">No steps were recorded${c.reason ? ` — ${esc(c.reason)}` : ''}.</div>`
      : steps
          .filter((s) => !s.superseded)
          .map((s) => {
            const tone = s.status === 'passed' ? 'ok' : s.status === 'skipped' ? 'skip' : 'no';
            return (
              `<details class="step ${tone}"><summary><b class="dot"></b>` +
              `<span class="sname">${s.index} ${esc(s.action)}</span>` +
              `<span class="ssub">${esc(s.intent ?? stepTarget(s) ?? '')}</span>` +
              `<span class="sms">${esc(fmtMs(s.durationMs))}</span>` +
              seekControl(s, hasVideo) +
              '</summary>' +
              `<div class="sbody">${stepDetail(s, budget, c.id)}</div></details>`
            );
          })
          .join('');
  const notes = (bundle?.notes ?? []).map((n) => `<div class="hline">${esc(n)}</div>`).join('');
  // The sheet's own id when the run qualified it (`BE:PL_03_01` on the row,
  // `PL_03_01` in the sheet), and the sheet/category the row came from — so
  // a reader holding the workbook finds the row, and a `--rerun-case` still
  // has the qualified id in front of them.
  const identity = sheetIdentity(c);
  const shownId = displayCaseId(c.id, identity.sheetCaseId);
  const scenarioSuffix = c.scenarioId === undefined ? '' : ` · ${c.scenarioId}`;
  const headingName = c.name === c.id
    ? `${c.id}${scenarioSuffix}`
    : c.name.startsWith(`${c.id} `)
      ? `${c.id}${scenarioSuffix}${c.name.slice(c.id.length)}`
      : c.name;
  const sheetChip = shownId.qualified
    ? `<span class="sid" title="the sheet's own spelling of this case id — the run qualified it to ${esc(shownId.qualified)} because the id repeats across or within sheets">sheet id ${esc(shownId.shown)}</span>`
    : '';
  const sheetTag = identity.label ? `<span class="ctag" title="the workbook sheet and category this case came from">${esc(identity.label)}</span>` : '';
  // A record-only case (CG-09) is judged by what it captured: the values are
  // listed FIRST in the case, before the steps, since they are its whole
  // deliverable and the reason it wears the `recorded only` colour.
  const captures = recordOnlyCase(c) ? recordedCaptures(bundle) : [];
  const capturesBlock = !recordOnlyCase(c)
    ? ''
    : `<div class="captures"><div class="cap">Recorded only — the sheet has no oracle; ${captures.length} value(s) captured for review</div>` +
      (captures.length === 0
        ? '<div class="hline muted">No values were captured — nothing to hand a reviewer.</div>'
        : captures.map((k) => `<div class="kv"><span>${esc(k.name)}</span><code>${esc(k.value)}</code></div>`).join('')) +
      '</div>';
  return (
    `<details class="case" id="${anchor}" data-name="${esc(c.name)}">` +
    `<summary><span class="chip ${chip.cls}">${esc(chip.label)}</span>` +
    `<span class="cname">${esc(headingName)}${sheetChip}${sheetTag}</span>` +
    (bundle ? `<span class="cms">${esc(fmtMs(bundle.caseDurationMs ?? bundle.durationMs))}</span>` : '') +
    exportControl(c, input) +
    '</summary>' +
    `<div class="split"><div class="steps-pane">${film}${capturesBlock}${historyBlock(c.history)}${left}` +
    (notes === '' ? '' : `<div class="history"><div class="cap">Run notes</div>${notes}</div>`) +
    `</div><div class="time-pane">${steps.length === 0 ? '<div class="muted">no timing — the case never ran</div>' : timePane(steps)}</div></div>` +
    '</details>'
  );
}

/* ------------------------------------------------------------- findings */

/** The anchor a case's section carries — what the findings block links to. */
function caseAnchor(id: string): string {
  return `case-${slugify(id)}`;
}

function memberChip(m: FindingCase, byId: ReadonlyMap<string, CatalogReportCase>): string {
  // The status exactly as the ledger sealed it — `error` reads `error`.
  const sealed = m.status ?? m.verdict;
  const via = m.dependsOn === undefined ? '' : ` <em title="listed here because it depends on ${esc(m.dependsOn)}">↳ depends on ${esc(m.dependsOn)}</em>`;
  const scenarioId = byId.get(m.id)?.scenarioId;
  const label = scenarioId === undefined ? m.id : `${m.id} · ${scenarioId}`;
  return `<span class="fcase"><a href="#${esc(caseAnchor(m.id))}">${esc(label)}</a> <code class="sealed">${esc(sealed)}</code>${via}</span>`;
}

function findingBlock(f: Finding, byId: ReadonlyMap<string, CatalogReportCase>): string {
  const counts = statusCounts(f.cases)
    .map((s) => `${esc(s.status)}: ${s.count}`)
    .join(' · ');
  const kv = (label: string, value: string | undefined): string =>
    value === undefined || value === '' ? '' : `<div class="kv"><span>${esc(label)}</span><code>${esc(value)}</code></div>`;
  return (
    `<details class="finding" data-key="${esc(f.key)}"><summary>` +
    `<span class="fkind">${esc(f.kind)}</span><span class="ftitle">${esc(f.title)}</span>` +
    `<span class="fcount">${f.cases.length} case${f.cases.length === 1 ? '' : 's'} · ${counts}</span></summary>` +
    `<div class="fbody">` +
    `<div class="kv"><span>cases</span><span class="fcases">${f.cases.map((m) => memberChip(m, byId)).join('')}</span></div>` +
    kv('where', f.where) +
    kv('asked', f.asked) +
    kv('offered', f.offered) +
    (f.evidence.length === 0
      ? ''
      : `<div class="kv"><span>evidence</span><ul class="turns">${f.evidence.map((e) => `<li><em>${esc(e.label)}</em> <code>${esc(e.value)}</code></li>`).join('')}</ul></div>`) +
    `</div></details>`
  );
}

/**
 * The block under the tally: the headline, one `<details>` per finding, the
 * unclustered remainder. Absent only when nothing failed — a run with no
 * non-passing case has no findings to lead with.
 */
function findingsSection(summary: FindingsSummary, cases: readonly CatalogReportCase[]): string {
  if (summary.nonPassing === 0) return '';
  const byId = new Map(cases.map((c) => [c.id, c] as const));
  const headline = findingsHeadline(summary);
  const unclustered =
    summary.unclustered.length === 0
      ? ''
      : `<details class="finding unclustered"><summary><span class="fkind">—</span><span class="ftitle">unclustered — no shared cause in the typed fields; each keeps its own section below</span>` +
        `<span class="fcount">${summary.unclustered.length} case${summary.unclustered.length === 1 ? '' : 's'}</span></summary>` +
        `<div class="fbody"><div class="kv"><span>cases</span><span class="fcases">${summary.unclustered.map((m) => memberChip(m, byId)).join('')}</span></div></div></details>`;
  return (
    `<section class="findings" id="findings"><div class="shead">Findings<span class="scount">${esc(headline)}</span></div>` +
    `<div class="fnote">Grouped by the failing step's typed fields — request, URL, control, hold, agent end — never by its message. Statuses are shown as the run sealed them.</div>` +
    summary.findings.map((finding) => findingBlock(finding, byId)).join('') +
    unclustered +
    '</section>'
  );
}

/**
 * Every `never ran` case in ONE list, the count on the summary line. A
 * 252-row remainder used to render 252 full sections a reader had to scroll
 * past; the ids are all still here, each in its own `<span>`.
 */
function neverRanSection(cases: readonly CatalogReportCase[]): string {
  if (cases.length === 0) return '';
  return (
    `<details class="never-ran" id="never-ran"><summary><span class="chip never">never ran</span>` +
    `<span class="cname">${cases.length} case${cases.length === 1 ? '' : 's'} never ran — listed here, not as a section each</span></summary>` +
    `<div class="fbody nlist">${cases
      .map((c) => `<span class="nid" id="${esc(caseAnchor(c.id))}" title="${esc(c.scenario)}${c.reason ? ` — ${esc(c.reason)}` : ''}">${esc(c.id)}${c.scenarioId === undefined ? '' : ` · ${esc(c.scenarioId)}`}</span>`)
      .join('')}</div></details>`
  );
}

/* ------------------------------------------------------------- the page */

/**
 * The player script, shared by this page and by every case exported from it.
 *
 * Kept as its own string precisely so an export can carry either an inline
 * `<video data-webm="…">` or a relative file-backed `<video src="…">`.
 */
const PLAYER_SCRIPT = `
function wowHydrateVideo(v) {
  if (!v || v.dataset.wowReady) return;
  var b64 = v.getAttribute('data-webm') || '';
  if (!b64 && !v.hasAttribute('src')) return;
  v.dataset.wowReady = '1';
  if (b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    v.src = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
  }
  /* data-webm deliberately STAYS. A hydrated player's src is a Blob URL, which
     means nothing in another document — and every export here is another
     document. Leaving the bytes on the attribute is what makes an exported
     case playable whether or not it had been opened first. */
  /* On a case that broke, the player opens ON the failure: the recording is
     kept because a step failed, and that is the frame worth showing first. */
  var at = parseFloat(v.getAttribute('data-failure-offset') || '');
  if (!isNaN(at)) {
    v.addEventListener('loadedmetadata', function () {
      if (at < (v.duration || Infinity)) v.currentTime = at;
    });
  }
}
/* Decoded when the case is opened, never at load: a catalog holds dozens of
   recordings and building every Blob on first paint would stall the page to
   make players nobody opened. */
function wowWireCase(node) {
  node.addEventListener('toggle', function () {
    if (node.open) node.querySelectorAll('video').forEach(wowHydrateVideo);
  });
}
document.addEventListener('click', function (e) {
  var b = e.target.closest && e.target.closest('.seek');
  if (!b) return;
  e.preventDefault();
  var scope = b.closest('.case') || document;
  var v = scope.querySelector('video');
  if (!v) return;
  wowHydrateVideo(v);
  v.currentTime = parseFloat(b.getAttribute('data-seek') || '0') || 0;
  v.play();
  v.scrollIntoView({ block: 'nearest' });
});
document.querySelectorAll('details.case').forEach(wowWireCase);
/* An exported single case is already open, so its toggle never fires. */
document.querySelectorAll('body.single video').forEach(wowHydrateVideo);
`;

const EXPORT_SCRIPT = `
function download(name, html) {
  var blob = new Blob([html], { type: 'text/html' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
}
/* A Blob URL is scoped to THIS document, so strip it only from inline videos;
   a relative file-backed src is the portable value and must stay. */
function wowStripBlobs(root) {
  root.querySelectorAll('video[data-webm]').forEach(function (v) {
    v.removeAttribute('src');
    delete v.dataset.wowReady;
  });
}
function exportCatalog() {
  var doc = document.documentElement.cloneNode(true);
  wowStripBlobs(doc);
  download((document.title || 'catalog-report') + '.html', '<!doctype html>' + doc.outerHTML);
}
`;

const STYLE = `
body { max-width: 1200px; margin: 0 auto; padding: 24px; font: 14px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
h1 { font-size: 20px; margin: 0 0 4px; }
.meta { color: var(--muted); font-size: 12px; margin-bottom: 18px; }
.headline { border: 1px solid var(--line); border-radius: 10px; background: var(--panel); padding: 14px 16px; margin: 14px 0 10px; }
.headline-counts { display: flex; align-items: baseline; gap: 24px; flex-wrap: wrap; }
.headline-count { display: grid; gap: 1px; }
.headline-count b { font-size: 28px; line-height: 1; font-variant-numeric: tabular-nums; }
.headline-count span { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
.headline-count.pass b { color: var(--pass, #2e7d32); }
.headline-count.fail b { color: #c0392b; }
.headline-count.never b { color: var(--muted); }
.headline-count.review b { color: #6a5acd; font-size: 19px; }
.headline-rates { margin-top: 10px; font-size: 12px; }
.headline-rates div + div { color: var(--muted); }
.tally { display: flex; gap: 14px; flex-wrap: wrap; margin: 10px 0 22px; font-size: 13px; }
.scenario { margin: 22px 0 8px; }
.scenario > .shead { font-weight: 600; font-size: 15px; padding: 6px 0; border-bottom: 1px solid var(--line); display: flex; gap: 10px; align-items: baseline; }
.scenario > .shead .scount { color: var(--muted); font-weight: 400; font-size: 12px; }
.chip { font-size: 11px; border-radius: 999px; padding: 2px 9px; white-space: nowrap; }
.chip.pass { background: color-mix(in srgb, var(--pass, #2e7d32) 15%, transparent); color: var(--pass, #2e7d32); }
.chip.fail { background: color-mix(in srgb, #c0392b 14%, transparent); color: #c0392b; }
.chip.error { background: color-mix(in srgb, #b8860b 16%, transparent); color: #b8860b; }
.chip.review { background: color-mix(in srgb, #6a5acd 14%, transparent); color: #6a5acd; }
/* Recorded only: its own colour — not the violet of a wording near-miss, and
   never green. The case claimed nothing; a person reads its captures. */
.chip.record { background: color-mix(in srgb, #1f7a8c 14%, transparent); color: #1f7a8c; border: 1px dashed #1f7a8c; }
.chip.never { background: color-mix(in srgb, var(--muted) 18%, transparent); color: var(--muted); }
.sid { font-size: 11px; color: var(--muted); margin-left: 8px; font-family: ui-monospace, monospace; }
.ctag { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 1px 7px; margin-left: 8px; }
.captures { background: color-mix(in srgb, #1f7a8c 8%, transparent); border-radius: 8px; padding: 8px 12px; margin: 8px 0; }
.captures .kv code { color: #1f7a8c; }
.observed em, .turns em { color: var(--muted); font-style: normal; font-size: 11px; }
details.case { border: 1px solid var(--line); border-radius: 10px; margin: 8px 0; background: var(--panel, transparent); }
details.case > summary { display: flex; align-items: center; gap: 10px; padding: 9px 12px; cursor: pointer; list-style: none; }
details.case > summary .cname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
details.case > summary .cms { color: var(--muted); font-variant-numeric: tabular-nums; }
.btn { font: inherit; font-size: 12px; border: 1px solid var(--line); background: transparent; color: inherit; border-radius: 7px; padding: 3px 10px; cursor: pointer; text-decoration: none; }
.btn[disabled] { opacity: .45; cursor: not-allowed; }
.meta.live { color: var(--warn, #b8860b); }
.split { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 18px; padding: 4px 14px 16px; }
@media (max-width: 900px) { .split { grid-template-columns: 1fr; } }
.cap { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 10px 0 6px; }
details.step { border-left: 3px solid var(--line); margin: 4px 0; }
details.step.no { border-left-color: #c0392b; }
details.step.skip { color: var(--muted); }
details.step.ok .dot { background: var(--pass, #2e7d32); }
details.step.no .dot { background: #c0392b; }
details.step.skip .dot { background: var(--muted); }
details.step > summary { display: flex; gap: 8px; align-items: baseline; padding: 4px 8px; cursor: pointer; list-style: none; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; align-self: center; }
.sname { font-weight: 600; white-space: nowrap; }
.ssub { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--muted); font-size: 12px; }
.sms { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 12px; }
.sbody { padding: 6px 10px 10px 22px; }
.kv { display: flex; gap: 10px; font-size: 12px; margin: 3px 0; }
.kv > span:first-child { color: var(--muted); flex: none; width: 82px; }
.kv code { word-break: break-all; white-space: pre-wrap; }
.kv.err code { color: #c0392b; }
.kv.heal code { color: #b8860b; }
.muted { color: var(--muted); }
.shot img { max-width: 100%; border: 1px solid var(--line); border-radius: 6px; margin-top: 6px; }
.history { background: color-mix(in srgb, var(--muted) 7%, transparent); border-radius: 8px; padding: 8px 12px; margin: 8px 0; }
.hline { font-size: 12px; margin: 3px 0; }
.turns { font-size: 12px; margin: 4px 0 0 14px; padding: 0; }
.turns li.no { color: #c0392b; }
.time-pane { border-left: 1px solid var(--line); padding-left: 16px; }
.trow { display: grid; grid-template-columns: 110px 1fr 52px; gap: 8px; align-items: center; margin: 3px 0; font-size: 11px; }
.tname { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--muted); }
.tbar { height: 8px; border-radius: 4px; background: var(--pass, #2e7d32); opacity: .75; min-width: 2px; }
.tbar.slow { background: #b8860b; }
.tbar.broke { background: #c0392b; }
.tms { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); }
.tms.slow { color: #b8860b; }
.tfoot { font-size: 11px; color: var(--muted); margin-top: 10px; }
body.single .split { grid-template-columns: minmax(0, 1fr) 340px; }
.rec { margin: 0 0 14px; padding: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
.rec figcaption { display: flex; gap: 10px; align-items: baseline; font-size: 11px; text-transform: uppercase;
  letter-spacing: .06em; color: var(--muted); margin-bottom: 8px; }
.rec figcaption .hint { text-transform: none; letter-spacing: 0; margin-left: auto; }
.rec video { display: block; width: 100%; height: auto; max-height: 60vh; border-radius: 4px; background: #000; }
.seek { font: inherit; font-size: 11px; cursor: pointer; padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--line); background: transparent; color: var(--muted); white-space: nowrap; margin-left: 8px; }
.seek:hover { border-color: var(--fg); color: var(--fg); }
.findings { margin: 4px 0 18px; }
.findings > .shead { font-weight: 600; font-size: 15px; padding: 6px 0; border-bottom: 1px solid var(--line); display: flex; gap: 10px; align-items: baseline; }
.findings > .shead .scount { color: var(--muted); font-weight: 400; font-size: 12px; }
.fnote { font-size: 11px; color: var(--muted); margin: 6px 0 8px; }
details.finding { border: 1px solid var(--line); border-left: 3px solid #c0392b; border-radius: 8px; margin: 6px 0; background: var(--panel, transparent); }
details.finding.unclustered { border-left-color: var(--muted); }
details.finding > summary { display: flex; align-items: baseline; gap: 10px; padding: 7px 12px; cursor: pointer; list-style: none; }
.fkind { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 1px 7px; flex: none; }
.ftitle { flex: 1; min-width: 0; }
.fcount { color: var(--muted); font-size: 12px; white-space: nowrap; }
.fbody { padding: 4px 14px 12px; }
.fcases { display: flex; flex-wrap: wrap; gap: 6px 14px; }
.fcase a { font-family: ui-monospace, monospace; }
.fcase .sealed { font-size: 11px; color: var(--muted); }
.fcase em { font-size: 11px; color: var(--muted); font-style: normal; }
details.never-ran { border: 1px dashed var(--line); border-radius: 10px; margin: 8px 0 18px; }
details.never-ran > summary { display: flex; align-items: center; gap: 10px; padding: 9px 12px; cursor: pointer; list-style: none; }
.nlist { display: flex; flex-wrap: wrap; gap: 4px 12px; font-family: ui-monospace, monospace; font-size: 12px; color: var(--muted); }
`;

export function renderCatalogReport(input: CatalogReportInput): string {
  const budget: MediaBudget = {
    screenshotLeft: SCREENSHOT_BUDGET_BYTES,
    recordingLeft: RECORDING_BUDGET_BYTES,
    inline: 0,
    screenshotsSpilled: 0,
    screenshotsOmitted: 0,
    recordingsSpilled: 0,
    recordingsOmitted: 0,
    spillScreenshot: input.spillScreenshot,
    spillRecording: input.spillRecording,
  };
  const findings = buildFindingsSummary(input.cases);
  const headline = catalogHeadline(input.cases);
  const passRate = headline.decided === 0 ? null : Math.round((headline.passed / headline.decided) * 100);
  const coverageRate = headline.total === 0 ? 0 : Math.round((headline.decided / headline.total) * 100);
  const headlineHtml =
    `<section class="headline"><div class="headline-counts">` +
    `<div class="headline-count pass"><b>${esc(headline.passed)}</b><span>passed</span></div>` +
    `<div class="headline-count fail"><b>${esc(headline.failed)}</b><span>failed</span></div>` +
    `<div class="headline-count never"><b>${esc(headline.noVerdict)}</b><span>no verdict</span></div>` +
    (headline.review === 0
      ? ''
      : `<div class="headline-count review"><b>${esc(headline.review)}</b><span>review</span></div>`) +
    `</div><div class="headline-rates">` +
    (passRate === null
      ? ''
      : `<div>pass rate ${esc(passRate)}% — ${esc(headline.passed)} of ${esc(headline.decided)} cases that reached a verdict</div>`) +
    `<div>${esc(headline.decided)} of ${esc(headline.total)} cases have a verdict (${esc(coverageRate)}%)</div>` +
    `</div></section>`;
  const neverRan = input.cases.filter((c) => c.verdict === 'never-ran');
  const byScenario = new Map<string, CatalogReportCase[]>();
  for (const c of input.cases) {
    const key = c.scenario || 'ungrouped';
    const cases = byScenario.get(key);
    if (cases === undefined) byScenario.set(key, [c]);
    else cases.push(c);
  }
  const tally = new Map<string, number>();
  for (const c of input.cases) {
    const { label } = verdictChipOf(c);
    tally.set(label, (tally.get(label) ?? 0) + 1);
  }
  const sections = [...byScenario.entries()]
    .map(([scenario, cases]) => {
      // Passed of N first, then the rest APART — failed, awaiting review /
      // recorded only, no verdict, never ran — so a scenario whose harness
      // fell over on three rows does not read as three product defects.
      const counts = describeVerdictCounts(countVerdicts(cases), {
        review: cases.filter((c) => c.verdict === 'review').every((c) => recordOnlyCase(c)) ? 'recorded only' : 'awaiting review',
      });
      // The counts still speak for every planned row; the sections are the
      // cases that ran — a `never ran` row lives in the fold above.
      return (
        `<section class="scenario"><div class="shead">${esc(scenario)}` +
        `<span class="scount">${esc(counts)}</span></div>` +
        cases
          .filter((c) => c.verdict !== 'never-ran')
          .map((c) => caseSection(c, input, budget))
          .join('') +
        '</section>'
      );
    })
    .join('');
  const omittedNote =
    budget.screenshotsOmitted === 0
      ? ''
      : `<div class="meta">${budget.screenshotsOmitted} routine screenshot(s) omitted to keep this file portable — every one stays in its proof bundle.</div>`;
  const mediaDirName = catalogMediaDirName(input.runKey, input.title);
  const spillParts = [
    budget.screenshotsSpilled === 0
      ? ''
      : `${budget.screenshotsSpilled} screenshot(s) written beside this file in ${esc(mediaDirName)}/shots/`,
    budget.recordingsSpilled === 0
      ? ''
      : `${budget.recordingsSpilled} recording(s) written beside this file in ${esc(mediaDirName)}/`,
  ].filter((part) => part !== '');
  const spillNote = spillParts.length === 0 ? '' : `<div class="meta">${spillParts.join(' · ')}</div>`;
  const finished = input.cases.filter((c) => c.verdict !== 'never-ran').length;
  // A live report reloads itself: its rows are still being filled in, and a
  // reader who opened it from the panel mid-run should not have to know that.
  const liveNote = input.live
    ? `<div class="meta live">▶ in progress — ${finished} of ${input.cases.length} case(s) finished · this page refreshes itself every 60s</div>`
    : '';
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"/>' +
    `<meta name="viewport" content="width=device-width, initial-scale=1"/>` +
    (input.live ? '<meta http-equiv="refresh" content="60"/>' : '') +
    `<title>${esc(input.title)}</title>` +
    `<style>${grimTheme()}</style><style>${STYLE}</style></head><body>` +
    `<h1>${esc(input.title)}</h1>` +
    `<div class="meta">${esc(input.runKey ?? '')}${input.generatedAt ? ` · authored ${esc(input.generatedAt)}` : ''} · ${input.cases.length} case(s)` +
    ` <button class="btn" onclick="exportCatalog()">Export catalog</button>` +
    // The run writes this workbook beside the report (see `excel-export.ts`):
    // every planned case, one row per step, the screenshot in a Photo
    // column and a video row under every step. A relative link, so it works
    // wherever the reports folder travels as a whole.
    ` <a class="btn" download href="${esc(`${catalogReportBase(input.runKey, input.title)}-cases.xlsx`)}"` +
    ` title="Written beside this report: every planned case, one step per row, photos embedded within budget, video linked under every step">Cases (Excel)</a></div>` +
    liveNote +
    headlineHtml +
    `<div class="tally">${[...tally.entries()].map(([label, n]) => `<span>${esc(label)}: <b>${n}</b></span>`).join('')}</div>` +
    findingsSection(findings, input.cases) +
    neverRanSection(neverRan) +
    spillNote +
    omittedNote +
    sections +
    // The player source is also a VALUE in the page so a copy of it can carry
    // the player into another document — see `PLAYER_SCRIPT`.
    `<script>var WOW_PLAYER = ${JSON.stringify(PLAYER_SCRIPT)};</script>` +
    `<script>${EXPORT_SCRIPT}</script>` +
    `<script>${PLAYER_SCRIPT}</script></body></html>`
  );
}

/** The file-name stem a run's report artifacts share (`<runKey slug>`). */
export function catalogReportBase(runKey: string | null, title: string): string {
  return slugify((runKey ?? title).replace(/@/g, '-')) || 'catalog-report';
}

/** `<runKey slug>-media` — the folder beside the report holding per-case workbooks and recordings. */
export function catalogMediaDirName(runKey: string | null, title: string): string {
  return `${catalogReportBase(runKey, title)}-media`;
}

/** `PL_06_05` → `pl-06-05` — the file-name stem a case's export artifacts share. */
export function catalogCaseExportName(caseId: string): string {
  return slugify(caseId) || 'case';
}

/** `reports/<runKey slug>.html` — stable per run key, so a resume overwrites its own file. */
export function catalogReportPath(runKey: string | null, title: string, cwd = process.cwd()): string {
  return resolve(cwd, CATALOG_REPORT_DIR, `${catalogReportBase(runKey, title)}.html`);
}

export async function writeCatalogReport(path: string, html: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, html, 'utf8');
  return path;
}
