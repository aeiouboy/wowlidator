/**
 * Rich HTML report.
 *
 * One self-contained file — inline CSS, inline JS, screenshots embedded as
 * data URIs — so it can be emailed, attached to a CI job, or opened off a USB
 * stick with no server and no network. Nothing is fetched at view time.
 *
 * The report's job is to make three things impossible to miss: where the
 * healer fired, where the agent took over, and what's actually broken.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import type { RequestRecord } from '../api/api-client.js';
import type { DbCheckRecord } from '../db/db-actions.js';
import { classifyCall, isBlockingFailure, type NetworkCall } from '../api/network-observer.js';
import { BACKEND_TIER_ACTIONS,
  describeValueSource,
  valueWasGenerated,
  describeTarget,
  familyLabel,
  meaningfulCoverage,
} from '../engine/proof-bundle.js';
import { buildVerdict, escalationTrace, type Verdict } from './verdict.js';
import { describeDbChanges } from '../engine/proof-bundle.js';
import {
  RESOLUTION_EXPLANATIONS,
  describeAgentAction,
  describeResolution,
  displayCaseId,
  observedEvidence,
  provenanceExtras,
  recordedCaptures,
  sheetLabel,
  stepKindFacts,
  stepTarget,
  visibleDetail,
  type AgentActionLike,
} from './step-facts.js';
import type {
  AgentRecord,
  BlockedOutcome,
  StepDecision,
  DataCaseResult,
  DataRetryRecord,
  Defect,
  DialogRecord,
  ProofBundle,
  ProofStep,
} from '../engine/proof-bundle.js';
import { GRIM_BASE, GRIM_COMPONENTS, GRIM_TOKENS } from './theme.js';

export const DEFAULT_REPORT_FILENAME = 'wowlidator-report.html';
export const DEFAULT_REPORT_DIR = '.wowlidator/reports';

/** Placeholders accepted inside a `--report` path. */
export const REPORT_PLACEHOLDERS = [
  'runId',
  'name',
  'kind',
  'index',
  'status',
  'date',
  'timestamp',
  'group',
] as const;
export type ReportPlaceholder = (typeof REPORT_PLACEHOLDERS)[number];

/** Where a report should be written. */
export interface ReportTarget {
  /**
   * Explicit destination. A file path, a directory (trailing separator or an
   * existing directory), or either with `{placeholders}`.
   */
  path?: string | undefined;
  /** Directory used when `path` is absent. */
  dir?: string | undefined;
  /** False skips writing entirely. */
  enabled?: boolean | undefined;
  /** Filename used when the destination resolves to a directory. */
  defaultFilename?: string | undefined;
}

/** Values available for substitution into a report path. */
export interface ReportNameContext {
  runId: string;
  name: string;
  status: string;
  /** 1-based position when a command writes several reports. */
  index?: number | undefined;
  /** Generated-case kind (`functional`, `edge-case`, …). */
  kind?: string | undefined;
  /**
   * Subfolder to nest this report under, so one command's output stays
   * together instead of spilling loose files into the reports directory.
   * Slugified like any other model-supplied name. Typically the page under
   * test — see `reportGroupForUrl`.
   */
  group?: string | undefined;
  /** Defaults to now. Injectable so tests are deterministic. */
  now?: Date | undefined;
}

const MAX_SLUG_LENGTH = 48;

/**
 * Reduce arbitrary text to a safe filename fragment.
 *
 * Load-bearing for safety, not just tidiness: `name` and `kind` can come from
 * a model, and a case called `../../etc/passwd` must not be able to steer a
 * write out of the intended directory. Everything outside `[a-z0-9-]` goes.
 */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
  return slug === '' ? 'report' : slug;
}

/** Does this resolved path already exist as a directory on disk? */
function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function substitutions(context: ReportNameContext): Record<ReportPlaceholder, string> {
  const now = context.now ?? new Date();
  const iso = now.toISOString();
  return {
    runId: context.runId,
    name: slugify(context.name),
    kind: slugify(context.kind ?? 'run'),
    index: context.index === undefined ? '' : String(context.index).padStart(2, '0'),
    status: slugify(context.status),
    group: context.group === undefined || context.group === '' ? '' : slugify(context.group),
    date: iso.slice(0, 10),
    // Filesystem-safe ISO: 2026-07-29T04-33-08
    timestamp: iso.slice(0, 19).replace(/:/g, '-'),
  };
}

/**
 * Filename used when the destination is a directory rather than a file.
 *
 * Inside a group folder the `wowlidator-report-` prefix is dropped: the folder
 * already says what these are, and repeating it on every file only makes the
 * index and kind harder to read at a glance.
 */
export function defaultReportFilename(context: ReportNameContext): string {
  const grouped = context.group !== undefined && context.group !== '';
  // Inside a page folder the flow's own name is the useful label — `report.html`
  // would collide the moment a second flow targets the same page.
  if (context.index === undefined) {
    return grouped ? `${slugify(context.name)}.html` : DEFAULT_REPORT_FILENAME;
  }
  const parts = [String(context.index).padStart(2, '0')];
  if (context.kind) parts.push(slugify(context.kind));
  parts.push(slugify(context.name));
  return grouped ? `${parts.join('-')}.html` : `wowlidator-report-${parts.join('-')}.html`;
}

/**
 * Turn the page under test into a folder name.
 *
 * The path is what distinguishes one page from another within a run, so it
 * leads; the host is only included when there is no path to speak of, which
 * keeps `.../benefits/rules` from becoming `localhost-3000-en-admin-...`.
 */
export function reportGroupForUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/+|\/+$/g, '');
    return slugify(path === '' ? parsed.host : path);
  } catch {
    return slugify(url);
  }
}

/**
 * Work out the absolute path a report should be written to.
 *
 * Returns `null` when reporting is disabled, so callers branch once rather
 * than threading an "are reports on" flag through every call site.
 */
export function resolveReportPath(
  target: ReportTarget,
  context: ReportNameContext,
): string | null {
  if (target.enabled === false) return null;

  const filename = target.defaultFilename ?? defaultReportFilename(context);
  // Slugified because it can carry a model-chosen name or a raw URL path —
  // the same path-traversal guard the filename gets.
  const group =
    context.group === undefined || context.group === '' ? null : slugify(context.group);

  if (target.path !== undefined && target.path !== '') {
    let expanded = target.path;
    for (const [key, value] of Object.entries(substitutions(context))) {
      expanded = expanded.replaceAll(`{${key}}`, value);
    }
    // Collapse artefacts left by an empty {index} on a single-report run.
    expanded = expanded.replace(/--+/g, '-').replace(/-(\.[A-Za-z0-9]+)$/, '$1');

    // Check the trailing separator *before* resolving — `resolve` strips it.
    const explicitDir = expanded.endsWith('/') || expanded.endsWith('\\');
    const base = target.dir !== undefined && !isAbsolute(expanded) ? target.dir : '.';
    const candidate = resolve(base, expanded);
    // An explicit path that names a *file* is honoured as written — the caller
    // said exactly where it wants this. Grouping only applies to destinations
    // that are directories, where the nesting has somewhere to go.
    if (!explicitDir && !isExistingDirectory(candidate)) return candidate;
    return group === null ? join(candidate, filename) : join(candidate, group, filename);
  }

  const dir = target.dir ?? DEFAULT_REPORT_DIR;
  return group === null ? resolve(dir, filename) : resolve(dir, group, filename);
}

/** Convenience: resolve a destination from a bundle, then write it. */
export async function writeReport(
  bundle: ProofBundle,
  target: ReportTarget,
  context?: Partial<ReportNameContext>,
): Promise<string | null> {
  const path = resolveReportPath(target, {
    runId: bundle.runId,
    name: bundle.name,
    status: bundle.status,
    ...context,
  });
  if (path === null) return null;
  return writeHtmlReport(bundle, path);
}

/** Escape for text nodes and attribute values alike. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

/**
 * Reader-facing names for the escalation rungs.
 *
 * The precise terms survive in the Diagnostics layer and in the JSON — this map
 * is only for the timeline, where the audience is whoever is triaging a red
 * run, not whoever maintains the ladder. `fast` has no label at all: "it
 * worked normally" is not information worth a badge on every green step.
 */
const RESOLUTION_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(RESOLUTION_EXPLANATIONS).map(([rung, { label }]) => [rung, label]),
);

/**
 * Every resolution's explanation, keyed by its reader-facing label — the
 * half of the glossary that comes from `step-facts.ts`, so a rung added there
 * (`reveal`, `scroll`, 2026-09-03) is explained here without a second edit.
 */
const RESOLUTION_GLOSSARY: Record<string, string> = Object.fromEntries(
  Object.values(RESOLUTION_EXPLANATIONS).map(({ label, explanation }) => [label, explanation]),
);

/**
 * Plain-language expansion for every term of art the report still shows.
 *
 * Rendered as `<abbr title=…>`, so a term is explained where it is met rather
 * than in a legend nobody scrolls to. There is a test asserting every badge
 * this file can emit has an entry here — a new badge with no explanation is
 * exactly the failure this section exists to fix.
 */
export const GLOSSARY: Record<string, string> = {
  // Every resolution rung's label, explained — see `RESOLUTION_EXPLANATIONS`.
  ...RESOLUTION_GLOSSARY,
  'value generated':
    'The sheet left this value as a placeholder or a description, and no test data, document, repository or database source named a real one — so the author invented a well-formed stand-in. The step ran with it; judge the result knowing the input was not the sheet\'s.',
  'matched as exact text':
    'A text selector that did not match as written, re-matched for free against what the page actually contains: an unquoted substring form narrowed to exact text when it hit several elements, or a quoted exact form relaxed to a substring when the page renders the value with formatting around it (a currency prefix, decimals). Either way the asserted text is on the page; the selector was written tighter or broader than the rendering.',
  'recorded only':
    'Every Expected line of this case says "record what the system shows" — an open question, not a claim — so nothing was asserted. The values the run captured are listed for a person to compare against the sheet; the case ends in review, never green.',
  observed:
    'What the workflow agent READ off the live page during this step, quoted verbatim. An observation is evidence the way a screenshot is; the agent\'s own summary of the leg is a claim.',
  'agent takeover':
    'A model drove the browser directly for this step, deciding one action at a time, rather than the runner following a selector the test supplied.',
  'agent decided':
    'The step met something the flow does not describe — a consent screen, a notice, an onboarding step — so the agent was asked to look, judge what was in the way, and choose what to do. What it judged and chose is recorded below in its own words; whether the step then worked is the separate, harder fact. Add the step that handles this interaction so the run stops paying a model to rediscover it.',
  backend:
    'This step exercised the backend directly — HTTP the test made, traffic the page made (expectCalls), or a database check — rather than driving the page.',
  quarantined:
    'Known-flaky: this case alternates between passing and failing, so its result is reported but not counted as a failure.',
  'resolved late':
    'The content appeared, but only when given the longer healed-selector window — slower than the fast-path budget. The feature works; the page is slow or hydrates late, and a timing defect records it.',
  'passed, in doubt':
    'This absence check passed after an earlier step in the run had already failed. "Not shown" is also what a broken page looks like, so this pass is true but is not evidence the feature works.',
  downstream:
    'This step failed after an earlier step had already failed — its failure may be a consequence of that one, not an independent finding. Fix the first failure and re-read this one.',
  superseded:
    'This failed attempt was followed by a successful in-run reconstruction of the same step, so it is an attempt, not the outcome — it counts toward nothing. It is folded under the step that replaced it, because what was tried is evidence.',
  'reconstructed in-run':
    'The step as written failed, and the repair model rebuilt it against the live page mid-run. The run is green, but the flow no longer matches the application — update the step so the suite stops paying a model every run.',
};

/**
 * Text captured from the application under test, marked as such (spec R5).
 *
 * Two rules, both about not misrepresenting evidence:
 *
 * - **Never translated.** A report is evidence; a translated string is a claim
 *   about evidence. An app that renders "ประเมินทดลองงาน" is quoted exactly.
 * - **Marked `lang`, never guessed at.** A screen reader reading Thai with an
 *   English voice is unintelligible, and the report interleaves wowlidator's own
 *   English prose with captured strings constantly. `lang=""` on the span tells
 *   assistive technology "this is not the document language, do not assume" —
 *   which is honest, where naming a specific language we did not detect would
 *   not be.
 */
