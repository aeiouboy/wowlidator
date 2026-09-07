# CLAUDE.md — the report

Split out of the root CLAUDE.md (2026-08-24) so this loads only when working under
`src/reporter/`. Same authority as the root file; the root keeps the map of the whole system.

## Reading the report (`src/reporter/verdict.ts`)

The report used to answer "what did the machinery do" before "what happened and who should act". Three layers now, strictly ordered: **verdict** (what broke, which side, is it new), **timeline** (intent-first steps, failures auto-expanded), **diagnostics** (rungs, tokens, coverage, trend — collapsed).

**Every sentence in the verdict is a pure function of the bundle** (`buildVerdict`), which is what makes the wording testable rather than buried in a template, and what guarantees it cannot contradict the evidence below it. `ownerOf` deliberately mirrors `ProofSummary`'s defect attribution — a report that says "frontend problem" above a defect table filing it under backend is worse than one that says nothing.

**Jargon is renamed only in layers 1–2**; layer 3 and the JSON keep the precise terms, so nothing downstream has to care. Every badge that survives carries its plain-language explanation inline via `GLOSSARY`, and there is a test asserting no badge can be rendered without an entry — a new badge with no explanation is exactly the failure this section fixed. `fast` is deliberately unbadged: every ordinary step resolves that way, so labelling it adds noise to the steps needing no attention.

**Failure evidence is ranked by diagnostic value**, not by source: intent and one-line error, screenshot, the escalation trace as prose (`escalationTrace`), failed network calls, then raw detail. An unrecognised rung passes through with its own name rather than being dropped — a rung added later must never silently vanish from the account of what was tried.

**Captured application text is quoted, never translated**, and marked `lang=""` when it leaves the Latin script: a report is evidence, a translation is a claim about evidence, and naming a language we did not detect would be a second claim. Only non-Latin text is marked, or every selector in the report grows an attribute that says nothing.

## Proof bundles and the report

`ProofBundleBuilder` records, per step, *how* the selector resolved (`fast` / `cache` / `jit`) alongside pass/fail, plus any `AgentRecord` and screenshot. The summary rolls that up with heal latency, agent latency, token usage, and defect count. That breakdown is the point: a suite whose `jitHeals` count is climbing is drifting, and the bundle is what tells an MCP client so. Bundles land in `.wowlidator/proofs/<runId>.json` by default.

Steps with no selector (`goto`, `workflow`, and every action in `API_STEP_ACTIONS`) have `resolution: null` and are excluded from the `fastPath` count — a 4-step flow with one `goto` reports `fastPath: 3`. An HTTP step is free, but `fastPath` counts *selector resolutions on a page*; crediting a `request` there would put backend work inside a frontend number.

**`summary.frontend` / `summary.backend` split the run by which side of the system a step exercised** (`API_STEP_ACTIONS` in `proof-bundle.ts` is the one definition of "this is an HTTP step", shared with `isBrowserFree()`). A mixed flow's headline pass/fail cannot answer the question anyone actually asks when it goes red — *which side is broken* — and a failed `expectVisible` and a failed `expectStatus` go to different people. Defects are attributed by a three-step rule, and the ordering is the load-bearing part: **category `backend` wins outright** (it is raised for traffic the *page* made, so it can sit on a `click` step and still belong to the API side), otherwise **the step's own side decides** (a malformed `request` counts against the half of the test it lives in), otherwise **frontend** (a static generator finding has no step, and the generator only ever looked at the UI). `frontend.defects + backend.defects` always equals `defects`; there is a test asserting the halves reconcile with the headline. The CLI prints the two lines only when there is a backend half to report — `backend 0/0` on every UI run would be noise pretending to be information.

**Every assertion records `expected` and `actual`, pass or fail** (`detail.expected` / `detail.actual`, written inside the check itself — `expectText` keeps an excerpt of the page text around the match via `excerptAround`, `expectUrl` the URL it ended on, the state assertions the state they read, `expectStatus`/`expectJson`/`expectHeader` what the response held). "It passed" and "it passed and the page really held 119 days" are different amounts of evidence, and the second is what catches a vacuous claim. `expectedActual()` in `proof-bundle.ts` is the one formatter: the CLI step line, the report's always-visible `step-compare` line (those two keys are dropped from the generic detail dump so they never render twice) and wowUI's checks table all read it or mirror it.

**Every bundle carries the test's polarity** — `ProofBundle.polarity` (`positive` / `negative`) plus `polaritySource` (`stated` / `inferred`). A negative test passes by proving the application *refuses* something, so its green run read without the label says exactly the wrong thing. A test-case sheet's own Positive/Negative column is the author's word and is stamped into the flow file (`Flow.polarity`, `authorEachRow`) so re-runs and repairs keep it; absent that, `runFlow` infers deterministically (`src/engine/polarity.ts` — refusal wording in English and Thai, or a step shape that can only mean refusal: an all-4xx `expectStatus`, an `expectCalls` with `never` entries). Inference understates: `expectHidden` alone is NOT negative (it is also the canonical login proof), and a status list mixing 200 and 422 is a tolerance, not a refusal claim. Shown as the report's header pill, wowUI's `positive`/`negative` tag on task and history rows, and `[negative]` on the CLI roll-up line.

**`ProofStep.intent` is carried through verbatim from `FlowStep.intent`, never regenerated.** Both `#step` (the escalation-ladder path) and `#bareStep` (absence assertions, storage seeding — anything with no selector to heal) copy it onto the recorded step; `html-reporter.ts` renders it as an always-visible line under the step header, in the author's own words from the `.flow.json`, so a report reads as "what this step checks" rather than only "what selector it hit." It is deliberately dropped from the generic detail key/value dump so it isn't shown twice.

