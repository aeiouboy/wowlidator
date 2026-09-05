/**
 * A warm `claude` process, reused across calls.
 *
 * **Why this exists.** Measured 2026-08-26: a one-shot `claude -p` costs
 * 3.4–4.3 s of process startup before the model is even asked — Node boot,
 * config load, session setup — on every call, whatever the model or the
 * prompt. At roughly twenty calls to author and run one case, that is over a
 * minute of pure startup per case and the single largest fixed cost in a run.
 * Fed through `--input-format stream-json` instead, the same question comes
 * back in ~1.2 s: the startup is paid once and amortised over everything that
 * follows.
 *
 * **One process per role, not one per call.** The JSON schema is a launch
 * flag rather than a per-message field, so a warm process is locked to the
 * schema it was started with. That is less limiting than it first appears:
 * each ROLE asks one shape of question — the generator authors flows, the
 * healer proposes selectors, the agent decides one action — so a session
 * keyed by (model, effort, system prompt, schema) is in practice a session
 * per role, which is exactly the granularity wanted.
 *
 * **Three rules keep a long-lived process honest:**
 *
 *  - *Serial.* One question in flight at a time. The transport is a pipe with
 *    no request ids, so answers are matched by arrival order, and a second
 *    concurrent question would make that matching a guess.
 *  - *Recycled.* A session is conversational — every call adds to its
 *    context. After `MAX_TURNS_PER_SESSION` the process is retired and the
 *    next call starts a fresh one, which bounds context growth and pays one
 *    startup per forty calls rather than one per call.
 *  - *Disposable.* Any failure — a crash, a malformed line, a timeout — kills
 *    the session and reports upward, and the caller falls back to a one-shot
 *    call. A warm process is an optimisation; it must never become a new way
 *    for a run to fail.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';

import { answerErrorOf, usageOf, type ClaudeResultEvent } from './claude-envelope.js';

/**
 * How many questions one process answers before it is retired.
 *
 * Measured 2026-08-26 on real be100 calls: a session left to run to 40 turns
 * accumulated 700k-1.7M cached input tokens, and per-call wall time grew from
 * ~5s early in the session to 26-82s by turn 20-30 — cached tokens are cheap
 * in dollars but the model still attends over them, so a bloated session gets
 * slower call by call even though nothing else changed. Ten keeps the
 * attended context small enough that a call stays well under the 20s target
 * for the run's whole lifetime, at the cost of paying the ~1.2s warm-restart
 * more often (still far cheaper than the 3.4-4.3s cold-start it replaces).
 */
export const MAX_TURNS_PER_SESSION = 10;

/**
 * How many questions a **generator** session answers: one.
 *
 * Measured on be100-rip (2026-08-31): 143 of 190 generator asks did no tool
 * use at all (`turns: 0`) and still read **126,616 cached input tokens each**
 * — nine earlier rows' 26.5k prompts and answers, sitting in the session. Over
 * the run that was 21.7M cached-read tokens against ~5M of actual prompts, and
 * per-call wall sat at 42–57 s against the ~5 s this comment's own measurement
 * records for a fresh session.
 *
 * The difference from the healer and the agent is what a session is FOR. Those
 * roles hold a conversation about one page, and the earlier turns are the
 * context that makes the next answer good. Catalog authoring is the opposite:
 * every row is an independent question, and the nine rows before it are pure
 * cost and pure latency — the model still attends over them.
 *
 * One means a fresh process per row: the ~1.2 s warm restart, not the
 * 3.4–4.3 s cold start of the one-shot vector, because this is still the
 * stream-json path. `WOWLIDATOR_GENERATOR_SESSION_TURNS` dials it back up if
 * that restart ever costs more than the context it avoids.
 */
export const AUTHORING_TURNS_PER_SESSION = 1;

function envTurns(raw: string | undefined): number | null {
  const value = Number((raw ?? '').trim());
  return Number.isInteger(value) && value >= 1 && value <= 40 ? value : null;
}

