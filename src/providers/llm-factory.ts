/**
 * Provider abstraction over the Vercel AI SDK.
 *
 * Everything model-shaped in wowlidator goes through `LanguageModel`, so the engine
 * never imports a vendor SDK and swapping providers is a config change rather
 * than a code change. Adding a fourth provider means one entry in `FACTORIES`
 * and one string in `PROVIDERS` — no call site moves.
 *
 * Roles are resolved lazily: a run that never heals and has no `workflow`
 * steps never constructs a model, and therefore never demands an API key.
 */

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import {
  APICallError,
  NoObjectGeneratedError,
  generateObject,
  type LanguageModel,
} from 'ai';
import { z } from 'zod';

import {
  PROVIDER_META,
  PROVIDERS,
  SERIAL_PROVIDERS,
  loadConfig,
  localLlmBaseUrl,
  type LlmRole,
  type ProviderName,
  type RoleConfig,
  type WowlidatorConfig,
} from '../config.js';
import { localFetch } from './local-fetch.js';
import { createAgyCli } from './agy-cli.js';
import { createClaudeCli } from './claude-cli.js';
import { createCodexCli } from './codex-cli.js';
import { createClaudeCloud, createClaudeTty } from './claude-tty.js';
import { maybeLogClaudeQuota } from './claude-quota.js';
import { dedupeKeyFor, serialGateFor } from './serial-gate.js';
import { logLlmFailure, logLlmRequest, logLlmResponse } from './llm-log.js';
import {
  PACED_PROVIDERS,
  PACER_MAX_WAIT_MS,
  estimateTokens,
  isRateLimitError,
  pacerFor,
  type RatePacer,
} from './rate-pacer.js';

export class MissingApiKeyError extends Error {
  readonly provider: ProviderName;
  readonly role: LlmRole;

  constructor(role: LlmRole, provider: ProviderName) {
    const meta = PROVIDER_META[provider];
    super(
      `wowlidator needs a ${meta.label} key to run the "${role}" role.\n` +
        `  export ${meta.envKey}=...   (${meta.consoleUrl})\n` +
        `  ${meta.freeTier}\n` +
        `  Add more than one as a comma-separated list (${meta.envKey}=key1,key2) ` +
        `and wowlidator fails over to the next automatically when one is exhausted.\n` +
        `Or point the role elsewhere: WOWLIDATOR_${role.toUpperCase()}_PROVIDER=<${PROVIDERS.join('|')}>`,
    );
    this.name = 'MissingApiKeyError';
    this.provider = provider;
    this.role = role;
  }
}

/**
 * Every key for `provider` failed. Distinct from `MissingApiKeyError` — that
 * one means "nothing configured"; this one means "configured, and none of it
 * works right now". Carries every attempt so the actual cause of each failure
 * (not just the last one) is visible rather than discarded.
 */
export class AllKeysExhaustedError extends Error {
  readonly role: LlmRole;
  readonly provider: ProviderName;
  readonly attempts: ReadonlyArray<{ keyIndex: number; error: unknown }>;

  constructor(
    role: LlmRole,
    provider: ProviderName,
    attempts: ReadonlyArray<{ keyIndex: number; error: unknown }>,
  ) {
    const meta = PROVIDER_META[provider];
    super(
      `all ${attempts.length} ${meta.label} key(s) failed for the "${role}" role:\n` +
        attempts.map((a) => `  key ${a.keyIndex + 1}: ${summarize(a.error)}`).join('\n') +
        `\nAdd another key, or fix ${meta.envKey}.`,
      { cause: attempts[attempts.length - 1]?.error },
    );
    this.name = 'AllKeysExhaustedError';
    this.role = role;
    this.provider = provider;
    this.attempts = attempts;
  }
}

function summarize(error: unknown): string {
  return error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error);
}

const KEY_FAILURE_PATTERN =
  /\bquota\b|rate.?limit|too many requests|\b(401|403|429)\b|invalid[_ ]api[_ ]key|unauthorized|permission denied|forbidden|resource_exhausted/i;

/**
 * Whether a failure looks like the KEY is the problem — expired, revoked,
 * rate-limited, or out of quota — as opposed to the request or the model's
 * own capability (a malformed prompt, a model that cannot emit
 * schema-constrained JSON). Only the former is worth rotating for: rotating
 * on the latter would just spend another key's quota on a call that was never
 * going to succeed, and would mask which model actually failed.
 *
 * `generateStructured` wraps whatever it catches in a new `Error` with the
 * original as `cause`, so both the direct SDK error and the wrapped one are
 * checked — this runs on both the raw `doctor` probe and every
 * `generateStructuredForModel` call.
 */
export function isKeyExhaustedError(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  const apiError = APICallError.isInstance(error)
    ? error
    : APICallError.isInstance(cause)
      ? cause
      : undefined;
  if (apiError?.statusCode === 401 || apiError?.statusCode === 403 || apiError?.statusCode === 429) {
    return true;
  }
  return KEY_FAILURE_PATTERN.test(error instanceof Error ? error.message : String(error));
}

/** How a (key, model id) becomes a `LanguageModel`. Exported as a test seam only. */
export type ModelBuilder = (
  apiKey: string,
  modelId: string,
  options?: {
    baseUrl?: string | undefined;
    /**
     * Reasoning effort, for a provider that has the concept. Per role, so a
     * run can spend it where authoring happens and keep the roles called
     * every few seconds cheap and quick.
     */
    effort?: string | undefined;
    /** Tools to make available to the provider session (e.g. for `claude-cli`). */
    tools?: string | readonly string[] | undefined;
    /** Allowed tools for the provider session. */
    allowedTools?: string | readonly string[] | undefined;
    /** Disallowed tools for the provider session. */
    disallowedTools?: string | readonly string[] | undefined;
    /**
     * Whether the session may search the run's registered corpus (repo
     * context graph + context documents) over the loopback BM25 MCP tool —
     * `claude-cli` only; other providers ignore it. See `claude-retrieval.ts`.
     */
    retrieval?: boolean | undefined;
    /** The role this model serves — spend attribution for session-billed providers. */
    role?: string | undefined;
  },
) => LanguageModel;

/**
 * One entry per provider. Each returns a `LanguageModel` — the AI SDK's
 * common denominator — so nothing downstream knows which vendor answered.
 */
