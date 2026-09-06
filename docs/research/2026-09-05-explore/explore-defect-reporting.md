# explore-defect-reporting — จาก 70 verdict เป็น 5 finding

อ่านแล้ว: `CLAUDE.md`, `src/reporter/CLAUDE.md`, `src/history/CLAUDE.md`, `src/orchestrator/CLAUDE.md`, `src/engine/proof-bundle.ts`, ledger ของ run วันนี้, proof bundle 11 ใบ, `ec-full-run-opus.log`, `history.jsonl`. ไม่ได้แก้ไฟล์ใด ๆ ใน repo

## 1. สรุปสั้น

- วันนี้ report บอก "ทุก case แยกกัน" เพราะ **ไม่มีที่ไหนในโค้ดมองข้าม case** เลย `addDefect` cluster แค่ภายใน bundle เดียว (`src/engine/proof-bundle.ts:1500` ราว ๆ นั้น, เงื่อนไข title+selector+category+severity) และ catalog report จัดกลุ่มตาม scenario เท่านั้น (`src/reporter/catalog-report.ts:575-600`)
- หลักฐานที่ต้องใช้ทำ signature **มีอยู่ครึ่งเดียว** ที่เป็น typed field แล้ว (API 404, redirect, blocked) อีกครึ่ง (agent บอกว่าไปไม่ถึง, picker ไม่มีตัวเลือก) **อยู่ในสตริง `error`/`summary` เท่านั้น** ต้องเพิ่ม field ที่ seal ก่อน reporter จึงจะ cluster ได้โดยไม่ parse ข้อความ
- โค้ดมี **ตัวจำแนก environment/defect/catalog อยู่แล้ว แต่เป็น model call** (`src/generator/error-diagnosis.ts`) และวันนี้มันตอบ **ไม่ตรงกันในคลัสเตอร์เดียว** (Position picker: HIR-EC-006 → `agent 70%`, c9/c18 ใน log → `test-catalog 63–78%`) นี่คือเหตุผลที่ clustering ต้อง deterministic และความเห็นของ model ต้องแสดงเป็น "ความเห็น" เท่านั้น
- ข้อเสนอที่คุ้มสุด: (1) projection `findings` ใน reporter จาก typed field ที่มี, (2) typed `endedBy` + ข้อมูล listbox บน `AgentAction`, (3) พับ noise ใน catalog report (มี bug จัดกลุ่ม scenario ด้วย: 269 case อยู่ใน "ungrouped")

## 2. ข้อเท็จจริงจาก run วันนี้ (ledger + bundles)

Ledger: `.wowlidator/reports/catalogs/qa-task-tracking-cycle1-sit-optimized-ec-csv.claims.progress.json`

| สถานะใน ledger | จำนวน (จาก 57 outcome, planned 309) |
|---|---|
| `null` (authoring refused / depends-on / exclusivity unproved) | 20 |
| `error` | 24 |
| `failed` | 6 |
| `passed` | 3 |
| `dead-end` | 2 |
| `passed-with-issues` | 1 |
| `needs-review` | 1 |

Tally บนหัว HTML report วันนี้: `never ran: 252 · system error: 23 · blocked: 21 · test failed: 6 · recorded only: 1 · test failed (dead-end): 2 · passed: 3 · pass**: 1` และ scenario header อ่านว่า `ungrouped | 4 of 269 passed · 8 failed · 14 no verdict · 243 never ran`

คลัสเตอร์ที่หัวหน้าทีมระบุ ตรวจกับ bundle แล้ว หลักฐานอยู่ที่ field ไหน:

| คลัสเตอร์ | case | field ที่มี "ข้อเท็จจริง" วันนี้ | typed พอไหม |
|---|---|---|---|
| consent API ตอบ 404 | CNS-EC-029, -021, -022, -023, -016, -031 (บางส่วน), HIR-EC-073 | `ProofStep.request.{method,url,status}` บน step `request` (เช่น CNS-EC-029 step 5: `GET https://humi-sit-int.central.co.th/api/consent-api/status → 404`) และ `detail.expected=[200] / detail.actual="404 Not Found"` บน `expectStatus` step 6 | **พอ** แต่ `expectJson`/`expectStatus` ไม่ชี้กลับไปที่ request step ต้องเดินถอยหาอันล่าสุด |
| เมนู EC > Consent > ทะเบียนเอกสารฝั่งผู้ดูแล ไม่มี | CNS-EC-004, -031, -021 (step 13), -013 | `AgentRecord.summary` = `agent reported the goal is unreachable: …` (สตริง), `actions[last].action==='fail'` + `reasoning`, `detail.urlAfter`, `detail.headingsAfter` | **ไม่พอ** เหตุจบ leg ไม่เป็น typed |
| /humi/th/consent redirect กลับ home | CNS-EC-007, -014, -020, -031 (step 17) | `expectUrl` มี `detail.expected` / `detail.actual` (`expected url to contain "/consent", got ".../humi/th/home"`) | **พอ** |
| Position picker หาตำแหน่งตามรหัสไม่ได้ | HIR-EC-006, -010, -011 (HIR-EC-048 **ไม่ใช่** ดูข้อ 5) | `AgentAction.error` สตริงเดียว: `opened "เลือกตำแหน่ง (Select Position)" but no option named "40106337" appeared (…; 500 shown: "Building Pallet Staff", …)`; และ `step.network` มี `GET …/foundation?type=positions&page=1&size=500&isActive=true&companyCode=C001 200` | **ไม่พอ** `ListboxOptionMissingError.shown/filtered/searchedEmpty` (`src/engine/listbox.ts:77-100`) หายไปตอน `describe(caught)` (`src/orchestrator/workflow-agent.ts:1885`) |
| Company filter ไม่มี C005 | CNS-EC-011 | เหมือน picker: สตริง `opened "ทุกบริษัท" but no option named "C005"` | **ไม่พอ** (คลาสเดียวกับ picker แต่ต้องเป็นคนละ finding) |

ข้อสังเกตเพิ่มที่หัวหน้าทีมยังไม่ได้พูดถึง:

- ทุก bundle ที่มี `network` แนบ มี `GET /humi/api/content-management/{language,quick-action/visible,menu-item/visible,news-update} → 500` บนทุกหน้า นี่คือ finding ระดับ environment ที่ไม่มีใครเห็น เพราะ `network` แนบเฉพาะ step ที่พัง (`ProofStep.network` doc ใน `proof-bundle.ts:690-700`)
- HIR-EC-008 ทุก route 404 จาก gateway `stgw` เพราะ base URL ไม่มี `/humi` เป็น harness config ไม่ใช่ app (diagnosis ตอบ `environment 70%` ถูก) signature ตาม path จะไม่รวมกับ consent 404 ถ้าเก็บ host+path เต็ม
- `scenarioFromId` (`src/cli/catalog-live-report.ts:41-43`) ใช้ regex `^([A-Za-z]+_\d+)` ซึ่งไม่ match `HIR-EC-006` และ `cmdCatalogReport` (`src/cli/commands/maintenance.ts:396`) ไม่ส่ง `scenarioOf` เลย → 269 case ตกไป `ungrouped` ทั้งที่ `bundle.generatedBy.scenario` = `E2E-06` มีอยู่ (`proof-bundle.ts:1083`)

## 3. สิ่งที่โค้ดมีอยู่แล้ว (ไม่เสนอซ้ำ)

