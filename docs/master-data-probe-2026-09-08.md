# Master-data probe against SIT — 2026-09-08

Handoff step 5 ("finish the lookup declaration") was pointed at the wrong
surface. Every number below came from a live call against `humi-sit-int` as
`automate01`, on the session the browser itself uses.

**What the codes were read from.** The originating sheet
(`HIR-EC-001-r17.csv`) lived in the previous session's scratchpad and is
gone. The Test Data below was reconstructed **verbatim from the authored
flow's own step values**
(`.wowlidator/reports/humi-en-login/e2e-01/hir-ec-001-key-in-60.flow.json`) —
nothing normalised, nothing inferred. So this proves what the *run* asked
for, which is what the failures were about; it is not a re-reading of the
sheet.

## Two master-data surfaces, and the index only sees one

`wowlidator data lookups --repo humi-sit-76b8` finds lookups by path segment
(`LOOKUP_SEGMENTS` in `src/context/lookup-discovery.ts`), so it found the
fourteen `GET /api/ec-api/employment/lookup/*` routes and inferred four. Those
are real, but they serve only the compensation and time steps. The hire
wizard's **organisation and job pickers** read something else entirely — one
endpoint behind a Next.js catch-all the index cannot name
(`src/lib/admin/hire/foundation-api.ts` in the application):

```
GET /humi/api/employee-foundation/foundation?type=<type>&page=<n>&size=<n>&isActive=true
    [&search=][&companyCode=][&employeeGroupCode=][&id=<picklistId>]
→ { code: 'SUCCESS', data: { rows: [...], pagination: { totalItems, hasNextPage, … } } }
```

Probed live: **27 of 29 `type` values answer 200** (`national_id_card_type`
and `job_type` answer `ERR_FOUNDATION_TYPE_NOT_FOUND`), and every
`picking_lists` id answers. Rows are uniform — `<thing>Code` / `<thing>Name`
as a locale map (`en_GB`, `th_TH`) plus `isActive`; picklists are
`picklistCode` / `label`.

The `/lookup/*` routes that `data lookups` could not infer answer once they
carry the scope the app itself sends: `banks?countryCode=THA` → 7 rows,
`payment-methods?countryCode=THA` → 3, `time-status-master` → 8. That is what
the `400 … is required` replies were saying.

The declaration built from both surfaces is committed at
`docs/artifacts/humi-sit-hire.lookups.json` (16 lookups; `{Company}` and
`{Employee Group}` bound from Test Data), copied to
`.wowlidator/master-data/` as the working file.

## The finding that overturns the handoff

Handoff problem 2 said three codes "are not in SIT". **All three exist in SIT
and are active**, and they appear verbatim in the flow, so there is no
transcription doubt about them:

| Field | Value as the run used it | In master | Picker holds | Verdict |
|---|---|---|---|---|
| Company | `C001` | yes — CDS | 143 of 143 | reachable |
| **Cost Center** | `C00132653` | **yes — "32653", active** | 425 of 425 (scoped by company) | **reachable** |
| **Work Location** | `50000127` | **yes — Chidlom Tower, active** | 1,000 of 2,256 | unreachable *(see below — derived, not picked)* |
| **Holiday Calendar** | `01` | **yes — HO Calendar, active** | 7 of 7 | **reachable** |
| Employee Sub-Group | `10` | yes | 48 of 48 | reachable |
| Position | `Studio Traffic Staff & Admin` | exists as a *name*, active | 500 of 5,364 | not found as a code; unreachable as a name |
| Employee Group | `A - Permanent` | not as a code (`A` = Permanent) | 8 of 8 | not found |
| Pay Group, Bank, Payment Method, Pay Component, Organization | `เลือกจากรายการ` | — | 238 / 7 / 3 / 8 / — | the cell holds an instruction, not a value |

Cost Center reads as missing only when the master is fetched **unscoped**:
11,818 rows, and `C00132653` sits past row 1,000. The wizard scopes it by
`companyCode`, which cuts it to 425 — the code is row 232. Holiday Calendar
`01` is row 1 of 7.

## Why anything is unreachable at all

`HumiSearchableSelect` filters **client-side** over the options already in
memory (`options.filter(o => o.label.toLowerCase().includes(q))`,
`src/components/admin/HumiSearchableSelect.tsx`). The wizard loads one page
and never sends the typed text back, although the endpoint supports `search=`
and answers it correctly — `search=Bangkok` returns 14 work locations, of
which the picker's own 1,000 rows hold 3.

So the rule is uniform: **a row past the page the picker loaded cannot be
picked, whatever is typed.**

**Position is the one blocker.** 500 loaded of 5,364
(`fetchPositions(…, { size: 500 })`, scoped to `companyCode=C001`). This is
the same picker `src/context/master-data.ts` documents from 2026-09-05 — "a
picker loaded 500 of 5,364 rows and searched by name". No value of the cell
fixes it; it is a product defect in the picker's paging.

**Work Location is a consequence, not a second blocker.** Selecting a
Position auto-fills it — `StepJob.tsx:337`,
`setWorkLocation(posData.workLocationCode || posData.storeBranchLocationCode || '')`
— so the value arrives without the picker. But `displayText` resolves the
selected value *through the loaded options*
(`optionsByValue.find(o => o.value === value)`), so a derived code outside the
loaded 1,000 leaves the control showing its placeholder while `value` is set:
it reads as empty and validates as filled. Worth reporting alongside Position,
as a display fault rather than a blocker.

## What this changes about the handoff

- **Problem 2 is withdrawn.** The three disputed codes are fine. What is left
  of it is the four `เลือกจากรายการ` cells — genuinely unfilled, still a BA
  question, and now with the option lists to fill them from (Pay Group 238,
  Bank 7, Payment Method 3, Pay Component 8).
- **Defect 1 gets its mechanism.** "Position renders No options found" and
  "the position cannot be selected" are one fault: the picker holds 500 of
  5,364. File it against the picker's paging, not against page-2 rendering.
- **A vocabulary question joins the two already open with the BA.** Two cells
  carry a display label where the field's code belongs — `Position = Studio
  Traffic Staff & Admin` against `positionCode` (e.g. `40000012`), and
  `Employee Group = A - Permanent` against `employeeGroupCode` (`A`). Whether
  the sheet should name codes or labels is a decision, not a bug.
- **The Time Management Status question has data now.** `time-status-master`
  returns `timeStatusCode: "1"`, `timeStatusName: "Clocking"` — so Expected
  12.1's `01 - Clocking` matches neither the code (`1`) nor the name as
  written.

## Reproducing

```bash
npm run cli -- data check <catalog.csv> \
  --master-data docs/artifacts/humi-sit-hire.lookups.json \
  --url https://humi-sit-int.central.co.th/humi/en/login \
  --as <user>:<pass>
```

About twenty seconds, one sign-in, no browser automation beyond it, exit 0
always. `data lookups --repo humi-sit-76b8` is *not* the way in for the
organisation and job pickers — those live on the foundation endpoint, which
the repository index cannot reach.

## Unverified, deliberately left in

`Department` (`type=departments`, 22,098 rows) is declared but was never
exercised: the cell it would ground was empty. The wizard's own `Organization`
control is a read-only textbox filled from the chosen Position, so the
mapping is a guess until a sheet names a department.
