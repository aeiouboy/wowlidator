# External survey: LLM-driven UI test agents and self-healing (as of 2026-09-05)

Scope: what current tools and papers do that wowlidator does not yet, mapped to the five live pain points:
P1 authoring cost (6–13 retrieval turns per row, ~40% lint re-asks) · P2 a turn cap killed a 9-section wizard · P3 test data given as codes while the UI shows names · P4 a picker that loads 500 rows so valid data is unreachable · P5 verdicts that say "system error" where the truth is "application limitation" or "spec not deployed here".

Method: primary docs, papers and repos fetched 2026-09-05; vendor blogs used only where marked. Anything I could not open from a primary source is marked **unverified**.

## What wowlidator already does that matches the state of the art (no gap)

- "A claim is never evidence" — Anthropic's computer-use docs say the same thing ("Claude sometimes assumes outcomes of its actions without explicitly checking… take a screenshot and carefully evaluate"), and the evaluation literature (WebJudge, AgentRewardBench) judges trajectories from screenshots and action history, never from the agent's final text. wowlidator's `goalOutcome`/`outcomeShown`/`settledBy` and the provenance ledger are ahead of every commercial tool I could read.
- AX tree over raw DOM, pruned — Agent-E (2024) and AgentOccam (ICLR 2025) both report that distilling the observation is worth more than a bigger model.
- Stable-prefix prompt caching (`agentContract` memoised) — exactly what Anthropic's caching docs prescribe (tools → system → messages hierarchy; a changed tool definition invalidates everything).
- A typed `blocked` outcome and a mutation gate — safety benchmarks (ST-WebAgentBench) treat side effects as a first-class axis; AgentRewardBench annotates "side effects" per trajectory.

## Findings

### F1. Induce reusable workflows from successful runs, and let strong-model journeys be replayed by cheap models

**Idea.** Keep a library of *abstracted* sub-routines induced from the agent's own successful trajectories (parameters stripped out), retrieve them by goal similarity, and feed them into the prompt. Skills authored by a strong model transfer to a weak one.

**Who.** Agent Workflow Memory (Wang et al., ICML 2025, arXiv 2409.07429): online mode "induces workflows from test queries on the fly"; +24.6% / +51.1% relative success on Mind2Web / WebArena "while reducing the number of steps"; +8.9 to +14.0 absolute points as the train–test gap widens. SkillWeaver (OSU, arXiv 2504.07079): skills synthesised as Python APIs, +31.8% (WebArena) / +39.8% (real sites) relative; "APIs synthesized by strong agents substantially enhance weaker agents… up to 54.3%". ReasoningBank (Google, ICLR 2026, arXiv 2509.25140): stores strategies distilled from *both* successes and failures. Commercially: Skyvern code caching ("records the actions an AI run takes and generates executable code… subsequent runs execute the cached code directly… if the cached code hits something unexpected… re-runs with the full agent and regenerates the cache"; vendor claim "up to 70% cheaper", unverified); Stagehand v3 caching (key = instruction + page content + options; a hit skips inference; no self-heal, any content change misses).

**Where wowlidator is today.** `AgentMemory` replays a journey keyed by exact `(startUrl, goal, persona)`; the flow-file `script` rung; `AGENT_SKILLS` are hand-written tactics selected per leg. None of these *generalise*: HIR-EC-001's wizard journey is not available to HIR-EC-002…029, and a row re-authored from scratch pays the full retrieval every time.

**Mapping.** (a) `src/orchestrator/agent-skills.ts`: add *induced* skills — after a leg passes, abstract `scriptOf(record.actions)` (values → `{{field}}` slots, ids → `{{id}}`) and store under a goal-shape key; `selectSkills` retrieves by BM25 over goal + first tree, appended under `GUIDANCE FOR THIS GOAL` like today's skills. (b) `AgentMemory.replayKey`: a second, fuzzy lookup (same start path pattern + same goal shape) that offers the abstracted script as a *hint*, not a replay — the replay's re-grounding rule stays. (c) `src/generator/flow-author.ts` / `authorEachRow`: a **row template** rung before the model — when a sibling row of the same sheet (same Steps skeleton, `caseIdShape`) already has a passing flow, substitute the new row's Test data pairs into it, run the $0 lints, and call the model only for the diff (the lints already know which steps are ungrounded). ReasoningBank's point applies to the suite refusal memory: keep *why* legs failed too.

