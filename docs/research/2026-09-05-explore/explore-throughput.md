# explore-throughput — ทำให้ catalog run 272 เคสเร็วขึ้นและรู้จัก quota

วันที่ 2026-09-05. อ่านจาก code (read-only) + log 3 attempt + `.wowlidator/claude-cli-usage.jsonl` + ledger + proof bundle 34 ไฟล์

## สรุปสั้น

ตัวที่ทำให้ช้าไม่ใช่ browser และไม่ใช่ video. มี 3 ตัวใหญ่:

1. **data lock ล็อกทุกเคสไว้ที่ section เดียว** เพราะ URL ของแอปนี้ขึ้นต้นด้วย `/humi/th/...` และ `routeSectionOf` ไม่ตัด prefix ออก ทุกหน้ากลายเป็น `route:humi/th` และหน้า login ก็ไม่ถูกรู้ว่าเป็น login. lane รอ lock รวม 2,808 s ใน attempt 2 (20% ของเวลา lane) และ 2,251 s ใน attempt 3 (26%). แถมมันปั๊ม "interference" 19 ครั้ง ซึ่งจะทำให้ตอนจบ run ต้องรันซ้ำทีละเคสแบบ serial
2. **quota คือกำแพงจริง** ไม่ใช่ CPU. เผา session window ~1.4%/นาที ที่ full speed. window 5 ชั่วโมงหมดใน ~60 นาที แล้วต้องรอ ~4 ชั่วโมง. ตอนนี้ตายกลางเคส เสีย 8 lane ที่กำลังรัน + flow ที่ author เสร็จแล้ว 17 ไฟล์ (attempt 2) และ 11 ไฟล์ (attempt 3) ทิ้งหมด แล้ว `--resume` author ใหม่ทุกไฟล์
3. **authoring แพงกว่า run 2.4 เท่า** ($62 vs $26 ใน attempt 2) เพราะ 27 จาก 41 แถวถูก author สองรอบ (re-author เมื่อ risk judge ให้ fail-fast)

## ตัวเลขที่วัดได้ (attempt 2, 06:40–07:09, 29 นาที, pid 22505)

| หัวข้อ | ค่า | ที่มา |
|---|---|---|
| เคสได้ verdict | 19 (+3 refused) | ledger `at` ในช่วงเวลา |
| flow ที่ queue แล้ว | 36 | `queued` ใน log |
| flow ที่ author เสร็จแต่โดน SIGTERM ทิ้ง | 17 (ทั้ง 17 ถูก author ใหม่ใน attempt 3) | เทียบ queued กับ ledger |
| model calls / cost | 526 calls, $89.04 | usage.jsonl |
| generator | 225 calls, $61.85, avg 58.8 s, cold 58 | usage.jsonl |
| agent | 286 calls, $26.25, avg 6.9 s | usage.jsonl |
| session window | 38% → 79% = 41 pt ใน 29 นาที = **1.4 pt/นาที**, **$2.17/pt** | ⛽ lines |
| weekly | ทั้งวัน 4% → 19% = 15 pt สำหรับ $180 = **$12/pt**, 0.29 pt ต่อ outcome | ⛽ lines |
| lock wait | 11 จาก 14 lock รอ, รวม 2,808 s, สูงสุด 549 s | `data lock: took ... after waiting` |
| interference stamps | 13 (attempt 2) + 6 (attempt 3) + 1 | `verdict provisional` |
| cold generator call | avg 81 s, $0.33 | usage.jsonl |
| warm generator call (answer > 2k tok) | avg 77 s, $0.34 | usage.jsonl |

เวลาต่อเคส (34 proof bundle ที่รันจริง):

