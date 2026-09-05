/**
 * Machine-readable results: JUnit XML and CTRF JSON (spec A1).
 *
 * The HTML report is for a person. CI systems want a format they already parse,
 * so that a failure becomes an inline annotation on a pull request rather than
 * a link somebody has to click. JUnit XML is the lingua franca — GitHub,
 * GitLab, Jenkins, Buildkite and every dashboard in between ingest it without
 * configuration — and CTRF is the modern JSON alternative for anything that
 * wants wowlidator's own numbers rather than the lowest common denominator.
 *
 * Both are pure functions of the same `ProofBundle`s the HTML reporter renders,
 * for the same reason `renderReport` is pure: a format nobody can test in
 * isolation is a format that silently rots.
 *
 * ## Two decisions worth keeping
 *
 * **A step is a test case.** Mapping a whole flow to one `<testcase>` would
 * throw away the only thing a dashboard is good at — pointing at the line that
 * broke. The case name is the author's `intent` when they wrote one, because
 * "Click Due Soon filter button" is what a reader can act on and
 * `click role=button[name="DUE SOON" i]` is not.
 *
 * **The frontend and backend halves become separate `<testsuite>`s.** That is
 * the whole point of the split reaching CI: a dashboard should be able to show
 * "backend: 1 failed" without anyone opening a report.
 *
 * Redaction is inherited, not re-implemented: these emitters read the same
 * already-redacted `RequestRecord`s the HTML report does, so a credential that
 * cannot reach the HTML cannot reach here either. There is a test asserting it.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { isPassing, BACKEND_TIER_ACTIONS, type ProofBundle, type ProofStep } from '../engine/proof-bundle.js';
import { observedEvidence, stepKindFacts, stepTarget } from './step-facts.js';
import { buildVerdict } from './verdict.js';

/** Escape for XML text and attribute values. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // XML 1.0 forbids most control characters outright; a screenshot-adjacent
    // byte or a terminal escape in a page's text would otherwise produce a
    // document no parser will accept.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** Seconds, as JUnit consumers expect. */
function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

/** What a reader should see as the case name. */
function caseName(step: ProofStep): string {
  // `stepTarget`, not `selector`: an `expectAnyVisible` has a LIST of
  // selectors and a `signIn` a persona, and a testcase named bare
  // "expectAnyVisible" is the empty row wearing a CI badge.
  return step.intent ?? `${step.action} ${stepTarget(step) ?? ''}`.trim();
}

function classOf(bundle: ProofBundle, step: ProofStep): string {
  const side = BACKEND_TIER_ACTIONS.has(step.action) ? 'backend' : 'frontend';
  return `wowlidator.${side}.${bundle.name}`;
}

export interface MachineReportOptions {
  /** Wall-clock stamp for the document. Defaults to the bundle's own. */
  timestamp?: string | undefined;
}

/**
 * Render one or more bundles as JUnit XML.
 *
 * Quarantined runs (see `--quarantine-flaky`) emit `<skipped>` rather than
 * `<failure>`: the result is still visible, but a known-flaky case does not
 * turn a pipeline red — which is the only way a quarantine is worth anything.
 */
