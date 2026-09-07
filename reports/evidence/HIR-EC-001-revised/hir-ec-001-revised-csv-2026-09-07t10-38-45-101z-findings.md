# Findings — wowlidator catalog — HIR-EC-001-revised.csv

hir-ec-001-revised-csv@2026-09-07T10:38:45.101Z · authored 2026-09-07T10:38:45.101Z · 1 case(s)

> Suggested severity is a stated rule, not a judgement: HIGH when a finding covers 3 or more cases or blocks a dependency chain (a case listed under it because it depends on a member); MEDIUM for 1–2 cases; LOW when every member is harness-only (a system error, a hold by the harness, or an authoring refusal — none of which is a verdict about the application). Statuses are shown exactly as the run sealed them.

> Finding owner is a stated rule over typed fields only: HARNESS when finding.kind is hold or agent, or, for a non-authoring finding, every member is harness-only; CATALOG when finding.kind is authoring; APPLICATION for everything else (api, url, control, other).

**1 finding account for 1 of 1 non-passing case · 0 unclustered** · never ran: 0

## Blocked chains

Fixing a root unblocks everything waiting under it.

No case is waiting on another.

## For the application team (0 findings, 0 cases)

none

## For the test harness (1 finding, 1 case)

### 1. heading[role="heading"] could not be found at /humi/en/admin/hire

- suggested severity: **low**
- kind: control · key: `control:heading[role="heading"] @ /humi/en/admin/hire`
- cases (1): HIR-EC-001 (E2E-01) (error)
- status as sealed: error: 1
- where: /humi/en/admin/hire
- asked: heading[role="heading"]
- evidence:
  - step: #5 expectText
  - selector: heading[role="heading"]
  - url: https://humi-sit-int.central.co.th/humi/en/admin/hire

Steps to reproduce (from HIR-EC-001):

1. setClock — Pin the page clock consistently with Hire Date = 01 Sep 2027. [time="2027-09-01"]
2. goto [url="https://humi-sit-int.central.co.th/humi/en/login"]
3. signIn — Step 1: sign in with the supplied HR_ADMIN_ACCOUNT persona. · persona HR_ADMIN_ACCOUNT [urlBefore="https://humi-sit-int.central.co.th/humi/en/login", browser="http://127.0.0.1:9444", signInUrl="https://humi-sit-int.central.co.th/humi/en/login", urlAfter="https://humi-sit-int.central.co.th/humi/en/home"]
4. goto [url="https://humi-sit-int.central.co.th/humi/en/login"]
5. goto [url="https://humi-sit-int.central.co.th/humi/en/admin/hire"]
6. expectText — Confirm the signed-in hiring page is open. · heading[role="heading"] [foundInPageText="true"]

## For the test catalog (0 findings, 0 cases)

none
