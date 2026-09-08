/**
 * Builders for the model-backed collaborators a run needs — healer, agent,
 * data model — plus the live-progress loggers. Split out of cli.ts verbatim.
 */

import type { ExtractedDocument } from '../catalog/extract.js';
import { resolve } from 'node:path';
import { connectDb, defaultDbConfig, type DbClient } from '../db/client.js';
import { LlmFlowAuthorModel, type FlowAuthorModel, type FlowAuthorOptions } from '../generator/flow-author.js';
import { createModelForRole } from '../providers/llm-factory.js';
import { LlmValueResolverModel } from '../generator/value-resolution.js';
import { FlowReviewer, LlmFlowReviewModel } from '../generator/flow-review.js';
import { LlmRiskModel, riskEnabled, type RiskModel } from '../generator/dead-end-risk.js';
import { LlmDiagnosisModel, diagnosisEnabled, type DiagnosisModel } from '../generator/error-diagnosis.js';
import type { CacheManager } from '../cache/cache-manager.js';
import { describeRouting } from '../config.js';
import { LlmDataModel } from '../data/data-model.js';
import { formatAgentAction, formatStepLine, type ProofStep } from '../engine/proof-bundle.js';
import type { RunPlan } from '../engine/runner.js';
import { CAPTURE_PILOT_MAX_STEPS } from '../context/capture-pilot.js';
import type { FetchJson, MasterDataLookup } from '../context/master-data.js';
import { currentLogTag } from '../log-format.js';
import { LlmFlowRepairModel, type FlowRepairModel } from '../repair/flow-repair-model.js';
import { LlmReviewJudge, type ReviewJudge } from '../engine/review-judge.js';
import type { HealHintsProvider } from '../context/heal-hints.js';
import { JitHealer, LlmHealerModel } from '../healer/jit-healer.js';
import { LlmAgentModel, WorkflowAgent } from '../orchestrator/workflow-agent.js';
import type { CliOptions } from './options.js';

export function buildHealer(options: CliOptions, hints?: HealHintsProvider | undefined) {
  return options.heal
    ? (cache: CacheManager) =>
      new JitHealer({
        model: new LlmHealerModel({
          factory: options.factory,
          ...(hints === undefined ? {} : { hints }),
        }),
        cache,
      })
    : undefined;
}

/**
 * Write one case's output so a reader — and the panel — can tell whose it is.
 *
 * Cases run concurrently now, so their lines interleave in one stdout. A tag
 * is the whole demultiplexer: `[c3]` in front of every line of case 3, applied
 * per line rather than per write so a multi-line summary cannot arrive half
 * attributed. **Without a tag nothing changes at all** — a sequential run's
 * output stays byte-for-byte what it was, which is what keeps the CLI's own
 * stdout tests, and anyone's scripts, working.
 *
 * One `write` per call, never one per line: two processes' worth of interleaved
 * lines is the problem being solved, and solving it with N syscalls that can
 * themselves interleave would be a poor joke.
 */
export function emitTagged(tag: string | undefined, text: string, stream: 'out' | 'err' = 'out'): void {
  const target = stream === 'out' ? process.stdout : process.stderr;
  // An explicit tag wins; otherwise the async context's own (`withLogTag`),
  // which is how a shared collaborator's narration — the author's lints, the
  // reviewer, the value resolver — lands under the row or case it serves.
  const effective = tag ?? currentLogTag();
  if (effective === undefined) {
    target.write(text);
    return;
  }
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  target.write(body.split('\n').map((line) => `${effective} ${line}`).join('\n') + '\n');
}

/** Live per-step console output; suppressed under --json, whose stdout must stay one document. */
export function stepLogger(
  options: CliOptions,
  tag?: string | undefined,
): ((step: ProofStep) => void) | undefined {
  return options.json ? undefined : (step) => emitTagged(tag, formatStepLine(step) + '\n');
}

/**
 * How many steps this run intends to take, printed once before the first one.
 *
 * The step lines that follow carry `[0]`, `[1]`, … and a numerator on its own
 * is not progress — anything reading this output can count what has finished
 * but not what remains. One line up front is the denominator, and the panel's
 * progress bar and time estimate are both built on it. Suppressed under
 * `--json` for the same reason every other progress line is: that stdout has to
 * stay one parseable document.
 */
