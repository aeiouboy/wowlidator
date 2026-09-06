# Explore: verdict ที่แม่นขึ้นสำหรับ wowlidator (จาก run humi SIT 2026-09-05)

อ่านแบบ read-only จาก `src/`, proof bundles ของวันนี้, ledger, log และ probe ผลใน scratchpad
ทุกข้อเสนอเคารพกฎ "what the agent claims is never the evidence" และ "a rung may only fail
identically or succeed against the right thing"

## สิ่งที่หลักฐานบอก (ก่อนเสนออะไร)

1. **workflow leg ที่ล้มเหลวทุกแบบจบเป็น step `error` เสมอ** — runner บันทึก step เป็น `failed`
   (`src/engine/runner.ts:4905`) แล้ว throw `workflow agent failed:` (`runner.ts:5046`) ซึ่ง
   `classifyStepFailure` จัดเป็น `error` เพราะ action ไม่ใช่ `expect*` (`runner.ts:8501-8504`;
   หมายเหตุใน `src/engine/proof-bundle.ts:1754`). ผลคือ "agent reported the goal is unreachable:
   ไม่มี option C005 ใน listbox" (หลักฐานจากหน้าจริง) กับ "agent gave up after 15 turns"
   (ขีดจำกัด harness) ได้ status เดียวกัน และเคสที่ไม่มี assertion ตามหลังถูก `harnessOnly`
   (`src/cli/exit.ts:179-205`) นับเป็น `blocked` พร้อมข้อความ "runtime error — the harness ended
   this case" ทั้งที่ agent อ่านหน้าแล้วจริง (ledger: CNS-EC-013, CNS-EC-004, CNS-EC-031)
2. **ทั้ง 5 leg ที่ชน cap 15 วันนี้เป็น wizard fill ที่ goal มี 20–26 คู่ค่า** (`goalOutcomes`):
   HIR-EC-021 17/17 action สำเร็จแล้วยังหมดโควตา; HIR-EC-006 15/19; HIR-EC-011 17/18;
   HIR-EC-048 12/15; HIR-EC-008 15/18. cap อยู่ต่ำกว่าจำนวนช่องที่ goal สั่งกรอกทุกเคส
3. **`listboxCannotOffer` (judge ที่มีอยู่แล้ว) ไม่ยิงกับ Position picker** เพราะเทียบชื่อ control
   ข้ามภาษาไม่ได้: goal เขียน `Position = 40106337` แต่ selector คือ
   `role=button[name="ตำแหน่ง" i]` (`src/orchestrator/agent-guards.ts:815-818` เทียบ containment
   ของ string) — ผมรัน `listboxCannotOffer` กับ goal จริงของ HIR-EC-006: ชื่อไทย → `null`,
   ชื่ออังกฤษ → ยิง. ถ้ายิง leg จะจบด้วย "agent stopped: … not among the 500 option(s)"
   (`workflow-agent.ts:2019-2029`) แต่ก็ยังแยกไม่ได้ว่า "ค่าไม่มีในระบบ" หรือ "มีแต่ UI ไม่ถึง"
4. **`NetworkObserver` ไม่เก็บ response body** (`src/api/network-observer.ts:75-91`,
   `#onResponse` :214-222) — bundle ของ HIR-EC-006 มี call
   `GET /humi/api/employee-foundation/foundation?type=positions&page=1&size=500&companyCode=C001`
   status 200 อยู่ใน `steps[4].network` แต่ไม่มีเนื้อ. probe6: 71 รหัสอยู่ใน 500 แรก, 29 รหัส
   (151 แถวชีต) อยู่นอก; probe3: พิมพ์ในกล่องค้นหาไม่ยิง API เลย (กรองฝั่ง client)
5. **404 ของ consent เกือบทั้งหมดคือ base path หาย ไม่ใช่ spec ไม่มี**: request record 404
   วันนี้ 27 รายการ เป็น `text/html` 547 bytes (gateway) ทั้งหมด ยกเว้น CNS-EC-025 ที่เรียก
   `/humi/api/consent-api/consent/status` แล้วได้ JSON `ERR_NOT_FOUND` จาก app เอง.
   สาเหตุ: `flow-author.ts:4064` ตั้ง `baseUrl: originOf(url)` (origin เปล่า ไม่มี `/humi`),
   `api-actions.ts:394` resolve relative url กับ baseUrl นั้น, และ `runner.ts:10013` ส่ง
   `deploymentUrl: flow.baseUrl` ทำให้ route matching เสีย base path ไปด้วย — ทั้งที่ reviewer
   เองพูดใน log ว่า "under the application's /humi base path"