/**
 * How many questions one process answers, for this role.
 *
 * Per-role because the roles want opposite things — see
 * `AUTHORING_TURNS_PER_SESSION`. `WOWLIDATOR_<ROLE>_SESSION_TURNS` overrides
 * one role, `WOWLIDATOR_SESSION_TURNS` overrides them all, and neither may
 * push a session past 40 turns (the bloat this whole mechanism exists to
 * bound).
 */
export function sessionTurnBudget(
  role: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const named = role === undefined ? null : envTurns(env[`WOWLIDATOR_${role.toUpperCase()}_SESSION_TURNS`]);
  if (named !== null) return named;
  const all = envTurns(env['WOWLIDATOR_SESSION_TURNS']);
  if (all !== null) return all;
  return role === 'generator' ? AUTHORING_TURNS_PER_SESSION : MAX_TURNS_PER_SESSION;
}
/** A session with nothing to do is closed rather than left holding a process. */
export const SESSION_IDLE_MS = 90_000;

function envMs(raw: string | undefined): number | null {
  const value = Number((raw ?? '').trim());
  return Number.isFinite(value) && value >= 60_000 ? Math.floor(value) : null;
}

/**
 * How long ONE answer may take, on either claude-cli vector.
 *
 * One constant for both, because the two used to differ and the difference
 * was paid for in full (multirole run, 2026-09-04, pid 34607): the warm
 * session gave up at 5 min on an authoring answer that was still arriving
 * (that run's answers were 17k–24.5k output tokens at 200–265 s), the
 * fallback re-sent the whole prompt as a cold one-shot with its own 10 min
 * budget, and that copy finished in 595.8 s — 24,487 tokens, one ledger row,
 * ~15 min and two payments for one answer. A timeout never fires on an
 * answer that arrives, so a longer one cannot slow a good call; a shorter
 * one than the answer needs is the most expensive outcome there is.
 * `WOWLIDATOR_CLAUDE_CLI_TIMEOUT_MS` overrides (minimum 60 s).
 */
export const CLAUDE_CLI_ANSWER_TIMEOUT_MS =
  envMs(process.env['WOWLIDATOR_CLAUDE_CLI_TIMEOUT_MS']) ?? 15 * 60_000;
/** No single answer may hang the run — the shared budget above. */
export const SESSION_ANSWER_TIMEOUT_MS = CLAUDE_CLI_ANSWER_TIMEOUT_MS;

export interface SessionAnswer {
  text: string;
  /**
   * The object the CLI validated against `--json-schema`, when the call had
   * one — the answer itself; `text` is its rendering. Undefined for a call
   * without a schema or an answer the model gave as plain text.
   */
  structuredOutput: unknown;
  /**
   * This call's OWN cost. The stream-json `result` event reports
   * `total_cost_usd` CUMULATIVELY for the session (measured 2026-08-27:
   * three identical questions reported 0.000754 / 0.001351 / 0.002015 —
   * constant deltas, climbing totals — while token usage stayed per-call),
   * so the session tracks the last total and reports the difference.
   * Before this, a 10-turn session's summed ledger rows over-reported spend
   * ~5×, and cost-guard.sh kills runs against exactly that number.
   */
  costUsd: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /**
   * Model turns this answer took (delta of the event's cumulative
   * `num_turns`). A `--json-schema` answer is a tool call and so takes TWO
   * turns by itself (measured on CLI 2.1.260, 2026-09-04 — `stop_reason:
   * "tool_use"`, `num_turns: 2` for a three-item answer with no tools); a
   * plain-text answer takes one. Anything above that is real tool use — the
   * only signal that the BM25 `search_context` tool was actually consulted.
   */
  turns: number;
}

export interface SessionKey {
  binary: string;
  /** Where the process runs — a directory with no CLAUDE.md. See `claude-cli.ts`. */
  cwd: string;
  modelId: string;
  effort: string;
  system: string;
  /** The JSON schema as a string, or null when the session takes none. */
  schema: string | null;
  tools?: string | null;
  allowedTools?: string | null;
  disallowedTools?: string | null;
  /** Inline `--mcp-config` JSON (the BM25 retrieval server), or null for none. */
  mcpConfig?: string | null;
  /**
   * The CLI's output cap for this process (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`),
   * or null to leave the operator's environment alone. An environment
   * variable is a launch property, so it is part of the identity: a re-ask
   * at a raised cap must never land on a pooled process still holding the
   * old one.
   */
  maxOutputTokens?: number | null;
}