- **การแยก harness / app / hold ระดับ status**: `classifyStepFailure` (`src/engine/runner.ts` ~8440-8500) จำแนก `failed | dead-end | error` ต่อ step ด้วยชื่อ error class; `harnessOnly` (`src/cli/exit.ts:184-207`) ให้ case ที่พังเฉพาะ `error` เป็น `blocked` และอ่าน `ProofStep.blocked` (typed) ก่อนข้อความ; `verdictFamily` (`proof-bundle.ts:115-122`) พับเป็น `test-failed | system-error | review`
- **Typed hold**: `BlockedOutcome{reason, rule, category, target, provenance}` (`proof-bundle.ts:449-466`) บน `AgentAction.outcome`, `AgentRecord.blocked`, `ProofStep.blocked`; report แสดง "Held by the run's rules" (`src/reporter/html-reporter.ts:864-880`), Excel `stepProof` แสดง `held (…)` (`src/reporter/excel-export.ts:228-232`)
- **Defect clustering ภายใน case**: `addDefect` รวม title+selector+category+severity เป็น `occurrences/stepIndexes`
- **`downstream`**: step ที่พังหลังการพังครั้งแรกถูก stamp (`proof-bundle.ts:756-760`) แต่ `Defect` ไม่มี field นี้ → HIR-EC-006 มี 8 defect ซึ่ง 7 เป็น cascade
- **Trend ต่อ case**: `analyseTrend` (`src/history/run-history.ts:172-291`) ให้ `still-broken/newly-broken/…` และ `newFailures` จาก `failureSignatures` = `action:selector` (`run-history.ts:66-71`) — สำหรับ agent leg ทุกอันคือ `workflow:-` จึงแยก "พังเรื่องเดิม" กับ "พังเรื่องใหม่" ไม่ได้
- **Diagnosis (model call)**: `diagnoseError` ทำงานเฉพาะ `status==='error'` (`src/cli/run-cases.ts:1133`), เขียน `bundle.diagnosis{origin∈test-catalog|generator|agent|environment|application, confidence, fix}` (`proof-bundle.ts:1099-1116`) และ push บรรทัดลง `bundle.notes` — case `failed` (เช่น CNS-EC-029) **ไม่มี** diagnosis
- **Dead-end risk ก่อนรัน**: `bundle.risk.missing[]` ระบุสิ่งที่ไม่มีหลักฐานว่ามี เช่น HIR-EC-006: `"Any document or fixture confirming … Position 40106337 … in the SIT environment"` — เป็น pre-run claim ไม่ใช่ evidence
- **Agent จบ leg ด้วยเหตุผลหลายแบบแต่จบเป็นสตริง `summary` อย่างเดียว**: `gave up after N turns` (`workflow-agent.ts:1587`), value-hunt (`:1651`), `unreachable` (`:1826`), arrived (`:2016`), cannot-offer (`:2019-2028`), blocked (`:2035`) — มีแค่ `blocked` และ `lookedOnly` ที่เป็น typed
- **Noise ที่พับแล้วบางส่วน**: `countVerdicts/describeVerdictCounts` (`src/reporter/step-facts.ts:559-586`) แยก no-verdict ออกจาก failed ในหัว scenario; `AUTHORING_REFUSAL_CAP=2` (`src/cli/suite-progress.ts:89`)

## 4. ข้อเสนอ (เรียงตามความคุ้ม)

### P1 — `findings` projection ใน reporter: 1 finding ต่อ signature, หัว report นำด้วย "N findings affecting M cases"  (effort M)

**ทำอะไร**: ไฟล์ใหม่ `src/reporter/findings.ts` ฟังก์ชัน pure `buildFindings(cases: CatalogReportCase[]): Finding[]`; เรียกจาก `renderCatalogReport` (`catalog-report.ts:573`) ก่อน `sections` และวางบล็อกไว้ใต้ `tally`. `CatalogReportCase.bundle` มีอยู่แล้ว จึงไม่ต้องแตะ ledger

**Signature (deterministic, จาก typed field เท่านั้น, อ่านเฉพาะ step แรกที่พังและ `!superseded && !downstream`)**:

| กรณี | key | อ่านจาก |
|---|---|---|
| API ตอบไม่ตรง | `api:${method} ${pathname(url)} → ${status}` | step `request` ล่าสุดก่อน `expectStatus/expectJson` ที่พัง (`step.request`) + `detail.expected` |
| หน้าเปลี่ยนที่ไม่ขอ | `url:${expected} → ${pathname(actual)}` | `expectUrl` `detail.expected/actual` |
| control ไม่มีบนหน้า | `control:${selector} @ ${pathname(step.url)}` | `dead-end` step + `pageContext[0]` |
| hold | `hold:${blocked.reason}/${blocked.rule}` | `ProofStep.blocked` |
| agent (หลัง P2) | `agent:${endedBy}:${listbox?.trigger ?? goalDestination(goal)} @ ${pathname(urlAfter)}` | field ใหม่จาก P2 |
| authoring refused (หลัง P6) | `author:${lint}` | ledger field ใหม่ |