export function planLogger(
  options: CliOptions,
  tag?: string | undefined,
): ((plan: RunPlan) => void) | undefined {
  return options.json
    ? undefined
    : (plan) => emitTagged(tag, `  plan       ${plan.total} step(s)\n`);
}

/** Live progress lines for generation/authoring/repair; suppressed under --json. */
export function lineLogger(
  options: CliOptions,
  tag?: string | undefined,
): ((line: string) => void) | undefined {
  return options.json ? undefined : (line) => emitTagged(tag, line + '\n');
}

export function buildAgent(options: CliOptions, tag?: string | undefined): WorkflowAgent | null {
  if (!options.agent) return null;
  return new WorkflowAgent({
    model: new LlmAgentModel({ factory: options.factory }),
    earlyStop: options.agentEarlyStop,
    // Per-turn live progress — a `workflow` step can run for several seconds
    // across multiple model calls, and this is the only visibility into it
    // before the step as a whole finishes. Suppressed under --json: the
    // response there is a single machine-parseable document on stdout.
    onAction: options.json
      ? undefined
      : async (_page, action) => {
        emitTagged(tag, formatAgentAction(action) + '\n');
      },
  });
}

/**
 * The agent that reinvestigates a failed step for `--repair-investigate`.
 * Separate from `buildAgent` on purpose: that one answers "may `workflow`
 * steps run?" (`--no-agent`), this one answers "may the repair loop act on
 * the page?" — conflating them would let one opt-in silently grant the other.
 */
export function buildInvestigationAgent(options: CliOptions): WorkflowAgent {
  return new WorkflowAgent({
    model: new LlmAgentModel({ factory: options.factory }),
    onAction: options.json
      ? undefined
      : async (_page, action) => {
        emitTagged(undefined, formatAgentAction(action) + '\n');
      },
  });
}

/**
 * The repair model for in-run step reconstruction, or null. Same lazy-key
 * degradation as the capture pilot: without a generator key, runs behave
 * exactly as they did before reconstruction existed.
 */
/**
 * The pre-run dead-end risk judge (`generator/dead-end-risk.ts`): on unless
 * `WOWLIDATOR_RISK=off`, and only when the generator role resolves — it is the
 * model that read the same evidence the case was written from.
 */
export function buildRiskModel(options: CliOptions): RiskModel | null {
  if (!riskEnabled()) return null;
  if (!options.factory.canResolve('generator')) return null;
  return new LlmRiskModel({ factory: options.factory });
}

/**
 * The post-run system-error judge (`generator/error-diagnosis.ts`): on unless
 * `WOWLIDATOR_DIAGNOSE=off`, through the healer role — the small, fast
 * diagnostic model. Only ever called on a run whose status is `error`.
 */
export function buildDiagnosisModel(options: CliOptions): DiagnosisModel | null {
  if (!diagnosisEnabled()) return null;
  if (!options.factory.canResolve('healer')) return null;
  return new LlmDiagnosisModel({ factory: options.factory });
}

export function buildStepRepair(options: CliOptions): FlowRepairModel | null {
  if (!options.reconstruct) return null;
  if (!options.factory.canResolve('generator')) return null;
  return new LlmFlowRepairModel({ factory: options.factory });
}

/**
 * The auto-review judge: one small `agent`-role call when a run lands on
 * proved-?, ruling it proved at 70%+ confidence (asked for by the person
 * running this — routine wording near-misses stop queuing for a human).
 * `WOWLIDATOR_AUTO_PROVE=off` disables; no agent key degrades silently to the
 * human-only queue, the capture-pilot rule.
 */
export function buildReviewJudge(options: CliOptions): ReviewJudge | null {
  if (process.env['WOWLIDATOR_AUTO_PROVE'] === 'off') return null;
  if (!options.factory.canResolve('agent')) return null;
  return new LlmReviewJudge({ factory: options.factory });
}