const FACTORIES: Record<ProviderName, ModelBuilder> = {
  'agy-cli': (_apiKey, modelId, options) =>
    createAgyCli({
      modelId,
      ...(options?.effort === undefined ? {} : { effort: options.effort }),
    }),
  'codex-cli': (_apiKey, modelId, options) =>
    createCodexCli({
      modelId,
      ...(options?.effort === undefined ? {} : { effort: options.effort }),
    }),
  // No key: the CLI carries the operator's own session. See `claude-cli.ts`
  // for why the system prompt is replaced and the process runs from a
  // neutral directory.
  'claude-cli': (_apiKey, modelId, options) =>
    createClaudeCli({
      modelId,
      ...(options?.effort === undefined ? {} : { effort: options.effort }),
      ...(options?.tools === undefined ? {} : { tools: options.tools }),
      ...(options?.allowedTools === undefined ? {} : { allowedTools: options.allowedTools }),
      ...(options?.disallowedTools === undefined ? {} : { disallowedTools: options.disallowedTools }),
      ...(options?.retrieval === undefined ? {} : { retrieval: options.retrieval }),
      ...(options?.role === undefined ? {} : { role: options.role }),
    }),
  // Same session, one warm interactive process per (model, effort) — pooled
  // in module state, because this builder runs on EVERY failover call.
  'claude-tty': (_apiKey, modelId, options) =>
    createClaudeTty({ modelId, ...(options?.effort === undefined ? {} : { effort: options.effort }) }),
  // The same account with the work in a Claude Code cloud session — the warm
  // terminal again, launched with `--cloud`. Pooled in module state for the
  // same reason as `claude-tty`.
  'claude-cloud': (_apiKey, modelId, options) =>
    createClaudeCloud({ modelId, ...(options?.effort === undefined ? {} : { effort: options.effort }) }),
  google: (apiKey, modelId) => createGoogleGenerativeAI({ apiKey })(modelId),
  groq: (apiKey, modelId) => createGroq({ apiKey })(modelId),
  openrouter: (apiKey, modelId) => createOpenRouter({ apiKey })(modelId),
  emmiedev: (apiKey, modelId) =>
    createOpenAICompatible({
      name: 'emmiedev',
      baseURL: 'https://chat.emmiedev.com/v1',
      apiKey,
    })(modelId),
  zai: (apiKey, modelId) =>
    createOpenAICompatible({
      name: 'zai',
      baseURL: 'https://api.z.ai/api/paas/v4',
      apiKey,
    })(modelId),
  deepseek: (apiKey, modelId) =>
    createOpenAICompatible({
      name: 'deepseek',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey,
    })(modelId),
  airforce: (apiKey, modelId) =>
    createOpenAICompatible({
      name: 'airforce',
      baseURL: 'https://api.airforce/v1',
      apiKey,
    })(modelId),
  cerebras: (apiKey, modelId) =>
    createOpenAICompatible({
      name: 'cerebras',
      baseURL: 'https://api.cerebras.ai/v1',
      apiKey,
    })(modelId),
  requesty: (apiKey, modelId) =>
    createOpenAICompatible({
      name: 'requesty',
      baseURL: 'https://router.requesty.ai/v1',
      apiKey,
    })(modelId),
  local: (apiKey, modelId, options) =>
    createOpenAICompatible({
      name: 'local',
      // The role's own server (`WOWLIDATOR_<ROLE>_BASE_URL`, the panel's port
      // field) first; the shared `LOCAL_LLM_BASE_URL` otherwise.
      baseURL: options?.baseUrl ?? localLlmBaseUrl(),
      apiKey,
      // The request carries the JSON schema itself (`response_format:
      // json_schema`). mlx_lm.server ignores the field; the `rerise` wrapper
      // around it reads the schema and SHAPES the reply to it before it
      // leaves the server — fences and <think> blocks stripped, the object
      // pulled out of surrounding prose, every required key present with
      // its type's empty value. The schema is still stated in the prompt
      // (`withPromptSchema`): the model is asked for the shape, and the
      // server guarantees what it can of it.
      supportsStructuredOutputs: true,
      // A transport that waits for a minutes-long non-streaming generation —
      // see `local-fetch.ts`. Node's default fetch hangs up at 300 s.
      fetch: localFetch,
    })(modelId),
};

export interface ResolvedModel {
  role: LlmRole;
  provider: ProviderName;
  modelId: string;
  model: LanguageModel;
  /** `provider:modelId`, recorded in proof bundles and reports. Never
   *  includes the key — rotating keys must not change a run's model label. */
  id: string;
  /** Which of the provider's configured keys this model was built from. */
  keyIndex: number;
  /** How many keys are configured for this provider. */
  keyCount: number;
}

export function modelIdFor(entry: RoleConfig): string {
  return `${entry.provider}:${entry.modelId}`;
}

/**
 * Build the model for one role from its `keyIndex`-th configured key
 * (default: the topmost / first-listed one). Throws `MissingApiKeyError` with
 * setup instructions rather than a provider-level auth failure ten seconds
 * later.
 *
 * `builders` is a test-only extension point — `LlmFactory` passes its own
 * injected builders through so key-failover can be exercised with a stub
 * model instead of a real provider SDK. External callers never need it; the
 * real AI SDK factories are the default.
 */
export function createModelForRole(
  role: LlmRole,
  config: WowlidatorConfig,
  keyIndex = 0,
  builders: Record<ProviderName, ModelBuilder> = FACTORIES,
): ResolvedModel {
  const entry = config.roles[role];
  const keys = config.apiKeys[entry.provider] ?? [];
  const apiKey = keys[keyIndex];
  if (apiKey === undefined) throw new MissingApiKeyError(role, entry.provider);

  return {
    role,
    provider: entry.provider,
    modelId: entry.modelId,
    model: builders[entry.provider](apiKey, entry.modelId, {
      baseUrl: entry.baseUrl,
      effort: entry.effort,
      tools: entry.tools,
      allowedTools: entry.allowedTools,
      disallowedTools: entry.disallowedTools,
      // The roles whose questions outgrow their prompt mid-thought: the
      // generator (what does this route render, which table holds this), the
      // healer (does anything declare the control it is looking for), and the
      // agent — which is only ever on the page BECAUSE a step failed as a
      // blocker, exactly when knowing the application's declared routes and
      // tables is worth a lookup. `data` stays off: its one job is inventing
      // a value, and grounding it in the repo would be over-thinking a fill.
      retrieval: role === 'generator' || role === 'healer' || role === 'agent',
      role,
    }),
    id: modelIdFor(entry),
    keyIndex,
    keyCount: keys.length,
  };
}

/**
 * Lazily resolves and caches one model per role, with automatic key failover.
 *
 * Construction is deferred so the CLI can start, parse a flow, and connect to
 * a browser without any provider key present — only a role that actually runs
 * pays the key requirement.
 *
 * A provider can have more than one key configured (comma-separated in its
 * env var). The active key per provider starts at index 0 — the topmost /
 * first-listed one — and only moves forward, via `callWithFailover`, when a
 * call actually fails in a way that looks like the key rather than the
 * request. The move is sticky and shared across every role on that provider,
 * so a repair role and a generation role pointed at the same exhausted
 * Google key do not independently rediscover the same dead key.
 */
export class LlmFactory {
  readonly config: WowlidatorConfig;

  readonly #builders: Record<ProviderName, ModelBuilder>;
  readonly #cache = new Map<LlmRole, ResolvedModel>();
  readonly #keyIndex = new Map<ProviderName, number>();