| ส่วน | เฉลี่ยต่อเคส | หมายเหตุ |
|---|---|---|
| ทั้งเคส (`caseDurationMs`) | 228 s | เคส HIR 400–680 s, เคส CNS 4–60 s |
| step ปกติ (ไม่ใช่ workflow) | 48 s | รวม sign-in 2 s, goto < 1 s |
| workflow legs (agent) | 46 s | 7.8 agent turns/เคส, 24–46 turns ในเคส HIR |
| เวลาใน step ที่พัง (ladder + heal + reconstruct + assist) | 80 s | เคสพังเฉลี่ย 5.6 step พัง, step พังละ 5–20 s timeout + 7–10 s model |
| รอ data lock | 255 s ต่อเคสที่รอ (11 จาก 19) | ไม่อยู่ใน step ใดเลย; HIR-EC-073 ใช้ 566 s แต่ step รวม 14 s |
| video | วัดไม่ได้ว่ากินเวลา | film 0.1–1.2 MB, condense ตอน seal ครั้งเดียวต่อเคส |

authoring ต่อแถว (ดู [PRB-EC-062], [HIR-EC-021], [CNS-EC-023] ใน log):
author 36–89 s → grounding review (agent role) 11–18 s → risk 14–31 s → **ถ้า risk > 50% ทำซ้ำอีกรอบ** (author 84–89 s + review + risk). แถวเดียว ≈ 100 s หรือ ≈ 250 s. 27 จาก 41 แถวทำสองรอบ. รวมเฉลี่ย ≈ 190 s serial ต่อแถว → 8 workers ≈ 2.5 แถว/นาทีในทฤษฎี, วัดได้ 1.8 แถว/นาที

## คำตอบ 5 ข้อ

### 1. Pipeline balance

- สมดุล: authoring ≈ 190 s/แถว serial, run ≈ 228 s/เคส. A:C ≈ 0.85 → **8 authors : 8 lanes ถูกแล้ว**. แถวที่ refused/blocked ไม่ใช้ lane เลย ดังนั้น author เยอะกว่านิดหน่อยได้
- browsers 8 ไม่ใช่คอขวด. step ที่ผ่านใช้ 0–2 s. ไม่ต้องเพิ่ม
- warm pool cap: pool แยกตาม key (system prompt + schema อยู่ใน `sessionKeyOf`, `src/providers/claude-cli-session.ts:187-205`). author key ต้องการ `workers` ช่อง, agent key ต้องการ `concurrency` ช่อง. `raiseSessionCapFor` ให้ max(4, n+1) ทั้งสองที่ (`authoring.ts:992`, `run-cases.ts:932`) → **cap ไม่ต้องตาม author+lanes**. ที่ล้น 60 ครั้งเป็น bug prune (ข้อเสนอ 6)
- dependency gate: `dependencyStanding` (`case-plan.ts:559-594`) ตอบ `'defer'` (`run-cases.ts:752-762`) ไม่ block หัวคิว. ผลต่อ parallelism น้อย. แต่ 5 จาก 51 outcome (PRB-EC-038/039/066/021, CNS-EC-009) **ถูก author แล้วค่อย blocked** เพราะ source พัง → เสียค่า author เปล่า
- data sections/locks: **นี่คือตัวกิน parallelism จริง**. ดูข้อเสนอ 1
- ScenarioGate: catalog นี้ 272 เคส / 269 scenario. ถ้าไม่ใส่ `--author-lookahead all` gate จะ lookahead 0 (`authoring.ts:3234-3238`) → author scenario ถัดไปได้ต่อเมื่อ scenario ก่อนหน้า**รันจบ** → เหลือ ~1 เคสต่อครั้ง. วันนี้รอดเพราะใส่ flag. ควร auto-off เมื่อ scenario ≈ แถว (ข้อเสนอ 8)

### 2. Quota-aware pacing

