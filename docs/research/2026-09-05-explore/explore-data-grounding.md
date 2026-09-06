# Master-data grounding สำหรับ Test Data ของ catalog (สำรวจ 2026-09-05, read-only)

โจทย์: humi SIT, catalog EC 272 แถว. Test Data เขียนเป็น "รหัส" (Position = 40106337, Company = C001, Department = 30041915) แต่ UI ให้เลือกด้วย "ชื่อ" เท่านั้น. picker โหลด 500 แถวแรกของ
`GET /humi/api/employee-foundation/foundation?type=positions&page=1&size=500&isActive=true&companyCode=C001` แล้ว filter ฝั่ง client ด้วยชื่อ.

## ตัวเลขจากไฟล์ (นับใหม่จาก CSV + probe5/probe6-result.json)

| สิ่งที่นับ | ค่า |
|---|---|
| แถวที่มี `Position = <8 หลัก>` | 215 (รหัสต่างกัน 101) |
| แถวที่กล่าวถึง 40106337 | 87 (74 เป็น `Position =`, ที่เหลือ `Position Code =` / อ้างซ้ำ) |
| รหัสที่มีจริงและ vacant ใน foundation API | 100/100 |
| รหัสนอก 500 แถวแรกที่ picker โหลด | 29 รหัส = 151 แถว (probe6 summary) |
| C001 มี position ทั้งหมด | 5,364 (picker เห็น 500) |
| `Nationality` เขียนสองแบบ | `TH` 67 แถว, `Thai` 21 แถว → UI แสดง "Thailand - Thailand" |
| `Employee Group` | `A - Permanent…` 174 แถว, `E - Temporary` 10 แถว |
| แถวที่ `Company` เป็น C001 / C004 / C013 | 111 / 61 / 32 |

## สิ่งที่โค้ดทำอยู่แล้ว (อย่าเสนอซ้ำ)

