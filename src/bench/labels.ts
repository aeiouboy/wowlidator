/**
 * What the bench reads from disk, parsed at the read seam (2026-09-05).
 *
 * Two files carry authority here and both go through a zod schema before a
 * number is computed from them:
 *
 * - the LABEL SET — a person's ruling on what each frozen proof bundle really
 *   was (`truth`). A typo'd truth would silently shift precision, so the
 *   vocabulary is closed and an unknown word rejects the whole file;
 * - a BASELINE SCORE FILE — an earlier `npm run bench` output that a change
 *   is judged against. The numbers the delta subtracts must be numbers.
 *
 * The bundles themselves go through the existing proof-bundle seam
 * (`parseProofBundle` in `src/artifacts/schemas.ts`); this module does not
 * re-describe them. Same rule as every other reader: an invalid file is a
 * thrown error naming the file and the first issue path, never a partial read.
 */

import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { firstIssue, parseArtifact, type ArtifactParse } from '../artifacts/schemas.js';

/**
 * The closed vocabulary a labeller rules with. Every value is a fact about
 * the CASE, judged by a person after the run, never by the harness:
 *
 * - `pass` — the application met the claim and the run said so.
 * - `real-defect` — the application contradicted the claim; a bug report
 *   would be accepted.
 * - `spec-question` — the page renders the fact under other words or
 *   design; BA triage, not a bug.
 * - `not-deployed` — the feature the case exercises is not on this
 *   environment yet.
 * - `test-data` — the case needed seeded data that was not there.
 * - `harness` — wowlidator itself broke or gave up: an agent turn budget, a
 *   request that dropped the deployment base path, a model that could not be
 *   asked. Nothing was learned about the application.
 */
export const BENCH_TRUTHS = [
  'pass',
  'real-defect',
  'spec-question',
  'not-deployed',
  'test-data',
  'harness',
] as const;
export type BenchTruth = (typeof BENCH_TRUTHS)[number];

export const BenchLabelSchema = z.looseObject({
  /** Relative to the label file's own directory. */
  bundle: z.string().min(1),
  truth: z.enum(BENCH_TRUTHS),
  note: z.string().optional(),
});

export const BenchLabelsSchema = z.array(BenchLabelSchema).min(1);

export interface BenchLabel {
  bundle: string;
  truth: BenchTruth;
  note?: string | undefined;
}

export function parseBenchLabels(value: unknown): ArtifactParse<BenchLabel[]> {
  return parseArtifact<BenchLabel[]>(BenchLabelsSchema, value);
}

/** Read a label set, or throw an error that names the file and the first issue. */
export async function readBenchLabels(file: string): Promise<BenchLabel[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`bench labels ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = parseBenchLabels(raw);
  if (!parsed.ok) throw new Error(`bench labels ${file}: ${parsed.issue}`);
  return parsed.value;
}

// --- the score file `npm run bench` writes and `--baseline` reads back -------

const CostSchema = z.looseObject({
  modelTurns: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cachedInputTokens: z.number(),
  pageCalls: z.number(),
  durationMs: z.number(),
  sessionCalls: z.number(),
  sessionCostUsd: z.number(),
});

/**
 * Enough of a baseline to subtract from: the headline numbers must be
 * numbers (precision may be null when nothing was filed). Descriptive fields
 * an older or newer bench wrote pass through untouched.
 */
export const BenchScoreFileSchema = z.looseObject({
  labelSet: z.string(),
  generatedAt: z.string(),
  score: z.looseObject({
    cases: z.number(),
    filedDefects: z.number(),
    truePositives: z.number(),
    precision: z.number().nullable(),
    recall: z.number().nullable(),
    costPerCase: CostSchema,
  }),
});

export type BenchScoreFile = z.infer<typeof BenchScoreFileSchema>;

export function parseBenchScoreFile(value: unknown): ArtifactParse<BenchScoreFile> {
  const result = BenchScoreFileSchema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, issue: firstIssue(result.error) };
}

/** Read a baseline score file, or throw an error that names the file and the first issue. */
export async function readBenchScoreFile(file: string): Promise<BenchScoreFile> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`bench baseline ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = parseBenchScoreFile(raw);
  if (!parsed.ok) throw new Error(`bench baseline ${file}: ${parsed.issue}`);
  return parsed.value;
}