6. **cascade ไม่ถูกจับ**: HIR-EC-006 ได้ 8 defect — 1 `medium` (หมดโควตา) + 7 `high` ซึ่ง 5 ตัวเป็น
   `expectVisible` ที่ล้มบนหน้า wizard ที่ไม่เคย submit. `error-diagnosis` ดู cascade เฉพาะ bundle
   status `error` (`run-cases.ts:1133`) เคสนี้ status `failed` จึงไม่ถูก diagnose เลย

## ข้อเสนอ (เรียงตามคุ้มค่า/ความเสี่ยง)

### 1. คืน `/humi` ให้ request step และแยก 404 สองแบบด้วย typed error — S + M

**เปลี่ยน**
- `src/generator/flow-author.ts:4064`: `baseUrl` = origin + base path ที่ deployment ใช้จริง.
  หา base path ได้ deterministic จาก `deploymentRoutePath` (`src/context/route-match.ts:220-235`
  คำนวณ `basePath` อยู่แล้วแต่ไม่คืนค่า) หรือจาก prefix ของ URL ที่ทรีจับได้ (`…/humi/th/login`)
- `src/api/api-actions.ts:277-313` (`expectStatus`): เมื่อ status 404 ให้ดูสองอย่างที่บันทึกอยู่แล้ว
  ใน `RequestRecord` (`api-client.ts:150-160`): `content-type` ของ response และผล `routeIsDeclared`
  (ต้องส่ง `declaredRoutes`/`deploymentUrl` เข้า `ApiActions` แบบเดียวกับ `#judgeNavigationStatus`
  `runner.ts:4672-4695`)
  - 404 + `text/html` + path ที่ codebase declare → `EndpointNotRoutedError` (ครอบครัว
    `RouteNotFoundError` `runner.ts:774`, เพิ่มชื่อใน `classifyStepFailure` :8471-8497) = การ
    request ไม่ถึง app เลย (base path/deployment ผิด) → step `error`, ไม่ file defect
  - 404 + JSON จาก app (`errorCode`) บน path ที่ declare → ปล่อยเป็น `failed` ตามเดิม แต่ติด
    marker `unsupported: { kind: 'endpoint-not-served', evidence: body.errorCode }` (ดูข้อ 6)
  - 404 บน path ที่ codebase **ไม่** declare → คงพฤติกรรม `unindexedRequestMethod`-style:
    ไม่มีความเห็น (silence ไม่กลายเป็น refusal)
- lint ตอน author: `flow-author.ts:4963` (`unindexedRequestMethod`) ตอนนี้ตรวจแค่ method บน path
  ที่ declare; เพิ่ม `unroutedRequestPath` ที่เตือนเมื่อ path ไม่ขึ้นต้นด้วย base path ที่ deployment
  ใช้ ขณะที่ทรี/ทราฟฟิกที่จับได้ล้วนอยู่ใต้ base path นั้น

**verdict ที่ผู้ใช้จะเห็นแทน** "failed: expected status 200, got 404 Not Found" ×8 →
"blocked (harness): `GET /api/consent-api/status` ไม่ถูก route ที่ deployment นี้ (gateway 404,
HTML) — หน้าเว็บเองเรียก `/humi/api/…`; flow ตั้ง baseUrl ไม่มี `/humi`" และสำหรับ CNS-EC-025
"failed — endpoint ไม่มีใน SIT: app ตอบ 404 `ERR_NOT_FOUND` บน `/humi/api/consent-api/consent/status`"

**หลักฐาน** `RequestRecord.responseHeaders['content-type']`, `responseBody` (JSON เท่านั้นที่ผ่าน
`redactBody` `redact.ts:196-219`), `routeIsDeclared`, และ `NetworkCall.url` ของหน้าเอง