- **แยก code/label ตอนเลือก listbox แล้ว**: `src/engine/listbox.ts:25-31` พิมพ์ครึ่ง CODE ลงช่องค้นหาก่อน ("A" ของ "A - Permanent") แล้วค่อยครึ่ง LABEL; `codeAndLabelOf` ที่ `src/engine/normalise.ts:82`. ดังนั้น `Employee Group = A - Permanent` ผ่านอยู่แล้ว. สิ่งที่ยังไม่ผ่านคือ (ก) ค่าที่เป็นรหัสล้วนแต่ option ไม่มีรหัสเลย (Position 40106337 → option "Building Pallet Staff", probe4) และ (ข) label ที่เป็นคำพ้อง ("Thai" กับ "Thailand - Thailand").
- **option miss ล้มเร็ว ไม่จ่าย healer**: `isStateContradiction` `src/engine/runner.ts:904` จับ `no option named … appeared` → เคสจบเป็น failed พร้อมเหตุผล "option set is wrong". นี่คือปัญหา: กับ Position มันคือ **false failure** ทุกแถว เพราะแอปถูก แต่ flow ส่งรหัสไปหาชื่อ.
- **agent มี judge สำหรับ list ที่ enumerate ครบแล้วไม่มีค่า**: `listboxCannotOffer` `src/orchestrator/agent-guards.ts:804`, ใช้ที่ `workflow-agent.ts:1885` (retry 1 ครั้ง แล้วจบ leg).
- **assertion เทียบ whole/code/label แล้ว**: `valueEquivalents` `normalise.ts:114`. แต่ไม่รู้จัก mapping รหัส→ชื่อที่ไม่อยู่ในสตริงเดียวกัน.
- **value resolution มี 4 แหล่ง** `resolveValues` `src/generator/value-resolution.ts:1613`, ลำดับที่ `:1658-1663` (relative-date, test-data, repo, db) แล้ว `generated`. แหล่ง `db` (`fromDb` `:1507`) ต้องมี `WOWLIDATOR_DB_URL` ซึ่ง SIT ไม่มี (repos.json มีแค่ localhost humi_demo). **ค่า concrete จาก Test Data (40106337) ไม่ถือเป็น "need"** (`findUnresolvedValues` `:678`) จึงไม่ถูกแตะ. ที่มาของค่าเก็บใน `FlowStep.valueSource` (`src/engine/runner.ts:538-546`) และต่อท้าย intent (`value-resolution.ts:1690-1696`); reporter/Excel/wowUI แสดงอยู่แล้ว.
- **การอ่าน Test Data**: `testDataPairs` `src/catalog/test-case-table.ts:641` แตกบรรทัดอัด (`Position = 40106337 Job Code = MKB12.12`) เป็นคู่ได้แล้ว; `unconfirmedValue` `:722` กันค่า `= ?`; `caseCard` `src/cli/commands/authoring.ts:859` ยัด Test Data 420 ตัวอักษรลง `Flow.caseContext`.
- **เคสที่ไม่ได้รัน = blocked**: 4 เลนก่อนรันใน `src/cli/run-cases.ts:958-1010` (authoring refused, dependency, vacuous, exclusivity) ทุกเลนเขียน `collected[index] = {verdict:'blocked', reason}` + `noteOutcome` ลง ledger. `dependencyStanding` `src/cli/case-plan.ts:559` เป็น gate เคส→เคส (pure). `BlockedOutcome` `src/engine/proof-bundle.ts:449` เป็น outcome **ระดับ action ของ agent** (reason: capability/provenance/approval/guardrail) ไม่ใช่ระดับเคส. `TargetProvenance` `mutation-policy.ts` reset ทุก `run()` จึงใช้เป็นที่เก็บ master data ข้ามเคสไม่ได้.
- **ล็อกข้อมูลระดับ step**: `dataWindows`/`SectionLocks`/`dataGateFor` `src/cli/data-locks.ts`, key เป็น `route:…` / `table:…` / `*` (`sections.ts:90-118`). ยังไม่มี key ระดับ entity.
- **ledger**: `LedgerOutcome` `src/cli/suite-progress.ts:33-86` มี `dependsOn`, `authoringRefused`, `knownResult`; `SuiteLedger` `:91` มี `dbBaseline`. ไม่มีที่เก็บ allocation.
- **capture tab ไม่มี NetworkObserver**: `NetworkObserver.attach` ถูกเรียกที่ `runner.ts:2271` เท่านั้น; `openCaptureTab` `authoring.ts:1800` ไม่แนบ. observer เก็บ `requestBody` แต่ **ไม่เก็บ response body** (`network-observer.ts:85`, ไม่มี `Network.getResponseBody`). capture pilot ห้ามเปิดเมนู (`capture-pilot.ts:44-46`) ดังนั้น request ของ picker จะยิงตอน `--probe` เปิด combobox เท่านั้น.
- **HTTP ผ่าน browser context มีแล้ว**: `BrowserTransport` `src/api/api-client.ts:62` ใช้ `context.request` แชร์ cookie → ยิง foundation API ด้วย session ที่ล็อกอินอยู่ได้ $0, ไม่มี model.
- **ที่จำข้อเท็จจริงของแอปต่อ repo**: `RepoEntry` `src/context/repo-registry.ts:34-69` มี `nav`, `contextDocs`, `dbHint`. เป็นที่ที่เหมาะจะจำ "lookup ของ master data".

## ข้อเสนอ เรียงตามลำดับ

### 1. ประกาศ master-data lookup ต่อแอป แล้วแปลง รหัส→ชื่อที่ UI แสดง ตอน author (M)

**เปลี่ยน**
- ใหม่ `src/context/master-data.ts`: schema ของการประกาศ (zod, ตามกฎ Phase C) เช่น
  `{ field: ['Position','Position Code'], url: '/humi/api/employee-foundation/foundation?type=positions&isActive=true&companyCode={Company}&size=1000&page={page}', code: 'positionCode', label: 'positionName.en', rows: 'data.rows', next: 'data.pagination.hasNextPage', facts: ['vacant','headcount','departmentCode','jobCodeCode'] }` ต่อ 1 field. เก็บใน `RepoEntry.masterData` (`repo-registry.ts:34`) ผ่าน `wow context add <repo> --master-data <file>` แบบเดียวกับ `--context-doc`.
