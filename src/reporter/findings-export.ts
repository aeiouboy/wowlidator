/**
 * The findings export — the run's root causes as a Markdown file and as a
 * workbook, both written beside the catalog report (asked for 2026-09-05).
 *
 * The HTML report leads with the same findings; this is the shape that goes
 * into a bug tracker or a mail without the 200MB of embedded evidence: one
 * entry per finding with its member cases, where it was met, what was asked
 * and offered, the typed evidence lines, the statuses AS SEALED, a suggested
 * severity under a rule stated at the top, and the steps to reproduce taken
 * from the first member's own flow.
 *
 * Rules carried over from `findings.ts` and `step-facts.ts`:
 * - no model call, no I/O beyond the two files, no status rewritten;
 * - the steps to reproduce are rendered through `stepTarget`,
 *   `describeTarget` and `visibleDetail`, so a credential the engine recorded
 *   on a step never reaches the file — and a value typed into a control whose
 *   selector or description names a password is withheld even when the key
 *   the engine stored it under is an innocent `value`.
 *
 * The workbook goes through the same hand-written zip writer as the
 * passed-cases export (`buildTextWorkbook` in `excel-export.ts`) and is read
 * back in tests through `catalog/extract.ts`'s independent reader.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { describeTarget, type ProofStep } from '../engine/proof-bundle.js';
import type { CatalogReportCase, CatalogReportInput } from './catalog-report.js';
import { buildTextWorkbook } from './excel-export.js';
import {
  SEVERITY_RULE,
  buildFindingsSummary,
  findingsHeadline,
  firstFailingStep,
  statusCounts,
  suggestedSeverity,
  type Finding,
  type FindingCase,
  type FindingsSummary,
} from './findings.js';
import { stepTarget, visibleDetail } from './step-facts.js';

/** A control whose name says it takes a secret — its typed value is withheld from the steps. */
const SECRET_CONTROL = /password|passwd|pwd|secret|token|otp|pin\b/i;
/** Longest detail value the steps carry inline; anything longer is a body, not a step. */
const MAX_INLINE_VALUE = 80;

function memberLine(m: FindingCase): string {
  const sealed = m.status ?? m.verdict;
  return `${m.id} (${sealed}${m.dependsOn === undefined ? '' : ` — depends on ${m.dependsOn}`})`;
}

/**
 * One step as a line of the reproduction: what it did, in the author's words,
 * on which control. Values come through `visibleDetail` (credential keys
 * already dropped) and are withheld outright on a secret-taking control.
 */
export function reproductionLine(step: ProofStep, n: number): string {
  const parts = [`${n}. ${step.action}`];
  if (step.intent) parts.push(`— ${step.intent}`);
  const target = stepTarget(step);
  if (target !== null) parts.push(`· ${target}`);
  const described = describeTarget(step.target);
  if (described !== null) parts.push(`(${described})`);
  const secret = SECRET_CONTROL.test(`${step.selector ?? ''} ${step.intent ?? ''} ${target ?? ''}`);
  const values: string[] = [];
  for (const [key, value] of visibleDetail(step)) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    const text = String(value);
    if (text === '' || text.length > MAX_INLINE_VALUE) continue;
    values.push(`${key}=${secret && key === 'value' ? '(withheld — a secret-taking control)' : JSON.stringify(text)}`);
  }
  if (values.length > 0) parts.push(`[${values.join(', ')}]`);
  return parts.join(' ');
}

/** The steps up to and including the failing one, superseded attempts left out. */
export function reproductionSteps(c: CatalogReportCase | undefined): string[] {
  const steps = c?.bundle?.steps;
  if (steps === undefined || steps.length === 0) return [];
  const failing = firstFailingStep(steps);
  const upTo = failing === null ? steps.length - 1 : failing.at;
  const lines: string[] = [];
  for (let i = 0; i <= upTo; i += 1) {
    const step = steps[i]!;
    if (step.superseded === true) continue;
    lines.push(reproductionLine(step, lines.length + 1));
  }
  return lines;
}

function findingMarkdown(f: Finding, n: number, byId: Map<string, CatalogReportCase>): string {
  const lines: string[] = [];
  lines.push(`## ${n}. ${f.title}`);
  lines.push('');
  lines.push(`- suggested severity: **${suggestedSeverity(f)}**`);
  lines.push(`- kind: ${f.kind} · key: \`${f.key}\``);
  lines.push(`- cases (${f.cases.length}): ${f.cases.map(memberLine).join(', ')}`);
  lines.push(`- status as sealed: ${statusCounts(f.cases).map((s) => `${s.status}: ${s.count}`).join(' · ')}`);
  if (f.where) lines.push(`- where: ${f.where}`);
  if (f.asked) lines.push(`- asked: ${f.asked}`);
  if (f.offered) lines.push(`- offered: ${f.offered}`);
  if (f.evidence.length > 0) {
    lines.push('- evidence:');
    for (const e of f.evidence) lines.push(`  - ${e.label}: ${e.value}`);
  }
  const sample = f.cases.find((m) => m.dependsOn === undefined) ?? f.cases[0];
  const steps = reproductionSteps(sample === undefined ? undefined : byId.get(sample.id));
  if (steps.length > 0) {
    lines.push('');
    lines.push(`Steps to reproduce (from ${sample!.id}):`);
    lines.push('');
    for (const s of steps) lines.push(s);
  }
  lines.push('');
  return lines.join('\n');
}

