/**
 * The CLI's option surface: the `CliOptions` shape and the flag-parsing
 * helpers. Split out of cli.ts verbatim.
 */

import { CONTEXT_BUDGET_CHARS } from '../catalog/retrieve.js';
import type { WowlidatorConfig } from '../config.js';
import type { ScreenshotMode, VideoMode } from '../engine/runner.js';
import { TEST_SCOPES, type TestScope } from '../generator/flow-author.js';
import type { MutationPolicy } from '../generator/test-generator.js';
import type { LlmFactory } from '../providers/llm-factory.js';

export const SCREENSHOT_MODES = ['auto', 'off', 'on-failure', 'on-event', 'all'] as const;

/**
 * Live 309-case run, 2026-09-07: 133 cases exceeded an hour; the worst ran
 * 13h15m across 145 agent calls and 2.0M tokens, then exercised 0% of controls.
 */
export const DEFAULT_CASE_TIMEOUT_MS = 1_200_000;

export interface CliOptions {
  config: WowlidatorConfig;
  factory: LlmFactory;
  cdp: string | undefined;
  cache: string | undefined;
  out: string;
  report: string | undefined;
  reportDir: string;
  reportEnabled: boolean;
  /**
   * What the user asked for. **Undefined means unset**, and is passed through
   * as unset so the runner can pick a mode from whether the run is filmed —
   * see `SmartRunnerOptions.screenshots`. Call sites that are never filmed
   * (the crawler) read it as `?? 'all'`, which is what it always was.
   */
  screenshots: ScreenshotMode | undefined;
  /**
   * Draw a red rectangle around each step's target in its screenshot
   * (`--no-target-highlight` disables). The target itself is recorded on the
   * step either way — see `ProofStep.target`.
   */
  highlightTarget: boolean;
  /**
   * The database baseline (`src/db/baseline.ts`): `off`, `snapshot` (detect the
   * tables under test, snapshot them, compare on every backend step),
   * `restore` (and put them back after the run), or `auto` — as much as the
   * configured connections allow. `--db-baseline`, else WOWLIDATOR_DB_BASELINE.
   */
  dbBaseline: string | undefined;
  /** Tables the operator adds to the detected set (`--db-baseline-tables a,b`, WOWLIDATOR_DB_BASELINE_TABLES). */
  dbBaselineTables: string[];
  video: VideoMode;
  /**
   * Perform like a person, for the film (`engine/humanize.ts`). Undefined
   * lets the runner decide: on while filming, off otherwise. `--humanize
   * on|off` or `WOWLIDATOR_HUMANIZE=1|0` to set it either way.
   */
  humanize: boolean | undefined;
  agentAssist: boolean;
  /**
   * Let the agent steady the page before a generation/authoring capture —
   * wait out spinners, dismiss overlays, prime lazy content. On by default
   * (`--no-agent-capture` disables): the pilot can only look, wait, scroll
   * and dismiss, and an inaccurate capture poisons every test written from
   * it. Degrades silently to an unpiloted capture when the agent role has
   * no key.
   */
  agentCapture: boolean;
  /**
   * Review each authored flow against the codebase and documents before it
   * is written (`--no-author-review` disables). On by default, like the
   * capture pilot, and for the same reason: an ungrounded step poisons every
   * run of the case. Degrades silently when the agent role has no key.
   */
  authorReview: boolean;
  /**
   * Resolve the values a sheet leaves as tokens or descriptions before the
   * lints — from the case, the documents/repository, the database (read-only),
   * or, flagged, the generator (`generator/value-resolution.ts`). Default on;
   * `--no-value-resolution` / `WOWLIDATOR_VALUE_RESOLUTION=off` disables.
   */
  valueResolution: boolean;
  /**
   * In-run step reconstruction: a failed step is rebuilt by the repair model
   * against the live page and retried, up to 3 total tries, before final
   * classification. On by default (`--no-reconstruct` disables); degrades
   * silently when the generator role has no key.
   */
  reconstruct: boolean;
  /**
   * The workflow agent's early-give-up judges (look-only at 3 turns,
   * no-progress at 5). On by default (`--no-agent-early-stop` /
   * `WOWLIDATOR_AGENT_EARLY_STOP=off` turns them off, raising both ceilings to
   * AGENT_NO_PROGRESS_OFF_TURNS — the agent tries much longer before conceding
   * a leg). `undefined` lets the env default decide.
   */
  agentEarlyStop: boolean | undefined;
  captureDelayMs: number;
  /**
   * Pause before each step, ms. Undefined lets the runner decide: 1.5s while
   * filming for a viewer (`--video always`), zero otherwise. Set explicitly
   * (`--step-delay 1500` or `WOWLIDATOR_STEP_DELAY=1500`) to pace every run.
   */
  stepDelayMs: number | undefined;
  heal: boolean;
  agent: boolean;
  /**
   * Whether this run tests the backend at all (`--no-backend` turns it off).
   *
   * On (the default) the author may write HTTP and database steps, and a run
   * that needs a database must have one configured. Off, no backend step is
   * written: a claim that would have been settled against HTTP or the
   * database is settled through the PAGE, and the step carries a
   * `backendHint` saying what a backend check would have proved — so the
   * proof is honest about being the weaker of the two available.
   */
  backend: boolean;
  json: boolean;
  all: boolean;
  focus: string | undefined;
  maxCases: number;
  /** Explicit suite destination. Undefined means "put it with the reports". */
  suite: string | undefined;
  /** Explicit flow destination. Undefined means "put it with the reports". */
  flow: string | undefined;
  /** Page to ground `wowlidator author` against. */
  url: string | undefined;
  run: boolean;
  policy: MutationPolicy;
  updateBaselines: boolean;
  history: boolean;
  /** Where the append-only run index lives. Absolute; see `config.historyPath`. */
  historyPath: string;
  /** Include the repository context graph in `generate` prompts. Default off. */
  context: boolean;
  /**
   * Open the page's menus and disclosures before generating or authoring, so
   * controls that only exist after a click are visible to the model.
   */
  probe: boolean;
  /**
   * Also capture the page the DESCRIPTION is about, not only the page the run
   * starts on. Opt-in: it navigates the application under test, which is a
   * decision about someone's system — the `--probe`/`--agent-assist` rule.
   */
  captureJourney: boolean;
  /**
   * How far an authored test must reach — see `TestScope`. `e2e` is not a
   * hint: it turns the journey capture on whether or not `--capture-journey`
   * was passed, and `notEndToEnd` refuses a flow confined to one page.
   */
  scope: TestScope;
  /** How many links `wowlidator crawl` may follow. */
  maxPages: number | undefined;
  /** Healer calls allowed per link during a crawl. */
  maxHeal: number | undefined;
  /**
   * How many cases of a suite may run at once. Undefined takes
   * `DEFAULT_CONCURRENCY`; `1` restores the strictly sequential run this had
   * before, which is also the A/B test when a parallel result looks wrong.
   * A case that changes data runs alone whatever this says — see `caseWrites`.
   */
  concurrency: number | undefined;
  /**
   * How many catalog rows are authored at once (`--author-concurrency`).
   * Each worker reads the start page in its own tab; the per-row journey
   * capture was already in a context of its own. 1 authors rows one after
   * another, the A/B for a batched result that looks wrong.
   */
  authorConcurrency: number | undefined;
  /** Total authoring asks per row including the first (`--author-attempts`). */
  authorAttempts: number | undefined;
  /**
   * How far authoring may run ahead of the runs on a pipelined catalog
   * (`--author-lookahead`): the number of scenarios beyond the one currently
   * being run, `'all'` to author eagerly as before. Default 0 — authoring
   * holds at the running scenario (`ScenarioGate`).
   */
  authorLookahead: number | 'all' | undefined;
  /** Follow navigational buttons as well as links. Opt-in — see the crawler. */
  followButtons: boolean;
  /** Start or recycle a driveable Chrome before running. Default on. */
  ensureChrome: boolean;
  /** Profile for a browser wowlidator starts itself. */
  chromeProfile: string;
  /**
   * Run without a window. `undefined` means no preference was expressed, which
   * is not the same as `false`: a browser already running is left in whatever
   * mode it is in, rather than being restarted to acquire a window nobody asked
   * for. See `resolveHeadless`.
   */
  headless: boolean | undefined;
  /** Stop the browser afterwards, but only if this process started it. */
  stopChrome: boolean;
  /**
   * How many Chromes a parallel run spreads its lanes over (`--browsers`,
   * env `WOWLIDATOR_BROWSERS`). Undefined or 1 is the single browser on the
   * CDP port; n starts n-1 more on the ports after it, headless unless a
   * window was explicitly asked for. See `src/browser/pool.ts`.
   */
  browsers: number | undefined;
  /** Wait for this URL to answer before starting. */
  waitFor: string | undefined;
  /** Open the HTML report when the run finishes. */
  open: boolean;
  /** Per-navigation budget for a crawl, in ms. */
  timeoutMs: number | undefined;
  /** Whole-case ceiling for suite/catalog runs; zero disables it. */
  caseTimeoutMs?: number | undefined;
  /** `wowlidator watch` interval, e.g. "15m". */
  every: string | undefined;
  /** Command run on a result change, fed the verdict as JSON on stdin. */
  notify: string | undefined;
  /** Stop watching at the first failure. */
  untilFail: boolean;
  /** Report a known-flaky failure without counting it as one. */
  quarantineFlaky: boolean;
  /** Where to write JUnit XML for CI, if anywhere. */
  junit: string | undefined;
  /** Where to write CTRF JSON for CI, if anywhere. */
  ctrf: string | undefined;
  /** Stop after listing a catalog's claims, before anything is authored or run. */
  claimsOnly: boolean;
  /** Read approved claims from this file instead of extracting them again. */
  claims: string | undefined;
  /** Skip cases the claims file's progress ledger already has a verdict for; run the rest. */
  resume: boolean;
  /** Re-author and re-run every recorded case whose flow proves nothing about its claim. Implies `--resume`. */
  rerunVacuous: boolean;
  /** Re-run every recorded case the harness ended with an error (not a verdict about the app). Implies `--resume`. */
  rerunErrors: boolean;
  /** Rerun the plan from this case id onward, verdicts included. Implies resume. */
  resumeFrom?: string | undefined;
  /** Re-run every recorded failed / dead-end case, with autoheal on. Implies `--resume` and `--repair`. */
  rerunFailed: boolean;
  /** Re-author (from the sheet row) and re-run exactly these case ids, whatever their verdicts. Implies `--resume`. */
  rerunCases?: readonly string[] | undefined;
  /** Where `--claims-only` writes the claims it found. */
  claimsOut: string | undefined;
  /** Where `draft` writes the catalog it constructs. */
  catalogOut: string | undefined;
  /** Cap on cases drafted in one go. */
  maxDraftCases: number;
  /** Supporting documents — background for the model, never a source of claims. */
  contextDocs: string[];
  /**
   * The account an authored flow should sign in as. Absent means the model has
   * to invent one, which it does badly — see `parseCredentials`.
   */
  credentials: { email: string; password: string } | undefined;
  /**
   * Credentials by persona LABEL (`HR_ADMIN_ACCOUNT`, `MANAGER_ACCOUNT`,
   * `SPD_ADMIN`) — `--persona LABEL=email:password`, repeatable, and the
   * `WOWLIDATOR_PERSONAS` JSON map. A workbook row names its actors as
   * `<X_ACCOUNT>` tokens and role words; the label is what a flow file
   * carries, the credentials live only here and in the environment. `--as`
   * stays the unlabelled default a single-persona row falls back to. See
   * `parsePersonas`.
   */
  personas: Record<string, { email: string; password: string }>;
  /**
   * Author and run rows the sheet records as Blocked / Pending deploy /
   * Pending confirm — with their bug ticket — instead of refusing them at the
   * gate (`--include-blocked`). Off by default: a case the sheet's own testers
   * could not run fails against a known defect and files it again.
   */
  includeBlocked: boolean;
  /**
   * Slice a workbook catalog to these worksheets (`--sheet EC`, repeatable,
   * case-insensitive) — the module, in a QA tracker's terms. Empty = every
   * sheet. The claims file, the ledger and the report are then per slice.
   */
  sheets: string[];
  /** The same slice one level down: the sheet's Category column (`--category Hiring`). */
  categories: string[];
  /**
   * Characters of `--context-doc` background allowed in one prompt. `0` — the
   * default — sends every context document whole, which is what this did
   * before relevance selection existed.
   */
  contextBudget: number;
  /** Cap on claims read out of one catalog. */
  maxClaims: number;
  /** Project root to index for `context build`/`show` and `generate --context`. */
  root: string | undefined;
  /**
   * A saved repository (`context add`) to ground this run in, by slug or path.
   * Explicit selection: unknown values are a loud error, never a silent skip.
   */
  repo: string | undefined;
  /** Where the context graph is cached. */
  contextOut: string | undefined;
  /** Rebuild the context graph even if its signature is unchanged. */
  force: boolean;
  /**
   * Keep a suite's own list order instead of running readers before writers.
   * The reorder is the default because a suite that mutates state mid-run
   * invalidates its own remaining read-assertions — see `readersFirst`.
   */
  sheetOrder: boolean;
  /** `run`: on failure, ask AI to rewrite the flow and retry. Default off. */
  repair: boolean;
  /** Total attempts for `--repair`, including the first unmodified run. */
  repairAttempts: number;
  /** `--repair`: agent reinvestigates each failure live before a fix is asked for. */
  repairInvestigate: boolean;
  /** `--repair`: a fix may regenerate the failing section from the failed step onward. */
  repairRegenerate: boolean;
  /** OpenAPI/Swagger spec to index — a path or an http(s) URL. */
  openapi: string | undefined;
  /** Path of a schema.sql / schema.prisma for `context build --db-schema`. */
  dbSchema: string | undefined;
  /** `generate`: write API tests from the indexed spec instead of reading a page. */
  api: boolean;
  /** Watch the page's HTTP traffic over CDP. Default on. */
  network: boolean;
}

