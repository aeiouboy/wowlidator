# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What wowlidator is

An in-house hybrid UI automation framework. The organising idea is **decoupled fast execution with JIT healing**: keep the hot path free and fast, and pay for intelligence only at the moment something breaks.

Two planes, and the boundary between them is the whole design:

- **Execution plane** (`src/engine/`) — plain Playwright over CDP, short timeouts, $0 per action.
- **Control plane** — an LLM, invoked only where determinism runs out:
  - `src/healer/` repairs a selector *after* it has already failed
  - `src/generator/` writes the tests in the first place by reading a page
  - `src/orchestrator/` drives the browser through unknown interstitials

  All three go through the **Vercel AI SDK** (`ai`), never a vendor SDK, so
  provider choice is config rather than code. Routing lives in `src/config.ts`;
  instantiation in `src/providers/llm-factory.ts`.

`src/api/` is a **second execution plane, not a second control plane**: HTTP the test makes deliberately, plus passive observation of what the page itself requests. It costs no tokens and calls no model — see [Backend testing](#backend-testing-srcapi) below.

`src/reporter/` turns a run into a standalone HTML report, and an MCP stdio server (`src/mcp/`) exposes the whole thing to developer tooling and to Claude. `src/context/` is a fourth, non-AI source the generator can optionally read from: a static index of the *project* (routes, components, existing tests, and — when a spec exists — API operations), as opposed to the one *page* the AX tree shows — see [Repository context engine](#repository-context-engine-srccontext) below.

**The rule that keeps this honest:** every control-plane module sits behind a small injectable interface — `HealerModel`, `GeneratorModel`, `AgentModel`. Each is one or two methods. That is what lets the entire test suite run offline, and it survived a full provider migration without a single call site changing shape. The `Llm*Model` classes are the only place a `LanguageModel` is constructed; nothing else imports a provider package.

## Commands

```bash
npm run ui            # the panel at /: runs, verdicts and the proof behind them, every command as a form, and the manual
npm run ui -- --wow   # the older wowUI layout at /wow, kept for side-by-side comparison
npm run cli -- go <flow.json | url | "what to test">   # one command, start to report
npm run cli -- catalog cases.xlsx --claims-only        # what does this document claim? no browser
npm run cli -- catalog cases.xlsx --claims c.json --url <page> --run   # prove the approved ones
npm run chrome        # start Chrome by hand (the CLI does this itself now)
npm test              # unit tests always; browser tests only if CDP is up
npm run typecheck     # src only (tsconfig.json)
npx tsc -p tsconfig.test.json --noEmit   # src + tests
npm run build         # emit dist/
npm run cli -- run examples/login.flow.json
npm run cli -- generate http://localhost:3000/some/page --run
npm run cli -- context build          # index the project into .wowlidator/context-graph.json, no model call
npm run cli -- run examples/login.flow.json --repair   # self-repair on failure, up to 3 attempts
npm run cli -- run login.flow.json --repair-investigate  # agent reinvestigates each failure live first
npm run cli -- run login.flow.json --repair-regenerate   # a fix may rewrite the flow from the failed step on
npm run cli -- context build --openapi ./openapi.yaml  # index endpoints alongside the code
npm run cli -- context build --db-schema ./schema.sql  # index tables too (or schema.prisma; with WOWLIDATOR_DB_URL set and no file, the live schema is introspected)
npm run cli -- catalog order.mmd --claims-only         # a sequence diagram is a catalog: one claim per message, no model call
npm run cli -- generate --api                          # write API tests from that spec (policy defaults to mutations; --policy forms|read-only to narrow)
npm run cli -- run checkout.api.json                   # browser-free: never opens Chrome
npm run cli -- report # rebuild each catalog run's HTML report + passed-cases Excel export from the ledgers on disk, no re-run
npm run cli -- db restore [<baseline.json>|<runKey>|<ledger.progress.json>]  # put the tables back to the run's pre-run snapshot (needs WOWLIDATOR_DB_RESTORE_URL)
npm run cli -- catalog cases.xlsx --sheet EC --category Hiring --run   # one worksheet / one Category column of a workbook
npm run cli -- catalog cases.xlsx --run --concurrency 8 --browsers 3   # parallel lanes spread over three Chromes
npm run cli -- catalog cases.xlsx --run --resume                       # continue a run that stopped short, under its run key (also --rerun-failed / --rerun-errors / --rerun-vacuous / --rerun-case <id>)
npm run cli -- run multi.flow.json --persona MANAGER=m@x.com:pw --no-headless --browsers 2  # one Chrome per person the flow signs in as
npm run cli -- doctor  # one real one-token call per role: the only proof a default model id still resolves
npm run mcp           # serve MCP over stdio
bin/wow <anything>    # engine + wowUI on one port; unknown subcommands pass straight through to the CLI
```

Single test:

```bash
npx tsx --test --test-name-pattern "heals a drifted" tests/smoke.test.ts
npx tsx --test --test-name-pattern "navigates two interstitials" tests/full-workflow.test.ts
```

There are ~100 files under `tests/`, one per subsystem, and every one uses the same tiering. The split rule, applied file by file: anything pure (parsers, renderers, verdicts, exports, the ladder's bookkeeping) runs always against scripted stubs; anything that is a fact about a real browser (accessible names, `fill` firing no per-key keydown, a `data:` video refusing to play, an overlay being gone before the next step) is CDP-gated. Two recurring rules worth knowing before adding a test: **a reader tested only against its own writer proves nothing** (so `tests/fixtures/` holds real `.xlsx`/`.pdf`/Playwright recordings, and the Excel writer is verified through `catalog/extract.ts`'s independent zip reader), and **"cannot run" and "should not run unasked" are different** (anything that kills Chrome or touches a real database is gated by an explicit env var, not auto-skipped). `tests/cli.test.ts` and `tests/mcp.test.ts` drive their targets as subprocesses because stdout purity is not observable in-process. Starting points: `smoke.test.ts` (cache, ladder, healer contract), `full-workflow.test.ts` (generation, agent, reporter), `tests/helpers.ts` (`jsonModel()` for mock models).

Test tiers, in cost order — all are opt-in by environment, nothing hidden:

| Tier | Runs when | Covers |
|---|---|---|
| Unit + contract | always | cache, proof bundle, config/routing, reporter, and all three AI SDK request shapes via `MockLanguageModelV4` ($0) |
| Browser | a CDP endpoint answers at `WOWLIDATOR_CDP_URL` (default `http://localhost:9222`) | the escalation ladder, multi-page navigation, screenshots, reporting |
| Live model | the **healer role's** provider key is set **and** CDP is up | whether a real free-tier model obeys the healing prompt |
| Shell | `WOWLIDATOR_SH_TESTS=1` | `wowlidator.sh` itself — start, stale-Chrome recovery, port propagation. Gated rather than auto-skipped because it starts and kills real Chrome processes: "cannot run" and "should not run unasked" are different things. |
| Chrome lifecycle | `WOWLIDATOR_CHROME_TESTS=1` | starting, recycling and refusing to touch someone else's browser. Gated for the same reason as the shell tier: it kills real Chrome processes. |
| Real application | `WOWLIDATOR_E2E_APP_URL` answers **and** CDP is up | the bug class fixtures cannot see. Both worst-ever defects — the Chrome/Playwright accessible-name divergence and the hydration race in a `hidden` condition — were invisible to every fixture and immediate against a real app. Assertions here are **invariants only** (a tree exists, captured names resolve, probing does not navigate); never business content, or the tier goes red when the app changes and people learn to ignore it. |

Skips are printed with the reason, so a green run that skipped the browser tier says so explicitly.

## The model-backed modules

| Role | Default provider | Invoked when | Interface to stub |
|---|---|---|---|
| `healer` (`healer/jit-healer.ts`) | Groq | a selector already failed | `HealerModel.suggest()` |
| `generator` (`generator/test-generator.ts`) | Google (Gemini) | you ask it to write tests | `GeneratorModel.generate()` |
| `orchestrator` → `agent` (`orchestrator/workflow-agent.ts`) | Groq | a `workflow` step runs | `AgentModel.decide()` |
| `data` (`data/data-model.ts`) | Groq | a `fillRetry` step's kind is `custom` | `DataModel.generate()` |
| `governor` (`orchestrator/queue-governor.ts`) | Groq | a handful of event-driven turns per *suite* | see `src/orchestrator/CLAUDE.md` |

Each role is matched to a tier's strength, not to a favourite vendor: repair is small and latency-sensitive (Groq is fastest), generation sends the biggest prompt in the system (Gemini has the largest free context), navigation is one small structured decision per turn (Groq again — the loop, not the model, owns the reasoning; OpenRouter remains the natural re-point for a stronger agent model), data regeneration is another small latency-sensitive call (Groq again). Every role is re-pointable with two env vars — see `.env.example`. `PROVIDERS` in `src/config.ts` is the live list (thirteen as of 2026-09, including the `claude-cli`/`claude-tty`/`claude-cloud` family that shells out to Claude Code rather than calling an HTTP API); `LLM_ROLES` is the live role list.

`data`'s deterministic kinds (`email`, `username`, `name`, `phone`, `text`) never actually touch a model — see `src/data/mock-data.ts`. Only `kind: 'custom'` reaches `data-model.ts`, which is why the role exists so escalation is *possible*, not so it's *routine*.

**Model ids are the most fragile thing in this repo.** They drift far faster than the code. `wowlidator doctor` makes a real one-token call per role and is the only way to know a default still resolves. Treat the values in `DEFAULT_ROLE_MODELS` as starting points, not facts.

Two layers, kept separate on purpose:
- `src/config.ts` — validates env into a `WowlidatorConfig`. No SDK imports. A bad provider name fails here with `ConfigError`, not 30 seconds into a run.
- `src/providers/llm-factory.ts` — turns a `RoleConfig` into an AI SDK `LanguageModel`, **lazily**. A run that never heals never demands a key. `generateStructured()` is the single `generateObject` call site; it wraps failures with the model label, because "which of my four free models can't do JSON schema" is the question you'll actually be asking.

Adding a fourth provider: one entry in `FACTORIES`, one string in `PROVIDERS`, one entry in `PROVIDER_META`. No call site moves.

**The agent owns its loop.** `AgentModel.decide()` returns exactly one action per call; `WorkflowAgent.run()` does observe → decide → act → repeat. This is not the SDK tool runner, and that is intentional: every turn needs budgeting, origin-checking, and screenshotting against live browser state, and a one-decision-per-turn seam is what makes the whole thing stubbable. Do not "upgrade" it to `client.beta.messages.toolRunner` without re-solving those four things.

Agent safety rails, all load-bearing:
- Stopping is judged by logic, not a turn count (2026-08-24; was a hard ceiling of 8, then 12): finish/fail, arriving at the goal's destination, a stall (an ok *page-changing* action repeated on an unchanged page — a repeated `wait`/`scroll` is let through instead, as a turn that advances nothing), `AGENT_NO_PROGRESS_TURNS` consecutive turns in which nothing advanced (failures and idle actions alike; five, since 2026-08-25 — three was tuned for an 8 s miss and became four times stricter once misses failed in 1.5 s), and a model failure each end the loop. A consent gate met on any turn — not only before the first — is cleared without a model turn and the agent returned to the page its goto asked for — and none of them can end a journey that is actually advancing. `maxSteps` / `WOWLIDATOR_AGENT_MAX_STEPS` reinstates a hard ceiling (the capture pilot keeps its own short one); `AgentRecord.maxSteps` is null when the run was unbounded.
- `allowedOrigins` — defaults to the origin it started on, so a confused agent cannot wander onto the public internet.
- **A destructive or authoritative click passes the mutation gate before the browser is touched** (2026-09-05, `src/orchestrator/mutation-policy.ts`): the row it scopes to must have been observed this session and be in the latest capture (a ledger fed only by the harness's own tree reads), the run's mutation policy must allow the category, and an irreversible one needs a pre-approved manifest entry or the host's explicit yes. A held action is a typed `blocked` outcome — no defect, the case scores blocked, exit 3. With no manifest, capability is unrestricted but irreversible actions still require explicit host approval. See `src/orchestrator/CLAUDE.md`.
- History is passed as a **snapshot** (`[...history]`). Passing the live array lets a model implementation observe mutations after the fact.
- `run()` never throws. Failure is reported in the record so the report can show what was attempted.

## Conventions and gotchas

- **The CLI is one entrypoint plus a package.** `src/cli.ts` keeps only what must stay at the bin path — the shebang, `main` (with the `ui` pre-`parseArgs` dispatch and the full option table), `cmdRecall`, and the test-facing re-exports (`EXIT`, `neverRan`, `suiteExit`, `exitCodeFor`, `classifyError`, `CaseOutcome`). Everything else lives in `src/cli/`: `usage.ts` (help text), `exit.ts` (the exit-code contract and suite verdicts), `options.ts` (`CliOptions` + flag parsing helpers), `runtime.ts` (model/logger builders, role gate), `artifacts.ts` (report/flow/Chrome side-effect helpers — `chromeStartedByUs` is module-private there on purpose; `growPool` adds Chromes on demand for personas), `run-cases.ts` (the shared suite loop), `case-plan.ts` (the pure scheduler: what may run beside what, `runQueue`, and the dependency gate `dependencyStanding` — a dependent waits for its prerequisite, runs only when it passed, and is `blocked` with the prerequisite's own outcome line otherwise; scenario-id references are linked by `linkDependencies` in `src/catalog/test-case-table.ts`; cycles and references to another sheet are printed once before the run), `sections.ts` + `data-locks.ts` (the parallelism rules: data sections per case, then step-level write locks), `suite-progress.ts` (the progress ledger that makes `--resume` possible), `catalog-live-report.ts` (the catalog report rewritten after every case), `pause.ts` (the suite-wide pause flag), and `commands/{run,authoring,maintenance,go}.ts`. Dependencies flow strictly downward; `commands/go.ts` is the only cross-family edge. **A dependent's verdict is correctness, so the gate lives in the deterministic scheduler, never in the governor** — the governor only observes and explains a wait (see `src/orchestrator/CLAUDE.md`).
- **CDP is connect-only.** `SmartRunner.connect()` calls `chromium.connectOverCDP` and never launches a browser. `close()` disconnects rather than killing Chrome, so a developer's browser survives a run. `SmartRunner.attach()` exists for embedders that own the browser lifecycle.
- **One Chrome per persona, a pool for parallel lanes** (2026-09-03). `--browsers <n>` spreads a parallel run over several Chromes (`src/browser/pool.ts`, each on its own profile and port), and a flow that signs in as several people gets a distinct pool member per person — `SmartRunner` keeps a `PersonaSession` per persona and re-points `page` on a hand-off, so a `signIn` is never preceded by a `signOut`. Sessions cross browsers as data (the suite session vault's `storageState`). A pool that falls short shares the least-loaded Chrome and says so as a note, never a verdict. Details in `src/browser/CLAUDE.md` and `src/engine/CLAUDE.md`.
- **The AX tree, not the DOM.** `captureAxTree` goes through a raw CDP session (`Accessibility.getFullAXTree`), not Playwright's deprecated `page.accessibility`. It prunes ignored nodes, structural noise, and unnamed non-interactive nodes, and caps at `DEFAULT_MAX_AX_NODES`. This is a token-budget decision — raising the cap raises the cost of every repair.
- **MCP owns stdout.** Anything written to stdout in `src/mcp/` corrupts the protocol stream. Diagnostics go to stderr.
- **`exactOptionalPropertyTypes` is on.** Optional properties need `?: T | undefined`, not `?: T`, wherever `undefined` may be assigned. This bites most often on `FlowStep.intent`.
- **`parseArgs` has no `--no-x` negation.** `--no-heal` and `--no-agent` are declared literally as the options `'no-heal'` / `'no-agent'` in `src/cli.ts`.
- **`types: ["node"]` is pinned in tsconfig.** Automatic `@types` discovery broke once the AI SDK dependency tree landed — every Node global vanished. Being explicit also stops unrelated `@types/*` leaking globals into the build. Don't remove it.
- **AI SDK provider-spec v4 shapes are nested** (the `ai` package itself is v7; the mock is `MockLanguageModelV4` from `ai/test`). `finishReason` is `{ unified, raw }`, not a string, and provider-level usage is `usage.inputTokens.total`, not a number. (The `generateObject` *result* flattens it back to `usage.inputTokens`.) `tests/helpers.ts` encapsulates this — build mocks with `jsonModel()` rather than hand-rolling the shape.
- **Fixture servers need `closeAllConnections()`.** Chrome holds keep-alive sockets; without it the test suite's `after` hook blocks for ~60s.
- **The panel runs `dist/cli.js`.** Jobs launched from `npm run ui` execute the built CLI, so an engine change needs `npm run build` before it shows up in a panel run; the panel's own UI is served from source and needs a server restart instead.
- **`bin/wow`** is the one-process launcher (engine + wowUI on one port) and passes unknown subcommands straight through to the CLI.
- Cache writes are temp-file + rename, and a corrupt cache file is reported to stderr and ignored rather than aborting a run.

## Where the subsystem guidance lives

The deep sections of this file moved (2026-08-24) into per-directory CLAUDE.md
files, loaded automatically when you work with files under that directory —
same authority as this file, just paid for only when relevant:

- `src/api/CLAUDE.md` — Backend testing; Sequence and database verification; the database baseline (snapshot → compare → restore), detected from the plan
- `src/browser/CLAUDE.md` — Browser lifecycle; the Chrome pool (`--browsers`) and one Chrome per persona
- `src/catalog/CLAUDE.md` — Catalogs; fastest scenario first; one row is one case; a scenario id is a name the table may hold
- `src/context/CLAUDE.md` — Understanding a page beyond its first render; The capture pilot; Retrieval and the token bill; Repository context engine; the database hint; what the generator actually knew, measured
- `src/coverage/CLAUDE.md` — UI coverage
- `src/crawl/CLAUDE.md` — Crawling
- `src/data/CLAUDE.md` — Mock data and `fillRetry`
- `src/engine/CLAUDE.md` — The escalation ladder; Composition and control flow; Scrolling and history; Modal and dialog detection; The agent rung; Losing the session; The session bootstrap and the suite session vault; Consent-gate recovery; Bare-role selectors; Accessible-name case; In-run step reconstruction; Keyboard and focus; the entry rung (put the value in, read it back); the step's target and the red rectangle; reconciliation as two readings; the film (every run keeps it, it performs like a person and cuts like an edit); a `signIn` allowed to stand on the sign-in page; the two-persona benchmark
- `src/generator/CLAUDE.md` — The authoring review; the suite's refusal memory; Authoring rails from a hand-authored comparison; Claim-fidelity rails; Negative testing; Boundary-value analysis; the tree's rendering, never the sheet's wording; code-grounded authoring; dead-end risk and error diagnosis; the Steps column is a script to perform (`scriptDemand`, `settleScriptDemand`); tokens are resolved, never typed (`value-rules.ts`); "only" means only (exclusivity); a persona hand-off is one `signIn`; the last word is a rewrite, not a refusal
- `src/healer/CLAUDE.md` — The healer's echo
- `src/history/CLAUDE.md` — Unattended runs and quarantine; Run history and flake detection
- `src/orchestrator/CLAUDE.md` — What the agent claims is never the evidence; the flow-file script rung; form-filling actions; `dbCount`; progress and stall judges; the queue governor and the dependency wait it explains but never decides; the off-page allowance and re-activation rails; the agent runs as whoever is active
- `src/providers/CLAUDE.md` — Structured output on free tiers; Prompt discipline
- `src/repair/CLAUDE.md` — Runtime script evolution
- `src/reporter/CLAUDE.md` — Reading the report; Proof bundles and the report; the catalog report and its live rewrite; the target on every step; a rescued step shows once
- `src/ui/CLAUDE.md` — The panel server; wowUI; the Ledger home page at `/`; the usage cap; the Database card; run gates; re-authoring and the work queue; personas asked for from the panel (the account is remembered, the password never is); the console reads the output, it does not rewrite it
- `src/visual/CLAUDE.md` — Visual regression

`src/db/` (baseline, client, redaction) is documented under `src/api/CLAUDE.md`; `src/cli/` under the bullet in Conventions above. Design specs and audits that predate a subsystem live in `docs/*-spec.md`.

## Repo-local tooling for Claude Code

- `.claude/skills/monitor` — `/monitor`: dumps the panel's job log and attributes a slow run to authoring, agent legs or the ladder. Its `joblog.mjs` is the fastest way to read timings.
- `.claude/skills/rebuild-beplan-db` — resets the local HRCenter-DEV `benefit_plan` table to the be100 QA baseline before a catalog run.
- `.claude/output-styles/asd-ste100.md` — an output style that holds every user-facing sentence to ASD-STE100 Simplified Technical English; code blocks are exempt.
- `.claude/agents/orchestrator-optimizer.md` — subagent for any change to the agent loop in `src/orchestrator/`; it enforces the "a claim is never evidence" rule.
- `.claude/agents/engine-expert.md` — subagent for any change to the execution plane in `src/engine/` (ladder rungs, selector rewrites, session/consent guards, reconstruction); it enforces "a rung may only fail identically or succeed against the right thing".
- `.claude/agents/provider-expert.md` — subagent for any change to the model layer in `src/providers/` and the provider half of `src/config.ts` (structured-output loop, breaker, claude-cli sessions, pacer, serial gate, usage cap); it enforces "a transport change may not alter what a model answers".
- `.claude/agents/ui-expert.md` — subagent for any change to the local surfaces in `src/ui/` (the panel server and its routes, the `commands.ts` whitelist and argv builder, `JobRunner`, the Ledger page and the wowUI script it composes, the proof/catalog-run projections, keys, models, checks, gates, uploads, the usage cap); it enforces "it runs the CLI, it does not reimplement it" and the no-credential/no-path-escape rules.
- `.claude/agents/reporter-expert.md` — subagent for any change to the reporting plane in `src/reporter/` (the verdict copy, the per-run and catalog HTML reports, the Excel proof workbooks, suite index, truth table, JUnit/CTRF, the GRIM theme, the shared step-fact projections); it enforces "every sentence is a pure function of the bundle" and the self-contained/escaped/no-credential rules, and routes a wrong status to the seal rather than relabelling it.
- `.claude/agents/generator-expert.md` — subagent for any change to the authoring plane in `src/generator/` (FlowAuthor prompt and lints, the informed re-ask, grounding audit/review, vacuity, exclusivity, value resolution, risk judge, error diagnosis, TestGenerator, ApiTestGenerator); it enforces "a claim is authored from evidence, never from wording", "feedback must never make the result worse", and the no-hardcode rule. The pre-optimisation author is kept as a reference artifact at `docs/artifacts/flow-author_original.ts`, outside `src/`, imported by nothing.
