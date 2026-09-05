/**
 * Centralised environment configuration.
 *
 * Every knob wowlidator has lives here, validated once at startup rather than
 * scattered through `process.env` lookups. The important part is the *role*
 * table: wowlidator has three distinct model jobs, and each is routed to whichever
 * free-tier provider suits it, independently of the others.
 *
 *   healer    → fast + cheap. One small repair, latency-sensitive.  → Groq (gpt-oss-120b)
 *   generator → big context. A whole AX tree in, a suite out.       → Gemini
 *   agent     → general reasoning, one decision per turn.           → Groq (gpt-oss-120b)
 *   data      → small, rare escalation for mock data.               → Groq (gpt-oss-120b)
 *
 * Nothing here is hard-wired: any role can point at any provider and model id
 * through environment variables, which is the whole point of the abstraction.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

import { z } from 'zod';

import { DEFAULT_REPORT_DIR as REPORTER_DEFAULT_DIR } from './reporter/html-reporter.js';
import { DEFAULT_CAPTURE_DELAY_MS } from './engine/evidence.js';
import type { ScreenshotMode, VideoMode } from './engine/runner.js';

export const LLM_ROLES = ['healer', 'generator', 'agent', 'data', 'governor'] as const;
export type LlmRole = (typeof LLM_ROLES)[number];

export const PROVIDERS = ['google', 'groq', 'openrouter', 'emmiedev', 'zai', 'deepseek', 'local', 'agy-cli', 'codex-cli', 'claude-cli', 'claude-tty', 'claude-cloud', 'airforce', 'cerebras', 'requesty'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

/** Which env var carries each provider's key, and where to get one. */
export const PROVIDER_META: Record<
  ProviderName,
  { envKey: string; label: string; consoleUrl: string; freeTier: string }
> = {
  'agy-cli': {
    envKey: '',
    label: 'Agy CLI (this machine\'s signed-in session)',
    consoleUrl: 'https://antigravity.google/',
    freeTier: 'billed to the session already signed in here — no key to configure',
  },
  'codex-cli': {
    envKey: '',
    label: 'Codex CLI (this machine\'s signed-in session)',
    consoleUrl: 'https://chatgpt.com/codex',
    freeTier: 'billed to the ChatGPT session already signed in here — no key to configure',
  },
  'claude-cli': {
    // Deliberately empty: the CLI carries the operator's own logged-in
    // session, so there is no key to set and the role gate must not demand
    // one. `KEYLESS_PROVIDERS` is what makes that structural rather than a
    // special case scattered through the callers.
    envKey: '',
    label: 'Claude Code CLI (this machine\'s own session)',
    consoleUrl: 'https://claude.com/claude-code',
    freeTier: 'billed to the session already signed in here — no key to configure',
  },
  // The same session, kept warm: one interactive `claude` per (model, effort)
  // answers every call instead of a process start per call. See
  // `providers/claude-tty.ts` for what it cannot promise (no native schema,
  // no usage figures).
  'claude-tty': {
    envKey: '',
    label: 'Claude Code TTY (this machine\'s session, one warm process)',
    consoleUrl: 'https://claude.com/claude-code',
    freeTier: 'billed to the session already signed in here — no key to configure',
  },
  // The same signed-in account, but the model runs in a Claude Code CLOUD
  // session (`claude --cloud`) rather than on this machine. The CLI refuses
  // `--cloud` without a TTY, so this rides the same warm interactive terminal
  // as `claude-tty` — see `createClaudeCloud` in `providers/claude-tty.ts`.
  // `WOWLIDATOR_CLAUDE_CLOUD_SESSION` attaches to an existing session by id or
  // claude.ai/code URL; unset, a fresh cloud session is created per worker.
  'claude-cloud': {
    envKey: '',
    label: 'Claude Code Cloud (a cloud session on this account)',
    consoleUrl: 'https://claude.ai/code',
    freeTier: 'billed to the signed-in account\'s cloud sessions — no key to configure',
  },
  google: {
    envKey: 'GOOGLE_GENERATIVE_AI_API_KEY',
    label: 'Google AI Studio (Gemini)',
    consoleUrl: 'https://aistudio.google.com/apikey',
    freeTier: 'generous free tier; largest context of the three',
  },
  groq: {
    envKey: 'GROQ_API_KEY',
    label: 'Groq',
    consoleUrl: 'https://console.groq.com/keys',
    freeTier: 'free tier with tight rate limits; fastest tokens/sec',
  },
  openrouter: {
    envKey: 'OPENROUTER_API_KEY',
    label: 'OpenRouter',
    consoleUrl: 'https://openrouter.ai/keys',
    freeTier: 'free `:free` model variants; broad model selection',
  },
  // OpenAI-compatible endpoint at chat.emmiedev.com — keys start `ek-`.
  // The server ignores the model field; `default` is its stable alias for
  // whatever model it currently runs, so always use that as the model id.
  emmiedev: {
    envKey: 'EMMIEDEV_API_KEY',
    label: 'EmmieDev',
    consoleUrl: 'https://chat.emmiedev.com',
    freeTier: 'self-provided key; OpenAI-compatible /v1 API',
  },
  // Z.AI (Zhipu) — OpenAI-compatible endpoint serving the GLM family
  // (glm-4.6, glm-4.5-air, …).
  zai: {
    envKey: 'ZAI_API_KEY',
    label: 'Z.AI (GLM)',
    consoleUrl: 'https://z.ai/manage-apikey/apikey-list',
    freeTier: 'paid API with free trial credit; GLM models',
  },
  // DeepSeek — OpenAI-compatible endpoint at api.deepseek.com. `deepseek-chat`
  // (V3) for every role here; `deepseek-reasoner` (R1) thinks before it
  // answers and bills the thinking against the output budget.
  deepseek: {
    envKey: 'DEEPSEEK_API_KEY',
    label: 'DeepSeek',
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    freeTier: 'paid API, low per-token price; deepseek-chat / deepseek-reasoner',
  },
  airforce: {
    envKey: 'AIRFORCE_API_KEY',
    label: 'Airforce',
    consoleUrl: 'https://api.airforce',
    freeTier: 'OpenAI-compatible /v1 API',
  },
  cerebras: {
    envKey: 'CEREBRAS_API_KEY',
    label: 'Cerebras',
    consoleUrl: 'https://cloud.cerebras.ai',
    freeTier: 'Fast AI Inference',
  },
  requesty: {
    envKey: 'REQUESTY_API_KEY',
    label: 'Requesty',
    consoleUrl: 'https://requesty.ai',
    freeTier: 'OpenAI-compatible /v1 API',
  },
  // A model served on this machine — mlx_lm.server, llama.cpp, vLLM, LM Studio:
  // anything speaking the OpenAI-compatible /v1 API. Default base URL is
  // http://localhost:8080/v1 (`LOCAL_LLM_BASE_URL` overrides). No key is
  // required: `LOCAL_LLM_API_KEY` is optional and a placeholder is supplied
  // when it is unset, so every "does this role have a key" gate stays true.
  local: {
    envKey: 'LOCAL_LLM_API_KEY',
    label: 'Local (localhost:8080)',
    consoleUrl: 'http://localhost:8080/v1/models',
    freeTier: 'your own hardware; OpenAI-compatible server (mlx_lm, llama.cpp, vLLM)',
  },
};