**Benefit.** P1 (most rows in a catalog are siblings; the template rung can be $0 for them), P2 (a wizard journey learned once is a skill, so later legs spend turns only on what differs).

**Confidence.** High that the mechanism works on benchmarks (three peer-reviewed papers agree on direction and rough size). Medium on transfer to a catalog of Thai HR rows — no paper measured a QA setting; the "strong→weak transfer" result is the most load-bearing for wowlidator's opus-author/groq-agent split and is from one paper.

### F2. Classify every non-pass into bug / intentional change / test-setup / environment / transient, and make "not testable here" a first-class outcome

**Idea.** A failure is triaged before it reaches a person; "real bug" alerts are high-signal because everything else was named as something else.

**Who.** Momentic (blog, 2026-06-24): a "Failure Classification Agent" decides "real bug, intentional application change, test setup issue, or transient error"; an intentional change opens a PR that fixes the *test*; a real bug alerts with context. No accuracy numbers published. mabl (product page): "Autonomously triage all failures for immediate root cause insights"; secondary sources name the classes real regression / app change / environment noise. Octomind (categories app bug / selector change / slow page load / broken dependency / flaky — from a secondary knowledge-base page; octomind.dev did not resolve on 2026-09-05, consistent with the reported May-2026 discontinuation; **unverified**). Playwright's healer lists "locator update, wait adjustment, data fix" as patch kinds — i.e. data is a recognised failure origin.

**Where wowlidator is today.** `error-diagnosis.ts` already has five origins (test-catalog / generator / agent / environment / application) — but only for `status === 'error'`, as a note, and the report headline stays "system error". `specQuestion` marks a needs-review whose disputed values quote the sheet. There is no outcome for "the feature is not deployed in this environment" or "the app cannot do this (picker caps at 500 rows)".

**Mapping.** (a) `src/generator/error-diagnosis.ts`: two new origins with $0 signals — `not-deployed` (the route/control is declared by the repo index *and* by the sheet, absent from every tree captured in this environment, and the 404/absent signature repeats across sibling rows) and `application-limitation` (the target is reachable only through a control the run proved bounded: a picker that stops paging, a search box absent from the tree — the PL_07 filter case). (b) Run the diagnosis on `failed` verdicts whose failing step is an *absence* (`could not resolve`, 404, `expectVisible` miss on a truncated list), not only on errors — with the existing rule that it never reclassifies a pass/fail, but it may promote to a typed outcome. (c) `src/cli/exit.ts` + `src/reporter`: a `not-testable-here` outcome beside `blocked` (exit 3 family), headline copy "spec not deployed in this environment / application limitation", the diagnosis reasons as the callout. The sheet gate already does this at authoring time from the Note column; this is the runtime half.

**Benefit.** P5 directly; P4 (the 500-row picker becomes an application-limitation verdict with the evidence, not a system error).

**Confidence.** Medium. The category set is industry-standard and the architecture is the one every vendor converged on, but nobody publishes precision for the classifier; wowlidator's advantage is that its signals can be deterministic (repo index + trees), where vendors use a model.

### F3. Budget long forms by milestone, batch form entries per turn, and treat "the page changed" as the progress signal

**Idea.** Long compositional forms are the known hard case for agents; the fixes that work are (i) per-step ground truth about what changed, (ii) several field entries per decision, (iii) budgets per sub-goal rather than one cap for the journey.