**เสี่ยง false positive** ต่ำ: gateway ที่ตอบ 404 เป็น JSON จะเข้าเกณฑ์ "app ตอบ" — บรรเทาด้วย
เงื่อนไข "มี `errorCode`/`message` field" ไม่ใช่แค่ JSON. base path เดาผิดถ้า deployment ไม่มี
route ใดตรง pattern — `deploymentRoutePath` คืน path เดิมอยู่แล้วในกรณีนั้น

**Q4 (live probe)**: ไม่จำเป็นสำหรับชั้น HTML-404 (index + base path ตัดได้ที่ $0 ก่อนรัน) แต่ชั้น
JSON-404 (proxy มี, upstream ไม่มี) ตรวจได้ก่อนรันด้วย `GET`/`HEAD` หนึ่งครั้งต่อ path ผ่าน
`BrowserContext.request` หลัง `signIn` (session เดียวกับ UI ตามหลัก `src/api/CLAUDE.md`) —
ราคา ~1 round trip/path, $0 token; ทำได้เฉพาะ verb อ่าน (POST/PATCH ห้าม probe). เสนอเป็น
flag opt-in `--probe-endpoints` หลังจากข้อนี้ลงแล้ว (M)

### 2. typed stop reason บน `AgentRecord` แล้วให้ runner โยน error คนละชนิดตามที่มาของหลักฐาน — M

**เปลี่ยน**
- `src/orchestrator/workflow-agent.ts`: ทุกจุดที่ตั้ง `summary` แล้ว break/stop ให้ตั้ง
  `this.#stopped = { kind, evidence }` ด้วย: `exhausted` (:1584-1587), `stalled` (:1752, :2190),
  `looked-only`, `wandered`, `value-never-appeared` (:1640-1650), `cannot-offer` (:2019-2029),
  `menu-absent` (ดูข้อ 6), `agent-fail` (การ `fail` ของ model), `agent-finish-refused`
  (claim ที่หน้าไม่ยืนยัน). ใส่ลง `WorkflowResult` ใน `#result` (:2444-2470) และ type ใน
  `proof-bundle.ts` ข้าง `AgentRecord.blocked` (:540-560)
- `src/engine/runner.ts:5030-5046`: แทน `throw new Error('workflow agent failed…')` หนึ่งตัว
  ด้วยสามชนิด:
  - harness-class (`exhausted`, `stalled`, `looked-only`, `wandered`) → `AgentBudgetError`
    → `error`, defect `medium` ตามที่ทำอยู่ — ข้อความบอก "ขีดจำกัดของ harness" ชัด
  - page-evidence (`cannot-offer` หลัง enumerate ซ้ำสอง, `value-never-appeared` บนทรีที่ไม่ตัด,
    `menu-absent`) → `AgentEvidenceError` ที่ `classifyStepFailure` จัดเป็น **`failed`** พร้อม
    `detail.expected`/`detail.actual` (ค่าที่ goal ขอ / รายการที่หน้าเสนอ) เพื่อให้ `expectedActual()`
    และ near-miss gate อ่านได้ — เพราะหลักฐานคือ enumeration ที่ harness อ่านเอง ไม่ใช่คำพูด agent
  - agent-claim (`agent-fail`) → คง `error` แต่ `harnessOnly` ต้องเปลี่ยนคำจาก "runtime error —
    the harness ended this case" เป็น "no verdict — the agent's own account, unverified: …"
    (`exit.ts:200-204` อ่าน `first.blocked` อยู่แล้ว เพิ่ม `first.agent?.stopped`)

**verdict ที่ผู้ใช้จะเห็นแทน** CNS-EC-011 "blocked: runtime error — the harness ended this case"
→ "failed: บริษัท filter เสนอ 9 option (ทุกบริษัท, C001, C002, …) ไม่มี C005 — อ่านจากหน้า 2 ครั้ง"
และ HIR-EC-006 leg 4 → "no verdict (harness): 15-turn cap หมดขณะ 15/19 action สำเร็จ" แยกจาก
leg 5/6 ที่เป็นคำพูด agent

**หลักฐาน** `ListboxOptionMissingError.shown` + `filtered === false` + `sameOptions` (มีอยู่แล้ว),
`anyValueAppears` บน full tree, การ enumerate ของ `#walkMenuPath`