/**
 * Providers that answer one call at a time — a local MLX server prefills
 * serially. Authoring runs one row at a time on them (`authorWorkers`) and
 * every structured call goes through `SerialGate` (`providers/serial-gate.ts`).
 */
// `claude-tty` is one terminal answering one request at a time — the same
// shape, so it takes the same admission control (and authors one row at a
// time). `WOWLIDATOR_CLAUDE_TTY_WORKERS` widens the terminal pool behind it.
// `claude-cloud` is that same terminal with the work happening in a cloud
// session behind it — still one request at a time per terminal.
export const SERIAL_PROVIDERS: ReadonlySet<string> = new Set(['local', 'claude-tty', 'claude-cloud']);

/** Where the `local` provider's server listens. */
export const DEFAULT_LOCAL_LLM_BASE_URL = 'http://localhost:8080/v1';
export function localLlmBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.LOCAL_LLM_BASE_URL?.trim();
  return raw === undefined || raw === '' ? DEFAULT_LOCAL_LLM_BASE_URL : raw.replace(/\/+$/, '');
}

/**
 * A base URL for a local server on this port — what the panel's port field
 * turns into. Two `rerise` instances (a 9B for authoring, a 4B for repairs)
 * differ only by port, so a port is the whole of what a person picks.
 */
export function localBaseUrlForPort(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`"${port}" is not a TCP port`);
  }
  return `http://localhost:${port}/v1`;
}

/** The port a local base URL points at, or null when it names none we can read. */
export function portOfBaseUrl(baseUrl: string): number | null {
  try {
    const u = new URL(baseUrl);
    if (u.port !== '') return Number(u.port);
    return u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : null;
  } catch {
    return null;
  }
}

/** Sent as the bearer token when `LOCAL_LLM_API_KEY` is unset; local servers ignore it. */
export const LOCAL_LLM_PLACEHOLDER_KEY = 'local';
/** The same idea for the Claude CLI — see where it is assigned. */
export const CLAUDE_CLI_PLACEHOLDER_KEY = 'claude-cli-session';
export const CODEX_CLI_PLACEHOLDER_KEY = 'codex-cli-session';
export const CODEX_CLI_MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const;
export const AGY_CLI_PLACEHOLDER_KEY = 'agy-cli-session';
export const AGY_CLI_MODELS = [
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-low',
  'gemini-3.7-flash-high',
  'gemini-3.7-flash-medium',
  'gemini-3.7-flash-low',
  'gemini-3.6-flash-high',
  'gemini-3.6-flash-medium',
  'gemini-3.6-flash-low',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
] as const;

