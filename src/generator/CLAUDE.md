# CLAUDE.md — authoring and its rails

Split out of the root CLAUDE.md (2026-08-24) so this loads only when working under
`src/generator/`. Same authority as the root file; the root keeps the map of the whole system.

## The authoring review (`src/generator/flow-review.ts`)

The commonest way an authored case ends in `dead-end` is not a broken application — it is a step written with nothing behind it: a control named from the requirement's wording rather than the tree, a destination guessed from a label, a leg after a `workflow` step on a page no capture ever saw. Each one spends the whole ladder, a healer call and a reconstruction call at run time to rediscover that the evidence never contained it. The lints refuse the shapes a string check can name; the review is the level above them, run inside `FlowAuthor.author` after every lint has had its say, default on (`--no-author-review` disables; no agent key degrades silently — the unreviewed flow is the flow we always wrote). Three parts, in cost order, the ladder's rule applied to authoring:

- **`auditGrounding` — $0.** Every step against the evidence the author was given: a role/name selector must name something in a captured tree (start, journey, probe); a `goto` must be a declared route or a tree link (**a goto is not its own evidence**); an `expectUrl` may also rest on a goto before it; a `workflow` goal's destination must be a declared route. The page the evidence was captured from counts as existing. A truncated tree is not judged for selectors, same rule as the lints. Only the findings go on.
- **One `agent`-role call, only when there are findings** (`LlmFlowReviewModel`, flat schema via `lenientObject`). The model sees the flagged steps, the whole flow, the trees, the declared routes, the repository's context slice and the request as the author saw it — the documents — and says per step `keep` / `replace` / `insertBefore` / `unsure`, quoting the evidence line. It may change **what a step points at** (selector, url, goal), never what it does: action, typed value and asserted text are the claim, and the claim is the author's. `insertBefore` admits preparation only (click, waitFor, goto, press, scrollTo, clickIfVisible→`when`).
- **Every proposal is verified before it is applied** (`applyReview`). A selector's name must be in a tree or in the evidence text (source index, documents); a path must match a declared route or appear in the evidence; a decision with no evidence quoted is dropped; a decision about a step the model was not asked about is ignored; a flagged step it says nothing about is `unsure` by omission. Rejections are recorded with the reason. Replacements mutate the step object in place so the case list sees them; insertions are spliced into the section **and** the case holding the step.

**Only findings some evidence could settle are asked about** (`settleableFindings`, 2026-08-31). Measured on be100-rip: the run's log is a wall of `the review could not ground it either — No tree captured for this page state`, every one of them an `unsure` the audit had already computed for free. A **selector** finding is unanswerable when all three hold — it follows a `workflow` leg so no tree covers its page, the evidence carries no repository slice, and its control's name appears nowhere in the evidence text; under those, `applyReview` would reject any `replace` and the audit already disproved `keep`. Such findings become a note naming the actual remedy (a capture of that page, or `--repo`), and when *every* finding is one the call is not made at all. **Path findings are always asked** — a route is settled by a declared pattern or a document sentence and needs no tree. The record still counts what the AUDIT found, so a skipped call never shrinks the reported problem. The reviewer is handed the **row's own** context slice, not the project-wide one: it judges by the evidence the author saw, and the row's slice is what that is.

The record (`AuthoredFlow.review`) is printed by the CLI (`review  N ungrounded step(s): …` plus one line per change and per rejection) and summarised on the flow's `notes`. A model fault never throws: the flow is as authored, the record says the review could not run. `tests/flow-review.test.ts` is entirely unit-tier.

## The suite's refusal memory (`flow-author.ts`)

The informed re-ask teaches one row at a time, and the teaching dies with the row. Measured on be100-rip (2026-08-31): the same two or three lints fired across the whole catalog — an `expectDbRows` on the case's own test data, a `workflow` goal naming controls the repository declares — and each cost a fresh authoring attempt (57 s, ~$0.44 on opus) to re-learn a rule the row before had already been taught.

One `FlowAuthor` writes a whole catalog, so the memory is suite-scoped by construction. Three rules, each with its reason:

- **Keyed by SHAPE, not by message** (`refusalShape`): quoted names, step indexes and numbers are stripped, so six variants of one lint collapse to one entry instead of filling the budget.
- **A rule travels only once it has been seen twice.** One row's accident is not the suite's pattern, and pre-loading it onto unrelated rows is how a memory turns into a bias.
- **It is a separate prompt field** (`AuthorRequest.commonRefusals`), rendered under its own heading before the row's own `feedback` and never merged into it. `feedback` says "your previous answer to THIS question was wrong", which is a fact; this says "the suite keeps making this mistake", which is a warning — wording the second as the first on a first attempt would be a lie the model would then try to fix.

Bounded at `SUITE_REFUSAL_MEMORY` (6), most frequent first: a lint that fired twenty times is the one worth pre-empting, and a long list would crowd the request itself out of the model's attention.

## Authoring rails from a hand-authored comparison (`flow-author.ts`)

One prompt from the run history was authored twice by the model and once by hand, the hand-written flow being read out of the application's own source and then run until it passed (30/30, no heals). Every difference became a rule, and the checkable ones became lints with the ordinary informed re-ask:

- **`countPinnedName`** refuses a live count inside an accessible name — `role=tab[name="Status (1)"]`. That number counts whatever the application holds *now*, including rows a seed or an earlier run left, so the selector works once and then heals: green, having paid a model call to rediscover that the number moved, and it will pay again next run. Names that merely contain a number ("OT Day 1") are untouched — the trailing parenthesised form is the count idiom specifically.
- **`interruptedCredentialSubmit`** refuses any step between the credential fills and the submit click. Not style — measured: the hydration replay (`nativeFormResubmitDetected`) recognises *an adjacent fill block plus click*, and one `expectValue` in that gap stopped it firing, the click degraded to the form's native GET, and a flow that passed 31/31 stopped logging in at all.
- **`unpinnedDateEntry`** refuses a typed `YYYY-MM-DD` with no `setClock` in setup. Date fields are gated on a window computed from *today* — the live case rejects any date outside the current 21st-to-20th payroll period — so an unpinned flow passes this week and fails when the window moves, blaming the field.
- **`unsettledWorkflowClaim`** refuses a `workflow` step nothing checks afterwards, where `expectUrl` deliberately does not count: a URL says which page is open, not that the thing happened. **It is the one lint here that stops refusing on the last attempt** and records the complaint on `notes` instead. Every other lint refuses a claim that is *false*, where refusing beats emitting; this one refuses a claim that is merely *thin*, and measured, the hard refusal turned a runnable-but-weak flow into no flow at all — the re-ask came back with one step and no assertion. "Feedback must never make the result worse" is already this file's rule for `vacuousFormAssertion`; a note plus a line in front of the person keeps the pressure on the model without the person paying for the model's second answer.

Six prompt rules carry the parts no lint can check: assert the value the page **computed** (a visibility check on a total passes whether the arithmetic is right or wrong); identify a record this flow created by **a value this flow typed**, so "MY row appeared" is the claim rather than "a row appeared"; quote the application's own status wording (a store's `pending` renders as "Awaiting manager"); claim the **database only when the evidence shows the page reaching a backend** — plenty of screens persist to client-side storage and make no request at all, and asserting a row against one of those files a high backend defect against an application working exactly as built; and start from a known state (`clearStorage`, then `goto` again so the app rehydrates from empty) when the journey creates something the application keeps.

**The table inventory is narrowed by relevance** (`TABLE_INVENTORY_MAX`, `bm25` over name + columns, the description as the query). Measured on the live prompt: **386 tables → 9**, and the authoring call went from **56,237 to ~7,000 input tokens** — the inventory had been 50,310 of them, 89% of the prompt, against 63 tokens of what the person actually asked for. Cost is only half of it: the full dump offered four near-identical candidates (`ot_request`, `ot_request_detail`, `ot_request_decision`, `ot_request_attachment`) for one journey, and which one comes back is exactly the coin-flip that makes two runs of one prompt disagree. A description that matches nothing keeps the whole inventory — presence of the inventory *is* the permission to author a DB check, so narrowing to an arbitrary forty would silently remove the capability.

**What none of this fixes, and it is the ceiling on the whole describe path:** the author reads the AX tree of the page the run *starts* on. For "log in, then create an overtime request" that is the login screen, so the entire form is invisible and the middle of the journey goes to a `workflow` step whatever the prompt says. The repo graph can name the destination; only a capture of that page can ground selectors on it.

## Claim-fidelity rails (born from the PB/DB catalog post-mortems)

Every rail below exists because a prior run produced a **false claim** — a green pass that proved nothing, or a red defect about an app that worked — and each names the live case that forced it.