จนกว่า P2 จะมา case ที่จบด้วย `workflow` error จะได้ key หยาบ `agent:workflow @ ${pathname(url)}` เท่านั้น **ห้าม regex `summary`** เพราะข้อความเป็นภาษาไทย/อังกฤษสลับกัน (CNS-EC-004 ไทย, CNS-EC-031 อังกฤษ เรื่องเดียวกัน)

**Reader เห็นอะไร** (mock บล็อก Position picker, ทุกบรรทัดชี้ field):

```
FINDINGS — 5 findings account for 22 of 25 non-passing cases · 3 cases unclustered

▸ [F3] Position picker offers 500 title-only options; code 40106337 is not among them
      cases: HIR-EC-006, HIR-EC-010, HIR-EC-011 (3)         ← cluster members
      status as sealed: error ×3 (system error)              ← LedgerOutcome.status, never relabelled
      where: /humi/th/admin/hire?step=2                       ← AgentAction.url of the failing action
      control: button "ตำแหน่ง" → dialog "เลือกตำแหน่ง (Select Position)"   ← AgentAction.listbox.trigger (P2)
      asked for: "40106337"  · offered: 500 option(s), first: "Building Pallet Staff", …  ← listbox.value / shownCount / shown[0..3]
      page's own request: GET /humi/api/employee-foundation/foundation?type=positions&page=1&size=500&isActive=true&companyCode=C001 → 200   ← step.network
      also tried: type องค์กร="30042174" then re-open (HIR-EC-006 a17→a18; HIR-EC-010 a15→a16)   ← actions[i].action/value ok=true then same listbox miss
      trend: present in every run since 2026-09-04 19:14 (3 runs)   ← P5
      model's opinion (not the finding): error-diagnosis said agent 70% (HIR-EC-006), test-catalog 63% (c9 log) — disagree   ← bundle.diagnosis, labelled
      evidence: [screenshot HIR-EC-006 step 4] [video 03:12] [Excel row]
      severity (suggested): high — 151 sheet rows reference positions by code (from the catalog, P4)
```

**Risk over-clustering**: (a) `gave up after 15 turns` ห้ามเป็น key เด็ดขาด — HIR-EC-048 ก็ `gave up after 15 turns` แต่ตายที่ `เพศ`/`สัญชาติ` แล้วกด ถัดไป ยังไม่เคยแตะ Position; ใช้ action ที่พังล่าสุด ไม่ใช่เหตุจบ leg. (b) 404 ต้อง key ด้วย path เต็ม: `/api/consent-api/status` กับ `/api/ec-api/detail/personal` (CNS-EC-029 step 4-5) คนละ endpoint และ HIR-EC-008 (`/th/admin/hire` 404 จาก stgw) ต้องไม่รวมกับ consent. (c) listbox miss ของ `บริษัท` (CNS-EC-011) ต้องไม่รวมกับ `ตำแหน่ง` — key รวม trigger name

### P2 — Typed end-reason และข้อมูล listbox บน record (seal-side, ให้ P1 มีของอ่าน)  (effort S–M)

**ทำอะไร** ใน `src/engine/proof-bundle.ts` + `src/orchestrator/workflow-agent.ts` (subagent `orchestrator-optimizer` ต้องรีวิว):

- `AgentRecord.endedBy?: 'finish' | 'arrived' | 'fail' | 'budget' | 'stalled' | 'no-progress' | 'value-hunt' | 'cannot-offer' | 'wandered' | 'blocked' | 'model-error'` — set ตรงจุดที่ `summary` ถูกตั้งอยู่แล้ว (`workflow-agent.ts:1587, 1651, 1826, 2016, 2019, 2035` และจุด stall/no-progress) ไม่เปลี่ยนตรรกะจบ leg
- `AgentAction.listbox?: { trigger: string; value: string; shownCount: number; shownHead: string[]; filtered: boolean; searchedEmpty: string | null }` — copy จาก `ListboxOptionMissingError` ใน catch ที่ `:1885` ก่อน `describe(caught)` ทิ้ง object. ข้อมูลนี้คือ evidence ที่ harness อ่านจาก tree เอง ไม่ใช่ claim ของ model
- `AgentRecord.unreachable?: { claim: string; urlAfter: string; headingsAfter: string[] }` สำหรับ `endedBy==='fail'` — `claim` คือ `decision.reasoning` (ติดป้ายว่าเป็น claim), `urlAfter/headingsAfter` มีใน `detail` อยู่แล้ว (เห็นใน CNS-EC-029 step 3 detail keys) ยกขึ้นมาเป็น typed