/**
 * The agent that steadies a page before its capture (`--no-agent-capture`
 * turns it off). Null when the `agent` role has no key — a capture without a
 * pilot is the capture we always took, so a missing key degrades to that
 * rather than blocking generation. Separate from `buildAgent` for the same
 * reason `buildInvestigationAgent` is: different act, different switch.
 */
export function buildCapturePilot(options: CliOptions): WorkflowAgent | null {
  if (!options.agentCapture) return null;
  if (!options.factory.canResolve('agent')) return null;
  return new WorkflowAgent({
    model: new LlmAgentModel({ factory: options.factory }),
    maxSteps: CAPTURE_PILOT_MAX_STEPS,
    onAction: options.json
      ? undefined
      : async (_page, action) => {
        emitTagged(undefined, formatAgentAction(action) + '\n');
      },
  });
}

// Lazy like every other role: a flow with no `fillRetry(kind: 'custom')` step
// never resolves the `data` role or demands its key. No `--no-data` flag —
// the deterministic kinds cost nothing to leave enabled, and `custom` is
// opt-in per step by construction.
/**
 * The authoring review (`src/generator/flow-review.ts`), on the agent role.
 * Default on; `--no-author-review` disables; no agent key degrades silently
 * to the unreviewed flow — the flow we always wrote.
 */
export function buildFlowReviewer(options: CliOptions): FlowReviewer | null {
  if (!options.authorReview) return null;
  if (!options.factory.canResolve('agent')) return null;
  return new FlowReviewer({
    model: new LlmFlowReviewModel({ factory: options.factory }),
    onLog: lineLogger(options),
  });
}

/**
 * The author's retry model (`FlowAuthorOptions.retryModel`): the generator
 * role's provider with `WOWLIDATOR_GENERATOR_RETRY_MODEL` as the model id, so a
 * run can put the expensive model on the first ask and a faster one on the
 * re-asks. Unset means one model throughout. Fails the way the generator
 * role fails — a missing key surfaces at the first retry, not at startup.
 */
export function buildAuthorRetryModel(options: CliOptions): FlowAuthorModel | null {
  const modelId = (process.env['WOWLIDATOR_GENERATOR_RETRY_MODEL'] ?? '').trim();
  if (modelId === '') return null;
  const config = options.factory.config;
  const generator = config.roles.generator;
  if (modelId === generator.modelId) return null;
  const patched = {
    ...config,
    roles: { ...config.roles, generator: { ...generator, modelId } },
  };
  let resolved: ReturnType<typeof createModelForRole> | null = null;
  const lazy: FlowAuthorModel = {
    id: `${generator.provider}:${modelId}`,
    author: (request) => {
      resolved ??= createModelForRole('generator', patched, options.factory.activeKeyIndex(generator.provider));
      return new LlmFlowAuthorModel({ model: resolved.model, id: resolved.id }).author(request);
    },
  };
  return lazy;
}

/**
 * Value resolution at authoring time (`src/generator/value-resolution.ts`):
 * the agent role answers the retrieval and database questions and the
 * generator role invents the flagged stand-in; the database is opened lazily,
 * read-only, and only when `WOWLIDATOR_DB_URL` is set. Default on;
 * `--no-value-resolution` / `WOWLIDATOR_VALUE_RESOLUTION=off` returns
 * undefined, which the author reads as "refuse a token as before". With no
 * agent key the model is null: test data and the deterministic stand-in still
 * work, and the flag still lands on the step.
 */
export function buildValueResolution(
  options: CliOptions,
  documents?: readonly ExtractedDocument[] | undefined,
): FlowAuthorOptions['valueResolution'] {
  if (!options.valueResolution) return undefined;
  const model = options.factory.canResolve('agent') ? new LlmValueResolverModel({ factory: options.factory, role: 'agent' }) : null;
  let client: Promise<DbClient | null> | null = null;
  const db = (): Promise<DbClient | null> => {
    if (client === null) {
      const config = defaultDbConfig();
      client = config === null ? Promise.resolve(null) : connectDb(config).catch(() => null);
    }
    return client;
  };
  return { model, db, ...(documents === undefined ? {} : { documents }) };
}

