/**
 * Persisted artifacts, parsed at the trust boundary (Phase C, 2026-09-05 —
 * docs/research/commerce-agents-patterns.md, "parse persisted artifacts at
 * the trust boundary").
 *
 * A proof bundle, a suite ledger, a context graph, a database baseline, the
 * healed-selector cache and the run history are all files written by an
 * earlier process — possibly another version of this program, possibly a
 * hand edit — and each of them can change a verdict or trigger an action
 * when read back. They used to be read with `JSON.parse(...) as T` and a
 * shallow shape check; a step whose `status` was "banana" flowed through a
 * verdict roll-up untouched. Each schema here rejects the SHAPES that carry
 * authority (a status, a verdict, a hold's reason, a selector to replay, a
 * table to restore) and lets the many optional, descriptive fields through
 * (`looseObject`), so an artifact written by an older build that lacks a
 * field it did not know about still reads.
 *
 * One rule for every reader: an invalid artifact is a typed unavailable
 * result — `null`, an empty set, a thrown error naming the file — and never
 * a partially executed one. The readers keep their existing signatures.
 */

import { z } from 'zod';

import type { ProofBundle } from '../engine/proof-bundle.js';

// --- vocabularies (mirrored from the engine's own unions) ---------------------

export const RUN_STATUSES = ['passed', 'passed-with-issues', 'needs-review', 'failed', 'error', 'dead-end'] as const;
export const STEP_STATUSES = ['passed', 'failed', 'error', 'dead-end'] as const;
export const BLOCKED_REASONS = ['capability', 'provenance', 'approval', 'guardrail'] as const;
export const CASE_VERDICTS = ['passed', 'failed', 'blocked', 'review'] as const;

const RunStatusSchema = z.enum(RUN_STATUSES);

// --- proof bundle ------------------------------------------------------------

const BlockedOutcomeSchema = z.looseObject({
  kind: z.literal('blocked'),
  reason: z.enum(BLOCKED_REASONS),
  rule: z.string(),
  message: z.string(),
});

const ProofStepSchema = z.looseObject({
  index: z.number().int().nonnegative(),
  action: z.string(),
  status: z.enum(STEP_STATUSES),
  blocked: BlockedOutcomeSchema.optional(),
});

/**
 * Enough of a bundle to be trusted with a verdict: identity, a status from
 * the known set, a summary with its three counts, and steps whose status —
 * and hold, when there is one — come from the known vocabularies.
 */
export const ProofBundleSchema = z.looseObject({
  runId: z.string().min(1),
  name: z.string(),
  status: RunStatusSchema,
  summary: z.looseObject({
    totalSteps: z.number(),
    passed: z.number(),
    failed: z.number(),
  }),
  steps: z.array(ProofStepSchema),
  defects: z.array(z.looseObject({})).optional(),
});

// --- suite ledger ------------------------------------------------------------

export const LedgerOutcomeSchema = z.looseObject({
  verdict: z.enum(CASE_VERDICTS),
  status: z.string().nullable(),
  reason: z.string().nullable(),
  reportPath: z.string().nullable(),
  at: z.string(),
});

export const SuiteLedgerSchema = z.looseObject({
  version: z.number(),
  title: z.string(),
  planned: z.array(z.string()),
  startedAt: z.string(),
  updatedAt: z.string(),
  generatedAt: z.string().nullable(),
  runKey: z.string().nullable().optional(),
  outcomes: z.record(z.string(), LedgerOutcomeSchema),
});

// --- context graph -----------------------------------------------------------

export const PROJECT_NODE_KINDS = ['package', 'component', 'route', 'test', 'operation', 'table', 'message'] as const;
export const PROJECT_EDGE_KINDS = ['uses', 'renders', 'covers', 'references'] as const;

export const ProjectGraphSchema = z.looseObject({
  version: z.number(),
  rootDir: z.string(),
  generatedAt: z.string(),
  signature: z.string(),
  nodes: z.array(
    z.looseObject({
      id: z.string(),
      kind: z.enum(PROJECT_NODE_KINDS),
      name: z.string(),
      file: z.string(),
    }),
  ),
  edges: z.array(z.looseObject({ from: z.string(), to: z.string(), kind: z.enum(PROJECT_EDGE_KINDS) })),
  sources: z.array(z.looseObject({ id: z.string() })),
});

// --- database baseline -------------------------------------------------------

export const BaselineSchema = z.looseObject({
  version: z.literal(1),
  takenAt: z.string(),
  runKey: z.string().nullable(),
  tables: z.array(
    z.looseObject({
      table: z.string().min(1),
      columns: z.array(z.string()),
      pk: z.array(z.string()),
      rowCount: z.number(),
      hash: z.string(),
      restorable: z.boolean(),
      rows: z.array(z.record(z.string(), z.unknown())),
    }),
  ),
});

// --- healed-selector cache ---------------------------------------------------

/** One entry: what is replayed against a live page, so every field the replay reads is required. */
export const HealedSelectorEntrySchema = z.looseObject({
  original: z.string(),
  healed: z.string().min(1),
  strategy: z.string(),
  url: z.string(),
  confidence: z.number(),
  hits: z.number(),
});

/** The file: an object with an `entries` record. Entries are judged one by one by the reader. */
export const HealedSelectorCacheFileSchema = z.looseObject({
  entries: z.record(z.string(), z.unknown()).optional(),
});

// --- run history -------------------------------------------------------------

export const HistoryEntrySchema = z.looseObject({
  runId: z.string().min(1),
  name: z.string(),
  status: RunStatusSchema,
  finishedAt: z.string(),
  durationMs: z.number(),
  passed: z.number(),
  failed: z.number(),
  jitHeals: z.number().default(0),
  defects: z.number().default(0),
  failedSteps: z.array(z.string()).default([]),
});

// --- the one way to ask ------------------------------------------------------

export type ArtifactParse<T> = { ok: true; value: T } | { ok: false; issue: string };

/** The first issue, as `path: message` — enough for a stderr line naming what was wrong. */
export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'invalid';
  const path = issue.path.map((p) => (typeof p === 'symbol' ? p.description ?? '' : String(p))).join('.');
  return `${path === '' ? '(root)' : path}: ${issue.message}`;
}

/**
 * Validate `value` against `schema` and hand back the ORIGINAL value, typed —
 * the schemas are loose so nothing is stripped, and the callers' types carry
 * fields the schemas deliberately do not enumerate.
 */
export function parseArtifact<T>(schema: z.ZodType, value: unknown): ArtifactParse<T> {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: value as T };
  return { ok: false, issue: firstIssue(result.error) };
}

/** `looksLikeBundle`'s successor: a bundle the panel and the suite may score. */
export function parseProofBundle(value: unknown): ArtifactParse<ProofBundle> {
  return parseArtifact<ProofBundle>(ProofBundleSchema, value);
}
