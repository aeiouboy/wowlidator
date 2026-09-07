# HIR-EC-001 — ผลรัน (steps ฉบับแก้ไข 7 ก.ย. 2026)

**runId** `8ff79280-f5eb-4fc8-ba7b-d1a233226b0a` · **เริ่ม** 17:38 · **จบ** 17:56 · **ใช้เวลา** 13 นาที 13 วินาที

## ผลลัพธ์: ✗ FAIL (ERROR)

| ตัวชี้วัด | ค่า |
|---|---|
| ขั้นที่ผ่าน | **9 / 45** |
| ขั้นที่ถูกข้าม | 30 (รวม Save & Submit) |
| defect | 5 (สูง 4) |
| coverage | **1 / 102 controls (1%)** |
| network | 235 call · ล้มเหลว 5 |
| agent turn | 57 turn · 12.2 นาที |
| ค่า token | 1,212,177 in / 13,610 out |

**พนักงานใหม่ไม่ถูกสร้าง** — flow ไปไม่ถึงปุ่ม Save & Submit ด้วยซ้ำ

## ขั้นตอนและหลักฐาน

| # | action | ผล | หลักฐาน |
|---|---|---|---|
| 0 | setClock 2027-09-01 | ✓ 13ms | |
| 1 | goto /humi/en/login | ✓ 372ms | |
| 2 | signIn HR_ADMIN_ACCOUNT (automate02) | ✓ 1.8s | |
| 3–4 | goto /humi/en/admin/hire | ✓ | |
| 5 | expectText `heading[role="heading"]` | **✗ 4.8s** | `step-05-expectText.jpg` |
| 6 | expectText (ซ่อมด้วย jit healer) | ✓ 33.7s | `step-06-expectText.jpg` |
| 7 | expectText "Step 1 of 2 - Personal" | ✓ 8ms | |
| 8 | click "Expand all" | ✓ 2.0s | |
| **9** | **workflow — กรอก Step 1 Personal** | **✗ 173s** | `step-09-workflow.jpg` |
| 10–11 | click Next, ตรวจ Employment | – ข้าม | |
| **12** | **workflow — กรอก Step 2 Employment** | **✗ 560s** | `step-12-workflow.jpg` |
| 13–42 | assertion ทั้งหมด + **Save & Submit** | – ข้าม 30 ขั้น | |
| 43 | expectVisible "Personal Information" | ✓ 35ms | |
| 44 | expectVisible "Employment Information" | **✗ 12.8s** | `step-44-expectVisible.jpg` |

## บั๊กที่พบ

### 1. แอปพลิเคชัน — API 5 ตัวคืน HTTP 500 (สูง)

ตอนโหลดหน้า `/humi/en/admin/hire`:

```
GET /humi/api/content-management/language                              → 500 (38ms)
GET /humi/api/content-management/quick-action/visible                  → 500 (59ms)
GET /humi/api/content-management/menu-item/visible?context=PROFILE_SIDEBAR → 500 (49ms)
GET /humi/api/content-management/menu-item/visible?context=ADMIN_SIDEBAR   → 500 (49ms)
GET /humi/api/content-management/news-update?language=en               → 500 (38ms)
```

ทั้งหมดอยู่ใต้ `content-management` — น่าจะเป็น service เดียวที่ล่ม ระบบเองบันทึกไว้ว่า
"a failing request is a far more likely explanation for a control that never appeared than a drifted selector — fix the request before touching the test"

**นี่คือของจริงที่ควรแจ้งทีมแอป**

### 2. เครื่องมือเรา — accessibility tree ถูกตัดที่ 120 node (สูง)

งบ node ที่ agent เห็นได้ต่อ turn:

| ค่า | ที่ | จำนวน |
|---|---|---:|
| `DEFAULT_AGENT_MAX_NODES` | `workflow-agent.ts:348` | 60 (ขาปกติ) |
| `FORM_AGENT_MAX_NODES` | `workflow-agent.ts:356` | **120** (ขากรอกฟอร์ม) |
| `DEFAULT_MAX_AX_NODES` | `jit-healer.ts:29` | 120 (ของ healer คนละตัว) |

การเพิ่ม budget ให้ "form leg" ทำงานถูกต้อง (60 → 120 เท่าตัว) แต่ **120 ยังน้อยเกินไป** หน้า hire มี **102 control** ที่นับได้ บวก node โครงสร้างอีกมาก