- **The authored deliberate-HTTP family** — `request` / `expectStatus` / `expectJson` joined `AUTHOR_ACTIONS` (flat forms: `name` = `"METHOD /path"`, saves in `key` as `"var = $.json.path"`), because an API-level claim used to be authorable only as a `goto` to the endpoint (a GET against a POST route — DB_07's seed "restore") or as an `expectCalls` the page never fires (DB_09: a high **backend** defect filed against a healthy seed endpoint the run sent zero requests to). The prompt's PLANE RULE says it outright: `expectCalls` watches traffic the *page* makes; a call only the test can make is a `request`. The runtime failure text for a never-observed expectCalls now names the same hazard. Authored `request` verbs are policy-filtered structurally (`REQUEST_VERBS_BY_POLICY`; DELETE at no tier), the `ApiTestGenerator` precedent.
- **`expectDbCount`** (authored) narrows to `expectDbRow` with an exact `count` and empty/partial `where` — and `count` may be a `{{variable}}` string, interpolated at run time. That composition (`request` saves `$.counts.persons` → `expectDbCount` compares it to SQL) is THE cross-check for "the API's number equals the database's number", which DB_01_01 was passing without ever reading a number.
- **`setClock`** pins the page clock via Playwright's clock API (`#bareStep`, in setup, before the first `goto`; verified working over CDP). It exists because PB_04_01 "passed" 13/13 while exercising zero of the four boundary dates it named — a time-dependent claim without a pinned clock tests whatever today is. The author prompt requires it for days-remaining/due-date claims and refuses to let an arithmetic claim be reduced to label-visibility (the "computed claim needs the computed value asserted" rule — PB_01_01's 119-vs-120 defect went undetected behind an `expectVisible`).
- **The hydration replay** (`nativeFormResubmitDetected` + the replay in `executeSteps`): a Sign-in click that lands before the app hydrates degrades to the form's native GET submit — credentials in the URL, no session, and (formerly) every body step dead-ending against `/en/login` as high "frontend" defects. Detection is evidence-based (a password-named query param, or a typed value echoed in the URL) and gated on a credential-shaped fill block so ordinary clicks never pay the recheck. The recovery replays the fill block + click once after `networkidle`; the finding is filed as `usability`/`medium` **and is an app fact too** (a login form that degrades to GET exposes what was typed). Companion authoring lint `unsynchronizedLoginSubmit`: a credential submit immediately followed by `goto` is refused with the informed re-ask — the prompt now demands a post-submit assertion.
- **The session guard exemption is per-goto** (`#lastGotoAskedSignIn`, not a run-wide flag): a flow that logs in first always has a login `goto` in its past, and the run-wide flag exempted exactly the case the guard exists for — a bounced post-login navigation. Only the most recent `goto` says what the flow means to be looking at.
- **A dialog opened by the previous click/press is the intended context, never a blocker** — the ladder's dialog rung no longer dismisses it (DB_07: the rung closed the "Edit rule" modal the test had deliberately opened, destroying the state and cascading four false defects). Left open, the step fails honestly and the healer reads a tree that *contains* the dialog — where the right candidate lives. `expectModal`/`closeModal` are authorable now, and the prompt says to assert the modal before filling its fields.
- **The timing re-check only downgrades genuine resolution failures**: a content mismatch (`expected text to contain`) or an intercepted click re-probes to "TIMING, not absence" only in the sense that the selector resolves — which was never in doubt — so those are excluded (DB_06: a failed `expectText body` downgraded to timing because `body`, of course, resolves).
- **Failure wording follows the failure's shape**: all-content-mismatch attempts headline as `"…" resolved, but its content did not hold` (never "could not resolve" — PB_05_01's control was on screen the whole time); an `expectHidden` timeout reads "stayed on the page", not "never found" (PB_03_01's inversion); and a failing step recorded on a sign-in URL overrides the verdict's frontend/backend side copy with the stranded note (`VERDICT_COPY.strandedSide`).
- **The sheet is read whole**: `Login / Persona`, `Preconditions` and `Note` columns now reach the author verbatim (`describeCase`) and the Note lands in the claim text — the KNOWN-FAIL notes and "the SQL is the only authoritative proof" caveats are exactly what decides an honest assertion. `beyondHarnessReason()` marks a row whose steps stop services (`brew services stop …`) or whose claim pivots on a direct SQL write as `testable: false` with the boundary named — narrow on purpose; a validation SELECT or a cleanup command in the steps strikes nothing.
- **Lane edits are recomputed server-side too** (`recomputeLaneTestability`, applied when `--claims` reads a file with a `sequence` block): a plane corrected by hand in the JSON now takes effect exactly as in the panel's lane editor, the boundary suffix on `source` is re-derived, and a database-named lane marked `user`/`page` earns a printed warning — the browser cannot observe calls a server makes, and a lane confirmation that says otherwise manufactures claims that must fail (seen live: a DB lane "confirmed" as user produced a high backend defect about traffic the browser could never see).
- **A catalog with database claims but no schema indexed says so loudly** in `cmdCatalog` — the author structurally cannot emit a DB step then, and the silent degradation to UI-text proxies is how DB_01_01's vacuous pass happened. `wowlidator context add <repo> --db-schema …` (or `WOWLIDATOR_DB_URL`) plus `--repo` is the fix the message names.
- **The hydration race has a second signature: lost fills.** A pre-hydration click sometimes navigates nowhere at all — React hydration RESETS the controlled inputs, the click submits an empty password, and the page just stays on the login screen with nothing in the URL to detect (run 4's DB_04/06/07, three re-clicks each, none re-filling). `fillsLostToHydration` reads the filled fields back after a credential-block click when the URL signature is absent; a field holding a different value than what was typed triggers the same wait-and-replay, recorded by `recordLostFillFinding`.
- **`expectDbRow`'s failure names which half failed.** `found 0` over a where that matched 1 row hid that the VALUES filter was the miss (run 4's DB_07: the row existed at 72000/mock-seed; the 75000/cnext-ui values never held because the edit never happened). The message and record now carry the redacted values summary and the where-only match count.
- **Two more vacuity lints, both from run 4's audited passes:** `dbClaimWithoutDbCheck` (a claim comparing something to the database, tables declared, zero expectDb* steps anywhere — the DB_01 "counts match exactly" case that asserted only `$.counts` exists) and `loginProofAssertsLoginPage` (a post-submit `expectUrl` of the sign-in path itself — an assertion that holds precisely when the login did NOT take; DB_02's "redirected away" that expected `/en/login`). Both feed the ordinary informed re-ask.
- **A check generated out of the test's scope is re-judged for necessity** (`typedCredentialValues` / `credentialEchoAssertions`): an assertion that a credential the flow itself typed is DISPLAYED came from the input side of the test — the persona lines put the email in every request, which is exactly where the model found it — and it fails on every run against a working application (PL_02_02: `expectVisible text="admin@cnext.test"` against an identity plate that renders name, role and user id, never the email; 42s of ladder, healer and reconstruction to disprove a string the tree never contained, then a high defect). The request text can never rescue such an assertion; the evidence tree can (a page seen to render the value makes it grounded). When the claim's own assertions carry the proof, the echo is dropped mechanically ($0, disclosed on `notes`); only when it is all the proof there is does it earn the informed re-ask. `expectHidden` is never flagged — a credential NOT displayed is a legitimate claim and the canonical login proof's own action. The prompt's sign-in step 4 states the other half: quote the identity from a tree, never from what the flow typed.
- **Expected values are the sheet's word, and a citation is a pointer, never a licence to invent (2026-08-24).** The authoring prompt's EXPECTED VALUES rule (`buildAuthoringPrompt`) says to quote the test case's own expected output exactly; when a row defers to another source for its value ("as per the Master Benefit List", "ตามเอกสาร Requirement"), `referencedSources()` in `catalog/retrieve.ts` extracts the cited phrases (English + Thai markers; bare `ตาม` needs a document-ish noun — "ตามเงื่อนไข" is not a citation) and `authorEachRow` boosts them in the per-row BM25 query (repetition — term frequency is the lever BM25 has) and in the repo-slice ranking, so the cited section outranks sections that merely share step vocabulary and the value is quoted from the source. A value neither the case nor the retrieved context states is not asserted.
- **A wording claim is asserted on labels the spec owns, never on a data row (2026-08-25).** `wordingClaimAssertsDataValue`: when the claim is about spelling/wording (`ข้อความ`, `สะกด`, "label", "wording"…) and an `expectVisible text=…` / `expectText` value appears neither in the test case's words nor in a non-data node of the evidence tree (heading, columnheader, button, link — never `cell`/`row`/`option`), it earns the informed re-ask. PL_02_02's "ข้อความสะกดถูกต้องตรงตาม Spec" was authored as `text=Medical Reimbursement` — a plan name the sheet never mentions; a sibling delete case had removed the plan, and the case dead-ended against a correctly worded page while its earlier authoring (`text="Benefit Plans"`, `text="Benefits Admin"`) had proved.
- **The backend toggle (`--no-backend`, `FlowAuthorOptions.backend`; 2026-08-25).** A run may declare that it does not test the backend at all. Off, no `request` / `expectStatus` / `expectJson` / `expectHeader` / `expectCalls` / `dbSnapshot` / `expectDb*` step is written — the family is dropped in narrowing with `BACKEND_OFF_REASON`, and an indexed schema stops being permission (`allowDb` requires the toggle too). The prompt tells the model to prove each claim through the PAGE instead, and — when a backend check would prove it better — to mark that step by beginning its `intent` with `backend could prove this: …`. The marker is lifted off the intent at `ProofBundleBuilder.addStep` into `ProofStep.backendHint`, shown as a `visual only` tag in wowUI and a callout in the report. Never a defect and never a verdict: the visual check really did pass; the note says a stronger proof exists and this run was told not to take it. **On is the CLI default**, so every existing script and catalog behaves as it always did; the panel offers it as opt-IN (most runs have no database) and states its choice explicitly in both directions via `Field.offFlag`. Turning it on makes the Database URL field required (`Field.requiredWhen`) — a DB claim with no database is a case that dies ten minutes in.
- **A `goto` must name a page the codebase declares (2026-08-26).** `ungroundedGoto` refuses a navigation to a path the indexed repository has no route for, carrying the nearest declared routes into the refusal. PL_02_03 navigated to an invented path, got a 404, and every step after it failed against the error page — filed against the application. Silent without an index, and about another origin, which is not this application's routing table's business. The runtime half is in `src/engine/CLAUDE.md`, "A 404 is two findings".
- **An authored `request`'s METHOD is checked against the indexed operations (2026-08-25).** `unindexedRequestMethod` refuses a `request` whose path the repository declares and whose verb it does not, naming the verbs that path does answer. PL_03_03 called `GET /api/benefit-plans` against a handler exporting POST/PUT/DELETE; the app answered 405 and the run filed two `high` defects against correct behaviour. It fires only when the path IS declared — an endpoint outside the index (a proxy, another host, an unindexed repo) says nothing, and silence must not become a refusal. See `src/context/CLAUDE.md`, "An endpoint is a method AND a path", for where the operations now come from.
- **A model's typography is not evidence:** a selector that is a CSS comment (`/* selector for X not found */`) narrows to no-selector and is dropped (DB_08 burned its whole reconstruction budget parsing one), and U+2011 non-breaking hyphens in selectors normalize to ASCII (`RULE‑FUEL‑002` can never match the ASCII row it means).
- **`workflow` legs are allowed on pages the capture never saw** — the authoring tree describes ONE page state, and DB_04/06/07's modal and row controls are structurally absent from a login-page capture. The prompt now permits a precisely-goaled workflow step for exactly those legs, with the rule that the claim must then be settled by evidence independent of the agent (a DB check, a request assertion, page content read afterwards) — the same "prepare, never perform" honesty applied at authoring scale.

## Negative testing (`MutationPolicy`)

Three tiers on `TestGenerator`, default `mutations` since 2026-09-02 (`DEFAULT_MUTATION_POLICY` in `test-generator.ts` is the single source):

| Policy | May do | Never |
|---|---|---|
| `read-only` | navigate, read, assert | submit anything |
| `forms` | submit **empty/invalid** input to exercise validation | submit valid data that writes |
| `mutations` | fill, submit, create and update — like a human tester | delete, purchase, bulk ops |

`mutations` is the default by request: a human QA fills forms with real data and submits them, and the suite is expected to do the same out of the box. The knob stays — `--policy forms` narrows to validation-only negative testing (its own load-bearing tier: an empty-required-field submit is not destructive, and verifying validation is a real surface), `--policy read-only` to navigate-and-assert for a page where even an invalid submit is unwelcome. DELETE appears at no tier, and `mutations` still refuses purchases and bulk/irreversible ops. The filter is still structural (`REQUEST_VERBS_BY_POLICY`, `POLICY_RULES` + every step re-checked on the way out), not a prompt request.

## Boundary-value analysis (`fillEach`)

One field, several values, an assertion after each. **Every case runs even after one fails** — a partial boundary table is far less useful than the whole one when you are trying to find where behaviour changes.

`submit` is the load-bearing option: validation usually fires on submit, not on input, so without it every case asserts against a form that never ran. That was found by running it, not by reading it.

## The tree's rendering, never the sheet's wording — the guarantee (2026-08-28)

The same case authored by two models, both flows run today with no model in the loop: gemini-3.5-flash-lite asserted `role=heading[name="Benefit Plan Catalog…"]` and passed; claude asserted `text="Benefit Plans"` / `role=heading[name="Benefit Plans" i]` — the requirement's phrase — and dead-ended three times on a page that renders the heading. The LANGUAGE rule in the prompt was a request; `ungroundedTextExpectation` (pure, beside `ungroundedCountRole`) is the guarantee, provider-independent: a presence assertion (`expectVisible`/`expectText`, `text=` or `role=…[name=…]`) whose text is a contiguous case-insensitive substring of NO rendered node name is refused with the nearest real renderings named ("The page renders: "Benefit Plan Catalog" — quote one of those, with its role"), and the ordinary feedback re-ask does the rest. Grounding strips `url="…"` first — word-wise matching would ground "Benefit Plans" on `/benefits/plans`. Exempt after a `workflow` leg and on a truncated tree, the `ungroundedUrlExpectation` rules. Companion in the engine: `relaxTextSelector` now relaxes the HEAD of a chained `text="X" >> nth=0` (every such selector used to skip the rung), so a rendering that differs only in case or surrounding text still resolves at $0.

