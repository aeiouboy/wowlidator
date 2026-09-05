#!/usr/bin/env node
/**
 * `npm run bench` — score the QA agent against a labelled set of frozen proof
 * bundles (2026-09-05). The frozen-artifact half of the benchmark: no model,
 * no browser, no application. Every number is a pure function of the bundles
 * on disk and the label file beside them (`score.ts`).
 *
 * Gated behind `WOWLIDATOR_BENCH=1` like the shell and Chrome tiers — not
 * because it cannot run, but because it should not run unasked: it writes
 * under `reports/`, and a score nobody asked for is a number nobody reads.
 *
 *   WOWLIDATOR_BENCH=1 npm run bench
 *   WOWLIDATOR_BENCH=1 npm run bench -- --baseline reports/bench/bench-score.json
 *   WOWLIDATOR_BENCH=1 npm run bench -- --labels path/to/labels.json --out reports/bench
 *
 * Exit codes follow the CLI's contract: 0 scored, 2 a file that would not
 * parse or a bad flag, 3 the gate refused.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { parseProofBundle } from '../artifacts/schemas.js';
import { effectiveStatus, type ProofBundle } from '../engine/proof-bundle.js';
import { readBenchLabels, readBenchScoreFile, type BenchLabel } from './labels.js';
import { diffScores, isFiledDefect, scoreBench, type BenchCost, type BenchEntry, type BenchScore } from './score.js';

export const BENCH_GATE = 'WOWLIDATOR_BENCH';
const EXIT = { ok: 0, usage: 2, environment: 3 } as const;

const ROOT = resolve(import.meta.dirname, '..', '..');
const DEFAULT_LABELS = join(ROOT, 'tests', 'fixtures', 'bench', 'labels.json');
const DEFAULT_OUT = join(ROOT, 'reports', 'bench');

/** One scored row, kept in the score file so a delta can be traced to a case. */
export interface BenchRow {
  bundle: string;
  name: string;
  status: string;
  defects: number;
  origin: string | null;
  truth: BenchLabel['truth'];
  filed: boolean;
  note?: string | undefined;
}

export interface BenchScoreOutput {
  labelSet: string;
  labelsFile: string;
  generatedAt: string;
  score: BenchScore;
  rows: BenchRow[];
}

/**
 * The set's name: the label file's basename, or — when it is the generic
 * `labels.json` — the directory that holds it, so a score file is named after
 * the set (`bench-score.json`) rather than after every set alike.
 */
export function labelSetName(labelsFile: string): string {
  const base = basename(labelsFile).replace(/\.json$/i, '');
  return base === 'labels' ? basename(dirname(labelsFile)) : base;
}