  /**
   * @param builders Test-only. Overrides how a (provider, apiKey, modelId)
   *   becomes a `LanguageModel` — lets failover be exercised with a stub
   *   instead of a real provider SDK. Defaults to the real AI SDK factories.
   */
  constructor(
    config: WowlidatorConfig = loadConfig(),
    builders: Partial<Record<ProviderName, ModelBuilder>> = {},
  ) {
    this.config = config;
    this.#builders = { ...FACTORIES, ...builders };
  }

  /** The key index currently active for a provider — 0 until a failover moves it. */
  activeKeyIndex(provider: ProviderName): number {
    return this.#keyIndex.get(provider) ?? 0;
  }

  /** Resolve (and memoise) the model for a role, at whichever key is currently active. */
  forRole(role: LlmRole): ResolvedModel {
    const provider = this.config.roles[role].provider;
    const idx = this.activeKeyIndex(provider);
    const cached = this.#cache.get(role);
    // A cached entry from before a rotation is stale — rebuild at the new key.
    if (cached && cached.keyIndex === idx) return cached;
    const resolved = createModelForRole(role, this.config, idx, this.#builders);
    this.#cache.set(role, resolved);
    return resolved;
  }

  /** Whether `forRole` would succeed — used to fail fast with a clear message. */
  canResolve(role: LlmRole): boolean {
    return (this.config.apiKeys[this.config.roles[role].provider]?.length ?? 0) > 0;
  }

  get maxRetries(): number {
    return this.config.maxRetries;
  }

  /**
   * Run `attempt` against the role's model, rotating through its provider's
   * configured keys — topmost first — whenever a call fails in a way that
   * looks like the key (auth, quota, rate limit) rather than the request.
   * See `isKeyExhaustedError` for exactly what triggers a rotation.
   *
   * The first attempt starts at whichever key is already active (0, unless an
   * earlier call already rotated it forward). A key that succeeds becomes the
   * active key going forward — for every role sharing that provider, not just
   * this one — so the framework never re-probes a key it already knows is
   * dead.
   *
   * Throws `MissingApiKeyError` if the role has no key at all, the original
   * error unchanged if only one key was tried, or `AllKeysExhaustedError`
   * once every configured key has failed.
   */
  async callWithFailover<T>(
    role: LlmRole,
    attempt: (resolved: ResolvedModel) => Promise<T>,
  ): Promise<T> {
    const provider = this.config.roles[role].provider;
    const keys = this.config.apiKeys[provider] ?? [];
    if (keys.length === 0) throw new MissingApiKeyError(role, provider);

    const tried: { keyIndex: number; error: unknown }[] = [];
    for (let i = this.activeKeyIndex(provider); i < keys.length; i++) {
      const resolved = createModelForRole(role, this.config, i, this.#builders);
      this.#cache.set(role, resolved);
      try {
        const result = await attempt(resolved);
        this.#keyIndex.set(provider, i);
        return result;
      } catch (error) {
        tried.push({ keyIndex: i, error });
        const hasNext = i < keys.length - 1;
        if (!hasNext || !isKeyExhaustedError(error)) {
          throw tried.length > 1 ? new AllKeysExhaustedError(role, provider, tried) : error;
        }
        // The cursor moves even before the next attempt succeeds, so a
        // concurrent call for a different role on the same provider does not
        // waste a request re-discovering the same dead key.
        this.#keyIndex.set(provider, i + 1);
        process.stderr.write(
          `[wowlidator] ${PROVIDER_META[provider].label} key ${i + 1}/${keys.length} for "${role}" ` +
            `looks exhausted (${summarize(error)}) — trying key ${i + 2}/${keys.length}\n`,
        );
      }
    }
    // Unreachable: the loop above always returns or throws before running out.
    throw new AllKeysExhaustedError(role, provider, tried);
  }
}

// --- Structured generation --------------------------------------------------

/** An image the model must read — a diagram photo, a screenshot of a spec. */
export interface StructuredImage {
  data: Uint8Array;
  /** IANA media type, e.g. `image/png`. */
  mediaType: string;
}

export interface StructuredRequest<T> {
  model: LanguageModel;
  /** `provider:modelId`, used to make failures name the model that failed. */
  modelLabel: string;
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  /**
   * Images sent alongside the prompt, for vision-capable models. A model
   * without vision fails the call with its label in the message — the useful
   * question is which role to repoint, same as every other failure here.
   */
  images?: readonly StructuredImage[] | undefined;
  maxOutputTokens?: number | undefined;
  maxRetries?: number | undefined;
  /** Raw provider request fields, keyed by the provider's registry name. */
  providerOptions?: Record<string, Record<string, unknown>> | undefined;
  /** Who is asking, for the request log — the role, plus anything the caller adds. */
  task?: string | undefined;
  /** Set for a paced provider (Google): waits for headroom, honours 429 delays. */
  pacer?: RatePacer | undefined;
}

export interface StructuredResponse<T> {
  object: T;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  /** Input tokens the provider served from its prompt cache, when it reports them (Phase C telemetry). */
  cachedInputTokens?: number | undefined;
}

/**
 * One structured-output call, with the failure mode that actually bites on
 * free tiers spelled out: not every free model can emit JSON matching a
 * schema, and when one can't, the error should say which model and which role
 * rather than surfacing a bare parse failure.
 */
/**
 * How many times a *generation* failure is worth re-asking.
 *
 * The AI SDK's own `maxRetries` covers transport: a 429 or a 500 is retried,
 * which is why a rate limit reports "Failed after 3 attempts". It does not
 * retry a response that arrived intact and was simply wrong — a truncated
 * object, unparseable text, a shape zod rejects — because from the SDK's
 * position those are indistinguishable from a model that can never comply.
 *
 * From here they are distinguishable, because the rate is measurable: on
 * glm-4.7-flash the generator succeeds about four times in five, so a failure
 * is overwhelmingly a bad roll rather than a model that cannot do this at all.
 * Two extra attempts take a ~21% call failure rate to roughly 1%. A model that
 * genuinely cannot comply still fails — three times, and then with the same
 * message it gives now.
 */
const RECOVERABLE_ATTEMPTS = 3;

/**
 * Exhausted re-ask cycles before a model's structured output is declared
 * broken for this process. One cycle can be a bad roll (~20% on some free
 * tiers); two full cycles — six unusable answers running — is a model that
 * cannot do this, and every further ask would spend three calls and their
 * timeouts to learn it again. Tripping the breaker converts that repeating
 * cost into one immediate, clearly-worded SYSTEM failure.
 */
const BREAKER_TRIPS = 2;
const exhaustedCycles = new Map<string, number>();

/** Test seam: the breaker is process-wide state. */
export function resetStructuredBreaker(): void {
  exhaustedCycles.clear();
}

/**
 * A model that cannot produce schema-valid output — a fact about the
 * *machinery*, never about the application under test. Typed so every
 * consumer can classify it as an environment/system failure: the CLI exits
 * `EXIT.environment`, the healer records unavailability, and nothing files
 * an application defect over it.
 */
export class StructuredOutputUnavailableError extends Error {
  readonly modelLabel: string;

  constructor(message: string, modelLabel: string, cause?: unknown) {
    super(message);
    this.name = 'StructuredOutputUnavailableError';
    this.modelLabel = modelLabel;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Whether the model answered, badly, in a way that re-asking might fix.
 *
 * Deliberately narrow: only `NoObjectGeneratedError`, which is what the SDK
 * raises once a response has come back and failed to become an object. A
 * transport error is already retried a layer down, and a key failure must
 * rotate rather than repeat — re-asking there would just spend another call on
 * something that was never going to work, which is the same reason
 * `isKeyExhaustedError` exists.
 */
/**
 * What to tell the model about its last reply. Appended to the prompt of the
 * re-ask, so the second ask is a different request from the first.
 */
function reaskNote(error: unknown, attempt: number): string {
  const e = error as { text?: unknown; cause?: unknown } | undefined;
  const zod = (e?.cause as { issues?: { path?: unknown[]; message?: unknown }[] } | undefined)?.issues;
  const lines = [
    `YOUR PREVIOUS REPLY (attempt ${attempt}) WAS REJECTED BEFORE IT WAS READ.`,
  ];
  if (Array.isArray(zod) && zod.length > 0) {
    lines.push('It was JSON, but these fields did not match the schema:');
    for (const issue of zod.slice(0, 8)) {
      lines.push(`  - ${(issue.path ?? []).map(String).join('.') || '(root)'}: ${String(issue.message ?? '')}`);
    }
  } else if (typeof e?.text === 'string' && e.text !== '') {
    // The parser's own complaint (the SDK's JSONParseError carries the
    // SyntaxError as its cause) names the position; the generic list is what
    // usually sits there. Both, so the note is exact where it can be.
    const parser = findInChain(e?.cause, (x) => x?.name === 'SyntaxError') as { message?: unknown } | undefined;
    lines.push(
      'It was not valid JSON' +
        (typeof parser?.message === 'string' && parser.message !== '' ? ` (parser: ${parser.message})` : '') +
        '. Common causes: a double quote inside a string that was not ' +
        'escaped as \\", a trailing comma, a comment, text before or after the object, ' +
        'a value that is not a JSON literal.',
    );
  } else {
    lines.push('It was empty.');
  }
  lines.push(
    'Reply again with ONE JSON object and nothing else: valid JSON, every required key ' +
      'present (use "" for a field you do not need), strings double-quoted with inner ' +
      'quotes escaped.',
  );
  return lines.join('\n');
}

function worthReasking(error: unknown): boolean {
  return NoObjectGeneratedError.isInstance(error) && !isKeyExhaustedError(error);
}

export async function generateStructured<T>(
  request: StructuredRequest<T>,
): Promise<StructuredResponse<T>> {
  // Breaker first: a model that has already burned the full re-ask budget
  // twice does not get a third chance per call site — it gets one immediate
  // system failure, and the run's report says which role to repoint.
  // Keyed by ROLE and model, not model alone (2026-08-28). Live on be100: two
  // authoring rows exhausted their re-asks on claude-cli:sonnet, the breaker
  // opened for the LABEL — shared by generator, healer and agent, all on
  // that model — and the agent was refused without a call on the very next
  // case, then the whole catalog aborted. A role that keeps answering must
  // never be switched off by a sibling's failures on the same model.
  const breakerKey = `${request.task ?? 'model'}@${request.modelLabel}`;
  const tripped = exhaustedCycles.get(breakerKey) ?? 0;
  if (tripped >= BREAKER_TRIPS) {
    throw new StructuredOutputUnavailableError(
      `${request.modelLabel} structured-output circuit is open for the ${request.task ?? 'model'} role: it returned unusable ` +
        `objects through ${tripped} full re-ask cycles this session. This is a SYSTEM ` +
        `failure (the model, not the application). Point the role at a model that can ` +
        `do JSON-schema output — run \`wowlidator doctor\`, or set the role's ` +
        `WOWLIDATOR_*_PROVIDER / WOWLIDATOR_*_MODEL.`,
      request.modelLabel,
    );
  }

  let last: unknown;
  let budget = request.maxOutputTokens ?? 4096;
  let feedback = '';
  for (let attempt = 1; attempt <= RECOVERABLE_ATTEMPTS; attempt++) {
    try {
      const response = await attemptStructured({
        ...request,
        maxOutputTokens: budget,
        prompt: feedback === '' ? request.prompt : `${request.prompt}\n\n${feedback}`,
      });
      // A success halves the count rather than clearing it: one good roll
      // from a mostly-broken model must not reset the evidence against it.
      const seen = exhaustedCycles.get(breakerKey) ?? 0;
      if (seen > 0) exhaustedCycles.set(breakerKey, seen - 1);
      return response;
    } catch (error) {
      last = error;
      if (attempt === RECOVERABLE_ATTEMPTS || !worthReasking(error)) break;
      // **A response cut at the output budget is re-asked with a BIGGER
      // budget, never the same one.** Every structured call here runs at
      // temperature 0, so an identical request is answered identically — a
      // model that spent the budget on hidden reasoning and was cut off
      // mid-object will be cut off at the same place three times running,
      // and that is exactly what happened: "returned an unusable object" ×3,
      // finish=length each time, then the circuit breaker, then a whole
      // catalog run dead. Growth is bounded; a cap the answer really needs
      // is paid once, and a model that stops sooner never bills the room.
      const truncated = wasCutAtBudget(error);
      if (truncated) budget = Math.min(budget * 2, MAX_STRUCTURED_OUTPUT_TOKENS);
      // **A reply that arrived whole and was still unusable is re-asked WITH
      // the complaint**, for the same temperature-0 reason: an identical
      // request gets the identical malformed reply. Measured on a local
      // Qwen3.5-4B: finish=stop, 621 tokens, "could not parse the response",
      // three times running, then the breaker. The note names what was wrong
      // (a parse failure, or the fields zod rejected) — the healer's
      // `rejected` seam applied to the transport.
      if (!truncated) feedback = reaskNote(error, attempt);
      // Same channel as key rotation: a run's output should say what it spent
      // and why, rather than a retry being invisible in the token count.
      process.stderr.write(
        `[wowlidator] ${request.modelLabel} returned an unusable object ` +
          `(${summarize(error)}) — re-asking, attempt ${attempt + 1}/${RECOVERABLE_ATTEMPTS}` +
          (truncated ? ` with the output budget raised to ${budget}` : '') +
          '\n',
      );
    }
  }
  if (worthReasking(last)) {
    exhaustedCycles.set(breakerKey, (exhaustedCycles.get(breakerKey) ?? 0) + 1);
  }
  throw describeStructuredFailure(request, last);
}

/** The most any structured call will be allowed to emit, thinking included. */
export const MAX_STRUCTURED_OUTPUT_TOKENS = 32_768;

/** Was the model's answer cut off at the output budget, with text arriving? */
function wasCutAtBudget(error: unknown): boolean {
  const bearer = evidenceBearer(error) as { finishReason?: unknown } | undefined;
  return bearer?.finishReason === 'length';
}

/**
 * The model was never heard from: the connection dropped, was refused, or the
 * server closed it before answering. Not a schema fact and not a key fact —
 * the local server being restarted mid-call read as "failed to produce a valid
 * structured response … 3 times running" after ONE attempt (2026-08-21).
 */
function isTransportError(error: unknown): boolean {
  if (NoObjectGeneratedError.isInstance(error) || isKeyExhaustedError(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  return (
    APICallError.isInstance(error) ||
    /cannot connect|other side closed|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|fetch failed|terminated|timeout|timed out|UND_ERR/i.test(message)
  );
}

function describeStructuredFailure<T>(request: StructuredRequest<T>, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  if (isTransportError(error)) {
    return new StructuredOutputUnavailableError(
      `${request.modelLabel} could not be reached — the connection failed before any answer arrived: ${detail}\n` +
        'This is the transport, not the model or the schema: the server is down, was restarted ' +
        'mid-call, or closed the connection. For a local server, check it is running and that ' +
        'LOCAL_LLM_TIMEOUT_MS is long enough for the prompt; nothing was retried.',
      request.modelLabel,
      error,
    );
  }
  // The capability advice is wrong for a key failure, and actively
  // misleading: "try a different model id" sends someone changing config
  // when the model was fine and the call was rate-limited. Those failures
  // already rotate keys on their own — see `isKeyExhaustedError`.
  // A third cause, a third advice: an answer CUT at an output budget is
  // neither a key nor a model that cannot do JSON — it is a budget, and the
  // dial is named on line one (2026-09-04: a claude-cli answer cut at the
  // CLI's own cap used to read "try a different model id").
  const advice = isKeyExhaustedError(error)
    ? 'This looks like the key rather than the model — rate limit, quota, or ' +
      'an expired credential. Retry, or add a second key to rotate into.'
    : wasCutAtBudget(error)
      ? 'The answer was cut at an output budget, not refused: raise the budget the ' +
        'first line names, or ask for a smaller answer.'
      : `Not every free-tier model supports JSON-schema output, and this one failed ` +
        `${RECOVERABLE_ATTEMPTS} times running. Try a different model id for this role, ` +
        'or point the role at another provider.';
  // Two different headlines for two different facts. "Failed to produce a
  // valid structured response" is what the model DID say when it answered
  // and the answer was unusable; a rate limit or quota is the model never
  // having been asked, and wording it as the former sent a reader to change
  // model ids over a daily token cap (Groq, 200k TPD, seen live).
  const headline = isKeyExhaustedError(error)
    ? `${request.modelLabel} could not be asked — the provider refused the call (rate limit, quota, or credential): ${detail}\n`
    : `${request.modelLabel} failed to produce a valid structured response: ${detail}\n`;
  // The evidence rides the FIRST line (2026-08-28). Every consumer that
  // shows a person why a row was blocked — the case line, the ledger reason,
  // the fatal — keeps `message.split('\n')[0]`, and the evidence used to sit
  // on line two: a whole be100 run reported "did not match schema" ten times
  // with what the model actually said discarded at every one of them.
  const evidence = describeGenerationFailure(error).trim();
  return new StructuredOutputUnavailableError(
    `${headline.trimEnd()}${evidence === '' ? '' : ` ${evidence}`}\n${advice}`,
    request.modelLabel,
    error,
  );
}

/** How many times one request may wait out a 429 before the failover sees it. */
const RATE_LIMIT_RETRIES = 3;

async function attemptStructured<T>(
  request: StructuredRequest<T>,
): Promise<StructuredResponse<T>> {
  const task = request.task ?? 'model';
  const estTokens = estimateTokens(request.system) + estimateTokens(request.prompt);
  for (let attempt = 1; ; attempt++) {
    // Pacing first: arriving under a limit costs seconds, arriving over it
    // costs a 429, the SDK's blind retries and a key rotation.
    let pacing: string | undefined;
    if (request.pacer) {
      const waited = await request.pacer.reserve(estTokens, task);
      const snap = request.pacer.snapshot();
      pacing =
        `${snap.minute.requests}/${snap.limits.rpm ?? '∞'} RPM · ${snap.minute.tokens}/${snap.limits.tpm ?? '∞'} TPM · ` +
        `${snap.day.requests}/${snap.limits.rpd ?? '∞'} RPD` +
        (waited > 0 ? ` · waited ${Math.round(waited / 1000)}s` : '');
    }
    logLlmRequest({
      task,
      modelLabel: request.modelLabel,
      system: request.system,
      prompt: request.prompt,
      estTokens,
      attempt,
      pacing,
    });
    const started = Date.now();
    try {
      const response = await sendStructured(request);
      request.pacer?.record(response, estTokens);
      logLlmResponse({
        task,
        modelLabel: request.modelLabel,
        ms: Date.now() - started,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        object: response.object,
      });
      // A claude-* call spends the signed-in account's own limits, so its
      // headroom rides beside the call that spent from it. Fire-and-forget,
      // cached, throttled — see `claude-quota.ts`; never on the hot path.
      if (request.modelLabel.startsWith('claude-')) maybeLogClaudeQuota(task);
      return response;
    } catch (error) {
      request.pacer?.release();
      // A 429 on a paced provider is waited out for as long as the server
      // asked, then the same request goes again on the same key — rotating
      // keys over a full minute spends the next key on the same minute.
      if (request.pacer && isRateLimitError(error) && attempt < RATE_LIMIT_RETRIES) {
        const delay = request.pacer.learnFrom(error, task);
        if (delay <= PACER_MAX_WAIT_MS) {
          logLlmFailure({ task, modelLabel: request.modelLabel, ms: Date.now() - started, error, willRetryInMs: delay });
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }
      logLlmFailure({ task, modelLabel: request.modelLabel, ms: Date.now() - started, error });
      // A refused claude-* call is exactly when the account's headroom is the
      // question — say where the limits stand next to the failure.
      if (request.modelLabel.startsWith('claude-')) maybeLogClaudeQuota(task);
      throw error;
    }
  }
}

async function sendStructured<T>(
  request: StructuredRequest<T>,
): Promise<StructuredResponse<T>> {
  {
    const result = await generateObject({
      model: request.model,
      schema: request.schema,
      system: request.system,
      // With images the prompt travels as a text part beside them — the SDK
      // takes `prompt` or `messages`, never both.
      ...(request.images?.length
        ? {
            messages: [
              {
                role: 'user' as const,
                content: [
                  { type: 'text' as const, text: request.prompt },
                  ...request.images.map((image) => ({
                    type: 'file' as const,
                    data: image.data,
                    mediaType: image.mediaType,
                  })),
                ],
              },
            ],
          }
        : { prompt: request.prompt }),
      // Zero, explicitly, for every structured call. Nothing here is creative
      // writing: a healer repairing a selector, an author turning a claim
      // into steps, an agent picking one action — each has a most-likely
      // right answer, and sampling around it is where run-to-run
      // inconsistency came from (the same claim authored as 25 steps one run
      // and 29 the next, with different invented roles). Providers that
      // reject the parameter fall back on their own default via retry
      // machinery; none of the current five do.
      temperature: 0,
      maxOutputTokens: request.maxOutputTokens ?? 4096,
      maxRetries: request.maxRetries ?? 2,
      ...(request.providerOptions === undefined
        ? {}
        : { providerOptions: request.providerOptions as never }),
    });

    const cacheRead = result.usage.inputTokenDetails?.cacheReadTokens;
    return {
      object: result.object,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      ...(typeof cacheRead === 'number' ? { cachedInputTokens: cacheRead } : {}),
    };
  }
}

/**
 * What actually came back when a structured call failed — the difference
 * between "the model can't do JSON" and "the model was cut off mid-thought".
 *
 * "No object generated: the model did not return a response" hides three very
 * different causes: a reasoning model that spent the whole output budget (or
 * the server's own completion ceiling) thinking and emitted nothing (`length`
 * with empty text), a model that wrapped the JSON in prose (text present but
 * unparseable), and a provider that errored outright. The evidence is on the
 * error object the SDK throws; this puts it in the message a person reads.
 */
function describeGenerationFailure(error: unknown): string {
  const source = evidenceBearer(error);
  const zod = findInChain(error, (x) => x?.name === 'ZodError');
  const e = source as {
    finishReason?: unknown;
    usage?: { outputTokens?: unknown };
    text?: unknown;
  };
  const parts: string[] = [];
  if (typeof e?.finishReason === 'string') parts.push(`finish=${e.finishReason}`);
  const out = e?.usage?.outputTokens;
  if (typeof out === 'number') parts.push(`outputTokens=${out}`);
  if (typeof e?.text === 'string') {
    parts.push(
      e.text === ''
        ? 'model text was empty — likely all output budget went to hidden reasoning'
        : e.finishReason === 'length'
          ? `the JSON was CUT OFF at the output budget (${e.text.length} chars arrived) — a thinking ` +
            'model spent the budget on hidden reasoning; cap the reasoning (OpenRouter: ' +
            'reasoning.max_tokens) or raise maxOutputTokens'
          : echoedTheSchema(e.text)
          ? 'the model replied with the JSON *schema* instead of an instance of it ' +
            '(its answers are inside "const" fields) — see promptSchemaInstruction'
          : `model text began: ${JSON.stringify(e.text.slice(0, 160))}`,
    );
  }
  // Which fields the model actually got wrong. Without this a schema mismatch
  // reads as "response did not match schema" and nothing else — the failure
  // that sent someone reproducing this by hand rather than reading the error.
  const issues = (zod as { issues?: { path?: unknown[]; code?: unknown }[] } | undefined)?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const named = [
      ...new Set(
        issues.map((issue) => {
          const path = (issue.path ?? []).filter((p) => typeof p === 'string').join('.');
          return `${path === '' ? '(root)' : path}: ${String(issue.code)}`;
        }),
      ),
    ];
    parts.push(`rejected ${named.slice(0, 5).join(', ')}`);
  }
  return parts.length === 0 ? '' : `  (${parts.join(', ')})\n`;
}

/** Walk an error's `cause` chain, cycle-safe. */
function findInChain(
  error: unknown,
  match: (candidate: { name?: unknown } | undefined) => boolean,
): unknown {
  const seen = new Set<unknown>();
  let node: unknown = error;
  while (node !== undefined && node !== null && !seen.has(node)) {
    seen.add(node);
    if (match(node as { name?: unknown })) return node;
    node = (node as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * The link in the chain that actually carries what the model said.
 *
 * This used to unwrap `cause` exactly once, which is right for a JSON parse
 * failure and wrong for a schema mismatch: `NoObjectGeneratedError` holds
 * `text`, `finishReason` and `usage` *itself*, and its cause is a
 * `TypeValidationError` that holds none of them. So the one failure mode
 * someone most needs evidence for — "response did not match schema" — was the
 * one that printed nothing at all. Take the first link that has the evidence,
 * whichever depth it sits at.
 */
function evidenceBearer(error: unknown): unknown {
  const bearer = findInChain(error, (candidate) => {
    const c = candidate as { text?: unknown; finishReason?: unknown } | undefined;
    return typeof c?.text === 'string' || typeof c?.finishReason === 'string';
  });
  return bearer ?? error;
}

/**
 * Whether the model answered with the schema rather than with data.
 *
 * A distinctive failure and an opaque one — zod reports every field as
 * `undefined`, which reads like a model that cannot emit JSON at all. Naming
 * it costs one parse of text we already have, and points at the one function
 * that fixes it. Deliberately narrow: a *real* instance would have to carry
 * both `properties` and one of the other schema keywords at the top level to
 * be mistaken for one.
 */
function echoedTheSchema(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
    const keys = new Set(Object.keys(parsed));
    return keys.has('properties') && (keys.has('$schema') || keys.has('type') || keys.has('required'));
  } catch {
    return false;
  }
}

/** Where a structured request gets its model from. */
export type ModelSource = { factory: LlmFactory; role: LlmRole } | { model: LanguageModel };

/**
 * Run one structured-output request against a model source.
 *
 * A factory-backed source gets automatic key failover via
 * `LlmFactory.callWithFailover` — this is how every `Llm*Model` class picks
 * up rotation without knowing it exists. An explicit model (used by tests and
 * by embedders that construct their own `LanguageModel`) is called directly:
 * there is no factory, and therefore nothing to fail over into.
 */
/**
 * Providers whose models bill hidden reasoning tokens against the same
 * output budget as the answer.
 *
 * Every `maxOutputTokens` in this codebase was sized for *visible* output —
 * 256 for a data value, 1024 for a repair. A reasoning model (EmmieDev's
 * `small` spends ~340 completion tokens to say "hello") burns those budgets
 * thinking, hits the cap mid-thought, and returns empty content — surfacing
 * as "No object generated: the model did not return a response", an error
 * that reads like a broken provider rather than a starved one. The floor
 * leaves the thinking room; a model that needs less simply stops sooner and
 * never bills the difference.
 */
const REASONING_OUTPUT_FLOOR: Partial<Record<ProviderName, number>> = {
  emmiedev: 16_384,
  // z.ai is deliberately absent. The floor was here because GLM models think
  // by default and that thinking bills against `max_tokens` — but
  // `withPromptSchema` now sends `thinking: { type: 'disabled' }` for z.ai, and
  // the measured `reasoningTokens` is 0. With the premise gone the floor only
  // buys a runaway generation more rope: seen live, a request for 3 test cases
  // ran to 16,384 tokens and 129KB of JSON before truncating mid-string, when
  // the generator's own 8,192 budget would have stopped it at half the cost.
  // Truncation is handled by retrying (see `RECOVERABLE_ATTEMPTS`); this only
  // decides how much is spent discovering it.
  // Gemini flash models think by default too, and thinking spends from the
  // same maxOutputTokens budget as the answer. Seen live on gemini-3.5-flash:
  // a generator call producing valid JSON that stopped mid-object — "No
  // object generated: could not parse the response" with the text visibly
  // truncated. The floor leaves the thinking room; non-thinking Gemini models
  // simply never use it.
  google: 16_384,
};

/**
 * Providers whose models never see a JSON schema unless we put it in the
 * prompt ourselves.
 *
 * `generateObject` delivers the schema through the provider's structured
 * output channel (`response_format: json_schema`). A plain OpenAI-compatible
 * endpoint has no such channel, and the SDK then sends the request with **no
 * schema in it at all** — the model returns fluent JSON in whatever shape it
 * invents, and every call fails validation with "response did not match
 * schema". Measured against z.ai's glm-4.5-flash: 0/3 with the bare request,
 * 3/3 with the schema stated in the system prompt. `json_object` mode is
 * requested alongside (both endpoints accept it; z.ai enforces it) so the
 * reply cannot be prose-wrapped.
 *
 * **How that instruction is worded is itself load-bearing — see
 * `promptSchemaInstruction`.**
 */
// DeepSeek offers `json_object` mode but no schema-constrained channel the
// OpenAI-compatible provider can hand a schema to, so it is told the schema in
// prose like the other two.
// `claude-cli` is NOT among them: the CLI takes `--json-schema` and validates
// against it, so restating the schema in the prompt would only cost tokens.
// `claude-tty` IS: an interactive terminal has no schema channel at all —
// and `claude-cloud` is that same terminal with the work in a cloud session.
const SCHEMA_IN_PROMPT_PROVIDERS: ReadonlySet<ProviderName> = new Set(['emmiedev', 'zai', 'deepseek', 'local', 'claude-tty', 'claude-cloud']);

/**
 * Silence the one AI SDK warning this codebase makes untrue.
 *
 * For the providers above, every structured call triggers "The feature
 * \"responseFormat\" is not supported" — the SDK saying it could not deliver
 * the schema through the provider's structured-output channel. True, and
 * handled: `withPromptSchema` puts the schema in the prompt and requests
 * `json_object` mode itself, so the warning describes a problem that no
 * longer exists, once per call, on stderr, forever. Every other warning
 * still logs — this filters, it does not switch the system off (setting the
 * global to `false` would).
 */
type SdkWarning = { type?: string; feature?: string };
(globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS = (options: {
  warnings: SdkWarning[];
  provider?: string;
  model?: string;
}): void => {
  const spurious = (w: SdkWarning) =>
    w.type === 'unsupported' &&
    w.feature === 'responseFormat' &&
    options.provider !== undefined &&
    (SCHEMA_IN_PROMPT_PROVIDERS as ReadonlySet<string>).has(options.provider.split('.')[0] ?? '');
  for (const warning of options.warnings) {
    if (spurious(warning)) continue;
    const scope = options.provider ? ` (${options.provider} / ${options.model ?? '?'})` : '';
    console.warn(`AI SDK Warning${scope}: ${JSON.stringify(warning)}`);
  }
};

/**
 * How to ask for an *instance* of a schema without being handed the schema.
 *
 * The obvious wording — "respond with a JSON object that matches this JSON
 * schema exactly" — is ambiguous, and GLM 4.7 reads it the wrong way: it
 * replies with the schema itself, answers tucked into `const` fields, like
 * this:
 *
 * ```json
 * {"$schema":"…","type":"object","properties":{
 *    "name":{"type":"string","const":"Verify successful login"}, …}}
 * ```
 *
 * That is valid JSON, so `json_object` mode is satisfied and nothing catches
 * it until zod rejects every field as `undefined` — surfacing as
 * "No object generated: response did not match schema", which reads like a
 * model that cannot do structured output at all. It can; it answered the
 * wrong question.
 *
 * Two things provoke it, and the fix addresses both:
 *
 * - **Nesting.** The failure tracks schema shape, not model quality. Measured
 *   on glm-4.7-flash: the healer's flat four-key object came back correct 4/4
 *   with the old wording, while the generator's `steps: array of objects`
 *   managed **3/8**. A nested schema simply looks more like a document to
 *   reproduce.
 * - **`$schema`.** `z.toJSONSchema` emits a `$schema` key, which is a strong
 *   hint that the thing being shown is a document worth echoing. It is
 *   dropped: nothing downstream reads it, and the model is being told what
 *   this is in prose anyway.
 *
 * The replacement names the distinction outright and lists the keywords a
 * schema echo would contain, so the failure is ruled out by the instruction
 * rather than hoped against. Same measurement, same prompts, same model:
 * **8/8**.
 */
export function promptSchemaInstruction(schema: z.ZodType): string {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json['$schema'];
  return (
    'Reply with one JSON object and nothing else — no prose, no markdown fences.\n' +
    'Your reply must be DATA described by the JSON Schema below, never the schema itself. ' +
    'Do not emit the keys "$schema", "type", "properties", "items", "required" or "const"; ' +
    'emit the keys the schema names under "properties", with values of the types it gives.' +
    `\n\nJSON Schema:\n${JSON.stringify(json)}`
  );
}

/** The request rewritten for a provider that needs the schema in the prompt. */
function withPromptSchema<T>(
  request: Omit<StructuredRequest<T>, 'model'>,
  provider: ProviderName,
): Omit<StructuredRequest<T>, 'model'> {
  if (!SCHEMA_IN_PROMPT_PROVIDERS.has(provider)) return request;
  return {
    ...request,
    // A request the local server has not answered yet is still being
    // generated; re-sending it queues the copy behind the original and both
    // time out. The re-ask loop above still handles a reply that arrived and
    // was unusable — that is a different thing from a reply that has not
    // arrived.
    ...(provider === 'local' ? { maxRetries: 0 } : {}),
    system: `${request.system}\n\n${promptSchemaInstruction(request.schema as z.ZodType)}`,
    providerOptions: {
      [provider]: {
        // `local` keeps the SDK's own `json_schema` response_format so the
        // schema reaches the server (see FACTORIES.local); the others have no
        // schema channel and get plain JSON mode.
        ...(provider === 'local' ? {} : { response_format: { type: 'json_object' } }),
        // GLM models think before every answer, and on the free tier that
        // thinking is both slow to produce and billed as output — measured
        // ~340 hidden tokens and 18s to say "ok", 2 tokens and 7s without.
        // Structured schema-following measured 3/3 either way, so the
        // thinking is pure cost here. z.ai-only: other providers don't know
        // the field.
        ...(provider === 'zai' ? { thinking: { type: 'disabled' } } : {}),
      },
    },
  };
}

/**
 * Models that think before they answer, reached through OpenRouter, and how
 * much thinking a structured call is allowed to buy.
 *
 * Measured on `openrouter:google/gemini-3.6-flash` (2026-08-19), one
 * authoring-sized call, four ways:
 *
 * | budget | reasoning              | outcome                                       |
 * |--------|------------------------|-----------------------------------------------|
 * | 2048   | default                | finish=length, 241 chars of JSON — ~1.8k hidden |
 * | 8192   | default                | finish=length, cut mid-object after 38 s — ~7.3k hidden |
 * | 2048   | effort: none           | refused: "Reasoning is mandatory for this endpoint" |
 * | 2048   | max_tokens: 256        | finish=stop in 3.6 s, 12 steps, 0 wasted        |
 *
 * That is the whole of "returned an unusable object (No object generated:
 * could not parse the response)": the JSON was fine, it was truncated because
 * the model spent the output budget thinking, and it spends MORE the more it
 * is given. `REASONING_OUTPUT_FLOOR` covers the same fact for the `google`
 * provider by raising the budget; here the measured answer is to CAP the
 * thinking instead — a floor of 16k would still be a coin toss (row 2 spent
 * 7.3k and was not done), and would make every call four times slower.
 *
 * Gated on the model id, not the provider: OpenRouter fronts hundreds of
 * models and a `reasoning` field sent to one that has none is at best ignored
 * and at worst refused. The patterns are the families that think by default.
 */
const OPENROUTER_REASONING_MODEL = /gemini|deepseek-r|deepseek-reasoner|\bo[1345](-|$)|gpt-5|qwen3|qwq|thinking|reason|glm-4\.[5-9]|grok-[4-9]/i;
export const OPENROUTER_REASONING_MAX_TOKENS = 1_024;

/**
 * Cap the hidden reasoning of a thinking model behind OpenRouter, and give
 * the visible answer back the budget the cap took. See the table above.
 */
function withReasoningCap<T>(
  request: Omit<StructuredRequest<T>, 'model'>,
  provider: ProviderName,
  modelId: string,
): Omit<StructuredRequest<T>, 'model'> {
  const existing = (request.providerOptions ?? {}) as Record<string, Record<string, unknown>>;
  // Gemini reached directly, same fact, its own dial. Measured on
  // `google:gemini-3.6-flash` with an authoring-sized prompt: default →
  // 20.6s, 1,727 thinking tokens; `thinkingBudget: 1024` → 10.9s, 303;
  // `thinkingBudget: 0` → "invalid argument" (thinking is mandatory on this
  // model). The 16k `REASONING_OUTPUT_FLOOR` stays as the room the soft cap
  // may still overrun; the cap is what makes the ordinary call fast.
  if (provider === 'google' && /gemini/i.test(modelId)) {
    return {
      ...request,
      providerOptions: {
        ...existing,
        google: {
          ...(existing['google'] ?? {}),
          thinkingConfig: {
            ...((existing['google']?.['thinkingConfig'] as Record<string, unknown> | undefined) ?? {}),
            thinkingBudget: OPENROUTER_REASONING_MAX_TOKENS,
          },
        },
      },
    };
  }
  // Groq's gpt-oss models reason at "medium" by default. Every call this
  // codebase makes to them is extraction — a selector, one agent action, one
  // data value — and measured, "low" answered the same in 766ms. It matters
  // less for latency than for the free tier's tokens-per-minute cap: four
  // cases running side by side hit that cap and the SDK's back-off turned an
  // 8-turn agent leg into 202 seconds. Fewer tokens per call is the one lever
  // against a per-minute limit that a run does not control.
  if (provider === 'groq' && /gpt-oss/i.test(modelId)) {
    return {
      ...request,
      providerOptions: {
        ...existing,
        groq: { ...(existing['groq'] ?? {}), reasoningEffort: 'low' },
      },
    };
  }
  if (provider !== 'openrouter' || !OPENROUTER_REASONING_MODEL.test(modelId)) return request;
  return {
    ...request,
    // The cap is spent from the same budget as the answer, so the answer's own
    // budget is restored on top of it — a healer sized at 1024 visible tokens
    // still gets 1024 visible tokens.
    maxOutputTokens: (request.maxOutputTokens ?? 4096) + OPENROUTER_REASONING_MAX_TOKENS,
    providerOptions: {
      ...existing,
      openrouter: {
        ...(existing['openrouter'] ?? {}),
        reasoning: { max_tokens: OPENROUTER_REASONING_MAX_TOKENS },
      },
    },
  };
}

export async function generateStructuredForModel<T>(
  source: ModelSource,
  request: Omit<StructuredRequest<T>, 'model'>,
): Promise<StructuredResponse<T>> {
  if ('model' in source) {
    return generateStructured({ ...request, model: source.model });
  }
  const entry = source.factory.config.roles[source.role];
  // A provider that answers one call at a time is entered through its gate:
  // bounded in flight, priority by who is waiting, one call per identical
  // question. Nothing else changes — the failover and every adaptation below
  // run inside the slot exactly as they would without it.
  if (SERIAL_PROVIDERS.has(entry.provider)) {
    const gate = serialGateFor(entry.baseUrl ?? entry.provider);
    const key = dedupeKeyFor([source.role, entry.provider, entry.modelId, request.system, request.prompt]);
    const { result, joined } = await gate.run(
      source.role,
      request.system.length + request.prompt.length,
      () => callStructuredWithFailover(source, request),
      request.images === undefined || request.images.length === 0 ? key : undefined,
    );
    // A joiner spent nothing: the tokens belong to the call it rode along with.
    return joined ? { ...result, inputTokens: 0, outputTokens: 0 } : result;
  }
  return callStructuredWithFailover(source, request);
}

function callStructuredWithFailover<T>(
  source: { factory: LlmFactory; role: LlmRole },
  request: Omit<StructuredRequest<T>, 'model'>,
): Promise<StructuredResponse<T>> {
  return source.factory.callWithFailover(source.role, async (resolved) => {
    const pacer = PACED_PROVIDERS.has(resolved.provider)
      ? await pacerFor(
          resolved.provider,
          source.factory.config.apiKeys[resolved.provider]?.[resolved.keyIndex] ?? '',
          resolved.modelId,
        )
      : undefined;
    const task = request.task === undefined ? source.role : `${source.role} · ${request.task}`;
    const floor = REASONING_OUTPUT_FLOOR[resolved.provider];
    const maxOutputTokens =
      floor === undefined
        ? request.maxOutputTokens
        : Math.max(request.maxOutputTokens ?? 0, floor);
    const adapted = withReasoningCap(
      withPromptSchema({ ...request, maxOutputTokens }, resolved.provider),
      resolved.provider,
      resolved.modelId,
    );
    return generateStructured({ ...adapted, model: resolved.model, task, pacer });
  });
}