/**
 * Defaults chosen to match each role's shape.
 *
 * ⚠️ Model *ids* move faster than this file does. They are the most likely
 * thing here to be stale — run `wowlidator doctor` to confirm each one resolves
 * against the live provider before trusting a run.
 *
 * The Google and Groq ids below were confirmed against each provider's live
 * `models.list` endpoint (Groq's `openai/gpt-oss-120b` on 2026-08-11).
 */
export const DEFAULT_ROLE_MODELS: Record<LlmRole, { provider: ProviderName; modelId: string }> = {
  healer: { provider: 'groq', modelId: 'openai/gpt-oss-120b' },
  generator: { provider: 'google', modelId: 'gemini-3.6-flash' },
  agent: { provider: 'groq', modelId: 'openai/gpt-oss-120b' },
  // Same job shape as healer — small, latency-sensitive, rarely called (most
  // data generation is deterministic and never reaches a model at all).
  data: { provider: 'groq', modelId: 'openai/gpt-oss-120b' },
  // The queue governor: a handful of event-driven turns per SUITE, each a
  // compact observation and one structured decision. Cheap by default; the
  // person may point it at an expensive model (claude-cli opus) precisely
  // because the turn budget, not the model, bounds the spend.
  governor: { provider: 'groq', modelId: 'openai/gpt-oss-120b' },
};

/**
 * The id sent to a provider whose server decides the model.
 *
 * One alias per provider, because servers differ: mlx_lm.server maps
 * `default_model` (its literal default for a missing `model` field) to the
 * `--model` it was started with, and treats ANY other id — `default`
 * included — as a Hugging Face repo to fetch, failing with "cannot find an
 * appropriate cached snapshot" offline. Measured live 2026-08-21. EmmieDev's
 * alias is `default`.
 */
export const FIXED_MODEL_ALIAS: Readonly<Partial<Record<ProviderName, string>>> = {
  emmiedev: 'default',
  local: 'default_model',
};
export function fixedModelFor(provider: ProviderName): string | undefined {
  return FIXED_MODEL_ALIAS[provider];
}

/**
 * Providers that serve exactly one model and ignore the `model` field of a
 * request: the loaded model answers whatever id is named. EmmieDev's `default`
 * is the original case; the `local` server is the same shape — the model is
 * chosen where the server is started, not per request. For these a role has
 * no model to pick: `WOWLIDATOR_<ROLE>_MODEL` is ignored, the panel shows no
 * model field, and the alias is what gets recorded as the run's model label.
 */
export const FIXED_MODEL_PROVIDERS: ReadonlySet<ProviderName> = new Set(['emmiedev', 'local']);

/**
 * The model a provider is known to run this codebase's structured calls on,
 * for a role whose provider was re-pointed without naming a model. Starting
 * points, not facts — `wowlidator doctor` is the only way to know an id still
 * resolves, the same caveat `DEFAULT_ROLE_MODELS` carries.
 */
export const DEFAULT_PROVIDER_MODELS: Record<ProviderName, string> = {
  google: 'gemini-3.6-flash',
  groq: 'openai/gpt-oss-120b',
  openrouter: 'google/gemini-3.6-flash',
  emmiedev: 'default',
  zai: 'glm-4.5-flash',
  deepseek: 'deepseek-chat',
  airforce: 'default',
  cerebras: 'llama3.1-8b',
  requesty: 'default',
  local: 'default_model',
  'agy-cli': 'gemini-3.8-flash-medium',
  'codex-cli': 'gpt-5.6-terra',
  // An alias, not a dated id: the CLI resolves `fable` to whatever the
  // current Fable is. A DEFAULT and not a fixed model — each role keeps its
  // own `WOWLIDATOR_<ROLE>_MODEL`, so a run can put the expensive model where
  // authoring happens and a cheaper one on the healer and the agent.
  'claude-cli': 'fable',
  // The warm terminal is for the roles called every few seconds — healer,
  // agent, data — where the cheap fast model at low effort measured best.
  'claude-tty': 'sonnet',
  // A cloud session pays network latency on every exchange anyway, so the
  // default leans on capability — the natural home for the agent role.
  'claude-cloud': 'sonnet',
};


