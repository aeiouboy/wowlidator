# แผนปรับปรุง QA verification agent — รวมจาก 6 รายงานสำรวจ (2026-09-05)

ที่มา: `explore-cost.md`, `explore-throughput.md`, `explore-verdicts.md`, `explore-data-grounding.md`, `explore-defect-reporting.md`, `explore-external.md` (ทั้งหมดใน scratchpad เดียวกัน) วัดจาก EC catalog 272 เคสบน humi SIT, claude-cli/opus, ~988 model call, ~176 USD

## ชั้น A — bug ที่ยืนยันแล้ว แก้สั้น ทำก่อน resume รอบหน้า

| # | bug | ที่ | ผล | ขนาด |
|---|---|---|---|---|
| A1 | โหลด `.env` หลังอ่าน `--as`/`--persona` | `src/cli.ts` | persona ใน `.env` มองไม่เห็น 308 เคสถูกปฏิเสธ | แก้แล้ว ยังไม่ commit |
| A2 | `routeSectionOf` ตัด locale เฉพาะตำแหน่งแรก | `src/cli/sections.ts:86` | ทุกหน้า `/humi/th/...` เป็น section เดียว เลนรอ lock 20-26% ของเวลา สูงสุด 549 s ต่อเคส | S |
| A3 | `baseUrl = originOf(url)` ตัด base path `/humi` | `src/generator/flow-author.ts:4064` → `src/api/api-actions.ts:394` | request step ยิง `/api/...` แทน `/humi/api/...` ได้ 404 จาก gateway 27 ครั้ง 6 เคส consent ตัดสินผิด | S (ใช้ `deploymentRoutePath` ใน `src/context/route-match.ts:220-235` ที่คำนวณ basePath อยู่แล้ว) |
| A4 | `scenarioFromId` regex ไม่ match `HIR-EC-006` และ `cmdCatalogReport` ไม่ส่ง `scenarioOf` | `src/cli/catalog-live-report.ts:41` | 269 เคสกองใน "ungrouped" ในรายงาน | S |
| A5 | warm session 1-turn นั่งกิน slot ~90 s หลังตอบ | `src/providers/claude-cli-session.ts` (prune) | 22% ของ generator call ตกไป cold (+24 s, +0.046 USD ต่อ call) | S |
| A6 | `listboxCannotOffer` เทียบชื่อ control ข้ามภาษา ("Position" vs "ตำแหน่ง") | `src/orchestrator/agent-guards.ts:815-818` | judge ไม่ยิงกับ picker ไทย เคสจบเป็น "gave up" แทนหลักฐาน | S แต่ต้องคู่กับ B6 |

## ชั้น B — ลด token/เวลา ด้วยค่าตั้งหรือแก้เล็ก

| # | ข้อเสนอ | ประหยัด (ของยอดรวม) | ขนาด | เสี่ยง |
|---|---|---|---|---|
| B1 | จำกัด retrieval ต่อ authoring ask (`budget=2`, hits 8→4, chars 1600→800, บอกใน system prompt ว่าค้นได้เมื่อ evidence ไม่มี) | 21-25% | S-M | โมเดลเห็นโค้ดน้อยลง วัดด้วย A/B ก่อน |
| B2 | risk judge ไม่ค้น retrieval และไม่ re-author เมื่อ fail-fast มาจาก expected-fail (29/59 re-ask แก้ไม่ได้โดยนิยาม) | ~15% | S | ต่ำ |
| B3 | agent/healer/data ไป sonnet (generator คง opus) | 11-23% | S (env) | agent ตัดสินใจเล็ก คุณภาพ flow ไม่เปลี่ยน |
| B4 | `WOWLIDATOR_STOP_AFTER_FIRST_ISSUE=on` สำหรับรอบ throughput | เวลาต่อเคสพัง 80 s → ~20 s ≈ −25% เวลาเคส | dial | เสีย defect ปลายทางที่เป็น cascade อยู่แล้ว |
| B5 | ย้าย lint ที่โดนบ่อยสุด 3 ตัวไปหน้า prompt แบบโครงสร้าง (script-to-end, perform-the-verb, wording-not-row) | ~9% ถ้าลด re-ask ครึ่ง | M | ต่ำ |
| B6 | listbox unique-prefix pick ("Thai" → "Thailand - Thailand" เมื่อ match ตัวเดียว) + read-back เดิม | ประหยัด 1 เทิร์นต่อ miss | S | ต้องมี read-back ตรวจ |
| B7 | fail-fast cap = max(15, goalOutcomes + slack) ใต้ 60 สำหรับ goal แบบฟอร์ม | เคส wizard ไม่ตายที่ 15 (5 leg วันนี้ 20-26 ช่อง) | S | ไม่ปล่อยตาม progress (เคย runaway 101 เทิร์น) |

