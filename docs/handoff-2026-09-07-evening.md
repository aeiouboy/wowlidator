# Handoff — EC catalog, 2026-09-07 evening

Written from state checked in-session, not memory. Everything below was read
from git, the ledger, or a live process at ~17:30 local.

**Worktree note:** sparse-checkout is on, cone = `reports src tests`. `docs/`,
`bin/` and `examples/` are tracked but absent on disk and `git status` says
nothing about it. To add a file under `docs/`: `mkdir -p docs`, write it, then
`git add --sparse <path>`. Plain `git add` is refused.

## สถานะปัจจุบัน

- Branch `phase-abc-action-authority`, head **`57e0722`**, matches
  `mine/master` (`github.com/aeiouboy/wowlidator`). **0 unpushed commits.**
- No uncommitted changes under `src/`, `tests/`, `CLAUDE.md` or `docs/`.
  Untracked noise only: `.env.backup-before-opus-ec`, `.omo/`,
  `.playwright-cli/`, `output/`, and run artifacts under `reports/`.
- Deterministic test tier at head: **2259 pass / 1 fail**. The single failure is
  the known pre-existing `tests/value-resolution.test.ts` → "the date grammar
  the second pass needed". Nothing else may be red.
- `npm run typecheck` and `npx tsc -p tsconfig.test.json --noEmit` both clean.
- Disk: **12 GB free**. It was 17 GB this morning; each run adds ~300–500 MB of
  media. It filled completely on 2026-09-06 and killed a scheduled job.

### Ledger — `.wowlidator/reports/catalogs/qa-task-tracking-cycle1-sit-optimized-ec-csv.claims.progress.json`

309 planned cases:

| verdict | count |
|---|---|
| passed | 4 |
| failed | 44 |
| review (proved-?) | 2 |
| blocked — no verdict | 259 |

**48 of 309 cases have a verdict (16%).** A pass rate must always be quoted
against that 48, never against 309, and always with the coverage figure beside
it — the report now enforces this.

## งานที่เสร็จใน session นี้

All merged and pushed, each commit carrying the measurement that motivated it:

- **`5050ec8`** — every finding carries an `owner` (`application` / `harness` /
  `catalog`); Markdown and workbook group by it, application team first; the
  export leads with `blockedChains` naming each dependency root and how many
  wait on it. Motivated by 66 findings covering 276 non-passing cases, of which
  35 were ours.
- **`7b202aa`** — the catalog report could not be built at all: one JS string,
  V8 caps at ~512 MB, the report reached 535 MB (709 MB of it recordings).
  Screenshots and recordings now spill to the `-media` folder through two
  optional sinks; a small run is still one self-contained file.
- **`be285d6`** — `--case-timeout` / `WOWLIDATOR_CASE_TIMEOUT_MS` (default 20
  min, `off`/`0` disables), a fatal authoring lint that an absolute URL must
  share the run's deployment host, and a per-role provider-failure tally.
  Motivated by 133 cases over an hour each, worst 13h15m at `coverage 0/109`.
- **`dc0133f`** — `CLAUDE.md` gained a "Testing a real application from the CLI"
  section: `CATALOG`/`APP_URL` variables, no machine paths, and the four rules
  the run paid for.
- **`08d79e8`** — the run workbook covers **every** case, not only passed ones.
  `<base>-cases.xlsx`, ordered failed → review → blocked → never-ran → passed,
  a `Verdict` column, per-case workbooks and recordings kept for every case.
  Measured: 4,344 rows, 698 images, 0 omitted.
- **`692d3f2`** — the report leads with three counts (passed / failed / no
  verdict) plus a pass rate over decided cases **and** a mandatory coverage
  line, because either number alone misleads in opposite directions.
- **`57e0722`** — every case shows the sheet's `Scenario ID` (`E2E-55`) beside
  our `Test Case ID`: `ID · SCENARIO` in HTML, a first `Scenario ID` column in
  the workbook, `ID (SCENARIO)` in findings. Measured: 273 of 309 carry one.
- **`48c5894` / `66773cd`** — the morning handoff, then its commands rewritten
  to use variables instead of this machine's absolute paths.

### Non-code work done in-session

- **SIT consent state was reset for two accounts.** `20500960` (Suphaphon
  Thongdee) and `20500961` (Sasithorn Meesap), both company C015, each held two
  `ACCEPT` rows in `consent.employee_consents`. All four rows deleted inside a
  transaction; the table went 86 → 82 and the other 37 employees were untouched.
  **Restorable** from
  `.wowlidator/consent-backup-20500960-20500961-20260907T162404.sql` (four
  `INSERT` statements preserving ids and timestamps).
  This confirmed the diagnosis: the consent cases were failing because those
  accounts had already accepted, not because of an application defect. After the
  reset the gate appears — `/humi/th/consent` shows in the log and the
  assertions that wanted it now pass.

## ค้างอยู่ / ยังไม่ commit

**Nothing is uncommitted.** `git status --short -- src tests CLAUDE.md docs` is
empty. The only work in flight is a running process, below.

## Services / processes ที่รันอยู่

| what | state | how to stop |
|---|---|---|
| `catalog --category Consent` re-run | running; all 29 cases sealed, doing a solo re-run tail | `pkill -f "src/cli.ts catalog"` |
| Chrome pool (4) on ports 9333–9336 | up | `pkill -f "remote-debugging-port=93"` |
| `rebuild.sh` (armed) | waits for the catalog run to exit, then rebuilds the full 309-case report | `pkill -f rebuild.sh` |