/** Stable identity for a session's launch flags — the same flags reuse a process. */
export function sessionKeyOf(key: SessionKey): string {
  return createHash('sha1')
    .update(
      [
        key.binary,
        key.cwd,
        key.modelId,
        key.effort,
        key.system,
        key.schema ?? '',
        key.tools ?? '',
        key.allowedTools ?? '',
        key.disallowedTools ?? '',
        key.mcpConfig ?? '',
        key.maxOutputTokens === undefined || key.maxOutputTokens === null ? '' : String(key.maxOutputTokens),
      ].join(' '),
    )
    .digest('hex');
}

class ClaudeSession {
  readonly #child: ChildProcess;
  #buffer = '';
  #turns = 0;
  #closed = false;
  /** Last cumulative `total_cost_usd` seen — see `SessionAnswer.costUsd`. */
  #lastCostUsd = 0;
  /** Last cumulative `num_turns` seen, same delta rule as the cost. */
  #lastNumTurns = 0;
  #idleTimer: NodeJS.Timeout | null = null;
  /** The question in flight, if any. Serial by construction — see the header. */
  #pending: {
    resolve: (answer: SessionAnswer) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  constructor(key: SessionKey) {
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      // stream-json output requires it; without it the CLI refuses to start.
      '--verbose',
      '--model',
      key.modelId,
      '--effort',
      key.effort,
      '--system-prompt',
      key.system === ''
        ? 'You answer exactly what is asked, with no preamble and no commentary.'
        : key.system,
      '--strict-mcp-config',
      // In step with the one-shot vector in `claude-cli.ts` (see the note
      // there): no settings/hooks/skills at boot, no transcript on disk.
      '--setting-sources',
      '',
      '--disable-slash-commands',
      '--no-session-persistence',
      // `=` form: variadic flags with an empty space-separated value would
      // swallow whatever follows — same rule as the one-shot vector.
      ...(key.tools !== undefined && key.tools !== null ? [`--tools=${key.tools}`] : []),
      ...(key.allowedTools !== undefined && key.allowedTools !== null ? [`--allowed-tools=${key.allowedTools}`] : []),
      ...(key.disallowedTools !== undefined && key.disallowedTools !== null ? [`--disallowed-tools=${key.disallowedTools}`] : []),
      ...(key.mcpConfig !== undefined && key.mcpConfig !== null ? [`--mcp-config=${key.mcpConfig}`] : []),
      ...(key.schema === null ? [] : ['--json-schema', key.schema]),
    ];
    this.#child = spawn(key.binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: key.cwd,
      // Startup network (version check, telemetry) is the enemy this warm
      // process exists to amortise — turn it off outright.
      env: {
        ...process.env,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ...(key.maxOutputTokens === undefined || key.maxOutputTokens === null
          ? {}
          : { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(key.maxOutputTokens) }),
      },
    });
    this.#child.stdout?.on('data', (chunk: Buffer) => this.#onData(chunk.toString()));
    // A dead process must fail the question it was holding, not hang it.
    this.#child.on('exit', () => this.#die(new Error('the claude session exited')));
    this.#child.on('error', (error: unknown) =>
      this.#die(error instanceof Error ? error : new Error(String(error))),
    );
    // stderr is drained so the pipe cannot fill and wedge the child.
    this.#child.stderr?.on('data', () => undefined);
  }

  /** Questions this process has already been asked. */
  get turnsTaken(): number {
    return this.#turns;
  }

  /**
   * True while this process can still take another question under the
   * CALLER's turn budget. The budget belongs to the ask, not to the process:
   * it is a policy about what kind of question this is (see
   * `sessionTurnBudget`), and a process spawned for one role is only ever
   * reused by that role, because the role's system prompt is part of the
   * session key.
   */
  usableFor(maxTurns: number): boolean {
    return !this.#closed && this.#turns < maxTurns && this.#pending === null;
  }

  /** True while this process could still take a question under ANY budget — for pruning. */
  get spent(): boolean {
    return this.#closed || this.#turns >= MAX_TURNS_PER_SESSION;
  }

  /** True while a question is in flight — a busy session must never be closed. */
  get busy(): boolean {
    return this.#pending !== null;
  }

  ask(text: string): Promise<SessionAnswer> {
    if (this.#closed) return Promise.reject(new Error('the claude session is closed'));
    if (this.#pending !== null) {
      return Promise.reject(new Error('the claude session is already answering'));
    }
    this.#clearIdle();
    this.#turns += 1;
    return new Promise<SessionAnswer>((resolve, reject) => {
      const timer = setTimeout(
        () => this.#die(new Error(`no answer within ${SESSION_ANSWER_TIMEOUT_MS} ms`)),
        SESSION_ANSWER_TIMEOUT_MS,
      );
      this.#pending = { resolve, reject, timer };
      const message = {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      };
      this.#child.stdin?.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) this.#die(error);
      });
    });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const at = this.#buffer.indexOf('\n');
      if (at < 0) break;
      const line = this.#buffer.slice(0, at);
      this.#buffer = this.#buffer.slice(at + 1);
      if (line.trim() === '') continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // A line that is not JSON is the CLI talking to a human, not to us.
        continue;
      }
      if (event['type'] !== 'result') continue;
      const held = this.#pending;
      if (held === null) continue; // an answer nobody is waiting for
      this.#pending = null;
      clearTimeout(held.timer);
      this.#startIdle();
      // Cumulative-to-delta for the session-scoped counters; usage is
      // already per-call. See `SessionAnswer.costUsd`. Computed BEFORE the
      // error branch: a failed answer spent real tokens (its thinking is
      // billed), and that spend belongs in the ledger either way.
      const totalCost = Number(event['total_cost_usd'] ?? 0);
      const costUsd = Math.max(0, totalCost - this.#lastCostUsd);
      this.#lastCostUsd = totalCost;
      const totalTurns = Number(event['num_turns'] ?? 0);
      const turns = Math.max(0, totalTurns - this.#lastNumTurns);
      this.#lastNumTurns = totalTurns;
      const spent = usageOf(event as ClaudeResultEvent, costUsd, turns);
      if (event['is_error'] === true) {
        // The CLI ANSWERED, and the answer is a failure — a cut at its output
        // cap, an API error it already retried. That is not a dead pipe:
        // the typed error tells the caller not to re-send the identical
        // request cold (measured 2026-09-04: the cold copy hits the same cap
        // and pays the whole prompt again). See `claude-envelope.ts`.
        held.reject(answerErrorOf(event as ClaudeResultEvent, spent));
        continue;
      }
      held.resolve({
        text: String(event['result'] ?? ''),
        structuredOutput: event['structured_output'],
        costUsd,
        inputTokens: spent.inputTokens,
        cachedInputTokens: spent.cachedInputTokens,
        cacheWriteTokens: spent.cacheWriteTokens,
        outputTokens: spent.outputTokens,
        turns,
      });
    }
  }

  #startIdle(): void {
    this.#clearIdle();
    this.#idleTimer = setTimeout(() => this.close(), SESSION_IDLE_MS);
    // Never hold the process open on this timer alone.
    this.#idleTimer.unref?.();
  }

  #clearIdle(): void {
    if (this.#idleTimer !== null) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }

  #die(error: Error): void {
    const held = this.#pending;
    this.#pending = null;
    this.#closed = true;
    this.#clearIdle();
    if (held !== null) {
      clearTimeout(held.timer);
      held.reject(error);
    }
    this.#child.kill();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearIdle();
    this.#child.stdin?.end();
    this.#child.kill();
  }
}