## No selector may assert a control's implementation (`inventedControlInternals`, 2026-08-28)

A selector like `main select:has(option:text-is("Medical"))` or
`… >> option:checked` is refused at authoring: no accessibility tree ever
shows `<select>`, `<option>` or `:checked` — the tree speaks roles — so an
internals selector is invented by construction, and it dead-ends on any
custom widget. Live driver: PL_04_04 pinned thirty-one steps to a native
`<select>` on a page whose category filter is a custom combobox; every one
failed identically. The refusal steers to the two legal shapes: the control's
role and visible label from a tree it appears in (`role=combobox[name="…" i]`
— `selectOption` drives native and custom dropdowns alike through it), or a
workflow goal in user terms when NO tree shows the control. It also carries
the semantic rule the case's wording needs: a default written "All" / "No
filter" is a state the user can see (the control's visible value, an
unfiltered listing), never an `option:checked` internal. `role=option[name]`
stays legal (tree notation); quoted strings are stripped before matching so
`text="Select all"` never trips it. Tests: `tests/flow-author.test.ts`.

## Code-grounded authoring — deterministic first, agent on error only (2026-08-28)

Asked for in so many words: if a part of the journey can be proved by reading
the codebase, the author writes it as deterministic Playwright steps; the
agent's job shrinks to the part an error actually reaches. Three layers:

- **Prompt**: grounding order is tree → repository → workflow. When a control
  is in no tree but WHAT THE REPOSITORY DECLARES names its rendered string (a
  component's words, a message catalog's values — both already in the graph),
  the step is written against that string (`role=button[name="Create Plan" i]`);
  a workflow leg is legal only where neither a tree nor the repository declares
  the control. The tree still outranks the code where they disagree.
- **Lints**: `declaredControlStrings` extracts the repo section's quoted
  strings (one extractor, so "declared by the code" cannot mean two things);
  `ungroundedTextExpectation` accepts them as evidence (else every
  code-grounded assertion the prompt invites would be refused);
  `workflowOverDeclaredControls` refuses a workflow goal that names a declared
  control, steering to explicit steps and telling the model to keep the goal
  to what is genuinely undeclared. (PL_07 spent 108 model calls on an agent
  leg whose "Make Correction" control `messages/en.json` declares verbatim.)
- **Runtime**: suite runs arm the agent-assist rung whenever an agent was
  built at all (`run-cases.ts`) — so the agent is consulted only at the step
  that actually failed, after the $0 ladder and the healer. `--no-agent`
  disables both; fail-fast still strips assist.

## Expected results are quoted, never invented (2026-08-28)

Driven by PL_03_07: the sheet asked "+1 in Total Plans / +1 in Reimbursement
by Employee and HR" and the authored flow proved a DB delta and a visible row
name — real checks of a different claim, with intents citing "6.1/6.2" over
assertions that never read the counter boxes. Three rails:

- **Prompt**: every NUMBERED Expected line gets its own assertion in the page
  terms that line names, intent citing the line number; a backend check may
  corroborate, never substitute. Every asserted value is quoted from the case
  (Expected / Test data / Note), a document, or the repository — in that
  order — and when none holds one, the flow says so in notes and asserts the
  observable shape instead of inventing.
- **Coverage lint** (`expectedItemsIn` / `unassertedExpectedItems`): numbered
  ids with no asserting carrier (assert step or workflow goal citing the id)
  are refused WEAK — the re-ask drives the rewrite, and an uncovered flow at
  budget end is still handed over with the note, never left flowless.
- **Contextual-sufficiency check** (`expectedLacksAnchors`, authoring loop):
  an Expected with no number, no `field = value` pair and no quoted span
  across Expected+Note+Test data boosts the expected text in the BM25 query
  (the citation-boost lever) and stamps a one-line instruction into the
  described case: anchors come from the documents/repository, never invention.
  Also: the runtime card's Test data cut went 120 → 420 chars — PL_03_07's
  card ended mid-value, so every runtime role saw truncated test data.

## Pre-run dead-end risk (`src/generator/dead-end-risk.ts`, 2026-08-28)

A case whose flow needs a page the application lacks, or a label the spec words differently, cannot be healed into passing — and the machinery used to try anyway: the ladder's heal and agent rungs, in-run reconstruction, then `--repair`'s three attempts, each a model call and a minute of browser. Measured on be100 (2026-08-28, 27 cases in): 3 dead-ends and 3 errors, each paid for up to four times. So, **right after a catalog row is authored** (`authorEachRow`, on the same evidence the author just read — the ranked documents, the repository slice, the declared routes), one small `generator`-role call judges how likely the run is to end as a dead-end or error rather than a verdict. **Above the threshold (default 50%, `WOWLIDATOR_RISK_THRESHOLD`; strictly above) the case runs ONCE with every RERUN path off** — `failFastRunOptions` in `run-cases.ts`: no healer, no step reconstruction, and the `FlowRepairLoop` is skipped. The AGENT stays, once per step (refined 2026-08-28): a workflow leg has exactly one executor, the assist rung is one consult at the step that failed, and once-per-step holds by construction because with reconstruction off a step fails at most once and the dead-end memo blocks identical retries. The verdict is recorded exactly as any other run's; only the retries are withheld. `WOWLIDATOR_RISK=off` disables it; a generator role that does not resolve disables it with one printed line.

Rules worth keeping:

- **Signals first, model second** (`riskSignals`, $0): a `goto` path the repository declares no page route for (`routeIsDeclared`), a selector name (`name="…"`, `text=…`, `:has-text(…)`) that no document, the case, or the repository mentions, a backend step with the backend off, an agent `workflow` step, and "no evidence at all". They ride in the prompt as facts and on the record as `signals`, so a reader sees what the model was told, not only what it concluded.
- **Two dimensions since 2026-08-28: dead-end risk AND expected-fail risk.** `likelihood` still rises only when the run cannot reach the point where the expectation is checked — a claim the page can answer, even by contradicting it, is a verdict, so a negative case is never fail-fast for being negative. `failLikelihood` is the separate estimate that the run, having reached its assertions, ends in a GENUINE FAIL (the sheet's own Actual Result recorded Failed — passed in as `knownResult` and stated as a signal — a note citing a defect number, documents contradicting the expected output). Either dimension above the threshold fail-fasts (`riskVerdict(likelihood, threshold, failLikelihood)`): a near-certain fail is a fact the first run proves, and retries only re-prove it at full price. `describeRisk` and wowUI's tag name which dimension tripped.
- **Never throws.** A judge that fails (rate limit, breaker) is a case that runs the ordinary way, logged once — the retries exist for exactly the runs nobody could judge in advance.
- **Recorded, visibly.** `SuiteCase.risk` → `bundle.risk` (`DeadEndRisk`: likelihood, threshold, verdict, reasons, missing, signals, model, tokens) plus a line on `bundle.notes`; the proof card carries `risk`, wowUI's task row shows a `fail-fast N%` tag with the reason in its tooltip, and the run log prints `risk  fail-fast: …` at pickup. A person who disagrees has the evidence to say so.
- **Catalog rows only, for now.** `go`/`generate` suites do not carry the per-row retrieved evidence the judge needs; a hand-written flow has no `risk` and runs as it always did.

`tests/dead-end-risk.test.ts` is entirely unit-tier: the threshold and env, each signal, the prompt's budget, the model through `MockLanguageModelV4`, and the fail-fast option rule as one function.

## Post-run system-error diagnosis (`src/generator/error-diagnosis.ts`, 2026-08-28)

The companion of the pre-run risk judge, on the other side of the run: **a case that ends as a SYSTEM ERROR — `status: 'error'`, no verdict delivered — gets one `healer`-role call naming which layer broke** and the fix when one exists. Born from PL_07: all ten cases errored because the seeded plan the whole scenario asserts against (`PL_07_01_02_03_04_05_06`, "QA-Make correction") is not in the replica at all — the agent hunted a row that cannot exist, stalled, and the run read "system error" with nothing saying *seed the data*; PL_07_01 alone spent 108 model calls and $3.24 rediscovering it, and a person's next move was to re-run it.

Five origins, each implying its own fix: `test-catalog` (the case or its TEST DATA — a record never seeded, a precondition that never holds; fix the data, not the flow), `generator` (an invented selector/route — re-author), `agent` (a target the evidence DOES describe that the agent still missed — retry, better capture), `environment` (unconfigured DB, provider refusal, lost browser — ops), `application` (a genuine 500/crash). Rules worth keeping:

- **Only `status === 'error'` is diagnosed** (`diagnoseError` returns null otherwise). A test-failure is a verdict; a diagnosis of it would be second-guessing evidence a person can already read.
- **Signals first** (`diagnosisSignals`, $0): the PL_07 signature is load-bearing — a stalled agent whose hunted-for values (from its own failed-action errors) appear in NO evidence (case text, routes, repo hints, background docs via the suite's `HealHintsProvider`) points at test-catalog; the same stall over values the evidence DOES describe points at the agent; provider/quota wording in the run error, or a "never configured" note, points at environment; a cascade (an expect that errored because an earlier step never opened its dialog) is attributed to the first error.
- **It never repairs and never reclassifies.** The verdict stays `error`; the diagnosis lands on `bundle.diagnosis` (origin, confidence, reasoning, `fix: string | null` — null is the honest empty — signals, model, tokens), a `notes` line, a `diagnosis` line in the run log, the proof card, and the panel's why-block ("Diagnosed: … / Suggested fix: …"). Explaining is the feature; acting stays a person's click (`--repair`, a seed script, an env var).
- **Never throws; off by env.** `WOWLIDATOR_DIAGNOSE=off`, or a healer role that does not resolve, and the run reports its error exactly as before.

`tests/error-diagnosis.test.ts` is entirely unit-tier, `MockLanguageModelV4` for the model.

## Three more guarantees from the 2026-08-28 audit (S3, S4, S6, S7)

- **Roles are read from the tree, for every action** (`ungroundedSelectorRole`, S4): the generalisation of `ungroundedCountRole`. Sixteen dead-ends on one page came from `role=combobox`, `role=textbox`, native `select` written for filters the tree exposes as `button "Type:"` and `searchbox "Search benefit name"` — the roles a filter USUALLY has. A role no tree line starts with is refused with the tree's own line for that name; and a `fill`/`click`/`type`/`selectOption` on a line the tree marks `disabled` is refused too (the search box "starts disabled until a filter is chosen" — six flows filled it first). `expectHidden` and `expectCount 0` are exempt; after a `workflow` leg or on a truncated tree it declines.
- **Test data is not an application fact** (`fixtureFacts` / `ungroundedFixtureAssertion`, S3): identifier-shaped values from the Test Data / Expected columns (`PL_07_01_02_03_04_05_06`, `BP-DENTAL-01`, `TH_MED_005`) may be TYPED freely but may be asserted to pre-exist — a DB where-clause, a row click scoped by them, an exact count — only after a step of the same flow typed them into a form (or an agent leg whose goal creates them). Thirteen be100 cases asserted fixtures the database never held and filed the misses against the app.
- **The risk judge's evidence feeds the author** (S6): a `fail-fast` verdict with concrete reasons triggers ONE immediate re-ask with those reasons as `priorFeedback`; the re-authored flow replaces the first only when its re-judged likelihood is lower **AND it asserts at least as much about the claim** (`substantiveAssertions`, the vacuous lint's own predicate) — feedback must never make the result worse. "The search box starts disabled" (0.78) and "no Start-date filter exists" (0.88) were each right and each spent on a full dead-ended run. **The second gate is from 2026-09-02** (HIR-EC-006/HIR-EC-010, live): "lower risk alone" was gameable — a flow that asserts nothing about the claim cannot dead-end on it, so it always scored safer than the first draft that tried. The judge's own reasons named steps 8 and 11–12 of a first draft that reached the hire wizard; the re-ask, avoiding whatever it was told was risky, came back with four steps that never left the sign-in page — 0% risk, 0% proof — replaced the first, and passed green in 5 s about a hire it never attempted.

## The vacuous lint counts the sign-in form's own controls as no proof (2026-09-02)

`vacuous.ts`'s `substantiveAssertions` excluded only the sign-in PROOF (`expectHidden` of the submit control) and `expectUrl`. HIR-EC-006/HIR-EC-010's degenerate flows carried `expectVisible input[type="password"]` and `expectVisible role=button[name="Sign in" i]` — the sign-in form RENDERING its own fields — and those counted as substantive, so the fatal `vacuousClaim` lint in `FlowAuthor.author` never fired and the S6 swap saw "3 assertions". `isLoginFormSurface` now excludes `expectVisible`/`expectEnabled`/`expectDisabled` of the identity field, the password field, and a control literally named sign-in/log-in. **Deliberately narrower than `LOGIN_CONTROL`**: "next"/"continue"/"submit" are real wizard-step buttons far past sign-in and are NOT swept in; and it is selector-anchored (a `role=`/`input[type=` control locator, never `text=`), so a genuine login-validation claim — an error message that happens to contain "password" — is untouched. Because the predicate is shared, this lands in all three places at once: the fatal lint at authoring, the S6 swap gate, and `--rerun-vacuous` (which now marks both live cases blocked and re-authors them on the next resume).
- **The Note column is a gate** (`sheetGate` in `commands/authoring.ts`, S7): a row whose Actual Result is Cancelled, or whose Note says cancelled/dropped, is refused before any model call — four be100 rows were authored against filters the requirement dropped on 6 Jul. A dated requirement change ("pop-up → page 4 Aug", "TBC wording") is prepended to the case card as its own line, so the author reads it before writing `role=dialog` for a page.

## Reconciliation claims and sheet-verbatim wording (EN-2 audit, 2026-08-31)

- **`unreconciledMatchClaim`** refuses a flow whose case claims two readings
  agree ("tile matches the table", "เท่ากับ", "ตรงกับ") or that a number does
  not change ("no change", "ไม่เปลี่ยน") while no step saves a reading and
  compares it (`saveCount`/`saveText` → an expect carrying `{{var}}`; a
  `dbSnapshot` + `expectDbDelta`/`expectDbUnchanged` pair also satisfies).
  Presence assertions pass whether or not the readings agree — ten such bugs
  shipped green. The prompt's companion rule: a number printed in Expected
  ("1-15 of 43") is the sheet-writer's illustration, never a value to assert;
  the saved reading is the value.
- **`ungroundedTextExpectation` exempts the sheet's own words** (new `prompt`
  param): when the asserted text appears verbatim in the case, the sheet's
  wording IS the claim — refusing it rewrote real wording bugs into
  assertions about whatever the page renders, which then passed. The claim
  runs; an exact-miss over text the page holds becomes a near-miss
  needs-review, the right verdict for a wording dispute.