## ชั้น C — ความสามารถใหม่ (M/L)

| # | ข้อเสนอ | แก้ปัญหา | ขนาด |
|---|---|---|---|
| C1 | **Resume จาก flow ที่ author แล้ว** เก็บ flow ลง ledger, SIGTERM/quota hold ไม่ทิ้งงานแต่ง (17+11 ไฟล์วันนี้) | ค่าแต่งซ้ำหลังหยุด | M |
| C2 | **Quota hold ใน process** poll `sessionQuotaPoint()` ผ่าน `runQueue.waitWhile` + gate ฝั่ง authoring หยุดที่ cap−12 รอ `resetsAt` แล้วไปต่อเอง + บรรทัดพยากรณ์ "ที่ rate นี้ พอ N เคสใน session / M เคสในสัปดาห์" ทุก 5 เคส | ตายกลางเคส เสียเลน | M |
| C3 | **Typed stop reason บน AgentRecord** (`endedBy`: exhausted / stalled / cannot-offer / value-never-appeared / menu-absent / agent-claim) → runner โยน error คนละชนิด: page-evidence → `failed` พร้อม expected/actual, harness-class → `error`, agent-claim → "unverified account" | ทุก leg ที่ล้มเป็น `error` เหมือนกันหมด | M |
| C4 | **Findings projection ในรายงาน** signature deterministic (endpoint+status, control+page, listbox shown, blocked reason) → "N findings affecting M cases" + export .md/.xlsx สำหรับทีมแอป ไม่ใช้โมเดล + trend ระดับ finding + พับ never-ran/authoring refused | 70 คำตัดสินแยก แทน 5 ต้นเหตุ; API content-management 500 ทุกหน้าไม่มีใครเห็น | M |
| C5 | **Master-data grounding** ประกาศ lookup ต่อแอป (foundation API) แปลงรหัส→ชื่อที่ UI แสดงตอน author; pre-flight ต่อแถว (มีจริง / vacant / อยู่ใน 500 ที่ picker โหลด) → `blocked (data)` พร้อมหลักฐานก่อนจ่าย authoring call; จำ mapping จาก miss ทั้ง suite | 151 แถวไปไม่ถึงจาก UI, 77 แถวแย่ง position เดียว, "Thai" vs "Thailand" | M (เริ่มด้วย `wow data check <catalog>` = S) |
| C6 | **Response body จาก call ของหน้าเอง** (lazy `Network.getResponseBody` เฉพาะ JSON) → ตอน cannot-offer: ค่าอยู่ใน body แต่ไม่โชว์ = defect แอป; อยู่หน้า k ที่ UI ไม่ขอ = ข้อจำกัดแอป; ไม่พบเลย = test data | verdict สามทางมีหลักฐาน | L |
| C7 | **Induced skills / row template** จำ journey ที่สำเร็จ (wizard) เป็น skill แบบตัดค่าเป็น slot ให้แถวพี่น้องใช้ซ้ำ; แถวที่ Steps เหมือนกันใช้ flow เดิมแทนค่า Test Data ใหม่ $0 | ค่าแต่งเทสซ้ำ 269 scenario ที่คล้ายกัน | L |
| C8 | **Benchmark ของตัว agent เอง** proof bundle ที่ติดป้าย + seeded fault + รันซ้ำ วัด precision/recall ของ verdict | ไม่มีตัววัดว่าแก้แล้วดีขึ้นจริง | M |

## ลำดับที่แนะนำ

1. A2, A3, A4, A5, A6+B6 (ทั้งหมด S) + commit A1 → resume รอบหน้าเก็บผล consent ใหม่ได้ถูกต้อง
2. B2, B3, B7 (env + S) → รอบเดียวกันเลย
3. B1, C1, C2 → ทำให้ full run รอบต่อไปจบในสัปดาห์เดียว ไม่ตายกลางเคส
4. C3 → C4 → C5 → C6 (คุณภาพ verdict + รายงาน)
5. C7, C8 ระยะยาว

## กฎที่ทุกข้อต้องไม่ละเมิด
- claim ของ agent ไม่ใช่หลักฐาน (C3/C6 ต้องยึด evidence จากหน้า/network)
- reporter เป็น pure function ของ bundle; status ผิดแก้ที่ seal ไม่ใช่ relabel (C4)
- แก้ test data ต้องไม่กลบ defect จริง (C5 ให้ออกเป็น `blocked (data)` พร้อมหลักฐาน ไม่ใช่เปลี่ยนค่าเงียบ ๆ)