function captured(value: unknown): string {
  const text = String(value ?? '');
  // Only mark it when it actually leaves the Latin script — otherwise every
  // selector in the report grows an attribute that says nothing.
  const nonLatin = /[^\u0000-\u024F\u2000-\u206F]/.test(text);
  return nonLatin ? `<span lang="" class="captured">${esc(text)}</span>` : esc(text);
}

/** Wrap a term in its explanation, when we have one. */
function term(label: string): string {
  const explanation = GLOSSARY[label];
  return explanation
    ? `<abbr title="${esc(explanation)}">${esc(label)}</abbr>`
    : esc(label);
}

/**
 * Layer 1: the block that answers what broke, whose it is, and whether it is
 * new — before any of the machinery. Built entirely by `buildVerdict`, so the
 * wording is unit-tested rather than buried in a template.
 */
function verdictBlock(verdict: Verdict): string {
  const lines = [verdict.what, verdict.side, verdict.history].filter(
    (line): line is string => typeof line === 'string' && line.length > 0,
  );
  const owner = verdict.owner
    ? `<span class="owner owner-${esc(verdict.owner)}">suggested owner: ${esc(verdict.owner)}</span>`
    : '';
  const jump =
    verdict.firstFailingStep === null
      ? ''
      : `<a class="jump" href="#step-${verdict.firstFailingStep}">go to the first failing step &rarr;</a>`;

  return `
  <section class="verdict ${esc(verdict.status)}">
    <h2 class="verdict-headline">${esc(verdict.headline)}</h2>
    ${lines.map((line) => `<p class="verdict-line">${esc(line)}</p>`).join('')}
    <div class="verdict-actions">${owner}${jump}</div>
  </section>`;
}

/** Absence assertions: a pass says "not shown", which a broken page also says. */
function isAbsenceAssertion(step: ProofStep): boolean {
  if (step.action === 'expectHidden') return true;
  if (step.action !== 'expectCount') return false;
  const detail = step.detail ?? {};
  return detail['count'] === 0 || detail['expected'] === 0;
}

function stepBadges(step: ProofStep, afterFailure = false): string {
  const badges: string[] = [];
  if (step.downstream) {
    badges.push(`<span class="badge res-jit">${term('downstream')}</span>`);
  }
  if (step.superseded) {
    badges.push(`<span class="badge res-cache">${term('superseded')}</span>`);
  }
  if (step.reconstruction) {
    badges.push(`<span class="badge res-jit">${term('reconstructed in-run')}</span>`);
  }
  // An absence check that passed while the run was already broken is the
  // vacuous-pass hazard: "hidden" is also what a page that never rendered
  // looks like. True, but not evidence — and the badge says so where the
  // green dot would otherwise read as a clean claim about the feature.
  if (afterFailure && step.status === 'passed' && isAbsenceAssertion(step)) {
    badges.push(`<span class="badge res-cache">${term('passed, in doubt')}</span>`);
  }
  // Which side of the system this step exercised. Only marked on API steps:
  // labelling every click "frontend" would be noise on a page where that is
  // the default, and the absence of the badge already says it.
  if (BACKEND_TIER_ACTIONS.has(step.action)) {
    badges.push(`<span class="badge res-backend">${term('backend')}</span>`);
  }
  // `fast` is deliberately unbadged: every ordinary step resolves that way, so
  // labelling it adds noise to exactly the steps that need no attention.
  // A rung the label map has never heard of still gets a badge under its
  // own name — with `describeResolution`'s one-line note as its explanation,
  // so the glossary rule ("no badge without an entry") holds for it too.
  const resolved = describeResolution(step.resolution);
  if (resolved !== null) {
    const label = RESOLUTION_LABEL[step.resolution ?? ''] ?? resolved.label;
    badges.push(
      `<span class="badge res-${esc(step.resolution)}">${
        GLOSSARY[label] ? term(label) : `<abbr title="${esc(resolved.explanation)}">${esc(label)}</abbr>`
      }</span>`,
    );
  }
  if (step.agent) badges.push('<span class="badge res-agent">agent takeover</span>');
  // The harness withheld this step's mutation (Phase B): not a finding, and
  // the badge says so before the reader opens the callout.
  if (step.blocked) badges.push(`<span class="badge held">held · ${esc(step.blocked.reason)}</span>`);
  if (step.backendHint) badges.push('<span class="badge">visual only</span>');
  // Distinct from the takeover badge: that one says a model drove the step,
  // this one says a model was asked to JUDGE something the flow never
  // mentioned. A reader needs to know a decision was taken on their behalf.
  if (step.decision) badges.push('<span class="badge res-agent">agent decided</span>');
  // A value the author INVENTED went into this field. Not a takeover and not a
  // decision — the run did exactly what the flow said — but the flow's data
  // here is a stand-in, and a verdict built on it reads differently.
  if (valueWasGenerated(step)) badges.push(`<span class="badge res-generated">${term('value generated')}</span>`);
  if (step.snapshot) {
    badges.push(
      `<span class="badge ${step.snapshot.outcome === 'matched' ? 'res-fast' : 'res-jit'}">visual: ${esc(step.snapshot.outcome)}</span>`,
    );
  }
  if (step.dataCases) {
    const ok = step.dataCases.filter((c) => c.ok).length;
    badges.push(
      `<span class="badge res-cache">${ok}/${step.dataCases.length} values</span>`,
    );
  }
  if (step.dataRetry) {
    const n = step.dataRetry.attempts.length;
    badges.push(
      `<span class="badge ${step.dataRetry.succeeded ? 'res-cache' : 'res-jit'}">${n} attempt${n === 1 ? '' : 's'}</span>`,
    );
  }
  // No `screenshot` badge. Every step that touched the page carries one now,
  // and a badge on every step is the same noise `fast` is deliberately spared:
  // it marks the ordinary case and so tells a reader nothing about where to
  // look. Evidence announces itself in the filmstrip instead.
  return badges.join('');
}

function reconstructionBlock(step: ProofStep): string {
  if (!step.reconstruction) return '';
  const r = step.reconstruction;
  return `
    <div class="callout heal">
      <div class="callout-title">Reconstructed in-run (held on try ${r.attempt})</div>
      <dl class="kv">
        <div><dt>as written</dt><dd><code>${captured(r.from)}</code></dd></div>
        <div><dt>as rebuilt</dt><dd><code>${captured(r.to)}</code></dd></div>
        ${r.inserted > 0 ? `<div><dt>inserted before</dt><dd>${r.inserted} preparation step(s)</dd></div>` : ''}
        <div><dt>model</dt><dd>${esc(r.model)}</dd></div>
        <div><dt>reasoning</dt><dd>${captured(r.reasoning)}</dd></div>
      </dl>
    </div>`;
}

function healBlock(step: ProofStep): string {
  if (!step.heal) return '';
  const h = step.heal;
  return `
    <div class="callout heal">
      <div class="callout-title">JIT healer repaired this selector</div>
      <div class="swap">
        <code class="was">${esc(h.from)}</code>
        <span class="arrow">&rarr;</span>
        <code class="now">${esc(h.to)}</code>
      </div>
      <p class="reason">${esc(h.reasoning)}</p>
      <dl class="kv">
        <div><dt>strategy</dt><dd>${esc(h.strategy)}</dd></div>
        <div><dt>confidence</dt><dd>${h.confidence.toFixed(2)}</dd></div>
        <div><dt>model</dt><dd>${esc(h.model)}</dd></div>
        <div><dt>latency</dt><dd>${ms(h.latencyMs)}</dd></div>
        <div><dt>tokens</dt><dd>${h.inputTokens ?? 0} in / ${h.outputTokens ?? 0} out</dd></div>
      </dl>
    </div>`;
}

function dialogBlock(dialog: DialogRecord): string {
  return `
    <div class="callout dialog">
      <div class="callout-title">An unexpected dialog was in the way</div>
      <p class="reason">Dismissed "${esc(dialog.name)}" via its "${esc(dialog.button)}" control, then retried the step.</p>
    </div>`;
}

function dataRetryBlock(retry: DataRetryRecord): string {
  const rows = retry.attempts
    .map(
      (a) => `<tr class="${a.succeeded ? '' : 'bad'}">
        <td>${a.succeeded ? '✓' : '✗'}</td>
        <td class="num">${a.attempt}</td>
        <td>${esc(a.kind)}</td>
        <td><code>${esc(a.value)}</code></td>
      </tr>`,
    )
    .join('');
  return `
    <div class="callout ${retry.succeeded ? 'data' : 'error'}">
      <div class="callout-title">Data regenerated on conflict${retry.succeeded ? '' : ' — still conflicting'}</div>
      <table class="agent-trace">
        <thead><tr><th></th><th>#</th><th>kind</th><th>value</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${
        retry.model
          ? `<dl class="kv"><div><dt>model</dt><dd>${esc(retry.model)}</dd></div><div><dt>tokens</dt><dd>${retry.inputTokens ?? 0} in / ${retry.outputTokens ?? 0} out</dd></div></dl>`
          : ''
      }
    </div>`;
}