/** The Markdown document: headline, the severity rule, one section per finding, then the remainder. */
export function renderFindingsMarkdown(findings: readonly Finding[], input: CatalogReportInput): string {
  const folds = buildFindingsSummary(input.cases);
  // The caller's findings are the ones rendered — the projection supplies the
  // counts and the folds around them.
  const byId = new Map(input.cases.map((c) => [c.id, c] as const));
  const out: string[] = [];
  out.push(`# Findings — ${input.title}`);
  out.push('');
  out.push([input.runKey ?? '', input.generatedAt ? `authored ${input.generatedAt}` : '', `${input.cases.length} case(s)`].filter((s) => s !== '').join(' · '));
  out.push('');
  out.push(`> ${SEVERITY_RULE}`);
  out.push('');
  out.push(`**${findingsHeadline({ ...folds, findings: [...findings] })}** · never ran: ${folds.neverRan.length}`);
  out.push('');
  findings.forEach((f, i) => out.push(findingMarkdown(f, i + 1, byId)));
  if (folds.unclustered.length > 0) {
    out.push(`## Unclustered (${folds.unclustered.length})`);
    out.push('');
    out.push('Non-passing cases whose typed fields name no shared cause. Each keeps its own section in the HTML report.');
    out.push('');
    for (const m of folds.unclustered) {
      const reason = byId.get(m.id)?.reason;
      out.push(`- ${memberLine(m)}${reason ? ` — ${reason}` : ''}`);
    }
    out.push('');
  }
  if (folds.neverRan.length > 0) {
    out.push(`## Never ran (${folds.neverRan.length})`);
    out.push('');
    out.push(folds.neverRan.map((m) => m.id).join(', '));
    out.push('');
  }
  return out.join('\n');
}

/** The sheet's columns, in order. */
export const FINDINGS_COLUMNS = ['Finding', 'Cases', 'Where', 'Asked/Offered', 'Evidence', 'Status as sealed', 'Suggested severity'] as const;

/** The rows of the findings sheet (header excluded): one per finding, then the unclustered and never-ran folds. */
export function findingsRows(folds: FindingsSummary, cases: readonly CatalogReportCase[]): string[][] {
  const byId = new Map(cases.map((c) => [c.id, c] as const));
  const rows: string[][] = folds.findings.map((f) => {
    const sample = f.cases.find((m) => m.dependsOn === undefined) ?? f.cases[0];
    const steps = reproductionSteps(sample === undefined ? undefined : byId.get(sample.id));
    return [
      `${f.title}\n[${f.kind}] ${f.key}`,
      f.cases.map(memberLine).join('\n'),
      f.where ?? '',
      [f.asked ? `asked: ${f.asked}` : '', f.offered ? `offered: ${f.offered}` : ''].filter((s) => s !== '').join('\n'),
      [...f.evidence.map((e) => `${e.label}: ${e.value}`), ...(steps.length === 0 ? [] : ['', `steps to reproduce (${sample!.id}):`, ...steps])].join('\n'),
      statusCounts(f.cases).map((s) => `${s.status}: ${s.count}`).join('\n'),
      suggestedSeverity(f),
    ];
  });
  if (folds.unclustered.length > 0) {
    rows.push([
      `unclustered (${folds.unclustered.length}) — no shared cause in the typed fields`,
      folds.unclustered.map(memberLine).join('\n'),
      '',
      '',
      folds.unclustered.map((m) => byId.get(m.id)?.reason ?? '').filter((r) => r !== '').join('\n'),
      statusCounts(folds.unclustered).map((s) => `${s.status}: ${s.count}`).join('\n'),
      '',
    ]);
  }
  if (folds.neverRan.length > 0) {
    rows.push([`never ran (${folds.neverRan.length})`, folds.neverRan.map((m) => m.id).join('\n'), '', '', '', `never ran: ${folds.neverRan.length}`, '']);
  }
  return rows;
}

/** The findings workbook: the rule in the first row, the columns, one row per finding. */
export function buildFindingsWorkbook(input: CatalogReportInput): Buffer {
  const folds = buildFindingsSummary(input.cases);
  return buildTextWorkbook({
    sheetName: 'Findings',
    preface: `${findingsHeadline(folds)} · never ran: ${folds.neverRan.length}. ${SEVERITY_RULE}`,
    header: FINDINGS_COLUMNS,
    rows: findingsRows(folds, input.cases),
    widths: [48, 30, 24, 34, 60, 18, 14],
  });
}

export interface FindingsExportResult {
  markdownPath: string;
  xlsxPath: string;
  findings: number;
  unclustered: number;
}

/** `reports/<base>.html` → `<base>-findings.md` and `<base>-findings.xlsx`. */
export function findingsExportNames(htmlReportPath: string): { markdownPath: string; xlsxPath: string } {
  const base = htmlReportPath.replace(/\.html$/, '');
  return { markdownPath: `${base}-findings.md`, xlsxPath: `${base}-findings.xlsx` };
}

/** Writes both files beside the report. Rebuilt from the ledger by `wowlidator report`, no re-run needed. */
export async function writeFindingsExports(htmlReportPath: string, input: CatalogReportInput): Promise<FindingsExportResult> {
  const { markdownPath, xlsxPath } = findingsExportNames(htmlReportPath);
  const folds = buildFindingsSummary(input.cases);
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(markdownPath, renderFindingsMarkdown(folds.findings, input), 'utf8');
  await writeFile(xlsxPath, buildFindingsWorkbook(input));
  return { markdownPath, xlsxPath, findings: folds.findings.length, unclustered: folds.unclustered.length };
}