export interface RoleConfig {
  role: LlmRole;
  provider: ProviderName;
  modelId: string;
  /**
   * Where this role's server listens — set only for the `local` provider,
   * from `WOWLIDATOR_<ROLE>_BASE_URL`, else `LOCAL_LLM_BASE_URL`, else the
   * default port. Per role, because one machine can run two local servers
   * and a role is the unit a provider is chosen at.
   */
  baseUrl?: string | undefined;
  /**
   * Reasoning effort for a provider that has the concept (`claude-cli`), from
   * `WOWLIDATOR_<ROLE>_EFFORT`.
   *
   * Per role, because the roles differ in what they are for: the healer, the
   * agent and the data model each make one small decision and are called
   * every few seconds, while authoring is one large call per case. Measured
   * 2026-08-26 at 15k tokens of prompt: fable at high effort answered in
   * 6.1 s against sonnet at low effort's 3.0 s, and cost four times as much.
   */
  effort?: string | undefined;
  /**
   * Available tools for a CLI provider (`claude-cli`), from
   * `WOWLIDATOR_<ROLE>_TOOLS`.
   */
  tools?: string | undefined;
  /**
   * Allowed tools for a CLI provider (`claude-cli`), from
   * `WOWLIDATOR_<ROLE>_ALLOWED_TOOLS`.
   */
  allowedTools?: string | undefined;
  /**
   * Disallowed tools for a CLI provider (`claude-cli`), from
   * `WOWLIDATOR_<ROLE>_DISALLOWED_TOOLS`.
   */
  disallowedTools?: string | undefined;
}

export interface WowlidatorConfig {
  roles: Record<LlmRole, RoleConfig>;
  /**
   * Ordered by preference — index 0 is the one used by default. A provider
   * with more than one key gets automatic failover: see
   * `LlmFactory.callWithFailover` in `providers/llm-factory.ts`.
   */
  apiKeys: Partial<Record<ProviderName, string[]>>;
  /** Free tiers rate-limit aggressively; the SDK backs off between attempts. */
  maxRetries: number;
  cdpUrl: string;
  cachePath: string;
  proofDir: string;
  /** Append-only run index. Absolute, or relative to the process's cwd. */
  historyPath: string;
  reportDir: string;
  /** Explicit report destination (file, directory, or a `{placeholder}` path). */
  reportPath: string | undefined;
  /** False disables HTML report writing entirely. */
  reportEnabled: boolean;
  /**
   * Stills.
   *
   * **`undefined` means unset, and unset is not `all`.** Left alone, the
   * runner picks a mode from whether the run is being filmed — `on-failure`
   * when it is, `all` when it is not. Defaulting it here would resolve that
   * choice before the runner could make it, and every run would carry both a
   * recording and a full set of stills.
   */
  screenshots: ScreenshotMode | undefined;
  /** Film the run, with a drawn-in pointer. See `engine/video.ts`. */
  video: VideoMode;
  /** Perform like a person while filming; undefined follows the recording. `WOWLIDATOR_HUMANIZE`. */
  humanize: boolean | undefined;
  /** Pause before each screenshot, so the page has painted. See `evidence.ts`. */
  captureDelayMs: number;
  healing: boolean;
  agentEnabled: boolean;
  /** Let the agent rescue an unreachable control mid-run. Off by default. */
  agentAssist: boolean;
}

export const DEFAULT_CDP_URL = 'http://localhost:9222';
export const DEFAULT_CACHE_PATH = 'healed-selectors.json';
export const DEFAULT_PROOF_DIR = '.wowlidator/proofs';
export const DEFAULT_REPORT_DIR = REPORTER_DEFAULT_DIR;
export const DEFAULT_MAX_RETRIES = 2;

const providerSchema = z.enum(PROVIDERS);
const screenshotSchema = z.enum(['off', 'on-failure', 'on-event', 'all']);
/**
 * `WOWLIDATOR_SCREENSHOTS=auto` is the same "unset" the CLI's `--screenshots
 * auto` means: let the recording decide. Accepted here so the environment can
 * state the default rather than only override it.
 */
const screenshotEnvSchema = z.union([screenshotSchema, z.literal('auto')]);
const videoSchema = z.enum(['on', 'off']);