**Live console progress is opt-in callbacks, not `console.log` calls buried in engine code.** `ProofBundleBuilder`'s `onStep`, threaded through `RunFlowOptions.onStep`, fires synchronously right after every `addStep()` — the single choke point every action (`goto`/`click`/`#step`/`#bareStep`/`fillEach`/`fillRetry`/`snapshot`/`workflow`) already goes through, so one hook covers all of them for free. `WorkflowAgent`'s pre-existing `onAction` gives the same thing per agent turn (a `workflow` step can run for several seconds across multiple model calls with no other visibility into it before the step as a whole finishes). `FlowRepairLoop`, `TestGenerator`, and `FlowAuthor` each take a plain `onLog?: (line: string) => void` for their own lifecycle narration ("asking the generator role for a fix…", "got N case(s)…"). None of this prints anything by itself — `src/cli/runtime.ts`'s `stepLogger()`/`lineLogger()` wire `console.log` in, gated off under `--json` (whose stdout must stay one parseable document), and `src/mcp/server.ts` passes neither, so MCP's stdout stays exactly as clean as the "MCP owns stdout" rule already requires. `formatStepLine()`/`formatAgentAction()` in `proof-bundle.ts` own the line formatting, same separation as `formatProofSummary`.

**`passed-with-issues` — the claims held, the path did not.** A run whose assertions ALL passed (and it made at least one) while only *action* steps broke (`failed`/`dead-end` clicks, navigations, agent legs) is a qualified pass: the row's claim was proved, the flow's way to it was not clean. Measured (BE_Test2 PL_02_03, 2026-08-19): a click dead-ended at step 3 on a consent gate, the same control was clicked and passed at step 6, both assertions passed — reported `dead-end`. Now `PASSED-WITH-ISSUES … 7/9`, and `isPassing()` is the one predicate every consumer asks (exit code, trend, quarantine, suite index, panel filters, roll-up — which says "passed, with issues"), so it is a pass everywhere and an issue everywhere. Three exclusions keep it honest: an `error` step never qualifies (the HARNESS could not proceed — a save that never landed, a database unreached; a held claim after one is a claim, not a run); a run-level *fatal* never qualifies (the session guard, a dead browser — the claims were asserted against the wrong page), which is why the "completed with N issues" tally is now typed apart as `StepIssuesError`/`recordIssueTally` rather than recorded as the run error; and the report's verdict copy says outright that a claim which holds whether or not the action before it landed may be a claim about the wrong thing. The `warn`-coloured rail slot and the dashed "proved, with issues" chip mark it in wowUI.

**A flow whose only assertions are the sign-in proof and a URL is vacuous, and three places refuse it the same way** (`src/generator/vacuous.ts`). Measured on be100.csv (2026-08-21): 20 of 22 `pass**` and 5 of 13 plain passes were login → goto → (workflow) → expectUrl — green about rows whose Expected Output they never touched. The mechanism was not a model declining to write the test: it wrote the middle, **the steps were dropped on narrowing** (`got 1 step(s), 3 dropped` — and nothing said why), the lints refused "no assertion"/the thin workflow claim, and after the budget the weak claim was accepted. So: (1) `dropReasonFor` names why each step was dropped, the log prints it, and the drops ride along as a weak violation so the re-ask knows what to fix; (2) `vacuousClaim` is a **fatal** lint in `FlowAuthor` — on the last attempt the case is blocked (`AuthoringError`), never handed over green — and the prompt's procedure says the sign-in proof and a URL are preparation, never the claim; (3) `runCases` does not run a vacuous flow already on disk: it is recorded `blocked` with `vacuous: true` in the ledger, and `remaining()` includes vacuous outcomes so `--resume` re-authors them. `catalog --rerun-vacuous` (implies `--resume`) re-reads every recorded outcome's `flowPath`, marks the vacuous ones, and continues — the mass re-run for a suite that already has them. Two siblings on the same ledger: `--rerun-errors` (cases the harness ended — an `error` bundle or none — are not verdicts and run again) and `--rerun-failed` (failed/dead-end cases run again with autoheal; implies `--repair`). All three imply `--resume`; `markForRerun` turns the chosen outcomes back into `blocked` with a reason prefix. wowUI's suite banner offers **Continue testing**, **Rerun all errors (N)**, **Heal all failed (N)** and **Re-author vacuous** — one route, `POST /api/jobs/<id>/resume` with `{mode}`, each mode a flag the command's spec declares. `tests/vacuous.test.ts` covers the predicate, the drop reasons and the ledger marking; `flow-author.test.ts`'s "thin" fixture gained a real assertion, because workflow + expectUrl alone is no longer thin — it is the vacuous shape.

