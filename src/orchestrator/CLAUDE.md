# CLAUDE.md — the workflow agent's evidence rules

Split out of the root CLAUDE.md (2026-08-24) so this loads only when working under
`src/orchestrator/`. Same authority as the root file; the root keeps the map of the whole system.

## What the agent claims is never the evidence (`src/orchestrator/goal-evidence.ts`)

The rule was already stated for the ladder's agent rung and enforced there structurally — the agent prepares the page, then the *author's own selector* is retried. The `workflow` action did not have it: `SmartRunner.workflow()` read `record.success` and stopped. Live (PB_03_01, 2026-08-19): the agent signed in successfully at turn 5, spent turns 6–8 re-filling a password field it could not read back, reported "gave up after 8 turns", the step was recorded failed with a `high` defect — and the very next step passed in 14ms **from the destination the goal named**. Thirty-seven seconds and a reconstruction call to file a defect against an app that had done what it was asked.

Four rules now, all deterministic, all in the leaf module (leaf because `runner` imports `workflow-agent`, so a shared predicate cannot live in either):

- **Arriving is finishing.** `destinationReached()` — the goal names a path (`goalDestination()`: the *last* URL or path in the goal, since a goal ends where it arrives; a bare `/` is never a destination) and the page has just reached it, having not been on it when the step began. The agent loop breaks there and spends nothing more; the WORKFLOW GOALS contract in the author prompt asks every page-changing goal to end with its destination path for exactly this reason. Only this rule is consulted mid-flight.
- **The page is asked before the agent's account stands.** `goalEvidence()` after the run: the destination rule, or — *only when the goal names no destination* — a sign-in goal that left the sign-in page and did **not** land on an interstitial (`looksLikeInterstitial`: consent, PDPA, terms, MFA). Every rule requires an observed *transition*, so none can be satisfied by an agent that did nothing; and the destination rule is **exclusive**, because the one genuine non-completion in the measured run was an agent stranded on `/en/consent` short of its named destination, which the weaker rule would have called success. A step judged on evidence still files a `low` usability finding: the goal was met, the agent under-reported it, and every run will pay the turns again until the goal is tightened.
- **A provider failure is not an application failure.** `agentModelUnavailable()` reads the record's summary; "agent model failed: … circuit is open" files **no defect** — six of eleven non-passing workflow steps in the measured run were the structured-output breaker, each filed as a `high` functional defect against an app the agent never clicked. Same rule the healer follows for `HealUnavailableError`.
- **Running out of turns is `medium`, worded as a harness limit.** `high` is for a goal the agent actively determined it could not reach.

## The flow-file script rung (2026-08-24)

A successful agent journey is persisted twice now: in the healed-selector cache
(`AgentMemory`, as before) and **on the flow file itself** — `runCases` folds
`scriptOf(record.actions)` back into the `workflow` step as `script`
(`withWorkflowScripts` in `src/cli/case-plan.ts`). `WorkflowAgent.run` replays
`runOptions.script` after the cache rung and before any model turn, under the
same rules (`#replay`: every selector must re-ground, a named destination must
be reached), and a successful script replay seeds the cache. The point over the
cache alone: the script survives a cleared cache and travels with the flow.
`scriptOf` is the single writer for both — `finish`/`fail`/`wait` never persist.

**Every workflow step is self-evidencing.** The step's `detail` carries `urlBefore`/`urlAfter`, the page's headings before and after (and `appeared`, the diff), and the requests the page made while the agent held it land on `network` — so a leg nothing asserts on afterwards is still auditable from the report. That is why `unsettledWorkflowClaim` (and the e2e `agent-journey` verdict of `notEndToEnd`) are `weak` refusals **accepted at once with a note**, never re-asked: measured, the re-ask came back with the same leg — the model could not see the page the leg ends on — and the weak result was taken anyway once the budget was spent, two calls later. Fatal violations still refuse. The agent's history lines now carry the value typed (a password masked to its length) and `moved A → B` / `still at`, and its prompt has a per-turn procedure whose second step is "an action marked ok is DONE — never repeat it".

## A control clicked past its limit is circling (`repeatedToggleClick`)

Live (PL_03_02, 2026-08-27): a filter button whose listbox options never appeared in the truncated tree was clicked EIGHT times across 38 turns and 310 s — each toggle changed the tree (open ↔ closed) so the repeated-on-unchanged-page guard never fired, and a mid-thrash URL change reset the per-URL done-set too. `repeatedToggleClick` (`agent-guards.ts`, pure) counts ok activations per selector for the WHOLE run: past `TOGGLE_CLICK_LIMIT` (3 — a multi-select legitimately re-opens once per pick, PL_03_17 needed three) the next activation of that selector is refused with the count and alternatives (type the value directly, a faster jump control, another control the tree shows, or fail). Second insistence is `circling:` — recorded REFUSED like the destructive guard, never acted on, counts as no progress, and the no-progress counter ends a model that keeps insisting.