/**
 * How many warm processes one launch-flag identity may hold at once.
 *
 * One is not enough: catalog authoring runs `DEFAULT_AUTHOR_CONCURRENCY` (3)
 * rows in parallel, all on the generator's one key, and the old single-slot
 * map CLOSED the busy session to make room — killing another worker's
 * in-flight question, which then fell back to a cold one-shot re-paying the
 * whole prompt (measured live 2026-08-27: a 217 s cold authoring call in the
 * middle of two overlapping warm ones). Sized to the author concurrency plus
 * one for a heal arriving mid-authoring; past the cap the caller gets a
 * rejection and takes the one-shot path, which is the honest overflow.
 */
export const MAX_SESSIONS_PER_KEY = 4;

/**
 * The live cap — the constant is the floor, and a suite that runs more lanes
 * raises it to `concurrency + 1` (docs/parallel-run-spec.md, defect #5): the
 * fifth concurrent ask used to fall to a cold one-shot at 217 s, which is the
 * exact bill parallelism exists to avoid. Never lowered below the default —
 * shrinking under live sessions would re-create the closed-busy-session bug.
 */
let sessionCap = MAX_SESSIONS_PER_KEY;

export function raiseSessionCapFor(concurrency: number): void {
  sessionCap = Math.max(MAX_SESSIONS_PER_KEY, Math.floor(concurrency) + 1);
}