ที่ควรอยู่: `runQueue` มี `waitWhile` แล้ว (`case-plan.ts:767, 800-803, 810`) ตอนนี้ใช้กับ `governorHold` (`run-cases.ts:1352`). เพิ่ม `QuotaHold` ที่ poll `sessionQuotaPoint()` (`claude-quota.ts:308-315`, มี `resetsAt`) ทุก TTL. hold เมื่อ session% ≥ cap − headroom, ปล่อยเมื่อ `now ≥ resetsAt` และอ่านใหม่ (`force=true`) เห็น window reset. ฝั่ง authoring ต้อง hold ด้วย: `mapPool` มีแค่ `shouldStop` ที่หยุดถาวร (`case-plan.ts:632-645`) → เช็ค hold ก่อน model call ที่จุดเดียวกับ `gate.waitFor` (`authoring.ts:1084`). headroom: ตอน hold มี 8 lanes × ~$1.4 + 8 authors × ~$1.5 ≈ $23 ≈ 11 pt → **hold ที่ cap − 12** (เช่น 78% เมื่อ cap 90). ปฏิสัมพันธ์: `assertUnderUsageCap` (`claude-cli.ts:418`) เป็น backstop (throw → เคส blocked → resume รันใหม่). panel `UsageCapGuard` ฆ่า job ด้วย SIGINT แล้ว SIGKILL (`jobs.ts:452-454`) → ต้องตั้ง cap ของ guard ≥ hold + 12 ไม่งั้น guard ฆ่าก่อน hold ทำงาน. pause file / SIGUSR2 ยังใช้ได้ระหว่าง hold เพราะ `runQueue` เช็ค `shouldPause` ใน loop ของ `waitWhile`. ทางเลือก exit + cron resume แย่กว่า: Chrome pool กับ warm session ต้องเริ่มใหม่ และต้องมีข้อเสนอ 2 ก่อนไม่งั้นเสีย flow

### 3. Budget forecasting

ข้อมูลมีครบ: `sessionQuotaPoint` (session + resetsAt), แถว weekly ใน `fetchClaudeQuota().limits` (kind `weekly_*`), `remaining(ledger)` (`suite-progress.ts:339`). พิมพ์ใน `noteOutcome` (`run-cases.ts:387-405`) ทุก K=5 outcome: Δsession% และ Δweek% ตั้งแต่เริ่ม ÷ outcome → "at this rate: N fit before hold at 78% (resets HH:MM), M fit in the week; catalog needs R". ledger ไม่มี cost → เพิ่ม `quotaAtStart/quotaAtEnd` ใน ledger เพื่อให้ resume เริ่มพยากรณ์ด้วยอัตราของ pass ก่อน. usage.jsonl ไม่มี run key/case id ใช้ยาก. ตัวเลขวันนี้: 0.29 week-pt/outcome × 258 ที่เหลือ = 76 pt → 19 + 76 = **95%** พอดีขอบ. รันซ้ำอะไรก็เกิน

### 4. เวลาไปไหน + speedup ถูกสุด

ดูตาราง. 3 อย่างที่ถูกสุด:
1. แก้ `routeSectionOf` (ข้อเสนอ 1) คืน 20–26% ของ lane time และเลี่ยง solo re-run ท้าย run
2. `WOWLIDATOR_STOP_AFTER_FIRST_ISSUE=on` (มีอยู่แล้ว, `runner.ts:8541, 8877, 9095`): เคสพังเฉลี่ย 5.6 step พัง, step พังละ 5–20 s + heal/reconstruct 7–10 s + agent assist. หยุดที่ step แรกลด failMs 80 s → ~20 s ≈ **−25% เวลาเคส**. เสีย evidence ของ step หลังจากนั้น (รอบแรกรับได้)
3. `WOWLIDATOR_AGENT_MAX_STEPS=10` (มีอยู่แล้ว, `runner.ts:388-394`) ตัด leg ที่ล้มเหลวอยู่ดี (ข้อเสนอ 5)
video ไม่ใช่: `--video off` ประหยัด CPU ของ Chrome แต่ไม่โผล่ใน step time เลย

### 5. Resume granularity

ตอนนี้**ไม่ได้**. ledger บันทึกเฉพาะเคสที่จบ (`noteOutcome` ใน `settle`, `run-cases.ts:1243`). flow ที่ queue อยู่บนดิสก์ (`authoring.ts:3366-3378`) แต่ ledger ไม่รู้ path. `--resume` author ใหม่จาก sheet (`authoring.ts:3041-3043` เขียนไว้ตรงๆ ว่าไม่ reuse flow file). ต้องทำอะไร: ดูข้อเสนอ 2