**`press` counts exactly as `click` does, since 2026-09-02.** Live (HIR-EC-009): a Date of Birth calendar's "Previous year" stepper was PRESSED — not clicked — upward of thirty times chasing a decades-distant year, 15.6 minutes on one workflow step (of a 45-minute case), because the guard counted `click` alone: a targeted `press` (a selector given, distinct from a bare key sent to whatever has focus) activates its control identically and is exactly the same pathology wearing a different action name. The one-step goal itself was a giant natural-language sentence ("Complete the new-hire key-in form... born in 1995... employee category \"F - DVT\"...") that `goalOutcome`'s narrow `set X to Y` parse cannot read at all, so the value-hunt guard (`AGENT_VALUE_HUNT_TURNS`, below) never engaged either — this fix is the one that is genuinely universal for that shape of goal, because it counts activations, not values. `DEFAULT_AGENT_MAX_STEPS` (60, also 2026-09-02) is the remaining backstop for a goal neither guard can parse.

## The agent fills forms like a human (`check` / `uncheck` / `selectOption` / `type`, 2026-09-02)

`AGENT_ACTIONS` gained the four form verbs the generator and the engine already had, so a `workflow` leg drives a real form instead of click-and-guess: `check`/`uncheck` set a checkbox, radio or ARIA toggle and confirm the state changed (native `setChecked` first, then read `aria-checked`/`aria-pressed`, click only if it differs, re-read); `selectOption` picks by visible label from a native `<select>` or, on failure, opens a custom listbox and clicks the option by accessible name — never fill a dropdown, never guess its items; `type` fires a real keydown per character for autocomplete/typeahead/masked fields, with no read-back guard because such a field is expected to transform what it holds. `fill` keeps its hydration read-back-and-refill. **The safety argument is unchanged**: none of the four is destructive — the vocabulary still cannot express a purchase or a delete except through a `click` the goal explicitly named. `REVEAL_ACTIONS` (the assertion-repair reveal pass) gained `check`/`uncheck`/`selectOption` — a human revealing a target does tick a gating box or pick a dropdown — but **not** `fill`/`type`: a claim an agent *typed* into existence still proves nothing, so text may never be written into the asserted field on that path. `READ_ONLY_ACTIONS` (the Stage-1 triage look) is untouched.

## The agent's read-only database access (`dbCount`)

`AGENT_ACTIONS` includes `dbCount`: count the rows of a table (in `selector`) matching equality pairs (in `value`, `"column=value, column2=value2"`), through `RunOptions.dbProbe` — which the runner wires to its own `DbActions.probeCount`, so the agent gets the same table/column grounding and the same read-only session as every `expectDbRow`, and nothing else. The observed count rides the history line as the action's note ("dbCount benefit_management.benefit_plan — ok (observed 3 row(s))"), so the model reasons from what the database actually said and the record shows the evidence — the same "what the agent claims is never the evidence" rule, satisfied by making the observation itself the record. It cannot write, which keeps the vocabulary's safety argument intact. When no database is configured the probe is simply absent and the action fails with advice ("verify through the page instead"), never a connection error. **`--no-backend` withdraws the probe too** (2026-08-27): a run that declared backend-off had its agent settle a UI-reading goal with three `dbCount` calls (PL_03_02) — a pass whose evidence the run's own limits said not to touch, on a replica whose counts drift. The gate lives in `SmartRunner.#agentDbProbe`. Born from PL_03_03 (2026-08-25): a claim of the form "the count in the box matches the database" was authored as a hardcoded `count: 0` because nothing could read both sides; an agent goal can now hold the box and the table together.

## Looking again is not a stall, and three turns was not evidence

Measured the day after the turn ceiling went (be100, 2026-08-25, 22 error runs with a bundle): 17 ended in the loop's own stops, not on the page. Seven were `stalled: repeated "scroll "` / `"wait "` — the model asked to look again, was told it already had, insisted once, and the run was recorded as a harness error with the goal's control on screen. Ten were `nothing succeeded in 3 consecutive turns`, most on a dropdown leg where the option's role was guessed three ways (`option`, `menuitem`, `text=`) at 1.5 s a miss. Three were an agent reasoning from `/en/consent` after a mid-run goto was redirected there.

