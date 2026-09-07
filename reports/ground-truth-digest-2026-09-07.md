# Ground truth digest — QA_Task_Tracking_Cycle1 (revised, 2026-09-07 17:29)

เอกสารนี้เทียบ workbook ฉบับแก้ไข (7 ก.ย. 17:29) กับฉบับที่เรารันจริง (4 ก.ย. 14:16) และกับ ledger ของ run ปัจจุบัน

| แหล่ง | ค่า |
|---|---|
| EC rows (เดิม / ใหม่) | 272 / 272 — เพิ่ม 0 ลบ 0 |
| Test Status เดิม | Cancelled 137 · Not Start 103 · Passed 14 · Failed 10 · In Progress 8 |
| Test Status ใหม่ | Cancelled 164 · Not Start 67 · Passed 21 · Failed 17 · In Progress 2 · Blocked 1 |
| แถวที่เนื้อหาเทสถูกแก้ | 105 (Steps 104 · Expected 98) |
| ความยาว Steps เฉลี่ย | 1066 → 2379 ตัวอักษร |
| in scope (ไม่ Cancelled) | **108** จาก 272 |

## 1. ขอบเขตหดลงมาก — 164 แถวถูก Cancelled

ฉบับ 4 ก.ย. Cancelled 137 แถว · ฉบับ 7 ก.ย. Cancelled **164** แถว (เพิ่มอีก 27)
ledger ของเรามี 309 เคส — **212 เคสวางอยู่บนแถวที่ QA ยกเลิกไปแล้ว** เหลือ in-scope จริง **97 เคส**
เคสที่ยกเลิกแล้วแต่เรายังรันจนได้ verdict: **34 เคส** (failed 31 · review 2 · passed 1) — เวลาที่เสียไปฟรี

## 2. ตาราง Test Status ของ QA × verdict ของเรา

| QA | ของเรา | จำนวน | ความหมาย |
|---|---|---:|---|
| Passed | failed | 4 | เราแดง แต่ QA ผ่าน — เจอของจริงที่คนมองข้าม หรือเคสเราเขียนผิด — HIR-EC-077, HIR-EC-082, CNS-EC-001, CNS-EC-002 |
| Failed | failed | 1 | ตรงกัน — ยืนยันบั๊กเดิม — HIR-EC-057 |
| Passed | passed | 2 | ตรงกัน — HIR-EC-055, CNS-EC-015 |
| Cancelled | failed | 31 | รันเคสที่ยกเลิกแล้ว |
| Cancelled | passed | 1 | รันเคสที่ยกเลิกแล้ว — CNS-EC-013 |
| Cancelled | review | 2 | รันเคสที่ยกเลิกแล้ว — HIR-EC-094, HIR-EC-095 |
| Not Start | failed | 8 | เรานำหน้า QA — ส่งให้ทีมแอปดูได้เลย — HIR-EC-015, HIR-EC-017, HIR-EC-020, HIR-EC-111, HIR-EC-139, PRB-EC-026, PRB-EC-076, PRB-EC-079 |
| Not Start | passed | 1 | เรานำหน้า QA — PRB-EC-062 |

### เคสที่ต้องตรวจด้วยคนก่อน
- **QA Passed แต่เรา failed (4)**: HIR-EC-077, HIR-EC-082, CNS-EC-001, CNS-EC-002 — ต้องตัดสินว่าเป็นบั๊กจริงที่ QA มองข้าม หรือ flow ที่เราเขียนผิด
- **ตรงกันทั้งคู่ (1)**: HIR-EC-057 — ตรวจว่าอ้าง Bug ticket เดียวกัน
- **QA Failed แต่เรา passed**: 0 เคส — ไม่มี ดีแล้ว

## 3. เนื้อหาเทสถูกเขียนใหม่ 105 แถว

การแก้ไม่ใช่แค่สถานะ — Steps ถูกเขียนใหม่ให้ละเอียดขึ้นเท่าตัว (เฉลี่ย 1,066 → 2,379 ตัวอักษร) โดยเพิ่ม:
- URL ตรง (`/humi/en/admin/hire`) แทนคำบอกทางแบบเมนู
- คำสั่ง "กดปุ่ม Expand all" ก่อนคีย์ฟอร์ม
- **ห้าม Logout แล้ว Login ใหม่ ให้ใช้ "สวมบทบาทแทน..."** — ตรงกับปัญหา anti-wander ที่ทำให้ agent ของเราหลุด
- ระบุค่าที่ต้องกรอกรายฟิลด์ พร้อมเครื่องหมาย * ว่าฟิลด์ไหนบังคับ

แถวที่แก้เนื้อหา + ยัง in scope: **78** แถว
ในจำนวนนั้น **10 เคสเราตัดสินไปแล้วโดยอิงข้อความเก่า** — verdict เหล่านี้ใช้ไม่ได้ ต้องรันใหม่: HIR-EC-015 (failed), HIR-EC-017 (failed), HIR-EC-020 (failed), HIR-EC-055 (passed), HIR-EC-057 (failed), HIR-EC-077 (failed), HIR-EC-082 (failed), HIR-EC-111 (failed), HIR-EC-139 (failed), PRB-EC-026 (failed)

## 4. สิ่งที่ทำแล้ว

- `.wowlidator/catalogs/QA_Task_Tracking_Cycle1_Revised_EC_in-scope.csv` — catalog ฉบับใหม่ 108 แถว in scope ใช้ข้อความที่แก้แล้ว (ตัด Cancelled 164 แถวออก)
- ledger เดิมไม่ถูกแตะ — verdict 48 เคสที่ได้มายังอยู่ครบ

## 5. ที่ต้องตัดสินใจ

1. รันรอบใหม่จาก catalog in-scope 108 แถว แทนที่จะรันต่อ 309 เคสเดิม — ตัดงานทิ้ง ~2/3
2. 10 verdict ที่อิงข้อความเก่า ต้องรันใหม่ไม่ว่าทางไหน
3. เคส QA Passed × เรา failed (4) ต้องมีคนตัดสินก่อนแจ้งทีมแอป