**เสี่ยง** การเลื่อน `cannot-offer` ไปเป็น `failed` ทำให้ list ที่โหลดไม่เสร็จกลายเป็น test-failed —
กฎ enumerate ซ้ำสองครั้งห่าง `WAIT_SETTLE_MS` มีอยู่แล้ว (:1877-1900) แต่ควรเพิ่มเงื่อนไข "ไม่มี
XHR ค้างระหว่างสองครั้ง" จาก observer (ข้อ 5) ก่อนยกระดับ. ต้องระวังกับข้อ 3/4: ถ้าขยายการเทียบชื่อ
control ข้ามภาษาโดยยังไม่มี prefix match, `Nationality = Thai` vs `["Thailand - Thailand"]` จะยิง
`cannot-offer` ผิด (`valueShownIn` เป็น whole-word) — ต้องลงข้อ 4 ก่อนหรือพร้อมกัน

### 3. fail-fast cap แปรตามขนาด goal แทนเลขตาย 15 — S

**เปลี่ยน** `src/orchestrator/workflow-agent.ts:1387-1388`: `effectiveMaxSteps` สำหรับ goal ที่
`goalOutcomes(goal).length >= 3 || FORM_GOAL` (เงื่อนไขเดียวกับ `maxNodes` :1378-1381) =
`max(runOptions.maxSteps, outcomes + AGENT_FORM_TURN_SLACK)` โดยยังไม่เกิน `this.#maxSteps`
(60). บันทึกค่าที่ใช้จริงลง `maxSteps` ของ record (ทำอยู่แล้ว :2458). ปรับ doc ของ
`RunOptions.maxSteps` (:1027-1035 "never looser") ให้เว้นกรณี form allowance และ test
`tests/dead-end-risk.test.ts:222-245` ที่ตรึง 15 (ตรึงที่ `failFastRunOptions` ไม่ใช่ที่ loop
จึงไม่ต้องแก้ค่านั้น). `failFastRunOptions` รับ `flow` แล้ว `void flow` (`run-cases.ts:217-218`) —
ทางเลือกคือคำนวณต่อเคสที่นั่นจาก goal ยาวสุด แต่ต่อ leg ใน loop ตรงกว่า

**verdict ที่ผู้ใช้จะเห็นแทน** "agent gave up after 15 turns" บน 5 เคส → leg เดินถึง Position picker
แล้วจบด้วยหลักฐานจากข้อ 2/5 หรือผ่านไปถึง submit

**trade-off กับ runaway 101 turn (HIR-EC-010)**: runaway นั้นคือค่าที่ไม่มีบนหน้า + คลิก ok บน control
ใหม่ทุกเทิร์น; ตอนนี้มี `AGENT_VALUE_HUNT_TURNS` (8), `reactivation`/`text-again` (2026-09-03)
และ `repeatedToggleClick` คุมรูปนั้นแล้ว — cap 15 เกิดวันเดียวกับ value-hunt judge จึงซ้อนกัน.
ด้วยสูตร `outcomes + 6` เพดานเลวร้ายสุดวันนี้คือ ~32 turn (≈4 นาทีที่ ~7 s/turn) แทน 15 —
ยอมรับได้เมื่อเทียบกับเคสที่พังทั้งเคส. **อย่า**ใช้ทางเลือก "ยกเพดานตราบที่ progress judge เห็น
ความก้าวหน้า": HIR-EC-010 ก้าวหน้าตามนิยามของ judge นั้นทุกเทิร์น ทางนั้นคือ runaway กลับมา

**เสี่ยง** goal ที่มีคู่ค่ามากแต่ค่าไม่มีจริงจะเสีย turn เพิ่ม — value-hunt (8) ยังตัดก่อนถึงเพดานใหม่
เมื่อ **ไม่มีค่าใดเลย**โผล่; กรณีค่าบางตัวโผล่บางตัวไม่ (เคสวันนี้) คือกรณีที่ควรได้ turn เพิ่มจริง

### 4. listbox: unique-prefix pick + เทียบชื่อ control ข้ามภาษาด้วยชื่อที่ทรีพิมพ์เอง — S + S

