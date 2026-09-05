/**
 * Which model each role runs on, chosen from the panel.
 *
 * The sibling of `ui/keys.ts`, and deliberately built to the same three rules.
 * That file answers "which key does this role start on"; this one answers "and
 * which model does it call with it". Both are decisions about *this panel's*
 * runs, both are applied as an environment overlay on the spawned CLI, and
 * neither writes to `.env` — editing that file is a decision about the machine,
 * not about the next run.
 *
 * ## The list comes from the provider, not from this repo
 *
 * `DEFAULT_ROLE_MODELS` in `config.ts` carries a warning that the ids in it are
 * the most fragile thing in the codebase, because they move faster than the
 * file does. A hardcoded dropdown would inherit that problem and make it worse:
 * it would look authoritative while going stale, and the first symptom would be
 * someone picking a model that was retired months ago. So each provider is
 * asked what it currently serves, using the key already configured for it.
 *
 * Three endpoints, three shapes, one list out:
 *
 * - **Google AI Studio** — `GET /v1beta/models?key=…`, filtered to the ones that
 *   support `generateContent`. An embedding model is not something a healer can
 *   be pointed at, and offering it would be offering a run that fails later.
 * - **Groq** — `GET /openai/v1/models`, bearer auth.
 * - **OpenRouter** — `GET /api/v1/models`. This one answers without a key, so
 *   the catalogue is browsable before anyone has signed up; the key is sent
 *   when there is one so the answer reflects the account.
 *
 * ## What this refuses to do
 *
 * **A model id that is not in the fetched list is still accepted.** The list is
 * a convenience, not an authority: it can be stale, the provider can be
 * unreachable, and a brand-new id is exactly the thing someone would be here to
 * type. Refusing it would make this panel the reason a working model could not
 * be used. `wowlidator doctor` makes a real call per role and is the only thing
 * that actually knows whether an id resolves.
 *
 * **A key never appears in what this returns.** Google takes its key as a URL
 * query parameter, which makes it the one place in this codebase where a
 * credential could end up inside an error message or a log line by accident —
 * so failures here are reported by provider and status, never by echoing the
 * request.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  LLM_ROLES,
  PROVIDERS,
  PROVIDER_META,
  type LlmRole,
  localLlmBaseUrl,
  localBaseUrlForPort,
  portOfBaseUrl,
  type ProviderName,
  type WowlidatorConfig,
  FIXED_MODEL_PROVIDERS,
  fixedModelFor,
  AGY_CLI_MODELS,
  CODEX_CLI_MODELS,
} from '../config.js';

/** How long a fetched catalogue is reused. The panel polls; providers do not. */
export const MODELS_TTL_MS = 10 * 60 * 1000;

/** Long enough for a cold provider, short enough not to hang the page. */
const FETCH_TIMEOUT_MS = 8_000;

/**
 * An id has to survive becoming an environment variable for a spawned process.
 *
 * Not a security boundary — argv is an array and the env is an object, so
 * nothing here is parsed by a shell. It is a sanity boundary: a value with a
 * newline in it is not a model id, and accepting one would produce a failure
 * inside a run that reads like a provider problem.
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\-/]{0,120}$/;

export interface ProviderModelsView {
  provider: ProviderName;
  label: string;
  /** Ids this provider says it serves, best-effort. Empty is not an error. */
  models: string[];
  /** Why the list is empty or old. Empty when it is neither. */
  note: string;
  /** ISO time the list was fetched, or null if it never was. */
  fetchedAt: string | null;
  /** False when no key is configured — the list may be short or absent. */
  keyed: boolean;
  /** True when the server ignores the model field — there is nothing to pick. */
  fixedModel: boolean;
}