**เหตุผล**: กฎ "what the agent claims is never the evidence" — ปัจจุบัน finding "เมนูไม่มี" ทั้ง 4 case พิสูจน์ได้จาก `reasoning` เท่านั้น ส่วน listbox miss มี evidence จริง (harness นับ option เอง) แต่ถูกทิ้งเป็นสตริง

**Risk**: ต่ำ เป็น additive field; `tests/artifact-schemas.test.ts` schema loose อยู่แล้ว (`src/artifacts/schemas.ts`) ต้องยืนยันว่าไม่ reject field ใหม่. **สิ่งที่ห้ามทำ**: เปลี่ยน `status` ของ step จาก `error` เป็นอย่างอื่นใน reporter

### P3 — Outcome ใหม่ "ไม่มีใน environment นี้" / "ข้อมูลไปไม่ถึงจาก UI" ที่ seal  (effort M–L, ต้องตัดสินใจก่อน)

**สถานะวันนี้ที่ outcome kinds รองรับ**:

| ความหมาย | มีแล้ว | field |
|---|---|---|
| harness เอง | `error` + `harnessOnly` → `blocked` | `StepStatus`, `exit.ts:184` |
| กฎของ run ห้าม | `blocked{reason,rule}` | `ProofStep.blocked` |
| control ไม่มี | `dead-end` | `StepStatus` |
| claim ขัดกัน | `failed` | `StepStatus` |
| ถ้อยคำก้ำกึ่ง | `needs-review` + `unsure` | `RunStatus`, `ProofStep.unsure` |
| route ที่ codebase ไม่ประกาศ 404 | `error` ผ่าน `RouteNotFoundError` | `runner.ts` ~8480 |
| **endpoint ที่ประกาศไว้ตอบ 404 ใน SIT** | ไม่มี → `failed` + defect backend | — |
| **เมนู/หน้าที่ sheet ระบุไม่มีในระบบ** | ไม่มี → `error` + defect `Workflow goal not reached` high (`runner.ts:5027-5045`) | — |
| **ข้อมูลมีแต่ UI ไปไม่ถึง** | ไม่มี → `error` `budget` + defect medium | — |

**ข้อเสนอขั้นต่ำ**: ขยาย `BlockedReason` (`proof-bundle.ts:423`) ด้วย `'environment'` และ `BlockedRule` ด้วย `'endpoint-absent' | 'surface-absent' | 'data-unreachable'` แล้วให้ runner stamp `ProofStep.blocked` เมื่อ **หลักฐาน deterministic** ครบ:

| rule | evidence rule (ต้องครบทุกข้อ ไม่ใช่ claim) |
|---|---|
| `endpoint-absent` | `request.status===404` **และ** body ไม่ใช่ JSON error envelope ของ app (`[body omitted … unrecognised format]` = gateway page) **และ** path อยู่ใน declaredRoutes ของ context graph (คือ spec บอกว่ามี) — ถ้าไม่มี context graph ให้คง `failed` ไว้ |
| `surface-absent` | `endedBy==='fail'` **และ** `goalDestination(goal)` ระบุ path **และ** ไม่มี `goto` ใน actions ที่ไปถึง path นั้น **และ** `headingsAfter` ไม่มีคำจาก goal — ยังเป็นเกณฑ์อ่อน; ผมแนะนำ **ไม่** เปลี่ยน status สำหรับกรณีนี้ใน phase แรก แสดงเป็น finding เฉย ๆ (P1) |
| `data-unreachable` | `listbox.filtered===false && listbox.shownCount>0 && value ไม่อยู่ใน shown` (enumerate สองครั้งเหมือน `listboxCannotOffer` ที่ `agent-guards.ts:805`) — เกณฑ์นี้มีอยู่แล้วแต่ **ไม่ fire ใน HIR-EC-006** เพราะ `listboxCannotOffer` ต้องการ control name ใน goal ตรงกับชื่อปุ่ม (`ตำแหน่ง` vs goal เขียน `Position`) ควรแก้ตรงนั้นก่อน |