export async function buildMasterData(options: CliOptions): Promise<FlowAuthorOptions['masterData']> {
  if (options.masterData === undefined) return undefined;
  let lookups: MasterDataLookup[];
  try {
    const { readMasterDataDeclaration } = await import('../context/master-data.js');
    lookups = await readMasterDataDeclaration(resolve(options.masterData));
  } catch (error) {
    emitTagged(undefined, `master-data declaration refused: ${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}\n`, 'err');
    return undefined;
  }

  let transport: Promise<FetchJson | null> | null = null;
  const fetch = (): Promise<FetchJson | null> => {
    if (transport !== null) return transport;
    transport = (async () => {
      if (options.url === undefined) return null;
      const { prepare } = await import('./artifacts.js');
      const { DEFAULT_CDP_URL } = await import('../engine/runner.js');
      const { SIGN_IN_URL_PATTERN, performSignIn } = await import('../engine/sign-in.js');
      const { acceptConsentGate } = await import('../engine/consent-gate.js');
      const { BrowserTransport } = await import('../api/api-client.js');
      const { fetchJsonThrough } = await import('../context/master-data.js');
      const { chromium } = await import('playwright');
      const blocked = await prepare(options, options.url);
      if (blocked !== null) return null;
      const browser = await chromium.connectOverCDP(options.cdp ?? DEFAULT_CDP_URL);
      const context = await browser.newContext();
      const tab = await context.newPage();
      await tab.goto(options.url, { waitUntil: 'domcontentloaded' });
      await tab.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      const credentials = options.credentials ?? Object.values(options.personas)[0];
      if (credentials !== undefined && SIGN_IN_URL_PATTERN.test(tab.url())) {
        const outcome = await performSignIn(tab, credentials);
        if (!outcome.ok) return null;
      }
      await acceptConsentGate(tab).catch(() => false);
      return fetchJsonThrough(new BrowserTransport(context));
    })().catch((error) => {
      emitTagged(undefined, `master-data transport unavailable: ${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}\n`, 'err');
      return null;
    });
    return transport;
  };
  return { lookups, fetch, ...(options.url === undefined ? {} : { appUrl: options.url }) };
}

/**
 * The persona map a RUN signs in from (`RunFlowOptions.personas`, CG-05): every
 * `--persona` / `WOWLIDATOR_PERSONAS` entry, plus the unlabelled `--as` account
 * under `DEFAULT`, plus whatever labels the catalog resolved for THIS case
 * (`extra` — a row whose single `<HR_ADMIN_ACCOUNT>` fell back to `--as` still
 * needs `signIn as: HR_ADMIN_ACCOUNT` to find it at run time). In memory only:
 * a flow file carries labels, the ledger carries emails, and this record is
 * never written anywhere. Undefined when there is nothing to sign in as, so a
 * run without credentials is byte-for-byte what it was.
 */
export function runPersonas(
  options: CliOptions,
  extra?: Readonly<Record<string, { email: string; password: string }>> | undefined,
): Record<string, { email: string; password: string }> | undefined {
  const map: Record<string, { email: string; password: string }> = {
    ...options.personas,
    ...(options.credentials === undefined ? {} : { DEFAULT: options.credentials }),
    ...(extra ?? {}),
  };
  return Object.keys(map).length === 0 ? undefined : map;
}

export function buildDataModel(options: CliOptions): LlmDataModel {
  return new LlmDataModel({ factory: options.factory });
}

/**
 * Fail before touching a browser when a role that this run needs has no key.
 * A missing key surfaced 30 seconds into a flow is far worse than one surfaced
 * on the first line of output.
 */
export function assertRolesResolvable(options: CliOptions, roles: readonly ('healer' | 'generator' | 'agent')[]): string | null {
  for (const role of roles) {
    if (!options.factory.canResolve(role)) {
      return (
        `the "${role}" role has no API key configured.\n\n` +
        `${describeRouting(options.config)}\n\n` +
        'Run `wowlidator doctor` for setup instructions, or disable the role ' +
        '(--no-heal / --no-agent).'
      );
    }
  }
  return null;
}