## ข้อเสนอเรียงลำดับ

### 1. แก้ route section สำหรับแอปที่มี base path (S)

- **แก้**: `routeSectionOf` (`src/cli/sections.ts:77-92`) ตัด locale ที่อยู่ใน 2 segment แรกไม่ใช่แค่ตัวแรก (`/humi/th/admin/hire` → head `admin`), และเช็ค login กับทุก segment ไม่ใช่แค่ head (`/humi/th/login` ต้องคืน null). ทางเลือก: env `WOWLIDATOR_ROUTE_BASE=/humi` หรือ derive จาก `--url`. test ใน `tests/sections.test.ts`, `tests/data-locks.test.ts`
- **ทำไม**: ทุก URL ของแอปนี้ map เป็น `route:humi/th` (7 จาก 14 lock ใน attempt 2, 7 จาก 8 ใน attempt 3). หน้า login ไม่ถูกจับ → flow ที่ login ด้วย `fill` เปิด window ตั้งแต่ step 1 (HIR-EC-073 ถือ lock step 1–10). `windowsInterfere` (`sections.ts:199-209`) ก็ใช้ section เดียวกัน → ทุกเคสที่ไม่ pass โดนปั๊ม interference (13+6 ครั้ง) → `pendingSoloReruns` (`run-cases.ts:1283-1328, 1375-1386`) รันซ้ำทีละเคสท้าย run
- **ผล wall**: lane ว่างเพิ่ม 20–26% → run-rate 0.66 → ~0.8 เคส/นาที. หลีกเลี่ยง solo re-run ท้าย run ≈ 19 × 228 s ≈ 72 นาที serial ต่อ 51 outcome; ทั้ง 272 เคส ≈ 100+ เคส × 228 s ≈ 6 ชั่วโมง serial ที่หายไป
- **ผล quota**: solo re-run จ่าย agent turn ใหม่ (~$1/เคส) → ประหยัด ~50 session-pt ทั้ง run
- **เสี่ยง**: ต่ำ. section ตอนนี้ไม่มีความหมายอยู่แล้ว การแก้ทำให้มีความหมาย

### 2. Resume จาก flow ที่ author แล้ว (M)

- **แก้**: (a) เพิ่ม `SuiteLedger.authored: Record<id, {flowPath, risk?, generatedAt}>` เขียนตอน push เข้า queue (hook ใหม่ `noteAuthored` ข้าง `noteOutcome` ใน `run-cases.ts`, หรือใน `onCase` ที่ `authoring.ts:3366-3390`). (b) ตอน resume: id ใน `remaining()` ที่มี `authored` และไม่ `vacuous`/refused → อ่าน flow file ผ่าน zod schema (กฎ Phase C, `src/artifacts/schemas.ts`) แล้ว push เข้า queue ตรง ๆ ข้าม `authorRow`. unique key ยังตรงเพราะ runKey เดิม (`substituteUniqueKeys`, `authoring.ts:1066`). (c) เสริม: ชะลอ author ของแถวที่มี `dependsOn` จนกว่า source จะมี verdict และ author เฉพาะเมื่อ pass
- **ผล**: ทุกครั้งที่หยุด (pause/quota/SIGTERM) ประหยัด 17 แถว × 190 s ÷ 8 workers ≈ 6–7 นาที wall และ $20–29 ≈ 10–13 session-pt, ~2 week-pt. ถ้ามี quota hold (ข้อ 3) จะหยุด ≥ 3–4 ครั้งต่อ run → ~40–50 session-pt, ~8 week-pt
- **เสี่ยง**: flow ที่ author กับ state หน้าเก่า. เท่ากับ pipelined flow ทุกตัวอยู่แล้ว

### 3. Quota hold ใน process (M)

