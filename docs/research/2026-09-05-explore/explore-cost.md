# ลดค่า token ของ control plane (authoring) — สำรวจ 2026-09-05

อ่านอย่างเดียว ไม่แก้ไฟล์ใน repo. ตัวเลขจาก `.wowlidator/claude-cli-usage.jsonl` แถว 2026-09-05T06:02–09:27 (988 แถว, model `opus` ทั้งหมด) และ log `ec-full-run-opus-attempt2.log` / `ec-full-run-opus.log`.

## สิ่งที่วัดได้จริง (ต่างจากโจทย์บางจุด)

| role | calls | $ | ส่วนแบ่ง |
|---|---|---|---|
| generator (authoring + risk judge) | 407 (316 warm, 91 cold) | 126.0 | 72% |
| agent | ~586 | ~50.7 | 28% |
| healer | 31 | 2.0 | 1% |
| รวม | | 175.9 | |

- generator ไม่ใช่ 87% แต่ 72% ในหน้าต่างนี้ agent 28% เป็นคันโยกที่ถูกที่สุด (env อย่างเดียว)
- ราคาที่อนุมานจาก ledger: cache-write ≈ $10/M (1h TTL), cache-read $0.5/M, output $25/M ⇒ generator แบ่งเป็น cache-write $65 (52%), output $50 (40%), cache-read $11 (9%)
- ต่อ authoring call เฉลี่ย: cache-write 16.0k, cache-read 53.6k, output 4.9k, wall 67 s (p50 64, p90 122, max 265), $0.31
- **retrieval ถูกเรียกใน 95% ของ call.** `turns: 2` = ไม่ค้นเลย มีแค่ 20/407 call. median turns 5–6 (≈ 2 ครั้ง). รวมทั้งหน้าต่าง ≈ 700 ครั้ง
- ต้นทุนส่วนเพิ่มต่อการค้น 1 ครั้ง (อ่านจากตาราง turns→cost): +≈6k cache-write, +20–30k cache-read, +0.5–1k output ≈ **$0.07–0.09 และ +10–15 s**. ผลลัพธ์ tool 1 ครั้ง (8 hits × 1,600 chars ภาษาไทย) หนักพอ ๆ กับ prompt ของแถวทั้งแถว

| turns | n | avg cache-write | avg cache-read | avg out | avg $ | avg s |
|---|---|---|---|---|---|---|
| 2 | 20 | 6.8k | 11k | 3.2k | 0.153 | 43 |
| 4 | 152 | 12.6k | 30k | 4.0k | 0.242 | 55 |
| 6 | 110 | 16.7k | 51k | 4.5k | 0.306 | 63 |
| 8 | 22 | 22.3k | 86k | 6.9k | 0.438 | 96 |
| 12 | 7 | 31.8k | 192k | 10.3k | 0.670 | 143 |

- risk judge = 112 call (67+45 ใน log), $18 (14% ของ generator), avg turns 5.1 ⇒ **judge ก็ค้น retrieval** เฉลี่ย 1.5 ครั้ง/ครั้ง, 24 s/ครั้ง
- re-ask จาก risk judge: 34+25 = 59 ครั้ง, แทนที่ flow เดิมจริง 14/34 และ 10/25 (≈41%). ใน 59 นี้ **29 ครั้งมาจาก expected-fail** (sheet บอกว่า Failed อยู่แล้ว) ซึ่ง re-author แก้ไม่ได้โดยนิยาม
- cold one-shot 91/407 (22%). log บอกสาเหตุ 104 ครั้ง = `all 9 warm claude sessions for this key are busy`, 6 ครั้ง = session exited. cold แพงกว่า warm ≈ +$0.046 และ +24 s ต่อ call
- refusal memory อิ่มตัว: 72/77 แถวใน attempt2 ส่ง `carrying 6 rule(s)` แล้ว re-ask ยังอยู่ที่ ~36% ของ authoring call
- attempt ที่ 3 แทบไม่เกิด: `(attempt 3)` = 0 บรรทัดทั้งสอง log; identical-refusal guard หยุดไว้ก่อน 5 และ 7 ครั้ง
- CLI 2.1.261: `claude --help` **ไม่มี `--max-turns`** มีแค่ `--max-budget-usd` ซึ่งตัดคำตอบทิ้งทั้งก้อน (จ่าย prompt ซ้ำ) ใช้ไม่ได้
- system prompt ของ author วัดได้ 29,578 chars ≈ 7.4k token (ตรงกับ cache-read ~11k ของแถว turns=2: system + tools + schema) ส่วน user prompt ไม่ hit cache เลยระหว่างแถว เพราะเริ่มด้วยข้อความของแถวเองตั้งแต่ byte แรก (`buildUserPrompt` `src/generator/flow-author.ts:1084`)