**เปลี่ยน (prefix)** `src/engine/listbox.ts:368-380`: หลัง candidate whole/word/code/label ล้มหมด
เพิ่ม rung `by: 'prefix'`: option ที่ชื่อ folded เริ่มด้วยค่า folded และ**มี option เดียว**เท่านั้น,
ค่ายาว ≥ 3 ตัวอักษร, ไม่ใช่ตัวเลขล้วน (รหัส "4010" จะ prefix ทั้ง 40106337/40106338 → ไม่ unique
→ ปฏิเสธเองอยู่แล้ว แต่ตัดตัวเลขล้วนไว้ก่อนเพื่อไม่ให้ "10" เลือก "10000075" เมื่อมีตัวเดียว).
เพิ่ม `'prefix'` ใน `matchedBy` (`listbox.ts:67-68`). **read-back คุมความซื่อ**: :413-425 เทียบ
`readBack` กับ `picked` (ชื่อ option ที่คลิกจริง) ผ่าน `foldedMatch` — trigger ต้องแสดง
"Thailand - Thailand" จริง ไม่งั้น `ListboxReadBackError`; `foldedMatch` เอง (`normalise.ts:168-180`)
**ไม่แก้** เพื่อไม่ให้ assertion หลวมตาม; `matchedBy: 'prefix'` ขึ้น record ให้รายงานบอกว่ายอมรับแบบ prefix
**เปลี่ยน (ชื่อ control)** `agent-guards.ts:804-822`: รับชื่อ trigger ที่ `ListboxOptionMissingError`
อ่านจากหน้าจริง (ตอนนี้อยู่ใน message เท่านั้น — "เลือกตำแหน่ง (Select Position)") เป็น field และเทียบ
`outcome.control` กับทั้ง selector name และชื่อนั้น: ป้ายสองภาษาที่หน้าพิมพ์เองคือหลักฐานจากหน้า ไม่ใช่
พจนานุกรม. เคสที่ป้ายเป็นไทยล้วน (เพศ/ชาย) ยังไม่ครอบ — ระบุเป็นข้อจำกัด

**verdict ที่ผู้ใช้จะเห็นแทน** turn ที่เสียกับ "no option named Thai … 1 shown: Thailand - Thailand"
หายไป (HIR-EC-006, HIR-EC-011 วันนี้); Position picker จบด้วย "cannot offer" ที่ยิงจริง (ข้อ 2)

**เสี่ยง** "New" เลือก "New hire" เมื่อมีตัวเดียว — uniqueness + ไม่ใช่ substring ("Male"∉"Female",
test `tests/engine-helpers.test.ts:118,729` ยังผ่าน) + read-back + `matchedBy` บน record คุมไว้.
รูปแบบพลาดส่วนใหญ่วันนี้ (Male/ชาย, Female, Ms./นางสาว, TH/Thailand, Non TH) เป็นสองภาษา ไม่ใช่
prefix — prefix แก้ได้ ~1 ใน 6 รูป ที่เหลือควรไปทาง `value-rules.ts`/`.wowlidator/value-rules.json`
(resolver ที่มีอยู่) ไม่ใช่ matcher

### 5. response body จาก call ของหน้าเอง → verdict สามทาง (defect / test-data / harness) — L

**เปลี่ยน**
- `src/api/network-observer.ts`: เพิ่ม `body(id)` แบบ lazy เรียก `Network.getResponseBody` ผ่าน
  `#session` เฉพาะเมื่อถูกถาม, จำกัดที่ `content-type: application/json` และขนาด (ตั้ง
  `Network.enable` `maxResourceBufferSize` ให้พอ), ผ่าน `redactBody` เสมอ. ไม่เก็บทุก call
  (ข้อกังวล 40 MB bundle ใน doc ของ `DEFAULT_MAX_CALLS`)
- `RunOptions.netEvidence?: (sinceMs) => Promise<{ call, json }[]>` ใน `workflow-agent.ts`
  (:1020-1100) wire จาก runner แบบ `#agentDbProbe` (`runner.ts:4444-4451`, :4771). agent **ไม่ได้**
  action ใหม่ — เป็นหลักฐานที่ loop อ่านเอง ไม่ใช่สิ่งที่ model สั่ง
