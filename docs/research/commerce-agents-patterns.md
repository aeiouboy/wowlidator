# Patterns from `anthropics/commerce-agents` for improving Wowlidator

Research date: 2026-09-05  
Upstream revision: [`fd4d59224ab96b43c6dc6888207c67b3bd5a24cf`](https://github.com/anthropics/commerce-agents/tree/fd4d59224ab96b43c6dc6888207c67b3bd5a24cf)

## Executive recommendation

Wowlidator already has several of the hard parts that make `commerce-agents` useful as a reference: a small model interface, a harness-owned action loop, origin and action restrictions, structured model output, deterministic proof records, and shared execution behind CLI/UI/MCP surfaces.

The highest-value patterns to adopt are:

1. **Fence every untrusted value before it enters a model prompt.**
2. **Stop durable replay memory from storing raw input values, especially credentials.**
3. **Require current-session provenance for destructive or authoritative actions.**
4. **Represent policy refusals as a typed `blocked` outcome instead of an ordinary failed action.**
5. **Validate persisted proof/cache/claims artifacts at their read boundary.**
6. **Move specialized browser guidance out of the monolithic system prompt and load it on demand.**

Items 1-3 are security/correctness work. Items 4-6 mainly improve verdict quality, maintainability, and token cost.

## What Wowlidator should keep

| Pattern | Upstream | Wowlidator today | Verdict |
|---|---|---|---|
| One core contract behind multiple runtimes | The same prompt, skills, tool contracts, and gates run through Messages API, Agent SDK, and Managed Agents ([README](https://github.com/anthropics/commerce-agents/blob/fd4d59224ab96b43c6dc6888207c67b3bd5a24cf/README.md#L181-L186), [layout](https://github.com/anthropics/commerce-agents/blob/fd4d59224ab96b43c6dc6888207c67b3bd5a24cf/README.md#L210-L225)). | CLI, UI, and MCP already converge on the same runner and proof bundle. Model providers sit behind `AgentModel.decide()`. | Keep this architecture. Add parity tests, not another abstraction layer. |
| Harness owns the loop | Tool execution and policy stay in the executor/turn loop, not in model prose. | `WorkflowAgent` makes one structured decision per turn and the harness performs/refuses it. | Strong match. |
| Claims are not evidence | Presentation is validated/enriched server-side before emission ([presentation.py](https://github.com/anthropics/commerce-agents/blob/fd4d59224ab96b43c6dc6888207c67b3bd5a24cf/commerce-common/commerce_common/presentation.py#L120-L145)). | `AgentRecord` separates model claims from actions and observed evidence; finish can be rejected against live page state. | Keep and extend to all persisted artifacts. |
| Stable prompt prefix | Upstream separates static system/tool bytes from dynamic context and tests byte stability across iterations ([test_turn_loop.py](https://github.com/anthropics/commerce-agents/blob/fd4d59224ab96b43c6dc6888207c67b3bd5a24cf/tests/test_turn_loop.py#L135-L168)). | `buildUserPrompt()` is explicitly stable-first and history is capped to the newest eight lines. | Do not build a second compactor first. Add invariance tests and provider cache telemetry. |
| Fail closed and continue | Unknown/disabled tools, invalid schemas, and tool exceptions become structured outcomes rather than crashing the turn ([execution.py](https://github.com/anthropics/commerce-agents/blob/fd4d59224ab96b43c6dc6888207c67b3bd5a24cf/commerce-common/commerce_common/execution.py#L214-L243)). | Model errors return an `AgentRecord`; action errors are recorded in `AgentAction`. | Keep, but add a typed policy-blocked lane. |

## Priority 0: fence model input as hostile data

### Upstream pattern

`commerce-agents` uses one reusable `Fence` module for third-party text. It:

- normalizes Unicode;
- removes zero-width, bidirectional, format, and control characters;
- removes forged transcript/tool/system tags to a fixpoint;
- rewrites forged role boundaries;
- bounds the final payload;
- wraps it in a source-labelled fence whose label is a static literal.

Source: [fencing.py lines 4-7](https://github.com/anthropics/commerce-agents/blob/fd4d59224ab96b43c6dc6888207c67b3bd5a24cf/commerce-common/commerce_common/fencing.py#L4-L7), [character and token rules](https://github.com/anthropics/commerce-agents/blob/fd4d59224ab96b43c6dc6888207c67b3bd5a24cf/commerce-common/commerce_common/fencing.py#L20-L73), and [`Fence.sanitize_text`](https://github.com/anthropics/commerce-agents/blob/fd4d59224ab96b43c6dc6888207c67b3bd5a24cf/commerce-common/commerce_common/fencing.py#L99-L149).

### Local gap

`buildUserPrompt()` currently interpolates `goal`, `caseContext`, `axTree`, URL, history, ledger, and refusal feedback directly into one prompt. HTML/XML escaping in reports protects the browser output surface, but it does not protect the model input surface.

Local evidence: [`buildUserPrompt`](../../src/orchestrator/workflow-agent.ts#L721-L773).

The highest-risk sources are:

- accessibility names and visible page text;
- API/network bodies used as generation or diagnosis context;
- workbook/catalog cell text;
- repository files and messages indexed by the context engine;
- model-produced reasoning recycled into later repair/history prompts.

### Proposed deep module

Add one small interface at the model-input seam, for example:

```ts
type ModelDataSource = 'page' | 'catalog' | 'network' | 'repository' | 'model-history';

interface ModelFence {
  wrap(source: ModelDataSource, value: unknown, maxChars: number): string;
}
```

The implementation should own normalization, marker removal, bounded serialization, and the literal source tags. Callers should not assemble their own tags or sanitizer chains.

Tests should cover nested closing markers, forged `system:` turns, `<tool_result>`/`<|...|>` tokens, zero-width/bidi characters, hostile object keys, Thai text preservation, and exact length bounds.

## Priority 0: make replay memory secret-safe and schema-valid

### Upstream pattern

The upstream memory writer uses a narrow schema with length/category limits, then validates and sanitizes every fact. A write filter rejects email- and identifier-shaped values, and purge generation prevents an asynchronous extraction from resurrecting deleted memory.

Source: [memory tool schema](https://github.com/anthropics/commerce-agents/blob/fd4d59224ab96b43c6dc6888207c67b3bd5a24cf/commerce-common/commerce_common/memory.py#L35-L47), [write filter](https://github.com/anthropics/commerce-agents/blob/fd4d59224ab96b43c6dc6888207c67b3bd5a24cf/commerce-common/commerce_common/memory.py#L121-L180), and [`validate_fact`](https://github.com/anthropics/commerce-agents/blob/fd4d59224ab96b43c6dc6888207c67b3bd5a24cf/commerce-common/commerce_common/memory.py#L183-L208).

### Local gap and concrete risk

Wowlidator masks password-shaped values when it renders the done ledger, but `scriptOf()` copies the raw `AgentAction.value` of every successful action into a replayable `PlanStep`. `cacheAgentMemory()` then JSON-serializes that step list into the persistent healed-selector cache, and the same script may be stamped into a flow file.

Local evidence: [`cacheAgentMemory`](../../src/orchestrator/workflow-agent.ts#L534-L562), [`scriptOf`](../../src/orchestrator/workflow-agent.ts#L977-L994), and [`doneLedger`](../../src/orchestrator/workflow-agent.ts#L1024-L1052).

This means a successful agent-driven `fill`/`type` of a real credential can be persisted even though the human-facing log is masked. This is an inference from the data path; it should be treated as a potential credential-at-rest defect until a safe-value resolver is enforced.

### Recommended change

- Durable scripts must never contain raw values for secret-bearing or identity fields.
- Persist a typed `ValueRef` such as `{ kind: 'persona-secret', name: 'HRBP_ACCOUNT.password' }`, or omit the action from durable replay and re-resolve it from the run-scoped credential provider.
- Parse cache entries with a Zod discriminated union; do not use `JSON.parse(...) as PlanStep[]`.
- Add `sourceRunId`, page fingerprint/version, timestamps, and optional expiry.
- Provide `forget` and full purge semantics that cannot be undone by concurrent flushes.
- Reject unknown action kinds and values exceeding their contract before replay.

The first regression test should prove that a successful password fill produces neither raw password bytes in the cache nor in a flow's recorded `script`.

## Priority 0: provenance-gate destructive and authoritative actions

### Upstream pattern

Before a merchant write, the upstream gate requires IDs that were actually returned in the current session. Applying a change then checks, in order: known staged change, current guardrails, and host approval.

Source: [`check_listing_provenance`](https://github.com/anthropics/commerce-agents/blob/fd4d59224ab96b43c6dc6888207c67b3bd5a24cf/merchant-agent/core/merchant_agent/gates.py#L113-L124) and [`check_apply_change`](https://github.com/anthropics/commerce-agents/blob/fd4d59224ab96b43c6dc6888207c67b3bd5a24cf/merchant-agent/core/merchant_agent/gates.py#L192-L215).

### Local partial match

Wowlidator already:

- limits origins;
- limits actions for read-only/reveal modes;
- refuses a destructive click when the selector is not scoped to an identifier named in the goal.

The missing property is **observed provenance**. An identifier in goal text is not proof that the current session discovered the row, is on the right environment, or still sees the same record.

Local evidence: [`unscopedDestructiveClick`](../../src/orchestrator/agent-guards.ts#L225-L260) checks goal identifiers and selector scope, while [`WorkflowAgent.#refuse`](../../src/orchestrator/workflow-agent.ts#L2329-L2365) applies it before acting.

### Recommended change

Introduce a run-scoped `TargetProvenance` ledger populated only from trusted harness observations. For a destructive action, require:

1. environment/origin matches the run policy;
2. target identifier was observed in the current session;
3. target is still present in the latest page snapshot;
4. action is permitted by the run's mutation policy;
5. irreversible actions carry a trusted host approval or an explicit pre-approved manifest entry.

Do not derive approval from the natural-language goal. Chat text may request an action; it must not manufacture the approval signal.

For non-interactive SIT batches, approval can be a signed/host-supplied run manifest such as `mutationPolicy: { allow: ['create', 'update'], deny: ['delete', 'approve'] }` rather than a modal on every case.

## Priority 1: add `blocked` as a first-class outcome

### Upstream pattern

`ToolOutcome` distinguishes a successful result, an error, and a held call with a reason such as provenance, guardrail, or approval. Tests assert that a held call is emitted as `status: blocked`, `is_error: false`, while a completed read is `ok` ([test_turn_loop.py](https://github.com/anthropics/commerce-agents/blob/fd4d59224ab96b43c6dc6888207c67b3bd5a24cf/tests/test_turn_loop.py#L176-L192)).

### Why it matters locally

Today an action refused by a safety rule is generally recorded as `ok: false` with an error string. Downstream code must infer whether the application failed, the harness failed, or policy intentionally withheld the action. Wowlidator already works hard to avoid false product defects; string classification at this point weakens that effort.

Local evidence: [`AgentAction`](../../src/engine/proof-bundle.ts#L372-L395) has only `ok` plus an optional error, and [`StepStatus`](../../src/engine/proof-bundle.ts#L38-L55) has no blocked state.

Use a discriminated result such as:

```ts
type ActionOutcome =
  | { kind: 'ok'; evidence?: ObservedValue }
  | { kind: 'blocked'; reason: 'provenance' | 'approval' | 'capability' | 'guardrail'; message: string }
  | { kind: 'failed'; reason: 'application' | 'infrastructure'; message: string };
```

The run verdict should treat `blocked` as “no application verdict,” not as a failed action that may later be promoted to a product defect.

## Priority 1: parse persisted artifacts at the trust boundary

### Upstream pattern

Model-authored presentation payloads are validated before enrichment and emission; enrichment may refuse or hold them ([presentation.py](https://github.com/anthropics/commerce-agents/blob/fd4d59224ab96b43c6dc6888207c67b3bd5a24cf/commerce-common/commerce_common/presentation.py#L120-L145)).

### Local partial match

Wowlidator uses Zod for model output and MCP inputs, but several persisted artifacts are read with a type assertion or a shallow shape check. Examples include replay memory, proof bundles, history entries, context graphs, cache files, baselines, and suite ledgers.

Local evidence: wowUI's proof reader accepts a bundle after checking only four top-level properties in [`looksLikeBundle`](../../src/ui/proofs.ts#L253-L292).

### Recommended change

Create schemas at the file/API read seam for the artifacts whose contents can trigger actions or affect verdicts:

1. replay scripts and healed-selector cache;
2. flow files and claims files;
3. proof bundles and suite-progress ledgers;
4. context graphs and database baselines.

Parse once into trusted internal types. Invalid artifacts should return a typed unavailable/corrupt result and should never partially execute.

## Priority 2: load specialized browser guidance on demand

### Upstream pattern

The upstream `SkillRegistry` keeps a stable, sorted index in the system prompt and returns a skill body only when requested. Skills are `SKILL.md` directories with validated frontmatter ([skills.py](https://github.com/anthropics/commerce-agents/blob/fd4d59224ab96b43c6dc6888207c67b3bd5a24cf/commerce-common/commerce_common/skills.py#L4-L86)).

### Local opportunity

Wowlidator's agent system prompt contains action semantics plus detailed guidance for sign-in, consent, date pickers, long tables, required-field forms, dropdowns, collapsed sections, and multi-step wizards. It is cached/stable, but every turn still carries knowledge irrelevant to most pages.

Split domain guidance into internal skills such as:

- `auth-and-consent`;
- `forms-and-required-fields`;
- `tables-and-pagination`;
- `date-pickers`;
- `wizards`.

Prefer deterministic host selection from the goal and AX-tree features so loading a skill does not consume another model turn. Keep the action contract and safety rules in the static system prompt. Skill bodies contain tactics only; they must never weaken the policy layer.

## Priority 2: add protocol-invariant tests

The upstream test suite checks properties of the loop rather than prose: forced grounding, tool-choice transitions, held outcomes, stable cached system/tool bytes, and feature switches that remove capabilities consistently.

Recommended Wowlidator invariants:

- identical static system and schema bytes across turns for a fixed configuration;
- disabling backend access removes `dbCount` from prompt/schema/dispatch together;
- read-only/reveal modes cannot express forbidden actions through any runtime;
- policy-blocked actions never become application defects;
- cache replay re-validates current target provenance;
- report/UI projections cannot override the authoritative proof-bundle verdict;
- prompt fencing is identical across generator, healer, orchestrator, repair, and judge roles.

Source: [cross-turn invariants](https://github.com/anthropics/commerce-agents/blob/fd4d59224ab96b43c6dc6888207c67b3bd5a24cf/tests/test_turn_loop.py#L157-L198) and the repository's stated safety model that tool-call gates hold on every runtime path ([docs/safety.md](https://github.com/anthropics/commerce-agents/blob/fd4d59224ab96b43c6dc6888207c67b3bd5a24cf/docs/safety.md#L194-L202)).

## Suggested implementation order

### Phase A: security boundary

1. Add the `ModelFence` module and hostile-input tests.
2. Route every model-input builder through it.
3. Replace raw replay values with secret-safe `ValueRef`s or omit them.
4. Parse replay/cache input with Zod.

Exit condition: hostile page/catalog text cannot escape its source fence, and no raw credential can be found in a flushed cache or recorded workflow script.

### Phase B: action authority

1. Add typed `ActionOutcome` with `blocked`.
2. Add current-session `TargetProvenance`.
3. Add host/run-manifest mutation policy.
4. Update proof/reporter/exit classification.

Exit condition: an unobserved target, missing approval, or denied capability produces a blocked no-verdict result and no application mutation.

### Phase C: cost and maintainability

1. Add prompt/tool byte-invariance tests and cache telemetry.
2. Extract specialized tactics into deterministically selected skills.
3. Add strict schemas for the remaining persisted artifacts.

Exit condition: common cases send only relevant tactics, all runtime surfaces enforce the same capabilities, and persisted data is trusted only after parsing.

## Patterns not worth copying directly

- **Do not replace the harness-owned one-action browser loop with a generic tool runner.** Wowlidator's page observation, screenshot, origin, evidence, and no-progress checks are valuable local behavior.
- **Do not add interactive approval to every write.** Batch QA needs a host-supplied mutation policy; reserve explicit approval for irreversible or authoritative operations.
- **Do not add history compaction before measuring a problem.** The agent prompt already caps visible history and preserves a compact done ledger. The immediate memory risk is secret persistence, not history length.
- **Do not expose internal skill loading as a public interface unless two real adapters need it.** Deterministic internal selection is simpler for the current single browser-agent loop.

## Inspected upstream paths

- `README.md`
- `docs/safety.md`
- `commerce-common/commerce_common/{execution,fencing,memory,presentation,prompt_assembly,skills,turn}.py`
- `merchant-agent/core/merchant_agent/gates.py`
- `tests/{test_turn_loop,test_consumption_paths,test_platform_seams,test_system_switches}.py`

The repository describes itself as a reference implementation and says it is not maintained, so copy the invariants and seams, not its dependency versions or platform-specific plumbing ([README](https://github.com/anthropics/commerce-agents/blob/fd4d59224ab96b43c6dc6888207c67b3bd5a24cf/README.md#L280-L282)).