- **แก้**: ตามข้อ 2 ข้างบน. ไฟล์: `run-cases.ts` (สร้าง hold, ส่งเข้า `waitWhile` ร่วมกับ `governorHold`), `case-plan.ts` (`mapPool` รับ `waitWhile`), ที่ใหม่ `src/providers/quota-hold.ts` (poll + resetsAt logic, ทดสอบด้วย `setClaudeQuotaFetcher` seam ที่ `claude-quota.ts:232`). env `WOWLIDATOR_QUOTA_HOLD_PERCENT` (default cap − 12) และ log บรรทัด "holding until HH:MM (session 79% ≥ 78%)"
- **ผล wall**: ไม่เปลี่ยน run-rate. เปลี่ยน "ตายกลางเคส เสีย 8 lane + 17 flow" เป็น "รอแล้วไปต่อ". ledger ไม่มีรอยขาด
- **ผล quota**: เลี่ยงของเสียต่อครั้ง ≈ 8 lanes × $1.4 + flow ที่ทิ้ง (ข้อ 2) ≈ 20 pt
- **เสี่ยง**: process อยู่นานหลายชั่วโมง. Chrome pool idle (ok). warm session ปิดเองหลัง 90 s (ok)

### 4. บรรทัดพยากรณ์ budget (S)

- **แก้**: ตามข้อ 3 ข้างบน ใน `noteOutcome` + ตอนเริ่ม + ตอนจบ. เพิ่ม `quotaAtStart/quotaAtEnd` ใน ledger
- **ผล**: ไม่เปลี่ยนเวลา. ทำให้คนตัดสินใจก่อนหมดสัปดาห์
- **เสี่ยง**: ไม่มี. quota อ่านไม่ได้ → ไม่พิมพ์

### 5. cap agent ต่อ leg สำหรับรอบ throughput (S, เป็น dial ไม่ใช่ code)

- **ทำ**: ใส่ `WOWLIDATOR_AGENT_MAX_STEPS=10` ในคำสั่ง run (dial มีแล้ว `runner.ts:388-394`; fail-fast ใช้ 15 อยู่ `workflow-agent.ts:182`)
- **ทำไม**: agent = 268 calls / 19 เคส = 14 ต่อเคส × 7.2 s ≈ 100 s model + action; HIR 24–46 turns, 400–680 s. 10 จาก 33 verdict จบด้วย "unreachable"/"gave up" คือ turn เหล่านั้นสูญเปล่าอยู่แล้ว
- **ผล**: −30% agent turns ≈ −4 session-pt ต่อ 30 นาที; เคส HIR −100–150 s
- **เสี่ยง**: journey จริงที่ยาวโดนตัด → blocked (harness) ไม่ใช่ failed → resume ด้วย cap สูงกว่าได้. ขัดกับหลัก "หยุดด้วย logic ไม่ใช่ turn count" ของ orchestrator จึงเป็น dial ของ operator ไม่ใช่ default

### 6. bug prune warm pool ทำให้ตก cold (S)

- **แก้**: `askWarm` (`claude-cli-session.ts:487-493`) prune เฉพาะ `spent` (turns ≥ 10, บรรทัด 297-299) แต่ generator budget = 1 (บรรทัด 76, 100). session ที่ตอบไปแล้ว 1 ครั้ง `usableFor(1)` เป็น false (292-294) แต่ไม่ `spent` → นั่งกินช่อง 90 s (`SESSION_IDLE_MS`, บรรทัด 103) จนกว่า idle timer ปิด. 8 workers จบ call ทุก 60–90 s → used-idle + in-flight > 9 → "all 9 warm claude sessions for this key are busy" 60 ครั้ง (attempt 2), 34 ครั้ง (attempt 3). แก้: prune `!busy && turnsTaken >= maxTurns` ของ caller (ปลอดภัยเพราะ key = role เดียว, บรรทัด 289-290) หรือปิด session ทันทีเมื่อ `turns >= budget`
- **ผล**: cold 81 s vs warm 77 s (answer ขนาดเท่ากัน) ≈ 4 s × 58 ≈ 4 นาทีต่อ attempt. quota เท่ากัน ($0.33 vs $0.34) เพราะ budget-1 ไม่มี cache ให้เสียอยู่แล้ว. **ช่องว่าง 78 vs 56 s ที่เห็นส่วนใหญ่มาจากขนาดคำตอบไม่ใช่ cold start**
- **เสี่ยง**: ไม่มี