const envSchema = z.object({
  WOWLIDATOR_HEALER_PROVIDER: providerSchema.optional(),
  WOWLIDATOR_HEALER_MODEL: z.string().min(1).optional(),
  // Reasoning effort per role, for a provider that has the concept. Left
  // loose on purpose: the set of levels belongs to the provider, and a schema
  // that pinned it here would reject a level added later.
  WOWLIDATOR_HEALER_EFFORT: z.string().min(1).optional(),
  WOWLIDATOR_GENERATOR_EFFORT: z.string().min(1).optional(),
  WOWLIDATOR_AGENT_EFFORT: z.string().min(1).optional(),
  WOWLIDATOR_DATA_EFFORT: z.string().min(1).optional(),
  WOWLIDATOR_HEALER_TOOLS: z.string().optional(),
  WOWLIDATOR_GENERATOR_TOOLS: z.string().optional(),
  WOWLIDATOR_AGENT_TOOLS: z.string().optional(),
  WOWLIDATOR_DATA_TOOLS: z.string().optional(),
  WOWLIDATOR_GOVERNOR_TOOLS: z.string().optional(),
  WOWLIDATOR_HEALER_ALLOWED_TOOLS: z.string().optional(),
  WOWLIDATOR_GENERATOR_ALLOWED_TOOLS: z.string().optional(),
  WOWLIDATOR_AGENT_ALLOWED_TOOLS: z.string().optional(),
  WOWLIDATOR_DATA_ALLOWED_TOOLS: z.string().optional(),
  WOWLIDATOR_GOVERNOR_ALLOWED_TOOLS: z.string().optional(),
  WOWLIDATOR_HEALER_DISALLOWED_TOOLS: z.string().optional(),
  WOWLIDATOR_GENERATOR_DISALLOWED_TOOLS: z.string().optional(),
  WOWLIDATOR_AGENT_DISALLOWED_TOOLS: z.string().optional(),
  WOWLIDATOR_DATA_DISALLOWED_TOOLS: z.string().optional(),
  WOWLIDATOR_GOVERNOR_DISALLOWED_TOOLS: z.string().optional(),
  WOWLIDATOR_HEALER_BASE_URL: z.string().url().optional(),
  WOWLIDATOR_GENERATOR_PROVIDER: providerSchema.optional(),
  WOWLIDATOR_GENERATOR_MODEL: z.string().min(1).optional(),
  WOWLIDATOR_GENERATOR_BASE_URL: z.string().url().optional(),
  WOWLIDATOR_AGENT_PROVIDER: providerSchema.optional(),
  WOWLIDATOR_AGENT_MODEL: z.string().min(1).optional(),
  WOWLIDATOR_AGENT_BASE_URL: z.string().url().optional(),
  WOWLIDATOR_DATA_PROVIDER: providerSchema.optional(),
  WOWLIDATOR_DATA_MODEL: z.string().min(1).optional(),
  WOWLIDATOR_DATA_BASE_URL: z.string().url().optional(),
  WOWLIDATOR_GOVERNOR_PROVIDER: providerSchema.optional(),
  WOWLIDATOR_GOVERNOR_MODEL: z.string().min(1).optional(),
  WOWLIDATOR_GOVERNOR_BASE_URL: z.string().url().optional(),
  WOWLIDATOR_GOVERNOR_EFFORT: z.string().optional(),

  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(1).optional(),
  GROQ_API_KEY: z.string().min(1).optional(),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  EMMIEDEV_API_KEY: z.string().min(1).optional(),
  ZAI_API_KEY: z.string().min(1).optional(),
  DEEPSEEK_API_KEY: z.string().min(1).optional(),
  AIRFORCE_API_KEY: z.string().min(1).optional(),
  CEREBRAS_API_KEY: z.string().min(1).optional(),
  REQUESTY_API_KEY: z.string().min(1).optional(),
  LOCAL_LLM_API_KEY: z.string().min(1).optional(),
  LOCAL_LLM_BASE_URL: z.string().url().optional(),

  WOWLIDATOR_LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(10).optional(),
  WOWLIDATOR_CDP_URL: z.string().min(1).optional(),
  WOWLIDATOR_CACHE_PATH: z.string().min(1).optional(),
  WOWLIDATOR_PROOF_DIR: z.string().min(1).optional(),
  WOWLIDATOR_HISTORY_PATH: z.string().min(1).optional(),
  WOWLIDATOR_REPORT_DIR: z.string().min(1).optional(),
  WOWLIDATOR_REPORT_PATH: z.string().min(1).optional(),
  WOWLIDATOR_DISABLE_REPORT: z.string().optional(),
  WOWLIDATOR_SCREENSHOTS: screenshotEnvSchema.optional(),
  WOWLIDATOR_VIDEO: videoSchema.optional(),
  WOWLIDATOR_HUMANIZE: z.string().optional(),
  WOWLIDATOR_CAPTURE_DELAY_MS: z.coerce.number().int().min(0).max(30_000).optional(),
  WOWLIDATOR_DISABLE_HEALING: z.string().optional(),
  WOWLIDATOR_DISABLE_AGENT: z.string().optional(),
  WOWLIDATOR_AGENT_ASSIST: z.string().optional(),
});

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Load a local `.env` into `process.env`, if one exists.
 *
 * Called from the CLI and MCP entrypoints only — never from `loadConfig`,
 * which stays pure so tests can pass an explicit env object. Values already
 * present in the real environment win, so `GROQ_API_KEY=... wowlidator run` still
 * overrides the file.
 */