**ความเห็นเชิงตั้งคำถาม**: consent 404 ที่ sheet คาด 200/409/400 คือ **test failed ที่แท้จริงตามสเปก** (spec บอกว่ามี endpoint, SIT ไม่มี) การย้ายไป `blocked` จะทำให้ exit code เป็น 3 และ `--resume` รันซ้ำทุกครั้ง ผมแนะนำ **คง `failed`** และให้ P1 ทำหน้าที่บอกทีมแอปว่า "6 case พังจาก 3 endpoint เดียวกัน" แทน ส่วน `data-unreachable` ควรเปลี่ยนเป็น blocked เพราะวันนี้ให้ `error` + defect medium ที่ตำหนิ "งบ turn" ทั้งที่ harness รู้แล้วว่าตัวเลือกไม่มี

**Risk**: สูงสุดใน 8 ข้อ กระทบ exit code, `remaining()`, truth table (`classifyTruth` `src/reporter/truth-table.ts:69-80` จะจัดเป็น `no-verdict`) ต้องมี test เทียบ 544 bundle เดิมแบบ false-failure audit

### P4 — Defect-report export สำหรับทีมแอป (Markdown + sheet "Findings" ใน xlsx) ไม่ใช้ model  (effort M)

**ทำอะไร**: `src/reporter/findings-export.ts` รับ `Finding[]` จาก P1 + `CatalogReportInput`:

- **Markdown** `reports/<runKey slug>-findings.md`: หัวข้อต่อ finding, ตาราง affected cases (id, sheet title จาก `generatedBy.caseTitle/scenario`, status), **Steps to reproduce** จาก flow: เดิน `bundle.steps` จน step ที่พัง ใช้ `intent` (verbatim จาก author), `action`, `describeTarget(step.target)` (`proof-bundle.ts:832`), value ผ่าน `visibleDetail` เพื่อไม่รั่ว credential (`step-facts.ts:232-280`), agent leg แสดง `goal` แล้วตามด้วย `describeAgentAction` ของ action ที่ ok (`step-facts.ts:401`); **Evidence**: request/response จาก `step.request` (body ถูก redact แล้ว), network mismatch จาก `step.network` (API 200 แต่ UI ไม่มี = บรรทัดเดียว), path ไฟล์ screenshot + `videoOffsetMs`
- **xlsx**: เพิ่ม sheet ที่สองใน `buildPassedCasesWorkbook` หรือ workbook ใหม่ `<runKey>-findings.xlsx` ใช้ `buildZip/workbookParts/stepProof` เดิม (`excel-export.ts:62, 206`) คอลัมน์ Finding · Cases · Where · Asked/Offered · Evidence · Status as sealed · Suggested severity
- **Suggested severity** ต้องเป็น rule ที่ตรวจได้: `high` เมื่อ finding ปิด >=3 case หรือ block dependency chain (`LedgerOutcome.dependsOn`), `medium` เมื่อ 1–2 case, `low` เมื่อ `harnessOnly` — และเขียนกติกานี้ลงหัวไฟล์ ไม่ใช่ให้ model ตัดสิน
- hook ใน `writeCatalogArtifacts` (`catalog-live-report.ts:80-86`) เพื่อให้ `wowlidator report` rebuild ได้จาก ledger โดยไม่รันใหม่

**Reader เห็น**: ไฟล์ .md 5 หัวข้อ แนบ ticket ได้ทันที แทน HTML 99 MB (ไฟล์วันนี้ `reports/…-202.html` = 99,802,027 bytes)

**Risk**: ต่ำ เป็น projection ล้วน; ต้องมี test แบบ `tests/excel-export.test.ts` ที่อ่านกลับผ่าน `extract.ts`

### P5 — Trend ระดับ finding: first seen / still present / fixed  (effort M)

**สถานะวันนี้**: `HistoryEntry.failedSteps` = `action:selector` (`run-history.ts:66-71`) ตัวอย่างจริง CNS-EC-004 6 บรรทัดใน `history.jsonl` มี `workflow:-` ทุกครั้ง → บอกแค่ "case นี้พัง 5 ครั้ง" บอกไม่ได้ว่าพังเรื่องเดิม