- **`IDLE_ACTIONS` (`wait`, `scroll`) are never a stall.** They cannot change the application, so repeating one is not the shape the repeat guard exists for (the same fill into the same field, four times). A repeated idle action is refused once with the reason (the tree lists off-screen elements too), then let through — and the turn it spends counts toward `AGENT_NO_PROGRESS_TURNS`, because it is never progress either. A loop that only looks still ends; it ends on the judge, not on the second look.
- **`AGENT_NO_PROGRESS_TURNS` is five, and counts turns in which nothing *advanced*** — no ok click/fill/press/hover/goto. Three was tuned when a miss cost the 8 s action timeout; once `#target` made a miss cost 1.5 s, three turns was four seconds of evidence, which is the ordinary price of finding out how a widget is built, not proof the page cannot do it.
- **A `wait` on a page whose network is already quiet pays `WAIT_SETTLE_MS`.** The idle wait returns at once there, and a wait that does nothing costs a model turn to do nothing. Paid only when the idle wait had nothing to wait on, so settled pages are not taxed on every wait (the 2026-08-24 concern).
- **`scroll` goes through `#target` and the grounding refusal.** A row a virtualised table has not rendered is "no element matches" in 1.5 s, with the reason, not a 5 s `scrollIntoViewIfNeeded` timeout the next turn cannot read.
- **The consent-gate rung runs on every turn, not only in the preflight.** A goto redirected to `/en/consent` (the session had not accepted; the preflight's 5 s poll had found no accept control on a page still hydrating under an eight-way run) is cleared without a model turn, and the agent is returned to `intendedUrl` — the page its last goto asked for, else the step's own page — never left on the app's home. The model is never asked to decide from the gate.

## A leg that never engages a control ends fast, and a reload is not progress

Live (PL_07_03, 2026-08-27): three workflow legs told to "locate the row for PL_07_… and click its Make Correction icon" on a 76-row table whose **filter and search controls are absent from the AX tree** — every `role=combobox`, `role=textbox`, `role=button[name="Category"]` a 1.5 s miss, while buttons that ARE exposed resolve. Two harness faults made a hopeless leg slow instead of quick: the looked-only handoff (`AGENT_LOOK_ONLY_TURNS`) fired only when EVERY action was a scroll/wait, so a leg that *tried* clicks and missed was disqualified and rode the full 5-turn stall at 1.5 s a miss (77 s on one leg); and a `goto` reload of the same page counted as progress and reset the no-progress judge, so the agent reloaded "to get a clean tree" and bought five fresh turns each time.

Two fixes in the loop's progress judge (both keyed on new `INTERACTION_ACTIONS` — the acts that engage a control; `goto` is not one):

- **A leg that never once lands a control-engaging action hands off at `AGENT_LOOK_ONLY_TURNS`**, softly — the same reading/unreachable outcome as the pure-scroll case, extended to "attempted a click and every one missed" (`missedEveryInteraction`). The handoff is soft (`lookedOnly`, inconclusive-not-failed), so a goal the agent truly could not fulfil still fails — at the flow's next assertion in 2 s, not after 77 s. A leg of failed **gotos** is excluded (navigation that did not arrive is an ordinary stall), and a leg that DID engage a control earlier (`interactedEver`) stays on the 5-turn judge.
- **A `goto` to a URL already visited this leg is not progress** (`visitedUrls`): a reload no longer resets the no-progress counter, so a leg that keeps reloading the same page is bounded instead of running indefinitely.

The still-open half is the target app's own: those filter/search controls render without `combobox`/`textbox`/`searchbox` roles, so nothing — agent or authored selector — can drive them. Until they carry ARIA roles (or authoring learns to locate the row another way, e.g. a URL search param the app honours), the correct outcome for these legs is the fast soft handoff above, with the assertion carrying the verdict.

## The early give-up is a toggle

The agent's two early-stop judges — the look-only soft handoff at `AGENT_LOOK_ONLY_TURNS` (3) and the no-progress stall at `AGENT_NO_PROGRESS_TURNS` (5) — are on by default and can be turned off per run (`--no-agent-early-stop`, the panel's "Disable the agent's early give-up") or process-wide (`WOWLIDATOR_AGENT_EARLY_STOP=off`). Off raises BOTH ceilings to `AGENT_NO_PROGRESS_OFF_TURNS` (25) rather than to `maxSteps` (unbounded by default): "off" must mean "try much harder before conceding," never "loop forever spending model calls on a control that will never appear." The ceilings live as instance fields (`#noProgressTurns`/`#lookOnlyTurns`, resolved in the constructor from `WorkflowAgentOptions.earlyStop ?? agentEarlyStopDefault()`), so the toggle is one decision applied everywhere the two judges fire. This is one of three retry rules the operator can switch off — the others are in-run step reconstruction (`WOWLIDATOR_RECONSTRUCT`/`--no-reconstruct`, `src/engine/`) and whole-flow repair (`WOWLIDATOR_REPAIR`/`--repair`, `src/repair/`).