/**
 * Whether this run wants a window, and whether it cares.
 *
 * Three answers, not two. `undefined` — nobody said — is the default, and it is
 * why a browser you already have open is never restarted just to change how it
 * looks. Precedence is the usual one: flag, then environment, then no opinion.
 *
 * `WOWLIDATOR_HEADLESS=1` in the engine's `.env` is how you stop windows
 * appearing for good, rather than remembering a flag on every command. Same
 * place the provider keys and report paths live; the `grimval` wrapper needs no
 * variable of its own, because the engine owns its config.
 */
/** `--browsers` if given, otherwise `WOWLIDATOR_BROWSERS`, otherwise none. */
export function resolveBrowsers(flag: string | undefined): number | undefined {
  const raw = flag ?? process.env['WOWLIDATOR_BROWSERS'];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return undefined;
  return n;
}

export function resolveHeadless(flag: boolean, negated: boolean): boolean | undefined {
  if (flag) return true;
  if (negated) return false;
  const set = process.env['WOWLIDATOR_HEADLESS'];
  if (set === undefined || set === '') return undefined;
  return set !== '0' && set.toLowerCase() !== 'false';
}

/**
 * `--screenshots` if given, otherwise whatever the environment configured,
 * otherwise the default.
 *
 * The fallback used to be the literal default, which meant `WOWLIDATOR_SCREENSHOTS`
 * was accepted by `loadConfig`, documented in `.env.example`, and then silently
 * ignored by every CLI command.
 */