**ทำอะไร**:
- `HistoryEntry.findings?: string[]` = signature key จาก P1 (คำนวณตอน `toHistoryEntry` `run-history.ts:73-90` ต้องย้าย `signatureOf(bundle)` ไปอยู่ที่ engine/history ไม่ใช่ reporter เพื่อไม่ให้ history import reporter) และ `runKey` (มีใน `generatedBy.runKey`)
- `analyseFindingTrend(key, entries)` pure: group entry ตาม catalog (runKey ก่อน `@`) → `first-seen(runKey)`, `present-in N of M runs`, `absent since <run>` = fixed หรือ case นั้นไม่ได้รัน (ต้องแยก: ถ้า case ที่เคยมี finding ไม่ได้รันใน run นี้ ห้ามพูดว่า fixed)
- P1 แสดงบรรทัด `trend:` ต่อ finding; per-case trend เดิมคงไว้

**Risk**: signature ต้องเสถียรข้าม re-authoring — selector เปลี่ยนได้ทุกครั้งที่ author ใหม่ ดังนั้น key ควรใช้ **path + control name + value** ไม่ใช่ selector string ทั้งก้อน; `schemas.ts` history schema ต้องยอมรับ field ใหม่ (loose อยู่แล้ว ต้องมี test)

### P6 — พับ noise ใน catalog report โดยไม่ซ่อน  (effort S)

สิ่งที่ stakeholder ไม่ต้องอ่านทีละบรรทัดวันนี้:

| noise | จำนวนวันนี้ | พับอย่างไร |
|---|---|---|
| `never ran` rows | 252 (สร้างเป็น `<section>` ทีละ case) | นับในหัว + `<details>` เดียว list id เท่านั้น ไม่ render `caseSection` เต็ม |
| `authoring refused (attempt N): …` | 10 case (ledger `authoringRefused`) | จัดกลุ่มตาม lint (ต้องเพิ่ม `LedgerOutcome.refusal?: string[]` ชื่อ lint จาก `AuthoringError` — วันนี้มีแต่ `reason` ข้อความยาว 200+ ตัวอักษร) แสดง "refused by lint X: 4 cases" |
| `depends on X which …` | 7 case | ซ้อนใต้ case X ใน finding เดียวกัน อ่าน `LedgerOutcome.dependsOn` (มีแล้ว `suite-progress.ts:77`) แทนที่จะ copy ข้อความเหตุผลของ X มาทั้งย่อหน้า |
| `exclusivity unproved — …` | 2 case | กลุ่ม authoring เดียวกัน |
| `ungrouped` 269 case | bug | fallback `scenario = bundle.generatedBy.scenario ?? scenarioFromId(id)` ใน `buildCatalogReportCases` (`catalog-live-report.ts:50-71`) และให้ `cmdCatalogReport` ใช้ทางเดียวกัน |
| 500 ของ content-management บนทุกหน้า | ทุก bundle | finding ระดับ environment หนึ่งบรรทัด ไม่ใช่ซ้ำใน step detail ทุก case |

หลักการ: นับให้เห็นในหัว เสมอ, รายชื่ออยู่ใน disclosure, ไม่มีอะไรหายจาก DOM (กติกา "silent truncation" ใน `suite-index.ts:33-42`)

### P7 — ให้ `Defect` รู้ว่าตัวเองเป็น cascade และไม่ file defect เมื่อ agent ตอบ `fail` แบบมีหลักฐาน  (effort S, seal-side)

- `Defect.downstream?: boolean` stamp ใน `#recordRuntimeDefect` (`runner.ts:5619-5636`) จาก step ที่ `downstream===true` → HIR-EC-006 จะเหลือ defect ที่นับจริง 1 จาก 8; `ownerOf`/`summary.defects` คงเดิม (ไม่เปลี่ยน status) แค่ report/P1 นับเฉพาะ non-downstream
- วันนี้ `fail` ของ agent file defect `high` (`runner.ts:5034-5045`: `exhausted ? 'medium' : 'high'` และ doc บอกว่า high "reserved for a goal the agent actively determined it could not reach") — แต่การที่ model "determined" ไม่ใช่ evidence ตามกฎ orchestrator เอง เสนอ: `high` เฉพาะเมื่อมี typed evidence (`listbox`/`cannot-offer`/`outcomeShown` miss) ไม่งั้น `medium` และ detail บอกว่าเป็น claim