- ที่จุด `cannotOffer` (:1898): ดึง call JSON ล่าสุดที่หน้าเรียกระหว่างเปิด list (mark ก่อน `#act`),
  แล้วตัดสิน deterministic:
  - `value` อยู่ใน body (ค้นทุก string field ผ่าน `foldValue`) แต่ไม่อยู่ใน `shown` → **application
    defect**: "picker renders N of M ที่ API ส่ง"
  - body มีรูป paging (`page`,`size`/`limit`,`total`/`totalPages`/`hasNext`) และ `shown.length === size`
    และ value ไม่อยู่ใน body → **ตามหน้าถัดไป**: `GET` URL เดียวกันเปลี่ยนแค่ `page=` ผ่าน
    `BrowserContext.request` (session เดิม, read-only, สูงสุด `PAGE_FOLLOW_LIMIT` เช่น 10) จนพบ/หมด.
    พบ → **application limitation**: "รหัส 40106337 มีจริง (page 3) แต่ UI ขอแค่ page=1&size=500
    และกล่องค้นหากรองฝั่ง client ตามชื่อ" (probe3 ยืนยันว่าพิมพ์ค้นหาไม่ยิง API). ไม่พบจนหมด →
    **test-catalog**: "ค่าไม่มีในระบบ"
  - ไม่มี call JSON / ไม่ใช่รูป paging → ไม่มีความเห็น (verdict ข้อ 2 ยืนอย่างเดียว)
- ผลลง `AgentRecord.stopped.evidence` และ `ProofStep.detail.pickerEvidence`; defect category
  ยัง `functional` (UI ฝั่ง frontend) แต่ title/description มาจากตัวเลขในหลักฐาน

**verdict ที่ผู้ใช้จะเห็นแทน** "agent gave up after 15 turns" → "failed (application): Position
picker เสนอเฉพาะ 500 รายการแรก (page=1&size=500, total 1,4xx) ค้นหาด้วยชื่อเท่านั้น — รหัส 40106337
มีอยู่และว่างที่ page k ของ endpoint เดียวกัน; ผู้ใช้ไม่มีทางเลือกได้ (กระทบ 151 แถวใน 100 รหัสของชีต)"

**หลักฐาน** URL+query ของ call ที่หน้าเรียกเอง, body JSON (redacted), `shown` จาก enumeration,
response ของหน้าถัดไปที่ harness ขอเอง

**เสี่ยง** การ GET หน้าถัดไปคือ HTTP ที่ test ทำเองโดยผู้เขียนไม่ได้สั่ง — ต้อง (a) verb GET เท่านั้น
(b) URL เดิมเปลี่ยนแค่ page (c) ปิดด้วย `--no-backend` เหมือน `dbCount` (`SmartRunner.#agentDbProbe`)
(d) บันทึกทุก request ลง step. false positive: body มี `40106337` ในฟิลด์อื่น (เช่น parentPositionCode)
→ ต้องเทียบ field ที่ชื่อ/ค่าสอดคล้องกับ option label หรืออย่างน้อยรายงานชื่อฟิลด์ที่พบ

### 6. marker `unsupported` สำหรับ "spec ไม่มีใน environment นี้" + `menu-absent` จาก walker — M

**เปลี่ยน**
- `proof-bundle.ts`: `ProofStep.unsupported?: { kind: 'endpoint-not-served' | 'menu-absent' |
  'route-not-deployed'; evidence: string[] }` ข้าง `blocked` (:670) — **ไม่เพิ่ม `StepStatus`**
  (:38) เพราะทุก reader/ledger/exit code ตรึงชุดเดิม; status คง `error` (ครอบครัว system) หรือ `failed`
  ตามข้อ 1 แล้วให้ `harnessOnly` (`exit.ts:179-205`) และ `run-cases.ts` roll-up (:1494-1500) แยก
  บรรทัด "not available in this environment: N" ออกจาก "runtime error: N"; `CaseOutcome.verdict`
  ยัง `blocked` (exit 3) — สัญญา exit code แช่แข็ง