export function parseScreenshotMode(
  raw: string | undefined,
  configured: ScreenshotMode | undefined,
): ScreenshotMode | null | undefined {
  if (raw === undefined) return configured;
  // `auto` is how "unset" is said out loud. Without it there is no way to ask
  // for the video-aware default from a command line — and no way at all once
  // WOWLIDATOR_SCREENSHOTS is set in the environment, which is exactly where
  // someone would need to override back to the default for one run.
  if (raw === 'auto') return undefined;
  return (SCREENSHOT_MODES as readonly string[]).includes(raw) ? (raw as ScreenshotMode) : null;
}

/**
 * `--capture-delay` in milliseconds, on the same fallback ladder.
 *
 * Rejects rather than clamps: a delay is paid once per captured step, so
 * `--capture-delay 3000` on a hundred-step run is five minutes of waiting the
 * author probably did not mean to buy, and silently accepting a nonsense value
 * hides it until the run is already slow.
 */
export function parseCaptureDelay(raw: string | undefined, configured: number): number | null {
  if (raw === undefined) return configured;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0 || parsed > 30_000) {
    return null;
  }
  return parsed;
}

export function parseCaseTimeout(
  rawSeconds: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  if (rawSeconds !== undefined) {
    if (rawSeconds.trim().toLowerCase() === 'off') return 0;
    const seconds = Number(rawSeconds);
    if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds * 1_000 > 2_147_483_647) return null;
    return seconds * 1_000;
  }
  const rawMs = env['WOWLIDATOR_CASE_TIMEOUT_MS'];
  if (rawMs === undefined || rawMs.trim() === '') return DEFAULT_CASE_TIMEOUT_MS;
  if (rawMs.trim().toLowerCase() === 'off') return 0;
  const milliseconds = Number(rawMs);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 2_147_483_647) return null;
  return milliseconds;
}