## A destructive click must name its row

Live (be100 PL_03_18, 2026-08-25 06:28): the goal named the plan to delete, the agent could not find its row, clicked `role=button[name="Delete" i] >> nth=0` — the first Delete on a 75-row table — confirmed the dialog, and the step's own network evidence shows `DELETE /api/benefit-plans?planId=TH_MED_001`. Its reasoning said it was the right row. On an authoritative database that delete is permanent, and PL_02_02 (re-authored 45 minutes later against that plan's name) dead-ended on every run after. The prompt's "no destructive action unless the goal asks" was satisfied on paper.

`unscopedDestructiveClick` (`agent-guards.ts`, pure) is the structural form: when the goal names an identifier (`PL_03_15_16_17_18`, `TH_MED_001`) and the click's target control is destructive by name (`DESTRUCTIVE_NAME`), the selector must carry one of those identifiers — or sit inside a `role=dialog`, the confirmation of a delete already scoped. Refused on the first ask with the scoped shape shown; on the second ask it is **never acted on**: recorded as a failed action (`REFUSED` in the history), the turn counts as no progress, and the loop goes on — the right row may still be found, or `fail` said honestly. A goal that names no identifier has nothing to scope to and is left to the prompt.

## The tree the agent is shown must contain the answer

Live (be100 PL_03_01, 2026-08-25). Goal: *"verify the Total Plans summary card shows count 75"*. The agent spent five turns scrolling, reported *"the required numeric values are not present in the accessibility tree"*, the step failed with a `high` defect — and the next step's `expectText "75"` passed against the very page it had been standing on.

Both halves were the harness's own:

- **`focusTree` dropped the goal's number.** Goal terms were filtered by `length > 2`, and `75` is two characters — so the one term naming the answer scored nothing, the node called `"75"` ranked below sixty sidebar links, and the budget evicted it. A numeric token now survives the filter; it is the most specific term a goal can carry.
- **`focusTree` kept the label and cut the value.** A summary card is a label and a value as sibling nodes (`StaticText "TOTAL PLANS"`, then `StaticText "75"`), and the value shares no word with the goal. A node that MATCHES the goal now brings its document neighbours with it, on the match's own rank — so it cannot outrank a better node, only fill the budget ahead of unrelated ones. Verified against the live page: before, `TOTAL PLANS` present and `75` absent; after, both.

**And the goal was never the agent's to answer.** `verificationOnlyGoal` (`goal-evidence.ts`): a goal carrying a verify verb and no action verb asks the agent to be the oracle, which it structurally cannot be — an agent produces an account of itself, never evidence, which is this module's whole premise. Such a leg now **hands off**: `goalEvidence` returns `verification-deferred`, the step passes, and whatever the flow asserts next is the proof (a leg with nothing after it is caught at authoring time by `unsettledWorkflowClaim`, never invented into a defect at runtime). It still files the `low` usability finding, worded for this case: write the leg as the assertion it is, and keep the agent for the navigation that reaches the page. Deliberately narrow — any action verb anywhere disqualifies it, so "open the dialog and verify the title" stays a real leg whose failure is real.

## The queue governor (`queue-governor.ts`, 2026-08-28)

One agent per suite run governing parallel queuing (docs/parallel-run-spec.md
§2.4): role `governor` (default groq; point at claude-cli opus via
`WOWLIDATOR_GOVERNOR_*` — the TURN BUDGET bounds the spend, not the model).
Event-driven (`suite-start`, `case-ended` on a non-pass, `queue-blocked` after
~25 refused dispatch polls), hard-budgeted (`WOWLIDATOR_GOVERNOR_TURNS`, 12),
compact observation, one structured action per turn. It may NARROW on its own
authority (hold, shrink pool, note); the deterministic section rules are the
floor. `db-read` = one SELECT; `db-write` = one INSERT/UPDATE on a declared
table, only with `WOWLIDATOR_DB_ADMIN_URL`, logged BEFORE execution, DELETE
refused outright. Absent/off/erroring/out-of-budget → the deterministic
scheduler runs exactly as it would alone (the capture-pilot containment rule).
`WOWLIDATOR_GOVERNOR=off` disables. Tests: `tests/queue-governor.test.ts`.

## A finish is accepted on the page's word (S1 of the 2026-08-28 agent-flaw audit)