/** One key/value row, omitted entirely when there's nothing to show. */
function kv(label: string, value: string | undefined): string {
  return value === undefined || value === ''
    ? ''
    : `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
}

function headerRows(headers: Record<string, string> | undefined): string {
  if (!headers || Object.keys(headers).length === 0) return '';
  return Object.entries(headers)
    .map(
      ([name, value]) =>
        `<tr><td><code>${esc(name)}</code></td><td><code>${esc(value)}</code></td></tr>`,
    )
    .join('');
}

/**
 * The call this step made deliberately.
 *
 * Everything rendered here has already been through `redact.ts` on the way
 * into the bundle — this function must never reach for a raw value, or the
 * report becomes the leak.
 */
function requestBlock(record: RequestRecord): string {
  const failed = record.status === null || record.status >= 400;
  const status =
    record.status === null
      ? 'no response'
      : `${record.status}${record.statusText ? ` ${record.statusText}` : ''}`;

  const section = (title: string, headers: Record<string, string> | undefined, body: string | undefined) => {
    const rows = headerRows(headers);
    if (!rows && !body) return '';
    return `
      <div class="http-part">
        <div class="http-part-title">${esc(title)}</div>
        ${rows ? `<table class="agent-trace"><tbody>${rows}</tbody></table>` : ''}
        ${body ? `<pre>${esc(body)}</pre>` : ''}
      </div>`;
  };

  return `
    <div class="callout request ${failed ? 'failed' : ''}">
      <div class="callout-title">HTTP ${esc(record.method)} &mdash; ${esc(status)}</div>
      <div class="swap"><code class="now">${esc(record.url)}</code></div>
      ${record.error ? `<p class="reason">${esc(record.error)}</p>` : ''}
      <dl class="kv">
        ${kv('duration', ms(record.durationMs))}
        ${kv('size', record.sizeBytes === undefined ? undefined : `${record.sizeBytes} B`)}
        ${kv('saved', record.saved?.join(', '))}
      </dl>
      ${section('request', record.requestHeaders, record.requestBody)}
      ${section('response', record.responseHeaders, record.responseBody)}
    </div>`;
}

/**
 * The database check this step made. Everything rendered here was redacted on
 * the way into the bundle (`redact-row.ts`) — same rule as `requestBlock`:
 * this function must never reach for a raw value, or the report is the leak.
 */
function dbBlock(record: DbCheckRecord): string {
  const target =
    record.table !== undefined
      ? record.table
      : record.tables !== undefined
        ? record.tables.join(', ')
        : '';
  const sample =
    record.rows && record.rows.length > 0
      ? `<table class="agent-trace"><tbody>${record.rows
          .map(
            (row) =>
              `<tr>${Object.entries(row)
                .map(([column, value]) => `<td>${esc(column)} = ${esc(value)}</td>`)
                .join('')}</tr>`,
          )
          .join('')}</tbody></table>`
      : '';
  return `
    <div class="callout request">
      <div class="callout-title">DB ${esc(record.kind)}${target ? ` &mdash; ${esc(target)}` : ''}</div>
      <dl class="kv">
        ${kv('where', record.where)}
        ${kv('expected', record.expected)}
        ${kv('observed', record.observed)}
        ${kv('duration', ms(record.durationMs))}
        ${kv('polled', record.polledMs === undefined ? undefined : ms(record.polledMs))}
      </dl>
      ${record.note ? `<p class="reason">${esc(record.note)}</p>` : ''}
      ${sample}
    </div>`;
}

/**
 * Traffic the page generated on its own, attached only where it is evidence.
 *
 * Deliberately terse compared to `requestBlock`: this is context for a
 * failure, not the subject of the step, and a wall of headers here would
 * bury the thing the reader actually came for.
 */
function networkBlock(calls: readonly NetworkCall[]): string {
  const rows = calls
    .map((call) => {
      const outcome = classifyCall(call);
      const status = call.errorText ?? (call.status === undefined ? 'pending' : String(call.status));
      return `<tr class="${outcome === 'ok' ? '' : 'bad'}">
        <td><span class="act">${esc(call.method)}</span></td>
        <td class="reason-cell"><code>${esc(call.url)}</code></td>
        <td>${esc(status)}</td>
        <td class="num">${call.durationMs === undefined ? '—' : ms(call.durationMs)}</td>
      </tr>`;
    })
    .join('');

  const anyFailed = calls.some((call) => isBlockingFailure(call));
  return `
    <div class="callout ${anyFailed ? 'error' : 'network'}">
      <div class="callout-title">
        ${anyFailed ? 'Requests failed while this step was waiting' : 'Requests the page made during this step'}
      </div>
      <table class="agent-trace">
        <thead><tr><th>method</th><th>url</th><th>status</th><th>time</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${
        anyFailed
          ? '<p class="reason">A failing request is a far more likely explanation for a control that ' +
            'never appeared than a drifted selector, so no repair was attempted. This is a ' +
            'correlation, not a proof of cause.</p>'
          : ''
      }
    </div>`;
}

/**
 * What the agent judged and chose, kept visibly apart from what it did.
 *
 * The three prose lines are the agent's own words — claims about the page —
 * and the last line is the only evidence in the block: whether the author's
 * own selector resolved afterwards. Rendering them together without that
 * separation would let a confident-sounding "I accepted the consent screen"
 * read as proof the step was sound.
 */
/**
 * The target cell of one agent turn: what it was aimed at, plus a note when
 * the action's meaning is not in its target — `save` names the variable it
 * filled, `signOut` has no selector at all, `read` quotes what it saw. One
 * formatter for both trace tables, from `step-facts.ts`, so an action the
 * agent gains later renders with its selector rather than as `—`.
 */
function agentTargetCell(a: AgentActionLike): string {
  const { target, note } = describeAgentAction(a);
  return `<code>${captured(target)}</code>${note === null ? '' : ` <span class="muted">${captured(note)}</span>`}`;
}

function decisionBlock(decision: StepDecision): string {
  const rows = decision.actions
    .map(
      (a) => `
      <tr class="${a.ok ? '' : 'bad'}">
        <td class="num">${a.index + 1}</td>
        <td><span class="act">${esc(a.action)}</span></td>
        <td>${agentTargetCell(a)}</td>
        <td class="reason-cell">${esc(a.reasoning)}${a.error ? `<div class="err">${esc(a.error)}</div>` : ''}</td>
      </tr>`,
    )
    .join('');

  return `
    <div class="callout agent ${decision.resolved ? '' : 'failed'}">
      <div class="callout-title">The run met something the flow does not describe${
        decision.resolved ? '' : ' — and the step still did not work'
      }</div>
      ${decision.observed ? `<p class="reason"><span>the agent judged</span> ${esc(decision.observed)}</p>` : ''}
      <p class="reason"><span>it decided</span> ${esc(decision.decided)}</p>
      ${decision.because ? `<p class="reason"><span>because</span> ${esc(decision.because)}</p>` : ''}
      <table class="agent-trace">
        <thead><tr><th>#</th><th>action</th><th>target</th><th>reasoning</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="muted">it chose not to act</td></tr>'}</tbody>
      </table>
      <dl class="kv">
        <div><dt>the test\u2019s own selector then</dt><dd>${
          decision.resolved ? 'resolved' : 'still did not resolve'
        }</dd></div>
        <div><dt>model</dt><dd>${esc(decision.model)}</dd></div>
      </dl>
    </div>`;
}

/**
 * The workflow leg, foldable. The trace is the evidence behind the summary
 * and every reader wants it eventually, but a run with a dozen legs is
 * unreadable with all of them open — so the summary and the goal stay
 * visible and the turn-by-turn log is one click away. Open by default when
 * the goal was not reached: that is the case a reader came for.
 */
/**
 * The agent's own account of a leg, framed by what the STEP then did.
 *
 * `agent.success` is what the agent said; the step's status is what the
 * flow's own selector proved afterwards, and the two disagree often — the
 * assist rung's agent stalls or errors on its second turn after its first
 * action already opened the panel, and the step passes. A red "goal not
 * reached" callout on a green step read as a contradiction and hid the fact
 * that mattered: the page was prepared and the step held. So a passed step
 * titles the callout by what happened, and only a step that did NOT pass
 * opens the trace and wears the failure colour.
 */
function agentBlock(agent: AgentRecord, stepPassed = agent.success): string {
  const failed = !agent.success && !stepPassed;
  const held = agent.blocked !== undefined;
  const title = agent.success
    ? 'Workflow agent took over'
    : stepPassed
      ? 'Workflow agent prepared the page — the step then passed on the flow\'s own selector'
      : held
        ? 'Workflow agent was held by the run\'s rules — no verdict about the application'
        : 'Workflow agent took over — goal not reached';
  // A held action is drawn as a hold, not as a failure: the typed outcome on
  // the record says the harness withheld it, and the row says the same.
  const rows = agent.actions
    .map(
      (a) => `
      <tr class="${a.ok ? '' : a.outcome?.kind === 'blocked' ? 'held' : 'bad'}">
        <td class="num">${a.index + 1}</td>
        <td><span class="act">${esc(a.action)}</span>${
          a.outcome?.kind === 'blocked' ? ` <span class="badge held">held · ${esc(a.outcome.reason)}</span>` : ''
        }</td>
        <td>${agentTargetCell(a)}</td>
        <td class="reason-cell">${esc(a.reasoning)}${a.error ? `<div class="err">${esc(a.error)}</div>` : ''}</td>
        <td class="num">${ms(a.durationMs)}</td>
      </tr>`,
    )
    .join('');

  return `
    <div class="callout agent ${held ? 'held' : failed ? 'failed' : ''}">
      <div class="callout-title">${title}</div>
      <p class="goal"><span>goal</span> ${esc(agent.goal)}</p>
      <p class="reason">${esc(agent.summary)}</p>
      <details${failed ? ' open' : ''}>
        <summary>What the agent did — ${agent.actions.length} action${agent.actions.length === 1 ? '' : 's'}, turn by turn</summary>
        <table class="agent-trace">
          <thead><tr><th>#</th><th>action</th><th>target</th><th>reasoning</th><th>time</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5" class="muted">no actions taken</td></tr>'}</tbody>
        </table>
      </details>
      <dl class="kv">
        <div><dt>turns</dt><dd>${agent.maxSteps == null ? `${agent.turns} (no ceiling)` : `${agent.turns} / ${agent.maxSteps}`}</dd></div>
        <div><dt>model</dt><dd>${esc(agent.model)}</dd></div>
        <div><dt>latency</dt><dd>${ms(agent.latencyMs)}</dd></div>
        <div><dt>tokens</dt><dd>${agent.inputTokens ?? 0} in / ${agent.outputTokens ?? 0} out</dd></div>
      </dl>
    </div>`;
}

/** Boundary-value table: the whole matrix, not just the first failure. */
function dataBlock(cases: readonly DataCaseResult[]): string {
  const rows = cases
    .map(
      (c) => `<tr class="${c.ok ? '' : 'bad'}">
        <td>${c.ok ? '✓' : '✗'}</td>
        <td>${esc(c.label)}</td>
        <td><code>${esc(JSON.stringify(c.value))}</code></td>
        <td class="reason-cell">${esc(c.error ?? '')}</td>
      </tr>`,
    )
    .join('');
  return `
    <div class="callout data">
      <div class="callout-title">Boundary values</div>
      <table class="agent-trace">
        <thead><tr><th></th><th>case</th><th>value</th><th>result</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function snapshotBlock(step: ProofStep): string {
  const snap = step.snapshot;
  if (!snap) return '';
  const failed = snap.outcome === 'changed' || snap.outcome === 'size-mismatch';
  return `
    <div class="callout ${failed ? 'error' : 'heal'}">
      <div class="callout-title">Visual snapshot — ${esc(snap.outcome)}</div>
      <p class="reason">${esc(snap.message)}</p>
      <dl class="kv">
        <div><dt>baseline</dt><dd><code>${esc(snap.baselinePath)}</code></dd></div>
        ${snap.diffRatio === undefined ? '' : `<div><dt>pixels changed</dt><dd>${snap.changedPixels ?? 0} / ${snap.totalPixels ?? 0} (${(snap.diffRatio * 100).toFixed(2)}%)</dd></div>`}
      </dl>
      ${
        snap.diffImage
          ? `<figure class="shot-wrap"><img loading="lazy" alt="Visual diff for ${esc(snap.name)}" src="data:image/png;base64,${snap.diffImage}"><figcaption>diff — changed pixels highlighted</figcaption></figure>`
          : ''
      }
      ${
        snap.actualImage
          ? `<figure class="shot-wrap"><img loading="lazy" alt="Rendered output for ${esc(snap.name)}" src="data:image/png;base64,${snap.actualImage}"><figcaption>what was rendered</figcaption></figure>`
          : ''
      }
    </div>`;
}

/**
 * What the page was showing when the step failed — the AX headings captured
 * while the heal was being attempted, promoted to first-class evidence. This
 * is how "the page said Access Denied" reaches a reader instead of living as
 * a substring of a rejected repair proposal.
 */
function pageContextBlock(step: ProofStep): string {
  if (!step.pageContext || step.pageContext.length === 0) return '';
  return `
    <div class="callout trace">
      <div class="callout-title">What the page was showing</div>
      <ul class="trace-list">
        ${step.pageContext.map((line) => `<li>${captured(line)}</li>`).join('')}
      </ul>
    </div>`;
}

/**
 * What the workflow agent READ off the page — the evidence of an
 * observe-and-record leg (OA-14). Quoted verbatim through `captured`, each
 * with the selector it was read from and the URL it was read at, because
 * "the agent says the status was Active" and "textbox "Status" held Active
 * at /en/employees/42" are different amounts of evidence.
 */
/**
 * The hold that ended a `workflow` leg (Phase B, 2026-09-05): which rule,
 * why, and what the provenance ledger knew. Its own callout, above the
 * agent trace, because the one thing a reader must take from this step is
 * that it is NOT a finding — the application was never asked.
 */
function heldBlock(blocked: BlockedOutcome): string {
  const facts = blocked.provenance;
  return `
    <div class="callout held">
      <div class="callout-title">Held by the run's rules — no verdict about the application</div>
      <p class="reason">${esc(blocked.message)}</p>
      <dl class="kv">
        <div><dt>reason</dt><dd>${esc(blocked.reason)}</dd></div>
        <div><dt>rule</dt><dd><code>${esc(blocked.rule)}</code></dd></div>
        <div><dt>category</dt><dd>${esc(blocked.category)}</dd></div>
        ${blocked.target === null ? '' : `<div><dt>target</dt><dd><code>${esc(blocked.target)}</code></dd></div>`}
        <div><dt>policy</dt><dd>${blocked.policySource === null ? 'none configured' : esc(blocked.policySource)}</dd></div>
        ${
          facts === undefined
            ? ''
            : `<div><dt>observed this session</dt><dd>${facts.observedThisSession.length === 0 ? 'none of the targets' : esc(facts.observedThisSession.join(', '))}</dd></div>
        <div><dt>in the latest snapshot</dt><dd>${facts.inLatestSnapshot.length === 0 ? 'none of the targets' : esc(facts.inLatestSnapshot.join(', '))}${
          facts.latestSnapshotAt === null ? ' (nothing captured yet)' : ` (captured ${esc(facts.latestSnapshotAt)}${facts.latestSnapshotUrl === null ? '' : ` on ${esc(facts.latestSnapshotUrl)}`})`
        }</dd></div>`
        }
      </dl>
    </div>`;
}

function observedBlock(step: ProofStep): string {
  const items = observedEvidence(step);
  if (items.length === 0) return '';
  return `
    <div class="callout observed">
      <div class="callout-title">${term('observed')} — ${items.length} value${items.length === 1 ? '' : 's'} read off the page</div>
      <ul class="trace-list">
        ${items
          .map(
            (o) =>
              `<li><code>${captured(o.text)}</code>${o.selector ? `<span class="trace-detail">from ${captured(o.selector)}${o.url ? ` at ${esc(o.url)}` : ''}</span>` : o.url ? `<span class="trace-detail">at ${esc(o.url)}</span>` : ''}</li>`,
          )
          .join('')}
      </ul>
    </div>`;
}

/**
 * The labelled facts a step kind carries beyond its selector — the
 * alternatives of an `expectAnyVisible`, the files of an `upload`, the
 * persona of a `signIn`, the author's own timeout. Always visible, like the
 * comparison line: they ARE what the step was, and a step whose facts hide
 * inside a collapsed body reads as an empty row.
 */
function stepFactsLine(step: ProofStep): string {
  const facts = stepKindFacts(step);
  if (facts.length === 0) return '';
  return `<p class="step-facts">${facts
    .map((f) => `<span class="fact"><span class="fact-k">${esc(f.label)}</span> ${captured(f.value).replace(/\n/g, '<br/>')}</span>`)
    .join('')}</p>`;
}

/**
 * A case the sheet gave no oracle for (CG-09): every Expected line said
 * "record what the system shows", so the run asserted nothing and ends in
 * review with what it captured. The captures ARE the deliverable — listed
 * up front, before the timeline, where a reader comparing them to the
 * sheet's open question looks first. Never green: a review colour of its own.
 */
function recordOnlyBlock(bundle: ProofBundle): string {
  if (!provenanceExtras(bundle).recordOnly) return '';
  const captures = recordedCaptures(bundle);
  return `
  <section class="verdict record-only">
    <h2 class="verdict-headline">${term('recorded only')} — ${captures.length} value${captures.length === 1 ? '' : 's'} captured for review</h2>
    <p class="verdict-line">The sheet's Expected lines record what the system shows rather than stating what it must show, so this run asserted nothing and a person must compare the captures below against the sheet.</p>
    ${
      captures.length === 0
        ? '<p class="verdict-line muted">No values were captured — the case has nothing to hand a reviewer.</p>'
        : `<dl class="kv wide">${captures
            .map((c) => `<div><dt>${esc(c.name)}</dt><dd><code>${captured(c.value)}</code></dd></div>`)
            .join('')}</dl>`
    }
  </section>`;
}

/**
 * Repair candidates the run refused, with why. A rejected proposal is what
 * the model saw on the page — frequently the diagnosis itself ("the heading
 * here says Access Denied") — so it ranks as evidence, right after the trace.
 */
function rejectedHealsBlock(step: ProofStep): string {
  if (!step.rejectedHeals || step.rejectedHeals.length === 0) return '';
  return `
    <div class="callout trace">
      <div class="callout-title">Repairs proposed and refused</div>
      <ul class="trace-list">
        ${step.rejectedHeals
          .map(
            (r) =>
              `<li><code>${captured(r.proposed)}</code> (confidence ${r.confidence.toFixed(2)}) — ${captured(r.reasoning)}<span class="trace-detail">refused: ${captured(r.rejectedBecause)}</span></li>`,
          )
          .join('')}
      </ul>
    </div>`;
}

/**
 * The escalation trace, told as a sequence rather than dumped as a stack.
 *
 * The raw error is kept below it verbatim — this is a reading aid, never a
 * replacement for the evidence.
 */
function traceBlock(step: ProofStep): string {
  const rungs = escalationTrace(step.error);
  if (rungs.length === 0) return '';
  return `
    <div class="callout trace">
      <div class="callout-title">What was tried, in order</div>
      <ol class="trace-list">
        ${rungs
          .map(
            (r) =>
              `<li><span class="trace-rung">${esc(r.rung)}</span> ${esc(r.prose)}<span class="trace-detail">${esc(r.detail)}</span></li>`,
          )
          .join('')}
      </ol>
    </div>`;
}

/**
 * The run as a strip of frames, one per step that left evidence.
 *
 * This is the whole point of capturing every step rather than only the failing
 * one: a failure screenshot shows the wreckage, and the frame *before* it is
 * usually where the wrong thing actually happened. Scrubbing the strip answers
 * "when did the page stop looking right" in seconds, and no amount of detail on
 * the failing step alone can answer it.
 *
 * **The frames are not emitted here.** Each screenshot appears exactly once in
 * the document, inside its own step, and the strip is assembled in the browser
 * from those same elements — so this costs no bytes in a file that already
 * carries every image inline. A server-rendered strip would double the report's
 * size to show the same pictures twice.
 */
function filmstripBlock(bundle: ProofBundle): string {
  // Superseded attempts are folded under the step that replaced them and
  // are not frames of the journey — the filmstrip shows the run as it ended.
  const live = bundle.steps.filter((step) => !step.superseded);
  const frames = live.filter((step) => step.screenshot !== undefined);
  if (frames.length < 2) return '';

  return `
  <figure class="filmstrip" id="filmstrip" hidden>
    <figcaption>
      <span>Evidence — ${frames.length} of ${live.length} steps</span>
      <span class="hint">click a frame to jump to its step</span>
    </figcaption>
    <div class="frames" id="filmstrip-frames"></div>
  </figure>`;
}

/**
 * The run on film, above the timeline.
 *
 * A still answers "what did the page look like"; this answers "what did the
 * test do", which is the question a screenshot structurally cannot — a click
 * exists only between two frames, and the two frames on either side of a click
 * that did nothing are identical to the two on either side of one that worked.
 * The pointer visible here is drawn by an injected overlay, not by the
 * operating system; see `engine/video.ts`.
 *
 * **The base64 is carried on an attribute and turned into a Blob URL by the
 * page's own script, rather than being handed to the element as a `data:`
 * URI.** Chrome's media stack will not load a `data:` video: the element sits
 * at `readyState 0` / `networkState 2` forever, with no error to explain
 * itself, which reads exactly like a corrupt recording. It is not — the same
 * bytes play immediately from a Blob. Found by extracting the base64 back out
 * of a rendered report and playing the result, which worked; keep the
 * indirection.
 *
 * The bytes are still inline, so the report is still one file. When the
 * recording was too large to embed, the figure still renders and says so —
 * "we recorded it and it did not fit" and "nothing was recorded" are different
 * facts, and silently showing neither would leave a reader to guess which.
 */
function videoBlock(bundle: ProofBundle): string {
  const video = bundle.video;
  if (!video) return '';
  if (!video.data) {
    return `
  <figure class="video">
    <figcaption><span>Recording</span></figcaption>
    <p class="video-missing">${esc(video.omitted ?? 'the recording could not be embedded')}</p>
  </figure>`;
  }
  // What this recording *is* — not a record of the run, but of the run up to
  // the point it broke. A reader who expects the whole thing and finds it
  // ending early would read that as a truncated file rather than as the rule.
  const endsAt = video.endsAtStep;
  const failing = endsAt === undefined ? undefined : bundle.steps[endsAt];
  const upTo =
    failing === undefined
      ? 'the run'
      : `the failure at step ${failing.index}${failing.intent ? ` — ${esc(failing.intent)}` : ''}`;
  // One subtitle segment per filmed step: what the mock user is doing at
  // that moment of the film, and — for the step that broke — how it failed.
  // Server-rendered as data so the page's own script can drive a live
  // subtitle bar without a second copy of the steps.
  const segments = bundle.steps
    .filter((step) => step.videoOffsetMs !== undefined)
    .map((step) => ({
      at: (step.videoOffsetMs ?? 0) / 1000,
      step: step.index,
      text: step.intent ?? `${step.action}${step.selector ? ` ${step.selector}` : ''}`,
      failed: step.status !== 'passed' && step.status !== 'skipped' && !step.superseded,
      error: step.status !== 'passed' && step.status !== 'skipped' ? (step.error?.split('\n')[0] ?? '') : '',
    }));
  return `
  <figure class="video" data-segments="${esc(JSON.stringify(segments))}">
    <figcaption>
      <span>Recording — from the start of the flow to ${upTo}${
        video.condensed
          ? ` (action moments only: ${video.condensed.moments} held ~${(video.condensed.dwellMs / 1000).toFixed(1)} s each, ${ms(video.durationMs ?? 0)} of ${ms(video.condensed.sourceDurationMs)} filmed)`
          : ''
      }</span>
      <span class="hint">each step body has a “play from here”</span>
    </figcaption>
    <video id="run-video" controls preload="metadata" width="${video.width}" height="${video.height}"
      data-webm="${video.data}"${
        failing?.videoOffsetMs !== undefined
          ? ` data-failure-offset="${(failing.videoOffsetMs / 1000).toFixed(2)}"`
          : ''
      }></video>
    <div class="video-subtitle" id="video-subtitle" hidden></div>
  </figure>`;
}

/**
 * The control that makes one recording per-step evidence.
 *
 * Without it a video is a clip someone has to scrub; with it every step in the
 * timeline is a cue point into the same file. The offset is the step's own
 * start, so what plays is the step running rather than its aftermath.
 */
function seekControl(step: ProofStep, hasVideo: boolean): string {
  if (!hasVideo || step.videoOffsetMs === undefined) return '';
  return `<button class="seek" type="button" data-seek="${(step.videoOffsetMs / 1000).toFixed(2)}">▶ play from here (${ms(step.videoOffsetMs)} in)</button>`;
}

/**
 * Whether this test meant to prove acceptance or refusal — without the label,
 * a negative test's green run reads as "the feature works" when it actually
 * says "the application refused it, as required". The title carries the
 * reading in full, and says whether the catalog stated it or the harness
 * inferred it, because those are different strengths of evidence.
 */
/**
 * "expected X · actual Y", rendered on every assertion step that recorded
 * both — passes included, because "it passed" and "it passed and the page
 * really held 119 days" are different amounts of evidence. Application text
 * goes through `captured` like everywhere else it is quoted.
 */
function expectedActualLine(step: ProofStep): string {
  const detail = step.detail;
  if (!detail || detail['expected'] === undefined) return '';
  const render = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));
  const expected = render(detail['expected']);
  const actual = detail['actual'] === undefined ? null : render(detail['actual']);
  const bad = step.status !== 'passed' && step.status !== 'skipped';
  return `<p class="step-compare">expected <code>${captured(expected)}</code>${
    actual === null ? '' : ` &middot; actual <code${bad ? ' class="cmp-bad"' : ''}>${captured(actual)}</code>`
  }</p>`;
}