- **A workflow goal carries an Expected item only when a later step asserts
  something** (`unassertedExpectedItems`): an agent leg's claim must be
  settled by evidence independent of the agent — behavioral lines "covered"
  solely by a goal's mention shipped unproved, and their bugs with them.
- **`specQuestion`** (stamped in `runFlow`, engine side): a needs-review whose
  every disputed expected value quotes the case's own wording is marked a
  spec question — deliberate design vs the sheet, a BA call. 29 of 31 genuine
  QA fails in the EN-2 audit were this class; wowUI shows a `spec?` chip.

## A refused row is recorded, authored leniently once, then left alone (2026-09-02)

`authorEachRow` used to print `! X could not be written` and move on, and the
row earned no ledger outcome — so `--resume` listed it as still to run,
authored it again against the same captured trees, hit the same
tree-grounding refusal (the page the row needs was never captured, so no tree
renders its wording), and the run ended with the same rows "left". ec10n:
two rows, every resume, two Opus calls each, no progress. Three changes, all
in `cmdCatalog`/`suite-progress.ts`:

- **Recorded.** A refusal (and a sheet gate) becomes a flow-less `SuiteCase`
  with `refused: { reason, attempt }`; the runner records it `blocked` —
  `authoring refused (attempt N): …` — with `LedgerOutcome.authoringRefused`
  = N, so the catalog report's row says why instead of "never ran". Buffered
  until the pipelined runner exists, flushed into its queue then; written
  straight to the ledger (`persistRefusals`) when nothing authored at all.
- **Lenient once.** A resume passes `refusedBefore` to the author; a row
  refused before is authored with `lenientGrounding`, which makes the
  `ungroundedTextExpectation` refusal `weak`: the flow is handed over with the
  note and the RUN proves or dead-ends the wording against the real page.
  Every other lint stays fatal.
- **Capped.** `remaining()` drops a row at `AUTHORING_REFUSAL_CAP` (2)
  refusals — strict, then lenient — so the third resume does not pay again; it
  stays blocked with its reason. `--rerun-errors` (`markForRerun`) clears the
  count, so an explicit ask authors it once more. A sheet-gated row (Cancelled)
  is recorded at the cap outright.

Tests: `tests/suite-progress.test.ts` ("authoring refusals").

## Two lints that refused ec10 for the system's own reasons (2026-09-02)

Confirmed against the sheet, row by row: of ten new-hire rows, four were
refused by rules that were reading the wrong thing.

**The wording classifier read the whole prompt, background included.**
`WORDING_CLAIM` matches the Thai `ข้อความ` — "message" — and a catalog row's
prompt carries the retrieved requirement documents as well as the row. Any Thai
specification says `ข้อความ` many times, so *every* row was classified as a
claim about the page's wording; `wordingClaimAssertsDataValue` then refused
each one for asserting a value those documents happened not to quote — a new
hire's own keyed name (HIR-EC-002 `HIREEC002`), a duplicate notice
(HIR-EC-004), a success message (HIR-EC-008), a count (HIR-EC-001). Measured on
the sheet, only three of the ten rows say `ข้อความ` themselves and none of the
four refused ones is about wording at all. The lint now takes the case's own
words (`extra.caseText`, the row as `describeCase` renders it) and classifies
on those; the prompt still supplies the "is this value stated anywhere"
haystack, and a caller with no case text behaves exactly as before.

**An open question was treated as an expected value.** The sheet's convention
is explicit — `ข้อความ Notice ที่แน่นอน = ? OQ-HIR-140`, "run it, record what
the system shows, send it to BA/SA" — so `OQ-…`/`CF-…` is the NAME of an
unanswered question. HIR-EC-009 asserted `expectVisible text=OQ-HIR-78` against
the New Hire form, which can only fail and fails as though the application were
missing something. `assertsOpenQuestion` refuses it with a message that says to
assert the surrounding fact instead, and the procedure now carries the rule so
the first ask rarely trips it. Deliberately narrow: only the id shape, and only
where the flow ASSERTS it — a `fill` carrying one is the tester's own data, an
intent naming one is a note to a reader.

Tests: `tests/flow-author.test.ts` (`wordingClaimAssertsDataValue`,
`assertsOpenQuestion`).

## The Steps column is a script to perform, not background to read (2026-09-02)

ec10 HIR-EC-001: the sheet's eight numbered steps key an identity, walk the
Province → District → Sub-District cascade, fill position and compensation,
press Submit, then verify the created profile. What was authored signed in,
opened the form, and asserted that an `Employee ID` label and the words
`Auto-generated by system` were on screen — fifteen steps, two `fill`s, both of
them the login. It proved the form exists. It never ran the case, so nothing it
asserted was evidence either way, and the Expected output it answered was not
the sheet's.

`describeCase` had always put the Steps column in the prompt, so the model was
told the script; nothing told it to CARRY IT OUT, and the loudest instruction
in the procedure pulls the other way — *the fewest steps that reach the claim*.
For a key-in case the fewest steps that appear to reach it are to look at the
empty form. Two changes:

- **A procedure rule above the "fewest steps" one**: the Steps column is a
  script to perform in order with the Test data's own values
  (`กรอก`/`คีย์`/enter → fill, `เลือก` → selectOption or click, `กด` → click,
  Submit → the submit control). Asserting a field EXISTS is not performing the
  step that fills it, and the claim of a key-in case is what the system does
  AFTER the data is entered. A step that genuinely cannot be performed is named
  in its intent, never silently dropped.
- **`skipsAuthoredScript`**, a fatal lint: the case's Steps ask for input
  (`กรอก`, `คีย์`, `ระบุ`, `เลือก`, `กด Submit`, fill/key-in/enter/select/submit)
  and the flow's BODY performs none — no `fill`, `fillRetry`, `type`,
  `selectOption`, `check`, `uncheck`. Only the body is examined, so a sign-in's
  own fills neither satisfy nor trip it, and a read-only case (a menu is
  visible, a column list is complete) scripts no input and is never touched.

Tests: `tests/flow-author.test.ts` (`skipsAuthoredScript`).

## The control is the one the label points at, with the role the tree shows (2026-09-02)

ec10 HIR-EC-001 authored `fill role=textbox[name="Select date" i]` with
`1 Sep 2027`, and `selectOption role=combobox[name="Event Reason" i]`. All three
choices were wrong about the page, and the tree had shown the right answers: a
`textbox "Hire Date"` beside the placeholder-named read-only shell, and a
`button "Event Reason"` with `aria-haspopup`. A textbox named by its PLACEHOLDER
is usually a display over the real input; the real one is named by the field's
label. A date input takes `YYYY-MM-DD`. A dropdown the tree lists as a button is
a button — invent no role the tree did not show. One procedure rule now says so;
the engine's read-only shell rung (`src/engine/CLAUDE.md`) rescues the flows
already on disk.


## A row that says it cannot be run is not authored; a script of actions is not answered by assertions (2026-09-02)

ec10_2x CNS-EC-028: five steps — employee 1 signs in, opens the attachment,
accepts; the admin publishes version 2.0; employee 2 does the same; the dev
team reads the bound version codes; restore. The row supplies one account
(`<HR_ADMIN_ACCOUNT>`), and its own Note, from a check of SIT on 31 Aug, says
the admin consent register does not exist and *"ให้บันทึกผลเป็นยังทดสอบไม่ได้"* —
record as not yet testable. Authored anyway, the model did the honest thing it
could: three `expectVisible` on the one admin page that exists, each intent
saying the step "cannot be performed". The case then read as green about a
feature the sheet says is absent.