- fetcher: ใช้ `BrowserTransport` (`api-client.ts:62`) บน capture tab ที่ล็อกอินแล้ว (`signInOnCaptureTab` `authoring.ts:1769`), เพจจนหมด (probe5 อ่าน C004 15,915 แถวได้ใน 16 หน้า), cache ต่อ suite ใน memory + `.wowlidator/master-data/<slug>/<type>-<company>.json` (parse ผ่าน `artifacts/schemas.ts`). `{Company}` ถูก bind จากคู่ Test Data ของแถวเดียวกัน (`testDataPairs`).
- แหล่งใหม่ในตัว resolve: ไม่ใช่ใน `resolveValues` (ค่ารหัสไม่ใช่ need) แต่เป็น stage หลัง resolve ก่อน lint ใน `FlowAuthor.author` (`flow-author.ts:2939` จุดที่ `#valueResolution` ทำงานกับ `result.steps`): สำหรับ `selectOption` ที่ selector ชื่อตรง field ที่ประกาศและ `value` ตรง `code` ให้เขียน `step.value = label`, `step.valueSource = { kind: 'master', detail: 'positions 40106337 → "Building Pallet Staff" (C001, vacant, dept 30041915)' }`. เพิ่ม `'master'` ใน `ValueSourceKind` (`value-resolution.ts:331`) และ `StepValueSource.kind` (`runner.ts:544`). intent ต่อท้ายตามแบบเดิม จึงรายงานเห็นทั้งรหัสและชื่อโดยไม่ต้องเพิ่ม field.
- ฝั่ง assertion: `valueEquivalents` (`normalise.ts:114`) รับ mapping เพิ่ม (รหัส ↔ ชื่อ) เพื่อให้ `expectText "40106337"` บนหน้าโปรไฟล์ที่แสดงชื่อผ่านแบบ conceded พร้อม `matchedBy: 'master'`. ไม่ทำข้อนี้ = แก้ input แต่ output check พัง.
- prompt: ส่ง "glossary" ของแถว (`Position 40106337 is shown as "Building Pallet Staff"`) เป็น section แยกป้ายชัดเจนใน `authorEachRow` (`authoring.ts:1224-1233` ข้าง `rowFacts`) แบบเดียวกับ probe report; **ไม่ใช่หลักฐานของ tree** จึงห้ามให้ lint `auditGrounding` นับเป็น selector.

**กัน**: 215 แถวที่ selectOption Position (และ Department/Job Code ที่เป็นรหัสล้วน) วันนี้ miss แน่นอน 100% เพราะ option ไม่มีรหัส. เป็น false failure ที่ `isStateContradiction` ปิดเร็วแต่ยังนับ failed.

**เสี่ยง**: (ก) lookup ประกาศผิด/endpoint เปลี่ยน → ต้องเสื่อมเป็น "ไม่ทราบ ปล่อย step ตามที่ author" ไม่ใช่ block (กฎ never-fatal ของ resolver). (ข) ชื่อซ้ำกันหลาย position (positionName ไม่ unique) → picker เลือกตัวแรกที่ชื่อตรง ซึ่งอาจไม่ใช่รหัสที่สั่ง; ต้องบันทึกใน valueSource ว่า "N positions share this name" และให้ assertion หลังจากนั้นเป็นตัวตัดสิน. (ค) ถ้า API ตอบชื่อแต่ UI แสดงอีกแบบ (th/en ตาม locale) → เลือก `positionName.th` ตาม locale ของ URL (`/humi/th/`), ผิด = miss ธรรมดา ไม่ใช่ false pass.

### 2. Pre-flight ต่อแถวก่อนจ่าย authoring call → `blocked (data)` พร้อมหลักฐาน (M)