Audit of be100's latest run: 20 of 22 agent legs on PASSED cases were settled by the agent's own `finish` text — "shows 1–75 of 75, *meaning* 100 was selected"; "picked, *as confirmed by* the successful clicks" — inference presented as observation, never checked. The "what the agent claims is never the evidence" rule had been enforced on failures only. Now: `goalOutcome` (`goal-evidence.ts`, pure) reads the checkable end state a goal names (`set X to Y`, `X = "Y"`); on `finish` the loop re-reads the live tree and `outcomeShown` must find it — on one line (`button "Status: Inactive"`) or as a label→value neighbour within three lines. A miss is refused ONCE with what the tree shows; a second insistence records `claimed finish, but the page does not show X = Y` and `success: false`. A goal naming no state falls through, and the record says so: `AgentRecord.settledBy` is `observed-state` (with the evidencing line) or `agent-claim` (with the bare reasoning), so an all-claim run is visible as one in the report. New action **`read`** (idle, never progress): the harness reports a control's text/value/checked/expanded/disabled into the history at $0, so the agent learns whether a choice took instead of clicking again to find out — the repeat-guard stalls on Country and Rows-per-page were exactly that.

## The judge may not overrule a human record (S2)

`runFlow`'s auto-review: when the sheet's own Actual Result (`generation.knownResult`) exists and the judge's ruling contradicts it, the ruling is withheld with the disagreement on `notes` and the run stays `needs-review` for a person. PL_04_08: a human passed the case by hand; the judge ruled "failed" at 0.9 on "still visible contradicts hidden" without asking whether "not shown" meant hidden, disabled or inert. A machine's confident reading of two strings does not outrank a tester's hands.

Since 2026-08-31 the DEFAULT governor is deterministic (`RuleGovernorModel`,
same `GovernorModel` seam, effectively unbudgeted): measured across two live
suites, every LLM turn concluded `idle` while restating a set-intersection the
scheduler had already computed. The rules: name a fully-conflicting blocked
queue as a real conflict (once per distinct blockage), call out a compatible
case that is not dispatching, and shrink the pool one step after 3
timeout-shaped failures in 5 minutes (never below 2). `WOWLIDATOR_GOVERNOR=
model` restores the LLM governor — its remaining unique power is judging and
seeding a starved fixture (`db-write`); `off` disables both.

## A dependency wait is the scheduler's; the governor explains it (2026-09-04, EC catalog run `ec-runtest-csv@…09-33-38`)

Read from the panel's job-16 log and its ledger (39 cases, 10 lanes). Two shapes
of "depends on" refusal, neither the governor's:

- **PRB-EC-021 ← HIR-EC-064.** HIR-EC-064 ran in `[c31]`, its sign-in did not
  take (a runtime error, 22 s), and it was recorded `blocked`; PRB-EC-021
  (`[c34]`) was decided AFTER that, quoting it. The gate behaved: a dependent is
  never decided before its prerequisite ended. What was wrong upstream is the
  sign-in, not the queue. The wording "which never ran" for a case the harness
  ended is now "which could not run (runtime error — …)"; a refused/never-
  started case keeps "never ran".
