# CLAUDE.md — the execution engine

Split out of the root CLAUDE.md (2026-08-24) so this loads only when working under
`src/engine/`. Same authority as the root file; the root keeps the map of the whole system.

## The escalation ladder

`SmartRunner.#resolve` in `src/engine/runner.ts` is the core of the framework. Every action walks seven rungs, and the ordering is load-bearing:

1. **fast** — the author's selector, `DEFAULT_FAST_TIMEOUT_MS` (2s). Free.
2. **case** — the same selector with the accessible name matched case-insensitively (`relaxRoleName()`). Free, deterministic, and still the author's own selector. Only runs for a `role=…[name=…]` selector that isn't already flagged. See [Accessible-name case](#accessible-name-case-srcengineselectorts) below.
3. **narrow** — `exactTextSelector()`. Free, deterministic, and only after a *strict-mode violation* on a `text=` selector (a plain not-found means the text is absent and must stay a failure). Unquoted `text=4 days` is a substring match, so on a page also showing "Overdue 54 days" and "≤ 14 days" it resolves several elements and the step reports "could not resolve" about text that is genuinely there — found by running PB_04_01 against a real app, and unhealable for the same reason as a case mismatch: the model proposes the same text and rejects its own multi-match answer at verify. The rung retries the exact form `text="4 days"`; if even that is ambiguous, a *presence* assertion (`expectText`/`expectVisible` only, per `PRESENCE_ACTIONS`) accepts the first visible match — safe because a text-engine match contains the asserted text by construction. Actions that *do* something (click, fill) never get the any-of half: acting on an arbitrary match changes what the test exercises.
4. **dialog** — `#dismissBlockingDialog()`. Still free, still deterministic. A surprising share of "selector" failures are really "something is blocking the page" failures — a cookie banner, a promo modal, a newsletter signup, appearing after the page settles. If a dialog is open right now, dismiss it via its Close/Accept control and retry the *original* selector once before paying for anything. See [Modal and dialog detection](#modal-and-dialog-detection-srcenginemodalts) below.
5. **cache** — a prior repair keyed by `${origin+pathname} :: ${selector}`. Free. A cached selector that fails is *deleted*, not retried — a stale repair is worse than none.
6. **backend** — a *stop*, not another attempt. If a request the page made while this step was waiting has already failed hard (5xx, dropped connection, expired session), give up here rather than paying for a repair. Free, deterministic. See [Backend testing](#backend-testing-srcapi) below.
7. **jit** — `JitHealer.heal()`. Costs tokens. Captures the AX tree, asks the model, **verifies the candidate resolves to exactly one element**, then caches it.

**Patience is the last free rung** (resolution `late`): a *presence* assertion (`expectText`/`expectVisible`/`waitFor`, and `expectCount` — any count reaching the ladder claims > 0; a zero-count runs through `#bareStep`) that failed every free rung gets the author's own selector one more window at the healed timeout before any model is paid. `body` resolves instantly on a hydrating shell, so the fast window closes on the wrong page state by construction — PB-05-01's detail page renders ~3s after the route commits, and a working feature filed a defect. A `late` pass still records a `medium` timing defect ("passed, slower than the budget" is a finding, not a free pass) and wears a `resolved late` badge. Actions that *do* something get no patience: acting late is not the same as observing late.

**`expectText` is language-flexible when told to be, and reads what a user sees.** `anyOf` lists accepted equivalent renderings of the same content — a bilingual app rendering "สมชาย สุขใจ" for a requirement written "Somchai Sukjai" is the same claim about the same employee (PB-05-01's false fail). The engine never invents an equivalence: omit `anyOf` and the check is strict, which is how a case that *means* to check one language keeps its teeth; which rendering matched is recorded on the step (`matchedRendering`). Matching reads `innerText`, not `textContent` — against `body` the latter happily reads `<script>` payloads, and PB-05-01's "got …" evidence was mostly Next.js flight data no user has ever seen. It also *polls* through the window, same rule as `expectUrl` and `expectScrollable`, because an instantly-resolving selector otherwise gets zero benefit from the timeout. On a cross-script failure the error carries a one-line note ("the page renders content in a different script…") — `scriptMismatchNote()`, advisory only. The authoring prompt's LANGUAGE section is the other half: prefer language-neutral anchors (IDs, codes, numbers), and quote the accessibility tree's own rendering, never the requirement document's wording.

Three more stops, all free, all born from PB-02-01's post-mortem (`docs/tester-evidence-spec.md`):

- **Known dead end** (rung 1.05): a selector that already exhausted the whole ladder on this exact page earlier *in this run* gets one fresh fast attempt and then fails with "identical failure at step N" — never a second ladder walk or healer call. Per-run only; never persisted.
- **Denied surface** (rung 2.6): if the page's headings match `DENIAL_HEADING_PATTERN` ("Access Denied", "ไม่มีสิทธิ์เข้าถึง", 403…), healing is skipped — it could only repair onto the denial page's own furniture — and the heading becomes an `authorization`/`high` defect plus `ProofStep.pageContext`. A flow that means to test the denial page never reaches this rung: its assertions resolve on the fast path.
- **Timing re-check** (in `close()`): every dead-ended selector is re-probed once at the end of the run, on the page the run ended on. One that resolves *now* was never absent — its defect downgrades to `medium` "TIMING, not absence". The mirror of `#flagTimingHeal`, pointed at failures.

**A dead browser is fatal and environmental** (`BrowserGoneError`): `Target page/context/browser has been closed` stops the run like `SessionLostError` does, but *skips* teardown (there is no browser to run it in) and exits `EXIT.environment` — the predecessor PB-02-01 run filed fourteen "defects" against an app it could no longer reach.

The short fast-path timeout is deliberate: a selector that is going to work works immediately, so waiting longer only delays the failure we actually care about. Don't raise it to "fix" flakiness — that trades a 2s failure for a 30s one.

**Rungs 2–4 and 6 run before rung 7 for the same reason, and it is not that they are cheaper.** If a dialog really is blocking the target, JIT healing would either fail the exact same way (the AX tree shows the dialog, not the real target) or worse, "successfully" repair the selector onto some control *inside* the dialog — a heal that silently changes what the test is exercising. Dismissing the blocker first and retrying the same selector is the only rung that can't corrupt the test this way. Rung 5 is the same argument for a different cause: if the control never rendered because the data behind it never arrived, a heal can only fail identically or "successfully" repair onto the error banner the app rendered instead — and the second outcome is strictly worse than failing, because the suite goes green while checking the wrong thing. Rung 2 is the sharpest version of it: the healer reads the *same* AX tree the selector was written from, so against a case mismatch it proposes the same name and then rejects its own correct answer at the verify step, having spent a call.

**A form case whose assertions cannot fail is rejected, and the model is told why.** The live failure shape: "submit malformed email" that fills, clicks, then asserts `expectValue` of the very value it typed — which holds whether or not validation exists. `vacuousFormAssertion()` refuses any fill+submit case whose assertions are all expectValue-on-a-filled-field or expectUrl; a rejection earns **one informed re-ask** (`GenerateRequest.feedback`, the healer's `rejected` seam applied to generation), and the better attempt wins — feedback must never make the result worse. Token spend reports both attempts. The `forms` policy prompt also teaches: fill EVERY field the form needs except the one under test, address a nameless field positionally (`role=textbox >> nth=N`), and never assert your own typed value.

**Assertions are the point of a test.** `ASSERTION_ACTIONS` / `hasAssertion()` in the runner define what counts. The generator refuses to emit a case without one — a case that only clicks and navigates passes whether or not the feature works, which is worse than no test because it displaces manual checking. Rejections surface on `GeneratedSuite.rejected`, never silently.

**`expectUrl` waits; it does not peek.** `click` returns when the click lands, not when the router finishes, so a synchronous `page.url()` read raced every client-side navigation and lost — in under a millisecond, reporting the *old* URL. Found against a real app where `click` → `expectUrl` is the most ordinary pair a suite can contain. It now waits up to the fast-path budget via `waitForURL` and, on timeout, still reports "expected X, got Y" rather than a bare timeout: that comparison is the entire diagnostic value of the step.

**`AxNode.url` carries where a link points.** Chrome reports it as an AX property and wowlidator used to discard it, so a generator could only see the label — which is how a card reading "E-Patient" produced `expectUrl "e-patient"` against a route of `/benefits-hub/referral`. The URL was in the tree the whole time. Both generator prompts now say to take a path from `url=`, never from a label; it is emitted only for nodes that have one, since the tree's size is the healer's cost per repair.

**Absence assertions must not heal.** `expectHidden`, and `expectCount` with 0, run through `#bareStep` and skip the escalation ladder entirely. Healing a selector whose whole purpose is to *not* resolve would let the healer repair it onto an unrelated element and turn a correct pass into a meaningless one. Same reasoning for `expectUrl` and the storage-seeding steps: no selector, nothing to repair.

**`Flow.setup` runs before `steps`; `Flow.teardown` always runs.** A setup failure short-circuits the body, because a test whose preconditions did not hold cannot produce a meaningful result. Teardown never masks a body failure. This is what makes authentication expressible — `goto` then `setLocalStorage` then the real flow.

**`clearStorage` before the first `goto` has nothing to clear, and that is done, not an error.** Storage is origin-scoped and a page sits on `about:blank` until it navigates, where reading `localStorage` throws `SecurityError: Access is denied for this document`. A model reliably opens `setup` with it as hygiene, and setup short-circuits the body — so every case authored from one catalog failed at step 0, each filing a high-severity *frontend* defect about a page none of them had visited. `hasStorableOrigin()` decides by inspecting the URL (http/https only) before the call is made, and the skip is recorded on the step's `detail` rather than left to be inferred from a fast pass. On a real origin the call still happens and a `SecurityError` there still fails: storage refused by a page that *has* storage is a genuine finding. **`setLocalStorage` deliberately does not get this treatment** — its intent is to put a value somewhere, which an opaque origin cannot honour, so a flow that seeds auth before navigating must fail loudly rather than run on unauthenticated and fail later somewhere confusing. Clearing is the opposite: "leave no storage behind" is already true of a page that has none.

**Form interaction is four actions beyond `click`/`fill`, all deterministic, all through the ladder.** `selectOption` picks a dropdown option by its visible label — a native `<select>` via Playwright's own `selectOption` (label first, value attribute second), anything else the way a user does it: click to open, then click the option (`role=option`/`menuitem`/`menuitemradio`, searched page-wide because custom dropdowns portal their options to the end of the document; Escape on failure so a retry starts from a closed dropdown). `check`/`uncheck` verify the state actually moved — Playwright's `setChecked` for native inputs, an `aria-checked`/`aria-pressed` read-click-reread fallback for styled toggles, and a control exposing no state at all is refused rather than clicked blind. `type` presses keys one at a time (`pressSequentially`) for the fields `fill` cannot wake — autocomplete, typeahead, masked input — with the typing itself charged to the healed budget, not the rung's: resolving the field is the race the ladder times, typing N characters at a human pace is not. These existed because the old vocabulary could complete no form containing a dropdown: `fill` throws on a `<select>` and `click` can only open one.

`use` and `when` are the two actions that never reach `#resolve` *or* `#bareStep` in the usual way — `use` is gone before the run starts, and `when` records itself while its condition deliberately bypasses healing. When adding an ordinary action (e.g. `hover`), it must go through `#step` → `#resolve`, or it silently loses healing. **Five** places to touch: the method on `SmartRunner`, the `FlowStep` union, the `switch` in `executeStep` (the dispatch moved out of `executeFlow`; there is a second, browser-free switch in `executeApiSteps`), `flowStepSchema` in `src/mcp/server.ts`, and the `GENERATOR_ACTIONS` list plus `toFlowStep` in `src/generator/test-generator.ts` (otherwise the generator can never produce it). An HTTP action has a sixth place: `API_GENERATOR_ACTIONS`/`toApiFlowStep` in `src/generator/api-test-generator.ts`. An *assertion* has a seventh: `ASSERTION_ACTIONS` in the runner, or `hasAssertion()` silently rejects every generated case that relies on it. And an action the *catalog* path should be able to author has an eighth: `AUTHOR_ACTIONS` plus `flow-author.ts`'s own `toFlowStep` — catalogs author through `flow-author.ts`, not `test-generator.ts`.

`workflow` is the deliberate exception: it bypasses `#resolve` entirely because it has no selector to escalate. It calls the agent directly and records an `AgentRecord` on the step.

## Composition and control flow (`src/engine/compose.ts`)

Two step types, both execution-plane, no model anywhere near them. They exist because a real journey has preludes and forks that a flat step list cannot express: "act as the HRBP" is three clicks that are identical in every HRBP test and are not what any of those tests is about.

- **`use`** splices another `.flow.json` in where it appears. A fragment is an ordinary flow — runnable and debuggable on its own — and `with` substitutes `{{name}}` inside it.
- **`when`** picks a branch on `visible` / `hidden` / `enabled` / `disabled`. Exactly one condition per step.

**Expansion happens before the run, not during it.** `runFlow` calls `expandFlow()` once, up front, and everything downstream sees an ordinary flow. That is what keeps the proof bundle a record of what *actually ran* (a report shows the two clicks, not "used a fragment") and what keeps `--repair`'s `locateFailedStep()` — which maps bundle entries onto `setup`/`steps` positionally — working untouched. `RunFlowOptions.flowDir` is how a fragment path stays relative to the flow that used it rather than to the process's cwd.

**A `when` condition is a probe, not an assertion, and it must never heal.** Healing answers "which element did the author really mean?", which presumes the selector ought to resolve. Here *not resolving is a legitimate answer* — usually the answer being asked for ("is the switcher already showing HRBP?"). A repair would turn "no" into "yes, some other element" and silently take the wrong branch. Same reasoning that keeps `expectHidden` off the ladder. A condition never fails the flow either: unresolvable means false, and `else` (or nothing) runs. The branch taken is recorded on the step via `noteBranch()`, because a report that says "already HRBP, so the switch was skipped" explains an otherwise puzzling gap in the step list.

**Fragment parameters are substituted at expansion; every other `{{...}}` is left alone.** Those belong to the runtime variable store (`src/api/variables.ts`), which is how a value saved from a `request` reaches a later UI step — `interpolateStep()` in the runner applies it at the one point every step passes through. Substituting everything at expansion would break that; leaving everything to runtime would mean a fragment's real selectors never appear in the flow you can read on disk.

**A fragment with a `teardown` is refused, loudly.** Dropping it would leave the fragment's author believing their cleanup runs; running it inline would run cleanup in the middle of the caller's body. Cycles and depth over `DEFAULT_MAX_INCLUDE_DEPTH` are errors for the same reason: silence here produces a test that quietly does less than it says.

**Guard a `hidden` condition behind a `waitFor` on the container.** Found by running it against a hydrating React page: the condition evaluated 17ms after `goto`, when nothing had rendered, so "is the HRBP label hidden?" answered *yes* and the flow re-ran a role switch it should have skipped — clicking a persona button that is `disabled` for the active persona, which then hangs for the full timeout. "Not attached yet" and "not there" are the same thing to a point-in-time probe, and only the flow author knows which one they meant.

## Scrolling and history

`back`/`forward` turn a list page into a journey — open a card, check it, come back — without re-navigating and losing the state the journey was testing. Two traps, both found live: **`goBack` must use `waitUntil: 'commit'`**, because a back navigation restored from the bfcache fires no load event and the default wait times out on exactly the pages where going back worked; and **it must let an in-flight navigation settle first** (`#settleNavigation`), or a `back` immediately after a click steps past the entry the click was about to create, landing on whatever preceded the test — usually `about:blank`.

`expectScrollable` asks whether a user can reach the content, which is not the same as whether content exists below the fold. Two halves, both required: the content overflows **and** the scroll position moves. **`element.scrollTop = n` works on `overflow: hidden`**, so movement alone proves nothing — script can scroll what a user cannot — which is why the computed `overflow-y` decides. It polls through hydration for the same reason `expectUrl` does: a shell that has not rendered is exactly one viewport tall, and a single reading called a 2806px page unscrollable. The scroll position is restored afterwards, because an assertion that moves the page changes what the next step tests.

## Modal and dialog detection (`src/engine/modal.ts`)

Deterministic, no model call — this is execution-plane code, called on every failed fast-path attempt, so it has to be cheap and it has to be honest about what it can't see.

**Detection is ARIA-based only:** `role="dialog"`, `role="alertdialog"`, or a native `<dialog open>`. A fixed-position `<div>` with no dialog role is not detected — the same "understate, never overstate" choice `ax-coverage.ts` makes for CSS selectors, applied to a much richer signal. Every mainstream component library (Radix, MUI, Headless UI, Bootstrap 5) marks this correctly; a hand-rolled non-ARIA popup is a disclosed gap, not something silently guessed at.

**The overlay rung covers what ARIA detection cannot — using Playwright's own evidence.** Detection stays ARIA-only for anything wowlidator goes *looking* for. But when a click fails because a non-ARIA overlay swallowed the pointer (a Semantic-UI dimmer, a hand-rolled promo — homepro.co.th's, live), Playwright's actionability log **names the exact blocker** ("<div class=…> intercepts pointer events"), and acting on a named element overstates nothing. `parseInterception()` reads the blocker off the interception line (the *last* element on it — the log's first is just whichever leaf sat under the pointer), the rung tries a name-gated dismiss control inside it (`findDismissButton`, so a promo's anonymous link is never clicked and can never navigate), falls back to Escape, and retries the author's own selector once. Resolution `dialog`, same record, same usability defect.

**A click that opens a new tab is a navigation, and the runner follows it.** `target="_blank"` (or a `window.open` in the handler) navigates a page the runner would otherwise never watch: the click lands, nothing changes, and every later step asserts against the page the user left — homepro's "ติดต่อเรา" contact link, live. `SmartRunner.click` now adopts the popup: a declared `_blank` waits for it properly, everything else gets a `POPUP_GRACE_MS` window; the adopted page becomes `this.page`, the step records `detail.openedNewTab`, and the original page is left open (closing it mid-run could take a recording with it).

**Named `dialog`/`DialogRecord`, never `interstitial`.** "Interstitial" already means something specific and different in this codebase — an unknown intermediate *page* the workflow agent navigates through (`orchestrator/workflow-agent.ts`, the `workflow` action). This feature is about a blocking *dialog on the current page*. Reusing the word would have collided two genuinely different concepts; don't reintroduce it here.

**`findDismissButton()` picks the first plausible match, not the "correct" one.** When a dialog offers more than one plausible affordance (a cookie banner with both "Accept" and "Reject"), it returns whichever it finds first in document order. That ambiguity is exactly why `closeModal` accepts an explicit `button` selector — automatic matching is a recovery mechanism for the *unrequested* case, not a substitute for asserting what a test actually means to click.

**Two ways this shows up, sharing the same detection code:**
- **Automatic recovery** — rung 3 of the escalation ladder (see above). Uses `openDialogNow()` (no wait — the fast path already spent its timeout failing) and records a `DialogRecord` plus a `usability`/`medium` runtime defect, one notch above an ordinary JIT heal's `low`: an unexpected dialog is a real friction point for human users too, not just automation.
- **Explicit `expectModal`/`closeModal` actions** — for a test that intentionally opens and interacts with a modal. Uses `waitForDialog()` (waits up to `#healedTimeoutMs`, since the dialog may not exist yet when the step starts). Both go through `#bareStep`, not `#resolve` — there's no author-supplied selector on the *dialog itself* to heal, same reasoning as `setLocalStorage`/`clearStorage`. Not wired into the autonomous generator's `ACTIONS` list, same precedent as `fillEach`: the AX tree is a snapshot and can't see a modal that only appears after an interaction, so this is authored by hand or via MCP.

**`waitForDialog()` polls rather than using `locator.first().waitFor()`.** A page can have more than one dialog-role container in the DOM at once — several possible modals, only one shown at a time — and `.first()` resolves to whichever matches first in *DOM order*, not whichever one actually becomes visible. Found by writing a test with two dialogs on one fixture page; don't "simplify" this back to `.first().waitFor()`.

## The agent rung (`SmartRunner.#agentRescue`)

The healer and the agent fix **opposite** problems, and until now only one of them was on the ladder:

| | the healer | the agent |
|---|---|---|
| fixes | a *wrong selector* on the right page | a *right selector* on the wrong page state |
| how | reads one static AX tree, proposes a different string | drives the browser: opens, scrolls, waits |
| helpless when | the control is not in the tree at all | the control is there under another name |

A control behind a closed menu, below the fold, or on a view still hydrating is simply **not in the tree**, so the healer has nothing to propose — it can only echo. That is not a repair problem; it is a reachability problem, and only something that can *act* can solve it. `--agent-assist` adds that as the last rung, below `jit`.

Four rules make it safe enough to exist:

- **The agent prepares the page; it never performs the step.** Its goal is explicitly "make this control reachable, then stop — the test will click it itself". Afterwards the **author's original selector** (and its free variants) is retried exactly as written, and if it still does not resolve the step still fails. Same guarantee the dialog rung gives, and the reason this is not a machine for making tests pass. Demonstrated live: the agent's second turn errored outright, but its first action had already opened the panel, and the step passed anyway — because what the agent *claims* is never the evidence.
- **An assertion is never offered it.** A claim that holds only because an agent went and made it true is worse than a failed claim: the suite goes green while the feature is broken. `ASSERTION_ACTIONS` decides — the same list that stops the generator emitting a case with nothing to prove.
- **Opt-in.** Unlike every rung above it, this one *changes the application* before the step runs — it clicks, types, navigates. That is a decision about someone's system, not a default. Same reasoning as `--follow-buttons` and `--probe`.
- **It is recorded as a defect, not just a resolution.** A `usability`/`medium` finding says the control exists but the flow does not say how to reach it, so the fix is to add the revealing step rather than to keep paying a model every run.

**The healer gets a second look at the page the agent opened.** This is the other half of the integration and the reason the two belong on one ladder: the healer's blind spot is a tree that did not contain the answer, and the agent has just changed the page. So if the author's selector still fails after the agent acts, one more repair is attempted against the *new* state. A step can therefore end up carrying both an `AgentRecord` and a `HealRecord` — the agent opened the menu, the healer named what was inside — and that combination is reported at `medium`, because two model calls for one step is worth fixing in the flow.

**The loop refuses a wasted turn before spending it** (`src/orchestrator/agent-guards.ts`). Three rules the prompt already stated became guarantees, each with ONE informed re-ask (the healer's `rejected` seam) before the cheaper honest outcome: a selector whose accessible name is in **no node of the tree** (`selectorGrounded` — the tree is the evidence; a name not in it cost 8 s to disprove), an **ok action repeated on an unchanged page** (`decisionKey` over a per-URL "done here" set — PB_03_01's four password fills; twice refused is a *stall*, recorded and returned, not eight turns), and a **`finish` that the goal's own destination contradicts** — the one hole the post-hoc evidence check could not close, because it ran only on failures and a false finish sailed through as success; twice refused it is recorded as "claimed finish, but …" and `success=false`. Two more accuracy moves: `#target` fails a miss in **1.5 s with "no element matches"** (and notes "N matched, acted on the first" in the history) instead of 8 s of "not found"; and the tree the agent reads is **goal-focused** (`focusTree` — nodes sharing a word with the goal survive the node budget ahead of unrelated interactive ones, document order restored), so the control the goal names is never the one past the cut. The budget line ("Actions remaining: N") left the prompt — it was the one input that changed every turn with nothing on the page changing, and the documented cause of a premature `fail`. The origin guard no longer means "anywhere" on `about:blank` (it used to short-circuit on an empty list); it is the start origin plus any origin the goal names, and nothing else. Measured live on the exact PB_03_01 goal after the change: eight distinct actions, zero repeats, arrives and stops. A provider that refuses the call (Groq's 200k tokens/day cap, hit live) is now worded "could not be asked — the provider refused" rather than "failed to produce a valid structured response", because the fix for the two is different.

**Three zero-call rungs and plan-ahead cut the agent's turns** (measured before: 3.8 model turns per `workflow` step, ~3,350 input tokens a turn — the largest token sink in a run and the first role to trip a per-minute quota). In cost order, before any model turn: (1) **replay memory** — a goal solved on this origin+path is remembered in the healed-selector cache (`cacheAgentMemory`, `strategy: 'workflow-replay'`, key `replayKey(startUrl, goal)`; the runner passes it per call) and replayed deterministically, each selector re-grounded in the live tree, so the twelve cases that share "navigate to the plans page" pay the model once; a replay that fails is forgotten and the model asked, with the history saying so. (2) **Pre-flight** — a consent gate in front of the page is accepted and the page returned to (`consentGateShowing`/`acceptConsentGate`); a tree **link whose `url` is the goal's destination** is clicked as the route the goal describes; and a goal that names WHERE but no route word (`ROUTE_WORDS`: via, menu, sidebar, click, tile…) is met by a direct `goto`, the summary saying "by direct navigation" so a leg meant to exercise a menu is never silently passed by a URL. (3) **Plan-ahead** — `DecisionSchema.next` carries up to `AGENT_PLAN_AHEAD` (2) follow-ups the model is certain of (fill email → click Next); each is executed only while it still grounds in the tree *after* the previous action and is not already done, the first that does not hands control back, and follow-ups cost no turn. Every success path writes memory (`#remember`); `tests/agent-economy.test.ts` proves all three against a real page. A test whose fixture links straight to its destination is now solved without the model — which is the point, and why `agent-guards`' contradicted-finish test aims at an unlinked page.

**The agent's vocabulary grew to match** (`AGENT_ACTIONS`): first `press`, `scroll` and `wait` alongside `click`/`fill`/`goto` — what a *stuck* page needs, a listbox that only opens on Enter, a control below the fold, a view that has not hydrated — and then (2026-09-02) `check`/`uncheck`/`selectOption`/`type`, the same form verbs the engine ladder has, so a `workflow` leg drives a real form the way a human tester does rather than click-and-guess. None of them can change data beyond what a form submit does, which is what keeps the safety argument intact: the agent cannot express a purchase or a delete except through a `click` the goal explicitly asked for. See `src/orchestrator/CLAUDE.md` for the reveal-pass carve-out (`check`/`selectOption` may reveal a target; `fill`/`type` never write into an asserted field).

## Losing the session (`SessionLostError`)

**A run that has been bounced to a sign-in page cannot answer the question it was asked, so it stops.** This is the only fatal error in the engine, and it exists because the alternative is actively misleading rather than merely useless: every later step is asserted against the login screen, so some fail for the wrong reason — and the healer *rescues* others by repairing them onto whatever the login page offers, verifying that the new selector resolves, and reporting them green. Seen exactly that way in PB_01_01: `waitFor role=heading[name="Sign in"] … passed (jit)`. A pile of defects about an application that was working perfectly.

`assertSessionHeld()` runs before every step **except a `signIn`** (HIR-EC-009, below: a sign-in page is exactly where a `signIn` expects to be). Three conditions, all required, so a flow that *means* to be on a sign-in page is never stopped: the page is on a sign-in URL now; no `goto` in this run asked for one; and the last `goto` asked for a different page, so being here was not the plan. A `click` is exempt — following a "Sign out" control is a legitimate way to arrive.

**`#strandedMessage()` is split out from the assertion so the ladder can consult it without stopping the run.** A step whose page was redirected *while it ran* could not have been caught beforehand, and there the rule is narrower: it is an ordinary failed step, but it **must not heal** — same shape as the backend rung, where a repair can only fail identically or succeed against the wrong thing, and the second is strictly worse.

Teardown still runs (`executeFlow` catches the fatal, runs cleanup, then rethrows): "teardown always runs" holds, and a flow that signed in and created something still has to put it back.

The other half of the fix is at authoring time: the author prompt now says to sign in explicitly and completely — **fill every field the form has**, because a password field usually has no accessible name of its own and a form missing one field never submits — and that a token seeded with `setLocalStorage` needs a `goto` after it, since an application reads its session once, at load.

**A prompt instruction is a request; `strandedCredentialFill()` is the guarantee — and the guarantee repairs before it refuses.** The prompt has always said to go back to the sign-in page before switching user, and PB-02-01 is what it looks like when a model ignores that: three credential blocks filled against a probation page. The lint walks `[...setup, ...steps]` in execution order; a credential-shaped fill (`password` in selector/intent, or the taught `role=textbox >> nth=N` idiom) whose most recent preceding `goto` does not look like a login surface is a violation. A flow with no `goto` before the fill is allowed: the page the author was given may *be* the login screen.

Handling runs in cost order, like the ladder — the first cut of this feature refused outright, which turned every stranded persona switch into a blocked case the system knew the exact fix for:

1. **$0 mechanical repair** (`groundCredentialFills`): when the flow itself names a sign-in URL (its first login's `goto`), splice that `goto` back in front of each stranded credential *block* (walking back over the contiguous fill run — the block starts at the email field, not the password field the detector flags). Applied to the body and to each case's step list, disclosed on `notes` and `onLog`, never silent. Same move `qualifyBareRole` makes for selectors. With no sign-in URL to learn from, nothing is invented.
2. **One informed re-ask** (`AUTHOR_ATTEMPTS` = 2): any `AuthoringError` from validation (no assertion, still-stranded credentials) goes back to the model as `AuthorRequest.feedback` — the healer's `rejected` seam applied to authoring, and for the same reason: the value of a retry is entirely in the ask that knows what was refused.
3. **The loud refusal stays** as the floor, naming the step and the fix; `runCases` already scores it blocked, not failed.

The prompt also now asks the flow to assert *who* is signed in after submitting, and says persona-specific claims belong in **separate cases** (setup re-runs per case, so each persona signs in from a clean start).

**`ungroundedUrlExpectation()` / `inventedUrlReason()` refuse a URL derived from a label.** The recurring shape (documented once for `AxNode.url`, back live anyway): a card labelled "Time & Attendance" routes to `/en/overtime`, the model asserts `expectUrl "time-attendance"`, and a correctly-navigating app gets a high defect. An expected fragment must appear in the tree's `url=` attributes or in one of the flow's own `goto`s; the authoring variant exempts expectations *after* a `workflow` step (the agent's journey ends on pages the authoring tree never saw, and the agent verifies its goal live). Both feed the ordinary feedback re-ask; the runtime `expectUrl` failure also names the hazard ("if the page shown IS the correct destination, the expectation was derived from a label"). Truncated-tree honesty as always.

**`ungroundedCountRole()` refuses a count of a role the page never exposes.** The habit it catches: the model reads a `radiogroup` in the tree and *infers* `role=radio` children — PB-02-01's app renders the outcome "cards" as `<button aria-pressed>` toggles, so `expectCount role=radio, 4` (and its CSS spelling `[role="radio"]`) resolves zero elements on every run, forever. Tree lines start with the node's role token, so "does this role exist" is a deterministic string check; a refusal feeds the ordinary feedback re-ask. It declines to judge a truncated tree — past the node budget, absence of evidence is not evidence of absence, the same rule the truncation notice itself states.

## The session bootstrap (`src/engine/sign-in.ts`, `SmartRunner.#bootstrapSession`)

A test-case-table catalog's rows are frequently pure UI scripts of one screen — a 'Test Script / Steps' column that starts mid-application, no persona column, unit scope (said out loud at authoring now: "rows author as UNIT tests… pass --scope e2e to demand full journeys"). Authored against a browser that HAS a session, such a flow honestly assumes one; run against a **fresh headless Chrome** it lands on the sign-in page and the session guard kills every case (BE_Test2.csv, 2026-08-19 16:53 — ten for ten, all dead on the login screen).

The recovery: when a `goto` asked for an ordinary page and landed on a sign-in URL, the run holds `--as` credentials, the flow contains **no sign-in of its own** (`signsInItself` — the same predicate that decides session inheritance; the bootstrap must never race a flow's own login or a persona test stops testing its persona), and it has not been tried this run — the runner performs the deterministic sign-in and re-navigates to the page the flow asked for. Establishing a documented precondition is preparation, not the claim: the same contract as the agent rung, done with the person's own account, no model anywhere. It is recorded three ways — `sessionEstablished: <email>` on the goto's detail, a run note, and a `usability`/`low` finding saying to author the sign-in into setup — and a consent gate met on arrival is accepted as part of it. When it cannot act, nothing changes: no credentials leaves the honest fatal, which now names the fix ("pass --as <email>:<password> and the run will establish the session itself"); a sign-in that does not take is a note, never a fake session.

**A persona switch is a browser switch; the flow is end-to-end either way (2026-09-03).** `SmartRunner` holds one `PersonaSession` per person it has signed in as — browser, context, page, recording, caption, network observer, the session guard's memory — and `page`/`#context` are getters over the active one, so the fifty-odd step implementations follow a switch without knowing. `signIn` decides in order: a persona who already has a session is switched to (no sign-out, no login — `keptSession`; only a session the app has since expired logs in again, on that same browser); the first `signIn` of the run binds to the primary (`signsInItself` already starts it with an empty jar); a new persona with a spare Chrome in `personaBrowsers` gets a context of its own there, seeded from the suite's vault under that account (`sessionStates`) and never from the pool member's leftover default context; and with no spare browser the single-browser path stays byte for byte — `performSignOut` on the active page, then the login. Per-page things are re-armed per session (`keepCaption`, the network observer, the cursor overlay, a pinned `setClock`), the API transport is rebuilt on a switch so a `request` runs as the person active, `#deadResolutions` keys carry the persona so an employee's 403 does not short-circuit the manager on the same URL, and `close()` seals every session's film (the primary's cut at the break, a persona's whole) and closes every context it owns — which also ends the leak where an isolated, unfilmed context was only disconnected from. A persona's Chrome that answers nothing is `PersonaBrowserUnavailableError`: harness-class, the case blocked, no app defect, no reconstruction. The proof carries `persona` and `browser` on every step (`ProofBundleBuilder.setActor`), one `videos[]` entry per persona beside the primary `video`, and the vault banks each session under its own email (`exportSessions`). Authoring emits one `signIn` per hand-off and no `signOut` before it (`flow-author.ts`'s sign-in rules); `switchesPersona` still marks such a flow `e2e`.

**One procedure, three callers.** `performSignIn` / `acceptConsentGate` moved to the engine and the journey capture and navigation-map learner delegate to them — a sign-in that works for a capture works for a run by construction. The procedure is everything the live application taught: a hydration settle, the two-step form (identity + Next before any password field exists), a wait on the URL actually leaving the sign-in page, one hydration replay, and a name-gated consent accept. `tests/session-bootstrap.test.ts` proves it at the browser tier against a real two-step fixture, including the never-races-the-flow half.

## The suite session vault (`src/engine/session-vault.ts`)

A catalog's cases each run in their own isolated context — required, concurrent cases must not share cookies — but that meant the session a case established died with its context and every case paid for sign-in again. The vault is the recording context's own move (`storageState()` — the session as data) pointed at the suite: after a run that ENDS signed in on the flow's origin (observation-gated: on-origin, off the sign-in page, cookies in the jar), `runFlow` banks the context's state; a later case whose flow does NOT sign in itself starts its isolated context WITH that state and its first `goto` lands authenticated. Contexts are never shared, only serialized state; the suite's vault outranks the attached browser's state when both exist. A flow that signs in itself still declines inheritance — the same `signsInItself` reasoning as always: it wants to BE the account it types. Origin-scoped, in-memory, per-suite (a session on disk would outlive its server-side expiry). The reuse is on the bundle's notes ("reused the session a sibling case of this suite established"); wired in `run-cases.ts`, one vault per suite. `tests/session-vault.test.ts` proves the carry against a real cookie-gated fixture.

## Consent-gate recovery (`SmartRunner.#settleConsentGate`, spec in `docs/consent-gate-recovery-spec.md`)

A client-side consent gate (localStorage-keyed, so every parallel isolated context hits it) has three measured shapes on the live application: it bounces the sign-in to `/en/consent`, it renders **in place on the URL a goto asked for** (URL unchanged, consent heading showing — URL-based detection is blind to it), and it bounces to `/en/consent` a beat **after** `domcontentloaded`. Accepting it dumps the run on the app's home landing, abandoning the deep link. Recovery was a coin flip left to models — the one BE_Test2 flow whose agent returned to the asked-for page passed, the three that wandered off by menu label went red — and is now deterministic, four layers, no model call:

- **F1** — after every `goto`, `#settleConsentGate` detects the gate **by content** (`consentGateShowing`: the name-gated accept control `CONSENT_ACCEPT_NAME` *and* a consent heading `CONSENT_HEADING_PATTERN`, both required — a page that merely carries an "Accept" button is never treated as this gate), accepts, and **re-issues the same goto once**. The late-bounce shape pays a 2s window only when the page was on a consent URL before the goto or is on one now — ordinary navigations are never taxed. Never when the goto asked for the gate's own page; recorded as `consentAccepted` on the step, a run note, and a `usability`/`low` finding. Once per goto — a gate that re-renders is an application finding.
- **F2** — in the agent loop: when the goal names no destination and the agent has made **no forward progress yet** (nothing acted but gate-clears, waits, scrolls), an accept-shaped click (`CONSENT_ACCEPT_NAME` on the selector's name) that navigated away from the step's starting URL is followed by a **deterministic return to that URL** — no model turn spent, once per distinct accept, history line says so. The progress guard is load-bearing: an accept fired first thing is an obstacle in front of the step's own page; one fired after real work is a gate met along a journey, and returning would destroy the journey (the two-interstitials test caught exactly that).
- **F3** — `settleConsentEarly()` in `flow-author.ts`: a consent-accept step the model placed after the first post-login navigation/assertion is spliced to immediately after the login block (bare `click` converted to the `when { visible }` form — the gate shows once per context), so the flow's own goto becomes the re-navigation. Mechanical, disclosed on `notes`, never a re-ask.
- **F4** — a workflow failure whose `urlAfter` differs from `urlBefore` names the displacement in the error and the defect ("the agent ended on X, not the page this step began on"), so "the control is missing" is never filed against a page that has it.

`tests/consent-gate.test.ts` carries all of it, browser tier included, against a fixture gate with all three shapes.

## Bare-role selectors (`src/engine/selector.ts`)

**`textbox >> nth=1` is a valid selector that can never match anything.** Playwright reads a leading token with no engine prefix as a *CSS tag name*, and there is no `<textbox>` element — so the selector resolves 0 on every page, at any timeout. Same for `heading[name="Employees"]` and `button[name="Extend until"]`: a `<button>` with a `name` attribute of "Extend until" does not exist either. The step then reports "could not resolve", which reads as *the control is missing* and files a front-end defect about an application that is fine.

This is the most damaging thing a model gets wrong when writing a selector, because it fails silently and it fails **completely** — and it clusters on exactly the controls that have no accessible name, since that is when the model falls back to a positional selector and drops the prefix. Found by investigating PB_02_01: the login page's password field is reported by Chrome as `role=textbox` with an **empty name** (the app's `<label>` is not associated), so the authored step was `textbox >> nth=1`. It matched nothing, the form never submitted, and all 26 steps ran against the sign-in page — six "defects", none real.

`qualifyBareRole()` adds the missing `role=`, and it is applied at every point a selector is written from a tree (`toFlowStep`, `flow-author`, the agent's decision, the healer's candidate — composed *before* `relaxRoleName`, since relaxing only recognises `[name=…]` on a role selector) plus **rung 1.15 of the ladder**, which is what rescues flows already written to disk.

Three guards keep the rewrite from doing harm, and each has a test:

- **A real CSS selector is never touched.** Anything structurally CSS — `.card`, `#id`, `a > span`, `input:checked`, `[data-testid]`, a descendant combinator — is left alone, and so is any leading token that is not an ARIA role. Turning a selector that resolves correctly into a role selector that matches something *else* is the one outcome worse than the bug.
- **An attribute the role engine does not accept declines the rewrite.** `role=textbox[placeholder="Password"]` throws `Unknown attribute "placeholder"`; qualifying there would swap a silent miss for a thrown step, and a miss is at least repairable by the healer. (Seen live in PB_01_01.)
- **It returns `null`, not the input, when there is nothing to do** — the same contract as `relaxRoleName`, so the ladder skips a second attempt instead of paying the fast-path timeout twice for an identical selector.

## Accessible-name case (`src/engine/selector.ts`)

wowlidator reads accessible names through Chrome (`captureAxNodes` →
`Accessibility.getFullAXTree`) and resolves selectors through Playwright's
`role=` engine. Those are two independent accessible-name implementations and
they disagree: **Chrome applies CSS `text-transform` when it computes a name,
Playwright does not.** A control styled `text-transform: uppercase` is captured
as `"DUE SOON 1 15–29 days"` and matched against `"Due soon 1 15–29 days"`.

This is not drift and not flake — `locator.count()` is 0 at any timeout, and
every selector written for such a control was unresolvable *by construction*.
Found by generating against a real app: 2 of 5 generated cases failed on the
same filter tabs, and the healer could not rescue either one.

The rule: **never assert a case we did not observe.** `relaxRoleName()` turns
`[name="X"]` into `[name="X" i]`, and it is applied at every point a selector
is written from a tree name — `toFlowStep` in `test-generator.ts` (shared with
`src/repair/`), `flow-author.ts`, the agent's decision in `workflow-agent.ts`,
and the healer's candidate *before* `#verify` (otherwise the healer spends a
call and then rejects its own correct answer). Rung 2 of the ladder covers what
those cannot: hand-written and pre-existing flows.

Three details worth keeping:

- **Case-insensitivity is a loosening, and the guards that make it safe are the
  existing ones.** The healer still verifies a candidate resolves to exactly one
  element, and a step matching two controls that differ only in case fails on
  Playwright's strict-mode violation rather than silently picking one.
- **`relaxRoleName` returns `null`, not the input, when there is nothing to
  relax** — a CSS/text/testid selector, a role selector with no name, or one
  already flagged. That is what lets rung 2 skip a second attempt instead of
  paying the fast-path timeout twice for the identical selector.
- **Coverage attribution folds case too** (`attributionKey()` in
  `ax-coverage.ts`). The inventory's names come from Chrome, a hand-authored
  selector carries the untransformed text; comparing them exactly would miss
  the attribution *and* add the same control again as a phantom "transient" —
  understating the numerator while inflating the denominator. `parseRoleSelector`
  also has to accept the trailing ` i`, or every generated step lands in
  `unattributed`.

## In-run step reconstruction (`executeSteps` in `src/engine/runner.ts`)

**A failed workflow leg closes its dependent tail (2026-09-05).** When a `workflow` step records a non-pass, `dependentTail` marks every following step through the next place-establishing action (or the next browser-free `request`/DB step, which reads nothing off the page) as `skipped`: those assertions and interactions are consequences of a page the leg never reached, not fresh defects to time out independently. Skipped steps stay in the proof with the leg's goal and still pass through the data gate's `after`, so a skipped window end releases its locks; they count as neither passed nor failed. `WOWLIDATOR_SKIP_AFTER_FAILED_LEG=off` restores run-to-the-end.

Between the ladder (one selector, mid-step) and `--repair` (whole flow, between runs) sits the level a failed *step* actually wants: on failure, the repair model rebuilds the step against the **live page** — no re-run, session intact — and the step retries, until its failures reach `STEP_RECONSTRUCT_TRIES` (3, total, including the original). Only then does the ordinary classification (failed / error / dead end) land. On by default; `--no-reconstruct` disables; no generator key degrades silently to pre-reconstruction behaviour.

Four rails hold it honest:

- **A rescued run passes, and the attempts stay visible.** Failed tries a later reconstruction rescued are marked `ProofStep.superseded`: still listed (what was tried is evidence), counted toward nothing — not the tallies, not the run status, not the trend's failure signatures — and their defects are withdrawn (`supersedeSteps`). Without this, "retry until it works" would be indistinguishable from "failed" and nobody would leave it on.
- **An assertion keeps its claim verbatim.** A reconstruction may only insert preparation *before* it; the replacement is discarded for `ASSERTION_ACTIONS`. A claim rewritten until it passes proves nothing — the same argument that keeps the agent rung off assertions.
- **Every rescue is a finding.** The passing step carries a `ReconstructionRecord` (as written / as rebuilt / inserted / reasoning) and files a `medium` drift defect: the run is green, the flow no longer matches the app.
- **Futile stops stay stopped.** A failure the ladder already attributed elsewhere (`backend:`, `authorization:`, `declined to heal:`, `known dead end:`) is never reconstructed — the same "a rewrite can only fail identically or succeed against the wrong thing" argument, verbatim.

Bad interpolation is also never reconstructed: an unknown `{{var}}` is the flow's problem, and nothing a rebuilt step does can save a variable the run never saved.

## A content mismatch is a verdict, never a dead end (2026-08-28)

A `StepResolutionError` whose attempts all read the element and missed only on
its text (`contentOnly`) classifies the step `failed`, not `dead-end` — the
control was never absent, the page answered, and `failed` is what keeps the
run eligible for the near-miss gate (proved-? → the review judge). The
dead-end memo cooperates: an exhausted ladder is remembered with a
`contentMiss` flag, and a retry of a content miss appends
`known content mismatch: …` (which preserves `contentOnly`) instead of
`known dead end: …` (which does not). Reconstruction stays available — the
claim survives verbatim and inserted preparation can make it true (a missing
click before an expectText) — but `FlowRepairLoop` stops on a `needs-review`
bundle unless the judge ruled it failed (ruled proved → passed; unruled →
left for a human, since re-running only reproduces the same pair of
strings). Live driver (be100 PL_02_07): a
breadcrumb claim written "Benefit Plans" against a page rendering "Benefit
Plan Catalog" was retried, memoed, stamped dead-end, and never reached the
judge that exists precisely for that wording call.

`expectText`'s recorded `actual` is first-reading-wins: the authored
selector's own text is the honest actual, and later rungs (the kin climb, a
heal onto a container) must not replace it — last-write-wins once put a whole
page of innerText in the report's Actual column. The thrown message's `got`
is capped at 200 chars for the same reason; the full first reading (400) stays
on `detail.actual`.

## Keyboard and focus

`press`, `expectFocused`, `expectTabOrder`. Focus order is the one accessibility property that cannot be read from a static tree — it only exists while tabbing.

**Two traps in `expectTabOrder`, both found by running it:**
- `body.focus()` alone is a no-op; body is not focusable without a `tabindex`.
- `activeElement.blur()` clears `activeElement` but leaves Chrome's *sequential focus navigation starting point* on the old element, so the next Tab resumes from there.

Temporarily setting `tabindex="-1"` on body and focusing it resets both. Don't "simplify" that back to a blur.

## Where determinism ends, it ends in two calls

The standing rule (2026-08-26). A step whose deterministic ladder has failed gets **ONE look** and, only if that look earns it, **ONE repair**. `#agentTriage` owns both and can spend no more; `#agentRescue` is gone, its contract absorbed.

1. **The look** — `readOnly`, so it structurally cannot click, type or navigate. It answers with one of three verdicts in the decision's `value` (a field the schema already has, so no prompt pays for a new one): `proved` + the selector of the element that shows it; `can-heal` + what stands in the way; `fail`. Anything unrecognised reads as `fail` — the safe direction is to spend nothing.
2. **The repair** — only on `can-heal`, and only under `--agent-assist`, because this stage changes the application and that has always been a decision about someone's system rather than a default. The look is ungated precisely because it cannot act. For an **assertion** the repair is further restricted to `REVEAL_ACTIONS` (open, focus, follow; never `fill`, never `dbCount`): a claim an agent typed into existence proves nothing.

**Neither verdict is believed.** After `proved` the harness re-runs the author's own comparison against the element named; after a repair it re-runs the author's own selector. A step whose claim does not then hold fails exactly as it would have. That is what lets an assertion be offered this at all, where the old `#agentRescue` refused one — its rule was about ACTING, and forbidding action structurally is what makes a reading question safe to ask.

**The healer keeps its place, for the one thing it is good at.** It reads a static tree and proposes a different string — the right tool for a WRONG SELECTOR, the wrong one for a CONTENT miss. Measured (be100 PL_03_01, 2026-08-25): asked why `text=Total plans` did not contain "75", it proposed `text="68"` — find an element containing the expected value, which is circular — at 0.20 confidence, and was rightly refused. So a content-only miss (`isContentMiss` across every attempt) skips the healer entirely and goes straight to triage. Ahead of both sits the free **kin** rung (`ancestorSelectors`, two levels): a summary card is a label and a value in sibling elements, and climbing to the container that holds both costs nothing.

## Backend off means not even present

Three layers, because a rule enforced in one place is a rule with a hole in it:

| Layer | Where | Behaviour |
|---|---|---|
| Authoring | `flow-author.ts` | The family is dropped in narrowing with `BACKEND_OFF_REASON`; an indexed schema stops being permission |
| Loading | `runFlow` | A flow carrying any backend step under `backend: false` is **refused before a browser opens**, naming the steps |
| Dispatch | `SmartRunner.assertBackendAllowed` | Throws `BackendDisabledError` per step, for a caller that drove the runner directly (MCP, the repair loop, an embedder) |

**Refused, never silently skipped.** A suite that quietly drops assertions goes green having proved less than it claims — the vacuous pass in a new coat. `BackendDisabledError` is harness-class (`classifyStepFailure` → `error`, `reconstructionFutile` → true), so the case is recorded **blocked**: a limit the run was given, never a finding about the application.

## A 404 is two findings, and only the codebase tells them apart

`page.goto` resolves for any response at all, so a navigation that came back 404 was recorded as a **passing** step and every step after it failed against the error page — attributed to the application. Live (be100 PL_02_03, 2026-08-25): the flow had invented a plausible-looking path, and the repository had held the real route list all along.

`#judgeNavigationStatus` reads the response against `declaredRoutes` (the indexed graph's page routes; api handlers excluded, since a navigation is not a request):

- **the path is declared** → the application should serve this page and did not. A real `high` defect, filed as one.
- **the path is NOT declared** → the TEST asked for a page that does not exist. `RouteNotFoundError`, harness-class (`classifyStepFailure` → `error`, `reconstructionFutile` → true), so the case records **blocked**. The nearest declared routes are named — "that page does not exist" is far less useful than "you meant this one".
- **nothing indexed** → no opinion. The navigation stands as it always did, and the steps after it fail on their own evidence.

Judged **after** the session bootstrap and the consent gate, never before: either can turn a first 4xx into a perfectly good page, and failing on the first answer would blame the app for a redirect it was always going to make.

`nearestRoutes` (`context/route-match.ts`) scores segment-wise — a matched leading prefix is worth most, a `:param` less than a literal — and requires **at least one literal segment in common**. Without that rule a pattern of nothing but `:param` matches every path of its length, so `/en/totally/made/up` "resembles" three routes and a reader learns to skip the line. The same function serves the authoring lint `ungroundedGoto`, so both halves give one answer about one codebase.

**`runFlow` forwards to `SmartRunner.connect` field by field.** A field added to `RunFlowOptions` and not listed there reaches the runner as `undefined` and its guard silently never fires. Both `backend` and `declaredRoutes` were added and not listed; the 404 test caught it by seeing `routes=0` inside the runner, and `assertBackendAllowed` would otherwise have been dead code shipped green. `personaBrowsers` and `sessionStates` (one Chrome per persona) are listed there too — a missing `personaBrowsers` silently degrades every hand-off to the single-browser sign-out path.


## A visible that resolved on nothing proves nothing (S5, 2026-08-28)

`expectVisible` on a positional or nameless selector (`role=combobox >> nth=0`, a bare `role=x`) whose element has no accessible name and no text records `detail.vacuous`, and `ProofBundleBuilder` seals such a run as `needs-review` with the step marked `unsure` — never green. PL_04_13: three of those passed on a page with zero comboboxes while the human had recorded the case Failed; the assertion could not fail, so it could not find the defect. A resume that dropped the agent role the pass was authored with is refused at the boundary (S8, `launch.agent` on the ledger) instead of erroring nine steps one by one.

## Reconciliation is two readings, compared (`saveCount`/`saveText`, 2026-08-31)

"The tile matches the table" / "no change after the action" was only authorable
as presence checks, which pass whether or not the readings agree — the EN-2
audit's largest missed-bug cluster (ten). `saveCount` reads how many elements
match into the run's variable store (`runner.variables`), `saveText` reads an
element's visible text; a later `expectCount` may carry a `{{variable}}` string
(interpolated by `interpolateStep`, then converted — non-numeric after
interpolation throws loudly), and `expectText` always could. Both saves go
through `#step`, so the ladder and healer apply; `saveCount` waits for one
attached match rather than silently recording 0 off a bogus selector — a
legitimately-empty listing is saved via `saveText` of the page's own readout
("0 of 0") instead. A save is not an assertion (not in `ASSERTION_ACTIONS`):
the compare carries the claim.

## A near-name on the right role is evidence, not absence (2026-08-31)

When an assertion's `role=X[name="N"]` selector exhausts the ladder and the
live tree holds a same-role node whose name is a `nearMiss` of N, the failed
step now carries `expected`/`actual` ("the page's button is named "Proceed"")
and `foundInPageText: true` — so it qualifies for proved-? and the review
judge rules on the wording, instead of a bare "could not resolve" filing a
false alarm (EN-2: exact-name misses on real controls were the largest
false-alarm cluster). Evidence-gathering only: a failed tree capture changes
nothing, and the step still fails.

## Every run keeps its film (2026-08-31)

`#videoCut` no longer discards a clean pass's recording: under the default
`video: 'on'`, every run's film is kept — the pass keeps the whole thing,
a failure keeps the film through the break (trimmed only when the failure was
the last filmed moment), and `'always'` still means untrimmed plus viewer
pacing. Asked for universally: "View actual flow" in the report and wowUI now
plays on every run, not only the ones that broke. The cost is bundle size —
the film is embedded in the proof JSON — and `--video off` remains the
opt-out (also the way to inherit the attached browser's own context).
Superseded in part 2026-09-04: `'on'` now keeps the film's ACTION MOMENTS
rather than its wall clock — see "The film keeps the moments, not the clock"
below; `'always'` is where the whole film still lives.

## The step's target, and the red rectangle (`src/engine/target.ts`, 2026-09-02)

A step's evidence used to be a selector string and a picture of the whole
page, reconciled by eye. Every step that resolved an element now records
`ProofStep.target` — the selector that resolved, the element's tag, role
(explicit or implied by the tag) and accessible name (aria-label, label, alt,
title, placeholder, or text), and its box in **document** CSS px — read from
the live element right before the shutter, so the record and the picture
describe the same thing. Steps with no element (`goto`, `workflow`, HTTP and
DB steps, the `#bareStep` absence assertions) have none. A failed step gets a
short read of the AUTHORED selector: an assertion that found its element and
disagreed with its content keeps a target (that IS the proof), a selector that
matched nothing costs one bounded miss (750 ms) and records none.

`captureEvidence` then draws a red rectangle around the target for the shutter
(`drawTargetHighlight`): a `[data-wowlidator-highlight]` div appended to the
document, `position:absolute` at the element's LIVE rectangle plus scroll —
not `fixed`, because the still is full-page and a viewport-fixed box lands at
the top of a tall image — `pointer-events:none`, top z-index, and removed in
the `finally` around `page.screenshot`, so a failed shutter cannot leave it in
the page, coverage never counts it, and the next step never sees it. Drawn
only after `primeLazyContent`/`settleRendering`, since both move things.
Every read is bounded (`TARGET_READ_BUDGET_MS`) and never throws: a target
that cannot be read is absent, never a reason a step fails. `highlightTarget`
(`SmartRunnerOptions`/`RunFlowOptions`, `--no-target-highlight` in the CLI
and the panel) turns the rectangle off; the target is recorded either way.
`describeTarget` is the one wording (`button "Sign in" · 120×40 at (30,200)`)
the CLI line, both reports, the workbook and wowUI share.
`tests/target.test.ts`: the pure half always, the browser half CDP-gated —
what the role IS and whether the box is gone afterwards are browser facts.

## Volatile greetings and the agent's tree notation (`src/engine/selector.ts`, 2026-09-02)

Two free rungs added after one ec10 run put six identical false failures and
four agent stalls on the board.

**The greeting is not the fact.** Every flow asserted the sign-in proof as
`text=Good afternoon, ผู้ดูแลระบบ`; every flow also pinned the clock with
`setClock` to a date at midnight, so the chrome said "Good morning". The step
dead-ended on every case about an admin who was signed in. `withoutGreeting`
re-writes a text or role-name selector to the name after the greeting (English
and Thai forms), and the ladder tries it right after the case rung, recorded as
`narrow` with a bundle note. The generator applies the same rewrite as it
writes (`withStableGreeting` in `toFlowStep`) and its procedure now says so, so
new flows never carry one; the rung is what rescues the flows already on disk.

**`region "Dependents Dependents"` is a tree line, not a selector.** The model
copies the AX tree's `role "name"` notation back as a selector often enough that
five such misses in a row ended a leg as a stall — while the same model had
written the correct `role=region[name=… i]` two turns earlier.
`fromAxNotation` rewrites the line to the role selector (and a bare `"name"` to
`text="name"`); `normaliseAgentSelector` composes it with the bare-role and case
rewrites and is applied to every decision and planned step in
`LlmAgentModel.decide`, before the grounding guard sees it.

**The still shows the section, not the page top.** `captureEvidence` scrolls
the step's target into view before drawing the red box and firing the shutter:
`fullPage` photographs the document, and an app shell that scrolls inside an
inner panel is viewport-tall as a document, so a section the agent reached by
scrolling was photographed at whatever position the panel was left in. An agent
leg's target is the last control it acted on successfully, so a `workflow`
step's evidence is outlined and in view like any other step's.

## The entry rung: put the value in, then read it back (2026-09-02)

Every rung of the ladder ends by re-running the AUTHOR'S OWN selector. That is
the right rule while the selector is merely hard to reach, and useless when it
names a control the page does not have. Live (ec10 HIR-EC-001): the flow keyed
a Hire Date into `role=textbox[name="Select date" i] >> nth=0` and chose an
Event Reason from `role=combobox[name="Event Reason" i]`. The agent's look
reported — correctly — that no `combobox` role exists on that page at all; the
control is a `button`. Three input steps burned 190 seconds, the case entered
not one value, and everything after it was moot. The flow was right about WHAT
to do and wrong about the selector, and no amount of re-running the selector
could fix that.

`#agentEnter` is the last rung, for `fill`/`fillRetry`/`type`/`selectOption`
only. It asks for the OUTCOME rather than the action — *set this field to this
value, with whatever the page really offers* — and what decides it is a
**read-back of the value**, from the author's selector if it resolves now,
otherwise from the control the agent last acted on successfully. `valueMatches`
is tolerant in one direction only: a control renders what it holds its own way
(`1 Sep 2027` for `01 Sep 2027`, a combobox label inside its row text), so the
ask need only be PRESENT in what came back; an empty control never satisfies a
non-empty ask. A step that passes here is recorded `agent` and files a
medium usability defect naming the selector to rewrite, because paying a model
to rediscover the same field every run is a cost, not a fix.

Gated by `--agent-assist`, the same reason the repair stage is: it types into
someone's application.

**`paste` joins the agent's vocabulary** for this. A control that refuses
`fill` (one assignment) and `type` (a keydown per character) usually has a
listener that rejects both — a date picker that only accepts its own calendar,
a masked input, a contenteditable. `paste` focuses, clears what it can, and
delivers the whole string through `keyboard.insertText`, the same input path a
real paste uses. It is in `INTERACTION_ACTIONS` (it engages a control, so it
counts against a stall) and deliberately NOT in `REVEAL_ACTIONS` or
`READ_ONLY_ACTIONS`: a claim an agent pasted into existence proves nothing.

Tests: `tests/form-actions.test.ts`.

## Where the fill actually failed, module by module (ec10 HIR-EC-001, 2026-09-02)

Measured, not inferred — each point below was reproduced with a probe.

- **The application**: Hire Date is TWO inputs (`HumiDatePicker`): a visible
  `type="text" readOnly` with the placeholder "Select date", and a hidden
  `type="date"` at `opacity:0` that the `<label for>` actually points at. Event
  Reason is `HumiSearchableSelect`: a `<button aria-haspopup="listbox">`.
- **Generator** (three faults): it took the textbox NAMED BY THE PLACEHOLDER
  (`textbox "Select date"`, the read-only shell) although the tree also listed
  `textbox "Hire Date"`, the real one; it wrote the date as the page displays it
  (`1 Sep 2027`) where a date input accepts only `YYYY-MM-DD` (Playwright:
  `Malformed value`); and it wrote `role=combobox` for a control the tree showed
  as a `button`. The procedure now says all three, in one rule.
- **Engine** (one fault, the expensive one): Playwright's `fill` on a read-only
  input does not fail — it WAITS for editability until the timeout. The ladder
  saw a timeout, which reads exactly like "not there", and walked every rung on
  the same element: 56 s, 41 s and 93 s for the three inputs, nothing entered.
  `#readOnlyShell` now asks the element whether it is read-only right after the
  fast miss; if so it fills the single editable input beside it (as an ISO date
  when it is a date input, `isoDateOf`), recorded `narrow` with a note, and when
  there is none it goes straight to `#agentEnter` instead of timing out four
  more times.
- **Orchestrator**: the agent's look found the truth ("no combobox role exists
  on this page") and was then barred from acting on it — fixed by the entry
  rung, which is now NOT gated by `--agent-assist` (see above).
- **Healer**: off under fail-fast (risk 80%), and it reads the same tree, so it
  would have proposed the same shell. Not the cause.
- **Provider, reporter**: every model call answered; the evidence (target box,
  error, durations) was recorded exactly. Not the cause.

Test: `tests/form-actions.test.ts` — the read-only shell fixture, filled as an
ISO date, passing in seconds rather than a minute.

**Follow-ups landed the same day** (`docs/readonly-input-spec.md` items 5–7):
the tree prints `readonly` on a read-only textbox (`AxNode.readonly`), the
generator refuses a fill aimed at one (`fillsReadOnlyNode`), the agent's
`fill`/`type`/`paste` refuse a read-only, disabled or non-editable target in one
turn (`#writable`) instead of reporting a success that changed nothing, and the
shell rung tries the input named by the field the intent speaks of
(`fieldNamesIn` → `role=textbox[name="Hire Date" i]`) before the positional
sibling. Delivered on typecheck alone at the user's request; the CDP fixture in
`tests/form-actions.test.ts` covers the rung, the rest is untested until the
next run.

## The film keeps the moments, not the clock (2026-09-04)

**Incident.** A run's film was its wall clock: Playwright's recorder writes a
constant 25 fps VP8 stream (measured on three catalog films under
`reports/*-media`: 25.0 fps throughout, a keyframe every 128 frames = 5.12 s,
each keyframe 60–90 KB at 960 wide, each idle second another 5–8 KB of
"nothing changed" frames). A 59 s film with a dozen moments in it weighed
1.6 MB and was 59 s to watch; a run whose steps walked the ladder or waited
on a model produced a film that was minutes of a page doing nothing, embedded
base64 in every proof bundle and report.

**Rule.** Under the default `video: 'on'` the sealed film is **condensed to
its action moments**: the instant each filmed step COMPLETED (its
`videoOffsetMs + durationMs` — a step that walked the ladder for forty seconds
keeps the second in which it finally acted, not the forty), and the instant
each action the workflow agent took inside a `workflow` step landed
(`AgentAction.finishedAt`, new; `wait`/`read`/`save`/`finish`/`fail` mark no
moment — nothing happened on screen). Each moment is held `VIDEO_ACTION_LEAD_MS`
(400) before and `VIDEO_ACTION_DWELL_MS` (1000, `videoDwellMs` on
`RunFlowOptions`/`SmartRunnerOptions`) after, at real speed. A failure keeps
the film through the break exactly as before: the cut (`#videoCut`) still
decides where the film ENDS, and the condensing only drops idle before it.
`ProofBundleBuilder.videoMoments(persona)` lists the moments per film;
persona films (`videos[]`) are condensed on their own clock the same way.
`'always'` is the opt-out — the whole wall-clock film, uncondensed, plus
viewer pacing; `'off'` still films nothing.

**How, with no encoder.** `condenseWebm` (`webm.ts`) keeps frames, never
makes them: a VP8 frame decodes against everything back to the last
keyframe, so every kept span opens on the most recent keyframe at or before
its moment and runs frame for frame, in source order, through the dwell. The
codec-forced pre-roll between that keyframe and the moment (0–5.12 s) is
re-timed to play at `IDLE_PLAYBACK_SPEED` (8×); the frames outside every
span are gone. Clusters are rebuilt (one per keyframe / 30 s), `SeekHead`
voided, `Cues` dropped, `Duration` and the segment size patched, and the
result re-parsed (`verify`) — a film that cannot be condensed faithfully is
handed over WHOLE, never doubtful. The recording carries `condensed`
(`sourceDurationMs`, `sourceBytes`, `moments`, `dwellMs`, and the clock map
`segments`); `setVideo`/`addPersonaVideo` move every step's `videoOffsetMs`
onto the condensed clock (`mapToCondensed`) so "play from here", the
failure pre-seek and the subtitle bar keep working unchanged. Playwright's
own bundled ffmpeg (`ms-playwright/ffmpeg-*`) could re-encode to exactly one
second per moment with no keyframe pre-roll; not taken on because it is a
native process and a generation loss — the pure cut is the floor: each kept
span costs one keyframe (~70 KB) plus its dwell.

**Fixed on the way.** `addStep` derived `videoOffsetMs` from the bare step
argument, which never carries the persona the builder stamps on the record —
so every persona step was measured from the PRIMARY film's first frame, and
seeks on a persona film were off by however long after it that film began.

**Measured** (`idle.flow.json`: goto, two asserts, a click whose effect lands
4 s later, one selector that walks the ladder for 18.8 s, one more assert; no
healer, no agent; same run, before = the whole film as `'on'` used to keep):

| | bytes | film | wall | steps | resolutions |
|---|---|---|---|---|---|
| before (whole film) | 184,732 | 24.3 s | 24.0 s | 5/6 | fast, fast, late, —, fast |
| after (condensed, 6 moments) | 71,111 | 5.2 s | 24.0 s | 5/6 | same |

On a real catalog film (`be100-rip … pl-07-04.webm`, 58.9 s, 1,629,364 B)
with seven synthetic moments: 979,918 B, 12.5 s.

**Pinned by** `tests/video.test.ts`: "condensing a recording to its action
moments" (real Playwright fixture, two keyframes — the pre-roll case), "the
action moments of a film" (steps + agent actions, persona films, the offset
remap), and CDP-gated "the condensed film plays in the browser, for as long
as the bundle says" — a container that re-parses is not the same fact as
one Chrome's demuxer accepts and seeks to its last frame.

## A two-persona benchmark, and what it measures (2026-09-04)

Every other `.flow.json` in the repository signs in exactly once (15 files,
none with more than one `signIn`), so the browser lease, the session guard's
per-persona memory and the sign-in bootstrap had no before/after to be measured
against. `examples/two-persona/` is that row: a dependency-free fixture of the
live application's shape (two-screen login, a session cookie carrying WHICH
account, `#who` on the protected page) and a flow that hands off and comes back.

Measured, headless, two consecutive runs stable to ~10 ms: `passed` 8/8 in
**7.2 s at 0 tokens**, `fast=6` and no other resolution — of which the three
`signIn` steps are **6.4 s** (1623 + 2387 + 2408 ms) and everything else is
0.15 s. **89% of a two-persona case is its sign-ins, and none of it appears in
any model-latency view**, because a switch spends no tokens; `signIn`'s own
`durationMs` on the step is the only place it shows.

Two facts the benchmark exposed, both worth knowing before reading its numbers:

- **`wowlidator run` cannot give a persona its own Chrome.** `personaBrowsers`
  is set in exactly one place — `cli/run-cases.ts`, the suite and catalog path,
  where a case leases a lane per persona. A single-flow `run` passes `personas`
  and never `personaBrowsers`, so every switch there is a sign-out and a fresh
  sign-in on one browser, and `--browsers 2` does not change it (measured: both
  runs stayed on one endpoint and recorded `signedOutVia`). The kept-session
  path — `keptSession: true`, no login form — is reachable only through a
  catalog run and is covered by the CDP-gated assertions in
  `tests/session-bootstrap.test.ts`. The 2.4 s return above is therefore the
  *worst* case, and closing that gap in `run` is the largest win this benchmark
  can show.
- **`signIn.url` is not resolved against `baseUrl`, although `goto` is.** A
  flow with `{ "action": "signIn", "url": "/login" }` dies on
  `Cannot navigate to invalid URL` while `{ "action": "goto", "url": "/app" }`
  one line later resolves fine. The example's URL is absolute for that reason.

## A `signIn` is allowed to stand on the sign-in page (HIR-EC-009, 2026-09-04)

**Incident.** The authored setup was `goto <app page>` then
`signIn as <HR_ADMIN_ACCOUNT>`. The flow contains a `signIn`, so
`signsInItself` is true, `inheritSession` is false and the context starts with
an empty jar — the first `goto` bounces to the login page, and all three
`#strandedMessage` conditions then hold at the top of `executeSteps`' step
loop: on a sign-in URL now, the most recent `goto` did not ask for one, and it
asked for a different page. The run died `SessionLostError` **on the step
whose entire job is to sign in**, one step short of the session it was about
to establish, and filed a high `functional` defect about an application that
was fine. `#bootstrapSession` could not rescue it either: it bails on
`#flowSignsInItself`, precisely so it never races a flow's own login.

**Rule.** `executeSteps` skips `assertSessionHeld()` for a step whose action
is `signIn`, and for nothing else.

The exemption is at the **call site**, not inside `#strandedMessage`. That
predicate is also consulted by the ladder (rung 2.5, "declined to heal"),
where "the next planned step" is not a meaningful notion and where relaxing
the answer would let a repair land on login furniture — the PB_01_01 failure
(`waitFor role=heading[name="Sign in"] … passed (jit)`) the predicate exists
for. Widening the predicate would have needed either new mutable state on the
runner or a parameter one of its two callers can never supply; the call-site
form needs neither, and `step` is already in scope there.

It is per step, never per run: the step AFTER the `signIn` is guarded exactly
as before, so a sign-in that does not take still stops the run one step later
rather than spending the body on the login screen. `signOut` is NOT exempt —
it has its own, different exemption (`#lastAction === 'signOut'`, which
exempts the step that follows one). `#strandedMessage`'s three conditions,
the `click` exemption and the `signInDidNotTake` branch are untouched, as is
`#bareStep`, which `signIn` runs through and which never consults the guard.

**Measured** (the incident's setup shape against `examples/two-persona/`'s
fixture — `/app` bounces an unauthenticated visitor to `/login` — one Chrome,
`--no-heal --no-agent`):

| | verdict | steps | wall | defects | tokens |
|---|---|---|---|---|---|
| before | `failed`, exit 1 | 1/1 recorded, 3 never ran | 0.6 s | 1 high functional, "lost its session" | 0 |
| after | `passed`, exit 0 | 4/4, `fast=2` | 2.2 s | 0 | 0 |

The persona benchmark is unmoved: `examples/two-persona/handoff.flow.json`
`passed` 8/8 in 7.06 s at `fast=6` against its 7.2 s baseline. Its three
`signIn` steps each follow a `goto /app` that did NOT bounce, so the guard
answered `null` there before the change and is simply not asked now.

**Blast radius, counted rather than guessed.** 178 `.flow.json` on disk (this
repository plus `valst-output/`), 5 of them containing a `signIn`, 7 `signIn`
occurrences in total: 2 have no preceding `goto` at all (`#lastGotoPath` is
null, the guard could never fire), 3 follow a `goto` that asked for a sign-in
URL (`#lastGotoAskedSignIn` already exempted them), and 2 are the two-persona
benchmark's hand-offs, which change only in the world where the application
had already dropped the session. No flow gains a step it did not have, and no
step becomes healable that was not: a `signIn` is a `#bareStep` off the
ladder, so nothing on its path can be repaired onto login furniture.

**One residual edge, disclosed.** `#signInDidNotTake` is set only by the
hand-authored credential path (`noteSignInOutcome`), never by the `signIn`
step. A flow that types a login by hand, fails it, and then runs a `signIn`
now reaches the `signIn`, and if that succeeds the stale verdict still stops
the run on the NEXT step with the "sign-in did not take effect" message. It
stops either way — no run goes green that did not before — so clearing the
flag on a successful `signIn` was left out of this change rather than widened
into it.

**Pinned by** `tests/session-bootstrap.test.ts`: "a goto bounced to login
followed by a signIn signs in rather than dying session-lost" (red before the
change, with the incident's own message as the failure) and its negative,
"the exemption is the signIn step only: an ordinary step after the same
bounce still stops" — green both before and after, which is what proves the
exemption did not become run-wide.

## The film performs like a person, and cuts like an edit (2026-09-04)

**Incident.** PL_07_06's film (`valst-output/proofs/7271deea-….json`, 48.4 s
condensed to 13.8 s, 12 moments) was called glitchy, and its frames say why
(`webm.ts`'s own reader; no ffmpeg here): 188 of its 511 frames were **5 ms
apart** — the 8× pre-roll of the first condensing (`IDLE_PLAYBACK_SPEED`) on
a 25 fps stream, which a browser presents one frame in three of, so every
keyframe-forced pre-roll (up to 5.12 s of source) was a 0.2–0.6 s strobe of
the page jumping about; a 2-frame "idle" between two windows 40 ms apart
became a **5 ms sliver** (source 3560–3600 → output 3525–3530); and every cut
(source 9520 → 25600, 30600 → 40960) was a jump between two page states with
**one frame period** between them. On top of that the actions themselves were
teleports: Playwright's `click` moves the pointer to the control and presses
in one event, so the drawn pointer appeared on the button in the frame it was
pressed, and `fill` set the whole value in one frame (`runner.ts` `click`/
`fill` closures; the agent's `#act` in `workflow-agent.ts` did the same).

**Rule, the cut (`webm.ts` `condense`).** Still no encoder and no frame is
ever made or reordered; only the clock changes. Three things replaced the 8×
speed: an idle run (a keyframe's pre-roll, or the gap between two moments on
one keyframe) is **packed into `IDLE_BURST_MS` (160)** — never faster than
one unit a frame, never faster than it happened — so it reads as a cut, not
a scrub; the **last frame before every cut is held `CUT_HOLD_MS` (400)** —
before a new span opens on its keyframe and before a moment gives way to
idle — a beat on the state that was reached, then the jump; and two moments
closer than **`BRIDGE_MS` (1000)** are one stretch at real speed (the pointer
travelling between two controls), so no sliver. Every span still opens on
the most recent keyframe at or before its window; output timestamps are
strictly increasing integers; `frameIndex()` exposes the frames as a player
sees them so tests can check both. `CondenseOptions` carries the three
knobs; `mapToCondensed` and the `segments` map are unchanged.

**Rule, the performance (`humanize.ts`, new leaf module).** One knob:
`humanize` on `SmartRunnerOptions`/`RunFlowOptions` (forwarded in `runFlow`),
`--humanize on|off`, `WOWLIDATOR_HUMANIZE=1|0`; **default on while filming,
off with `--video off`**, so an unfilmed run pays nothing (pinned: an
unfilmed run records no `performedMs`). Everything in it is a PRELUDE to the
author's own action, never a replacement: `approach()` moves the mouse along
an eased, slightly bowed path (`pointerPath`, `HUMAN_POINTER_STEPS` × 16 ms)
to the box of the locator the rung resolved, hovers `HUMAN_HOVER_MS`, and
then that same locator is clicked with what is left of the step's timeout
(`remainingTimeout` — the look is bounded by `HUMAN_LOOK_MS` (250) and
deducted, so a missing element still fails inside ONE fast window, with
Playwright's own error). `humanFill` inserts the value character by
character through `Keyboard.insertText` with `keyDelays` (30–80 ms,
shrunk to `HUMAN_TYPING_BUDGET_MS`), then READS IT BACK; a field that does
not hold exactly the value is filled by the ordinary `fill`. Two ladder
facts are kept literally: **`fill` still fires no keydown** (insertText is
what Playwright's `fill` uses; the clear is a `select()`, not `fill('')`,
which presses Delete), and a field whose ARIA says its keys drive a popup
(`combobox`/`searchbox`, `aria-autocomplete`, `aria-haspopup`,
`aria-controls`, `list`) is never typed into — a suggestion list opened by
the film's typing would cover the next control. `type` keeps real keys and
only jitters the pace (`humanKeys`); `scrollTo` and the agent's screen
scroll do a smooth scroll first and the instant one as the action of record;
`goto` puts the pointer back on the new document (no pause — a real 350 ms
beat moved the ladder's clock and flipped the patience rung's fixtures from
`late` to `fast`, so the film's dwell is the beat). The workflow agent's
`#act` goes through the same functions (`WorkflowAgentOptions.humanize`,
`RunOptions.humanize`, passed by the runner on every `run`), so an agent leg
looks like the steps around it. The approach runs BEFORE the popup listener
is armed in `click` — the grace window must not count during it (two popup
tests caught that).

**The film keeps the performance.** A humanised step writes
`detail.performedMs`; `videoActionMoments()` gives each moment a lead of the
fixed `VIDEO_ACTION_LEAD_MS` plus that (an agent action that landed: plus its
`durationMs`), capped at `VIDEO_LEAD_CAP_MS` (5 s); `actionWindows` and the
offset remap take `ActionMoment` as well as a number. Without it the typing
and the pointer's travel would have been the idle the condensing drops.

**Measured.** Fixture film (`tests/fixtures/recording.webm`, moments 2.5 s
and 6 s): pre-roll segments 624 ms + 440 ms → 156 ms + 154 ms, one 400 ms
hold, every frame after a hold a keyframe. Catalog film `pl-07-04.webm`
(58.9 s, seven synthetic moments), played back in Chrome: old 5 ms cadence —
14.0 s, 1 stall, 282 dropped of 745; new — 13.3 s, 7 stalls of ~25 ms
(decoder catching up on a 1 ms burst; total overrun 170 ms), 432 dropped —
the burst frames, which is the point. A humanised click on a local page
performs in ~400 ms; a humanised fill of 16 characters in ~1.1 s; a missing
element under a humanised click fails in < 1.8 s against a 1 s window.

**Pinned by** `tests/video.test.ts` ("packs the forced pre-roll into a
burst", "never emits a frame spacing under one unit, and never a sliver",
"holds the last frame before every cut, and every cut lands on a keyframe",
"keeps a performed step's whole performance ahead of its moment") and
`tests/humanize.test.ts` (the path and delay planners; humanize off is the
single call the step always made; CDP: no keydown + read-back + a combobox
filled in one move, the click lands where the plain one would and a miss
fails in one window, a filmed run performs and an unfilmed one does not, with
identical resolutions).