**`passed-with-issues` prints as `PASS**`** (`statusLabel`/`issueSteps` in `proof-bundle.ts`; the same spelling in the CLI roll-up, the report verdict and wowUI's chips). It IS a pass and `isPassing` is untouched; the asterisks point at the action step(s) that broke on the way, which the roll-up names (`pass** (** step 3 click … — error)`) and the summary lists as `** issue` lines — so a reader sees where to look without mistaking it for a validation failure.

**Pause is instant (2026-08-24, twice).** The first cut of Pause "wasted nothing": it stopped TAKING new cases and let the in-flight ones finish with verdicts — which at 3–5 concurrent lanes of minutes each meant the pause landed a quarter of an hour after the click, and a pause that slow is not one (changed the same day, by request). Now SIGUSR2 (wowUI's Pause button; `kill -USR2 <pid>` from a terminal) makes `runCases` write the ledger's pause record synchronously (`paused with N case(s) still to run — in-flight cases were interrupted…`) and **exit on the spot**, `EXIT.environment` — the pause says nothing about the application. Interrupted cases keep NO verdict, so `remaining()` includes them and **Continue testing / `--resume` re-runs each from its own first step** (a browser's mid-case state cannot be resurrected anyway) **while every finished verdict is carried into the resumed roll-up** — in a fresh process, on whatever the code and flow files say at resume time, never the paused process's image. The pause FILE (`<ledger>.pause`) is polled every 500ms inside `runCases` so it is as instant as the signal; `runQueue`'s `shouldPause` dispatch check remains as the backstop. A suite with **no** ledger keeps the old graceful behaviour — nothing to resume from, so exiting instantly would only throw finished-in-flight work away. Pause and Stop (SIGINT) now differ in intent and wording, not mechanics: Stop means "done with this run", Pause means "continue it later". The wowUI banner reads Paused (from the ledger's own cause), and the job reports `stopped` whatever the exit code says — a green chip over a half-run list would be a lie the banner then contradicts.

**The auto-review judge rules the proved-? — both ways at the bar (2026-08-24, asked for by the person running this; widened the same day).** When a run lands on proved-? and the `agent` role resolves a key, `src/engine/review-judge.ts` makes ONE small call: the retrieved case context (`Flow.caseContext` — the sheet's own claim, expected output and notes) beside every unsure expected-vs-actual pair. At `AUTO_PROVE_CONFIDENCE` (0.7, `WOWLIDATOR_AUTO_PROVE_CONFIDENCE` moves it) or better the judgement is stamped as the ruling — **proved** on a confident "yes", **failed** on a confident "no" — so `effectiveStatus` reads it everywhere (exit code, roll-up, wowUI) while the machine's own `needs-review` status stays on the record. The "no" side is new: the judge used to only resolve doubt upward, defensible while only ≥50%-overlap near-misses reached it; now that EVERY wording mismatch defers (see the next paragraph), an unruled far miss would sit at proved-? forever. Three rails: the ruling is always LABELLED as the model's (`by`, confidence, reasoning — and a model "failed" lists red in the panel, where failures are exactly what people look at) and a human may replace it (never the reverse — a human ruling is final); anything short of the bar leaves the run for the human with the judge's opinion on `notes`; and a judge fault (no key, provider error, `WOWLIDATOR_AUTO_PROVE=off`) changes nothing — the run is exactly the proved-? it was. `buildReviewJudge` in `cli/runtime.ts` gates it, `appendToHistory` applies it before the history write so recalls carry the ruling.

**A suite keeps a progress ledger, and a run that stops short is continued, never restarted** (`src/cli/suite-progress.ts`). Live, 2026-08-21: a 108-row catalog stopped at row 36 and the only way on was all 108 again. `runCases` now writes `<claims>.progress.json` (beside the claims file — the one input a resume can be keyed on before any report folder exists; since 2026-08-24 the ledger is kept even on a first pass with no `--claims`, keyed on the claims file the run itself just wrote) **after every case**, records the cause when it can (a thrown case, a SIGINT/SIGTERM from the panel's Stop — written synchronously on the way out), the ledger also carries the pass's `generatedAt` **stamp**, which a resume reuses as its own provenance so its cases join the original group in wowUI (runs are grouped by that stamp; a resume is the same approved list, not a new pass) — and `catalog --resume` skips every planned case that has a **verdict** (passed/failed/proved-?: re-running a failure is a retry, a different decision) and authors+runs the ones that never ran (`blocked`) or were never reached, stating the counts. A case with status `error` is labelled **runtime error** on screen.

**A run the harness alone ended scores `blocked`, never `failed` (2026-08-24).** `harnessOnly()` in `cli/exit.ts`: every broken step status `error`, nothing about the application contradicted — a database never configured, an agent that gave up, a provider refusing on quota. Measured before the change: 136 of 544 live bundles, all scored `failed`, a missing `WOWLIDATOR_DB_URL` reading as "the test found a bug" 22 times. Blocked means `remaining()` includes them, so plain `--resume` re-runs them once the environment is fixed; one real `failed`/`dead-end` step anywhere keeps the failed verdict. `exitCodeFor` consults the same predicate, so single runs and suites agree. See `src/api/CLAUDE.md` for the whole false-failure audit.

**A catalog run has a unique key, and a resume answers for the whole catalog under it (2026-08-24).** `cmdCatalog` mints `<catalog name, slugged>@<pass stamp>` at initialisation — the stamp is set then too, not lazily at the first authored flow, so a run that dies while authoring still leaves a keyed ledger — and the key lands in `SuiteLedger.runKey` and every bundle's `GenerationProvenance.runKey`; a resume reads the stored key back and continues under it (grouping still keys on `generatedAt`, which the key embeds, so pre-key bundles of the same pass group with keyed ones). The other half is pull-forward in `runCases`: on a resume, planned cases the earlier pass already finished are **carried into the resumed run as finished tests** — `carriedOutcomes`/`sortByPlan` merge their ledger verdicts into the roll-up (marked `[finished by the earlier run]`, counted in the header, excluded from the `spent` line), into `suiteExit` (a resume can no longer exit 0 over earlier failures), and — via `LedgerOutcome.proofPath`, recorded per case — their re-read bundles into the suite index, so the index lists the whole plan rather than the resumed subset. The ledger also records `launch` (catalog, claims, url, repo — never credentials), which is what lets wowUI rebuild a resume with no in-memory job: `GET /api/catalog-runs` scans the two catalog dirs for `*.progress.json` and lists each run by key with `summariseLedger` counts (the ledger is authoritative where `Job.ended`'s stdout parse was an estimate), the banner renders from that list — so it survives a panel restart — and its buttons post `{ledgerPath, mode}` to `POST /api/catalog-runs/resume`, which reuses the same-session job's argv when one exists, else builds argv from `launch` through the `catalog-run` spec (`buildArgv` — the whitelist still says what runs), refusing a ledger path it did not itself list. `POST /api/jobs/<id>/resume` still exists for same-session jobs.

**A guessed quota never refuses work.** The first cut of the pacer ended the day at 90% of the *table's* RPD — and `gemini-3.5-flash-lite` was not in the table, so a 500-RPD tier was cut off at 225 by this code, seventy cases blocked. The table and `WOWLIDATOR_GOOGLE_*` now only *pace* (and warn once past the believed day cap); the day ends only when the server's own 429 names the daily metric (`learnFrom` → `#dayBlocked`). `RateBudgetExhaustedError` maps to `EXIT.environment`.

**Containment is a near-miss, both ways round, and one dead-end shape qualifies (2026-08-24).** `nearMiss` accepts either side contained whole in the other for any script — an exact-match instrument that found the right TEXT in the wrong shape is a wording call, never a plain fail — while the numeric guard still outranks it (a missing number is a defect). And a presence assertion that dead-ended on `text="X"`/`role=…[name="X"]` while the live page's own `innerText` CONTAINS X is stamped `foundInPageText` by the runner (one $0 read on the failure path, `#textContainedInPage`), which is the only dead-end admitted to proved-?: absence is disproved by the page's own words, so the run defers instead of filing "could not resolve" about text that is on screen (be100 PL_06_10, live: 40s and a healer call to disprove nothing). A dead end without the stamp stays a dead end.

**proved-? (`needs-review`) — the verdict that defers to the judge, then a human.** A run whose only broken steps are failed **assertions** with a recorded expected-vs-actual **wording mismatch** (`nearMiss()`, broadened 2026-08-24 from a ≥50%-word-overlap detector to every wording mismatch: after the deterministic comparison reads the actual, anything not accurate or contained is the judge's call, not a token ratio's — the ratio flat-failed translated renderings it scored at 0%; a numeric token is exact or nothing — 119 against a promised 120 is the catalog's own documented defect and must never soften; purely numeric expectations, identical strings, `error` steps, un-stamped `dead-end` steps and run fatals all still disqualify) is a wording question the machine must not rule on — PL_02_03's `expectModal "Create Plan"` against a dialog the app titles "Create Benefit Plan", live. The run takes status `needs-review`, each unsure step carries the exact expected-vs-actual pair on `ProofStep.unsure` (the proof of the unsure part), and `ProofBundle.review` is where the human ruling lands — written by wowUI's **Confirm proved / Confirm failed** buttons through `POST /api/proofs/<runId>/review` (temp-file + rename into the bundle file; a second ruling is refused 409 — changing a decision means editing the file). The machine's status is never rewritten: `effectiveStatus()` is the one place the ruling outranks the deferral, and every consumer asks it. Until ruled, proved-? is **neither** green (`isPassing` says no) **nor** a product failure: `exitCodeFor` and `suiteExit` score it with the blocked family (`EXIT.environment`), the roll-up prints `? name — proved-? (a wording near-miss; confirm proved or failed in the panel)`, and the report leads with `PROVED-?` plus a per-step "a human must rule on this step" callout. `tests/needs-review.test.ts` covers all of it.

**The film is kept whole when the run carried past a failure.** The "cut at the first broken step" rule was written when a failure ended the run; its premise — everything afterwards is a state the test no longer understands — stopped being true when steps after a failure started getting their turn. Measured on the same case: a 13-second recording ending at step 1, the one part of the run that proved nothing, while the rescue and both passing assertions went unfilmed. `#videoCut` now returns `'full'` whenever a later filmed step exists past the first break (the player still opens pre-seeked to the break via `data-failure-offset`, so the moment the film was kept for is the first frame seen), and cuts at the break only when it was the last filmed step.

**Defects** come from two sources and the report labels which: `generator` (static findings from the AX tree, no run required) and `runtime` (a failed step, a failed workflow goal, or — at `low` severity — a selector that had to be healed, since that means the test is drifting from the app).

**Identical runtime defects cluster at recording time** (`addDefect`: same title, selector, category, severity → one defect with `occurrences` and `stepIndexes`) — eleven copies of one broken login block read as eleven problems when they are one problem hit eleven times. Generator findings never cluster. **Failures after the first are marked `ProofStep.downstream`** — possibly consequences, not findings — and the report badges them so. **`ProofStep.pageContext`** carries what the page was showing at a failure (AX headings already captured for the heal — never a fresh capture), and the verdict leads with it: "the page was showing 'Access Denied'" outranks "could not resolve". **Video offsets are reconciled at `setVideo()`**: the recording is cut at the first failure, so any step offset at or past `durationMs` is stripped — a "play from here" that seeks past the last frame is a dead control pretending to be evidence. An absence assertion that passes after an earlier failure gets a **"passed, in doubt"** badge: "not shown" is also what a broken page looks like.

`html-reporter.ts` is a pure function (`renderReport`) plus a writer. Constraints that must hold:
- **Self-contained.** Inline CSS and JS, screenshots as `data:` URIs. No `<script src>`, no external stylesheet, no remote image — the report has to open off a USB stick. There's a test asserting this.
- **Escape everything.** Page text, model reasoning, and defect titles all reach the HTML. Use `esc()` on every interpolation; there's a test that feeds `<script>alert()</script>` through a defect title.
- Failed steps auto-expand on load; everything else starts collapsed.

**Report destinations** resolve through `resolveReportPath()` in the reporter — one function, used by the CLI and MCP alike. It handles file vs directory vs `{placeholder}` template and returns `null` when reporting is off, so callers branch once instead of threading a flag around. Two things to preserve if you touch it:
- `{name}` / `{kind}` go through `slugify()` because they can come from a model. Dropping that reintroduces a path-traversal write. There's a test for it.
- The trailing-separator check must happen **before** `resolve()`, which strips it.

Precedence is CLI flag → env (`WOWLIDATOR_REPORT_PATH` / `WOWLIDATOR_REPORT_DIR` / `WOWLIDATOR_DISABLE_REPORT`) → `.wowlidator/reports/`. Multi-report commands pass `index` and `kind` in the context so generated cases can't overwrite each other.

### The run on film (`src/engine/video.ts`)

**A still cannot show a click.** It shows the page before one and the page after one, and those two images are identical whether the click landed on the right control, the wrong control, or nothing at all. So the default evidence is a **recording** (`VideoMode`, default `on`), and stills are kept only where someone will zoom in.

**A recording is evidence of a failure, and it is kept only when there is one.** The rule, in full: *when a step fails, keep the film from the start of the flow to that step; if that cannot be done, keep none of it.* Three parts, each load-bearing:

- **From the start**, because the state leading up to a failure is most of what makes it diagnosable — the click two steps earlier that went to the wrong control is the thing worth seeing, and it is unrecoverable afterwards.
- **To that step**, because a recording that carries on past the failure buries the moment it was kept for. The cut is clamped so it can never reach the *next* filmed step (`SmartRunner.#videoCut`): a run continues after a failure, and film of what happened afterwards is no longer film "up to the failure". The **first** failure, not the last — after one step fails the run is in a state the test no longer understands, so later failures are usually consequences.
- **A superseded failure is not the failure.** In-run reconstruction can rescue a step mid-flight; cutting the film at the rescued attempt produced a PASSED run whose recording showed two steps of five (seen live: "Navigate to Contact Us Page"). `#videoCut` skips superseded steps, and a run that was rescued keeps its **whole** film — the break and the rescue are exactly the footage the drift defect asks someone to look at.
- **Otherwise nothing.** A run that passed cleanly keeps no recording at all, which is what makes filming affordable as a default: the reports that carry one are exactly the ones somebody opens. And a recording that cannot be cut faithfully is discarded rather than handed over whole — see `webm.ts`.

Two things had to be established by running it, and both shape the design:

- **Playwright records over a CDP connection, but only on a context it created.** `recordVideo` is a `newContext` option with no way to switch it on for a context the browser already has. So `SmartRunner.connect` stops reusing `browser.contexts()[0]` when filming — **which means a fresh cookie jar**, and that is the real cost of this feature, not a detail. It is the entire reason `--video off` exists: a run that depends on a session someone signed into by hand must turn filming off.
- **Playwright videos contain no mouse pointer.** The browser composites the page, not the cursor the OS draws on top of it, so a recording of a perfectly good click is a recording of a page changing for no visible reason. **The pointer is drawn by the page**, from `CURSOR_OVERLAY_SOURCE` injected via `addInitScript` — a dot that follows the synthetic input, turns green and pulses a ring on mousedown, plus a caption naming the step now running (`SmartRunner.narrate`), so the video is still an account of a test after it has been pulled out of the report and attached to a bug.

**`CURSOR_OVERLAY_SOURCE` is a source string, not a function, and that is load-bearing.** `addInitScript` serialises a function with `Function.prototype.toString`, so what reaches the browser is whatever the *build* left behind — and under `tsx` the transpiled arrow installs nothing at all: no error, no warning, no pointer. Passing source verbatim removes the build from the path. There is a test asserting it stays a string.

The overlay is injected into the application under test, so three rules keep it from becoming part of what the test measures: a **closed shadow root** (the page's own queries, every flow selector and the healer see one anonymous zero-size host and nothing inside it), **`aria-hidden` + `pointer-events: none`** (absent from the AX tree the healer and coverage inventory read; can never intercept a click), and **it installs itself late and repeatedly** — at document-start `document.documentElement` is still `null`, so a single attempt is guaranteed to be too early. There is a test asserting the overlay changes nothing a flow can see.

**One recording per run, addressed per step.** `ProofStep.videoOffsetMs` is stamped in `ProofBundleBuilder.addStep` — one derivation rather than eighteen call sites — and the report turns it into a "play from here" on every step. That is what makes a single clip per-step evidence instead of something a reader has to scrub. An HTTP step gets no offset for the same reason it gets no screenshot: nothing about a `request` happened on screen.

Frames are capped at 960 on the long edge; the recording itself has no size cap (the 24MB ceiling was removed 2026-09-03 — see the catalog report notes below). `video.omitted` remains for an embedder that made a recording it cannot carry, because "it did not fit" and "nothing was recorded" are different facts. Sealing happens **between closing the context and closing the browser**, in that order — Playwright finalises a video when its context closes, so asking earlier reads a truncated file no player will open.

**The cut happens in the container, with no encoder** (`src/engine/webm.ts`). Playwright can only stop recording by closing the context, which is the end of the run, so the trim is done afterwards on the finished file — and dropping the *tail* of a WebM needs no re-encoding, because frames are stored in order and nothing kept still refers to what was removed. (Cutting the *head* would be a different problem: every frame after a keyframe depends on it. The segment always starts at zero, so that never arises.) Playwright writes one cluster per ~5 seconds, which is far too coarse to end at a step, so the cut is made **block by block inside the last kept cluster**; `Cues` and `SeekHead` are dropped rather than rewritten, since their byte offsets do not survive it. The output is then **re-parsed and verified before it is returned** — same rule as `catalog/extract.ts`: never hand back something we could not check. Anything unexpected returns `null`, and `null` means no video at all. A subtly malformed recording is worse than none, because it plays for three seconds and quietly misrepresents when the run ended.

Three more found by running it, each now load-bearing:

- **Chrome will not load a `data:` video.** The element sits at `readyState 0` / `networkState 2` forever with no error, which reads exactly like a corrupt recording — and it is not: the same bytes play instantly from a Blob. So the base64 is carried on a `data-webm` attribute and the page's own script turns it into an object URL. The bytes are still inline, so the report is still one file. Diagnosed by extracting the base64 back out of a rendered report and playing it, which worked.
- **A named function inside `page.evaluate` is a landmine under `tsx`.** esbuild rewrites `const wait = (ms) => …` into `__name(wait, "wait")` to preserve `fn.name`, Playwright ships the function's *source* to the browser, and `__name` does not exist there — so the whole callback dies with `ReferenceError: __name is not defined`. This is the same hazard as `CURSOR_OVERLAY_SOURCE` being a string, in a second place. It was live in `evidence.ts`'s `primeLazyContent`, where `captureEvidence` swallows everything, so the symptom was not an error but a silence: the lazy-content walk never ran under `tsx`, and full-page captures of a lazy-loading page were the skeleton loaders that function exists to prevent. **Keep every function inside an `evaluate` callback anonymous.**
- **A caption does not survive a navigation.** It lives on the window, and a navigation replaces the window — so without `keepCaption` (a `framenavigated` listener, not a re-caption inside `goto`, because a click can navigate too) the film runs uncaptioned from the moment a page loads until the *next* step starts. That is precisely the stretch a `goto` is on screen for, so the one step whose caption matters most would be the one that never showed it.
- **Nothing else will close the recording context.** Between `newContext` and a constructed `SmartRunner` there is a window where a throw would abandon it, and an abandoned context is not garbage — it is a live context in a Chrome that outlives the process, one per failed run. `connect()` unwinds it explicitly.

**`--video always` keeps the whole recording whatever the outcome** — the film of the mock user performing the task, end to end, untrimmed (still parsed and measured before it is trusted, like every cut). It exists for "view actual flow": wowUI's run detail plays the film in a modal with a **live subtitle bar** driven by the bundle's own `videoOffsetMs` segments — which step the mock user is performing at this moment — and a step-chip timeline; the failing segment and chip turn red and carry the error's first line, so the film shows *where* it broke and the subtitle says *how*. A run with no film offers **Record actual flow**, which re-runs the flow with `video: always`. The HTML report's player carries the same subtitle bar (`data-segments`, server-rendered). Superseded attempts get no subtitle highlight — they are attempts, not outcomes.

**Steps are paced for a viewer only when a viewer is the point.** `stepDelayMs` pauses before each step — after the caption, so the viewer reads what is about to happen and sees the state it starts from. Defaults: `DEMONSTRATION_STEP_DELAY_MS` (1.5s) under `--video always`, zero everywhere else — the hot path stays hot. `--step-delay <ms>` / `WOWLIDATOR_STEP_DELAY` set it explicitly for any run; a crawl is never paced (nothing films it).

**`--video off` restores the old behaviour wholesale**: no recording, and stills on every step.

**Stills follow the recording unless set explicitly** (`ScreenshotMode`; `--screenshots auto` and `WOWLIDATOR_SCREENSHOTS=auto` are how "unset" is said out loud, which is otherwise inexpressible once the env var is set). Filming drops them to `on-failure`: the film already carries every other step, and what a still adds over a frame is resolution, which matters at exactly one place. With `--video off` the mode returns to `all` and everything below is exactly as it was.

**A crawl is never filmed.** It drives a page borrowed through `withPage` rather than a recording context, so stills remain its only evidence — and `--video` says so rather than offering a control that does nothing.

### Stills

**When they are captured, they are captured on every step, not only the one that broke** (`ScreenshotMode`, `all`). A failure screenshot shows the wreckage; the frame *before* it is usually where the wrong thing actually happened, and that frame cannot be recovered afterwards — re-running to look changes the very timing that produced it. `SmartRunner.#shoot` takes an `EvidenceKind` rather than two booleans, and the three kinds are what make "every step" affordable:

- `failure` — the step that broke.
- `notable` — passed, but something happened worth seeing: a heal, a dismissed dialog, an agent turn, a regenerated data value.
- `routine` — passed, uneventfully. Individually dull, collectively the filmstrip.

Two size decisions, because a report is one self-contained file and every byte lands in it: **`scale: 'device'`** (full native resolution — a capture someone zooms into must not have been downsampled; the JPEG quality tiers absorb the size pressure), and **routine frames encode at a lower JPEG quality than the ones being examined** — a filmstrip frame is looked at to see roughly what was on screen, a failure screenshot is looked at closely.

**An HTTP step gets no screenshot even under `all`.** It never touched the page, so a picture of the page is not evidence about it — the request/response pair already recorded is. Evidence proportionate to what the step exercised.

**The filmstrip reads as one connected journey, and the eye lands where it snapped.** Frames are chained with arrow connectors (step N → step N+1), each labelled with its index and action; the connector *into* a broken frame turns red, the frame itself wears a red ring and ✗, and "broken" covers every non-pass status — `failed` alone once missed `error` and `dead-end` frames entirely. On load the strip scrolls the first broken frame into view, and the video player opens pre-seeked to the failing step's offset (`data-failure-offset`, server-rendered): the recording exists because a step broke, so the first frame a reader sees is the one it was kept for.

The report shows this as a **filmstrip above the timeline, assembled in the browser from the images already in the document** — each screenshot is emitted exactly once, inside its own step, and the strip reuses those `src` strings. Rendering the strip server-side would double the size of a file that already carries every image inline; there's a test asserting the count of embedded images equals the number of frames. There is deliberately **no `screenshot` badge** any more: every step has one, so it marks the ordinary case and tells a reader nothing — the same reason `fast` is unbadged. The Diagnostics cards state how many steps carry evidence and what it weighs, because report size is the whole cost of this default and should not be a mystery.

**The MCP `run_flow` response strips screenshots** and returns `hasScreenshot: boolean` instead; megabytes of base64 in a tool result is a model-context disaster, and that matters roughly nine times more now than it did when only failures carried one. **The recording is stripped the same way**, leaving its width, height and byte count — it is the largest single thing a bundle can carry, and there is nothing a model can do with a webm.

## The catalog report (`catalog-report.ts`, `reports/`, 2026-08-31)

One HTML report per catalog RUN in the local `reports/` folder
(`reports/<runKey slug>.html` — stable per key, so a resume overwrites its own
file), generated at the suite roll-up from the LEDGER, never fatally. Every
planned case is a row — never-ran included — grouped by scenario with
passed-of-N counts and the two-family chips. A case opens into a two-pane
view: LEFT expandable steps (intent, selector, resolution, error, heal, agent
turns, screenshot) plus history explanations (`analyseTrend`/`formatTrend`
over `RunHistory.forFlow` + heal pressure) and the bundle's run notes; RIGHT
the time record — a bar per step against the 2s fast-path budget, slowest
named. Screenshots embed as data URIs: failure stills take priority, routine
stills until `SCREENSHOT_BUDGET_BYTES` (15MB) is spent. Past that budget the
artifact writer spills shots beside the report; a sink-less pure render omits
them with a note naming the proof bundle.

- **The actionable headline (2026-09-07).** Above the unchanged chip tally,
  the report shows passed, failed and no-verdict totals, plus review only when
  present, followed by pass rate over decided cases. The coverage line is
  mandatory even when no case is decided: without it, a pass rate over a small
  answered subset can look like a result for the whole catalog.

- **Self-contained while the evidence fits (2026-09-06).** When nothing
  spills, the catalog report is still one file. Past the inline budgets, the
  artifact writer puts shots in `<runKey slug>-media/shots/` and recordings
  in `<runKey slug>-media/` beside the HTML; the report says how many of each
  went there. A sink-less pure render keeps the old behaviour.

**The film is here too, and it is the evidence a passing case has.** The
runner's screenshot default is video-aware (`runner.ts`: filming ⇒
`on-failure`), because the recording covers what stills would. Measured on
be100-rip's 32 bundles, that is exactly what they hold — all 13 non-passing
cases carry stills, 18 of 19 passing ones carry none — so a report that
dropped the recording left a reader with **no evidence at all for every case
that worked**. Each case now carries its own `<video>`. Recordings use a
deliberately small 20MB inline budget (2026-09-06), because they are the
largest single value a bundle carries. Past it they spill as relative `.webm`
files in the media folder; inline screenshots and recordings also draw down
one shared 350MB ceiling, so their separate budgets cannot combine into an
unbuildable document. Three mechanics are load-bearing: **inline base64 rides on
`data-webm` and becomes a Blob URL in the page** (Chrome will not load a
`data:` video — `readyState 0` forever, no error, reads exactly like a corrupt
file); **it is decoded when the case is opened, not at load** (dozens of
recordings, and building every Blob on first paint stalls the page to make
players nobody opened); and **the attribute is never removed**, because a Blob
URL means nothing in another document and every export here is another
document; a spilled recording is a real file-backed `src` and needs no Blob
shim. Each filmed step carries a `play from here` cue **on its summary**,
not in its body — measured in a browser, in the body it is inside a collapsed
`<details>` and a reader has to expand every step to discover seeking exists;
the handler's `preventDefault` is what stops a button inside a `<summary>`
from toggling the step open as a side effect.

Whole-catalog export is client-side (`Blob` + anchor): Blob `src`s are stripped
from inline recordings so `data-webm` travels, while relative file-backed
`src`s stay. Per-case export is the case's Excel workbook — see below — not an
HTML clone.

**The report is live (`cli/catalog-live-report.ts`, 2026-09-02).** It is
written when the run STARTS — every planned case a `never ran` row, or the
verdict an earlier pass under the same run key recorded — and rewritten after
every case, so wowUI's Report button (on the catalog's name in the proof
groups, on the resumable-run banner, on the running job) opens the current
state of the catalog at any point of the run; while the run is going the page
says `in progress — N of M` and reloads itself every 60 s. `CatalogLiveReport`
reads bundles from memory for cases this process ran and from the ledger's
`proofPath` for carried ones; writes are serialised and coalesced (cases finish
concurrently and the file embeds every recording — two writers on one path is a
torn report), and never fatal. The roll-up's final `refresh(true)` drops the
in-progress marker. A rerun (same run key) updates the SAME file — the path has
always been stable per key; now the rows are too, each case replacing its own.
`wowlidator report` rebuilds through the same `buildCatalogReportCases` +
`writeCatalogArtifacts`, so the two can never disagree on shape.

**The Excel exports (`excel-export.ts`, 2026-09-02; widened 2026-09-07).**
Beside every catalog report the run writes `<runKey slug>-cases.xlsx` — one
workbook for EVERY planned case, ordered failed, review, blocked, then passed,
with catalog order stable inside each verdict. A never-ran case sits with the
no-verdict cases before passes. The sheet starts with **Scenario ID**, then
Case and **Verdict**, so a reader can sort or match it against the QA sheet;
each case band also says `failed`, `blocked
(no verdict)`, `proved-? (a human must rule)`, `recorded only`, or `passed`,
and a blocked band carries its reason. Under `<runKey slug>-media/` every case
also gets `<case id slug>.xlsx`, beside its recording when one exists, and the
report's per-case `Export (Excel)` link downloads it. A bundle-less case still
gets its band and verdict instead of disappearing.

Both shapes keep one row per step (superseded attempts excluded, same rule as
the HTML), the **Proof column** carrying the step's own log (`stepProof`:
expected vs actual, how the selector resolved, a heal, an agent summary, the
URL, the first line of an error), the screenshot embedded in the **Photo**
column, and a video row beneath every filmed step with its own `videoOffsetMs`.
`EXCEL_IMAGE_BUDGET_BYTES` gives routine stills the same 15MB allowance as the
HTML report: failing-step stills always win, and a routine still beyond the
budget becomes `omitted for size — it stays in the proof bundle`; the first
row states the omitted count. Excel cannot play an embedded webm, so every
recording is a real relative file under `<runKey slug>-media/`. A step with no
still says `see the video row below` rather than sitting blank.

**A rerun updates, never accumulates.** Names derive from the run key and case
id, so every case workbook is overwritten in place; `writeRunExcel` removes a
legacy sibling `<runKey slug>-passed.xlsx`, but never deletes a non-passing
case's workbook or recording. `preserveVideoCaseIds` protects a recording the
HTML spill sink already wrote. The container is hand-written (`node:zlib`
deflate + crc32, inline strings, no sharedStrings), the `extract.ts` decision
pointed the other way — and it is tested against `extract.ts`'s own independent
zip READER, on the same "a writer tested only against its own reader proves
nothing" rule. The report's header carries a relative `Cases (Excel)` link to
the sibling file. `wowlidator report [<ledger>|<dir>]`
(`cmdCatalogReport` in `cli/commands/maintenance.ts`) rebuilds report + Excel
from ledgers on disk without re-running anything — with one guard: a ledger
whose EVERY recorded proof bundle is gone is skipped rather than overwriting a
report that may still carry the evidence. Tests: `tests/excel-export.test.ts`. A resume
still shows evidence: carried outcomes re-read their bundle from the ledger's
`proofPath`, so the report answers for the whole catalog rather than for the
subset this process ran. Tests: `tests/catalog-report.test.ts` — pure for
everything above, plus one CDP-gated test that the recording ACTUALLY PLAYS
(against `tests/fixtures/recording.webm`), because a markup assertion would
pass on a report whose every player spins forever, which is the bug this
exists to fix.

**Scenario ID is a label, never an identity (2026-09-07).** The QA sheet's
Test Case ID and Scenario ID are independent columns: only 99 of 272 measured
rows had the same trailing number, so correspondence near the top of a sheet
cannot be extrapolated to later rows. `CatalogReportCase.scenarioId` comes
from the ledger's authored entry, with the bundle's explicit value as a
fallback; it is never guessed from the case id. HTML shows it beside every
case label, the case workbook puts it in the first column, and findings write
it after the case id. Case-id keys, anchors, media names, finding signatures,
and rerun selection remain case-id-only. Scenario IDs may repeat, so equal
labels are rendered independently and never deduplicated or merged; absence
stays an omitted suffix, an empty workbook cell, and a bare finding member id.

## Findings: the catalog report leads with N root causes (`findings.ts`, `findings-export.ts`, 2026-09-05)

A run whose 70 non-passing cases shared five root causes read as 70
independent verdicts, and 252 `never ran` rows each rendered a full section.
`buildFindingsSummary(cases)` is the deterministic projection that leads the
catalog report instead — under the tally, `N findings account for M of K
non-passing cases · U unclustered`, one `<details class="finding">` per root
cause with its title, the member case ids linked to their sections
(`#case-<slug>`), the statuses AS SEALED counted per status, where/asked/
offered, and the typed evidence lines of the first member. No model call, no
I/O, no imports from the control plane; `tests/findings.test.ts` greps the two
source files for that.

**The signature is computed only from typed fields of the first
non-superseded failing step** — `firstFailingStep`, then `signatureOf`:
`api:<METHOD> <pathname> → <status>` from the latest `request` step before a
failed `expectStatus`/`expectJson` (`step.request.{method,url,status}`,
`detail.expected/actual`); `url:<expected> → <pathname(actual)>` from a failed
`expectUrl`; `hold:<reason>/<rule>` from `ProofStep.blocked` (checked first —
a hold is not a finding about the application); `agent:<endedBy>:<trigger> @
<pathname(urlAfter ?? step.url)>` for a failed `workflow`, reading the
OPTIONAL `agent.endedBy` and `agent.actions[i].listbox` fields through a
local structural type so the module compiles and behaves with or without them
(no trigger → the coarse `agent:workflow @ <path>`); `control:<selector> @
<pathname>` for a dead-end or a selector no rung resolved;
`other:<action> <selector> @ <pathname>` for a resolved control whose claim
failed; `authoring:<first 60 chars of the reason, attempt counter removed>`
for a bundle-less case whose reason begins `authoring refused`. **Never from
`summary`, `error` or `reasoning`** — the same cause is worded in Thai on one
case and English on the next, and a key built from prose splits one cause into
as many findings as there are wordings. A case with no signature is
`unclustered`, counted, never dropped; a case whose reason begins `depends on
<X>` is listed under X's finding when X (or, through a bounded chain, X's own
prerequisite) has one, marked `↳ depends on X`, and is unclustered otherwise.
`never ran` cases are not non-passing: the report folds them into ONE
`<details class="never-ran">` with the count on its summary line and every id
as its own `span.nid` carrying the case anchor — nothing leaves the DOM, the
scenario counts still speak for them, and no full section is rendered for
them. **No status is rewritten anywhere**: a member sealed `error` reads
`error` (`<code class="sealed">`), and the projection groups, it never
relabels.

**The export** (`findings-export.ts`) writes `<base>-findings.md` and
`<base>-findings.xlsx` beside the HTML from `writeCatalogArtifacts`, so
`wowlidator report` rebuilds both from the ledgers with no re-run. The
Markdown states the severity rule at the top (`SEVERITY_RULE`: high when a
finding covers ≥3 cases or blocks a dependency chain; medium for 1–2; low when
every member is harness-only — a system error, a hold, an authoring refusal),
then one section per finding with its members, the sealed statuses, evidence,
and **steps to reproduce** drawn from the first non-dependent member's own
flow up to the failing step, through `stepTarget` / `describeTarget` /
`visibleDetail` so a credential the engine recorded never reaches the file — a
value typed into a control whose selector or intent names a password is
withheld outright (and says so) even when its key is an innocent `value`. The
workbook goes through `buildTextWorkbook` in `excel-export.ts` (the same
hand-written zip writer as the proof workbooks: a preface row, a bold header,
wrapped cells) with the columns Finding · Cases · Where · Asked/Offered ·
Evidence · Status as sealed · Suggested severity · Owner, and is read back in tests
through `catalog/extract.ts`'s independent reader. Tests:
`tests/findings.test.ts` (hand-built bundles for every kind, the prose-only
difference that still clusters, the source grep, the credential that never
appears), `tests/catalog-report.test.ts` ("findings lead the report": the exact
count line, every member linked, `error` shown as error, 252 never-ran rows as
one block), `tests/catalog-live-report.test.ts` (the `.md` exists after
`writeCatalogArtifacts` over a fixture ledger).

**The export names who owns each cause and leads with dependency roots (2026-09-06).** `ownerOf` assigns `application`, `harness`, or `catalog` from the finding kind and sealed member fields only: holds, agent failures, and all-system-error findings belong to the harness; authoring refusals belong to the catalog; reached application behaviour belongs to the application team. Markdown states that rule, shows `blockedChains` before three owner sections, and the workbook adds Owner after Suggested severity and uses the same owner order. A blocked chain follows `depends on X` transitively to the first case that is not waiting, lists nearer dependents first, and folds a cycle once under its alphabetically first member. Authoring keys still use their one permitted prose input, but normalise the authored-flow id, quoted runs, step number, problem count, and whitespace before taking 60 characters, so one lint cause remains one finding.

## The target on every step (2026-09-02)

`ProofStep.target` (see `src/engine/CLAUDE.md`, "The step's target") is shown
wherever a step is: the CLI step line (`target: …`), the per-case report
(beside the selector on the step's sub-line and as a `target` fact, with
"(outlined in red in the screenshot)" only when there IS a screenshot), the
catalog report's step detail (`target` kv row), wowUI's "How this step
resolved" panel, and the workbooks — a **Target** column between Selector and
Result plus a `target: …` line in the Proof column. One wording everywhere,
`describeTarget`: `button "Sign in" · 120×40 at (30,200)`; no target, no row,
and never a placeholder that reads like a fact. Application text in a name is
escaped like every other string.

## A rescued step shows once, as it ended (2026-09-04)

A failed attempt that an in-run reconstruction later rescued (`ProofStep.superseded`) used to sit in the per-run report's step list as a red row of its own, one line above the green rebuilt step with the same headline — the same step twice, once failed and once passed, and only the `superseded` badge said the red one was not a failure. `stepList` in `html-reporter.ts` now folds each run of superseded attempts under the next step carrying a `ReconstructionRecord` (the one that finally held), behind a closed `details.replaced` disclosure; preparation the reconstruction inserted renders as an ordinary step in between. The attempt is still a full row inside the disclosure — error, screenshot, trace, the badge — because what was tried is evidence, just not the outcome. Three companions: the first failure that puts later absence checks "in doubt" is the first LIVE failure (a superseded one is history); the page script neither auto-opens a folded attempt nor films it (`.step:not(.attempt)`, and a step's own screenshot is read with `:scope`, never an attempt's); and `agentBlock` is framed by the STEP's status — an assist-rung agent that stalled after its first action had already opened the panel reports `success: false` on a step that passed, and the callout now says the page was prepared and the step passed on the flow's own selector, in the ordinary colour with the trace closed, rather than "goal not reached" in red. An attempt with no rescue after it (a shape the runner never writes) renders in place rather than vanishing. The catalog report and the Excel export already filtered superseded rows. Tests: `tests/reporter-wave2.test.ts` ("folds a superseded attempt").

## Provider failures in the suite roll-up (2026-09-07)

`LlmFactory` counts a logical model call only after its configured failover is
exhausted, keyed by role. `runCases` prints the non-zero counts once at close as
`provider failures: generator N · healer N · agent N (each degraded one step,
never the verdict)`. It changes neither retry policy nor verdicts: the tally
only makes the previously logged degradation countable. With no recorded
failure the line is absent. Tests: `tests/api-keys.test.ts`.