**เปลี่ยน**
- ตรวจ 3 อย่างจาก master ที่ข้อ 1 ดึงมาแล้ว: (1) รหัสมีอยู่ (`isActive`), (2) ยัง vacant / headcount เหลือ, (3) **UI เข้าถึงได้**: ยิง request เดียวกับที่ picker ยิง (`page=1&size=500`) แล้วดูว่ารหัสอยู่ใน 500 แถวนั้น. ขนาด 500 ไม่ควร hardcode: เอาจาก request จริงของ picker (ข้อ 6) หรือจากการประกาศ `uiPageSize`.
- จุด hook: `authorEachRow` ก่อน `author.author` (`authoring.ts:1224`). ผลลบ → สร้าง `SuiteCase` แบบ `refusedCaseOf` (`authoring.ts:3262`) แต่ใส่ field ใหม่ `dataBlocked: { rule: 'entity-missing'|'entity-consumed'|'entity-unreachable', field, code, evidence }` แทน `refused` (เพราะ `AUTHORING_REFUSAL_CAP` `suite-progress.ts:89` ไม่ควรนับ; resume ควรตรวจใหม่ทุกครั้ง). ใน `run-cases.ts` เพิ่มเลนที่ 5 ข้าง `:958` เขียน `verdict:'blocked'` + `noteOutcome` พร้อม `dataBlocked` ลง `LedgerOutcome` (`suite-progress.ts:33`). `suiteExit` ให้ exit 3 อยู่แล้ว.
- ไม่ยัดเข้า `BlockedOutcome` ของ proof-bundle (มันคือ outcome ของ action ใน agent leg) และไม่ยัดเข้า `dependencyStanding` (gate เคส→เคส ต้อง pure และไม่ยิงเน็ต). แต่ให้ `dependencyStanding` อ่านเหตุผลของ source ที่ blocked ได้เหมือนเดิม (มันควรอยู่แล้ว `:582-591`).

**กัน**: 151 แถว (29 รหัส) ที่วันนี้เสีย authoring call + browser + ladder แล้วจบ failed ปลอม. ประมาณ 151 × (1 authoring call + ~1-2 นาที browser).

**เสี่ยง — ตัวใหญ่**: "picker เห็นแค่ 500 จาก 5,364" เป็นข้อจำกัดจริงของแอป ถ้า block เงียบ ๆ คือกลบ finding. ต้องออก **1 finding ระดับ suite** (ไม่ใช่ต่อแถว) ในรายงาน: "Position picker loads 500 of 5,364 for C001; 29 sheet positions unreachable by any UI path" ให้คนตัดสินว่าเป็น defect หรือ test-data. และ pre-flight **block ได้เฉพาะเมื่อ API บอก "ไม่"** (หาย/ถูกใช้/นอก 500) ห้ามใช้ API บอก "มี" มาข้ามการพิสูจน์ใน UI — UI ยังต้องพิสูจน์เอง. lookup ล่ม (404/5xx) = unknown → รันตามปกติ ไม่ block.

### 3. entity ที่ถูกใช้แล้ว: ล็อกและตรวจ vacant ซ้ำตอน dispatch แล้ว block ด้วยหลักฐาน (M)

**เปลี่ยน**
- `data-locks.ts` `touched()`/`dataWindows` เพิ่ม section key `entity:position:<code>` จาก `selectOption` ที่มี `valueSource.kind==='master'` (รู้รหัสได้จาก detail) → แถวที่ใช้ position เดียวกันรันทีละแถว (window จาก selectOption ถึง assertion สุดท้าย). S.
- ตรวจซ้ำตอน dispatch (สถานะเปลี่ยนระหว่างรัน ตรวจตอน author ไม่พอ): ใน `run-cases.ts` หลังผ่าน 4 เลน (`~:1015`) ถ้าเคสอ้าง entity ที่ประกาศว่า consumable ให้ GET รหัสนั้น (`search=<code>` ใช้ได้ ตาม probe5 `paramProbes`) ผ่าน client ระดับ suite ที่ล็อกอินไว้ตัวเดียว (ต้องสร้าง: session vault มี storageState อยู่แล้วตาม `src/engine/CLAUDE.md`). ถ้า `vacant=false` และ headcount เต็ม → `blocked (data: consumed by <caseId ที่ผ่านก่อนหน้าใน run นี้>)`, อ้างจาก ledger ว่าเคสไหนใช้รหัสนี้ไปแล้ว.
- ledger: `LedgerOutcome.entities?: { field, code, display, consumed: boolean }[]` เพื่อ resume ตอบได้ว่าใครใช้ไป.