- **Twelve E2E-nn references, fourteen rows.** `E2E-04`, `-11`, `-18`, `-42`,
  `-45`, `-46`, `-105`, `-115`, `-118`, `-119`, `-125`, `-128` are scenarios of
  another sheet ("Sheet E2E All Module", which the rows' own notes name); the
  CSV holds one sheet, and none of them is a Scenario ID in it. Scenario-id
  resolution (`linkDependencies`, 2026-09-04) is correct — these are external.
  They were fourteen identical per-row lines; the plan now says each ONCE,
  with the rows that need it (`unresolvedReferences`, `case-plan.ts`, printed
  by `cmdCatalog` right after `orderDependentsAfterSources`). A cycle is
  printed there too (`dependencyCycles`), before either side is blocked on the
  other at run time.

**Where the gate lives, and why.** `dependencyStanding` (`src/cli/case-plan.ts`,
pure) is the whole rule — wait while a prerequisite queued ahead is unfinished,
ready when every one passed, blocked with the prerequisite's own outcome line
otherwise (failed / review / never ran / could not run / not in this run /
queued after it / a cycle) — and `runCases` only supplies its lookups. It is
in the deterministic scheduler and not here because a dependent's verdict is
correctness, and this module's governor is an optimiser that may be absent,
off, erroring or out of budget without any verdict changing (the containment
rule at the top of the governor section). The governor OBSERVES the gate:
`GovernorCaseFact.waitingOn` carries the prerequisite a pending case is
parked on (set from `dependencyStanding`, never inferred here), the WAITING
prose line shows ` waits-for:X`, and the rules governor's queue-blocked rule
says `"B" is waiting on prerequisite A, in flight in lane N` (or "queued
ahead of it and not yet started" / "not yet queued") once per pair, keeps
such cases out of the "looks compatible yet has not dispatched" diagnosis —
which had misread every parked dependent as a scheduler fault — and answers
idle when the whole queue is parked on prerequisites.

**The queue defect this found.** `runQueue` dispatches in index order, and a
dependent's `false` from `canRunWith` held the HEAD of the queue: a ten-lane
pool drained to the one lane running the prerequisite while every case behind
the dependent waited on nothing. `canRunWith` may now answer `'defer'` (what
a dependency wait answers): the item is parked, the loop goes on, and parked
items are re-offered before each take, whenever a lane ends while a streaming
queue waits for its next authored row (the take races the lanes), and after
close until none is left; an exclusive dependent is parked the same way
instead of draining the pool to wait. A suite that never answers `'defer'`
takes exactly the path it always did — pinned by `tests/case-plan.test.ts`
("a suite that never answers defer takes the old path exactly"). The wait
still counts toward the queue-blocked event (25 polls), so a long one reaches
the governor and is explained rather than silent.

Tests: `tests/case-plan.test.ts` (`runQueue parks a deferred item…`,
`dependencyStanding…`, `dependencyCycles / dependsBackOn /
unresolvedReferences…`), `tests/queue-governor.test.ts` (`the rules governor
explains a dependency wait`). Live before/after on the EC catalog still to be
recorded: the 09:33 run never hit the wait (HIR-EC-064 ended before PRB-EC-021
was authored), so the number to watch on the next run is lanes in flight while
a `waits for` line is open — previously 1, expected the pool size.

## A readOnly run's finish is the answer, never a claim to refuse (2026-08-31)

The observed-state finish settlement (`goalOutcome`/`outcomeShown`) is skipped
when the run is `readOnly`: such a run cannot act, so refusing its finish to
make it "set" the state burns a turn by construction — and the triage look's
verdict travels IN its finish. Found live: the look's goal text parses as an
outcome, the settlement refused the verdict once, and every `fail` verdict
cost two model calls instead of one (tests/smoke.test.ts pins one call).

## The model copies the tree's notation back as a selector (2026-09-02)

`region "Dependents Dependents"`, `spinbutton "Day Day"`, `heading "National ID
/ Tax ID"` — the AX tree's own line shape, handed back as a selector and read by
Playwright as a CSS tag with a stray string. Live (ec10 HIR-EC-003) five such
misses in a row ended a leg as a stall while the same model had written the
correct `role=…[name=… i]` two turns earlier. `normaliseAgentSelector`
(`src/engine/selector.ts`) rewrites the line to the role selector before the
grounding guard sees it, in `LlmAgentModel.decide`, for the decision and every
planned step alike — see the engine CLAUDE.md for the rule and its siblings.

## A leg off its page has a small allowance (`wanderedOffPage`, `AGENT_OFF_PAGE_TURNS`, 2026-09-03)

Live (HIR-EC-002, 2026-09-03 13:00 run): steps 16 "Reopen the saved New Hire"
and 19 "Leave the New Hire form" burned 903 s of a 1,377 s case. Each leg left
the step's page (/en/admin/hire/draft → /en/requests → on through the admin
area) and every goto or click onto a fresh page was progress by the no-progress
judge's own rule (`advanced`: an ok interaction, or a goto to an unvisited
URL), so nothing but `DEFAULT_AGENT_MAX_STEPS` (60) ended them, at ~7 s a
turn. The judge that should have fired did not exist: no rule distinguished a
journey from a wander.