export function loadDotEnv(path = '.env'): boolean {
  let parsed: Record<string, string | undefined>;
  try {
    parsed = parseEnv(readFileSync(path, 'utf8')) as Record<string, string | undefined>;
  } catch {
    return false; // No .env is the normal case, not an error.
  }
  // The file is applied by hand rather than through `process.loadEnvFile`,
  // because that API refuses to overwrite an existing variable — which made
  // "reload `.env`" a lie for exactly the case it exists for, a key
  // *replaced* in the file while the process runs.
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined) continue;
    // Anything this process was started with, or set itself, wins over the
    // file — `GROQ_API_KEY=... wowlidator run` still overrides `.env`. Only a
    // variable that is unset, or that an earlier load of the file supplied,
    // takes the file's value.
    if (process.env[key] !== undefined && !DOTENV_SOURCED.has(key)) continue;
    process.env[key] = value;
    // Recorded so a parent process can avoid exporting file-supplied values
    // to children as though they were the real environment (see the spawn in
    // `ui/jobs.ts` for why that distinction is load-bearing).
    DOTENV_SOURCED.add(key);
  }
  return true;
}

/**
 * Env vars whose current value came from a `.env` file rather than from the
 * environment this process was actually started with.
 *
 * The distinction exists for one reason: a long-lived process (the control
 * panel) that spawns CLI runs. `loadDotEnv`'s "real environment wins" rule is
 * right within one process — `GROQ_API_KEY=... wowlidator run` must beat the
 * file — but a panel that passes its own dotenv-loaded snapshot to a child
 * makes that snapshot *become* the child's real environment, permanently
 * shadowing every later edit to `.env`. Found the expensive way: a corrected
 * EMMIEDEV_API_KEY in the file, and every panel-launched run still failing
 * auth on the stale value the panel had exported from before the fix.
 */
export const DOTENV_SOURCED = new Set<string>();

/** Drop empty strings so `FOO=` behaves the same as an unset `FOO`. */
function compact(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() !== '') out[key] = value;
  }
  return out;
}

/**
 * One env var, one or more keys: `GOOGLE_GENERATIVE_AI_API_KEY=key1,key2`.
 * Order is preserved — the first key listed is the one tried first — and
 * duplicates are dropped so a pasted-twice key doesn't count as a second,
 * independent quota to fail over into.
 */