## ข้อเสนอ เรียงตามผลตอบแทน

### 1. จำกัด retrieval ต่อ authoring call (S–M) — ประหยัด ~30–35% ของ generator, ~21–25% รวม

**เปลี่ยนอะไร**
- `src/providers/claude-retrieval.ts:50-52` — `RETRIEVAL_DEFAULT_LIMIT` 8→4, `RETRIEVAL_HIT_MAX_CHARS` 1600→800 (payload ต่อครั้งเหลือ ¼)
- งบค้นต่อ ask: `retrievalArgs` (`src/providers/claude-cli.ts:141-160`) ต่อ `?ask=<id>&budget=2` ท้าย URL เมื่อ role = generator; `handle`/`searchCorpus` (`claude-retrieval.ts:100-165`) นับต่อ `ask` เกินงบตอบว่า "budget exhausted — answer from the evidence in your prompt". ทำได้เพราะ generator session เป็น 1 turn อยู่แล้ว (`AUTHORING_TURNS_PER_SESSION = 1`, `claude-cli-session.ts:80`) URL ต่อ ask จึงไม่เสีย pooling; healer/agent (10-turn session) ใช้ URL เดิม
- `buildSystemPrompt` (`flow-author.ts:1265`) เพิ่ม 1 บรรทัดใน procedure: ค้น `search_context` ได้ไม่เกิน 1 ครั้ง และเฉพาะ route/table/label ที่ evidence ไม่ได้ให้ — ตอนนี้ prompt **ไม่พูดถึง tool เลย** (grep ไม่พบ) โมเดลใช้เพราะเห็นชื่อ tool
- เพิ่ม env ต่อ role `WOWLIDATOR_<ROLE>_RETRIEVAL` (ตอนนี้มีแค่สวิตช์รวม `WOWLIDATOR_CLAUDE_CLI_RETRIEVAL`, `claude-cli.ts:129`; role ถูก hardcode ที่ `llm-factory.ts:320`) เพื่อ A/B ปิดเฉพาะ generator

**เลข**: ปัจจุบันการค้น ≈ 700 × $0.07–0.08 ≈ $49–56 (35–45% ของ generator). หลังแก้ ≈ 400 ครั้ง × ~$0.03 ≈ $12 ⇒ ประหยัด ≈ $37–44 = 30–35% generator, 21–25% รวม. wall: 700×12 s − 400×8 s ≈ 87 นาทีจาก 457 นาที lane ของ generator ≈ 19%

**"pre-fetch top-k เข้า prompt" ทำอยู่แล้ว**: `CONTEXT_BUDGET_CHARS` 24,000 (`src/catalog/retrieve.ts:76`) จัดอันดับเอกสารต่อแถวเข้า prompt + repo slice + journey tree. tool คือการค้นซ้ำ corpus เดียวกัน

**เสี่ยง**: กลาง-ต่ำ. คุณค่าของ tool ต่อ verdict ไม่เคยถูกวัด ให้รัน 20 แถวด้วย `WOWLIDATOR_CLAUDE_CLI_RETRIEVAL=0` เทียบ refusal rate + pass rate ก่อนตัดสิน