`wanderedOffPage(goal, startUrl, url)` (`goal-evidence.ts`, pure): the page is
on a different origin or path from the step's start (`differentPage` — a
`?step=` change is the same page) **and** not at the destination the goal
names (`goalDestination`/`atGoalDestination`; a goal naming none has nowhere
off its page that counts). While that holds, the loop spends
`AGENT_OFF_PAGE_TURNS` (8) — a turn counts when it moved the page again or only
clicked; a turn that lands a **first-time form entry** (`FORM_ENTRY_ACTIONS`:
fill, type, paste, selectOption, check, uncheck) off the page is free, because
"open the form and fill it" legitimately lives off its start page for fifteen
turns and a literal turn budget would cut a passing leg. Returning to the
start page resets the allowance; a consent URL is the gate rung's to clear and
is never counted (`CONSENT_GATE_URL_PATTERN`); arriving at a named destination
still ends the leg by the destination rule before this one is consulted. Past
the allowance the leg ends with `agent wandered: left the step's page … spent N
turn(s) elsewhere … without reaching …`, naming the page it is on. Lifted to
`AGENT_NO_PROGRESS_OFF_TURNS` when early-stop is off, like the other two
judges (`#offPageTurns`). Why it cannot slow a passing leg: a journey to a
named destination is two to four page moves and arrives before the eighth; a
leg whose work is on one other page pays nothing for the entries. Tests:
`tests/goal-evidence.test.ts` (`wanderedOffPage`), `tests/agent-guards.test.ts`
(the constant's place among the ceilings). Measured on the HIR-EC-002
benchmark (`e2e-02/02-…flow.json`, 2026-09-03 12:59 UTC, both rails, agent on
opus): 558 s / 56 agent requests / 1.03M in-tokens / agent 296 s, longest
leg 57 s — against the 13:00 run's 1,377 s / 182 requests / 3.55M / 1,188 s
with steps 16 and 19 at 425 s and 478 s. The former wanderers (now steps 18
and 20) ended in 56 s and 38 s by the agent's own `unreachable`; the
allowance's stop message itself did not fire on either benchmark, and on ec09
HIR-EC-009 (job-3, 12:39 UTC) no leg wandered at all.

## The same control on the same page is not progress (`reactivation`, 2026-09-03)

Live twice in one day. ec09 HIR-EC-009 job-3 leg [14]: 320 s / ~60 turns
re-clicking section headers on one wizard page — every click ok, every ok
click resetting the no-progress judge, and `repeatedToggleClick` (three per
selector, whole run) worth thirty-six free turns across a dozen headers. Then
job-2, the Position / Employee Sub-Group picker: 122 agent requests and 18
minutes of ok `fill` into `role=textbox[name="Search options" i]` with a
different search string each time ("40106337", "401063", "MKB12.12", "",
"4010", …), between failed `selectOption`s on the button and ok re-clicks of
it. The judge saw an ok interaction on every turn.

`reactivation(decision, url, activatedHere)` (`agent-guards.ts`, pure) reads an
ok activation (`ACTIVATION_ACTIONS`: click, press, hover, check, uncheck, fill,
type, paste, selectOption) against the selectors already ok-activated **on
that URL this leg** (`activationKey`; a miss records nothing, and the same
selector on another page is a new control): `first`, `repeat` (a click-shaped
re-activation), or `text-again` (another fill/type/paste into the same field).
`reactivationAdvanced(kind, treeChanged)`: `first` is progress as before;
`repeat` is progress **only if the full tree changed after it** — the loop
re-reads the tree for that case alone and charges the credit to
`AGENT_TREE_CHANGE_CREDITS`, shared with the scroll/wait looks, so a control
that toggles forever still ends the leg; `text-again` is **never** progress,
because the typed value is echoed into the tree's `value=` and would pass a
change test on its own evidence (the picker's six strings would each have
been credited). A turn not credited for this reason tells the model so in the
history. `repeatedToggleClick` is untouched — it refuses the fourth activation
outright; this rule only decides whether an ok one counted. Why it cannot slow
a passing leg: a multi-select re-opened once per pick changes the tree and is
credited; a search box used twice has a pick between the fills, and the pick
is `first`. Tests: `tests/agent-guards.test.ts` (`reactivation`, with both
legs' action sequences as fixtures). Measured on ec09 HIR-EC-009 (panel
job-3, 2026-09-03 12:39 UTC, agent on opus): case 533 s / 55 agent calls /
1.43M in-tokens, agent time 262 s, the five workflow legs 14–77 s each and
every one ended by the agent's own honest `unreachable` — against the morning
run's 1,090 s / 122 calls / 3.4M in / 763 s agent time (old prompt, old
loop). The stall message itself never fired: the history note handed back
on a re-activation was enough for the model to stop hunting. Job-2 in between
(new prompt, old loop) had cut leg [14] to 40 s but was at 122 requests on
the Position picker when it was interrupted.

## The agent runs as whoever is active (2026-09-03)

`SmartRunner.workflow` hands the agent `this.page`, and `page` is a view of the active `PersonaSession` — so after `signIn MANAGER_ACCOUNT` the leg runs in the manager's own Chrome, and the step's record carries `persona` and `browser`. Nothing in the loop changed; OA-15 stands: a goal naming two people is still refused, and the authored form is two legs with a `signIn` between them.

## Two people, one address (2026-09-04)

Two corrections to the loop, both from the same case shape: a catalog row that
changes hands — the manager submits a probation review, the approver approves
the same case — where both legs start on the same URL with near-identical goal
wording.

**The replay memory is keyed by persona.** `replayKey(startUrl, goal, persona)`
takes the active persona's LABEL, fed from `RunOptions.persona`, which the
runner supplies from `activePersona` at every `#agent.run` call site that passes
`memory` (the `workflow` step, the entry rung, the heal pass). Without it the
second leg replays the first person's recorded journey on the second person's
browser, at zero model turns, and reports success — the very hazard
`#deadResolutions` was already keyed by persona to avoid, its comment saying so
outright: *an employee's 403 page and the manager's real page share a URL and
nothing else*. The agent's memory had not been given the same treatment.