**กัน**: 76-86 แถวหลังแถวแรกที่ผ่านบน 40106337 จะ fail จริงเพราะแอปถูก (position ไม่ว่าง) — วันนี้จะถูกนับ failed และคนไล่หาบั๊กที่ไม่มี. ให้เป็น blocked พร้อมชื่อผู้ใช้ไป.

**เสี่ยง**: ถ้า `multipleIncumbentsAllowed`/`headcount>1` ต้องอ่านค่านั้นก่อน block (probe5 sampleRow มี 53 field รวม `vacant`, `incumbentEmployeeCode`, `headcount`). และ block แบบนี้ทำให้ pass rate ของ sheet "ดูดี" ทั้งที่ 76 แถวไม่ได้พิสูจน์อะไร — รายงานต้องนับ blocked ในตัวหาร (ทำอยู่แล้ว `BlockedEntry`).

### 4. จัดสรร position ว่างต่างกันต่อแถวจาก master (L, opt-in เท่านั้น)

**เปลี่ยน**: flag `--allocate <field>` หรือ token ใน sheet `Position = <ANY_VACANT_POSITION>`; allocator เลือกจาก master ที่ `vacant && companyCode && departmentCode && jobCodeCode` ตรงกับคู่ Test Data อื่นของแถว **และ** ทุก field ที่ position กำหนดและ Expected Output อ้าง (costCenter, businessUnit, division, workLocation, ssoLocation, payGrade — ดู probe5 sampleRow) ต้องตรงกับที่แถวเขียน ไม่งั้นไม่จัดสรร. สถานะการจัดสรรใน `SuiteLedger.allocations` (`suite-progress.ts:91`) เพื่อ resume ใช้รหัสเดิม; ป้องกันแจกซ้ำใน run ด้วย `EntityPool` ระดับ suite ข้าง `SectionLocks` (`run-cases.ts:667`). valueSource kind `'allocated'` และ badge ในรายงานเหมือน `generated`.

**กัน**: ทำให้ 77-87 แถวบน 40106337 รันได้จริงแทนที่จะ blocked (ข้อ 3).

**เสี่ยง — สูงสุดในชุดนี้**: มันเขียน Test Data ใหม่. ผู้เขียน sheet อาจเลือก 40106337 เพราะคุณสมบัติเฉพาะ (SSO location, pay grade) และ Expected Output อาจ quote ค่า derived; เลือกผิด 1 field = fail ปลอมที่หาเหตุยาก, เลือกตรงหมด = ยังเป็น "การเดา" ที่ต้องติดป้ายเสมอ. จึงต้อง opt-in และมี field-consistency check. ทางเลือกที่ถูกกว่า: ให้ sheet ระบุ position หลายรหัส (ดูข้อ 7).

### 5. เรียนรู้รูปแบบที่ UI แสดงจาก miss แล้วจำไว้ทั้ง suite (S/M)