export interface RoleModelView {
  role: LlmRole;
  provider: ProviderName;
  modelId: string;
  /** True when the panel changed this from what the environment configured. */
  overridden: boolean;
  /** What `.env` says, so a person can see what they are departing from. */
  configuredProvider: ProviderName;
  configuredModelId: string;
  /** Where a `local` role's server listens; null for every other provider. */
  baseUrl: string | null;
  /** The port of `baseUrl`, for the panel's field; null when there is none. */
  port: number | null;
}

export class ModelSelectionError extends Error {}

/** One provider's catalogue, and when it arrived. */
interface CachedModels {
  models: string[];
  note: string;
  fetchedAt: number;
}

/**
 * The panel's per-role model override, plus the catalogue it offers.
 *
 * Kept apart from `WowlidatorConfig` for the same reason `KeySelection` is: the
 * config is what the environment said at startup, and this is what somebody
 * clicked a moment ago. Merging them would make "re-read .env" meaningless.
 */
export class ModelSelection {
  readonly #chosen = new Map<
    LlmRole,
    { provider: ProviderName; modelId: string; baseUrl: string | undefined }
  >();
  readonly #catalogue = new Map<ProviderName, CachedModels>();
  readonly #inFlight = new Map<ProviderName, Promise<CachedModels>>();

  /**
   * Point a role at a provider and a model.
   *
   * The provider is checked against the three this codebase can construct — an
   * unknown one would otherwise reach `LlmFactory` and fail inside a run, about
   * something the user did not type. The model id is checked for shape only;
   * see the note at the top about why it is not checked against the list.
   */
  select(role: string, provider: string, modelId: string, port?: number | null): void {
    if (!(LLM_ROLES as readonly string[]).includes(role)) {
      throw new ModelSelectionError(`"${role}" is not a model role`);
    }
    if (!(PROVIDERS as readonly string[]).includes(provider)) {
      throw new ModelSelectionError(
        `"${provider}" is not a provider wowlidator can use — it has ${PROVIDERS.join(', ')}`,
      );
    }
    // A fixed-model provider answers with whatever it loaded; a typed id
    // would be recorded as the run's model and be false.
    const trimmed = fixedModelFor(provider as ProviderName) ?? modelId.trim();
    if (!MODEL_ID.test(trimmed)) {
      throw new ModelSelectionError(
        'that does not look like a model id — expected something like "llama-3.3-70b-versatile"',
      );
    }
    // A port is only meaningful for a server on this machine; for any other
    // provider it is dropped rather than recorded as a setting that does nothing.
    let baseUrl: string | undefined;
    if (provider === 'local' && port !== undefined && port !== null) {
      try {
        baseUrl = localBaseUrlForPort(port);
      } catch (error) {
        throw new ModelSelectionError(error instanceof Error ? error.message : String(error));
      }
    }
    this.#chosen.set(role as LlmRole, {
      provider: provider as ProviderName,
      modelId: trimmed,
      baseUrl,
    });
  }

  /** Put a role back on whatever the environment configured. */
  reset(role: string): void {
    if (!(LLM_ROLES as readonly string[]).includes(role)) {
      throw new ModelSelectionError(`"${role}" is not a model role`);
    }
    this.#chosen.delete(role as LlmRole);
  }

  /** What each role would run on now, and what it would have run on otherwise. */
  describeRoles(config: WowlidatorConfig): RoleModelView[] {
    return LLM_ROLES.map((role) => {
      const configured = config.roles[role];
      const chosen = this.#chosen.get(role);
      const provider = chosen?.provider ?? configured.provider;
      // A role moved onto `local` without a port keeps the shared default;
      // one that stayed on `local` keeps whatever `.env` gave it.
      const baseUrl =
        provider !== 'local'
          ? null
          : (chosen?.baseUrl ??
            (configured.provider === 'local' ? configured.baseUrl : undefined) ??
            localLlmBaseUrl());
      return {
        role,
        provider,
        modelId: chosen?.modelId ?? configured.modelId,
        overridden: chosen !== undefined,
        configuredProvider: configured.provider,
        configuredModelId: configured.modelId,
        baseUrl,
        port: baseUrl === null ? null : portOfBaseUrl(baseUrl),
      };
    });
  }

  /** The catalogue as the browser may see it — ids only, never a key. */
  describeCatalogue(config: WowlidatorConfig): ProviderModelsView[] {
    return PROVIDERS.map((provider) => {
      const cached = this.#catalogue.get(provider);
      return {
        provider,
        label: PROVIDER_META[provider].label,
        models: cached?.models ?? [],
        note: cached?.note ?? '',
        fetchedAt: cached === undefined ? null : new Date(cached.fetchedAt).toISOString(),
        keyed: (config.apiKeys[provider]?.length ?? 0) > 0,
        fixedModel: FIXED_MODEL_PROVIDERS.has(provider),
      };
    });
  }

  /**
   * Fetch every provider's catalogue, reusing anything still fresh.
   *
   * Never throws. A provider that is down, rate-limited or unkeyed comes back
   * as an empty list and a note — the panel has to render either way, and a
   * page that fails to load because a model list could not be fetched would be
   * a worse outcome than a page that says so.
   */
  async refresh(config: WowlidatorConfig, force = false): Promise<void> {
    await Promise.all(
      PROVIDERS.map(async (provider) => {
        const cached = this.#catalogue.get(provider);
        if (!force && cached && Date.now() - cached.fetchedAt < MODELS_TTL_MS) return;

        // One request per provider even when the page asks twice: the panel
        // polls, and a slow provider would otherwise collect a queue of
        // identical calls behind each poll.
        let pending = this.#inFlight.get(provider);
        if (pending === undefined) {
          const key = (config.apiKeys[provider] ?? [])[0];
          pending = fetchModels(provider, key).finally(() => {
            this.#inFlight.delete(provider);
          });
          this.#inFlight.set(provider, pending);
        }
        this.#catalogue.set(provider, await pending);
      }),
    );
  }

  /**
   * The environment a spawned run should inherit, given these choices.
   *
   * Only roles somebody actually changed appear. An untouched role keeps what
   * the real environment already had rather than being handed its own value
   * back in a slightly different shape — the same rule `KeySelection` follows,
   * and what keeps an unchanged panel invisible to the run it starts.
   */
  envOverlay(): Record<string, string> {
    const overlay: Record<string, string> = {};
    for (const [role, choice] of this.#chosen) {
      const name = role.toUpperCase();
      overlay[`WOWLIDATOR_${name}_PROVIDER`] = choice.provider;
      overlay[`WOWLIDATOR_${name}_MODEL`] = choice.modelId;
      if (choice.baseUrl !== undefined) overlay[`WOWLIDATOR_${name}_BASE_URL`] = choice.baseUrl;
    }
    return overlay;
  }
}

