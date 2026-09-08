# Master-data probe against SIT — 2026-09-08

Handoff step 5 ("finish the lookup declaration") turned out to be pointed at
the wrong surface. Every number below came from a live call against
`humi-sit-int` as `automate01`, on the session the browser itself uses.

## What the probe was pointed at, and what it should have been

`wowlidator data lookups --repo humi-sit-76b8` finds lookups by path segment
(`LOOKUP_SEGMENTS` in `src/context/lookup-discovery.ts`), so it found the
fourteen `GET /api/ec-api/employment/lookup/*` routes and inferred four. Those
are **not the endpoints the hire wizard's pickers use.**

The wizard's whole master-data surface is one endpoint behind a catch-all
proxy the index cannot name — `src/lib/admin/hire/foundation-api.ts` in the
application:

```
GET /humi/api/employee-foundation/foundation?type=<type>&page=<n>&size=<n>&isActive=true
    [&search=][&companyCode=][&employeeGroupCode=][&id=<picklistId>]
→ { code: 'SUCCESS', data: { rows: [...], pagination: { totalItems, hasNextPage, … } } }
```

Probed live: **27 of 29 `type` values answer 200** (`national_id_card_type`
and `job_type` answer `ERR_FOUNDATION_TYPE_NOT_FOUND`), and every
`picking_lists` id answers. Row shapes are uniform — `<thing>Code` /
`<thing>Name` as a locale map (`en_GB`, `th_TH`), plus `isActive`; picklists
are `picklistCode` / `label`.

The declaration built from that is committed at
`docs/artifacts/humi-sit-hire.lookups.json` — copied to
`.wowlidator/master-data/` as the working file (14 lookups, parses
clean, `{Company}` and `{Employee Group}` bound from Test Data).

## The finding that overturns the handoff

Handoff problem 2 said three codes "are not in SIT". **Every code the sheet
names exists in SIT and is active.** `wowlidator data check` on HIR-EC-001's
Test Data:

| Field | Code | In master | Picker loads | Verdict |
|---|---|---|---|---|
| Company | `C001` | yes — CDS | 143 of 143 | reachable |
| Position | `Studio Traffic Staff & Admin` | yes, active | 500 of 5,364 | **unreachable** — and it is a *name*, not a `positionCode` |
| Cost Center | `C00132653` | yes — "32653" | 425 of 425 (scoped by company) | reachable |
| Work Location | `50000127` | yes — Chidlom Tower | 1,000 of 2,256 | **unreachable** |
| Employee Group | `A` | yes — Permanent | 8 of 8 | reachable |
| Employee Sub-Group | `10` | yes | 48 of 48 | reachable |
| Holiday Calendar | `01` | yes — HO Calendar | 7 of 7 | reachable |
| Pay Group / Bank / Payment Method / Pay Component / Organization | `เลือกจากรายการ` | — | — | the sheet holds an instruction, not a value |

Cost Center reads as missing only when the master is fetched **unscoped**:
11,818 rows, and `C00132653` sits past row 1,000. The wizard scopes it by
`companyCode`, which cuts it to 425. Holiday Calendar `01` is row 1 of 7.

## Why the two unreachable ones are unreachable

`HumiSearchableSelect` filters **client-side** over the options already in
memory (`options.filter(o => o.label.toLowerCase().includes(q))`,
`src/components/admin/HumiSearchableSelect.tsx`). The wizard loads one page
and never passes the typed text back to the server, although the endpoint
supports `search=` and answers it correctly — `search=Bangkok` returns 14
work locations, of which the picker's own 1,000 rows hold 3.

So the rule is uniform: **a code past the page the picker loaded cannot be
picked, no matter what is typed.** Two fields cross that line —

- **Position** — 500 loaded of 5,364 (`fetchPositions(…, { size: 500 })`).
  This is the same picker `src/context/master-data.ts` documents from
  2026-09-05: "a picker loaded 500 of 5,364 rows and searched by name".
- **Work Location** — 1,000 loaded of 2,256, and the fetch carries no
  company scope at all (`fetchWorkLocations()` in `StepJob.tsx`).

That is a product defect, not test data: it is unfixable from the sheet,
because no value of the cell makes an unloaded row appear.

## What this changes about the handoff

- **Problem 2 is withdrawn.** Nothing is wrong with the sheet's three codes.
  What is left of it is the four `เลือกจากรายการ` cells — genuinely
  unfilled, still a BA question.
- **Defect 1 gets a mechanism.** "Position renders No options found" and
  "the position cannot be selected" are the same fault seen twice: the
  picker holds 500 of 5,364. File it against the picker's paging, not
  against page-2 rendering.
- **A third BA question joins the two already open.** The sheet writes
  `Position = Studio Traffic Staff & Admin`, a display name; the field's
  code is `positionCode` (e.g. `40000012`). `data check` reports it as not
  found for that reason alone.

## Reproducing

```bash
npm run cli -- data check <catalog.csv> \
  --master-data .wowlidator/master-data/humi-sit-hire.lookups.json \
  --url https://humi-sit-int.central.co.th/humi/en/login \
  --as <user>:<pass>
```

Twenty seconds, no browser automation beyond one sign-in, exit 0 always.
`data lookups --repo humi-sit-76b8` is *not* the way in for this application
— its `/api/ec-api/employment/lookup/*` routes are a different surface from
the one the hire wizard reads.