Two rules. `sheetGate` now reads the Note's own verdict — `ยังรันไม่ได้`,
`ยังทดสอบไม่ได้`, "cannot be run yet", "not testable" — and records the row
blocked in the sheet's words, at the refusal cap, for no model calls.
`skipsAuthoredScript` gained a second tier: a script that asks the tester to
ACT (`กด`, `ยอมรับ`, `ประกาศ`, `เข้าสู่ระบบ`, click/accept/publish/sign in) is not
performed by a body of assertions alone; a `click` or a `workflow` leg
satisfies it, as a fill satisfies the input tier. What no rule can supply: the
two employee accounts the script needs and the row never names. That is the
sheet's to fix.

Tests: `tests/retriever.test.ts` (`sheetGate`), `tests/flow-author.test.ts`
(`skipsAuthoredScript`).

## A token is not a value, and the script runs to its last step (2026-09-02, HIR-EC-012)

Two more refusals from reading one authored flow against its sheet row.

**`<NON_EXISTING_EMPLOYEE_ID>` was typed into the field.** The sheet's
Test data says `Invalid Replaced Employee ID = <NON_EXISTING_EMPLOYEE_ID>` — an
angle-bracket TOKEN for a value the tester supplies, the same convention as
`<HR_ADMIN_ACCOUNT>`. The flow filled the token itself; the page URL-encoded it
(`check-replaced-employee/%3CNON_EXIS…`), the API rejected malformed input, and
the step "proved" a rejection the case never asked about. `typesPlaceholderToken`
(fatal) refuses any `fill`/`type`/`selectOption` whose value still carries
`<LIKE_THIS>`, and the procedure says how to resolve one: from the Test data
when it names the real value, from the run's credentials for an account, and
for a NON_EXISTING / INVALID token from the format the case states — a
well-formed value that cannot exist (an 8-digit Employee ID such as 29999999).

**The flow stopped at step 3 of 7.** It cited "Step 2" and "Step 3" in its
intents and never reached the valid-replacement check, the identity data,
Submit or the profile check — the case's actual claim. Because the author
already cites the script step in each intent, coverage is checkable without
reading Thai prose: `unperformedScriptSteps` parses the script's `N.` lines,
collects the numbers the intents cite, and refuses (fatal) when numbered steps
beyond the highest cited one are neither cited nor marked
`skipped step N: <why>`. A flow that cites no step at all is left alone — there
is nothing to reason from — and the procedure now asks for the citation and the
skip marker explicitly, so a genuine gap is visible rather than silent.
Measured on the live HIR-EC-012 flow: refused with `performedThrough 3 of 7`,
naming steps 4–7; a flow citing every step, or naming its skips, passes.

Both delivered on typecheck plus a scripted check against the live flow; the
unit tests are owed.

## Values the sheet left as tokens are resolved, and a stand-in is flagged (2026-09-02)

`typesPlaceholderToken` refuses `<NON_EXISTING_EMPLOYEE_ID>` typed as data — honest,
and useless to the tester, who still has no run. `value-resolution.ts` runs
BEFORE the lints and resolves every input step whose value is a token or a
description ("ของพนักงานที่มีอยู่จริง"), cheapest source first, recording which one
answered on the step (`FlowStep.valueSource`), in its intent, and in every report:

1. **test-data** — the case's own `Field = value` line; a NON_EXISTING need never
   takes the valid id's line and vice versa. $0.
2. **repo** — `selectRelevantContext` over the documents (or the prompt's own
   paragraphs ranked by overlap), one structured question to the agent role;
   accepted only when the value appears verbatim in a passage.
3. **db** — read-only, only when `WOWLIDATOR_DB_URL` is set: the agent role names
   `{table, column, where}` in `dbCount`'s shape, every identifier is checked
   against the introspected schema (a wrong one is a refusal, not a query), one
   `SELECT … LIMIT 1`, the value through `redactValue` (a sensitive column is
   never used). A NON_EXISTING token is proved absent instead: a candidate from
   the case's stated format (`8 หลัก`, `หลักแรกเป็น 2` → `29999999`), `count(*) = 0`,
   stepping past up to five that exist.
4. **generated** — the generator role invents a well-formed value (or
   `candidateFor` does, deterministically, with no model), and the step is
   FLAGGED: `valueSource.kind = 'generated'`, the intent says so, the proof
   bundle gets a note, the CLI line prints `value generated — …`, both HTML
   reports show a `value generated` badge (`GLOSSARY` entry) and a `value` fact,
   the Excel Proof column a `value source:` line, wowUI's step panel a `value`
   row. A generated value is a stand-in the reader must weigh, never evidence.

Never fatal: a source that throws is a source that did not answer; the lint stays
as the backstop for what nothing could resolve. `--no-value-resolution` /
`WOWLIDATOR_VALUE_RESOLUTION=off` turns the stage off (`buildValueResolution` in
`cli/runtime.ts`); with no agent key the model is null and sources 1 and 4 still
work. Tests: `tests/value-resolution.test.ts`.

## The token stays for the resolver, and a skip is not an escape hatch (2026-09-02, HIR-EC-012 again)

Read against the sheet, the re-authored HIR-EC-012 covered steps 1–3, one field
of step 5, and skipped 4, 6 and 7 — the case's claim untested — and it had
resolved `<NON_EXISTING_EMPLOYEE_ID>` to `29999999` ITSELF, so the value carried
no `valueSource` and a made-up id read as data. Two changes:

- **The procedure now says to leave the token in place.** The resolution stage
  runs after the model and records provenance (test data / repo / db / generated);
  a model that resolves the token on its own destroys exactly that. The
  non-existence proof (`count = 0` in the database) only happens on this path.
- **A step skipped for want of a value is looked up, then re-asked.**
  `#valuesForSkippedSteps` reads each `skipped step N: <why>`; when the reason
  speaks of a missing id/value it extracts the field (`fieldNamesIn`) and asks
  the test-data, repo and db sources. A value found becomes a `weak` refusal —
  "step 4 skipped, but db has Replaced Employee ID = 20004512; author it, and
  the steps skipped only because it was missing" — so the next attempt writes
  step 4 (and, with it, 6 and 7), and the last attempt accepts the skip with a
  note naming the value that was available. Steps skipped for other reasons
  (another module, destructive) are left alone.

What no lint can judge: how COMPLETELY a cited step was performed — step 5's
"กรอกข้อมูล Identity ตามข้อมูลที่กำหนด" is one bullet and a dozen fields, and a
flow that keys one of them has cited the step. That remains the reader's call,
and the report's step list is where to make it.

## "Only" means only (`src/generator/exclusivity.ts`, 2026-09-02)

An Expected line that says ONLY / JUST / EXACTLY / เฉพาะ / แค่ / เพียง / เท่านั้น about an enumerated set ("แสดง 3 ค่า", "A / B / C") is a claim about the whole set, and the whole set is proved by counting it. Measured on ec10_3x HIR-EC-029: the flow proved three options visible and three named codes hidden and went green over a list nothing had counted. Three places share one detector (`exclusivityClaimIn` / `unprovedExclusivity`): the authoring prompt's procedure + self-check, a fatal lint in `FlowAuthor` (refuses a body with no `expectCount`, or one whose numeric count disagrees with the sheet's), and `runCases`, which blocks a flow already on disk the same way it blocks a vacuous one (re-authored on `--resume`). Conservative by design: the marker must be in the Expected block and the line must enumerate — a bare "เฉพาะบางกลุ่ม" is left alone.

## "Only these three" is a count, not three presences (2026-09-02, HIR-EC-029)

The Expected output read *dropdown แสดง 3 ค่า : Event Reason บนหน้า Key-in
แสดงเฉพาะ New Hire / Replacement / Migration*. The page offered a dozen reasons
(DATA MIGRATION, HIREDM, H_NEWHIRE, H_RPLMENT, MT_EMP_INFO …) — the defect the
case exists to catch. The flow asserted `expectVisible` of each of the three:
presences that pass on a dropdown of a hundred. The case went red only because
one presence tripped on wording, so the report blamed a label and never
mentioned the extra options — a fail for the wrong reason, which is a miss.

`unboundedExclusivityClaim` (fatal): when the case text claims a closed set —
a count (`แสดง 3 ค่า`, `exactly 3 options`) or an "only" (`เฉพาะ`, `only these`,
`nothing else`) — the flow must carry an `expectCount`; presences alone are
refused, and the message names the bound (`expectCount role=option = 3`). The
numbered form is read first so the refusal can quote the number. The procedure
carries the same rule, with the shape to write: open the control, count its
options, then assert each named value; an `ไม่แสดง X` line is an `expectHidden`
on top of the count, never instead of it. Tests: `tests/flow-author.test.ts`
(`unboundedExclusivityClaim`).

## What a model hands back is unwrapped before it is typed (`cleanModelValue`, 2026-09-03)

Live (ec09 HIR-EC-009, panel jobs 2 and 3): the value resolver reached its last rung for `National ID / Tax ID = <VALID_NATIONAL_ID>` (no sheet value; the column is sensitive so the database is never asked) and typed the model's answer verbatim — which was the reply envelope nested inside the value, `{"value": "1999900123459"}`, because the system prompt said "output only the value" while the user prompt said "Reply {"value": …}". `cleanModelValue` now runs on every string a resolver model returns (`generated`, `fromRepo`): code fences, a JSON object whose `value` (or lone) key holds the answer — nested envelopes too — surrounding quotes and trailing prose are stripped; a plain value is untouched; a generated value that still contains `{}[]"` falls back to `candidateFor`. The generate prompt no longer contradicts its own reply shape. This is packaging repair only — it knows nothing about any field. (The number itself then failed the app's mod-11 checksum; a field-keyed checksum generator was tried and rejected the same day as hardcoding — a generated value's validity is the app's verdict, shown in the report as `generated`.) Tests: `tests/value-resolution.test.ts` ("what a model hands back is unwrapped…").

## A persona hand-off is one `signIn`, never a `signOut` first (2026-09-03)

Each persona now gets a Chrome of their own for the length of the case and keeps their session (see `src/engine/CLAUDE.md`, "A persona switch is a browser switch"), so the prompt's sign-in rules say: one `signIn` per hand-off, no `signOut` before it, and a `signIn` naming a persona who already signed in earlier returns to their browser with the session intact. `signOut` is authored only when the case itself says to sign out. `groundPersonaSwitches` never spliced a `signOut` before a `signIn`-based switch (it grounds hand-typed credential blocks only), so the change is in the prompt and the refusal wording; `multiPersonaWorkflow` still refuses one workflow goal naming two people.

## The tree is read with the row's tab selected, and the opening click only from that state (2026-09-04, PY-1 TC_SSO_001_001)

The sheet's step 2 says `กดปุ่ม "Add" / "+"`; the flow clicked
`role=button[name="Add Rate" i]` with the intent admitting it — *(rendered as
"Add Rate")* — and every field after it was the RATE form's (Employee Rate (%),
Save (Ctrl+Enter)). The run proved the page: after the flow's own click of the
"SSO Branch Registration" tab, "Add Rate" was absent (`the page's button is
named "SSO Branch Rate"`), and in-run reconstruction had to click BACK to the
"SSO Branch Rate" tab to find it. Not two controls in one tree: the panels
render one at a time, and the Registration panel's own Add control was in no
tree the author ever saw.

