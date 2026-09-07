/**
 * The CLI usage text. Split out of cli.ts verbatim.
 */

import { DEFAULT_CACHE_FILENAME } from '../cache/cache-manager.js';
import { DEFAULT_CONTEXT_CACHE_FILE } from '../context/context-engine.js';
import { DEFAULT_CDP_URL } from '../engine/runner.js';
import { DEFAULT_PROOF_DIR } from '../mcp/server.js';
import { DEFAULT_MAX_REPAIR_ATTEMPTS } from '../repair/flow-repair-loop.js';
import { DEFAULT_REPORT_DIR, REPORT_PLACEHOLDERS } from '../reporter/html-reporter.js';

export const USAGE = `wowlidator — decoupled UI testing engine with JIT self-healing

Usage:
  wowlidator ui [--port 4600] [--no-open] [--wow]        everything below, in a browser
  wowlidator go <flow.json | url | "what to test"> [options]   one command, start to report
  wowlidator run <flow.json>... [--repair] [options]        several files run as one suite
  wowlidator generate <url> [--run] [--context] [options]
  wowlidator author "<prompt>" [--url <url>] [--run] [options]
  wowlidator catalog <file> [--claims-only] [--claims <f>] [--url <url>] [--run]
  wowlidator draft "<what to cover>" [--context-doc <f>] [--url <url>]
  wowlidator crawl <url> [--max-pages 20] [options]
  wowlidator watch <flow.json> [--every 15m] [--notify <cmd>] [--until-fail]
  wowlidator cache list [--cache <path>]
  wowlidator cache forget (<key> | --all) [--cache <path>]
  wowlidator history clear [--all] [--out <proof dir>]
  wowlidator context build [--root <dir>] [--openapi <path|url>] [--db-schema <path>] [--force]
  wowlidator context show  [--root <dir>] [--context-out <path>] [--json]
  wowlidator context add <path> [--openapi <path|url>] [--db-schema <path>] [--context-doc <file>]
                                           scan a repository and remember it —
                                           select it on a run with --repo
  wowlidator context list                  the saved repositories and their slugs
  wowlidator recall [last | <n>] [--json]  list saved launches, or re-run one —
                                           every launch is saved before it can
                                           fail, so a run that died before any
                                           test executed is still recallable
  wowlidator report [<ledger.progress.json> | <dir>]
                                           rebuild each catalog run's HTML report
                                           and its all-cases Excel export
                                           (one step per row, photos embedded,
                                           video linked under every step) from
                                           the ledgers on disk — no re-run
                                           (default: .wowlidator/catalogs/)
  wowlidator db restore [<baseline.json> | <runKey> | <ledger.progress.json>]
                                           put the tables back to the snapshot a
                                           run took before it started — for a run
                                           paused or killed before its own restore
                                           ran. Needs WOWLIDATOR_DB_RESTORE_URL, a
                                           write credential. Newest baseline if no
                                           argument is given
  wowlidator data check <catalog> --master-data <file> --url <app> [--as <email>:<pass>] [--json]
                                           do the codes the sheet's Test Data names
                                           exist in the application's master, what
                                           are they called, are they free, and can
                                           the UI picker reach them? A report, exit
                                           0 always — see "data check" below
  wowlidator data lookups --repo <slug> --url <app> [--as <email>:<pass>] [--out <file>]
  wowlidator doctor
  wowlidator mcp

Options:
  --cdp <url>          CDP endpoint of a running Chrome  (default ${DEFAULT_CDP_URL})
  --cache <path>       Healed-selector cache file        (default ./${DEFAULT_CACHE_FILENAME})
  --out <dir>          Directory for proof bundles       (default ./${DEFAULT_PROOF_DIR})
  --report <path>      HTML report destination — a file, a directory, or a
                       template. Placeholders:
                         ${REPORT_PLACEHOLDERS.map((p) => `{${p}}`).join(' ')}
                                                         (default ./${DEFAULT_REPORT_DIR}/)
  --report-dir <dir>   Directory for reports when --report has no path
  --no-report          Skip HTML report generation
  --humanize <on|off>  Perform like a person for the film: the pointer
                       travels to each control and hovers before the press,
                       values go in character by character, navigations get
                       a beat. Default: on while filming, off with --video
                       off. Never changes what a step resolves or asserts.
  --video <mode>       on | always | off  (default on)
                       Every run keeps its film — "View actual flow" plays
                       it in the report and the panel, pass or fail. Under
                       'on' a failing run's film is cut at the failure when
                       nothing was filmed after it; 'always' keeps it
                       untrimmed whatever happened, and paces steps for a
                       viewer (--step-delay defaults to 1500 there).
                       Films the run, with a pointer drawn into the page so
                       clicks are visible — a still cannot show a click, only
                       the page on either side of one. The recording is
                       embedded in the report and every step can be played
                       from. Recording needs a browser context wowlidator
                       creates, so a filmed run does NOT inherit the attached
                       browser's cookies; use 'off' when a run depends on a
                       session that is already signed in.
  --screenshots <mode> auto | all | on-event | on-failure | off  (default auto)
                       'auto' follows --video: 'on-failure' while filming,
                       since the recording already covers every other step and
                       a still per step would be the same evidence twice; 'all'
                       when filming is off, which is what it always was. Set it
                       explicitly to have both — 'all' gives a filmstrip
                       alongside the video.
  --capture-delay <ms> Pause before each screenshot so the page has painted
                       (default 250). Navigation waits for domcontentloaded,
                       which fires before a client-rendered app has drawn
                       anything — without this the filmstrip is a reel of empty
                       shells for steps that passed. Raise it for a slow or
                       heavily animated app; 0 captures as early as possible.
  --step-delay <ms>    Pause before each step. Defaults to 1500 while
                       filming for a viewer (--video always) — a run that
                       blurs through five states in two seconds demonstrates
                       nothing — and 0 otherwise. Set it (or
                       WOWLIDATOR_STEP_DELAY) to pace every run.
  --agent-assist       When the healer cannot find a control, let the agent
                       drive the browser to make it reachable — open the menu
                       or tab it lives behind, scroll it into view, wait out a
                       load — and then run YOUR selector against the page it
                       opened up. The step still has to resolve on its own
                       terms, and an assertion is never offered this: a claim
                       an agent made true proves nothing. Off by default
                       because, unlike every other rung, it changes the
                       application before the step runs.
  --no-reconstruct     Disable in-run step reconstruction. By default a
                       failed step is rebuilt by the repair model against
                       the live page and retried — up to 3 total tries —
                       before it is classified as a failure or dead end.
                       A rescued step is recorded (superseded attempts,
                       reconstruction record, a medium drift defect), and
                       an assertion always keeps its claim: only
                       preparation may be inserted before it.
  --no-agent-early-stop
                       Disable the workflow agent's early give-up. By default
                       a leg concedes after 3 turns of finding nothing to act
                       on, or 5 with no progress; off raises both to 25, so
                       the agent keeps trying far longer before conceding —
                       slower and more thorough. Env: WOWLIDATOR_AGENT_EARLY_STOP=off.
  --no-heal            Disable the JIT healer
  --no-agent           Disable multi-page agentic navigation
  --db-baseline <mode> off | snapshot | restore | auto (default). Before a run,
                       snapshot the tables the flows are about; compare on every
                       backend step; restore them after (restore mode, needs
                       WOWLIDATOR_DB_RESTORE_URL). See .env.example. Also
                       --db-baseline-tables <a,b> to add tables to the set.
  --no-backend         Author no HTTP or database step: every claim is proved
                       through the page, and a step a backend check could prove
                       better is marked as visual-only in the report
  --no-network         Do not observe the page's HTTP traffic. Observing is on
                       by default and costs no tokens: it is what lets a failed
                       step say "the request behind this returned 500" instead
                       of blaming the selector — and skip the heal that would
                       otherwise repair onto the resulting error state.
  --update-baselines   Rewrite visual baselines instead of comparing
  --no-history         Do not record or compare against run history
  --json               Print the full proof bundle as JSON
  -h, --help           Show this message

run options:
  A suite whose catalog recorded its own results (an Actual Result column)
  also writes truth-table.html beside the suite index on finish — every case
  graded TP/TN/FP/FN against the sheet, accuracy/precision/recall on top.
  Pure arithmetic over the verdicts already earned: zero model tokens.
  --sheet-order        Keep the suite's own case order. Two defaults it
                       disables: readers run before writers (a read-assertion
                       is authored against the data as it stood, and a suite
                       that creates or deletes records mid-run invalidates its
                       own remaining reads), and a multi-scenario catalog
                       queues its FASTEST scenario first — estimated from the
                       catalog's own prior run durations where they exist, the
                       sheet's Steps/Expected lines otherwise — so verdicts
                       arrive soonest and cheap scenarios fail fast.
                       Use this when the sequence itself is what the suite
                       tests.
  --repair             Autoheal: on a failed / error / dead-end result, ask AI
                       to rewrite the flow around the break and rerun — up to
                       --repair-attempts total runs. On a catalog or generated
                       suite it heals each case the same way. Never
                       overwrites the original file: each attempt writes a
                       new <name>.attempt-N.flow.json beside it, plus a
                       <name>.attempt-N.patch explaining the change. Reports
                       a dead end, not a crash, if every attempt still fails.
                       Off by default. Uses the generator role.
  --repair-attempts <n> Total attempts, including the first  (default ${DEFAULT_MAX_REPAIR_ATTEMPTS})
  --repair-investigate Before each fix, send the agent back to the page to
                       reinvestigate the failed step live — open the menu,
                       wait, scroll — and repair against the page it opened
                       up, not just a static snapshot. Its findings land in
                       the .patch file. Implies --repair. Uses the agent
                       role, and acts on the application: opt-in for the
                       same reason as --agent-assist.
  --repair-regenerate  Let a fix regenerate the flow from the failed step
                       onward — replacing the failed step and every later
                       step in the same section — for when the failure shows
                       the whole tail was written against a page that does
                       not exist. Steps before the failure are never
                       touched. Implies --repair.

generate options:
  --run                Execute the generated cases immediately
  --focus <text>       Steer generation, e.g. "the filter controls"
  --max-cases <n>      Cap generated cases                (default 6)
  --suite <path>       Where to write the generated suite
                       (default: <report-dir>/<page>/suite.json)

draft — the other way in: a description, some specs, or a page becomes a
                       catalog in this project's own format (the columns of
                       test_catalog.csv). It runs nothing — read the sheet, cut
                       what you do not want, then hand it to the catalog command.
  --context-doc <path> A spec to write the cases from. Repeatable.
  --url <url>          Read the page too, so menu paths and control names match
                       what is really on screen.
  --catalog-out <path> Where the sheet goes
                       (default: <report-dir>/catalogs/<subject>.csv)
  --max-cases-drafted <n>  Cap on cases in one draft (default 20)

catalog — a document of claims (.md .csv .html .txt .json .yaml .xlsx .pdf .mmd .puml,
                       or a sequence-diagram image: .png .jpg .jpeg .webp .svg,
                       transcribed by a vision model into a reviewable
                       <image>.transcribed.mmd beside it, then read as an
                       ordinary diagram) becomes a test, in two steps you can
                       see between. The approved claims are authored as
                       discrete cases and each is run on its own, so a case
                       that fails is recorded and the remaining ones are still
                       checked. A sheet in this project's own format is read
                       from its columns instead of being interpreted — no model
                       call, and the Test Case IDs survive into the claims:
  --claims-only        Stop after listing what the document claims. One cheap
                       model call, no browser. Writes a claims file.
  --claims <path>      Author from an already-reviewed claims file. Strike a
                       claim out by setting its "approved" to false.
  --resume             Continue a catalog that stopped short, under its original run key:
                       cases whose verdict is in <claims>.progress.json are pulled into the
                       roll-up as finished tests; the rest are authored and run
  --rerun-vacuous      Re-author and re-run every recorded case whose flow asserts nothing about
                       its claim (only the sign-in proof and a URL); implies --resume
  --rerun-errors       Re-run every recorded case the harness ended in error; implies --resume
  --rerun-failed       Re-run every failed / dead-end case with autoheal; implies --resume --repair
  --rerun-case <id>    Re-author the named case from its sheet row and re-run it, whatever its
                       verdict; repeatable; implies --resume. A case id the workbook
                       repeats is qualified (SHEET:CASE_ID, CASE_ID#2) — use that spelling.
  --sheet <name>       (workbook) Only this worksheet — EC, BE, TM, PY; repeatable,
                       case-insensitive. The claims file, the ledger and the report
                       are then this slice's.
  --category <name>    (workbook) Only rows of this Category column (Hiring, Benefit
                       Plan …); repeatable, case-insensitive; combines with --sheet.
  --include-blocked    Author and run rows the sheet records as Blocked / Pending
                       deploy / Pending confirm. Off by default: the sheet's own
                       testers could not run them, and each names a bug ticket the
                       run would only file again. Their sheet status still reaches
                       the truth table as "sheet: blocked", outside the accuracy.
  --claims-out <path>  Where --claims-only writes
                       (default: <report-dir>/catalogs/<name>.claims.json)
  --context-doc <path> A supporting document — background for the model, never
                       a source of claims. Repeatable. Not --context, which is
                       the static repository index.
  --context-budget <n> Characters of that background sent per prompt. Default
                       24000; 0 sends every context document whole. Over the
                       budget, the sections
                       that bear on each case are selected and the document's
                       full heading outline is sent with them, so nothing
                       elided reads as absent. A document under the budget, or
                       one the case does not distinguish, is still sent whole.
  --max-claims <n>     Cap on claims read from one catalog (default 40)
  --policy <p>         read-only | forms | mutations      (default mutations)
  --no-author-review   Skip the authoring review. By default every authored
                       flow gets a second look before it is written: steps
                       with nothing behind them (a name in no captured tree, a
                       path no route declares) are checked by the agent role
                       against the codebase index and the documents, repointed
                       when the evidence supports it, and reported either way.
  --no-value-resolution  Leave a sheet's placeholder tokens (<NON_EXISTING_EMPLOYEE_ID>)
                       unresolved. By default a token or a described value is resolved
                       before the lints — from the case's own test data, the documents
                       and repository, the database (read-only), or, flagged as
                       GENERATED on the step and in every report, the generator itself.
                       WOWLIDATOR_VALUE_RESOLUTION=off does the same.
  --no-target-highlight
                       Leave step screenshots unmarked. By default a red
                       rectangle is drawn around the element each step acted
                       on or checked (its selector, role, name and box are
                       recorded on the step as "target" either way).
  --no-agent-capture   Capture the page immediately instead of letting the
                       agent steady it first (wait out spinners, dismiss
                       overlays, prime lazy content). The pilot is on by
                       default because an inaccurate capture poisons every
                       test written from it; it is skipped automatically
                       when the agent role has no key.
                       'forms' enables negative testing: submit empty/invalid
                       input and assert the validation error appears.
Browser lifecycle (wowlidator starts and checks Chrome itself — no wrapper script):
  --no-ensure-chrome   Do not start or repair Chrome; use whatever is there.
  --chrome-profile <d> Profile for a browser wowlidator starts (default /tmp/wowlidator-chrome-profile).
                       Only a browser on this profile is ever restarted or stopped.
  --headless           Run without a window (env WOWLIDATOR_HEADLESS=1, to stop
                       remembering the flag). Applies to a browser wowlidator
                       already has open, not only to one it starts: that browser
                       is restarted without its window. Never touches a Chrome
                       on another profile.
  --no-headless        Give the window back.
  --browsers <n>       Spread a parallel run over n Chromes (env WOWLIDATOR_BROWSERS):
                       the one on the CDP port plus n-1 on the ports after it,
                       each on its own profile (<profile>-2, -3, …), started
                       headless unless --no-headless. Each case leases the
                       least-busy one. One browser's main thread queues every
                       lane's renderer, encoder and CDP session, so with
                       --concurrency above 3 or so this is where the time goes.
                       A case that signs in as several people (--persona) gets
                       one Chrome per person, sessions kept for the whole case;
                       the pool grows on demand when this is unset. With
                       --no-headless --browsers 2 you watch employee and
                       manager side by side. --stop-chrome stops every one
                       this run started.
  --stop-chrome        Quit the browser afterwards, but only if this run started it.
  --wait-for <url>     Wait until this responds before starting — for a dev
                       server that is still booting.
  --open               Open the HTML report when the run finishes.

  --max-pages <n>      (crawl) How many links to follow (default 20). Links
                       beyond the budget are reported, never silently dropped.
  --follow-buttons     (crawl) Also follow buttons that navigate — needed for
                       apps that route from rows and cards. Off by default: a
                       link is a GET, a button is anything. Even on, a control
                       whose short label reads like an action (Approve, Delete,
                       Submit…) is never clicked.
  --concurrency <n>    (catalog --run, generate --run) How many cases run at
                       once, each in its own browser context. A pipelined
                       catalog with no value stated runs 3 while rows are
                       still being authored and widens to 5 once authoring
                       finishes; anywhere else the default is 8. A case that
                       changes data — fills a form, calls a writing endpoint,
                       asserts on the database — always runs alone. 1 runs
                       them one after another, and is the A/B test for a
                       parallel result that looks wrong.
  --case-timeout <seconds|off>
                       Whole-case ceiling for suite/catalog runs (default 1200s;
                       env WOWLIDATOR_CASE_TIMEOUT_MS is milliseconds). 0 or off
                       disables it. A cut case is blocked and --resume runs it again.
  --author-concurrency <n>
  --author-attempts <n>  Authoring asks per row including the first (default 3, or the
                       Machinery dial); 1 = no re-ask budget
                       (catalog --claims) How many rows of a test-case table
                       are authored at once (default 3). Each worker reads the
                       start page in its own tab and makes its own model call;
                       with --run, a finished case is queued to run at once.
                       1 authors rows one after another, and is the A/B test
                       for a batched result that looks wrong.
  --author-lookahead <n|all>
                       (catalog --claims --run) How far authoring may run
                       ahead of the runs. Default 0: rows of a scenario are
                       authored only once every scenario before it has
                       finished running, so flows are always written against
                       the application state their runs will actually see.
                       A number allows that many scenarios ahead; 'all'
                       authors eagerly, as before.
  --max-heal <n>       (crawl) Repair attempts per link before falling back to
                       navigating by URL (default 5). Every attempt is recorded
                       in the report, successful or not.
  --timeout <seconds>  (crawl) Budget per navigation, settle and click
                       (default 30). A slow route is slow, not broken.
  --every <interval>   (watch) How often to re-run: 30s, 15m, 2h (default 15m).
  --notify <cmd>       (watch) Run this command when the result CHANGES —
                       green→red, red→green, or newly flaky — with the verdict
                       as JSON on its stdin. Silence means nothing changed.
  --until-fail         (watch) Stop at the first failure.
  --quarantine-flaky   Report a known-flaky failure without counting it as one.
                       Needs run history; a consistently failing test is never
                       quarantined, and 5 consecutive passes clear it.
  --junit <path>       Also write JUnit XML for CI to ingest (env WOWLIDATOR_JUNIT_PATH).
  --ctrf <path>        Also write CTRF JSON, with wowlidator's own numbers under
                       "extra" (env WOWLIDATOR_CTRF_PATH).
  --probe              Open the page's menus and disclosures first, so controls
                       that exist only after a click are visible when writing
                       the test. Clicks ARIA-marked disclosures only — never a
                       plain button — and closes each one again.
  --scope <s>          unit | e2e                          (default unit)
                       unit: prove one thing on one page. e2e: the whole
                       journey — reach the page as a user does, act, verify on
                       the page that results. e2e is enforced, not requested:
                       it turns --capture-journey on by itself, and an
                       authored flow that never leaves its first page is
                       refused rather than handed back as a unit test.
  --capture-journey    Also read the page the description is ABOUT, not only
                       the one the run starts on. With --repo, the indexed
                       routes are ranked against the request and the best one
                       is opened and captured as a second, separately labelled
                       section. Off by default because it navigates the
                       application. One extra page, one navigation, no clicks;
                       a capture that lands on a sign-in screen signs in once
                       when --as supplied credentials, and is discarded rather
                       than mislabelled when it cannot.
  --context            Include repository context (routes, components, what
                       already covers this page) in the generation prompt.
                       Builds/reuses the graph under --context-out. Off by
                       default — generation behaves exactly as before it.
  --repo <slug|path>   Ground generate, author and catalog in a repository
                       saved with "wowlidator context add" — its code index
                       (routes, endpoints, tables) joins the prompt. An
                       unknown value fails loudly rather than running
                       ungrounded; see the saved ones: wowlidator context list
  --as <email>:<pass>  The account an authored flow signs in as. Without it the
                       model invents a password and the flow cannot sign in;
                       also settable as WOWLIDATOR_AS. The unlabelled default a
                       single-persona row falls back to.
  --persona <LABEL>=<email>:<pass>
                       Credentials for a named persona — the sheet's
                       <HR_ADMIN_ACCOUNT>, <MANAGER_ACCOUNT>, <HRBP_ACCOUNT>,
                       <EMPLOYEE_ACCOUNT> tokens, or SPD_ADMIN for "Login ด้วย SPD
                       Admin". Repeatable; also WOWLIDATOR_PERSONAS as JSON
                       ({"MANAGER_ACCOUNT":{"email":"…","password":"…"}}). A row
                       that hands off between two personas needs both, or it is
                       recorded blocked with the missing label named — never a
                       guessed password. Labels travel in flow files and in the
                       ledger (emails only); passwords stay in env and argv.
  --api                Generate API tests from the indexed OpenAPI spec instead
                       of reading a page. Needs "wowlidator context build --openapi
                       <spec>" first: with no spec there is no endpoint
                       inventory, and wowlidator will refuse rather than invent URLs.
                       <url> is optional in this mode. --policy applies to HTTP
                       verbs: read-only = GET/HEAD, forms = invalid-payload
                       probes, mutations = POST/PUT/PATCH. Never DELETE.

context options:
  Statically indexes the project — package.json, tsconfig, README, React/Next
  routes and components, existing tests — into a graph the generator can read
  from. No model call is made to build it.

  --root <dir>         Project to index                   (default .)
  --openapi <path|url> OpenAPI/Swagger spec to index as well, giving the
                       generator a real endpoint inventory. Omit and a
                       conventionally-named openapi.* / swagger.* file is used
                       if one exists.
  --db-schema <path>   Database schema (schema.sql or schema.prisma) to index
                       as table nodes, giving catalog authoring a declared
                       table inventory for DB checks. Omit and a conventionally
                       named file is used; with WOWLIDATOR_DB_URL set and no
                       file, the live schema is introspected instead.
  --context-out <path> Where the graph is cached   (default ./${DEFAULT_CONTEXT_CACHE_FILE})
  --force              Rebuild even if nothing appears to have changed
  --json               (context show) print the full graph instead of a summary

author options:
  Writes ONE flow from a described test, e.g.
    wowlidator author "check pagination is disabled when there is a single page" \\
      --url http://localhost:3000/en/admin/benefits/rules --run

  --url <url>          Open this page first and hold the model to selectors that
                       really appear in its accessibility tree. STRONGLY
                       RECOMMENDED — without it every selector is a guess and
                       the flow is a starting point, not a test.
  --flow <path>        Where to write the flow
                       (default: <report-dir>/<page>/<name>.flow.json,
                        i.e. beside the report it produces)
  --run                Execute the authored flow immediately
  --policy <p>         Same three tiers as generate (default forms)

data check:
  A sheet names entity CODES (a position, a company); the UI picker shows
  NAMES and may load only the first page of a large master. This rung reads
  the sheet's Test Data pairs, fetches each declared lookup once per distinct
  binding, and prints, per code: rows in the sheet, found, label, the declared
  facts, and reachable (when the declaration gives the picker's page size).
  Then a summary: codes/rows not found, codes/rows unreachable, consumable
  codes two or more rows want, and the lookup URLs used. It informs a person;
  it authors nothing, blocks nothing and changes no data. No model call.

  --master-data <file> The lookup declaration: a JSON array of
                       { field: ["Position", "Position Code"],   Test Data fields it grounds
                         url: "/api/positions?company={Company}&page={page}",
                                                    {Token} bound from the same row's
                                                    Test Data; {page} is 1-based
                         rows: "data.rows",         JSON path to the page's row array
                         next: "data.hasNextPage",  JSON path to a has-more boolean (optional)
                         code: "positionCode",      JSON path in a row to the code
                         label: "name.en",          JSON path to the label (a locale key is fine)
                         facts: ["vacant"],         row paths to report (optional)
                         consumable: "vacant",      the fact one use consumes (optional)
                         uiPageSize: 500 }          rows the UI picker loads (optional)
  --url <app>          The application; lookup paths are resolved against it
  --as / --persona     Sign in on a tab of its own and send the lookups through
                       that browser context, so the application's own cookies
                       are used. Without credentials the lookups go over plain
                       HTTP and Chrome is never touched.
  --json               The same report as one JSON document, for tooling

LLM routing (verify with: wowlidator doctor):
  healer     repairs a dead selector      WOWLIDATOR_HEALER_PROVIDER / WOWLIDATOR_HEALER_MODEL
  generator  writes tests from a page,    WOWLIDATOR_GENERATOR_PROVIDER / WOWLIDATOR_GENERATOR_MODEL
             and rewrites a flow for --repair
  agent      crosses unknown pages        WOWLIDATOR_AGENT_PROVIDER / WOWLIDATOR_AGENT_MODEL
  data       regenerates a fillRetry's    WOWLIDATOR_DATA_PROVIDER / WOWLIDATOR_DATA_MODEL
             "custom" kind (rare)
  keys       GOOGLE_GENERATIVE_AI_API_KEY | GROQ_API_KEY | OPENROUTER_API_KEY

Start a browser first:
  chrome --remote-debugging-port=9222 --user-data-dir=/tmp/wowlidator-chrome-profile
`;