/**
 * `--context-budget` in characters, then `WOWLIDATOR_CONTEXT_BUDGET`, then the
 * default.
 *
 * A number rather than a boolean on purpose. `--context` (the static
 * repository index) and `--context-doc` (background documents) are already
 * one flag apart from doing each other's job, and a third context-shaped
 * noun — `--no-context-retrieval`, `--full-context` — is how that hazard gets
 * worse. `0` says "send everything" without inventing one.
 *
 * Rejects rather than clamps, the `parseCaptureDelay` rule: a budget typed
 * wrong is either a prompt with no background in it or one with all of it, and
 * both are quieter than they should be.
 */
export function parseContextBudget(raw: string | undefined): number | null {
  const value = raw ?? process.env['WOWLIDATOR_CONTEXT_BUDGET'];
  if (value === undefined || value === '') return CONTEXT_BUDGET_CHARS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * `--as <email>:<password>`, then `WOWLIDATOR_AS`, then nothing.
 *
 * A model must never guess a secret, and measured over nine authoring runs it
 * guessed one every single time — `Password123!`, `password123` — because
 * nothing in the prompt could have told it otherwise. The cost is not
 * theoretical: one run died on "agent reported the goal is unreachable:
 * Sign-in failed with 'Incorrect password'", and a worse one reported 12/12
 * passed, having failed the login and then completed the journey on a session
 * a previous run had left behind. Real credentials live in the application's
 * own source (a demo-users module, a seed file) that no ingester reads, so the
 * only honest place for them to come from is the person running the command.
 *
 * Rejects rather than guesses, the `parseCaptureDelay` rule: a malformed pair
 * silently ignored would put us straight back to an invented password.
 *
 * Split on the FIRST colon only. A password may contain colons; an email may
 * not, so the first one is unambiguously the separator.
 */
export function parseCredentials(
  raw: string | undefined,
): { email: string; password: string } | null | undefined {
  const value = raw ?? process.env['WOWLIDATOR_AS'];
  if (value === undefined || value === '') return undefined;
  const at = value.indexOf(':');
  if (at < 0) return null;
  const email = value.slice(0, at).trim();
  const password = value.slice(at + 1);
  if (email === '' || password === '') return null;
  return { email, password };
}

/** A persona label as the map keys it: trimmed, the `<…>` of a sheet token stripped, upper-cased, spaces to `_`. */
export function personaLabelOf(raw: string): string {
  return raw.trim().replace(/^<|>$/g, '').trim().toUpperCase().replace(/[\s-]+/g, '_');
}

/**
 * `--persona LABEL=email:password` (repeatable), then the `WOWLIDATOR_PERSONAS`
 * JSON map (`{"HR_ADMIN_ACCOUNT":{"email":…,"password":…}}`), merged — a flag
 * outranks the environment for the same label. The same discipline as
 * `parseCredentials`: a malformed entry is refused with the reason, never
 * silently dropped, because a dropped persona puts the author straight back
 * to inventing the second account's password (CG-05: 98 rows hand off between
 * two people — an employee submits, a manager or HRBP approves — and until
 * now every second persona was a guessed password).
 *
 * Labels are normalised through `personaLabelOf`, so `--persona hr_admin_account=…`
 * and the sheet's `<HR_ADMIN_ACCOUNT>` meet. The split is on the FIRST `=`
 * (a label never contains one) and then the first `:` (an email never does).
 */
export function parsePersonas(
  raw: readonly string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; personas: Record<string, { email: string; password: string }> } | { ok: false; error: string } {
  const personas: Record<string, { email: string; password: string }> = {};
  const json = env['WOWLIDATOR_PERSONAS'];
  if (json !== undefined && json.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { ok: false, error: 'WOWLIDATOR_PERSONAS must be a JSON object: {"LABEL":{"email":"…","password":"…"}}' };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'WOWLIDATOR_PERSONAS must be a JSON object keyed by persona label' };
    }
    for (const [label, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as { email?: unknown; password?: unknown } | string | null;
      let email = '';
      let password = '';
      if (typeof entry === 'string') {
        const at = entry.indexOf(':');
        email = at < 0 ? '' : entry.slice(0, at).trim();
        password = at < 0 ? '' : entry.slice(at + 1);
      } else if (entry !== null && typeof entry === 'object') {
        email = typeof entry.email === 'string' ? entry.email.trim() : '';
        password = typeof entry.password === 'string' ? entry.password : '';
      }
      if (email === '' || password === '') {
        return { ok: false, error: `WOWLIDATOR_PERSONAS["${label}"] needs both "email" and "password"` };
      }
      personas[personaLabelOf(label)] = { email, password };
    }
  }
  for (const item of raw ?? []) {
    const eq = item.indexOf('=');
    if (eq <= 0) return { ok: false, error: `--persona must be LABEL=<email>:<password> (got "${item.split(':')[0] ?? item}")` };
    const label = personaLabelOf(item.slice(0, eq));
    const pair = parseCredentials(item.slice(eq + 1));
    if (pair === null || pair === undefined || label === '') {
      // Named by label only — never echo a value that may be a password.
      return { ok: false, error: `--persona ${label || '?'}=… must be LABEL=<email>:<password>, both halves present` };
    }
    personas[label] = pair;
  }
  return { ok: true, personas };
}