function polarityPill(bundle: ProofBundle): string {
  if (bundle.polarity === undefined) return '';
  const negative = bundle.polarity === 'negative';
  const how = bundle.polaritySource === 'stated' ? 'stated by the catalog' : 'inferred from the test\'s own words and assertions';
  const title = negative
    ? `a NEGATIVE test — it passes by proving the application refuses or blocks the attempt (${how})`
    : `a POSITIVE test — it passes by proving the intended path works (${how})`;
  return `<span class="polarity ${negative ? 'neg' : 'pos'}" title="${esc(title)}">${negative ? 'negative test' : 'positive test'}</span>`;
}

/**
 * The failed attempts a reconstruction rescued, folded under the step that
 * finally held.
 *
 * A superseded attempt used to sit in the main list as a red row of its own,
 * one line above the green step that replaced it — the same headline twice,
 * once failed and once passed — and a reader had to know the badge to see it
 * was not a failure. Now the main list shows the run as it ended: the
 * rebuilt step (and any preparation inserted before it) in place, and the
 * attempts it replaced behind a closed disclosure on that step, each one
 * still a full row — error, screenshot, trace — because what was tried is
 * evidence, just not the outcome. Pure over the bundle: nothing here decides
 * what was superseded; `supersedeSteps` did, at run time.
 */