The chain was the capture, not the model. `captureJourneyTree`
(`cli/commands/authoring.ts`) read `/admin/config/sso` in its LANDING state —
the default tab — although `destinationOf` had already parsed the row's tab
(`เลือกแท็บ "…"`), and the prompt merely told the model "the row selects the tab
X — click it before reading". Then `captureAfterOpening` matched the script's
`"Add"` by prefix to the default panel's `"Add Rate"`, clicked it, and captured
the wrong form as the row's. Every lint and the $0 audit passed, because
everything the flow named WAS in the tree; the tree was of a state the script
never visits. A grounding lint cannot recover evidence that was never captured,
so nothing changed in either author file; the fix is where the evidence is made:

- **The row's tab is selected on the capture tab before the tree is read**
  (`selectNamedTab`, matched by accessible name in whatever role the strip
  renders it — here buttons). The section header says the tree was read WITH
  that tab selected and that the flow must click it first.
- **The opening click runs only from the state the script clicks it in.** A
  row that names a tab this capture could not select gets NO opening capture
  (logged), and the header says the tab was not selected and that a control
  the script names which is absent below is *not captured*, never absent — a
  workflow goal in the script's words is the honest shape for that leg. No
  tree beats a tree of the wrong panel: the first hands the author a thin
  claim the run can settle; the second handed it a false one that passed
  every check.
- **One matcher for both clicks** (`controlNamedIn`, pure, exported): whole
  name, then prefix, then containment, clickable roles only — so "which
  control did the sheet mean" cannot mean two things. The prefix rule stays;
  it is right on the right panel.

Evaluated and rejected as generator rules: (a) marking the selected tab in the
tree — the strip here is buttons, the tree is flat, and a state flag would
raise every healer call's token bill for a signal this app does not emit;
(b) "an exact tree match for the script's quoted name beats a longer name" —
it refuses a true claim in this very flow (`กด "Save"` is correctly
`Save (Ctrl+Enter)` on the modal wherever a page-level "Save" also exists), and
a rule that can refuse a true claim is wrong; (c) a lint comparing the flow's
clicks against the capture's click path — a filter clicked between arriving and
opening is legitimate, and with the capture fix the header is consistent by
construction. Tests: `tests/flow-author.test.ts` ("journey capture reads the
tab the row selects, before the opening click").

## One author again (2026-09-04)

For a day the CLI ran `flow-author_original.ts` while every test ran `flow-author.ts` — ~1,750 diff lines apart, the hardcode guard skipping the live one by name. The CLI, `src/index.ts` and `cli/options.ts` now import `flow-author.ts`; the older file is a reference artifact at `docs/artifacts/flow-author_original.ts` (outside `src/`, compiled and imported by nothing, and no longer on the no-hardcode SKIP list). Seven prompt tests that pinned the old file's SHOUTED headings were re-pointed at the live prompt's sentences for the same rules (persona sign-in by label, menu path as the first leg, one pair per line, date phrases, `[RECORD ONLY]`, option sets counted with the list open once, wait-until, `expectFieldError`, `expectAnyVisible`, evidence independent of the agent, the disclosure corollary, `request`, one page state, the captured second page, both scopes). No rule was dropped: each was found reworded before its test was changed. Tests: `tests/author-wave2.test.ts`, `tests/flow-author.test.ts`.

## The resolver's vocabulary is data: `value-rules.ts` and `.wowlidator/value-rules.json` (2026-09-04)

The whole QA workbook (`QA_Task_Tracking_Cycle1.xlsx`, 1,286 rows, 8,225 Test data pairs) was read cell by cell through the resolver's own functions. Of the 1,409 pairs that turn out to be needs, the resolver knew tokens, date phrases, reused keys and described values; it did NOT know five shapes the sheet writes constantly, and typed each verbatim:

- a value followed by a remark — `Employee Sub Group = 10 ตามชุดข้อมูล` (HIR-EC-015), `Work Schedule = D05H0830 ตามที่ Position กำหนด`, a bound `Personnel Grade = 11 ขึ้นไป` (PRB-EC-038), a quoted literal with a comment `"32/13/2026" (วันที่ผิดรูปแบบ)` (PL_10_41) — 457 pairs;
- a blank word — `Payment Method = Blank` (HIR-EC-059), `DVT Project = null`, `Transfer out to = เว้นว่างในเคสนี้ …` (HIR-EC-139) — 107;
- a mask standing for a value made elsewhere — `Employee ID = EMXXXX (จาก E2E-01)` (PRB-EC-036), `Benefit plan ID = BE-XXX-999 (ไม่มีในระบบ)` (PL_10_54) — 57;
- an invalid value described by its own examples — `status = ค่าอื่นที่ไม่ถูกต้อง เช่น "Active", "X"` (PL_10_40) — 28; and a text described only by its length — `ข้อความความยาวเกิน 255 ตัวอักษร` (PL_10_48);
- date phrases outside the grammar — `31-Dec-9999`, `13 เมษายน`, `1 มกราคมของปีก่อนหน้า`, `< Current Date`, `วันก่อนวันที่จ้าง`, `Age = 60 พอดี ณ Hire Date`, `ทำให้อายุ ณ Hire Date เท่ากับ 59 ปี 11 เดือน`, `ย้อนหลังจากวันที่ทดสอบ 5`, `วันที่ทดสอบ บวก 30 วัน`, and a value that IS another date field's label (`Probationary Period End Date = Hire Date`, PRB-EC-066) — 85 date misses became 73, and the 73 left are unresolvable in-row (the Hire Date lives in another case's data set, `วันแรกของงวดเวลาปัจจุบัน` needs a payroll calendar, a `Payroll Period Cycle` is not a date) and are left as written, exactly as before.

Every one of those readings rests on a VOCABULARY, and the user's standing rule is no field-, phrase- or locale-keyed fix. So the mechanisms are structural and live in `value-resolution.ts` — `writtenValueOf` (a trailing clause after an introducer, a trailing bound, one parenthetical after a space, a leading quoted literal, the first quoted example after an example introducer), `MASK_VALUE`, `labelOfDatePair`, an anchor clause (`ณ <label>`) and a relation prefix (`< X`, `วันก่อน X`) in the date grammar, a length format — and the WORDS are data in `value-rules.ts`: `DEFAULT_VALUE_RULES`, a zod `ValueRulesSchema`, `loadValueRules()` (built-ins merged with `.wowlidator/value-rules.json`; an invalid file is one stderr warning and the built-ins, never a throw), `saveValueRules()` (validate, temp-file + rename), `compileValueRules()` (the one place the regexes are built: every word is escaped and anchored the way the built-in was — Latin on a word boundary, Thai as a substring, a blank word as the whole value; a bad entry is rejected by list and index). `ValueResolutionContext.rules` injects a rule set; `resolveValues` loads the file once per call when none is given, so the CLI and the panel need no new flag, and the panel can edit the file without a TypeScript change. Externalised from code into the file: key-field words, QA key prefixes, non-existing / described / already-exists wordings, blank words, note introducers, bound words, example introducers, format words, the date vocabulary (today/tomorrow/yesterday/future/past, month words, before/after, anchor prepositions, filler prefixes, exact words, back/forward, units, birth-field and age words, age comparators, age anchor fields), field aliases (`Hire Date` ~ `วันที่จ้าง`), and per-field defaults (a value is recorded as `valueSource.kind = 'rules'`, never as the sheet's word; a format shapes the stand-in).

Why it cannot make a result worse: every new shape is single-source — cleaned, blanked or computed from the case's own words, or left as written; no new shape reaches a model. A `selectOption` keeps its parenthetical (an option's label may BE `CDS (C001)`); a value with several parentheticals, a bracket glued to a name (`Permanent(7-16)-(12/31/9999)`), a lowercase `<runtime>`, a range (`07 ถึง 10`) and an option label that reads like a phrase are all typed as written, pinned. The 34 tests that existed pass unchanged under the built-ins; the file's lists REPLACE the built-in list wholesale (a word can be removed), so a tester's edit is exact. Tests: `tests/value-resolution.test.ts` ("the workbook's own cell shapes", "value rules") — every value quoted from a real cell with its case id.

## A visual snapshot is not authorable (2026-09-04, ec09 HIR-EC-009)

Step 58 of the live HIR-EC-009 run was `snapshot record_oq_hir_78`: the author's reading of the [RECORD ONLY] rule ("snapshot a region when it is a state"). A `snapshot` writes its baseline on the first run and diffs every later run against it, so the second run of the same case failed the step `changed` (10% of pixels — the data the run itself had typed) and a record-only observation became a red step about nothing. `snapshot` is out of `AUTHOR_ACTIONS` (so the schema refuses it and narrowing never sees it), out of the vocabulary list, and the rule now says a state is `saveText` of the region that shows it — the film and the per-step screenshot already keep the picture. The engine action stays for hand-written flows (`src/visual/`). A flow already on disk with a snapshot step keeps it until re-authored. Test: `tests/author-wave2.test.ts` (CG-09, "a visual snapshot is not authorable").

## Two lints no flow could satisfy, and a loop that kept asking (2026-09-04, multirole HIR-EC-001)

Panel jobs 3 and 15 spent three opus calls a row (264 s, 21.7k output tokens,
~$0.95 each) on HIR-EC-001 and blocked it — `authoring refused (attempt 1)`,
which is the RESUME-cap counter, not the model-attempt count — and a `--resume`
would have paid three more for the same result, since `lenientGrounding`
relaxes only `ungroundedTextExpectation`. Read against the sheet, two of the
four refusals were unsatisfiable by construction, one was reading a note
instead of a claim, and one was right.

- **One exclusivity detector.** `FlowAuthor.author` called BOTH the legacy
  `unboundedExclusivityClaim` and `exclusivity.ts`'s `unprovedExclusivity`. The
  legacy `only` regex had no word boundary and read *Time Management Status และ
  O.T. Flag เป็น Read-only และ HR ไม่สามารถแก้ไขเองได้* as a closed set, demanding
  `expectCount role=option` of options that do not exist; the shared detector
  had already said null (nothing enumerated). The legacy call is gone; the
  export is a view over `unprovedExclusivity` so nothing else moves; and
  `ENGLISH_MARKER` is `(?<![\w-])only\b` — a hyphen-joined "only" is a compound
  adjective (read-only, view-only), one thing's mode, never a set's size.