**เปลี่ยน**
- runtime, $0: ใน `selectFromListbox` (`listbox.ts`) เมื่อพิมพ์ค่าแล้ว list เหลือ **1 option พอดี** และค่าที่พิมพ์เป็น prefix ที่ขอบคำของ option (Thai → **Thai**land - Thailand) ให้เลือกและบันทึก `matchedBy: 'unique-filtered'` + runtime note ระดับ low แบบ `#flagOverExactName` (`runner.ts:5600`) "quote what the page shows". ห้ามใช้กับค่าที่เป็นตัวเลขล้วน ("10" → "100 - X" คือเดาผิดได้). ยังคงโยน `ListboxOptionMissingError` เมื่อเหลือ >1 หรือไม่ใช่ prefix.
- persist: `.wowlidator/display-forms.json` key `${scopeUrl(page)} :: ${field} :: ${value}` → `{display, hits, lastUsedAt}` ตามแบบ `HealedSelectorEntry` (`cache-manager.ts:19-40`, flush แบบ merge `:110+`). อ่านตอน author เป็นแหล่ง `'learned'` ใน stage ของข้อ 1 และเป็น candidate เพิ่มใน `optionCandidates` (`listbox.ts:144`) ตอนรัน. miss ซ้ำบน entry ที่จำไว้ = ลบ entry (แบบเดียวกับ cache heal ที่ stale).

**กัน**: 21 แถว `Nationality = Thai` (และ 67 แถว `TH` ถ้า picking_lists ISOCountryList ถูกประกาศในข้อ 1) + label พ้องอื่น ๆ ที่วันนี้จบ "1 shown: Thailand - Thailand" เป็น failed; แถวถัดไปไม่จ่าย turn/ladder ซ้ำ.

**เสี่ยง**: unique-survivor คือการยอมรับแบบ conceded — ต้องเห็นในรายงานทุกครั้ง (matchedBy มีอยู่แล้ว). mapping เก่าค้างเมื่อแอปเปลี่ยนคำ → ตกไปเป็น miss ธรรมดาแล้วลบ ไม่ใช่ false pass.

### 6. จับ request จริงของ picker ตอน `--probe` เพื่อ seed การประกาศและขนาดหน้าที่ UI โหลด (S/M)

**เปลี่ยน**: แนบ `NetworkObserver.attach` (`network-observer.ts:176`) กับ capture tab ระหว่าง `probeInteractions` (probe เป็นตัวเดียวที่เปิด combobox; pilot ห้าม) แล้วบันทึกต่อ combobox: URL + query ของ XHR ที่ยิงตอนเปิด (`type=positions&size=500&companyCode=…`) ลง `RepoEntry.masterData[].observedRequest` (แบบ `nav`). ไม่ต้องเก็บ body. ข้อ 1-2 ใช้ค่านี้แทนตัวเลข 500 ที่เดาเอง.

**กัน**: การประกาศด้วยมือผิด endpoint/ขนาดหน้า; ทำให้ "เข้าถึงได้ใน UI" เป็นข้อเท็จจริงที่วัดจากแอป ไม่ใช่ตัวเลขใน config.

**เสี่ยง**: probe เปิดได้ระดับเดียวและเฉพาะ ARIA disclosure; picker บางตัวไม่ยิง XHR จนพิมพ์ → เห็นเฉพาะที่ยิงตอนเปิด (บอกไว้ในรายงาน probe ว่า "no request observed").

### 7. รูปแบบ sheet: อะไรควรอยู่ในไฟล์เคส อะไรควรอยู่ใน wowlidator (S, กระบวนการ)