- `menu-absent`: `#walkMenuPath` (`workflow-agent.ts:2515-2580`) รู้แน่ว่า segment ใดไม่อยู่ในทรี
  หลังเปิด i ระดับ (:2537) แต่ตอนนี้แค่ push history แล้วยกให้ model. เพิ่ม: ถ้าทรี**ไม่ถูกตัด**
  และ parent segment `aria-expanded=true` และ model ตอบ `fail` ที่อ้าง segment นั้น → stamp
  `stopped.kind='menu-absent'` พร้อมรายชื่อ menu node ที่ enumerate ได้เป็นหลักฐาน → `unsupported`

**verdict ที่ผู้ใช้จะเห็นแทน** CNS-EC-004/031 "blocked: runtime error…" → "not in this environment:
เมนู EC > Consent ไม่มีใน sidebar (ระบบ มี: ผู้ใช้และสิทธิ์, จัดการเนื้อหา, ฐานข้อมูลกลาง, …)"

**เสี่ยง** sidebar ที่ virtualise/ยุบอยู่ทำให้ "ไม่มี" ผิด — เงื่อนไข "ทรีไม่ตัด + parent เปิดอยู่" และ
ต้องเป็นทรีที่ harness จับเอง (`#captureTree`) ไม่ใช่คำพูด model

### 7. cascade: assertion ที่ล้มหลัง leg ที่จบด้วยเหตุ harness-class ไม่ file defect แยก — M

**เปลี่ยน** `ProofBundleBuilder.finish()` (`proof-bundle.ts:1939-2011`) และ `#recordRuntimeDefect`
clustering (`occurrences`/`stepIndexes` :600-615): เมื่อ step แรกที่พังเป็น `workflow` ที่หยุดด้วย
`stopped.kind` harness-class (ข้อ 2) และ assertion ต่อมาอยู่บน URL เดียวกับ `urlAfter` ของ leg นั้น
(ไม่ได้ไปถึง destination ที่ goal ชื่อ) → assertion ยังบันทึก `failed` แต่ `detail.cascadeOf =
legIndex`, ไม่นับเป็น defect ใหม่, และ `RunStatus` ตามครอบครัวของจุดพังแรก (`error`) ให้เคสสกอร์
`blocked` แทน `failed` — สอดคล้องกับที่ `error-diagnosis` ทำอยู่แล้วแต่เฉพาะ bundle `error`

**verdict ที่ผู้ใช้จะเห็นแทน** HIR-EC-006 "failed, 8 defects (7 high)" → "blocked: leg 4 หมดโควตา
(harness); 5 assertion ถัดไปไม่ถึงหน้าที่ต้องตรวจ — cascade" (หรือเมื่อรวมข้อ 5: failed 1 defect
เรื่อง picker)

**เสี่ยง** ซ่อน defect จริงที่อยู่บนหน้าเดียวกัน — จำกัดเฉพาะ assertion ที่ selector/ค่าอ้างสิ่งที่ leg
ควรสร้าง (ค่าใน `goalOutcomes` ของ leg เช่น "A - Permanent", "1966-09-05") ไม่ใช่ทุก assertion

## สิ่งที่โค้ดทำอยู่แล้ว (ไม่เสนอซ้ำ)

- `listboxCannotOffer` + enumerate ซ้ำสองครั้ง (`workflow-agent.ts:1877-1900`)
- `MethodRefusedError` สำหรับ 405/501 และ `RouteNotFoundError` สำหรับ goto 404 บน path ที่ไม่ declare
- `agentModelUnavailable`/`personaRefusal` → `error` ไม่มี defect (`runner.ts:4846-4851`)
- `unindexedRequestMethod`/`ungroundedGoto` lint ตอน author (`flow-author.ts:3293-3320`)
- value-hunt judge, `reactivation`, `repeatedToggleClick`, `wanderedOffPage`
- `blocked` typed outcome + `harnessOnly` → exit 3 (Phase B)

## ลำดับที่แนะนำ

1 (base path, S) → 2 (typed stop reasons, M) → 3 (cap, S) → 4 (prefix + control name, S+S ต้องลงคู่กัน)
→ 7 (cascade, M) → 6 (unsupported/menu-absent, M) → 5 (body + paging follow, L) → live probe opt-in