/** Read every labelled bundle through the proof-bundle seam; a bad one names itself. */
export async function loadLabelled(labelsFile: string): Promise<{ labels: BenchLabel[]; entries: BenchEntry[]; rows: BenchRow[] }> {
  const labels = await readBenchLabels(labelsFile);
  const dir = dirname(labelsFile);
  const entries: BenchEntry[] = [];
  const rows: BenchRow[] = [];
  for (const label of labels) {
    const file = resolve(dir, label.bundle);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      throw new Error(`bench bundle ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = parseProofBundle(raw);
    if (!parsed.ok) throw new Error(`bench bundle ${file}: ${parsed.issue}`);
    const bundle: ProofBundle = parsed.value;
    entries.push({ truth: label.truth, bundle });
    rows.push({
      bundle: label.bundle,
      name: bundle.name,
      status: String(effectiveStatus(bundle)),
      defects: Array.isArray(bundle.defects) ? bundle.defects.length : 0,
      origin: typeof bundle.diagnosis?.origin === 'string' ? bundle.diagnosis.origin : null,
      truth: label.truth,
      filed: isFiledDefect(bundle),
      note: label.note,
    });
  }
  return { labels, entries, rows };
}

// --- rendering ---------------------------------------------------------------

function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function signed(value: number, digits = 1): string {
  const s = value.toFixed(digits);
  return value > 0 ? `+${s}` : s;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function costLine(cost: BenchCost, format: (n: number) => string, money: (n: number) => string): string {
  return (
    `turns ${format(cost.modelTurns)} · in ${format(cost.inputTokens)} · out ${format(cost.outputTokens)}` +
    ` · cached ${format(cost.cachedInputTokens)} · page calls ${format(cost.pageCalls)}` +
    ` · ${format(cost.durationMs / 1000)}s · session calls ${format(cost.sessionCalls)} · $${money(cost.sessionCostUsd)}`
  );
}

export function renderTable(rows: BenchRow[], score: BenchScore): string {
  const lines: string[] = [];
  const w = {
    name: Math.max(4, ...rows.map((r) => r.name.trim().length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
    origin: Math.max(6, ...rows.map((r) => (r.origin ?? '—').length)),
    truth: Math.max(5, ...rows.map((r) => r.truth.length)),
  };
  lines.push(
    `${pad('case', w.name)}  ${pad('status', w.status)}  def  ${pad('origin', w.origin)}  ${pad('truth', w.truth)}  filed`,
  );
  for (const r of rows) {
    lines.push(
      `${pad(r.name.trim(), w.name)}  ${pad(r.status, w.status)}  ${pad(String(r.defects), 3)}  ` +
        `${pad(r.origin ?? '—', w.origin)}  ${pad(r.truth, w.truth)}  ${r.filed ? 'yes' : 'no'}`,
    );
  }
  lines.push('');
  lines.push(
    `cases ${score.cases} · filed ${score.filedDefects} · true positives ${score.truePositives}` +
      ` · missed ${score.missedDefects} · precision ${pct(score.precision)} · recall ${pct(score.recall)}`,
  );
  lines.push(
    `by truth: ${Object.entries(score.byTruth)
      .filter(([, n]) => n > 0)
      .map(([t, n]) => `${t} ${n}`)
      .join(', ')}`,
  );
  lines.push(
    `by status: ${Object.entries(score.byStatus)
      .map(([s, n]) => `${s} ${n}`)
      .join(', ')}`,
  );
  lines.push('diagnosis origin × truth:');
  for (const [origin, cells] of Object.entries(score.confusion)) {
    const parts = Object.entries(cells).map(([truth, n]) => `${truth} ${n}`);
    lines.push(`  ${origin}: ${parts.join(', ')}`);
  }
  lines.push(`cost per case: ${costLine(score.costPerCase, (n) => n.toFixed(1), (n) => n.toFixed(3))}`);
  return lines.join('\n');
}

export function renderDelta(baselineFile: string, baseline: Parameters<typeof diffScores>[0], current: BenchScore): string {
  const d = diffScores(baseline, current);
  const precision =
    d.precision === null ? `precision ${pct(current.precision)} (baseline ${pct(baseline.precision)})` : `precision ${signed(d.precision * 100)} pts`;
  const recall = d.recall === null ? `recall ${pct(current.recall)} (baseline ${pct(baseline.recall)})` : `recall ${signed(d.recall * 100)} pts`;
  return [
    `delta vs ${baselineFile}:`,
    `  cases ${signed(d.cases, 0)} · filed ${signed(d.filedDefects, 0)} · true positives ${signed(d.truePositives, 0)} · ${precision} · ${recall}`,
    `  cost per case: ${costLine(d.costPerCase, (n) => signed(n), (n) => signed(n, 3))}`,
    '  a change is judged on precision × cost: cheaper and less precise is not better.',
  ].join('\n');
}

// --- main --------------------------------------------------------------------

export async function main(argv: string[], env: NodeJS.ProcessEnv, out: { log: (s: string) => void; error: (s: string) => void }): Promise<number> {
  if (env[BENCH_GATE] !== '1') {
    out.error(
      `bench: refusing to run — set ${BENCH_GATE}=1 to score the labelled proof bundles. ` +
        'It should not run unasked: it writes under reports/ and a score nobody asked for is a number nobody reads.',
    );
    return EXIT.environment;
  }

  let values: { labels?: string | undefined; baseline?: string | undefined; out?: string | undefined; json?: boolean | undefined };
  try {
    values = parseArgs({
      args: argv,
      options: {
        labels: { type: 'string' },
        baseline: { type: 'string' },
        out: { type: 'string' },
        json: { type: 'boolean' },
      },
      strict: true,
    }).values;
  } catch (error) {
    out.error(`bench: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.usage;
  }

  const labelsFile = resolve(values.labels ?? DEFAULT_LABELS);
  const outDir = resolve(values.out ?? DEFAULT_OUT);

  let loaded: Awaited<ReturnType<typeof loadLabelled>>;
  try {
    loaded = await loadLabelled(labelsFile);
  } catch (error) {
    out.error(`bench: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.usage;
  }

  const score = scoreBench(loaded.entries);
  const output: BenchScoreOutput = {
    labelSet: labelSetName(labelsFile),
    labelsFile: relative(ROOT, labelsFile),
    generatedAt: new Date().toISOString(),
    score,
    rows: loaded.rows,
  };

  await mkdir(outDir, { recursive: true });
  const scoreFile = join(outDir, `${output.labelSet}-score.json`);
  await writeFile(scoreFile, JSON.stringify(output, null, 2) + '\n');

  if (values.json === true) {
    out.log(JSON.stringify(output));
  } else {
    out.log(renderTable(loaded.rows, score));
    out.log('');
  }

  if (values.baseline !== undefined) {
    let baseline;
    try {
      baseline = await readBenchScoreFile(resolve(values.baseline));
    } catch (error) {
      out.error(`bench: ${error instanceof Error ? error.message : String(error)}`);
      return EXIT.usage;
    }
    if (values.json !== true) {
      out.log(renderDelta(values.baseline, baseline.score, score));
      out.log('');
    }
  }

  out.error(`bench: wrote ${relative(process.cwd(), scoreFile)}`);
  return EXIT.ok;
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && resolve(process.argv[1]).replace(/\.(ts|js)$/, '') === import.meta.filename.replace(/\.(ts|js)$/, '');

if (invokedDirectly) {
  main(process.argv.slice(2), process.env, {
    log: (s) => process.stdout.write(`${s}\n`),
    error: (s) => process.stderr.write(`${s}\n`),
  }).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`bench: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exit(EXIT.usage);
    },
  );
}