- **อย่าเพิ่มคอลัมน์ "Expected UI label"** — ข้อความที่แอปแสดงเป็นข้อเท็จจริงของแอป ไม่ใช่ของ sheet; กฎ "the tree's rendering, never the sheet's wording" (`src/generator/CLAUDE.md:90`) มีไว้กันสิ่งนี้พอดี. คอลัมน์แบบนั้นจะเก่าเร็วและทำให้ test พิสูจน์คำใน sheet แทนคำในแอป.
- **เก็บรหัสไว้ใน sheet (ดีอยู่แล้ว)** — รหัสคือ key ที่เสถียร; ให้ mapping รหัส→ชื่ออยู่ใน wowlidator ผ่านการประกาศ lookup ต่อแอป (ข้อ 1) ครั้งเดียว.
- **ใช้รหัสให้สม่ำเสมอ**: `Nationality` มีทั้ง `TH` (67) และ `Thai` (21) — เลือก `TH` (ISO ตรงกับ `picking_lists&id=ISOCountryList`). `Employee Group = A - Permanent Employee Sub Group = 10` เป็นบรรทัดอัด parser แยกได้ แต่ควรแยกบรรทัดให้คนอ่านง่าย.
- **บอกเจตนาเรื่อง consumable**: แถวที่ "ต้องการ position ว่างอะไรก็ได้ใน dept นี้" ให้เขียน token `Position = <ANY_VACANT_POSITION>` (resolver รองรับ `<TOKEN>` อยู่แล้ว `value-resolution.ts:81`) เพื่อให้ข้อ 4 จัดสรรได้โดยไม่ต้องเดาเจตนา; แถวที่ต้องเป็น 40106337 จริง ๆ ปล่อยรหัสไว้และรับว่าจะรันได้แถวเดียวต่อรอบ (หรือให้ชุดข้อมูล TD-01..TD-nn ระบุรหัสต่างกัน).
- **เลือกรหัสที่ UI เข้าถึงได้**: 29 รหัสอยู่นอก 500 แถวแรก; ถ้าเจตนาคือทดสอบว่า picker หาได้ ให้เขียนใน Steps ว่าค้นด้วยชื่อ ไม่ใช่ปล่อยให้ผู้ทดสอบเดา.

### 8. เส้นทางถูกที่สุดถ้าไม่มีเวลาทำข้อ 1: script probe เป็นคำสั่ง `wow data check <catalog>` (S)

เอา logic ของ probe5/probe6 (อ่าน master ต่อ company, intersect กับรหัสใน sheet, เช็ค 500 แถวแรก, เช็ค vacant) มาเป็นคำสั่ง CLI ที่พิมพ์ตารางต่อแถว: exists / vacant / reachable / shared-with. ไม่แตะ authoring, ไม่แตะ runner, ใช้ `BrowserTransport` + `testDataPairs`. ให้คนแก้ sheet ก่อนรัน. ได้ประโยชน์ 151+77 แถวทันทีโดยไม่เพิ่มความเสี่ยงกลบ defect เพราะไม่มีการ block อัตโนมัติ.

## ลำดับที่แนะนำและเหตุผลสั้น

1. ข้อ 8 ก่อน (S, วันเดียว) — ได้ตัวเลขให้ทีม sheet แก้ทันที
2. ข้อ 1 + assertion half (M) — แก้ต้นเหตุ 215 แถว
3. ข้อ 2 (M) — หยุดเผา authoring/browser กับ 151 แถว, พร้อม finding ระดับ suite
4. ข้อ 5 (S/M) — ปิดคำพ้อง "Thai"
5. ข้อ 3 (M) — ให้แถวที่ 2..N บน position เดียวเป็น blocked มีชื่อผู้ใช้ไป ไม่ใช่ failed
6. ข้อ 6 (S/M) — เลิก hardcode 500
7. ข้อ 4 (L) — เฉพาะเมื่อ sheet ประกาศเจตนาด้วย token

## ความเสี่ยงร่วม (กลบ defect จริง)

- ทุกการ block ต้องมาจาก API บอก "ไม่มี/ไม่ว่าง/นอกหน้าที่ UI โหลด" เท่านั้น. API บอก "มี" ไม่มีน้ำหนักแทน UI.
- lookup พัง = ไม่ทราบ = รันตามปกติ. ห้ามให้ config ที่เก่า block ทั้ง suite.
- picker cap 500 เป็น finding ต้องขึ้นรายงาน 1 ครั้งต่อ suite ไม่ว่าจะ block กี่แถว.
- ทุกค่าที่ wowlidator เปลี่ยนจากที่ sheet เขียน (ชื่อแทนรหัส, จัดสรร, เรียนรู้จาก miss) ต้องมี `valueSource` และ badge ในรายงาน เหมือน `generated` วันนี้.
- `blocked (data)` ห้ามนับเข้า `AUTHORING_REFUSAL_CAP` และต้องตรวจใหม่ทุก `--resume`.