### 2. ปิด retrieval ให้ risk judge และไม่ re-author เมื่อ fail-fast มาจาก expected-fail (S) — ~20% ของ generator, ~15% รวม

- `LlmRiskModel` (`src/generator/dead-end-risk.ts:325-356`) ใช้ `{factory, role:'generator'}` จึงได้ instance เดียวกับ author (`LlmFactory.forRole` cache ต่อ role, `llm-factory.ts:370-378`) ⇒ ได้ tool ไปด้วย. เพิ่ม option `forRole(role, {retrieval:false})` แยก cache key. judge มี evidence ครบใน prompt แล้ว (`DOCS_BUDGET_CHARS` 10k, `REPO_BUDGET_CHARS` 4k, บรรทัด 45-46) หน้าที่คือตัดสิน ไม่ใช่ค้น. ประหยัด 112 × 1.55 × $0.08 ≈ $14 + 112 × 15 s ≈ 28 นาที
- `src/cli/commands/authoring.ts:1303` เงื่อนไข `risk.verdict === 'fail-fast'` ให้เพิ่ม `&& risk.likelihood > threshold` (มิติ dead-end). `riskVerdict` (`dead-end-risk.ts:61-68`) รวมสองมิติเป็นค่าเดียว จึงต้องดู `likelihood` เอง. expected-fail = sheet บันทึกว่า Failed / app มี defect — re-author flow ไม่เปลี่ยนผล. ประหยัด 29 × ($0.31 author + $0.17 judge ซ้ำ) ≈ $14 + 29 × 90 s ≈ 44 นาที
- risk re-ask ที่เหลือ (dead-end) แทนที่จริง ~41% — พอคุ้ม เก็บไว้

**เสี่ยง**: ต่ำ

### 3. แก้ warm pool ค้าง: session 1-turn นั่งกิน slot 90 s หลังตอบ (S) — ~3% ของ generator แต่ตัด cold 22% ทิ้งหมด

- `askWarm` (`src/providers/claude-cli-session.ts:398-414`) prune ด้วย `spent` (= closed หรือ turns ≥ 10). generator budget = 1 ⇒ session ที่ตอบแล้ว `usableFor(1)` เป็น false แต่ไม่ `spent` จึงค้างจน `SESSION_IDLE_MS` 90 s (บรรทัด 112) ปิดให้ และนับใน `pool.length >= currentSessionCap()`. 8 worker × call ~60 s ⇒ pool ทะลุ 9 เป็นประจำ ⇒ 104 ครั้ง "all 9 warm claude sessions for this key are busy" → cold
- แก้: prune `!held.busy && !held.usableFor(maxTurns)` ด้วย (key เดียวกัน = system prompt เดียวกัน = role เดียวกัน = budget เดียวกัน ข้อกังวล "ฆ่า session ของ role อื่น" ไม่เกิดใน pool เดียวกัน) หรือปิด session ทันทีหลังตอบเมื่อ `maxTurns === 1`
- ประหยัด: 91 × $0.046 ≈ $4, 91 × 24 s ≈ 36 นาที lane (8%). และเลิกผูก cap กับ author concurrency
- หมายเหตุตรงไปตรงมา: ด้วย budget 1 "warm" คือ spawn process ใหม่ทุกแถวอยู่ดี ข้อได้เปรียบ 1.2 s เทียบ 3.4 s เป็นของ process ที่ถูก reuse ควรวัดว่า warm-1-turn กับ cold ต่างกันจริงไหม ถ้าไม่ต่างก็ลดความซับซ้อนได้

### 4. agent ไป sonnet/haiku (S, env อย่างเดียว) — ประหยัด 11–23% ของยอดรวม