export function currentSessionCap(): number {
  return sessionCap;
}

/** Live session pools by launch-flag identity. */
const sessions = new Map<string, ClaudeSession[]>();

/**
 * Ask a warm process, starting one if none is free.
 *
 * A busy session is NEVER closed here — it is answering someone else. A
 * retired or dead idle session is pruned; a free one is reused; a new one is
 * spawned while the pool is under `MAX_SESSIONS_PER_KEY`.
 *
 * Rejects on any transport failure so the caller can fall back to a one-shot
 * call — the warm path is an optimisation and must never be the reason a run
 * fails.
 */
export async function askWarm(
  key: SessionKey,
  text: string,
  /**
   * How many questions this process may answer, from `sessionTurnBudget`.
   * Defaults to the old global bound so an unattributed caller is unchanged.
   */
  maxTurns: number = MAX_TURNS_PER_SESSION,
): Promise<SessionAnswer> {
  const id = sessionKeyOf(key);
  let pool = sessions.get(id);
  if (pool === undefined) {
    pool = [];
    sessions.set(id, pool);
  }
  // Prune sessions that are done for (retired at the turn budget, or dead)
  // and idle. Busy ones stay whatever their state — their caller is owed an
  // answer, and `usableFor` already keeps new questions off them.
  //
  // Pruning uses `spent` (the global bound), not this ask's budget: a session
  // this ask may not reuse is not necessarily rubbish. Under a budget of one
  // that distinction is academic, but it keeps a mixed pool honest — killing
  // another role's still-good process to satisfy this one's policy is the
  // closed-busy-session bug in a new hat.
  for (let at = pool.length - 1; at >= 0; at -= 1) {
    const held = pool[at] as ClaudeSession;
    if (held.spent && !held.busy) {
      held.close();
      pool.splice(at, 1);
    }
  }
  let session = pool.find((candidate) => candidate.usableFor(maxTurns));
  if (session === undefined) {
    if (pool.length >= currentSessionCap()) {
      // The pool is full of processes this ask cannot reuse. One that is
      // idle and merely over THIS ask's budget (a one-turn authoring session
      // that has answered, waiting out its 90 s idle timer) is a slot, not a
      // worker: close it and take its place. Measured live (2026-09-05,
      // eight authors on a cap of nine): 91 of 407 authoring asks fell to
      // the cold one-shot path — +24 s and a full prompt re-sent each — while
      // the pool held finished sessions that no ask could use. A busy one is
      // still never touched.
      const stale = pool.findIndex((candidate) => !candidate.busy && !candidate.usableFor(maxTurns));
      if (stale < 0) {
        throw new Error(
          `all ${currentSessionCap()} warm claude sessions for this key are busy`,
        );
      }
      (pool[stale] as ClaudeSession).close();
      pool.splice(stale, 1);
    }
    session = new ClaudeSession(key);
    pool.push(session);
  }
  try {
    return await session.ask(text);
  } catch (error) {
    session.close();
    const at = pool.indexOf(session);
    if (at >= 0) pool.splice(at, 1);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/** Close every warm process. Safe to call twice. */
export function closeClaudeSessions(): void {
  for (const pool of sessions.values()) {
    for (const session of pool) session.close();
  }
  sessions.clear();
}