export function renderJUnit(
  bundles: readonly ProofBundle[],
  options: MachineReportOptions = {},
): string {
  const totals = bundles.reduce(
    (acc, bundle) => ({
      tests: acc.tests + bundle.summary.totalSteps,
      failures: acc.failures + (bundle.quarantined ? 0 : bundle.summary.failed),
      skipped: acc.skipped + bundle.steps.filter((step) => step.status === 'skipped').length +
        (bundle.quarantined ? bundle.summary.failed : 0),
      time: acc.time + bundle.durationMs,
    }),
    { tests: 0, failures: 0, skipped: 0, time: 0 },
  );

  const suites = bundles
    .map((bundle) => {
      const verdict = buildVerdict(bundle);
      const cases = bundle.steps
        .map((step) => {
          const name = xmlEscape(caseName(step));
          const attrs =
            `name="${name}" classname="${xmlEscape(classOf(bundle, step))}" ` +
            `time="${seconds(step.durationMs)}"`;
          if (step.status === 'passed') return `      <testcase ${attrs}/>`;
          const message = xmlEscape((step.error ?? 'step failed').split('\n')[0] ?? 'step failed');
          const body = xmlEscape(step.error ?? '');
          // A quarantined failure is reported, not counted — the report and
          // the JSON still shout about it.
          const inner = step.status === 'skipped'
            ? `        <skipped message="${message}"/>`
            : bundle.quarantined
            ? `        <skipped message="quarantined (known flaky): ${message}"/>`
            : `        <failure message="${message}" type="${xmlEscape(step.action)}">${body}</failure>`;
          return `      <testcase ${attrs}>\n${inner}\n      </testcase>`;
        })
        .join('\n');

      const properties = [
        ['wowlidator.verdict', verdict.what],
        ['wowlidator.owner', verdict.owner ?? 'none'],
        ['wowlidator.trend', bundle.trend?.verdict ?? 'unknown'],
        ['wowlidator.frontend', `${bundle.summary.frontend.passed}/${bundle.summary.frontend.steps}`],
        ['wowlidator.backend', `${bundle.summary.backend.passed}/${bundle.summary.backend.steps}`],
        ['wowlidator.runId', bundle.runId],
      ]
        .map(([k, v]) => `      <property name="${xmlEscape(k!)}" value="${xmlEscape(v ?? '')}"/>`)
        .join('\n');

      return (
        `    <testsuite name="${xmlEscape(bundle.name)}" tests="${bundle.summary.totalSteps}" ` +
        `failures="${bundle.quarantined ? 0 : bundle.summary.failed}" ` +
        `skipped="${bundle.steps.filter((step) => step.status === 'skipped').length + (bundle.quarantined ? bundle.summary.failed : 0)}" ` +
        `time="${seconds(bundle.durationMs)}" timestamp="${xmlEscape(options.timestamp ?? bundle.startedAt)}">\n` +
        `      <properties>\n${properties}\n      </properties>\n${cases}\n    </testsuite>`
      );
    })
    .join('\n');

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites name="wowlidator" tests="${totals.tests}" failures="${totals.failures}" ` +
    `skipped="${totals.skipped}" time="${seconds(totals.time)}">\n${suites}\n</testsuites>\n`
  );
}

/** CTRF report shape — the fields consumers rely on, plus wowlidator's own under `extra`. */
export interface CtrfReport {
  results: {
    tool: { name: string; version: string };
    summary: {
      tests: number;
      passed: number;
      failed: number;
      skipped: number;
      pending: number;
      other: number;
      start: number;
      stop: number;
    };
    tests: {
      name: string;
      status: 'passed' | 'failed' | 'skipped';
      duration: number;
      message?: string;
      trace?: string;
      suite: string;
      extra: Record<string, unknown>;
    }[];
    extra: Record<string, unknown>;
  };
}

/** Render bundles as CTRF JSON — richer than JUnit, still machine-first. */
export function renderCtrf(bundles: readonly ProofBundle[], version = '0.2.0'): CtrfReport {
  const tests = bundles.flatMap((bundle) =>
    bundle.steps.map((step) => {
      const status: 'passed' | 'failed' | 'skipped' =
        step.status === 'passed' ? 'passed' : step.status === 'skipped' || bundle.quarantined ? 'skipped' : 'failed';
      const test: CtrfReport['results']['tests'][number] = {
        name: caseName(step),
        status,
        duration: step.durationMs,
        suite: `${bundle.name} / ${BACKEND_TIER_ACTIONS.has(step.action) ? 'backend' : 'frontend'}`,
        extra: {
          action: step.action,
          selector: step.selector ?? null,
          // What the step was aimed at when `selector` is null by construction
          // (the alternatives of an either/or, an upload's file names, a
          // persona LABEL — never an address), plus the kind's own facts.
          target: stepTarget(step),
          facts: Object.fromEntries(stepKindFacts(step).map((f) => [f.label, f.value])),
          resolution: step.resolution,
          url: step.url ?? null,
          hasScreenshot: step.screenshot !== undefined,
          // Where in the run's recording this step is, for a CI viewer that
          // has the video alongside the report.
          videoOffsetMs: step.videoOffsetMs ?? null,
          // What the agent read off the page on an observe-and-record leg.
          observed: observedEvidence(step),
        },
      };
      if (step.error) {
        test.message = step.error.split('\n')[0] ?? step.error;
        test.trace = step.error;
      }
      return test;
    }),
  );

  const start = Math.min(...bundles.map((b) => Date.parse(b.startedAt)));
  const stop = Math.max(...bundles.map((b) => Date.parse(b.finishedAt)));

  return {
    results: {
      tool: { name: 'wowlidator', version },
      summary: {
        tests: tests.length,
        passed: tests.filter((t) => isPassing(t.status)).length,
        failed: tests.filter((t) => t.status === 'failed').length,
        skipped: tests.filter((t) => t.status === 'skipped').length,
        pending: 0,
        other: 0,
        start: Number.isFinite(start) ? start : 0,
        stop: Number.isFinite(stop) ? stop : 0,
      },
      tests,
      // wowlidator's own numbers, where a CTRF consumer can find them without
      // pretending they are part of the standard.
      extra: {
        runs: bundles.map((bundle) => ({
          name: bundle.name,
          runId: bundle.runId,
          status: bundle.status,
          quarantined: bundle.quarantined ?? false,
          verdict: buildVerdict(bundle).what,
          owner: buildVerdict(bundle).owner,
          trend: bundle.trend?.verdict ?? null,
          summary: bundle.summary,
          coverage: bundle.coverage
            ? { exercised: bundle.coverage.exercised, total: bundle.coverage.total }
            : null,
        })),
      },
    },
  };
}

/** Write JUnit XML. Returns the absolute path. */
export async function writeJUnitReport(
  bundles: readonly ProofBundle[],
  target: string,
  options: MachineReportOptions = {},
): Promise<string> {
  const path = resolve(target);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderJUnit(bundles, options), 'utf8');
  return path;
}

/** Write CTRF JSON. Returns the absolute path. */
export async function writeCtrfReport(
  bundles: readonly ProofBundle[],
  target: string,
): Promise<string> {
  const path = resolve(target);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(renderCtrf(bundles), null, 2)}\n`, 'utf8');
  return path;
}