**Who.** Agent-E (Emergence, arXiv 2407.13032): "change observation" — every skill returns the DOM mutations it caused (MutationObserver) "so the LLM can judge if the skill executed properly"; 73.2% on WebVoyager. Anthropic computer-use docs: "After each step, take a screenshot and carefully evaluate…"; the sample loop bounds `max_iterations` (10 default) and the docs say to attach a screenshot to the last result of a batch so the model "always sees the current state". Browser Use agent parameters: `max_actions_per_step` default 4 "e.g. for form filling the agent can output 4 fields at once", `max_failures` 3 *per step* (retries are local, not global), `step_timeout` 120 s. WorkArena++ (ServiceNow, NeurIPS 2024 D&B): 682 compositional enterprise tasks; secondary sources report humans ≈94% vs GPT-4o ≈2% and horizons up to 50 steps (**numbers unverified from the abstract**; the abstract says only that the tasks "reveal several challenges").

**Where wowlidator is today.** The loop already has tree-change credits, `reactivation`, the off-page allowance and a no-progress judge, and the agent can plan follow-up steps. The turn cap that killed the wizard is a *global* ceiling on one leg; nothing counts "section 3 of 9 completed" as progress, and the author writes a 9-section wizard as one goal.

**Mapping.** (a) `src/generator/flow-author.ts`: a lint + `settle` — a script whose Steps enumerate sections/tabs the tree shows as headings or `tab`s must be authored as one leg per section (or deterministic entry steps via `settleScriptDemand`), each ending with the section's own observable (next heading visible, step indicator advanced). (b) `src/orchestrator/workflow-agent.ts`: a **milestone budget** — the goal's numbered sub-goals (or the wizard's section headings read from the first tree) each get `AGENT_MILESTONE_TURNS`; reaching a milestone (heading/`?step=` change) resets the local budget and is logged as `milestone k/n`; the global cap becomes n × per-section, not a flat 15/60. (c) Report the mutation diff after each action in the history line (Agent-E's change observation) — wowlidator has `appeared` at step level; per-action `appeared/disappeared` at $0 would let the model stop re-clicking.

**Benefit.** P2 (a 9-section wizard is 9 budgets), and fewer wasted turns on P3/P4 pickers.

**Confidence.** Medium-high on the ingredients (Agent-E's mechanism and Browser Use's defaults are primary); the milestone-budget composition is my synthesis, not something a source measured.

### F4. Ground test data to the UI's option set: enumerate first, then match; codes resolve to labels through the schema

**Idea.** Dropdowns and pickers are where form agents fail most; the working pattern is a cheap "list the options" step followed by a match, with the code→label mapping resolved outside the model.

**Who.** Browser Use ships `dropdown_options` ("Get dropdown option values") and `select_dropdown` as separate tools. FormFactory (arXiv 2506.01520, June 2025): "no model surpasses 5% accuracy"; failures attributed to "field-value alignment"; the HTML version reports dropdown/checkbox performance near zero (**from a search summary, not verified in the abstract**). WebSuite (arXiv 2406.01623): one agent "entirely unable to complete select interactions", 0% on complex forms. "Detecting Pipeline Failures…" (arXiv 2509.14382): selection accuracy falls as candidate count grows (secondary summary quotes 73.1% with two candidates → 56.0% with four; **unverified**). Anthropic computer-use docs: dropdowns "might be tricky… try prompting the model to use keyboard shortcuts".

**Where wowlidator is today.** `selectOption` picks by visible label (native or custom listbox), `read` reports a control's value, `value-resolution.ts` resolves tokens from test data / repo / db / generated, and `value-rules.ts` holds the vocabulary. A code in the sheet (`Work Schedule = D05H0830`, `Employee Sub Group = 10`) is typed as written; the UI shows names; the picker shows 500 of N.

**Mapping.** (a) `src/generator/value-resolution.ts`: a **code→label** rung for `selectOption` values — same table the db rung already introspects: when the target column is a code column and the table has a name/label column, fetch both and record `valueSource.kind = 'code→label'` with the pair; without a DB, the repo's message catalogs / enum files (already in the context graph) are the second source. (b) `src/engine` selectOption rung order: label → code → *type-to-filter then pick* (the picker's own search box, matched by role from the tree) — the 500-row cap is defeated by filtering, not scrolling. (c) `AGENT_ACTIONS`: `readOptions` (idle, $0): open the control, dump its options (or the first page plus "N more, has search: yes/no") into the history — Browser Use's `dropdown_options`. (d) When neither label nor code nor filter reaches the value, the outcome is F2's `application-limitation`, with the option count and the absent search control as evidence.