/**
 * Write a role's provider and model into `.env`, so the choice outlives the panel.
 *
 * This module used to say, deliberately, that nothing here writes to `.env` —
 * that editing it is a decision about the machine and not about the next run.
 * That reasoning holds for a *key*, which is a credential you might switch for
 * one run and must not leave behind. It does not hold for the model a role runs
 * on: picking one in the panel and finding it gone after a restart is not
 * "scoped to this session", it is the setting not working. Changed on request.
 *
 * Upserts, never rewrites: an existing uncommented assignment is replaced in
 * place, keeping the file's comments and order, and anything new is appended
 * under one managed heading. Temp file plus rename, the same as the cache
 * writer — a half-written `.env` would take the provider keys with it.
 */
export async function persistRoleModel(
  role: string,
  choice: { provider: string; modelId: string; baseUrl?: string | undefined } | null,
  envPath = '.env',
): Promise<void> {
  const target = resolve(envPath);
  const name = role.toUpperCase();
  const assignments: [string, string | null][] = [
    [`WOWLIDATOR_${name}_PROVIDER`, choice === null ? null : choice.provider],
    [`WOWLIDATOR_${name}_MODEL`, choice === null ? null : choice.modelId],
  ];
  // The base URL is written only when one was chosen; otherwise the line is
  // commented out (a reset, or a move off `local`), so a stale port cannot
  // outlive the provider it belonged to.
  if (choice?.baseUrl !== undefined) assignments.push([`WOWLIDATOR_${name}_BASE_URL`, choice.baseUrl]);
  else assignments.push([`WOWLIDATOR_${name}_BASE_URL`, null]);

  let text = '';
  try {
    text = await readFile(target, 'utf8');
  } catch {
    text = '';
  }

  const lines = text.split('\n');
  const appended: string[] = [];

  for (const [key, value] of assignments) {
    const at = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
    if (value === null) {
      // Reset means "go back to whatever the file said before the panel touched
      // it" — and the file *is* the thing it said. Commented out rather than
      // deleted, so the value is recoverable by eye.
      if (at !== -1) lines[at] = `# ${lines[at]}`;
      continue;
    }
    if (at === -1) appended.push(`${key}=${value}`);
    else lines[at] = `${key}=${value}`;
  }

  if (appended.length > 0) {
    const heading = '# --- Chosen in the panel ---';
    if (!lines.includes(heading)) {
      if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
      lines.push(heading);
    }
    lines.push(...appended);
  }

  const next = lines.join('\n');
  const temp = `${target}.tmp`;
  await writeFile(temp, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
  await rename(temp, target);
}

/**
 * Ask one provider what it serves.
 *
 * Each answer is normalised to a sorted list of ids, because the three shapes
 * have nothing in common and everything above this line should not have to
 * know which provider it is looking at.
 */
async function fetchModels(
  provider: ProviderName,
  key: string | undefined,
): Promise<CachedModels> {
  const stamp = Date.now();
  const fail = (note: string): CachedModels => ({ models: [], note, fetchedAt: stamp });

  // A fixed-model provider serves exactly one model and ignores the id it is
  // sent; there is no catalogue worth fetching, so the alias is stated here
  // rather than asked for over the network.
  const fixed = fixedModelFor(provider);
  if (fixed !== undefined) {
    return { models: [fixed], note: '', fetchedAt: stamp };
  }

  if (provider === 'agy-cli' || provider === 'codex-cli') {
    return {
      models: provider === 'agy-cli' ? [...AGY_CLI_MODELS] : [...CODEX_CLI_MODELS],
      note: '',
      fetchedAt: stamp,
    };
  }

  // OpenRouter serves its catalogue unauthenticated; the other two cannot say
  // anything useful without a key, and asking anyway would spend a round trip
  // to be told so.
  if (key === undefined && provider !== 'openrouter') {
    return fail(`no key configured — set ${PROVIDER_META[provider].envKey} in .env`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const request = REQUESTS[provider](key);
    const response = await fetch(request.url, {
      headers: request.headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      // Reported by status, never by echoing the request: Google's key travels
      // in the URL, and a message quoting it would put a live credential in
      // the panel, the page and anything that screenshots either.
      return fail(
        response.status === 401 || response.status === 403
          ? `${PROVIDER_META[provider].label} rejected the configured key (${response.status})`
          : `${PROVIDER_META[provider].label} answered ${response.status}`,
      );
    }

    const models = request.parse(await response.json());
    return models.length === 0
      ? fail(`${PROVIDER_META[provider].label} listed no usable models`)
      : { models: [...new Set(models)].sort(), note: '', fetchedAt: stamp };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return fail(
      aborted
        ? `${PROVIDER_META[provider].label} did not answer within ${FETCH_TIMEOUT_MS / 1000}s`
        : `could not reach ${PROVIDER_META[provider].label}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

interface ModelRequest {
  url: string;
  headers: Record<string, string>;
  parse: (body: unknown) => string[];
}

const REQUESTS: Record<ProviderName, (key: string | undefined) => ModelRequest> = {
  google: (key) => ({
    url: `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key ?? '')}`,
    headers: {},
    parse: (body) => {
      const models = (body as { models?: unknown }).models;
      if (!Array.isArray(models)) return [];
      return models
        .filter((entry) => {
          // An embedding model is not something a role can be pointed at, and
          // listing one is offering a run that fails at the first call.
          const methods = (entry as { supportedGenerationMethods?: unknown })
            .supportedGenerationMethods;
          return Array.isArray(methods) && methods.includes('generateContent');
        })
        .map((entry) => String((entry as { name?: unknown }).name ?? ''))
        // `models/gemini-2.0-flash` — the prefix is the API's, not the id's.
        .map((name) => name.replace(/^models\//, ''))
        .filter((name) => name !== '');
    },
  }),
  groq: (key) => ({
    url: 'https://api.groq.com/openai/v1/models',
    headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
    parse: (body) => openAiShape(body),
  }),
  openrouter: (key) => ({
    url: 'https://openrouter.ai/api/v1/models',
    headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
    parse: (body) => openAiShape(body),
  }),
  zai: (key) => ({
    url: 'https://api.z.ai/api/paas/v4/models',
    headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
    // The catalogue lists only the paid GLMs; the free tier's glm-4.5-flash is
    // callable but absent from it, so it is added here rather than lost.
    parse: (body) => [...openAiShape(body), 'glm-4.5-flash'],
  }),
  deepseek: (key) => ({
    url: 'https://api.deepseek.com/v1/models',
    headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
    parse: (body) => openAiShape(body),
  }),
  airforce: (key) => ({
    url: 'https://api.airforce/v1/models',
    headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
    parse: (body) => openAiShape(body),
  }),
  cerebras: (key) => ({
    url: 'https://api.cerebras.ai/v1/models',
    headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
    parse: (body) => openAiShape(body),
  }),
  requesty: (key) => ({
    url: 'https://router.requesty.ai/v1/models',
    headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
    parse: (body) => openAiShape(body),
  }),
  // Never reached — `fetchModels` short-circuits every `FIXED_MODEL_PROVIDERS`
  // entry before any request is built. These exist because `REQUESTS` is
  // total over `ProviderName`.
  emmiedev: () => ({
    url: 'https://chat.emmiedev.com/v1/models',
    headers: {},
    parse: () => ['default'],
  }),
  local: (key) => ({
    url: `${localLlmBaseUrl()}/models`,
    headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
    parse: () => ['default_model'],
  }),
  'agy-cli': () => ({
    url: 'about:blank',
    headers: {},
    parse: () => [...AGY_CLI_MODELS],
  }),
  'codex-cli': () => ({
    url: 'about:blank',
    headers: {},
    parse: () => [...CODEX_CLI_MODELS],
  }),
  // The CLI publishes no catalogue endpoint, so the aliases it accepts are
  // listed here. Aliases rather than dated ids on purpose: the CLI resolves
  // each to the current model of that name, which is exactly what an alias
  // is for. The URL is never fetched — `parse` ignores its body.
  'claude-cli': () => ({
    url: 'about:blank',
    headers: {},
    parse: () => ['fable', 'opus', 'sonnet', 'haiku'],
  }),
  'claude-tty': () => ({
    url: 'about:blank',
    headers: {},
    parse: () => ['fable', 'opus', 'sonnet', 'haiku'],
  }),
  // Same aliases: a cloud session takes the same `--model` the local CLI does.
  'claude-cloud': () => ({
    url: 'about:blank',
    headers: {},
    parse: () => ['fable', 'opus', 'sonnet', 'haiku'],
  }),
};


/** `{ data: [{ id }] }` — what both OpenAI-compatible catalogues return. */
function openAiShape(body: unknown): string[] {
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((entry) => String((entry as { id?: unknown }).id ?? ''))
    .filter((id) => id !== '');
}