function parseApiKeys(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const candidate of raw.split(',')) {
    const key = candidate.trim();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/**
 * Validate the environment into a config object. Throws `ConfigError` with an
 * actionable message rather than letting a bad value surface later as a
 * confusing provider error.
 *
 * Missing API keys are **not** an error here — a run with `--no-heal` and no
 * `workflow` steps needs no keys at all. Keys are checked when a role is
 * actually instantiated (see `llm-factory.ts`).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WowlidatorConfig {
  const parsed = envSchema.safeParse(compact(env));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`invalid wowlidator environment:\n${issues}`);
  }
  const e = parsed.data;

  const role = (
    name: LlmRole,
    provider: ProviderName | undefined,
    modelId: string | undefined,
    baseUrl?: string | undefined,
    effort?: string | undefined,
    tools?: string | undefined,
    allowedTools?: string | undefined,
    disallowedTools?: string | undefined,
  ): RoleConfig => {
    // Authoring is one large call per case and earns the thinking; the roles
    // called every few seconds do not. A role that says nothing takes the
    // default for its kind rather than the most expensive setting.
    const resolvedEffort =
      (effort?.trim() || undefined) ?? (name === 'generator' ? 'high' : 'low');
    const resolvedTools = tools?.trim() || undefined;
    const resolvedAllowedTools = allowedTools?.trim() || undefined;
    const resolvedDisallowedTools = disallowedTools?.trim() || undefined;
    const resolvedProvider = provider ?? DEFAULT_ROLE_MODELS[name].provider;
    // Only `local` has a server to point at; a base URL on any other provider
    // is ignored rather than sent somewhere the SDK would not honour it.
    const resolvedBase =
      resolvedProvider === 'local'
        ? (baseUrl?.trim() || undefined)?.replace(/\/+$/, '') ?? localLlmBaseUrl(env)
        : undefined;
    // A provider named without a model must not inherit a model id that
    // belongs to a DIFFERENT provider. Seen live: `WOWLIDATOR_GENERATOR_PROVIDER=zai`
    // alone resolved to `zai:gemini-3.6-flash` — the generator role's Google
    // default — and `doctor` reported the provider broken when the id was.
    // The role's own default is kept only when the provider is its own; any
    // other provider gets that provider's known-good model.
    // A fixed-model provider has nothing to choose — whatever `.env` names,
    // the server answers with the model it loaded, so the alias is the truth.
    const fixed = fixedModelFor(resolvedProvider);
    if (fixed !== undefined) {
      return {
        role: name,
        provider: resolvedProvider,
        modelId: fixed,
        baseUrl: resolvedBase,
        effort: resolvedEffort,
        tools: resolvedTools,
        allowedTools: resolvedAllowedTools,
        disallowedTools: resolvedDisallowedTools,
      };
    }
    const resolvedModel =
      modelId ??
      (resolvedProvider === DEFAULT_ROLE_MODELS[name].provider
        ? DEFAULT_ROLE_MODELS[name].modelId
        : DEFAULT_PROVIDER_MODELS[resolvedProvider]);
    return {
      role: name,
      provider: resolvedProvider,
      modelId: resolvedModel,
      effort: resolvedEffort,
      tools: resolvedTools,
      allowedTools: resolvedAllowedTools,
      disallowedTools: resolvedDisallowedTools,
    };
  };

  const apiKeys: Partial<Record<ProviderName, string[]>> = {};
  const googleKeys = parseApiKeys(e.GOOGLE_GENERATIVE_AI_API_KEY);
  const groqKeys = parseApiKeys(e.GROQ_API_KEY);
  const openrouterKeys = parseApiKeys(e.OPENROUTER_API_KEY);
  const emmiedevKeys = parseApiKeys(e.EMMIEDEV_API_KEY);
  const zaiKeys = parseApiKeys(e.ZAI_API_KEY);
  const deepseekKeys = parseApiKeys(e.DEEPSEEK_API_KEY);
  const airforceKeys = parseApiKeys(e.AIRFORCE_API_KEY);
  const cerebrasKeys = parseApiKeys(e.CEREBRAS_API_KEY);
  const requestyKeys = parseApiKeys(e.REQUESTY_API_KEY);
  if (googleKeys.length > 0) apiKeys.google = googleKeys;
  if (groqKeys.length > 0) apiKeys.groq = groqKeys;
  if (openrouterKeys.length > 0) apiKeys.openrouter = openrouterKeys;
  if (emmiedevKeys.length > 0) apiKeys.emmiedev = emmiedevKeys;
  if (zaiKeys.length > 0) apiKeys.zai = zaiKeys;
  if (deepseekKeys.length > 0) apiKeys.deepseek = deepseekKeys;
  if (airforceKeys.length > 0) apiKeys.airforce = airforceKeys;
  if (cerebrasKeys.length > 0) apiKeys.cerebras = cerebrasKeys;
  if (requestyKeys.length > 0) apiKeys.requesty = requestyKeys;
  // A local server needs no key; the placeholder keeps the role-readiness gates honest.
  const localKeys = parseApiKeys(e.LOCAL_LLM_API_KEY);
  apiKeys.local = localKeys.length > 0 ? localKeys : [LOCAL_LLM_PLACEHOLDER_KEY];
  // The Claude CLI carries the operator's own signed-in session, so there is
  // no key to set and none to miss. A placeholder keeps `hasKeyForRole` and
  // the role gate structural — the same move `local` makes above, for the
  // same reason: a provider that needs no credential must not be modelled as
  // a provider whose credential is absent.
  apiKeys['claude-cli'] = [CLAUDE_CLI_PLACEHOLDER_KEY];
  apiKeys['claude-tty'] = [CLAUDE_CLI_PLACEHOLDER_KEY];
  apiKeys['claude-cloud'] = [CLAUDE_CLI_PLACEHOLDER_KEY];
  apiKeys['codex-cli'] = [CODEX_CLI_PLACEHOLDER_KEY];
  apiKeys['agy-cli'] = [AGY_CLI_PLACEHOLDER_KEY];

  return {
    roles: {
      healer: role(
        'healer',
        e.WOWLIDATOR_HEALER_PROVIDER,
        e.WOWLIDATOR_HEALER_MODEL,
        e.WOWLIDATOR_HEALER_BASE_URL,
        e.WOWLIDATOR_HEALER_EFFORT,
        e.WOWLIDATOR_HEALER_TOOLS,
        e.WOWLIDATOR_HEALER_ALLOWED_TOOLS,
        e.WOWLIDATOR_HEALER_DISALLOWED_TOOLS,
      ),
      generator: role(
        'generator',
        e.WOWLIDATOR_GENERATOR_PROVIDER,
        e.WOWLIDATOR_GENERATOR_MODEL,
        e.WOWLIDATOR_GENERATOR_BASE_URL,
        e.WOWLIDATOR_GENERATOR_EFFORT,
        e.WOWLIDATOR_GENERATOR_TOOLS,
        e.WOWLIDATOR_GENERATOR_ALLOWED_TOOLS,
        e.WOWLIDATOR_GENERATOR_DISALLOWED_TOOLS,
      ),
      agent: role(
        'agent',
        e.WOWLIDATOR_AGENT_PROVIDER,
        e.WOWLIDATOR_AGENT_MODEL,
        e.WOWLIDATOR_AGENT_BASE_URL,
        e.WOWLIDATOR_AGENT_EFFORT,
        e.WOWLIDATOR_AGENT_TOOLS,
        e.WOWLIDATOR_AGENT_ALLOWED_TOOLS,
        e.WOWLIDATOR_AGENT_DISALLOWED_TOOLS,
      ),
      data: role(
        'data',
        e.WOWLIDATOR_DATA_PROVIDER,
        e.WOWLIDATOR_DATA_MODEL,
        e.WOWLIDATOR_DATA_BASE_URL,
        e.WOWLIDATOR_DATA_EFFORT,
        e.WOWLIDATOR_DATA_TOOLS,
        e.WOWLIDATOR_DATA_ALLOWED_TOOLS,
        e.WOWLIDATOR_DATA_DISALLOWED_TOOLS,
      ),
      governor: role(
        'governor',
        e.WOWLIDATOR_GOVERNOR_PROVIDER,
        e.WOWLIDATOR_GOVERNOR_MODEL,
        e.WOWLIDATOR_GOVERNOR_BASE_URL,
        e.WOWLIDATOR_GOVERNOR_EFFORT,
        e.WOWLIDATOR_GOVERNOR_TOOLS,
        e.WOWLIDATOR_GOVERNOR_ALLOWED_TOOLS,
        e.WOWLIDATOR_GOVERNOR_DISALLOWED_TOOLS,
      ),
    },
    apiKeys,
    maxRetries: e.WOWLIDATOR_LLM_MAX_RETRIES ?? DEFAULT_MAX_RETRIES,
    cdpUrl: e.WOWLIDATOR_CDP_URL ?? DEFAULT_CDP_URL,
    cachePath: e.WOWLIDATOR_CACHE_PATH ?? DEFAULT_CACHE_PATH,
    proofDir: e.WOWLIDATOR_PROOF_DIR ?? DEFAULT_PROOF_DIR,
    // Defaults *beside the proof bundles*, not to the working directory.
    // Everything else a run produces already had an absolute home configurable
    // through the environment; run history did not, so it resolved against
    // wherever the command happened to be typed — one file per directory anyone
    // ever ran from, and the UI reading a different one from all of them.
    historyPath:
      e.WOWLIDATOR_HISTORY_PATH ??
      join(e.WOWLIDATOR_PROOF_DIR ?? DEFAULT_PROOF_DIR, '..', 'history.jsonl'),
    reportDir: e.WOWLIDATOR_REPORT_DIR ?? DEFAULT_REPORT_DIR,
    reportPath: e.WOWLIDATOR_REPORT_PATH,
    reportEnabled: e.WOWLIDATOR_DISABLE_REPORT !== '1',
    screenshots: e.WOWLIDATOR_SCREENSHOTS === 'auto' ? undefined : e.WOWLIDATOR_SCREENSHOTS,
    video: e.WOWLIDATOR_VIDEO ?? 'on',
    humanize: e.WOWLIDATOR_HUMANIZE === undefined || e.WOWLIDATOR_HUMANIZE === '' ? undefined : e.WOWLIDATOR_HUMANIZE !== '0' && e.WOWLIDATOR_HUMANIZE !== 'off',
    captureDelayMs: e.WOWLIDATOR_CAPTURE_DELAY_MS ?? DEFAULT_CAPTURE_DELAY_MS,
    healing: e.WOWLIDATOR_DISABLE_HEALING !== '1',
    agentEnabled: e.WOWLIDATOR_DISABLE_AGENT !== '1',
    agentAssist: e.WOWLIDATOR_AGENT_ASSIST === '1',
  };
}

/** True when the provider backing `role` has at least one key available. */
export function hasKeyForRole(config: WowlidatorConfig, role: LlmRole): boolean {
  return (config.apiKeys[config.roles[role].provider]?.length ?? 0) > 0;
}

/** Human-readable routing table, used by `wowlidator doctor` and the CLI banner. */
export function describeRouting(config: WowlidatorConfig): string {
  return LLM_ROLES.map((role) => {
    const entry = config.roles[role];
    const meta = PROVIDER_META[entry.provider];
    const keys = config.apiKeys[entry.provider] ?? [];
    const key =
      meta.envKey === ''
        ? "this machine's own session"
        : keys.length === 0
        ? `MISSING ${meta.envKey}`
        : keys.length === 1
          ? 'key set'
          : `${keys.length} keys set (failover enabled)`;
    return `  ${role.padEnd(9)} ${entry.provider.padEnd(11)} ${entry.modelId.padEnd(34)} ${key}`;
  }).join('\n');
}