The rebuild writes `.wowlidator/reports/catalogs/full-report-rebuild.log`. It
exists because the consent-only run **overwrote the full report with a 30-case
one** — the ledger still holds all 309, so the rebuild restores the full set.

## Next steps, in the order I would do them

1. **Rebuild the full report** (the armed script does it; if it did not fire):
   ```
   npm run cli -- report .wowlidator/reports/catalogs/qa-task-tracking-cycle1-sit-optimized-ec-csv.claims.progress.json
   ```
   Note the argument — bare `report` looks in `.wowlidator/catalogs/`, which is
   not where this ledger lives.

2. **Fix the anti-wander rule — the single highest-value change.** Four of the
   twelve dependency roots die the same way, and it is the biggest blocker in
   the catalog:
   ```
   agent wandered: left the step's page …/humi/th/home
   now at …/humi/th/admin/hire?step=2
   ```
   The agent had reached the **correct** page (`/admin/hire`, the New Hire
   form), and the rule still ended the leg because it left the URL the step
   started on. A multi-step form necessarily changes page. Start at the
   wander/progress judges in `src/orchestrator/` (see `src/orchestrator/CLAUDE.md`
   for the stall/progress rules) and at `HIR-EC-080#r1`'s proof:
   `.wowlidator/proofs/e8bc71ad-e653-4be8-84bf-7df86e652d2a.json`.

3. **Then fix the roots, by how many cases each frees:**

   | root | cases waiting | why it is stuck |
   |---|---|---|
   | `HIR-EC-001` | **21** | agent judged wandered at `/admin/hire?step=2` |
   | `HIR-EC-127#r1` | 5 | country dropdown not found |
   | `HIR-EC-119#r1` | 5 | page stays on a loading state |
   | `HIR-EC-023` | 4 | signed-in user's name not found on screen |

   `HIR-EC-001` alone frees 21. Fixing step 2 probably fixes it and several
   others at once.

4. **Prepare consent test data properly.** `CNS-EC-005` needs one employee
   inside company **C001** and one outside (control **C005**), *both* never
   having consented. The two accounts reset today are **C015**, so that case
   still cannot pass. Find candidates with:
   ```sql
   -- from ~/Projects/cnext-azure/k8s-config/sit/config/consent/.env
   SELECT p.employee_code FROM employee_center.view_employee_profiles p
   LEFT JOIN consent.employee_consents c ON c.employee_id = p.employee_code
   WHERE p.company_code = 'C001' AND c.id IS NULL LIMIT 5;
   ```

5. **Investigate the Chrome-pool death** from the 2026-09-07 morning run
   (`ec-full-run-luna-resume9.log`, first death line 7003, first
   `ECONNREFUSED` line 13889, 67 cases lost). It did **not** recur in the
   afternoon runs, so it may be environmental — but it has no explanation yet.

## Gotchas — things that will cost the next person time

- **`--rerun-errors` resets verdicts before it re-runs them.** Passing it on a
  run that then stops short leaves the ledger *poorer*: it cost 55 sealed
  `failed` verdicts today. Only pass it when the run will finish.
- **A category-scoped run overwrites the whole report.** `--category Consent`
  rewrote the 309-case HTML/Excel with a 30-case one. Harmless — the ledger is
  the source of truth — but rebuild afterwards.
- **A long-lived run keeps the code it started with.** A reporter fix merged
  mid-run does not reach that run; its live rewrites keep failing the old way
  until the next `report`.
- **`codex exec` costs ~13–15 s per call regardless of prompt size** — measured
  with a three-word prompt. The agent makes ~22 calls per case, so ~5 minutes
  per case is process startup, not thinking. An HTTP provider (Groq, Cerebras)
  would be ~8× faster, but **no API keys are set** in `.env`.
- **`codex exec resume` does not inherit `-m`.** Pass the model explicitly or it
  falls back to an id this CLI version rejects.
- **Test Case ID and Scenario ID are different numbering systems.** Only 99 of
  272 rows share a trailing number; `E2E-101` is `HIR-EC-100`. Never map them by
  arithmetic. Scenario IDs are also not unique — `E2E-236` covers both
  `PRB-EC-082` and `PRB-EC-085`.
- **Nothing in the consent DB maps a login name to an employee id.**
  `authentication.users` and the username column in `employee_center` are both
  empty — auth is external. Identify an account by name through
  `employee_center.view_employee_profiles` (its name columns are `jsonb`, so
  cast: `last_name::text ilike '%X%'` or `last_name->>'en_GB'`).
- **`kubectl` against `cg-aks-nonprd` is Forbidden** for this account — every
  namespace. Do not go through k8s for SIT config; it is already on disk at
  `~/Projects/cnext-azure/k8s-config/sit/config/<service>/.env`.
- **"no verdict" ≠ "the app is fine" and ≠ "the app is broken."** It means the
  question was never answered. 280 of 309 cases did open a browser and run; only
  48 reached a point where a verdict was possible.

## Key files / docs

- `docs/handoff-2026-09-07.md` — this morning's handoff (run history, provider
  comparison, the resume command).
- `CLAUDE.md` § "Testing a real application from the CLI" — the resume recipe
  and the four rules.
- `src/reporter/CLAUDE.md` — findings owner rule, blocked chains, the headline
  band and why the coverage line is mandatory, media spill, Scenario ID.
- `src/orchestrator/CLAUDE.md` — the agent loop, stall and progress judges
  (where step 2 above lives).
- `reports/qa-task-tracking-cycle1-sit-optimized-ec-csv-202-findings.md` — the
  root causes, split by owner, with the blocked chains on top.
- `.wowlidator/consent-backup-20500960-20500961-20260907T162404.sql` — the
  consent rows deleted today.