- code รองรับแล้ว: `WOWLIDATOR_AGENT_MODEL` (`src/config.ts:435-436`), breaker แยกตาม role+model, `AgentModel.decide()` = 1 structured decision ต่อ turn; ค่า default คือ Groq gpt-oss-120b (`config.ts:237`) แสดงว่าออกแบบมาให้โมเดลเล็กทำอยู่แล้ว. `.env` ตอนนี้ตั้งทั้ง 4 role เป็น opus
- agent ≈ 586 call, $50.7, เฉลี่ย 6.3k cache-write / 25.8k read / 434 out / 6 s. sonnet (≈60% ราคา) ประหยัด ≈ $20 (11% รวม); haiku (≈20%) ≈ $40 (23% รวม). wall แทบไม่เปลี่ยน
- **เสี่ยง**: กลาง — agent ตัดสินใน agent rung หลัง step พัง และใน capture pilot; โมเดลอ่อนกว่า → stall/no-progress มากขึ้น → dead-end เพิ่ม. เริ่มที่ sonnet, A/B 20 แถว ดู agent-leg success. healer $2 ไม่คุ้มยุ่ง; data แทบไม่ถูกเรียก

### 5. ย้ายกฎ lint ที่โดนบ่อยไปหน้า prompt แบบโครงสร้าง ไม่ใช่ตัวอย่างข้อความ (M) — ~9% ของ generator ถ้าลด lint re-ask ครึ่งหนึ่ง

- refusal memory (`SUITE_REFUSAL_MEMORY` 6, `flow-author.ts:127`; `#recalledRefusals` 2506-2513) ส่ง `held.exemplar` = ข้อความเต็มของแถวอื่น (มีชื่อ case/step ของแถวนั้น) และอิ่มตัวที่ 6 บน 72/77 แถว แต่ re-ask ยัง ~36%
- เหตุผลบนสุด (โจทย์ + log): flow หยุดก่อน step สุดท้ายของ Steps, flow ไม่ทำการพิมพ์/คลิกที่ Steps สั่ง (`unperformedScriptSteps` / `skipsAuthoredScript`), wording claim ไป assert data row (`wordingClaimAssertsDataValue` 12 ครั้ง)
- `scriptDemand` (`flow-author.ts:4617`) ใช้หลังคำตอบเท่านั้น (lint 4654-4659, mechanical `settleScriptDemand` 3185/6015). เสนอ render เป็น checklist ใน user prompt ก่อน ask แรก: "Steps บรรทัด 5 สั่ง 'ระบุ' → ต้องมี fill/type/selectOption; flow ต้องไปถึงบรรทัด N" — เอา predicate ของ lint มาเป็นคำสั่ง. และเก็บ rule 1 บรรทัดต่อ lint id แทน exemplar
- ประหยัด: 71 lint re-ask ÷ 2 × $0.31 ≈ $11 + 35 × 67 s ≈ 39 นาที. เสี่ยงต่ำ (prompt +~200 token)
- **ไม่ควรลด attempts เป็น 2**: attempt 3 เกิด 0 ครั้ง identical-refusal guard ทำงานอยู่แล้ว
- ทางเลือกถูกกว่า: `WOWLIDATOR_GENERATOR_RETRY_MODEL=sonnet` (`src/cli/runtime.ts:224-231`, ใช้ที่ `flow-author.ts:2718`) 71 × $0.12 ≈ $8.5 (7%) เสี่ยงกลาง (sonnet อาจไป break lint อื่น → blocked)

### 6. แชร์ evidence ต่อ scenario ให้ prompt cache hit + memo journey capture (L) — ~17% ของ generator, ~13% รวม