**Benefit.** P3, P4.

**Confidence.** High that this is the dominant form-agent failure (three independent papers); medium on the specific rung order — the DB code→label mapping depends on the HR schema actually holding the label column.

### F5. Judge outcomes from key points and key screenshots, and record side effects and repetition as verdict axes

**Idea.** An LLM judge is reliable enough to be a *second opinion* when it (1) extracts checkable key points from the task before looking, (2) selects the few screenshots that bear on them, (3) judges from those plus the action history — and reports its own success-rate gap to humans.

**Who.** WebJudge / Online-Mind2Web (OSU, COLM 2025, arXiv 2504.01382): three stages exactly as above; 85.7% agreement with humans (o4-mini), WebJudge-7B 87%, "low success rate gap (3.8%)". Browser Use (blog 2026-02-23): judge built into the agent loop as a validation layer, 87% alignment with hand labels, outputs `{verdict, reasoning, failure category}`. AgentRewardBench (McGill, arXiv 2504.08942): 1,302 expert-labelled trajectories for success, **side effects** and **repetitiveness**; "no single LLM excels across all benchmarks"; rule-based checks "underreport" success.

**Where wowlidator is today.** `runFlow`'s auto-review judge exists and is (rightly) withheld when it contradicts the sheet's Actual Result. Key points are implicit in `expectedItemsIn`.

**Mapping.** (a) Make the Expected column's numbered items the explicit key-point list on the bundle (`bundle.keyPoints`), each linked to the step(s) that assert it — the coverage lint already computes this. (b) `src/reporter` + the review judge: select key screenshots by those links (the step's target screenshot, the film moment) and hand the judge only those — cheaper and closer to WebJudge's method than a whole trajectory. (c) Add `sideEffects` (mutations performed, from the provenance/mutation ledger) and `repetition` (the reactivation counts) as report columns — both already computed, neither surfaced as a verdict axis.

**Benefit.** P5 (a needs-review that states which key point lacks evidence), and it is the instrument F9's benchmark needs.

**Confidence.** High on the method and its agreement numbers (peer-reviewed); medium on cost — one judge call per non-pass case.

### F6. Cut authoring cost with pre-fed retrieval, $0 settle-before-re-ask, and cheap-first model tiering

**Idea.** Spend model turns on judgment, not on fetching; validate and rewrite deterministically before asking again; draft cheap and escalate.

**Who.** Anthropic "Building effective agents" (2024-12-19): routing — "directing straightforward questions to smaller models like Claude Haiku and complex ones to Claude Sonnet"; include "stopping conditions (such as a maximum number of iterations)". Claude Code costs docs: hooks/skills "preprocess data before Claude sees it… reducing context from tens of thousands of tokens to hundreds"; each tool round re-sends the transcript at cache-read rate. Claude Agent SDK structured outputs: the SDK "validates the output against it, re-prompting on mismatch", ending in `error_max_structured_output_retries` — the standard is validate-then-reprompt with a retry cap. Browser Use: `page_extraction_llm` "a small & fast model because it only needs to extract text", `flash_mode`, `use_vision: auto`. Magnitude: earlier releases split a planner from a Moondream executor; current docs recommend one grounded model (Claude Sonnet 4 or Qwen 2.5 VL 72B) — the split was walked back, so treat "tiny grounding model" as unproven for testing.

**Where wowlidator is today.** Retrieval is BM25 and already deterministic, but the author still spends 6–13 *tool* turns; lints re-ask ~40% of rows; `settleViolations` rewrites only at the last word; `WOWLIDATOR_GENERATOR_RETRY_MODEL` exists, unmeasured.