/**
 * The persona map as a record may carry it: labels to EMAILS. The password
 * rides the environment on purpose, the same rule as `SuiteLedger.launch.persona`.
 */
export function personaEmails(
  personas: Readonly<Record<string, { email: string; password: string }>>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(personas).map(([label, p]) => [label, p.email]));
}

/**
 * A label looked up tolerantly: as given, then with/without the sheet's
 * `_ACCOUNT` suffix (`<HR_ADMIN_ACCOUNT>` against `--persona HR_ADMIN=…`), so a
 * person is not made to spell the workbook's token to the letter.
 */
export function lookupPersona(
  personas: Readonly<Record<string, { email: string; password: string }>>,
  label: string,
): { email: string; password: string } | undefined {
  const key = personaLabelOf(label);
  return (
    personas[key] ??
    personas[key.replace(/_ACCOUNT$/, '')] ??
    personas[`${key}_ACCOUNT`] ??
    personas[key.replace(/_ACCOUNT$/, '').replace(/_/g, '')]
  );
}

/**
 * `--scope`, defaulting to `unit`.
 *
 * `unit` is the default because it is what authoring has always produced, and
 * a default that silently changed the shape of every existing invocation would
 * be wrong. Rejects rather than falling back, the `parseCaptureDelay` rule:
 * `--scope e2ee` quietly authoring a unit test is exactly the surprise this
 * flag exists to remove.
 */
export function parseScope(raw: string | undefined): TestScope | null {
  if (raw === undefined) return 'unit';
  return (TEST_SCOPES as readonly string[]).includes(raw) ? (raw as TestScope) : null;
}

/** Commands whose invocation is worth saving as a recallable preset. */
export const LAUNCH_COMMANDS = new Set(['run', 'generate', 'author', 'go', 'crawl', 'watch', 'catalog']);