**Risk**: เปลี่ยน severity มีผลกับ `summary.defects` count และ ownerOf ไม่เปลี่ยน; ต้องผ่าน `engine-expert`

### P8 — แสดง `diagnosis` เป็น "ความเห็นของ model" ในระดับ finding และวัดความสอดคล้อง  (effort S)

- ใน P1 บล็อก finding รวม `bundle.diagnosis.origin` ของสมาชิกทุก case เป็น vote line ติดป้าย model/confidence (กติกาเดียวกับ review judge: "always LABELLED as the model's") **ห้าม** ใช้ origin เป็นชื่อหมวดของ finding
- เมื่อ vote ไม่ตรงกัน (Position picker: agent vs test-catalog) แสดงว่า "disagree" ตรง ๆ — นี่คือสัญญาณให้คนดู และเป็น metric ที่ใช้วัดว่า prompt diagnosis ดีขึ้นไหม
- ค่าใช้จ่ายวันนี้ต่อ diagnosis ~5–20k token in (log บรรทัด 2067, 3929, 6492) และไม่ทำสำหรับ `failed` เลย จึงไม่ควรเป็นฐานของ finding

## 5. ลำดับที่แนะนำ

1. P6 (bug scenario + พับ never-ran) — เห็นผลทันทีในไฟล์ 99 MB
2. P2 → P1 (typed field ก่อน projection) — หัว report เป็น findings
3. P4 export — ส่งทีมแอป
4. P7, P8 — ความถูกต้องของ defect count และความเห็น model
5. P5 trend — ต้องมี P1 key ก่อน
6. P3 — ตัดสินใจนโยบาย status ก่อนลงมือ (ผมแนะนำเฉพาะ `data-unreachable`)

## 6. ไฟล์อ้างอิงหลัก

- `src/engine/proof-bundle.ts` — `RunStatus:39`, `verdictFamily:115`, `AgentAction:373`, `BlockedOutcome:449`, `AgentRecord:508`, `Defect:596`, `ProofStep:619` (`network:690`, `request:697`, `downstream:756`), `GenerationProvenance:1031` (`scenario:1083`), `ErrorDiagnosis:1099`, `addDefect ~1500`
- `src/engine/listbox.ts:77-100` — `ListboxOptionMissingError{shown, filtered, searchedEmpty}`
- `src/orchestrator/workflow-agent.ts` — summary strings `1587, 1651, 1826, 2016, 2019-2028, 2035`; catch ที่ทิ้ง typed error `1885`
- `src/orchestrator/agent-guards.ts:805` — `listboxCannotOffer`
- `src/engine/runner.ts` — defect ของ workflow `5027-5045`, `#recordRuntimeDefect 5619`, `classifyStepFailure ~8440`
- `src/cli/exit.ts:184-207` — `harnessOnly`
- `src/cli/suite-progress.ts:33-87` — `LedgerOutcome`
- `src/cli/catalog-live-report.ts:41-71, 80-98` — `scenarioFromId`, `buildCatalogReportCases`, `writeCatalogArtifacts`, `historyLinesFor`
- `src/cli/commands/maintenance.ts:367-430` — `cmdCatalogReport`
- `src/cli/run-cases.ts:1120-1150` — diagnosis เฉพาะ `error`
- `src/reporter/catalog-report.ts:77-125, 573-640` — `CatalogReportCase`, `renderCatalogReport`
- `src/reporter/step-facts.ts:559-586` — `countVerdicts`
- `src/reporter/excel-export.ts:62, 206-292, 353` — zip, `stepProof`, workbook
- `src/history/run-history.ts:25-90, 172-291` — `HistoryEntry`, `analyseTrend`
- `src/generator/error-diagnosis.ts:1-80` — origins และเหตุผลที่มี
- `src/reporter/truth-table.ts:69-80` — `classifyTruth`