- ที่มีอยู่แล้ว: run-time sign-in แชร์ผ่าน `SessionVault` (`src/engine/session-vault.ts`); authoring เขียน sign-in เป็น `signIn` step เดียว (`flow-author.ts:204, 962`) ⇒ prefix ใน output เล็ก (~10% ของ 4.9k) template flow ต่อ menu path จึง**ไม่คุ้ม**: ประหยัดแค่ output ~$0.025/call และ prefix ที่ผ่านของแถวหนึ่ง (persona/test data หนึ่ง) ไม่ได้พิสูจน์ของแถวพี่น้อง — block ย้ายจาก authoring ไป run time
- ที่ซ้ำจริงคือ **input**: `buildUserPrompt` (`flow-author.ts:1084`) เริ่มด้วย request ของแถว ⇒ ไม่มีอะไรหลัง system prompt hit cache (ledger: turns=2 read 11k = system+tools+schema, write 6.7k = user prompt ทั้งก้อน). แถวใน scenario เดียวกัน (`row.scenarioId`, `src/catalog/test-case-table.ts:74,390`) ลงหน้าเดียวกันและเอกสารเกือบชุดเดียวกัน; `captureJourneyTree` (`authoring.ts:1999`) sign-in + อ่านหน้าใหม่ทุกแถว
- hook: `authorEachRow` (`authoring.ts:932`) group ตาม scenarioId/menu path; เลือกเอกสารครั้งเดียวต่อ scenario; memo journey tree ด้วย (resolved URL, persona) ภายใน pass; เรียง `buildUserPrompt` ให้บล็อกที่แชร์ (tables, docs, journey tree, repo slice) มาก่อน request ของแถวมาท้ายสุด ⇒ พี่น้อง read ที่ $0.5/M แทน write $10/M
- ประหยัด: ถ้า ~8k จาก 16k cache-write กลายเป็น read: 8k × $9.5/M × 295 ≈ $22; capture 15–20 s × 190 แถว ≈ 50 นาที
- **เสี่ยง**: กลาง — จัดอันดับเอกสารต่อ scenario เสีย evidence เฉพาะแถว (refusal "wording ไม่อยู่ใน tree" เพิ่ม); พี่น้องที่ author พร้อมกัน 8 worker เริ่มก่อน cache ถูกเขียน ต้องจัดคิวให้แถวแรกของ scenario ไปก่อน; journey tree แชร์ได้เฉพาะ destination URL เดียวกัน

### 7. งบ context เป็น token ไม่ใช่ chars สำหรับภาษาไทย (S, ต้องวัดก่อน)

- `CONTEXT_BUDGET_CHARS` 24,000 และ `RETRIEVAL_HIT_MAX_CHARS` 1,600 เป็น chars; ภาษาไทยกิน token ต่อ char สูงกว่าอังกฤษมาก ตัวเลข cache-write 6k ต่อการค้น 1 ครั้ง (12.8k chars) บอกว่า ≈ 2 chars/token. `--context-budget` มีอยู่แล้ว (`src/cli.ts:217`) ลอง 12,000 บน 20 แถว ดู refusal ก่อน. ประหยัดสูงสุด ~3–4k cache-write/call ≈ $0.035 × 295 ≈ $10 (8%)

## สรุปลำดับ

| # | ข้อเสนอ | ประหยัด token (ของ generator / รวม) | wall | เสี่ยง verdict | effort |
|---|---|---|---|---|---|
| 1 | จำกัด retrieval ต่อ call + hit เล็กลง + prompt บอกงบ | 30–35% / 21–25% | −19% lane | กลาง-ต่ำ (A/B ก่อน) | S–M |
| 2 | judge ไม่ค้น + ไม่ re-author expected-fail | 20% / 15% | −72 นาที | ต่ำ | S |
| 4 | agent → sonnet/haiku | 0 / 11–23% | ~0 | กลาง | S |
| 6 | evidence ต่อ scenario + cache prefix + memo capture | 17% / 13% | −50 นาที capture | กลาง | L |
| 5 | กฎ lint ขึ้นหน้า prompt เชิงโครงสร้าง | ~9% / 6% | −39 นาที | ต่ำ | M |
| 3 | pool ค้าง 90 s → cold 22% | 3% / 2% | −36 นาที | ไม่มี | S |
| 7 | งบ context เป็น token | ~8% / 6% | เล็ก | กลาง (วัดก่อน) | S |

ทำ 1+2+3 ก่อน (S–M ทั้งหมด, ไม่เกี่ยวพันกัน) รวม ≈ 50–55% ของ generator ≈ 40% ของยอดรวม แล้ว A/B ข้อ 4 บน agent