The label is used for the key and for nothing else. It is never put in a
prompt, never offered to the model, and carries no email and no password — the
agent has no sign-in verb and no credentials by design, and this must not
become the hole in that. A run with no personas passes `undefined` and its keys
are byte-identical to before, so no cache entry written earlier is orphaned.
The trade is deliberate: on a multi-persona run a leg that could have replayed
another person's journey now pays the model instead. Correctness over a saved
turn, and only where two people are actually involved.

**A refused goal is an authoring fault, not a broken feature.**
`multiPersonaSummary`'s `multi-persona goal:` prefix was declared to be "the
protocol `run-cases` reads so it can file this as an authoring refusal" and had
no reader anywhere in `src/`. The refused leg fell through to the ordinary
failed-leg path and became `functional` / `high`, "Workflow goal not reached" —
a fact about how the goal was worded, filed as a defect in the application under
test. `personaRefusal(summary)` in `goal-evidence.ts` is the reader; the runner
branches on it beside the provider refusal, records the step `error`, files **no
defect**, and throws a message naming the fix. Like `agentModelUnavailable`, it
can only be true of a summary produced by a return that happens before turn 1,
so it can never change the outcome of a leg that actually ran.

## Action authority: the mutation gate, the provenance ledger, and `blocked` (Phase B, 2026-09-05)

Phase B of `docs/research/commerce-agents-patterns.md`. The loop refused an
unscoped destructive click since PL_03_18, but three things were still missing:
an identifier in the goal was taken as proof the session had seen the row; a
batch had no way to say which categories of change it permits; and a refusal
was an `ok: false` with a prefix in `error`, which every reader had to parse to
learn that the application was never touched. All three live in
`mutation-policy.ts` (pure) and one choke point in the loop.

- **`ActionOutcome` on every `AgentAction`** (`engine/proof-bundle.ts`): `ok`,
  `failed`, or `blocked` with a machine-readable `reason`
  (`capability | provenance | approval | guardrail`), `rule`, `category`,
  `target`, `policySource` and, for a provenance hold, the ledger's facts. The
  boolean `ok` and the `error` string stay for every reader that predates it.
  The existing destructive-scope and circling refusals are typed `guardrail`
  and end the leg as blocked.
- **`TargetProvenance`** is fed by `#captureTree` — the ONE way the class reads
  the accessibility tree — and by nothing else: not the goal, not the model's
  reasoning, not the selector it emitted. Reset at the top of every `run()`. A
  `delete`/`approve` click must scope to identifiers that were observed this
  session AND are in the latest capture, which the gate re-reads at the moment
  of the click (`#provenanceForGate`), so a row that scrolled away, was
  filtered out, or was already deleted is never acted on because it was once
  on screen.
- **`MutationPolicy`** is the host's manifest (`WOWLIDATOR_MUTATION_POLICY`,
  `WorkflowAgentOptions.mutationPolicy`, `RunOptions.mutationPolicy`,
  `SmartRunnerOptions.mutationPolicy`): `allow` (exhaustive when present),
  `deny` (wins), `approved` entries for the irreversible categories, and an
  `approveMutation` hook for the host's explicit yes. Categories are read off
  the accessible name of the control the click lands on (`mutationCategoryOf`:
  `delete`, `approve`, `submit`); everything else is ordinary and never gated.
  Without a policy manifest, provenance is enforced, capability is
  unrestricted, and an irreversible action still requires the host's explicit
  approval hook. Goal text and model output can never supply that approval.
- **The gate runs inside `#act`**, before the browser is touched, so a planned
  follow-up, a replayed script and the menu walker all pass it. A held
  mutation is terminal for the leg (`WorkflowResult.blocked`): another model
  turn does not change a policy, insisting does not make a row observed, and
  an approval cannot be talked into existence. The runner records the step
  `error` with `ProofStep.blocked`, files **no defect**, throws
  `MutationBlockedError` (an `error` in `classifyStepFailure`, futile for
  reconstruction), `harnessOnly` names it `blocked (reason, rule)`, and the
  case scores blocked — exit 3, never 1. The report shows a "Held by the
  run's rules" callout, the panel a `HELD (…)` line.

Tests: `tests/mutation-policy.test.ts` — the gate, the ledger and the manifest
parser (pure), and the loop under a scripted model on a real page (CDP): an
unobserved id, a row that vanished, an observed row under an approving policy,
a denied category, a missing approval, the host's yes, an ordinary journey
under the strictest policy, and a `runFlow` whose held leg is an error with no
defect and a held report.