function replacedAttemptsBlock(attempts: readonly ProofStep[], hasVideo: boolean): string {
  if (attempts.length === 0) return '';
  const n = attempts.length;
  return `
    <details class="replaced">
      <summary>Replaced ${n} failed attempt${n === 1 ? '' : 's'} at this step — as written, before the in-run reconstruction (step${n === 1 ? '' : 's'} ${attempts.map((a) => a.index).join(', ')})</summary>
      <ol class="steps attempts">${attempts.map((a) => stepRow(a, hasVideo, false, true)).join('')}</ol>
    </details>`;
}

/**
 * The step list with every superseded attempt folded under the step that
 * replaced it. Attempts are buffered as they come and attached to the next
 * step carrying a `ReconstructionRecord` — the one that finally held;
 * preparation the reconstruction inserted before it renders as an ordinary
 * step in between. Should a buffer reach the end of the list with no rescue
 * after it (a shape the runner never writes), the attempts render in place
 * rather than vanish.
 */
function stepList(bundle: ProofBundle, hasVideo: boolean): string {
  const steps = bundle.steps;
  // A superseded failure is history, not a break in the run: the passes that
  // follow it are not "in doubt", so the first LIVE failure is what counts.
  const firstFailure = steps.findIndex((s) => s.status !== 'passed' && s.status !== 'skipped' && !s.superseded);
  const rows: string[] = [];
  let pending: ProofStep[] = [];
  for (const step of steps) {
    if (step.superseded) {
      pending.push(step);
      continue;
    }
    const afterFailure = firstFailure !== -1 && step.index > firstFailure;
    if (step.reconstruction && pending.length > 0) {
      rows.push(stepRow(step, hasVideo, afterFailure, false, pending));
      pending = [];
    } else {
      rows.push(stepRow(step, hasVideo, afterFailure));
    }
  }
  for (const orphan of pending) rows.push(stepRow(orphan, hasVideo, false));
  return rows.join('');
}

function stepRow(
  step: ProofStep,
  hasVideo = false,
  afterFailure = false,
  attempt = false,
  replaced: readonly ProofStep[] = [],
): string {
  // The resolved selector, the authored one, or — for a kind with no single
  // selector (`expectAnyVisible`, `signIn`, `upload`) — what the record says
  // it was aimed at. `—` only when the step truly names nothing (a `goto`).
  const target = stepTarget(step);
  // `intent`, `expected`, `actual`, the kind facts and the observations each
  // get a dedicated line — the generic dump repeats none of them, and drops
  // every credential-shaped key (a `signIn` records the persona it resolved;
  // the report shows the label and never the address). See `visibleDetail`.
  const detail = visibleDetail(step);
  const compare = expectedActualLine(step);
  const facts = stepFactsLine(step);

  // Intent leads. A reader triaging a red run needs "what was this step for"
  // before "which selector expressed it"; the selector is one line down, and
  // still verbatim for anyone who came for it.
  const headline = step.intent ? captured(step.intent) : esc(step.action);

  return `
  <li class="step ${step.status}${attempt ? ' attempt' : ''}" id="step-${step.index}" data-step="${step.index}">
    <button class="step-head" aria-expanded="false">
      <span class="dot"></span>
      <span class="idx">${step.index}</span>
      <span class="headline">${headline}</span>
      <span class="badges">${stepBadges(step, afterFailure)}</span>
      <span class="time">${ms(step.durationMs)}</span>
      <span class="chev" aria-hidden="true">&#9662;</span>
    </button>
    <p class="step-sub"><span class="action">${esc(step.action)}</span> <code class="target">${captured(target ?? '—')}</code>${step.target ? ` <span class="target-what" title="what the selector resolved to, read from the live element">→ ${captured(describeTarget(step.target) ?? '')}</span>` : ''}</p>
    ${facts}
    ${compare}
    <div class="step-body" hidden>
      ${step.unsure ? `<div class="callout unsure"><div class="callout-title">Proved-? — a human must rule on this step</div><pre>${captured(step.unsure)}</pre></div>` : ''}
      ${step.backendHint ? `<div class="callout"><div class="callout-title">Proved on screen — a backend check could prove it better</div><p>Backend testing was off for this run, so this claim was settled through the page. ${captured(step.backendHint)}</p><p class="muted">The step passed on its own terms. Turn backend testing on (and give the run a database URL) to prove it against the data itself.</p></div>` : ''}
      ${step.error ? `<div class="callout${step.status === 'skipped' ? '' : ' error'}"><div class="callout-title">${step.status === 'skipped' ? 'Not run' : 'Failure'}</div><pre>${esc(step.error.split('\n')[0] ?? step.error)}</pre></div>` : ''}
      ${pageContextBlock(step)}
      ${seekControl(step, hasVideo)}
      ${
        step.screenshot
          ? `<figure class="shot-wrap">
               <img loading="lazy" alt="Screenshot at step ${step.index}" src="data:image/jpeg;base64,${step.screenshot}">
               <figcaption>${step.status === 'skipped' ? 'this step was not run' : step.status !== 'passed' ? 'the page when this step failed' : 'the page after this step'} — click to enlarge</figcaption>
             </figure>`
          : ''
      }
      ${traceBlock(step)}
      ${rejectedHealsBlock(step)}
      ${step.network ? networkBlock(step.network) : ''}
      ${healBlock(step)}
      ${reconstructionBlock(step)}
      ${replacedAttemptsBlock(replaced, hasVideo)}
      ${step.request ? requestBlock(step.request) : ''}
      ${step.db ? dbBlock(step.db) : ''}
      ${step.dialog ? dialogBlock(step.dialog) : ''}
      ${step.decision ? decisionBlock(step.decision) : ''}
      ${step.blocked ? heldBlock(step.blocked) : ''}
      ${step.agent ? agentBlock(step.agent, step.status === 'passed') : ''}
      ${observedBlock(step)}
      ${step.snapshot ? snapshotBlock(step) : ''}
      ${step.dataCases ? dataBlock(step.dataCases) : ''}
      ${step.dataRetry ? dataRetryBlock(step.dataRetry) : ''}
      ${step.error && step.error.includes('\n') ? `<details class="raw"><summary>Full error text</summary><pre>${esc(step.error)}</pre></details>` : ''}
      <dl class="kv wide">
        <div><dt>url</dt><dd><code>${esc(step.url ?? '—')}</code></dd></div>
        <div><dt>authored selector</dt><dd><code>${esc(step.selector ?? '—')}</code></dd></div>
        <div><dt>resolved selector</dt><dd><code>${esc(step.resolvedSelector ?? '—')}</code></dd></div>
        ${(() => {
          const how = describeResolution(step.resolution);
          return how === null ? '' : `<div><dt>resolved via</dt><dd>${esc(step.resolution ?? '')} — ${esc(how.label)}</dd></div>`;
        })()}
        ${stepKindFacts(step)
          .map((f) => `<div><dt>${esc(f.label)}</dt><dd><code>${captured(f.value)}</code></dd></div>`)
          .join('')}
        ${step.target ? `<div><dt>target</dt><dd>${captured(describeTarget(step.target) ?? '')}${step.screenshot ? ' <span class="muted">(outlined in red in the screenshot)</span>' : ''}</dd></div>` : ''}
        ${describeValueSource(step) ? `<div><dt>value</dt><dd>${esc(describeValueSource(step) ?? '')}</dd></div>` : ''}
        ${describeDbChanges(step.dbChanges).map((line) => `<div><dt>db</dt><dd>${esc(line)}</dd></div>`).join('')}
        ${step.dbProbeError ? `<div><dt>db probe</dt><dd class="muted">${esc(step.dbProbeError)}</dd></div>` : ''}
        <div><dt>started</dt><dd>${esc(step.startedAt)}</dd></div>
        ${detail.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd><code>${esc(typeof v === 'string' ? v : JSON.stringify(v))}</code></dd></div>`).join('')}
      </dl>
    </div>
  </li>`;
}

function defectRow(defect: Defect): string {
  return `
  <tr class="sev-${esc(defect.severity)}">
    <td><span class="pill sev-${esc(defect.severity)}">${esc(defect.severity)}</span></td>
    <td><span class="pill cat">${esc(defect.category)}</span></td>
    <td>
      <div class="d-title">${captured(defect.title)}${
        (defect.occurrences ?? 1) > 1
          ? ` <span class="pill cat">&times;${defect.occurrences} occurrences</span>`
          : ''
      }</div>
      <div class="d-detail">${captured(defect.detail)}</div>
      ${defect.selector ? `<code class="d-sel">${esc(defect.selector)}</code>` : ''}
    </td>
    <td class="num">${defect.stepIndex === undefined ? `<span class="muted">${esc(defect.source)}</span>` : `step ${defect.stepIndex}`}</td>
  </tr>`;
}

const STYLES = `
${GRIM_TOKENS}
/*
 * The escalation ladder, in GRIM's semantic colours.
 *
 * These are aliases, not a second palette: each rung is expressed as the GRIM
 * token whose *meaning* matches, so the report cannot drift away from the
 * control panel or from grimval. The mapping is the argument:
 *
 *   fast    muted   — the ordinary case. Deliberately unbadged; see below.
 *   case    accent  — free, deterministic, still the author's own selector.
 *   cache   accent  — free, a repair already paid for.
 *   jit     warn    — costs tokens AND means the test is drifting from the app.
 *                     Amber is GRIM's "review this", which is exactly right.
 *   dialog  info     \\ something happened and was handled; worth seeing,
 *   backend info     / not worth alarming about at the badge level.
 *   request info    — HTTP the test made on purpose.
 *   agent   violet  — the orchestrator's agent colour, carried across.
 */
:root{
  --fast:var(--muted);
  --case:var(--accent);--case-bg:var(--accent-soft);
  --narrow:var(--accent);--narrow-bg:var(--accent-soft);
  --cache:var(--accent);--cache-bg:var(--accent-soft);
  --jit:var(--warn);--jit-bg:var(--warn-bg);
  --dialog:var(--info);--dialog-bg:var(--info-bg);
  --agent:var(--violet);--agent-bg:var(--violet-bg);
  --request:var(--info);--request-bg:var(--info-bg);
}
${GRIM_BASE}
${GRIM_COMPONENTS}
.wrap{max-width:1100px;margin:0 auto;padding:32px 20px 80px}
header.top{display:flex;flex-wrap:wrap;gap:16px;align-items:baseline;justify-content:space-between;
  padding-bottom:20px;border-bottom:1px solid var(--line);margin-bottom:24px}
h1{font-size:21px;margin:0;font-weight:650;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:13px;margin-top:4px}
.status{font-weight:700;font-size:13px;letter-spacing:.08em;text-transform:uppercase;
  padding:6px 14px;border-radius:999px}
.status.passed{color:var(--ok);background:var(--ok-bg)}
.status.passed-with-issues{color:var(--warn);background:var(--warn-bg)}
.status.needs-review{color:var(--warn);background:var(--warn-bg);border:1px dashed var(--warn)}
.verdict-card.needs-review{border-left-color:var(--warn)}
.callout.unsure{border-left:3px solid var(--warn)}
.status.failed,.status.dead-end{color:var(--bad);background:var(--bad-bg)}
.status.error{color:var(--warn);background:var(--warn-bg,var(--bad-bg))}
.status-group{display:flex;align-items:center;gap:8px}
.polarity{font-weight:600;font-size:11px;letter-spacing:.06em;text-transform:uppercase;
  padding:4px 10px;border-radius:999px;border:1px dashed var(--line);color:var(--muted);cursor:help}
.polarity.neg{color:var(--warn);border-color:var(--warn)}
.step-compare{margin:2px 0 0;font-size:12px;color:var(--muted)}
.step-compare code{font-size:12px}
.step-compare .cmp-bad{color:var(--bad)}
.step-facts{margin:-4px 0 0;padding:0 16px 8px 46px;font-size:12px;color:var(--muted);display:flex;gap:14px;flex-wrap:wrap}
.step-facts .fact-k{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;margin-right:4px}
.callout.observed{background:var(--agent-bg);border:1px solid color-mix(in srgb,var(--agent) 30%,transparent)}
.callout.observed .callout-title{color:var(--agent)}
.verdict.record-only{border-left-color:var(--info)}
.verdict.record-only .verdict-headline{color:var(--info);font-size:15px}
.sheet-id{font-size:11.5px;color:var(--muted);margin-left:8px}
.sheet-id code{font-size:11.5px}
.sheet-tag{display:inline-block;font-size:10.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;
  padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted);margin-left:8px}