agent เขียนเหตุผลเดียวกันซ้ำทุก turn:
> "the accessibility tree is truncated and the required fields are not yet visible, so scrolling down is needed"

ปิดท้ายทั้งสองขาด้วย:
> ขา 9: "National ID / Tax ID, Firstname (TH), Lastname (TH), House No. are **absent from the current truncated accessibility tree**"
> ขา 12: "The page is truncated and the required controls (including **Identity\*, Personal Information\***, Contact\*, Global Information\*, House No.) …"

ขา 12 บอกว่ามองไม่เห็นปุ่มที่ตัวเองเพิ่งคลิกไป 3–4 ครั้ง

**ลูปที่เกิดขึ้น** — ยิ่งพยายามยิ่งแย่:

```
กางส่วน → node เพิ่ม → ทะลุ 120 → ฟิลด์เดิมหลุดจากหน้าต่าง
   ↑                                        ↓
   └──── กางส่วนถัดไปเพื่อ "หา" ← scroll ←──┘
```

**57 turn ลงมือ 37 action มีแค่ 10 ที่ป้อนข้อมูลจริง** (fill 5 · selectOption 5)
อีก 27 คือ click กางส่วน 14 · scroll 11 · goto/wait 4

ปุ่มกางส่วนที่เป็น toggle ถูกคลิกซ้ำ: Personal Information\* **4 ครั้ง** · Position & Organization\* **3** · Identity\* **3**
คลิกส่วนที่เปิดอยู่แล้ว = ปิดมัน

### 3. selector ที่ generator เขียนผิดรูป (ต่ำ)

`heading[role="heading"]` ซ้ำ role สองชั้น — healer ซ่อมเป็น `role=heading[name="Add New Employee"]` (ความมั่นใจ 0.99) ควรแก้ prompt ไม่ให้เขียนแบบนี้ จะได้ไม่เสีย 33.7 วินาทีทุกครั้ง

### 4. provider ล้ม 1 ครั้ง (ไม่กระทบ verdict)

risk assessment ข้ามไป เพราะ codex CLI เอง: `failed to load models cache: missing field base_instructions`

## ระบบวินิจฉัยเองว่าอย่างไร

> **origin: agent — confidence 0.84**
> "The first error was step 9: the workflow agent could not reach controls that the hire flow requires, after the accessibility tree was truncated and scrolling did not change it. The later step 12 and assertions are cascades."
> **fix:** "Retry with a better page capture or run `--repair-investigate`"

ตรงกับที่วิเคราะห์ด้วยมือ — **ต้นเหตุคือเครื่องมือเรา ไม่ใช่ business logic ของแอป** (API 500 เป็นคนละเรื่อง เป็นของแอปจริง)

## ผลต่อ catalog

HIR-EC-001 เป็น dependency root ที่มี **21 เคสรออยู่** ถ้าฟอร์มขนาดนี้ทะลุ 120 node เสมอ ทุกเคส hiring ที่ต้องกรอกฟอร์มเต็มจะพังแบบเดียวกันตลอด ไม่ว่ารันซ้ำกี่รอบ — ตรงกับ ledger ที่แสดงว่า hiring แทบไม่มีเคสผ่าน

## ทางแก้

| ทาง | ทำอะไร | ข้อแลก |
|---|---|---|
| 1 | ยก `FORM_AGENT_MAX_NODES` จาก 120 → 400+ | token ต่อ turn สูงขึ้น แต่ turn น้อยลงมาก (ตอนนี้เสีย 57 turn ได้ 10 action) |
| 2 | เลิกกด Expand all กรอกทีละส่วน | ขัดกับ steps ฉบับใหม่ที่สั่งให้กด Expand all ตรง ๆ |
| 3 | แจ้งทีมแอปเรื่อง 500 | แยกเรื่อง ทำคู่ขนานได้ |

**ยังไม่ได้แก้อะไร** รอตัดสินใจ

## ไฟล์

- `HIR-EC-001.mp4` / `hir-ec-001.webm` — วิดีโอเต็ม (ตัดเหลือ 110 วินาทีจาก 792 วินาที, 82 ช่วงสำคัญ)
- `step-*.jpg` — ภาพ 5 จุดที่มีเหตุการณ์
- `*-cases.xlsx` — workbook พร้อมภาพฝัง
- `*-findings.md` — defect ที่ระบบสรุปเอง
- report เต็ม: `reports/hir-ec-001-revised-csv-2026-09-07t10-38-45-101z.html`