**Mapping.** (a) `src/generator/flow-author.ts` / `authorEachRow`: pre-compute the row's slice (documents, repo slice, tables, trees) and put it in the first prompt; give the model **no** retrieval tools by default (`--disallowedTools` on claude-cli, F7) and one bounded "ask for more" tool for the miss path. (b) Run `settleViolations` on the *first* attempt's fatal set too — re-ask only for violations with no `settle` (the doc's own list: vacuity, token typed, credential echo…). Expected: most of the 40% re-asks that are exclusivity, selector-role, script-step and text-grounding shapes become $0 rewrites. (c) Tiering: draft on the cheaper generator role, lint + settle, and escalate to opus only when a fatal violation survives — the S6 "at least as much about the claim" gate already protects against a worse cheap draft.

**Benefit.** P1.

**Confidence.** High on the mechanisms (primary docs); the size of the saving is unmeasured — the 40% figure is wowlidator's own, and which lint shapes dominate it should be counted from the ledgers before building.

### F7. Bound CLI-hosted authors with the harness flags, not with prompt text

**Idea.** When the model runs inside Claude Code or Codex, the CLI is the budget: turns, dollars, schema, effort, tools and session persistence are flags.

**Who.** Claude Code CLI reference: `--max-turns` "Limit the number of agentic turns (print mode only). Exits with an error when the limit is reached. No limit by default"; `--max-budget-usd` "Maximum dollar amount to spend… Spend from subagents counts toward the cap"; `--json-schema` "validated JSON output matching a JSON Schema after the agent completes its workflow"; `--effort low|medium|high|xhigh|max`; `--tools` / `--disallowedTools`; `--no-session-persistence`. Costs docs: cache lifetime 1 h on a subscription, 5 min on an API key; the `/usage` cache line names "tool definitions changed" as a likely-cause of misses; average ≈$13 per developer-day. Prompt-caching docs: reads 0.1× base (0.025× on Fable 5.1), 1-h writes 2×, hierarchy tools → system → messages. Codex: `codex exec --output-schema <file>` for a schema-conformant final message, `--json` JSONL events on stdout, progress on stderr, `--ephemeral`; **no max-turn, timeout or budget flag is documented**; a known bug reports `--output-schema` ignored when MCP tools are active (openai/codex #15451). Secondary (unverified): a blog measuring the median token re-billed 27× across a session.

**Where wowlidator is today.** The `claude-cli` provider family shells out to Claude Code; the generator doc records "the 92k 'in' per attempt is the claude-cli session's cache re-written per call". The lead's "15-turn cap" may be this wrapper's cap rather than the orchestrator's (whose doc says `DEFAULT_AGENT_MAX_STEPS` is 60) — worth confirming which cap fired.

**Mapping.** `src/providers` (claude-cli / claude-tty): pass `--json-schema` (drop text parsing), `--max-turns` per role (author: small, since retrieval is pre-fed; healer: 1–2), `--max-budget-usd` per row surfaced as a typed `budget` outcome, `--effort medium` for authoring and `low` for repair (measure with `doctor`), `--disallowedTools` to keep the author out of the repo, `--no-session-persistence`. Keep `--append-system-prompt` byte-identical across rows (the row goes in the user turn) so the 1-h cache holds across a catalog. For Codex, expect no budget flag: bound with a wall-clock timeout in the harness and treat schema failures as a provider fault (never a defect), as the healer already does.

**Benefit.** P1 (turns and cache), P2 (the cap becomes explicit and per-leg).

**Confidence.** High — all from current primary docs — except the 27× figure and the exact cause of the 15-turn cap.

### F8. A $0 fingerprint match before the model healer, with a score cap and a human gate

**Idea.** Store a structural fingerprint of every element on a *passing* run; on failure, score live candidates by similarity and accept only above a threshold; record score + screenshot for review. Model repair only when that misses.

**Who.** Healenium (docs): on each successful find it stores the locator plus the node's DOM neighbourhood; on `NoSuchElement` it runs an LCS-based tree comparison, ranks candidates, and accepts above `score-cap` (docs default 0.6; example configs 0.5; community advice ≥0.9); every heal is recorded with score and screenshot. testRigor (vendor): "on the first successful run… internally record the end-user's way of explaining your locator" and re-find by it. Playwright healer (docs): "Re-runs the test until it passes or until guardrails stop the loop". The "68% of self-healed selectors fail in production" figure circulating in blogs is vendor marketing — **unverified**.

**Where wowlidator is today.** The healer is model-first (echo rejection, 3 asks, exactly-one verification, rejected candidates kept). `relaxTextSelector` and the near-name rule are the only $0 repairs.

**Mapping.** `src/engine` records, at pass time, `{role, name, neighbours ±2 AX lines, landmark}` per selector into the healed-selector cache (schema already zod-parsed); `src/healer` gets a rung before `LlmHealerModel`: Jaccard/LCS over AX neighbourhoods, accept ≥ cap, else fall to the model with the top candidates as hints. Healed entries carry the score; the panel shows them for approval.

**Benefit.** Fewer healer calls (not one of the five pain points, but every dead-end today pays a healer call before it is called dead).

**Confidence.** Medium — Healenium's mechanism is documented; no source publishes its precision, and wowlidator's AX-tree neighbourhoods differ from Healenium's DOM subtrees.

### F9. Measure the QA agent's precision and recall with labelled bundles, seeded faults and repeat runs

**Idea.** Precision (how many filed defects are real), recall (how many seeded faults are caught), and reliability (how often the same case flips) — measured on frozen artifacts, not on live runs.

**Who.** "Neural-Based Test Oracle Generation: A Large-scale Evaluation and Lessons Learned" (ESEC/FSE 2023, arXiv 2307.16023): 25 Java systems, 223.5K tests, **51K injected faults**; when TOGA generates an assertion, ">47% of them are false positives" and true positives raise fault detection by 0.3% — the canonical warning that generated oracles must be measured for false alarms. Meta ACH (FSE 2025, arXiv 2501.12862): mutation-guided test generation; the equivalent-mutant judge reports precision 0.79 / recall 0.47 (0.95/0.96 with preprocessing) — i.e. they publish the judge's own P/R. AgentRewardBench: expert labels for success / side effects / repetitiveness; judges compared on precision, recall, F1. WebJudge: reports the "success-rate gap" between judge and human. WAREX (arXiv 2510.03285): repeats benchmarks under realistic perturbation and finds "significant drops" — reliability is its own number.

**A small benchmark for wowlidator (proposal).**
1. **Labelled set.** Freeze ~30–50 proof bundles from be100 / EC runs (mix of pass, defect, needs-review, error). A tester labels each: `true outcome ∈ {pass, real-defect, spec-question, not-deployed, test-data, harness}` — the same vocabulary as F2's origins. Store under `tests/fixtures/bench/` (bundles are already zod-parsed at the read seam, so the fixture is stable).
2. **Precision.** Of bundles wowlidator filed as a defect, the share labelled real-defect. Also the confusion matrix of `diagnosis.origin` vs label. Target: publish the number in the suite index like WebJudge's gap.
3. **Recall via seeded faults.** In the local HRCenter-DEV app (the `rebuild-beplan-db` skill already resets its data), seed UI mutants: hide a button, rename a label, remove an option from a set, break a cascade clear, change a computed total. Run the catalog rows that cover them; recall = mutants caught / seeded. This is Meta's ACH pattern at UI scale and answers "would the flows notice".
4. **Reliability.** Run each bench case 3× (the `--rerun-case` path) and report flip rate per case; a case that flips is quarantined by the existing history tier.
5. **Cost line.** Tokens and model calls per case from the bundles' `cachedInputTokens`/usage — so a change to F1/F6/F7 is judged on precision × cost, not cost alone.
6. **Tier.** Gated by an env var (`WOWLIDATOR_BENCH=1`), like the shell and Chrome tiers: "should not run unasked".

**Benefit.** Makes P5 measurable (false "system error" verdicts become a number that goes down), and protects F1–F7 from making the result worse.

**Confidence.** High on method (three independent precedents publish exactly these numbers); the size of the labelled set is a judgment call.

## Priority, by pain point

| Pain point | Findings | Cheapest first step |
|---|---|---|
| P1 authoring cost | F6, F7, F1 | Count re-ask lint shapes from the ledgers; settle on attempt 1; `--json-schema` + `--max-turns` on claude-cli |
| P2 wizard turn cap | F3, F7 | Confirm which cap fired; one leg per section lint + milestone budget |
| P3 codes vs names | F4 | code→label rung in value-resolution from the introspected schema |
| P4 500-row picker | F4, F2 | type-to-filter rung; else `application-limitation` outcome |
| P5 "system error" | F2, F5 | `not-deployed` / `application-limitation` origins; run diagnosis on absence-shaped fails |
| measurement | F9 | freeze 30 bundles, label them, publish precision |

## Sources (fetched 2026-09-05)

- Playwright Test Agents — https://playwright.dev/docs/test-agents
- Anthropic, Computer use tool — https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- Anthropic, Building effective agents (2024-12-19) — https://www.anthropic.com/research/building-effective-agents
- Anthropic, Prompt caching — https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Claude Code, Manage costs — https://code.claude.com/docs/en/costs
- Claude Code, CLI reference — https://code.claude.com/docs/en/cli-reference
- Claude Agent SDK, Structured outputs — https://code.claude.com/docs/en/agent-sdk/structured-outputs
- Codex, Non-interactive mode — https://learn.chatgpt.com/docs/non-interactive-mode ; issue #15451 — https://github.com/openai/codex/issues/15451
- Agent Workflow Memory (arXiv 2409.07429; ICML 2025) — https://arxiv.org/abs/2409.07429 ; repo https://github.com/zorazrw/agent-workflow-memory
- SkillWeaver (arXiv 2504.07079) — https://arxiv.org/abs/2504.07079
- ReasoningBank (arXiv 2509.25140; ICLR 2026) — https://arxiv.org/abs/2509.25140
- Learn-by-interact (arXiv 2501.10893) — https://arxiv.org/abs/2501.10893
- AgentSymbiotic, large+small LLMs (arXiv 2502.07942) — https://arxiv.org/abs/2502.07942
- Agent-E (arXiv 2407.13032) — https://arxiv.org/abs/2407.13032
- AgentOccam (arXiv 2410.13825; ICLR 2025) — https://arxiv.org/abs/2410.13825
- WorkArena++ (arXiv 2407.05291; NeurIPS 2024 D&B) — https://arxiv.org/abs/2407.05291
- FormFactory (arXiv 2506.01520) — https://arxiv.org/abs/2506.01520
- WebSuite (arXiv 2406.01623) — https://arxiv.org/pdf/2406.01623
- Detecting Pipeline Failures… (arXiv 2509.14382) — https://arxiv.org/abs/2509.14382
- Online-Mind2Web / WebJudge (arXiv 2504.01382; COLM 2025) — https://arxiv.org/abs/2504.01382 ; https://github.com/OSU-NLP-Group/Online-Mind2Web
- AgentRewardBench (arXiv 2504.08942) — https://arxiv.org/abs/2504.08942
- WAREX (arXiv 2510.03285) — https://arxiv.org/abs/2510.03285
- Neural-Based Test Oracle Generation: Large-scale Evaluation (ESEC/FSE 2023, arXiv 2307.16023) — https://arxiv.org/abs/2307.16023
- Mutation-Guided LLM-based Test Generation at Meta (FSE 2025, arXiv 2501.12862) — https://arxiv.org/pdf/2501.12862
- Browser Use, evaluation system (2026-02-23) — https://browser-use.com/posts/our-browser-agent-evaluation-system ; tools — https://docs.browser-use.com/customize/tools/available ; parameters — https://docs.browser-use.com/customize/agent/all-parameters
- Stagehand, Caching — https://docs.stagehand.dev/v3/best-practices/caching
- Skyvern, Code caching — https://www.skyvern.com/docs/developers/features/code-caching
- Magnitude, Compatible LLMs — https://docs.magnitude.run/core-concepts/compatible-llms
- Momentic, A new era of software quality (2026-06-24) — https://momentic.ai/blog/a-new-era-of-software-quality
- mabl, AI test automation — https://www.mabl.com/ai-test-automation
- Healenium docs — https://healenium.io/docs/download_and_install/hlm_web ; https://github.com/healenium/healenium-web
- testRigor, self-healing (vendor) — https://testrigor.com/ai-based-self-healing/
- Octomind categories (secondary; site unreachable) — https://bug0.com/knowledge-base/octomind-ai-testing-platform-features