.cards{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));margin-bottom:28px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px}
.card .v{font-size:24px;font-weight:650;letter-spacing:-.02em}
.card .k{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;margin-top:2px}
.card .note{font-size:12px;color:var(--muted);margin-top:6px}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);
  margin:34px 0 12px;font-weight:600}
ol.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.step{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
.step.failed,.step.dead-end{border-color:var(--bad)}
.step.error{border-color:var(--warn)}
.step.skipped{border-color:var(--line);color:var(--muted)}
.step-head{width:100%;display:flex;align-items:center;gap:11px;padding:11px 14px;background:none;
  border:0;color:inherit;font:inherit;text-align:left;cursor:pointer}
.step-head:hover{background:color-mix(in srgb,var(--ink) 4%,transparent)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);flex:none}
.step.failed .dot,.step.dead-end .dot{background:var(--bad)}
.step.error .dot{background:var(--warn)}
.step.skipped .dot{background:var(--muted)}
.idx{color:var(--muted);font-size:12px;min-width:20px;font-family:ui-monospace,monospace}
.action{font-weight:600;min-width:88px}
.target{flex:1;color:var(--muted);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badges{display:flex;gap:5px;flex:none}
.badge{font-size:10.5px;padding:2.5px 8px;border-radius:999px;font-weight:600;letter-spacing:.02em;white-space:nowrap}
.badge.res-fast{color:var(--fast);border:1px solid var(--line)}
.badge.res-backend{color:var(--dialog);background:var(--dialog-bg)}
.badge.res-case{color:var(--cache);background:var(--cache-bg)}
.badge.res-cache{color:var(--cache);background:var(--cache-bg)}
.badge.res-jit{color:var(--jit);background:var(--jit-bg)}
.badge.res-dialog{color:var(--dialog);background:var(--dialog-bg)}
.badge.res-generated, .badge.res-agent{color:var(--agent);background:var(--agent-bg)}
.time{font-size:12px;color:var(--muted);min-width:56px;text-align:right}
.chev{color:var(--muted);transition:transform .15s;font-size:11px}
.step-head[aria-expanded=true] .chev{transform:rotate(180deg)}
.step-body{padding:4px 14px 16px;border-top:1px solid var(--line)}
details.replaced{margin:12px 0;font-size:12.5px}
details.replaced summary{cursor:pointer;color:var(--muted)}
details.replaced .attempts{margin:10px 0 0;padding:0;list-style:none;display:grid;gap:8px}
.step.attempt{opacity:.85}
.callout{border-radius:8px;padding:12px 14px;margin:12px 0}
.callout-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}
.callout.heal{background:var(--jit-bg);border:1px solid color-mix(in srgb,var(--jit) 30%,transparent)}
.callout.heal .callout-title{color:var(--jit)}
.callout.dialog{background:var(--dialog-bg);border:1px solid color-mix(in srgb,var(--dialog) 30%,transparent)}
.callout.dialog .callout-title{color:var(--dialog)}
.callout.agent{background:var(--agent-bg);border:1px solid color-mix(in srgb,var(--agent) 30%,transparent)}
.callout.agent .callout-title{color:var(--agent)}
.callout.agent.failed{background:var(--bad-bg);border-color:var(--bad)}
.callout.agent.failed .callout-title{color:var(--bad)}
.callout.data{background:var(--cache-bg);border:1px solid color-mix(in srgb,var(--cache) 30%,transparent)}
.callout.data .callout-title{color:var(--cache)}
.callout.held,.callout.agent.held{background:var(--warn-bg,var(--bad-bg));border:1px solid color-mix(in srgb,var(--warn) 40%,transparent)}
.callout.held .callout-title,.callout.agent.held .callout-title{color:var(--warn)}
.badge.held{color:var(--warn);background:var(--warn-bg,var(--bad-bg))}
.agent-trace tr.held td{background:color-mix(in srgb,var(--warn) 10%,transparent)}
.prov.trend-newly-broken{border-color:var(--bad)}
.prov.trend-flaky{border-color:var(--jit)}
.prov.trend-newly-fixed{border-color:var(--ok)}
.callout.request{background:var(--request-bg);border:1px solid color-mix(in srgb,var(--request) 30%,transparent)}
.callout.request .callout-title{color:var(--request)}
.callout.request.failed{background:var(--bad-bg);border-color:var(--bad)}
.callout.request.failed .callout-title{color:var(--bad)}
.callout.network{background:var(--cache-bg);border:1px solid color-mix(in srgb,var(--cache) 30%,transparent)}
.callout.network .callout-title{color:var(--cache)}
.http-part{margin-top:10px}
.http-part-title{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;
  color:var(--muted);margin-bottom:4px}
.http-part pre{margin:4px 0 0;font-size:12.5px;white-space:pre-wrap;word-break:break-word;
  max-height:320px;overflow:auto}