- **An empty `expectValue` is the cleared-field claim.** *เมื่อเปลี่ยน Province
  ระบบเคลียร์ District / Sub-District / Postal Code เดิม* is a claim that a field
  holds NOTHING; the model wrote `expectValue ""`, narrowing dropped it
  ("expectValue needs a value"), and the drop was refused fatally — a shape the
  vocabulary offered no way to write. The engine compares `inputValue` to `""`,
  which fails on any textbox still holding something, so the pass can fail.
  The one control that cannot carry it is a dropdown the tree lists as a
  button: the engine falls back to the trigger's own text (its placeholder) and
  the step would be red against a correctly cleared dropdown. That shape alone
  is dropped, with `EMPTY_VALUE_ON_BUTTON_REASON` naming the legal ones
  (`expectText` of the trigger's wording, `expectHidden` of the cleared choice);
  the vocabulary line says the same.
- **The fixture lint reads the claim, never the note, and knows a derived
  field.** `ungroundedFixtureAssertion` stringified the whole step, intent
  included — and the prompt itself tells the model to write *skipped step 4:
  unconfirmed test data — Policy Profile = … ดู CF-SIT-19*, so any
  `expectVisible` carrying that note was refused for "asserting CF-SIT-19".
  The intent is now excluded; `fixtureFacts` skips `OPEN_QUESTION`-shaped ids
  (a question's name is never a fixture — `assertsOpenQuestion` owns that
  shape, and now also reads `role=…[name="…"]` and past a `>> nth=N` chain);
  and an `expectText`/`expectValue` anchored on a value-holding control after
  a body `fill`/`selectOption`/`type` is the application's answer to what was
  entered — *ระบบดึงข้อมูลจาก Department ได้แก่ … Store/Branch Location*, Branch
  `T153_1733` after selecting the Department — which the run settles. A
  `text=` presence, a row click, a DB where-clause and a count stay judged:
  those are the be100 shapes the lint was written for, and a lookup BEFORE
  anything was entered is still refused.
- **An open-question id beside a value is a reference.** `Policy Profile = CDS
  ใช้แทน CDS ที่เคยระบุ ดู CF-SIT-19` was classified unconfirmed on the raw cell
  (`unconfirmedValue`, `catalog/test-case-table.ts`) although `writtenValueOf`
  already reads it as `CDS` and the same data set lists `[TD-01] Policy Profile
  = CDS`; the author was told to skip the field and `usesUnconfirmedValue`
  would have refused `selectOption "CDS"` into it. The OQ/CF alternative now
  counts only at the START of the value (`? CF-HIR-08 OQ-HIR-50`, `OQ-HIR-13`
  stay unconfirmed) — the rule `fixtureFacts` already applies to a case id
  after "same as". No vocabulary was added; the note introducer that strips
  the remark (` ใช้`) was already data in `value-rules.ts`.
- **The same fatal refusal twice is not re-asked.** The loop had no notion of
  a refusal the flow cannot satisfy. In the `catch` of `FlowAuthor.author`,
  when this attempt's fatal `refusalShape` set equals the previous attempt's,
  the loop stops and throws the refusal prefixed *refused identically on N
  attempts — a rule the model cannot satisfy or a lint that misreads the case;
  review the lint*, and the repeat is NOT counted by `#rememberRefusals` (so an
  unsatisfiable rule cannot become suite memory; a rule now travels only once
  two ROWS broke it). Weak refusals are untouched — they are meant to be
  re-asked, then accepted. Why it cannot make the result worse: the outcome is
  the BLOCKED the budget would have reached anyway, one attempt earlier, and
  the ledger line now says whether to look at the lint or at the model. It
  cannot detect an unsatisfiable rule on the first attempt; only the lint
  fixes above do that.
- **What was right:** `unperformedScriptSteps` (the flow stopped at step 7 of 8).
  The earlier run reached step 8 unprompted; with one item of feedback instead
  of four the re-ask has a chance to converge. Kept fatal.

Measured offline on the real row through the lints: `unconfirmedTestData` empty,
`fixtureFacts` without the three OQ/CF ids, both exclusivity detectors null, the
skip-note and derived-Branch shapes accepted, `usesUnconfirmedValue` null for
`selectOption "CDS"`. Expected on the panel: one or two attempts instead of
three-and-blocked. Tests: `tests/flow-author.test.ts` (`unboundedExclusivityClaim`
"Read-only", the fixture and `assertsOpenQuestion` HIR-EC-001 cases, "stops after
two identical fatal refusals", the memory test now needing two rows),
`tests/author-wave2.test.ts` ("narrows an empty expectValue …"),
`tests/value-resolution.test.ts` ("an open-question id beside a value is a
reference"). Cost is out of this module's hands: the 92k "in" per attempt is the
claude-cli session's cache re-written per call (`provider-expert`), and the 264 s
is 21.7k output tokens; `WOWLIDATOR_GENERATOR_RETRY_MODEL` and
`WOWLIDATOR_AUTHOR_ATTEMPTS` are the dials, unmeasured.

## The lints' words are data, and a choice is made by clicking (2026-09-04, multirole PRB-EC-001 / ML_01_04)

Two lint defects read off the multirole run, and the audit they forced. The
user's standing rule (2026-09-03) is the frame: no field-, phrase- or
locale-keyed fix; a lint keys on STRUCTURE — a role from the tree, a step
shape, an action kind, a line's numbering, a `= ?` beside an id — and the
words it reads that structure through belong in data, in both of the
languages the sheets use.

- **`skipsAuthoredScript` has three tiers, and each names what performs it.**
  `เลือก` / select / choose sat in the TYPING tier, satisfied only by
  `INPUT_ACTIONS` — no `click` — while the refusal told the model a click
  counts. PRB-EC-001's `click role=radio[name="Pass probation (normal)"]` was
  refused for a script it had performed. Now: TYPING (`กรอก`, `คีย์`, fill,
  key in …) is performed by a fill / fillRetry / type / setValue / upload — and
  a selectOption / check, a chosen cascade being data entered (HIR-EC-001,
  kept); CHOOSING (`เลือก`, `ติ๊ก`, select, choose, tick …) by those, or a
  `click` whose selector role is a choice role (`CHOICE_ROLES`: radio, option,
  checkbox, switch, menuitemradio, menuitemcheckbox, tab, treeitem), or a
  `click` that another body step follows — a choice made by clicking is the
  ordinary shape and the step after it is what the choice was for; ACTING
  (`กด`, `ยอมรับ`, `ประกาศ`, click, accept, publish, sign in …) by any action
  or a workflow leg, as before. Tiers are judged in that order, the result
  carries the `tier`, and the refusal prints `describeScriptDemand(tier)` —
  the sentence lives beside the sets it describes, so the message and the
  code cannot say two things.
- **`unperformedScriptSteps` reads three carriers.** It read only an intent's
  `step N`. A `workflow` step's GOAL is where an agent leg names its script
  step (the carrier rule `unassertedExpectedItems` already applies), and the
  sheet's own sub-numbering at the head of an intent (`5.4 กด Approve`) cites
  step 5 — excluding any id that is an EXPECTED line's (`expectedItemsIn`), so
  the two numberings cannot be confused, and only for a number the script has.
  `skipped step N: <why>` still marks a skip. The step and skip words are data
  (`authoring.script.stepWords` / `skipWords`: step / ขั้นตอน / ข้อ, skip /
  ข้าม).
- **`expectedItemsIn` anchors an id at the line's head.** "Requested hours :
  0.52 hrs" was read as Expected item `0.52` and demanded an assertion. A
  decimal id or a bare `N.` counts only after optional whitespace and a
  bullet, never mid-line.
- **`ENGLISH_MARKER` keeps its `(?<![\w-])` lookbehind** (read-only, view-only
  are one thing's mode).

**`value-rules.ts` now exists** — the section above ("The resolver's
vocabulary is data") described it before the file did; the resolver's
`VOCABULARY` was an inline constant. It is one module with two halves under one
zod schema: `values` (the resolver's vocabulary, moved there verbatim and
re-exported by `value-resolution.ts` under its old name) and `authoring` (the
lints' and gates' words). `loadValueRules()` merges the built-ins with
`.wowlidator/value-rules.json` — a present list REPLACES the built-in one
wholesale so a word can be removed, an absent key keeps the built-in, an
unknown key or an invalid file is one stderr line and the built-ins, never a
throw. Loaded once per process (`VALUE_RULES`, `AUTHORING`), which is once per
panel job since the panel runs `dist/cli.js` per run; not per call, and there is
no `ValueResolutionContext.rules` — the earlier section overstated both.
`compileAuthoringRules` is the one place the lint regexes are built: Latin on a
word boundary, Thai as a substring after a line start / space / bullet / step
number (the anchoring the lints always used), longest word first.

Moved into data (`DEFAULT_AUTHORING_RULES`), every list Thai + English:
`script.typing` / `choosing` / `acting` (was `SCRIPT_DEMANDS_INPUT` /
`SCRIPT_DEMANDS_ACTION`), `script.routeLine` (was inline in
`withoutRouteLabels`), `script.stepWords` / `skipWords` (was the citation
regex), `wordingClaim` (was `WORDING_CLAIM`), `matchClaim.agree` /
`unchanged` / `readings` / `quantities` (was `unreconciledMatchClaim`'s
regex — the shape, an agree-word within a clause of a reading or an
unchanged-word within a clause of a quantity in either order, stays in code),
`openQuestionPrefixes` (was `OQ|CF` in three files), `sheetNote.cancelled` /
`notYet` / `retest` (was `sheetGateReason`'s regexes in
`catalog/test-case-table.ts`, whose English-only cancelled list gained the
Thai phrases). The catalog parser now imports this one leaf module of the
generator; it imports nothing of the parser, so the dependency still runs one
way.

Became structural: **an open question is any id the case writes after its
`?`** (`openQuestionIdsIn`) — `OQ-`/`CF-` were one workbook's convention;
`assertsOpenQuestion` takes the case text and `fixtureFacts` reads it too, the
prefixes staying as a configurable fallback; **a sibling case id is one whose
skeleton (digits blanked, `HIR-EC-#`) matches the case's own id or an id the
row cites as a case** — `fixtureFacts`' `caseIdShape` was a literal list of
one workbook's suffixes (EC / BE / TM / PY), and `เคส <id>` now counts as a
case citation beside `same as`; **`unconfirmedValue`** reads the open-question
prefix at the START of a value through the same rules. Prompt examples that
steered toward one application were generalised or marked: the procedure
opens by saying every quoted name in its examples is an illustration from some
other application; "an OQ-/CF- id" is "the id the sheet writes after its
`= ?`"; "Login web humi" is "Login web <app>"; the placeholder-token refusal
no longer names an 8-digit Employee ID. `vacuous.ts`'s `LOGIN_FORM_CONTROL`
reads `email` rather than one application's `work email`.

Left alone, on purpose: `beyondHarnessReason`'s `brew services stop` family
(shell commands, language-neutral); `referencedSources` (bilingual already, in
the catalog); the four inline claim shapes `ALTERNATIVE_CLAIM` / `DELTA_CLAIM`
/ `FIELD_ERROR_CLAIM` / `WAIT_UNTIL_CLAIM` (bilingual and symmetric; moving
them is mechanical and owed); `LOGIN_CONTROL` / `LOGIN_URL_PATTERN` (the
documented sign-in generic); `ageAnchorFields` / `fieldAliases` (data already,
now overridable); and, in the catalog parser, `CASE_ID` / `DATA_REF` /
`GENERATED_NAME` / `personasOf`'s role words / `OTHER_TEAM_RE` — one
workbook's id prefixes, QA name prefixes, persona words and a Thai-only
"handed to another team" list, each needing the whole table's ids or a driver
row in the other language to replace structurally; named here so they are not
mistaken for generic.

Probed offline on the PRB shape: the radio / Submit / signIn / Approve /
workflow body passes, a body of assertions is refused `choosing`, a goal-only
`Step 5:` and a `5.4 …` intent each clear step 5, a flow citing 1–4 alone is
still refused, `0.52` is no longer an item. Tests: `tests/flow-author.test.ts`
("a choice is made by clicking", "a citation in a goal or in the sheet's
sub-numbering", "an id is at the head of its line", "the authoring vocabulary
is data").

## The last word is a rewrite, not a refusal (2026-09-04, multirole HIR-EC-001 / PRB-EC-001)

Read against the panel's two multirole runs. The 07:10 ledger blocked HIR-EC-001
with the two refusals the section above had already fixed at 14:28 local
(`only` inside `Read-only`; `expectValue ""` dropped) — the panel runs
`dist/cli.js`, and dist was built after both runs, so the report was the OLD
author's; and the ledger's `(attempt 1)` is the RESUME-cap counter, not the
model-attempt count (the loop asked three times, then stopped identically).
The 05:46 run blocked PRB-EC-001 — not HIR-EC-001 — with *depends on E2E-01,
which is not in this catalog*: `E2E-01` is the SCENARIO ID of HIR-EC-001, two
rows above it, and `linkDependencies` resolved references against Test Case
IDs only. ML_01_04's "no verdict" is `status: error` on
`expectVisible text=Full day` straight after the date-picking `workflow` leg —
the agent leg's outcome, `orchestrator-optimizer`'s, not an authoring shape
(the assertion after the leg is exactly what `unsettledWorkflowClaim` asks
for). What changed, all in `flow-author.ts` unless named:

- **A scenario id is a name the table may hold** (`catalog/test-case-table.ts`
  `linkDependencies`): a reference resolves against Test Case IDs first, then
  the Scenario ID column — the row's OWN scenario is itself (never a
  dependency), another scenario in the table is its first row of the same
  sheet (`dependsOn`), and only a scenario the table lacks is `externalRefs`.
  Structural: the ids come from the table's own columns. The parser also had a
  literal NUL byte inside three template-literal keys (`grep` read the whole
  file as binary and found nothing in it); it is the `\u0000` escape now.
- **A step the harness cannot run is rewritten before it is dropped**
  (`repairAuthoredStep`, in `LlmFlowAuthorModel`'s narrowing, $0): the nearest
  runnable form from the evidence the model was given — `expectValue ""` on a
  dropdown BUTTON becomes `expectText` of the trigger's own wording as a tree
  line names it (the cleared state; no tree line, no rewrite); an `expectText`
  / `expectCount` / `expectAttribute` with no value takes the intent's own
  `= value` pair (digits for a count) or narrows to `expectVisible` of the same
  control and says it is thinner; a `type` / `selectOption` with no value takes
  the Test data pair the control is named after, `valueSource.kind =
  'test-data'`; a one-alternative `expectAnyVisible` is the `expectVisible` it
  meant. `fill ""` is never touched — clearing a field is a real step. Every
  rewrite ends the step's intent with `[generated: <how> — the authored
  <action> could not run: <reason>]` (`markGenerated`; the HEAD of the intent
  stays, so `unperformedScriptSteps` and `expectedItemsIn` still read their
  citations), lands on `AuthorResult.substituted`, is logged `substituted …`
  beside `dropped …`, and is written to the flow's `notes` — the report reads
  what was substituted for what. Found on the way: `expectCount ""` narrowed to
  **count 0** (`Number('')`), a claim the model never made that passes on any
  empty list; digits are required now.
- **`Violation.settle`** — the structural fallback a fatal lint may carry, run
  by `settleViolations` at the LAST WORD only: the budget's final attempt, or
  the attempt whose fatal shapes equal the previous attempt's (the identical
  refusal, one attempt earlier). Every fatal complaint with a grounded rewrite
  performs it in place — the step objects are shared between `steps` and
  `cases`, and `insertStepBefore` / `removeStep` edit both — and the flow goes
  out with the covered steps as written and each uncovered claim in `notes`;
  one fatal complaint that cannot be settled keeps the whole refusal, so a
  FALSE claim is still never handed over. Weak complaints keep their notes.
  The five that settle: `unprovedExclusivity` → `settleExclusivity` inserts
  `expectCount role=<item role> = N` before the first member presence, the
  role read from the tree/probe lines that name EVERY enumerated member under
  one role (a member in no tree is no evidence, null — the same phantom
  `ungroundedCountRole` refuses); `unperformedScriptSteps` → `not covered:
  script step(s) N (<text>)`; `assertsOpenQuestion` → the step is removed
  unless it is the only assertion; `ungroundedTextExpectation` → the step is
  annotated with the nearest renderings and left for the run (what
  `lenientGrounding` did one resume later); `ungroundedSelectorRole` →
  `settleSelectorRole` repoints the role to the tree's own line for the SAME
  name, never a different one and never a disabled control. Without a
  fallback, as before: vacuity, no assertion, a script performed by assertions
  alone, a placeholder token typed, a credential echoed, a login proof on the
  login page, an unpinned date, an unindexed verb, a goto to no route, a
  fixture asserted as fact, a wording claim on a data row, an unreconciled
  match — each is a false claim, and `CLAUDE.md`'s premise 3 says refusing it
  is the right answer. Owed, if a live row shows them refusing a true claim:
  a `settle` for `unpinnedDateEntry` (a `setClock` of the run's own `now`) and
  for `countPinnedName` (the name without its count).
- **The procedure says to cover every claim in one answer** and names the
  accepted forms for the two shapes the row tripped on (a cleared textbox is
  `expectValue ""`; a closed set is `expectCount` + presences), so the first
  ask rarely needs the fallback.

Why it cannot make the result worse: a rewrite reads a tree line, the intent's
own pair, or the sheet's own Test data — never a guess — and a settlement is
either the lint's OWN remedy performed from the evidence (the count, the
tree's role) or a note that names what is not covered; a refusal with no
grounded rewrite is the refusal the budget would have reached anyway. Long
Test data cells were checked, not fixed: `describeCase` renders the whole cell
(HIR-EC-001's 1,550 characters, one pair per line); only the RUNTIME card
(`caseCard`) cuts at 420, and the exclusivity fragment came from the
word-boundary bug, not from truncation. Not verified live: the authoring
itself (opus via `claude-cli`, whose output side `provider-expert` is changing
today); verified offline through the lints and the parser on the real rows.
Tests: `tests/sheet-grammar.test.ts` (CG-12, "resolves a reference against
the Scenario ID column"), `tests/author-wave2.test.ts` ("a step the harness
cannot run as written is rewritten and marked"; CG-08's one-alternative case
re-pinned), `tests/flow-author.test.ts` ("the last word is a rewrite, not a
refusal": `settleViolations`, the step-7-of-8 hand-over, the identical
refusal settled on attempt 2, a token still refused, the ungrounded text
annotated, `settleSelectorRole`, `settleExclusivity`).

### Addendum, same day: ML_01_04 — a noun read as a verb, and what the last word could not settle

The panel's job-6 (`--author-attempts 1`, so attempt 1 IS the last word) blocked ML_01_04 on `skipsAuthoredScript` (fatal, no `settle`) plus the weak `workflowOverDeclaredControls`; the rebuilt dist was in use (job started 08:54Z, dist 15:46 local = 08:46Z). What stopped the settle was simply that the fatal lint had none — and it should not have fired: the script says `5. เลือก Leave type = Sick Leave`, and the typing tier matched the NOUN "type" (the head of a `Field = value` pair). Fixes, all structural:

- **`scriptDemand`**: a demand word immediately followed by `=` / `:` is a field name (the sheet's own pair grammar), never the verb. A `workflow` leg performs the typing and choosing tiers as it already performed the acting tier — whether its claim is settled is `unsettledWorkflowClaim`'s question. ML_01_04's body (choosing through agent legs) now passes the lint outright.
- **`workflowOverDeclaredControls`**: a declared word inside a longer CAPITALISED run in the goal ("Type" in "Leave Type", "Leave" in "Sick Leave") names that longer thing; a declared compound matches on its own turn; every occurrence is judged; a lower-case goal keeps the plain match (`capitalisedRunAround`, read from casing, no word list).
- **`settleScriptDemand`** (the fallback for `skipsAuthoredScript`): each uncited script line of the demanded tier is performed — every `Field = value` pair on the line (or the Test data pair the line names) whose field a tree/probe line names becomes the entry step the tree's ROLE dictates (`entryStepFor`: textbox → fill, button/combobox → selectOption, checkbox → check, radio/option → click), cited `Step N:` and marked; a line nothing grounds becomes a `workflow` leg whose goal is the sheet's own line, marked the same way. Placed before the first body step citing a later script step, else before the first assertion.
- **`settleWorkflowGoal`** (for the weak lint, applied on acceptance — `settleViolations` now lets a weak complaint run its own settle before falling back to its note): the goal's `Field = value` pairs a tree names are split out as entry steps before the leg, and the leg is annotated. Values in prose are cut by casing (`valueHeadOf`: "Sick Leave and pick today" → "Sick Leave").
- `insertStepBefore` / `appendOrInsert` skip a case whose `steps` IS the body's array (the folded single case shares it) — found by the test, it would have inserted twice.

Tests: `tests/flow-author.test.ts` ("a script step is performed, never read as a noun, and the last word performs it (multirole ML_01_04)"): the noun rule, the workflow-leg rule, the compound rule, `settleScriptDemand` from the tree and to an agent leg, `settleWorkflowGoal`, and the pipeline shipping the ML_01_04 shape on attempt 1 of 1.

## The authored host is the deployment host (2026-09-07)

`foreignAuthoredHost` is a fatal authoring lint over setup and body steps. Every
absolute HTTP(S) URL carried by a step must use the deployment URL's exact host;
relative URLs and `{{variable}}` placeholders remain portable. The informed
re-ask names both the authored and expected hosts and says that the run's own
host is the only one this catalog may reach. This runs before route grounding:
a typo in an origin is authored evidence failure, not an application environment
error, and applies equally to `goto`, `signIn`, `request`, and any future step
that carries a string `url`. Tests: `tests/flow-author.test.ts` ("authored
absolute URLs stay on the deployment host").

## The Expected output is the measure; a Test data gap is a means, not an end (2026-09-07, HIR-EC-001)

A sheet's Test data column is written by a person under time pressure and is
routinely incomplete. Its Expected output column is not: that is what the case
claims, and it is the only thing a verdict may rest on. So the two columns
carry different authority, and a required field is routed by which one names
it:

- **A field the Expected output names** is the claim. It takes the sheet's
  value exactly, as a deterministic entry step — never a goal handed to the
  agent to satisfy however it can. HIR-EC-001's `Hire Date = 01 Sep 2027` is
  Expected line 3.1; authored as part of a forty-field workflow goal, the
  agent spent five consecutive turns guessing at a segmented date picker
  (`paste` on the date node, `click` "Show date picker", `paste` by
  aria-label, `click` "Select date", `fill` `spinbutton "Day Day"`) and the
  stall judge ended the leg. A `fill` with the resolved value would have taken
  one action.
- **A required field no Expected line names** is a turnstile on the way to the
  claim. The harness supplies a valid value itself and records that it did —
  it must never stop because the sheet was silent. HIR-EC-001 is blocked at
  `Personal Information (Attachment) *` with "no file path or file is
  available", and not one of its nineteen Expected lines mentions an
  attachment. `src/data/fixtures.ts` already mints exactly this
  (`pdf:medical-certificate` and its vocabulary) and `engine/upload.ts`
  already drives the dropzone; what is missing is the author emitting the
  `upload` step when the sheet names no file, because the sheet naming a file
  is not the reason the step exists.

The report keeps the distinction visible: a value from the sheet and a value
the harness minted are both evidence, and a reader must be able to tell them
apart. This is the same rule as **Values the sheet left as tokens are
resolved, and a stand-in is flagged** above, widened from "the sheet wrote a
token" to "the sheet wrote nothing at all".

**A workflow leg cannot attach a file.** `AgentModel`'s action vocabulary has
no `upload`, so once a form section is handed to a leg, a required attachment
is unreachable by construction, not merely unlikely — the agent clicks the
Upload button and the dropzone correctly and then has nothing left to try.
Either the author emits the `upload` step outside the leg, or the leg can
never finish a section that has one.