### 7. ปิด re-author ตาม risk judge สำหรับ catalog นี้ (S, dial ใหม่)

- **ทำ**: `authoring.ts:1303-1347` re-author แถวที่ `fail-fast` หนึ่งครั้ง. 27 จาก 41 แถวโดน แถวละ author + review + risk ≈ 140 s serial, ≈ $0.5–0.6. เพิ่ม env `WOWLIDATOR_RISK_REAUTHOR=off` หรือยก threshold (`dead-end-risk.ts:55 riskThreshold`)
- **ทำไม**: เหตุผลของ judge ใน catalog นี้เป็นฝั่งแอป ("ไม่มีเมนู EC > Consent", route 404) ซึ่ง author ใหม่แก้ไม่ได้
- **ผล**: 258 แถว × 66% × 140 s ÷ 8 ≈ **50 นาที wall**, ≈ $95 ≈ 44 session-pt ≈ 8 week-pt
- **เสี่ยง**: กลาง. comment อ้าง be100 ที่ re-author ช่วยจริง. ต้องวัดว่ากี่แถวที่ re-author แล้ว "ชนะ" (log มี "re-authored —" น้อยมาก แต่ regex ผมไม่แน่นพอ)

### 8. ScenarioGate auto-off เมื่อ scenario ≈ แถว (S)

- **แก้**: `authoring.ts:3233-3239` ถ้า `distinct scenarios / rows > 0.8` ให้ gate = null และ log บอก. กันคนลืม `--author-lookahead all` แล้วได้ ~1 เคสต่อครั้ง (attempt 1 วันนี้เกือบเป็นแบบนั้นด้วย author-concurrency 3)
- **ผล**: ป้องกันไม่ใช่เร่ง. เสี่ยง: ไม่มี

## เลขรวมสำหรับ 272 เคส (เหลือ 258)

ตอนนี้: 0.66 verdict/นาที → 390 นาที run time. session เผา 1.4 pt/นาที → ถึง 90% ใน ~60 นาทีต่อ window → ต้อง ~6.5 window × (1 ชั่วโมงรัน + 4 ชั่วโมงรอ) ≈ **≥ 30 ชั่วโมง wall**, weekly ถึง ~95% (ขอบ), และทุกครั้งที่ตายเสีย ~20 pt

หลังข้อ 1 + 2 + 3 + 5 + 6 + 7 + STOP_AFTER_FIRST_ISSUE (ประมาณการ): เวลาเคส 228 → ~150 s และ lane ว่าง +20% → ~3 เคส/นาที → run time ≈ 90 นาที. ต้นทุน/เคส $2.8 → ~$1.9 ≈ 0.9 session-pt → 258 × 0.9 = 230 pt ≈ 3 window → **≈ 10–13 ชั่วโมง wall**. weekly 258 × $1.9 ÷ $12 ≈ 41 pt → 19 + 41 ≈ **60%**. ตัวเลขนี้เป็นการคูณจากค่าเฉลี่ยวันนี้ ไม่ใช่ผลวัด

## สิ่งที่ยืนยันไม่ได้ / ควรวัดต่อ

- อัตรา "ชนะ" ของ re-author ตาม risk (ข้อ 7) ต้องนับจาก log ด้วย regex ที่แน่นกว่า
- ผลจริงของ `WOWLIDATOR_STOP_AFTER_FIRST_ISSUE=on` ต่อ verdict mix ยังไม่เคยวัดบน catalog นี้
- `summary.session` ใน proof bundle เป็นตัวเลขทั้ง process ไม่ใช่ต่อเคส (HIR-EC-073 บอก 190 calls $28) ใช้พยากรณ์ต่อเคสไม่ได้ ต้องใช้ Δquota แทน