.callout.error{background:var(--bad-bg);border:1px solid var(--bad)}
.callout.error .callout-title{color:var(--bad)}
.callout.error pre{margin:0;font-size:12.5px;white-space:pre-wrap;word-break:break-word}
.swap{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.swap code{font-size:12.5px;padding:3px 8px;border-radius:5px;background:color-mix(in srgb,var(--ink) 7%,transparent)}
.swap .was{text-decoration:line-through;opacity:.65}
.swap .now{font-weight:650}
.arrow{color:var(--muted)}
.reason{margin:6px 0;font-size:13.5px;color:var(--muted)}
.goal{margin:0 0 6px;font-size:13.5px}
.goal span{font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-right:8px}
.kv{display:grid;gap:6px 22px;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin:10px 0 0}
.kv.wide{grid-template-columns:repeat(auto-fit,minmax(230px,1fr));margin-top:12px}
.kv div{display:flex;flex-direction:column;gap:1px;min-width:0}
.kv dt{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.kv dd{margin:0;font-size:13px;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;font-size:13px}
.agent-trace{margin-top:8px}
.agent-trace th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;
  color:var(--muted);font-weight:600;padding:5px 8px;border-bottom:1px solid var(--line)}
.agent-trace td{padding:7px 8px;border-bottom:1px solid color-mix(in srgb,var(--line) 55%,transparent);vertical-align:top}
.agent-trace tr.bad td{background:color-mix(in srgb,var(--bad) 8%,transparent)}
.act{font-weight:650}
.reason-cell{color:var(--muted)}
.err{color:var(--bad);margin-top:3px;font-size:12px}
.num{text-align:right;white-space:nowrap;color:var(--muted)}
.shot-wrap{margin:14px 0 0}
.shot-wrap img{max-width:100%;border:1px solid var(--line);border-radius:8px;display:block;cursor:zoom-in}
.shot-wrap figcaption{font-size:11.5px;color:var(--muted);margin-top:6px}
.video{margin:0 0 18px;background:var(--panel);border:1px solid var(--line);
  border-radius:8px;padding:10px}
.video figcaption{display:flex;gap:10px;align-items:baseline;font-size:11px;
  text-transform:uppercase;letter-spacing:.08em;font-weight:700;margin-bottom:8px}
.video .hint{text-transform:none;letter-spacing:0;font-weight:400;margin-left:auto}
.video video{display:block;width:100%;height:auto;max-height:70vh;border-radius:4px;background:#000}
.video-missing{margin:0;font-size:13px;opacity:.75}
.seek{display:inline-block;margin:0 0 10px;padding:5px 10px;font:inherit;font-size:12px;
  cursor:pointer;border:1px solid var(--line);border-radius:4px;background:var(--panel);color:inherit}
.seek:hover{border-color:var(--ink)}
.video-subtitle{margin-top:8px;padding:8px 12px;border-radius:7px;background:var(--panel);
  border:1px solid var(--line);font-size:12.5px;line-height:1.45}
.video-subtitle .sub-step{font-weight:700;font-variant-numeric:tabular-nums;margin-right:8px;color:var(--muted)}
.video-subtitle.failed{border-color:var(--bad);background:var(--bad-bg);color:var(--bad)}
.video-subtitle.failed .sub-step{color:var(--bad)}
.video-subtitle .sub-how{display:block;margin-top:3px;font-family:var(--mono,monospace);font-size:11px;opacity:.9}
.filmstrip{margin:0 0 18px;background:var(--panel);border:1px solid var(--line);
  border-radius:var(--radius);padding:12px 14px}
.filmstrip figcaption{display:flex;gap:10px;align-items:baseline;font-size:11px;
  text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600;margin-bottom:9px}
.filmstrip .hint{text-transform:none;letter-spacing:0;font-weight:400;margin-left:auto}
.filmstrip .frames{display:flex;gap:0;align-items:center;overflow-x:auto;padding-bottom:4px}
.filmstrip .frame{flex:none;position:relative;padding:0;border:1px solid var(--line);
  border-radius:7px;background:var(--bg);cursor:pointer;line-height:0;overflow:hidden}
.filmstrip .frame:hover{border-color:var(--ink)}
.filmstrip .frame img{width:132px;height:82px;object-fit:cover;object-position:top left;display:block}
.filmstrip .frame span{position:absolute;left:0;bottom:0;line-height:1;font-size:10px;font-weight:700;
  padding:3px 6px;background:var(--ink);color:var(--panel);border-radius:0 7px 0 0;max-width:126px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The connector is what makes the strip read as one journey rather than a
   pile of thumbnails: each frame leads to the next, and the arrow INTO a
   broken frame turns red — the eye lands on where the flow snapped. */
.filmstrip .link{flex:none;width:22px;text-align:center;font-size:14px;line-height:1;color:var(--muted);user-select:none}
.filmstrip .link.broke{color:var(--bad);font-weight:700}
.filmstrip .frame.broke{border-color:var(--bad);box-shadow:0 0 0 2px var(--bad)}
.filmstrip .frame.broke span{background:var(--bad);color:#fff}
.filmstrip .frame.broke::after{content:'✗';position:absolute;top:2px;right:5px;color:#fff;font-size:12px;
  font-weight:700;line-height:1;background:var(--bad);border-radius:50%;width:16px;height:16px;
  display:flex;align-items:center;justify-content:center}
.defects{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
.defects th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
  font-weight:600;padding:10px 14px;border-bottom:1px solid var(--line)}
.defects td{padding:12px 14px;border-bottom:1px solid color-mix(in srgb,var(--line) 55%,transparent);vertical-align:top}
.defects tr:last-child td{border-bottom:0}
.pill{font-size:10.5px;font-weight:700;padding:2.5px 9px;border-radius:999px;text-transform:uppercase;letter-spacing:.04em}
.pill.sev-high{color:var(--bad);background:var(--bad-bg)}
.pill.sev-medium{color:var(--jit);background:var(--jit-bg)}
.pill.sev-low{color:var(--muted);border:1px solid var(--line)}
.pill.cat{color:var(--muted);border:1px solid var(--line)}
.d-title{font-weight:600;margin-bottom:3px}
.d-detail{color:var(--muted);font-size:13px}
.d-sel{display:inline-block;margin-top:6px;font-size:12px;padding:2px 7px;border-radius:4px;
  background:color-mix(in srgb,var(--ink) 7%,transparent)}
.muted{color:var(--muted)}

/* --- Layer 1: the verdict ------------------------------------------------ */
.verdict{background:var(--panel);border:1px solid var(--line);border-left:5px solid var(--fast);
  border-radius:var(--radius);padding:18px 20px;margin-bottom:18px}
.verdict.failed,.verdict.dead-end{border-left-color:var(--bad)}
.verdict.error{border-left-color:var(--warn)}
.verdict.passed{border-left-color:var(--ok)}
.verdict.needs-review, .verdict.passed-with-issues{border-left-color:var(--warn)}
.verdict-headline{margin:0 0 10px;font-size:19px;letter-spacing:-.01em}
.verdict.failed .verdict-headline,.verdict.dead-end .verdict-headline{color:var(--bad)}
.verdict.error .verdict-headline{color:var(--warn)}
.verdict.passed .verdict-headline{color:var(--ok)}
.verdict.passed-with-issues .verdict-headline{color:var(--warn)}
.verdict-line{margin:0 0 7px;font-size:14.5px;line-height:1.55;max-width:78ch}
.verdict-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:12px}
.owner{font-size:12px;padding:3px 9px;border-radius:999px;font-weight:600;
  background:color-mix(in srgb,var(--ink) 8%,transparent)}
.owner-backend{color:var(--dialog);background:var(--dialog-bg)}
.owner-frontend{color:var(--cache);background:var(--cache-bg)}
.owner-mixed{color:var(--jit);background:var(--jit-bg)}
.jump{font-size:12.5px;color:var(--cache);text-decoration:none;border-bottom:1px dashed currentColor}
.headline-cards{margin-bottom:26px}

/* --- Layer 2: the timeline ----------------------------------------------- */
.step .headline{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.step-sub{margin:-4px 0 0;padding:0 16px 10px 46px;font-size:12px;color:var(--muted);
  display:flex;gap:8px;align-items:baseline}
.step-sub .action{font-weight:600;letter-spacing:.02em}
.callout.trace{background:color-mix(in srgb,var(--ink) 4%,transparent);border:1px solid var(--line)}
.trace-list{margin:6px 0 0;padding-left:18px;font-size:13px;line-height:1.6}
.trace-rung{display:inline-block;min-width:58px;font-weight:600;color:var(--muted);
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;text-transform:uppercase}
.trace-detail{display:block;color:var(--muted);font-size:12px;margin-left:58px}
details.raw{margin-top:10px;font-size:12.5px}
details.raw summary{cursor:pointer;color:var(--muted)}
abbr[title]{text-decoration:underline dotted;text-underline-offset:2px;cursor:help}
.captured{font-style:normal}

/* --- Layer 3: diagnostics ------------------------------------------------ */
details.diagnostics{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
  padding:14px 16px;margin:26px 0}
details.diagnostics summary{cursor:pointer;font-weight:600;font-size:13.5px;color:var(--muted)}
details.diagnostics[open] summary{margin-bottom:14px}
details.diagnostics .cards{margin-bottom:0}
.empty{background:var(--panel);border:1px dashed var(--line);border-radius:var(--radius);
  padding:22px;text-align:center;color:var(--muted);font-size:13.5px}
.prov{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px;margin-bottom:24px}
footer{margin-top:44px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:12px;
  display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap}
dialog.lightbox{border:0;padding:0;background:transparent;max-width:94vw;max-height:94vh}
dialog.lightbox::backdrop{background:rgba(0,0,0,.78)}
dialog.lightbox img{max-width:94vw;max-height:94vh;border-radius:8px;display:block}
@media (max-width:768px) {
  .wrap { max-width: 100%; padding: 20px 16px; }
  .stats, .cards { grid-template-columns: 1fr; }
  .proof-grid { grid-template-columns: 1fr; }
  .kv { grid-template-columns: 1fr; }
  .verdict-actions { flex-direction: column; align-items: flex-start; }
  .film { overflow-x: auto; white-space: nowrap; -webkit-overflow-scrolling: touch; }
  .agent-trace { display: block; overflow-x: auto; white-space: nowrap; }
}
@media (max-width:640px){.target,.time{display:none}.action{min-width:0}}
`;

const SCRIPT = `
for (const head of document.querySelectorAll('.step-head')) {
  head.addEventListener('click', () => {
    const open = head.getAttribute('aria-expanded') === 'true';
    head.setAttribute('aria-expanded', String(!open));
    head.parentElement.querySelector('.step-body').hidden = open;
  });
}
// Failed steps start open — that is what the reader came for.
// A replaced attempt is history behind a closed disclosure, not a failure to open.
for (const head of document.querySelectorAll('.step.failed:not(.attempt) .step-head, .step.error:not(.attempt) .step-head, .step.dead-end:not(.attempt) .step-head')) head.click();

const box = document.getElementById('lightbox');
if (box) {
  const img = box.querySelector('img');
  for (const shot of document.querySelectorAll('.shot-wrap img')) {
    shot.addEventListener('click', () => { img.src = shot.src; box.showModal(); });
  }
  box.addEventListener('click', () => box.close());
}

// The filmstrip is assembled here, from the screenshots already in the page,
// rather than rendered into the file — see filmstripBlock. Each frame reuses
// the src string of the image inside its own step, so showing the run twice
// costs the report nothing.
const strip = document.getElementById('filmstrip');
const frames = document.getElementById('filmstrip-frames');
if (strip && frames) {
  let firstBroken = null;
  for (const step of document.querySelectorAll('.step:not(.attempt)')) {
    // The step's own screenshot — never one from an attempt folded under it.
    const shot = step.querySelector(':scope > .step-body > .shot-wrap img');
    if (!shot) continue;
    // Every non-pass status is a break in the journey — the step <li> wears
    // its status as a class, and 'failed' alone missed 'error' and 'dead-end'.
    const broke =
      step.classList.contains('failed') ||
      step.classList.contains('error') ||
      step.classList.contains('dead-end');
    if (frames.children.length > 0) {
      const link = document.createElement('span');
      link.className = 'link' + (broke ? ' broke' : '');
      link.textContent = '\u2192';
      link.setAttribute('aria-hidden', 'true');
      frames.appendChild(link);
    }
    const frame = document.createElement('button');
    frame.type = 'button';
    frame.className = 'frame' + (broke ? ' broke' : '');
    const index = step.getAttribute('data-step');
    const action = step.querySelector('.action')?.textContent ?? '';
    frame.title = 'step ' + index + ' — ' + (step.querySelector('.headline')?.textContent ?? '');
    const thumb = document.createElement('img');
    thumb.src = shot.src;
    thumb.alt = '';
    const label = document.createElement('span');
    label.textContent = index + ' · ' + action;
    frame.append(thumb, label);
    frame.addEventListener('click', () => {
      const head = step.querySelector('.step-head');
      if (head && head.getAttribute('aria-expanded') !== 'true') head.click();
      step.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    frames.appendChild(frame);
    if (broke && firstBroken === null) firstBroken = frame;
  }
  if (frames.children.length > 1) strip.hidden = false;
  // The reader's first question on a red run is "where did it snap" — put
  // the broken frame in view before they ask.
  if (firstBroken !== null) {
    firstBroken.scrollIntoView({ behavior: 'instant', inline: 'center', block: 'nearest' });
  }
}

// Per-step seek. The video is one element; every step points into it by
// offset, which is what turns a single clip into evidence for a particular
// step instead of something a reader has to scrub for.
const runVideo = document.getElementById('run-video');
if (runVideo) {
  // Chrome will not load a data: video, so the inline base64 becomes a Blob.
  // See videoBlock for the whole story; without this the player spins forever
  // on a recording that is perfectly fine.
  const b64 = runVideo.getAttribute('data-webm') || '';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  runVideo.src = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
  runVideo.removeAttribute('data-webm');
  // On a failed run the player opens ON the failure moment, not at the start:
  // the recording exists because a step broke, and the first frame a reader
  // sees should be the one it was kept for. Scrubbing back for the lead-up
  // stays one drag away.
  const failureOffset = parseFloat(runVideo.getAttribute('data-failure-offset') || '');
  if (!Number.isNaN(failureOffset)) {
    runVideo.addEventListener('loadedmetadata', () => {
      if (failureOffset < (runVideo.duration || Infinity)) runVideo.currentTime = failureOffset;
    }, { once: true });
  }
  // Live subtitle: which step the mock user is performing at this moment of
  // the film — and, in the failing step's segment, how it failed. The page's
  // baked-in caption can be lost to a navigation; this bar cannot.
  const figure = runVideo.closest('figure');
  const subtitle = document.getElementById('video-subtitle');
  let segments = [];
  try { segments = JSON.parse(figure?.getAttribute('data-segments') || '[]'); } catch { segments = []; }
  if (subtitle && segments.length > 0) {
    let shown = -1;
    const update = () => {
      const t = runVideo.currentTime;
      let active = null;
      for (const seg of segments) { if (seg.at <= t + 0.05) active = seg; else break; }
      if (!active || active.step === shown) return;
      shown = active.step;
      subtitle.hidden = false;
      subtitle.className = 'video-subtitle' + (active.failed ? ' failed' : '');
      subtitle.textContent = '';
      const num = document.createElement('span');
      num.className = 'sub-step';
      num.textContent = (active.failed ? '✗ ' : '') + 'step ' + active.step;
      subtitle.append(num, document.createTextNode(active.text));
      if (active.failed && active.error) {
        const how = document.createElement('span');
        how.className = 'sub-how';
        how.textContent = active.error;
        subtitle.appendChild(how);
      }
    };
    runVideo.addEventListener('timeupdate', update);
    runVideo.addEventListener('seeked', update);
    runVideo.addEventListener('loadedmetadata', update, { once: true });
  }

  for (const button of document.querySelectorAll('.seek')) {
    button.addEventListener('click', () => {
      runVideo.currentTime = parseFloat(button.getAttribute('data-seek')) || 0;
      runVideo.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Autoplay is muted-only in every browser and this recording has no
      // audio track at all, so this is never blocked and never makes noise.
      runVideo.play().catch(() => {});
    });
  }
}
`;

export interface RenderOptions {
  /** Extra bundles rendered as additional runs in one file. */
  title?: string | undefined;
}

/** Render a bundle to a complete, standalone HTML document. */
export function renderReport(bundle: ProofBundle, options: RenderOptions = {}): string {
  const s = bundle.summary;
  const title = options.title ?? `wowlidator report — ${bundle.name}`;
  const totalTokens = s.inputTokens + s.outputTokens;
  const highDefects = bundle.defects.filter((d) => d.severity === 'high').length;
  const verdict = buildVerdict(bundle);

  // Three chips, not twelve. Everything else moved into Diagnostics: a reader
  // deciding what to do about a red run is not served by `fast path: 3` having
  // the same visual weight as `2 failed`.
  const headlineCards = [
    {
      v: `${s.passed}/${s.totalSteps}`,
      k: 'steps passed',
      note: s.failed > 0 ? `${s.failed} failed` : 'no failures',
    },
    {
      v: String(s.defects),
      k: 'findings',
      note: highDefects > 0 ? `${highDefects} high severity` : 'none high severity',
    },
    { v: ms(bundle.durationMs), k: 'took', note: new Date(bundle.startedAt).toISOString().slice(0, 10) },
  ];

  const cards = [
    {
      v: `${s.passed}/${s.totalSteps}`,
      k: 'steps passed',
      note: s.failed > 0 ? `${s.failed} failed` : 'no failures',
    },
    {
      v: String(s.fastPath),
      k: 'fast path',
      note: 'free, deterministic',
    },
    {
      v: String(s.cacheHits),
      k: 'cache hits',
      note: 'repairs reused, free',
    },
    {
      v: String(s.jitHeals),
      k: 'JIT heals',
      note: s.jitHeals > 0 ? `${ms(s.healLatencyMs)} of model time` : 'no drift detected',
    },
    {
      v: String(s.agentTakeovers),
      k: 'agent takeovers',
      note: s.agentTakeovers > 0 ? `${ms(s.agentLatencyMs)} navigating` : 'no interstitials',
    },
    {
      v: totalTokens > 0 ? totalTokens.toLocaleString('en-US') : '0',
      k: 'tokens used',
      note: `${s.inputTokens.toLocaleString('en-US')} in / ${s.outputTokens.toLocaleString('en-US')} out`,
    },
    {
      v: String(s.defects),
      k: 'defects',
      note: highDefects > 0 ? `${highDefects} high severity` : 'none high severity',
    },
    {
      v: ms(bundle.durationMs),
      k: 'wall clock',
      note: bundle.healerModel ?? 'healing disabled',
    },
  ];

  // What the evidence cost. Capturing every step is the default, and the price
  // is paid entirely in the size of this file — so the file says so, rather
  // than leaving someone to wonder why a report is 3 MB.
  const frames = bundle.steps.filter((step) => step.screenshot !== undefined);
  if (frames.length > 0) {
    const bytes = frames.reduce((total, step) => total + (step.screenshot?.length ?? 0), 0);
    cards.push({
      v: `${frames.length}/${bundle.steps.length}`,
      k: 'steps with evidence',
      note: `${(bytes / 1024 / 1024).toFixed(2)} MB embedded`,
    });
  }

  if (bundle.video) {
    const endsAt = bundle.video.endsAtStep;
    cards.push({
      v: bundle.video.durationMs === undefined ? '—' : ms(bundle.video.durationMs),
      k: 'recording',
      note: bundle.video.data
        ? `${(bundle.video.bytes / 1024 / 1024).toFixed(2)} MB, ${bundle.video.width}×${bundle.video.height}` +
          (endsAt === undefined ? '' : `, cut at step ${endsAt}`)
        : 'recording not embedded',
    });
  }

  if (s.visualChecks > 0) {
    cards.splice(5, 0, {
      v: `${s.visualChecks - s.visualFailures}/${s.visualChecks}`,
      k: 'visual snapshots',
      note: s.visualFailures > 0 ? `${s.visualFailures} drifted` : 'no drift',
    });
  }

  if (meaningfulCoverage(bundle) && bundle.coverage) {
    const cov = bundle.coverage;
    cards.splice(7, 0, {
      v: `${Math.round((cov.ratio ?? 0) * 100)}%`,
      k: 'UI coverage',
      note: `${cov.exercised}/${cov.total} controls exercised`,
    });
  }

  if (s.dialogsDismissed > 0) {
    // Inserted by a dynamic lookup, not a fixed index — the splices above
    // already shift the array.
    const afterJitHeals = cards.findIndex((c) => c.k === 'JIT heals') + 1;
    cards.splice(afterJitHeals, 0, {
      v: String(s.dialogsDismissed),
      k: 'dialogs dismissed',
      note: 'unexpected, and cleared automatically',
    });
  }

  if (s.backend.steps > 0 || s.backend.defects > 0) {
    // Which side is broken is the first question a mixed run has to answer, so
    // the split sits immediately after the headline. Omitted entirely on a
    // pure-UI run, where the headline already is the frontend number.
    const afterSteps = cards.findIndex((c) => c.k === 'steps passed') + 1;
    cards.splice(
      afterSteps,
      0,
      {
        v: `${s.frontend.passed}/${s.frontend.steps}`,
        k: 'frontend steps',
        note: s.frontend.failed > 0 ? `${s.frontend.failed} failed` : 'UI side green',
      },
      {
        v: `${s.backend.passed}/${s.backend.steps}`,
        k: 'backend steps',
        note: s.backend.failed > 0 ? `${s.backend.failed} failed` : 'API side green',
      },
    );
  }

  if (s.apiRequests > 0) {
    const afterSteps =
      cards.findIndex((c) => c.k === 'backend steps') + 1 ||
      cards.findIndex((c) => c.k === 'steps passed') + 1;
    cards.splice(afterSteps, 0, {
      v: String(s.apiRequests),
      k: 'API requests',
      note: s.apiFailures > 0 ? `${s.apiFailures} never answered` : 'all answered',
    });
  }

  if (s.networkFailures > 0 || s.backendBlocked > 0) {
    // Only shown when there's something to say: on a healthy run the traffic
    // count is noise, but a failed request is the most important number on
    // the page — it means the app broke, not the test.
    const afterJit = cards.findIndex((c) => c.k === 'JIT heals') + 1;
    cards.splice(afterJit, 0, {
      v: String(s.networkFailures),
      k: 'failed requests',
      note:
        s.backendBlocked > 0
          ? `${s.backendBlocked} step(s) not healed as a result`
          : 'observed on the page',
    });
  }

  const trend = bundle.trend
    ? `<div class="prov trend-${esc(bundle.trend.verdict)}">
         <div class="callout-title">Trend — ${esc(bundle.trend.verdict.replace(/-/g, ' '))}</div>
         <p class="reason">${esc(bundle.trend.message)}</p>
         <dl class="kv">
           <div><dt>runs compared</dt><dd>${bundle.trend.sampleSize}</dd></div>
           <div><dt>pass/fail flips</dt><dd>${bundle.trend.flips}</dd></div>
           ${bundle.trend.coverageDelta === undefined || !meaningfulCoverage(bundle) ? '' : `<div><dt>coverage change</dt><dd>${bundle.trend.coverageDelta > 0 ? '+' : ''}${bundle.trend.coverageDelta}pp</dd></div>`}
           ${bundle.trend.newFailures.length === 0 ? '' : `<div><dt>new failures</dt><dd>${esc(bundle.trend.newFailures.join(', '))}</dd></div>`}
         </dl>
       </div>`
    : '';

  // The sheet-side identity of a catalog case: the sheet's own spelling of
  // the id when the run qualified it (CG-04), the sheet and category the row
  // came from, and what the sheet itself recorded. Read structurally — see
  // `provenanceExtras` — so the header is right the day the stamp lands.
  const extras = provenanceExtras(bundle);
  const caseId = displayCaseId(bundle.name.split(/\s+/)[0] ?? bundle.name, extras.sheetCaseId);
  const sheetTag = sheetLabel(extras);
  const provenance = bundle.generatedBy
    ? `<div class="prov">
         <div class="callout-title">Autonomously generated</div>
         <dl class="kv wide">
           <div><dt>kind</dt><dd>${esc(bundle.generatedBy.kind)}</dd></div>
           <div><dt>model</dt><dd>${esc(bundle.generatedBy.model)}</dd></div>
           <div><dt>source page</dt><dd><code>${esc(bundle.generatedBy.sourceUrl)}</code></dd></div>
           <div><dt>generated</dt><dd>${esc(bundle.generatedBy.generatedAt)}</dd></div>
           ${extras.sheet ? `<div><dt>sheet</dt><dd>${captured(extras.sheet)}</dd></div>` : ''}
           ${extras.category ? `<div><dt>category</dt><dd>${captured(extras.category)}</dd></div>` : ''}
           ${caseId.qualified ? `<div><dt>sheet case id</dt><dd><code>${captured(caseId.shown)}</code> <span class="muted">(run as ${esc(caseId.qualified)})</span></dd></div>` : ''}
           ${extras.sheetVerdict ? `<div><dt>sheet recorded</dt><dd>${esc(extras.sheetVerdict)}</dd></div>` : ''}
         </dl>
         <p class="reason">${esc(bundle.generatedBy.rationale)}</p>
       </div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div>
      <h1>${esc(bundle.name)}${
        caseId.qualified
          ? `<span class="sheet-id" title="the sheet's own spelling of this case id — the run qualified it because the id repeats across or within sheets">sheet id <code>${captured(caseId.shown)}</code></span>`
          : ''
      }${sheetTag ? `<span class="sheet-tag" title="the workbook sheet and category this case came from">${captured(sheetTag)}</span>` : ''}</h1>
      <div class="sub">
        run <code>${esc(bundle.runId)}</code> &middot; ${esc(bundle.startedAt)}
        ${bundle.cdpUrl ? ` &middot; ${esc(bundle.cdpUrl)}` : ''}
        ${bundle.caseStartedAt ? `<br/>case started <code>${esc(bundle.caseStartedAt)}</code> &middot; took ${ms(bundle.caseDurationMs ?? bundle.durationMs)}` : ''}
      </div>
    </div>
    <div class="status-group">${polarityPill(bundle)}<span class="status ${esc(bundle.status)}" title="machine status: ${esc(bundle.status)}">${esc(familyLabel(bundle.status))}</span></div>
  </header>

  ${verdictBlock(verdict)}
  ${recordOnlyBlock(bundle)}

  <section class="cards headline-cards">
    ${headlineCards.map((c) => `<div class="card"><div class="v">${esc(c.v)}</div><div class="k">${esc(c.k)}</div><div class="note">${esc(c.note)}</div></div>`).join('')}
  </section>

  ${
    bundle.error
      ? `<div class="callout error"><div class="callout-title">Run error</div><pre>${esc(bundle.error)}</pre></div>`
      : ''
  }

  <h2>What the test did</h2>
  ${videoBlock(bundle)}
  ${filmstripBlock(bundle)}
  ${
    bundle.steps.length === 0
      ? '<div class="empty">No steps were executed.</div>'
      : `<ol class="steps">${stepList(bundle, bundle.video?.data !== undefined)}</ol>`
  }

  <details class="diagnostics">
    <summary>Diagnostics — how wowlidator resolved each step, traffic, model cost</summary>
    ${
      bundle.dbBaseline
        ? `<div class="prov"><div class="callout-title">Database baseline</div>
           <p class="reason">Snapshotted before the run and compared on every backend step: <code>${esc(bundle.dbBaseline.tables.join(', '))}</code> · taken ${esc(bundle.dbBaseline.takenAt)}.</p></div>`
        : ''
    }
    ${
      bundle.notes && bundle.notes.length > 0
        ? `<div class="prov"><div class="callout-title">Run notes (${bundle.notes.length})</div>
           ${bundle.notes.map(n => `<p class="reason">${esc(n)}</p>`).join('')}</div>`
        : ''
    }
    ${
      bundle.status === 'needs-review'
        ? `<div class="prov trend-newly-broken" style="border-left-color:var(--warn)">
             <div class="callout-title">Proved-? — needs a human ruling</div>
             <p class="reason">Every broken step failed only on wording, and closely: the page produced the right kind of thing under a name the claim does not quite match. Whether that is a spec violation or an acceptable rendering is your call, not the machine's.</p>
             ${bundle.review ? `<p class="reason"><strong>Ruling:</strong> ${esc(bundle.review.verdict)} by ${esc(bundle.review.by || 'human')} at ${esc(bundle.review.at)}</p>` : ''}
           </div>`
        : ''
    }
    ${
      bundle.variables && Object.keys(bundle.variables).length > 0
        ? `<div class="prov"><div class="callout-title">Variables</div>
           <dl class="kv wide">${Object.entries(bundle.variables).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd><code>${esc(v)}</code></dd></div>`).join('')}</dl></div>`
        : ''
    }
    ${trend}
    ${provenance}
    <section class="cards">
      ${cards.map((c) => `<div class="card"><div class="v">${esc(c.v)}</div><div class="k">${esc(c.k)}</div><div class="note">${esc(c.note)}</div></div>`).join('')}
    </section>
  </details>

  ${
    meaningfulCoverage(bundle) && bundle.coverage && bundle.coverage.untouched.length > 0
      ? `<h2>Untested controls</h2>
         <div class="defects"><table>
           <thead><tr><th>role</th><th>accessible name</th><th>selector</th><th>state</th></tr></thead>
           <tbody>${bundle.coverage.untouched
             .map(
               (c) => `<tr>
                 <td><span class="pill cat">${esc(c.role)}</span></td>
                 <td>${captured(c.name || '(unnamed)')}</td>
                 <td><code class="d-sel">${esc(c.selector)}</code></td>
                 <td class="num">${c.disabled ? '<span class="muted">disabled</span>' : ''}</td>
               </tr>`,
             )
             .join('')}</tbody>
         </table></div>`
      : ''
  }

  <h2>Defects</h2>
  ${
    bundle.defects.length === 0
      ? '<div class="empty">No functional or usability defects recorded.</div>'
      : `<div class="defects"><table>
           <thead><tr><th>severity</th><th>category</th><th>finding</th><th>origin</th></tr></thead>
           <tbody>${bundle.defects.map(defectRow).join('')}</tbody>
         </table></div>`
  }

  <footer>
    <span>wowlidator &middot; decoupled execution, JIT healing, agentic navigation</span>
    <span>finished ${esc(bundle.finishedAt)}</span>
  </footer>
</div>
<dialog class="lightbox" id="lightbox"><img alt="Enlarged screenshot"></dialog>
<script>${SCRIPT}</script>
</body>
</html>`;
}

/** Render and write the report. Returns the absolute path written. */
export async function writeHtmlReport(
  bundle: ProofBundle,
  target: string,
  options: RenderOptions = {},
): Promise<string> {
  const path = resolve(target);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderReport(bundle, options), 'utf8');
  return path;
}
