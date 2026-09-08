/**
 * Value resolution at authoring time (`src/generator/value-resolution.ts`).
 *
 * Entirely unit-tier: a scripted resolver model, a scripted `DbClient` (the
 * `tests/db.test.ts` pattern) and plain text stand in for the sheet, the
 * documents and the database. What is pinned is the ORDER of the sources and
 * the honesty rules — a model answer is accepted only when the evidence holds
 * it, a sensitive column is never used, a stand-in is always flagged.
 */

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import type { DbClient, DbResult, DbSchema } from '../src/db/client.js';
import type { FlowStep } from '../src/engine/runner.js';
import { readMasterDataDeclaration } from '../src/context/master-data.js';
import { describeValueSource, formatStepLine, valueWasGenerated, type ProofStep } from '../src/engine/proof-bundle.js';
import { typesPlaceholderToken } from '../src/generator/flow-author.js';
import {
  PLACEHOLDER_TOKEN,
  absoluteDateOf,
  candidateFor,
  cleanModelValue,
  assertDerivedFields,
  expandMasterDataCodes,
  fieldLabelOf,
  findUnresolvedValues,
  formatStatedFor,
  fromRelativeDate,
  fromTestData,
  fromUniquePerRun,
  isDatePhrase,
  isReusedKeyValue,
  resolveDatePhrase,
  resolveValues,
  testDataPairsOf,
  type ValueResolverModel,
} from '../src/generator/value-resolution.js';

const MASTER_DATA_FIXTURE = resolve(import.meta.dirname, 'fixtures/master-data.lookups.json');

const CASE = [
  'HIR-EC-012: ตรวจสอบการจ้างพนักงานแบบ Replacement ผ่าน Key-in',
  'Test data: - Replaced Employee ID = Employee ID ของพนักงานที่มีอยู่จริงและสามารถใช้สำหรับ Replacement; - Invalid Replaced Employee ID = <NON_EXISTING_EMPLOYEE_ID>; - Employee Group = A - Permanent',
  'Steps:',
  '  3. ตรวจสอบ Replaced Employee ID ที่ไม่มีอยู่จริง',
  '  - กรอก Replaced Employee ID = <NON_EXISTING_EMPLOYEE_ID>',
  '  4. ตรวจสอบ Replaced Employee ID ที่ถูกต้อง',
  'Expected output:',
  '  - ระบบสร้าง Employee ID เป็นตัวเลข 8 หลัก โดยหลักแรกเป็น 2',
].join('\n');

const SCHEMA: DbSchema = {
  source: 'introspection',
  tables: [
    {
      name: 'employee_center.employee',
      columns: [
        { name: 'employee_id', type: 'text', nullable: false, pk: true },
        { name: 'status', type: 'text', nullable: false, pk: false },
        { name: 'password_hash', type: 'text', nullable: true, pk: false },
      ],
      pk: ['employee_id'],
      references: [],
    },
  ],
};

class StubDb implements DbClient {
  readonly id = 'stub';
  readonly queries: { sql: string; params: readonly unknown[] }[] = [];
  rows: Record<string, unknown>[] = [{ employee_id: '20004512', status: 'active', password_hash: 'x' }];
  existing = new Set(['20004512']);
  async query(sql: string, params: readonly unknown[]): Promise<DbResult> {
    this.queries.push({ sql, params });
    if (sql.includes('count(*)')) {
      return { rows: [{ n: this.existing.has(String(params[0])) ? '1' : '0' }], rowCount: 1, durationMs: 1 };
    }
    const col = /SELECT "([^"]+)"/.exec(sql)?.[1] ?? 'employee_id';
    return { rows: this.rows.map((r) => ({ v: r[col] })), rowCount: this.rows.length, durationMs: 1 };
  }
  async introspect(): Promise<DbSchema> {
    return SCHEMA;
  }
  async close(): Promise<void> {}
}

function model(script: Partial<ValueResolverModel> & { calls?: string[] }): ValueResolverModel {
  const calls = script.calls ?? [];
  return {
    id: 'scripted',
    fromPassages: async (q) => {
      calls.push('repo');
      return script.fromPassages ? script.fromPassages(q) : { value: null, evidence: '' };
    },
    chooseDbLookup: async (q) => {
      calls.push('db');
      return script.chooseDbLookup ? script.chooseDbLookup(q) : null;
    },
    generate: async (q) => {
      calls.push('generated');
      return script.generate ? script.generate(q) : { value: '29999999' };
    },
  };
}

const tokenStep = (over: Partial<Record<string, unknown>> = {}): FlowStep =>
  ({
    action: 'fill',
    selector: 'role=textbox[name="Replaced Employee ID" i]',
    value: '<NON_EXISTING_EMPLOYEE_ID>',
    intent: 'Step 3: กรอก Replaced Employee ID = <NON_EXISTING_EMPLOYEE_ID>',
    ...over,
  }) as FlowStep;

const describedStep = (): FlowStep =>
  ({
    action: 'fill',
    selector: 'role=textbox[name="Replaced Employee ID" i]',
    value: 'Employee ID ของพนักงานที่มีอยู่จริง',
    intent: 'Step 4: กรอก Replaced Employee ID ของพนักงานที่มีอยู่จริง',
  }) as FlowStep;

describe('master-data value expansion', () => {
  const step = (field: string, value: string): FlowStep => ({ action: 'selectOption', selector: `role=combobox[name="${field}" i]`, value, intent: `select ${field}` });

  it('expands an exact code and stamps its source', async () => {
    const lookups = await readMasterDataDeclaration(MASTER_DATA_FIXTURE);
    let calls = 0;
    const out = await expandMasterDataCodes([], [step('Cost Center', 'CC-07')], {
      lookups,
      fetch: async () => async () => {
        calls += 1;
        return [{ code: 'CC-07', title: 'North Office' }];
      },
    });
    assert.equal(calls, 1);
    const first = out.steps[0];
    assert.equal(first !== undefined && 'value' in first ? first.value : undefined, 'CC-07 — North Office');
    assert.deepEqual(first !== undefined && 'valueSource' in first ? first.valueSource : undefined, { kind: 'master-data', detail: 'Cost Center code "CC-07" is labelled "North Office" in Cost Center' });
    assert.match(first !== undefined && 'intent' in first ? first.intent ?? '' : '', /— value from master-data:/);
    assert.equal(out.expanded.length, 1);
  });

  it('leaves an already paired value, a missing code, and an identical label untouched', async () => {
    const lookups = await readMasterDataDeclaration(MASTER_DATA_FIXTURE);
    const authored = [step('Cost Center', 'CC-07 — North Office'), step('Cost Center', 'CC-08'), step('Cost Center', 'CC-09')];
    const out = await expandMasterDataCodes([], authored, { lookups, fetch: async () => async () => [{ code: 'CC-09', title: 'CC-09' }] });
    assert.deepEqual(out.steps, authored);
    assert.deepEqual(out.expanded, []);
  });

  it('skips an unbound lookup without opening a transport', async () => {
    const lookups = await readMasterDataDeclaration(MASTER_DATA_FIXTURE);
    const log: string[] = [];
    let opened = false;
    const authored = [step('Position', 'P-005')];
    const out = await expandMasterDataCodes([], authored, {
      lookups,
      fetch: async () => {
        opened = true;
        return async () => null;
      },
      onLog: (line) => log.push(line),
    });
    assert.equal(opened, false);
    assert.deepEqual(out.steps, authored);
    assert.match(log.join('\n'), /\{Company\} not in this row's Test Data/);
  });

  it('leaves every step authored when the transport throws or is unavailable', async () => {
    const lookups = await readMasterDataDeclaration(MASTER_DATA_FIXTURE);
    const authored = [step('Cost Center', 'CC-07')];
    const thrown = await expandMasterDataCodes([], authored, { lookups, fetch: async () => { throw new Error('offline'); } });
    const unavailable = await expandMasterDataCodes([], authored, { lookups, fetch: async () => null });
    const failedFetch = await expandMasterDataCodes([], authored, { lookups, fetch: async () => async () => { throw new Error('request failed'); } });
    assert.deepEqual(thrown.steps, authored);
    assert.deepEqual(unavailable.steps, authored);
    assert.deepEqual(failedFetch.steps, authored);
  });

  it('expands a found unreachable code and reports the reachability fact', async () => {
    const lookups = await readMasterDataDeclaration(MASTER_DATA_FIXTURE);
    const log: string[] = [];
    const out = await expandMasterDataCodes([], [step('Position', 'P-005')], {
      lookups,
      testDataPairs: [{ phase: null, key: 'Company', value: 'ACME' }],
      fetch: async () => async () => ({ data: { rows: [
        { positionCode: 'P-001', name: { en: 'One' } },
        { positionCode: 'P-002', name: { en: 'Two' } },
        { positionCode: 'P-003', name: { en: 'Three' } },
        { positionCode: 'P-004', name: { en: 'Four' } },
        { positionCode: 'P-005', name: { en: 'Five' } },
      ], hasNextPage: false } }),
      onLog: (line) => log.push(line),
    });
    const first = out.steps[0];
    assert.equal(first !== undefined && 'value' in first ? first.value : undefined, 'P-005 — Five');
    assert.match(log.join('\n'), /found but is unreachable/);
  });
});

describe('finding what needs a value', () => {
  it('sees a token, a described value, and nothing else', () => {
    const needs = findUnresolvedValues(
      [],
      [
        tokenStep(),
        describedStep(),
        { action: 'fill', selector: 'role=textbox[name="First Name (EN)" i]', value: 'Somchai' } as FlowStep,
        { action: 'expectVisible', selector: 'text=<NON_EXISTING_EMPLOYEE_ID>' } as FlowStep,
        { action: 'fill', selector: 'role=textbox[name="Note" i]', value: 'see OQ-HIR-78' } as FlowStep,
      ],
      CASE,
    );
    assert.deepEqual(needs.map((n) => [n.index, n.field, n.token, n.nonExisting]), [
      [0, 'Replaced Employee ID', '<NON_EXISTING_EMPLOYEE_ID>', true],
      [1, 'Replaced Employee ID', null, false],
    ]);
  });

  it('reads the format the case states — digits and the leading digit', () => {
    assert.deepEqual(formatStatedFor('Employee ID', CASE), { digits: 8, leading: '2' });
    assert.equal(formatStatedFor('Nickname', 'nothing about digits here'), null);
    assert.deepEqual(formatStatedFor('National ID', 'Thailand Format = N-NNNN-NNNNN-NN-N'), { mask: 'N-NNNN-NNNNN-NN-N' });
  });

  it('a candidate follows the format and steps on retry', () => {
    assert.match(candidateFor({ digits: 8, leading: '2' }), /^2\d{7}$/);
    assert.notEqual(candidateFor({ digits: 8, leading: '2' }, 0), candidateFor({ digits: 8, leading: '2' }, 1));
    assert.match(candidateFor({ mask: 'N-NNNN-NNNNN-NN-N' }), /^\d-\d{4}-\d{5}-\d{2}-\d$/);
    assert.match(candidateFor(null), /^\d{8}$/);
  });
});

describe('the sources, in order', () => {
  it('test data wins when the case states the value — no model, no db touched', async () => {
    const calls: string[] = [];
    const db = new StubDb();
    const out = await resolveValues(
      [],
      [tokenStep({ value: '<VALID_EMPLOYEE_ID>', intent: 'Step 4: กรอก Replaced Employee ID = <VALID_EMPLOYEE_ID>' })],
      { caseText: `${CASE}\n- Replaced Employee ID = 20001234`, model: model({ calls }), db: async () => db },
    );
    assert.equal(out.resolved.length, 1);
    assert.equal(out.resolved[0]!.source.kind, 'test-data');
    assert.equal((out.steps[0] as { value: string }).value, '20001234');
    assert.deepEqual(calls, []);
    assert.equal(db.queries.length, 0);
  });

  it('a non-existing token never takes the VALID id\'s line from the test data', () => {
    const need = findUnresolvedValues([], [tokenStep()], `${CASE}\n- Replaced Employee ID = 20001234`)[0]!;
    assert.equal(fromTestData(need, `${CASE}\n- Replaced Employee ID = 20001234`), null);
  });

  it('repo beats db, and only when the value really is in a passage', async () => {
    const calls: string[] = [];
    const db = new StubDb();
    const grounded = await resolveValues([], [describedStep()], {
      caseText: CASE,
      promptText: 'BACKGROUND\n\nDemo users: HR admin employee 20007777 (active) is the replacement fixture.',
      model: model({ calls, fromPassages: async () => ({ value: '20007777', evidence: 'Demo users: HR admin employee 20007777' }) }),
      db: async () => db,
    });
    assert.equal(grounded.resolved[0]!.source.kind, 'repo');
    assert.equal((grounded.steps[0] as { value: string }).value, '20007777');
    assert.equal(db.queries.length, 0, 'the db is not asked when the repo answered');

    // The same model answer with nothing behind it is refused, and the db is next.
    const calls2: string[] = [];
    const ungrounded = await resolveValues([], [describedStep()], {
      caseText: CASE,
      promptText: 'BACKGROUND\n\nnothing numeric here',
      model: model({
        calls: calls2,
        fromPassages: async () => ({ value: '20007777', evidence: 'made up' }),
        chooseDbLookup: async () => ({ table: 'employee_center.employee', column: 'employee_id', where: { status: 'active' } }),
      }),
      db: async () => db,
    });
    assert.equal(ungrounded.resolved[0]!.source.kind, 'db');
    assert.equal((ungrounded.steps[0] as { value: string }).value, '20004512');
    assert.match(ungrounded.resolved[0]!.source.detail, /employee_center\.employee\.employee_id where status=active/);
    assert.ok(db.queries.some((q) => /SELECT "employee_id" AS v FROM "employee_center"\."employee" WHERE "status" = \$1/.test(q.sql)));
  });

  it('a NON_EXISTING token is proved absent in the db, stepping past a value that exists', async () => {
    const db = new StubDb();
    db.existing = new Set(['29999999', '29999998']);
    const out = await resolveValues([], [tokenStep()], {
      caseText: CASE,
      model: model({ chooseDbLookup: async () => ({ table: 'employee_center.employee', column: 'employee_id', where: {} }) }),
      db: async () => db,
    });
    const r = out.resolved[0]!;
    assert.equal(r.source.kind, 'db');
    assert.match(r.value, /^2\d{7}$/);
    assert.ok(!db.existing.has(r.value), 'the chosen candidate is one the table does not hold');
    assert.match(r.source.detail, /count = 0/);
    assert.equal(db.queries.length, 3, 'two existing candidates were stepped past');
  });

  it('refuses a lookup the schema does not ground, and falls through to a flagged stand-in', async () => {
    const db = new StubDb();
    const log: string[] = [];
    const out = await resolveValues([], [describedStep()], {
      caseText: CASE,
      model: model({ chooseDbLookup: async () => ({ table: 'employee_center.employee', column: 'ssn', where: {} }) }),
      db: async () => db,
      onLog: (l) => log.push(l),
    });
    assert.equal(out.resolved[0]!.source.kind, 'generated');
    assert.ok(log.some((l) => /db: the model named column "ssn"/.test(l)));
    assert.equal(db.queries.length, 0, 'no SQL ran for an ungrounded column');
  });

  it('never hands out a sensitive column\'s value', async () => {
    const db = new StubDb();
    const out = await resolveValues([], [describedStep()], {
      caseText: CASE,
      model: model({ chooseDbLookup: async () => ({ table: 'employee_center.employee', column: 'password_hash', where: {} }) }),
      db: async () => db,
    });
    assert.equal(out.resolved[0]!.source.kind, 'generated');
    assert.ok(!(out.steps[0] as { value: string }).value.includes('x'));
  });

  it('the generated stand-in is flagged on the step, in the intent, and matches the stated format', async () => {
    const out = await resolveValues([], [tokenStep()], { caseText: CASE, model: model({}) });
    const step = out.steps[0] as { value: string; intent: string; valueSource?: { kind: string; detail: string } };
    assert.match(step.value, /^\d{8}$/);
    assert.equal(step.valueSource?.kind, 'generated');
    assert.match(step.intent, /value GENERATED by the author/);
    assert.match(step.valueSource!.detail, /8 digits/);
    // The lint that used to refuse the token has nothing left to refuse.
    assert.equal(typesPlaceholderToken(out.steps), null);
  });

  it('with no model at all, test data and the deterministic stand-in still work', async () => {
    const out = await resolveValues([], [tokenStep()], { caseText: CASE, model: null });
    assert.equal(out.resolved[0]!.source.kind, 'generated');
    assert.match(out.resolved[0]!.value, /^2\d{7}$/);
  });

  it('the stage off leaves the token, and the lint fires as before', () => {
    const steps = [tokenStep()];
    assert.ok(PLACEHOLDER_TOKEN.test((steps[0] as { value: string }).value));
    assert.deepEqual(typesPlaceholderToken(steps), { index: 0, token: '<NON_EXISTING_EMPLOYEE_ID>', action: 'fill' });
  });
});

describe('what a model hands back is unwrapped before it is typed', () => {
  it('unwraps the live envelope, fences, quotes and trailing prose; leaves a plain value alone', () => {
    // ec09 HIR-EC-009, 2026-09-03: the National ID box received this string verbatim.
    assert.equal(cleanModelValue('{"value": "1999900123459"}'), '1999900123459');
    assert.equal(cleanModelValue('{"value": {"value": "29999999"}}'), '29999999', 'an envelope inside an envelope');
    assert.equal(cleanModelValue('```json\n{"value": "ABC-1"}\n```'), 'ABC-1');
    assert.equal(cleanModelValue('"29999999"'), '29999999');
    assert.equal(cleanModelValue('29999999\nThis is a synthetic id.'), '29999999');
    assert.equal(cleanModelValue('  29999999 '), '29999999');
    assert.equal(cleanModelValue('A - Permanent'), 'A - Permanent');
    assert.equal(cleanModelValue('{"id": "X1"}'), 'X1', 'a lone key of any name');
    assert.equal(cleanModelValue('{"a": "1", "b": "2"}'), '{"a": "1", "b": "2"}', 'two keys and no value: not an envelope');
  });

  it('a generated value that still looks like JSON falls back to the deterministic candidate', async () => {
    const out = await resolveValues([], [tokenStep()], {
      caseText: CASE,
      model: model({ generate: async () => ({ value: '{"value": "{\\"value\\": 1}"}' }) }),
    });
    assert.match((out.steps[0] as { value: string }).value, /^2\d{7}$/);
  });

  it('an enveloped generated value is typed as the value it meant', async () => {
    const out = await resolveValues([], [tokenStep()], {
      caseText: CASE,
      model: model({ generate: async () => ({ value: '{"value": "28888888"}' }) }),
    });
    assert.equal((out.steps[0] as { value: string }).value, '28888888');
  });

  it('a repo answer wrapped in an envelope is still grounded against the passage', async () => {
    const out = await resolveValues([], [describedStep()], {
      caseText: CASE,
      projectContext: 'seed: Replaced Employee ID 23456789 exists for replacement',
      model: model({ fromPassages: async () => ({ value: '{"value": "23456789"}', evidence: 'seed line' }) }),
    });
    assert.equal(out.resolved[0]!.value, '23456789');
  });
});

describe('the flag in the proof', () => {
  const proofStep = (valueSource: unknown): ProofStep =>
    ({
      index: 7,
      action: 'fill',
      selector: 'role=textbox[name="Replaced Employee ID" i]',
      resolvedSelector: 'role=textbox[name="Replaced Employee ID" i]',
      resolution: 'fast',
      status: 'passed',
      startedAt: '2026-09-02T00:00:00.000Z',
      durationMs: 12,
      url: 'http://localhost:3005/en/admin/hire',
      detail: { value: '29999999', valueSource },
    }) as unknown as ProofStep;

  it('describes a generated value as such, and a sourced one by its source', () => {
    assert.equal(describeValueSource(proofStep({ kind: 'generated', detail: 'GENERATED from 8 digits' })), 'generated — GENERATED from 8 digits');
    assert.equal(describeValueSource(proofStep({ kind: 'db', detail: 'employee.employee_id' })), 'from db: employee.employee_id');
    assert.equal(describeValueSource(proofStep(undefined)), null);
    assert.equal(valueWasGenerated(proofStep({ kind: 'generated', detail: '' })), true);
    assert.equal(valueWasGenerated(proofStep({ kind: 'repo', detail: '' })), false);
  });

  it('the CLI step line says so', () => {
    const line = formatStepLine(proofStep({ kind: 'generated', detail: 'GENERATED from 8 digits' }));
    assert.match(line, /value generated — GENERATED from 8 digits/);
    assert.ok(!formatStepLine(proofStep(undefined)).includes('value generated'));
  });
});

// --- CG-02: the Test data reaches the resolver one pair at a time ------------------

describe('test data pairs', () => {
  it('unpacks packed lines, phase headers, the folded describeCase form, and a draft correction', () => {
    const folded = 'Test data: --Create--; Position = 40106337 Job Code = MKB12.12; Effective Start Date = Today; --Insert R1--; Effective Start Date = Next day';
    assert.deepEqual(testDataPairsOf(folded), [
      { phase: 'Create', key: 'Position', value: '40106337' },
      { phase: 'Create', key: 'Job Code', value: 'MKB12.12' },
      { phase: 'Create', key: 'Effective Start Date', value: 'Today' },
      { phase: 'Insert R1', key: 'Effective Start Date', value: 'Next day' },
    ]);
    const corrected = testDataPairsOf('- Benefit plan ID = TH_MED_001\n- Note: ดราฟต์เดิมระบุ TH_MED_001 ใช้ TH_MED_002');
    assert.equal(corrected[0]!.value, 'TH_MED_002');
    // A bullet is stripped; a phase header is not a bullet.
    assert.deepEqual(testDataPairsOf('- --Delete--\n- Name = QA-Delete'), [{ phase: 'Delete', key: 'Name', value: 'QA-Delete' }]);
  });

  it('fromTestData takes pre-split pairs, matches a key after `*` and parentheticals, and reads a Thai label off the intent', () => {
    const need = findUnresolvedValues([], [tokenStep({ value: '<POSITION>', intent: 'Step 2: กรอก Position = <POSITION>', selector: 'role=textbox[name="Position *" i]' })], CASE)[0]!;
    assert.equal(need.field, 'Position *');
    const pairs = [{ phase: 'Create', key: 'Position (SAP code)', value: '40106337' }];
    const r = fromTestData(need, 'nothing here', pairs);
    assert.equal(r?.value, '40106337');
    assert.match(r!.source.detail, /\[Create\] Position \(SAP code\) = 40106337/);
    // The packed line, read straight from the case text.
    const packed = fromTestData({ ...need, field: 'Job Code' }, 'Test data: Position = 40106337 Job Code = MKB12.12');
    assert.equal(packed?.value, 'MKB12.12');
    // A Thai label after the sheet's verb, when the selector has no name.
    assert.equal(fieldLabelOf({ action: 'fill', selector: '#plan-name', value: '', intent: 'กรอก ชื่อแผน = ประกันสุขภาพ' } as FlowStep), 'ชื่อแผน');
    const thai = fromTestData({ ...need, field: 'ชื่อแผน' }, 'Test data: ชื่อแผน = ประกันสุขภาพ');
    assert.equal(thai?.value, 'ประกันสุขภาพ');
  });
});

// --- CG-06: relative dates, deterministic from an injected now -----------------------

const NOW = new Date(2026, 8, 3, 12); // 3 Sep 2026, local
const env = (known: Record<string, string> = {}) => ({ now: NOW, lookup: (l: string) => known[l.toLowerCase()] ?? null });

describe('relative dates', () => {
  it('the sheet\'s English and Thai anchors', () => {
    const at = (p: string, k: Record<string, string> = {}) => resolveDatePhrase(p, env(k))?.iso ?? null;
    assert.equal(at('Today'), '2026-09-03');
    assert.equal(at('วันนี้'), '2026-09-03');
    assert.equal(at('Next day'), '2026-09-04');
    assert.equal(at('Next Day'), '2026-09-04');
    assert.equal(at('Tomorrow'), '2026-09-04');
    assert.equal(at('วันถัดไป'), '2026-09-04');
    assert.equal(at('Next day+1'), '2026-09-05');
    assert.equal(at('Next day + 1'), '2026-09-05');
    assert.equal(at('Today + 30 Days'), '2026-10-03');
    assert.equal(at('ย้อนหลัง 3 วัน'), '2026-08-31');
    assert.equal(at('3 วันก่อน'), '2026-08-31');
    assert.equal(at('วันที่ 25 ของเดือนปัจจุบัน'), '2026-09-25');
    assert.equal(at('วันที่ 5 ของเดือนถัดไป'), '2026-10-05');
    assert.equal(at('วันสุดท้ายของเดือน'), '2026-09-30');
    assert.equal(at('วันสุดท้ายของเดือนถัดไป'), '2026-10-31');
    assert.equal(at('last day of next month'), '2026-10-31');
    assert.equal(at('01/01 ของปีก่อนหน้า'), '2025-01-01');
    assert.equal(at('31 Dec 9999'), '9999-12-31');
    assert.equal(at('31/12/9999'), '9999-12-31');
    assert.equal(at('Dec 31, 9999'), '9999-12-31');
    assert.equal(at('today พอดี'), '2026-09-03');
  });

  it('Thai month names and Buddhist years', () => {
    assert.deepEqual(absoluteDateOf('25 ธันวาคม 2569'), { y: 2026, m: 12, d: 25 });
    assert.deepEqual(absoluteDateOf('25 ธ.ค. 69'), { y: 2026, m: 12, d: 25 });
    assert.deepEqual(absoluteDateOf('1 Sep 2027'), { y: 2027, m: 9, d: 1 });
    assert.equal(absoluteDateOf('01/09/2027'), null, 'day/month order is the writer\'s, so it is left alone');
    assert.equal(absoluteDateOf('31 Feb 2026'), null);
  });

  it('a later field leans on an earlier one by label, and month arithmetic clamps', () => {
    const r = resolveDatePhrase('Hire Date + 119 Day', env({ 'hire date': '2026-09-03' }));
    assert.equal(r?.iso, '2026-12-31');
    assert.equal(r?.detail, 'Hire Date + 119 Day = 2026-12-31 (Hire Date = 2026-09-03)');
    assert.equal(resolveDatePhrase('Hire Date + 1 Year - 1 Day', env({ 'hire date': '2026-09-03' }))?.iso, '2027-09-02');
    assert.equal(resolveDatePhrase('Hire Date + 119 Day', env())?.iso ?? null, null, 'an unknown label is a refusal, not today');
    assert.equal(resolveDatePhrase('Today + 1 Month', { now: new Date(2026, 0, 31, 12), lookup: () => null })?.iso, '2026-02-28');
    assert.equal(resolveDatePhrase('Effective Start Date', env()), null, 'a bare label with no date behind it is nothing');
    assert.equal(resolveDatePhrase('Somchai', env()), null);
  });

  it('an age is a date of birth at the hire date, half a year inside a strict bound, exact on a boundary', () => {
    const k = { 'hire date': '2026-09-03' };
    assert.equal(resolveDatePhrase('Age < 60', env(k))?.iso, '1967-03-03');
    assert.match(resolveDatePhrase('Age < 60', env(k))!.detail, /age 59 y 6 m at hire date 2026-09-03/);
    assert.equal(resolveDatePhrase('อายุน้อยกว่า 60 ปี', env(k))?.iso, '1967-03-03');
    assert.equal(resolveDatePhrase('Age >= 60', env(k))?.iso, '1966-09-03');
    assert.equal(resolveDatePhrase('อายุ 60 ปีขึ้นไป', env(k))?.iso, '1966-09-03');
    assert.equal(resolveDatePhrase('อายุพอดี 60 ปีเป๊ะ', env(k))?.iso, '1966-09-03');
    assert.equal(resolveDatePhrase('Age > 60', env(k))?.iso, '1966-03-03');
    assert.equal(resolveDatePhrase('35 ปี 6 เดือน', env(k))?.iso, '1991-03-03');
    // No hire date resolved: today is the anchor, and the detail says so.
    assert.match(resolveDatePhrase('Age < 60', env())!.detail, /at today 2026-09-03/);
  });

  it('isDatePhrase gates on shape, and `N ปี M เดือน` only on a birth-date field', () => {
    for (const p of ['Today', 'Next day', 'Age < 60', 'Hire Date + 119 Day', 'วันที่ 25 ของเดือนปัจจุบัน', '31 Dec 9999', '25 ธ.ค. 69']) assert.equal(isDatePhrase(p), true, p);
    for (const p of ['Somchai', '20001234', '2026-09-03', 'A - Permanent', 'Effective Start Date', '']) assert.equal(isDatePhrase(p), false, p);
    assert.equal(isDatePhrase('6 เดือน', 'Claim Period'), false);
    assert.equal(isDatePhrase('35 ปี 6 เดือน', 'Date of Birth'), true);
  });

  it('is the FIRST source, and needs no model: a phrase typed as written, or stated in the Test data', async () => {
    const calls: string[] = [];
    const db = new StubDb();
    const caseText = [
      'HIR-EC-001: New hire',
      'Test data: Hire Date = Today; Date of Birth = Age < 60; Period End Date* = Hire Date + 119 Day; Replaced Employee ID = 20001234',
    ].join('\n');
    const out = await resolveValues(
      [],
      [
        { action: 'fill', selector: 'role=textbox[name="Hire Date" i]', value: 'Today', intent: 'Step 2: key Hire Date = Today' } as FlowStep,
        { action: 'fill', selector: 'role=textbox[name="Date of Birth" i]', value: 'Age < 60', intent: 'Step 3: key Date of Birth' } as FlowStep,
        { action: 'fill', selector: 'role=textbox[name="Period End Date" i]', value: '<PERIOD_END>', intent: 'Step 4: key Period End Date' } as FlowStep,
        tokenStep({ value: '<VALID_EMPLOYEE_ID>', intent: 'Step 5: กรอก Replaced Employee ID = <VALID_EMPLOYEE_ID>' }),
      ],
      { caseText, model: model({ calls }), db: async () => db, now: NOW },
    );
    const steps = out.steps as { value: string; intent: string; valueSource?: { kind: string; detail: string } }[];
    assert.equal(steps[0]!.value, '2026-09-03');
    assert.deepEqual(steps[0]!.valueSource, { kind: 'relative-date', detail: 'Today = 2026-09-03' });
    assert.match(steps[0]!.intent, /value from relative-date: Today = 2026-09-03/);
    assert.equal(steps[1]!.value, '1967-03-03', 'the DOB is relative to the Hire Date resolved just before');
    assert.equal(steps[2]!.value, '2026-12-31', 'a token whose Test data line is a phrase is computed too');
    assert.equal(steps[2]!.valueSource?.kind, 'relative-date');
    assert.equal(steps[3]!.value, '20001234', 'a plain value still comes from test data');
    assert.equal(steps[3]!.valueSource?.kind, 'test-data');
    assert.deepEqual(calls, [], 'no model was consulted');
    assert.equal(db.queries.length, 0);
    assert.equal(out.resolved.length, 4);
  });

  it('a phrase in the Test data resolves the field even when the sheet lists it after the one that leans on it', () => {
    const caseText = 'Test data: Period End Date = Hire Date + 119 Day; Hire Date = Today';
    const need = { section: 'steps' as const, index: 0, field: 'Period End Date', token: null, nonExisting: false, format: null };
    assert.equal(fromRelativeDate(need, caseText, NOW)?.value, '2026-12-31');
  });

  it('a phrase nothing understands is left as written — never a stand-in', async () => {
    const log: string[] = [];
    const out = await resolveValues([], [{ action: 'fill', selector: 'role=textbox[name="Hire Date" i]', value: 'Nonexistent Label + 3 Day', intent: 'x' } as FlowStep], {
      caseText: 'nothing',
      model: model({}),
      now: NOW,
      onLog: (l) => log.push(l),
    });
    assert.equal(out.resolved.length, 0);
    assert.equal((out.steps[0] as { value: string }).value, 'Nonexistent Label + 3 Day');
    assert.ok(log.some((l) => /was not understood — left as written/.test(l)));
  });

  it('a selectOption whose option label reads like a phrase is not a need', () => {
    const needs = findUnresolvedValues([], [{ action: 'selectOption', selector: 'role=combobox[name="Repeat" i]', value: 'Next day' } as FlowStep], '');
    assert.equal(needs.length, 0);
  });
});

// --- CG-13: a key that IS the case id becomes unique per run ---------------------------

describe('unique per run', () => {
  const BE = [
    'PL_06_21: ตรวจสอบการสร้าง Benefit Plan',
    'Test data: Benefit Plan ID = PL_06_21; Benefit name = QA-Create Plan Success/History; Country = TH',
    'Expected output:',
    '  1.1 ระบบสร้าง Plan สำเร็จ',
  ].join('\n');
  const planStep = (value: string, intent = 'Step 2: key Benefit Plan ID'): FlowStep =>
    ({ action: 'fill', selector: 'role=textbox[name="Benefit Plan ID" i]', value, intent }) as FlowStep;

  it('recognises the case id in any spelling, the sheet\'s _R1 tail, and QA-/SIT_ names — on key fields only', () => {
    assert.equal(isReusedKeyValue('PL_06_21', 'Benefit Plan ID', 'PL_06_21'), true);
    assert.equal(isReusedKeyValue('pl-06-21', 'Benefit Plan ID', 'PL_06_21'), true);
    assert.equal(isReusedKeyValue('PL_06_21_R3', 'Benefit Plan ID', 'PL_06_21'), true);
    assert.equal(isReusedKeyValue('QA-Insert', 'Benefit name', 'PL_08_19'), true);
    assert.equal(isReusedKeyValue('SIT_CNS_01', 'Document Code', 'CNS-EC-003'), true);
    assert.equal(isReusedKeyValue('TH_MED_001', 'Benefit Plan ID', 'PL_10_05'), false, 'a value chosen for its meaning stays');
    assert.equal(isReusedKeyValue('PL_06_21', 'Description', 'PL_06_21'), false, 'not a key field');
    assert.equal(isReusedKeyValue('PL_06_21', 'Benefit Plan ID', undefined), false, 'no case id, only QA-/SIT_ qualify');
  });

  it('rewrites the typed value with the run suffix and flags the source', async () => {
    const out = await resolveValues([], [planStep('PL_06_21')], { caseText: BE, model: null, runKey: 'be100@2026-08-31t07-20-25-957z', caseId: 'PL_06_21' });
    const step = out.steps[0] as { value: string; intent: string; valueSource?: { kind: string; detail: string } };
    assert.equal(step.value, 'PL_06_21_25957z');
    assert.deepEqual(step.valueSource, { kind: 'unique-per-run', detail: 'unique per run: PL_06_21 → PL_06_21_25957z' });
    assert.match(step.intent, /value unique per run: PL_06_21 → PL_06_21_25957z/);
    assert.equal(out.resolved[0]!.source.kind, 'unique-per-run');
  });

  it('a value reached through the Test data gets the suffix too, and the detail keeps the sheet line', async () => {
    const out = await resolveValues([], [planStep('<PLAN_ID>')], { caseText: BE, model: null, runKey: 'be100@2026-08-31t07-20-25-957z', caseId: 'PL_06_21' });
    const step = out.steps[0] as { value: string; valueSource?: { kind: string; detail: string } };
    assert.equal(step.value, 'PL_06_21_25957z');
    assert.equal(step.valueSource?.kind, 'unique-per-run');
    assert.match(step.valueSource!.detail, /the case states "Benefit Plan ID = PL_06_21"/);
  });

  it('a duplicate case keeps the value: the text says it already exists', async () => {
    const dup = `${BE}\n- Benefit plan ID = PL_06_21 (มีอยู่แล้วในระบบ)\n  1.2 แสดง Error: Plan ID นี้มีอยู่แล้วในระบบ`;
    const log: string[] = [];
    const out = await resolveValues([], [planStep('PL_06_21')], { caseText: dup, model: null, runKey: 'be100@x', caseId: 'PL_06_21', onLog: (l) => log.push(l) });
    assert.equal((out.steps[0] as { value: string }).value, 'PL_06_21');
    assert.equal(out.resolved.length, 0);
    assert.ok(log.some((l) => /kept as written \(the case says it already exists\)/.test(l)));
    // The intent alone can say so.
    const need = findUnresolvedValues([], [planStep('PL_06_21', 'Step 3: key the existing Plan ID again')], BE, { caseId: 'PL_06_21' })[0]!;
    assert.equal(fromUniquePerRun(need, BE, 'be100@x', 'Step 3: key the existing Plan ID again'), null);
  });

  it('without a run key nothing is rewritten, and a value that is not a key is never a need', async () => {
    const out = await resolveValues([], [planStep('PL_06_21')], { caseText: BE, model: null, caseId: 'PL_06_21' });
    assert.equal((out.steps[0] as { value: string }).value, 'PL_06_21');
    assert.equal(out.resolved.length, 0);
    assert.equal(findUnresolvedValues([], [planStep('TH_MED_001')], BE, { caseId: 'PL_06_21' }).length, 0);
  });
});

// --- the workbook's own cell shapes (QA_Task_Tracking_Cycle1.xlsx, read whole on 2026-09-04) --------
//
// Every value below is quoted from a real cell, the case id in the test name.
// The rule under test is structural (a trailing clause, a quoted example, a
// mask, a label reference, an anchor clause) over the built-in vocabulary.

import {
  describesOwnField,
  exampleValuesIn,
  isDescription,
  labelOfDatePair,
  normalLabel,
  writtenValueOf,
  MASK_VALUE,
} from '../src/generator/value-resolution.js';

const fill = (field: string, value: string, action: 'fill' | 'selectOption' = 'fill'): FlowStep =>
  ({ action, selector: `role=textbox[name="${field}" i]`, value, intent: `key ${field}` }) as FlowStep;
type Out = { value: string; intent: string; valueSource?: { kind: string; detail: string } };

describe("the workbook's own cell shapes", () => {
  it('a value followed by a note or a bound is cleaned in place, never handed to a model (HIR-EC-015, PRB-EC-038, HIR-EC-135)', async () => {
    const calls: string[] = [];
    const out = await resolveValues(
      [],
      [fill('Employee Sub Group', '10 ตามชุดข้อมูล'), fill('Personnel Grade', '11 ขึ้นไป'), fill('Work Schedule', 'D05H0830 ตามที่ Position กำหนด'), fill('Employee Group', 'A - Permanent')],
      { caseText: 'nothing', model: model({ calls }), now: NOW },
    );
    const steps = out.steps as Out[];
    assert.deepEqual(steps.map((s) => s.value), ['10', '11', 'D05H0830', 'A - Permanent']);
    assert.equal(steps[0]!.valueSource?.kind, 'test-data');
    assert.match(steps[0]!.valueSource!.detail, /the case writes "10 ตามชุดข้อมูล"; the value is "10"/);
    assert.equal(steps[3]!.valueSource, undefined, 'a plain value is not a need');
    assert.deepEqual(calls, [], 'cleaning is single-source: no model, ever');
    assert.equal(out.resolved.length, 3);
  });

  it('a blank word leaves the field empty — typed, or stated in the Test data (HIR-EC-059, HIR-EC-001, HIR-EC-139)', async () => {
    const calls: string[] = [];
    const out = await resolveValues(
      [],
      [fill('Payment Method', 'Blank'), fill('DVT Project', 'null'), fill('Transfer out to', 'เว้นว่างในเคสนี้ เพราะเป็นการรับพนักงานเข้า ไม่ใช่การโอนออก'), fill('Account Number', '<ACCOUNT>')],
      { caseText: 'Test data: Account Number = Blank', model: model({ calls }), now: NOW },
    );
    const steps = out.steps as Out[];
    assert.deepEqual(steps.map((s) => s.value), ['', '', '', '']);
    assert.match(steps[0]!.valueSource!.detail, /leave it blank: "Blank"/);
    assert.match(steps[3]!.valueSource!.detail, /leave it blank: "Account Number = Blank"/);
    assert.deepEqual(calls, []);
  });

  it('a mask is a need with its own format and the cited case; a non-existing mask stays non-existing (PRB-EC-036, PL_10_54)', async () => {
    const need = findUnresolvedValues([], [fill('Employee ID', 'EMXXXX (จาก E2E-01)')], 'nothing')[0]!;
    assert.equal(need.token, 'EMXXXX');
    assert.equal(need.format?.mask, 'EMXXXX');
    assert.equal(need.reference, 'E2E-01');
    assert.equal(need.nonExisting, false);
    const out = await resolveValues([], [fill('Employee ID', 'EMXXXX (จาก E2E-01)')], { caseText: 'nothing', model: null });
    const step = out.steps[0] as Out;
    assert.match(step.value, /^EM\d{4}$/, 'the letters of the mask are kept, the X digits invented');
    assert.equal(step.valueSource?.kind, 'generated');
    const absent = findUnresolvedValues([], [fill('Benefit plan ID', 'BE-XXX-999 (ไม่มีในระบบ)')], 'nothing')[0]!;
    assert.equal(absent.token, 'BE-XXX-999');
    assert.equal(absent.nonExisting, true);
    assert.match(candidateFor(absent.format), /^BE-\d{3}-999$/);
    assert.equal(MASK_VALUE.test('MedicalReimbursement--XXX(XXX-XXX)-A'), false, 'a name that merely contains XXX is not a mask');
  });

  it('a described invalid value with its own examples types the first example (PL_10_40)', async () => {
    const cell = 'ค่าอื่นที่ไม่ถูกต้อง เช่น "Active", "X"';
    assert.deepEqual(exampleValuesIn(cell), ['Active', 'X']);
    const calls: string[] = [];
    const out = await resolveValues([], [fill('status', cell)], { caseText: `Test data: status = ${cell}`, model: model({ calls }), now: NOW });
    assert.equal((out.steps[0] as Out).value, 'Active');
    assert.deepEqual(calls, []);
    // Through a token on the same field, the Test data line answers with the example too.
    const viaToken = await resolveValues([], [fill('status', '<INVALID_STATUS>')], { caseText: `Test data: status = ${cell}`, model: null });
    assert.equal((viaToken.steps[0] as Out).value, 'Active');
    assert.equal((viaToken.steps[0] as Out).valueSource?.kind, 'test-data');
  });

  it('a stated length is a format, and the stand-in has that length (PL_10_48)', async () => {
    const cell = 'ข้อความความยาวเกิน 255 ตัวอักษร';
    assert.deepEqual(formatStatedFor('Benefit name EN', `Benefit name EN/TH = ${cell}`), { length: 255, lengthRelation: 'over' });
    assert.equal(candidateFor({ length: 255, lengthRelation: 'over' }).length, 256);
    assert.equal(candidateFor({ length: 50, lengthRelation: 'under' }).length, 49);
    assert.equal(candidateFor({ length: 10, lengthRelation: 'exact' }).length, 10);
    const out = await resolveValues([], [fill('Benefit name EN', cell)], { caseText: `Test data: Benefit name EN/TH = ${cell}`, model: null });
    const step = out.steps[0] as Out;
    assert.equal(step.value.length, 256);
    assert.equal(step.valueSource?.kind, 'generated');
    assert.match(step.valueSource!.detail, /over 255 characters/);
  });

  it('a quoted literal keeps its exact text and drops the remark; a concrete value beside an OQ pointer is still the value (PL_10_41, HIR-EC-120)', async () => {
    assert.equal(writtenValueOf('"32/13/2026" (วันที่ผิดรูปแบบ)'), '32/13/2026');
    assert.equal(writtenValueOf('"N",ว่าง'), 'N');
    const out = await resolveValues([], [fill('Effective Start Date', '"32/13/2026" (วันที่ผิดรูปแบบ)')], { caseText: 'nothing', model: null, now: NOW });
    assert.equal((out.steps[0] as Out).value, '32/13/2026', 'a deliberately malformed date is typed exactly, never computed');
    const pairs = [{ phase: null, key: 'Division', value: '20000248 (ยังไม่พบช่องชื่อ Division บนหน้าจอ ดู OQ-HIR-138)' }];
    const need = findUnresolvedValues([], [fill('Division', '<DIVISION>')], 'nothing', { pairs })[0]!;
    assert.equal(fromTestData(need, 'nothing', pairs)?.value, '20000248');
  });

  it('the date grammar the workbook needed (RU_05_24, HIR-EC-041, HIR-EC-030, HIR-EC-005, HIR-EC-070, HIR-EC-006, HIR-EC-071, HIR-EC-015, HIR-EC-072, HIR-EC-019, HIR-EC-075)', () => {
    const k = { 'hire date': '2026-09-03' };
    const at = (p: string) => resolveDatePhrase(p, env(k));
    assert.equal(at('31-Dec-9999')?.iso, '9999-12-31');
    assert.equal(at('13 เมษายน')?.iso, '2026-04-13', 'a day and month with no year is this year');
    assert.equal(at('1 มกราคมของปีก่อนหน้า')?.iso, '2025-01-01');
    assert.equal(at('< Current Date')?.iso, '2026-09-02');
    assert.match(at('< Current Date')!.detail, /the day before/);
    assert.equal(at('วันก่อน Hire Date')?.iso, '2026-09-02');
    assert.equal(at('Age = 60 พอดี ณ Hire Date')?.iso, '1966-09-03');
    assert.match(at('Age = 60 พอดี ณ Hire Date')!.detail, /^Age = 60 พอดี ณ Hire Date = 1966-09-03 \(age 60 y at Hire Date 2026-09-03\)$/);
    assert.equal(at('ทำให้อายุ ณ Hire Date เท่ากับ 59 ปี 11 เดือน')?.iso, '1966-10-03');
    assert.equal(at('ทำให้อายุมากกว่า 60 ปี ณ Hire Date')?.iso, '1966-03-03');
    assert.equal(at('ย้อนหลังจากวันที่ทดสอบ 5')?.iso, '2026-08-29');
    assert.equal(at('วันที่ทดสอบ บวก 30 วัน')?.iso, '2026-10-03');
    assert.equal(at('วันในอนาคต')?.iso, '2026-09-04');
    assert.equal(at('Hire Date + 60 วัน ให้มาก่อน Probationary Period End Date')?.iso, '2026-11-02', 'a trailing instruction is set aside');
    assert.equal(at('Hire Date + 90 Day (หรือมากกว่า แต่ไม่เกิน 119 Day)')?.iso, '2026-12-02');
    assert.equal(at('Age = 60 ณ Contract Date'), null, 'an anchor the case never set is a refusal, not today');
    assert.equal(at('3 วันก่อน')?.iso, '2026-08-31', 'still: N days before');
    assert.equal(at('3 days ago')?.iso, '2026-08-31');
  });

  it("an alias finds the field, and a value that is another date field's label follows it (HIR-EC-070, PRB-EC-066)", async () => {
    const pairs = [
      { phase: null, key: 'Hire Date', value: 'Today' },
      { phase: null, key: 'วันหมดอายุใบอนุญาตทำงาน', value: 'วันก่อนวันที่จ้าง' },
      { phase: null, key: 'Probationary Period End Date', value: 'Hire Date' },
    ];
    assert.equal(labelOfDatePair('Hire Date', pairs)?.key, 'Hire Date');
    assert.equal(labelOfDatePair('Hire Date', [pairs[2]!]), null, 'a label pointing at itself is nothing');
    const out = await resolveValues(
      [],
      [fill('วันหมดอายุใบอนุญาตทำงาน', '<EXPIRY>'), fill('Probationary Period End Date', 'Hire Date'), fill('Employee Group', 'Hire Date', 'selectOption')],
      { caseText: 'nothing', model: null, now: NOW, testDataPairs: pairs },
    );
    const steps = out.steps as Out[];
    assert.equal(steps[0]!.value, '2026-09-02', 'วันที่จ้าง is Hire Date by alias');
    assert.equal(steps[0]!.valueSource?.kind, 'relative-date');
    assert.equal(steps[1]!.value, '2026-09-03');
    assert.equal(steps[2]!.value, 'Hire Date', 'an option label is never a phrase');
  });

  it('what is deliberately left alone (PL_08_06, RU_06_04, HIR-EC-048, PRB-EC-036)', async () => {
    const untouched = [
      fill('Company', 'CDS (C001), B2S (C006), RBS (C002)'),
      fill('Rule name', 'MedicalReimbursement--XXX(XXX-XXX)-A - Permanent(7-16)-(12/31/9999)'),
      fill('Employee ID', '<runtime>'),
      fill('Personnel Grade', '07 ถึง 10'),
      fill('Company', 'CDS (C001)', 'selectOption'),
    ];
    const out = await resolveValues([], untouched, { caseText: 'nothing', model: null, now: NOW });
    assert.deepEqual(
      (out.steps as Out[]).map((s) => s.value),
      untouched.map((s) => (s as { value: string }).value),
      'a list, a glued bracket (a phrase by its 9999, understood by nothing), a lowercase token, a range and an option label are typed as written',
    );
    assert.equal(out.resolved.length, 0);
    assert.deepEqual(findUnresolvedValues([], [fill('Company', 'CDS (C001)')], 'nothing').map((n) => n.written), ['CDS'], 'a fill drops the code in brackets, as the test-data source always did');
    assert.equal(isDatePhrase('<runtime>'), false);
    assert.equal(isDatePhrase('07 ถึง 10'), false);
  });
});

// --- the workbook read a second time (QA_Task_Tracking_Cycle1.xlsx, 2026-09-04) --------------
//
// Every pair of the 1,286 rows was classified through the resolver's own
// functions (8,225 pairs). The classes below are the ones the first pass typed
// verbatim or answered wrongly; each test quotes the real cell with its case id.

describe("the workbook's value classes, second pass", () => {
  it('a concrete value that CITES an open question is the value; one that IS the question stays (HIR-EC-114, HIR-EC-044, HIR-EC-001)', async () => {
    const out = await resolveValues(
      [],
      [
        fill('Department', '30009285 (คีย์ที่ช่อง Organization ดู OQ-HIR-138)'),
        fill('Personnel Grade (PG)', '11 ใช้แทน 10 ที่เคยระบุ เพราะ CPN ไม่มี Position ว่าง Personnel Grade (PG) 10 ดู CF-SIT-07'),
        fill('Probationary Period End Date', '? CF-HIR-08 OQ-HIR-50'),
        fill('Note', 'see OQ-HIR-78'),
      ],
      { caseText: 'nothing', model: null, now: NOW },
    );
    const steps = out.steps as Out[];
    assert.deepEqual(steps.map((s) => s.value), ['30009285', '11', '? CF-HIR-08 OQ-HIR-50', 'see OQ-HIR-78']);
    assert.equal(steps[0]!.valueSource?.kind, 'test-data');
    assert.equal(steps[2]!.valueSource, undefined, 'a value that IS an open question is nobody\'s to resolve');
    assert.equal(steps[3]!.valueSource, undefined, 'a note that only points at a question is left alone');
  });

  it('a remark after a connective is set aside: แก้จาก, ซึ่ง, ถ้า, แต่, เป็น (HIR-EC-002, HIR-EC-057, PRB-EC-067, PRB-EC-059, HIR-EC-007)', () => {
    assert.equal(writtenValueOf('D05H0830 แก้จากเดิมที่ระบุ D05H0800_02 ซึ่งไม่มีในตาราง ดู CF-SIT-11'), 'D05H0830');
    assert.equal(writtenValueOf('40004936 ซึ่งสังกัด Company C004 คนละ Company กับที่กรอก'), '40004936');
    assert.equal(writtenValueOf('Yes ถ้า field แสดง'), 'Yes');
    assert.equal(writtenValueOf('A Permanent แต่ Employee Sub Group เป็นชุด Piecework X7 ถึง XB'), 'A Permanent');
    assert.equal(writtenValueOf('UC เป็น Employee Sub Group ค่าเดียวที่ตาราง FO ผูกไว้กับกลุ่ม B ดู OQ-HIR-104'), 'UC');
    assert.equal(writtenValueOf('7 หาก Dropdown มีค่าให้เลือก'), '7');
    assert.equal(writtenValueOf('C - ต่างชาติมาทำงานไทย'), 'C - ต่างชาติมาทำงานไทย', 'a connective glued inside a Thai label is not a remark');
    assert.equal(writtenValueOf('H - บุคคลภายนอกที่จ่ายเงิน'), 'H - บุคคลภายนอกที่จ่ายเงิน');
  });

  it('alternatives mean any one of them, and the first is typed; a slash inside one value is not a list (HIR-EC-003, PL_06_25, PRB-EC-082, RU_07_02, PL_03_07, HIR-EC-005)', async () => {
    assert.equal(writtenValueOf('Yes / No'), 'Yes');
    assert.equal(writtenValueOf('PL_06_25 / PL_06_25_70813'), 'PL_06_25');
    assert.equal(writtenValueOf('Job Change หรือ Salary Adjustment'), 'Job Change');
    assert.equal(writtenValueOf('Reimbursement: Employee/HR'), 'Reimbursement: Employee/HR');
    assert.equal(writtenValueOf('01/02/2021'), '01/02/2021');
    const out = await resolveValues(
      [],
      [fill('Copy Address from Employee', 'Yes / No'), fill('Effective Date', 'ว่าง/วันที่ในอดีต/วันที่ปัจจุบัน หรืออนาคต'), fill('Type', 'Reimbursement: Employee/HR', 'selectOption')],
      { caseText: 'nothing', model: null, now: NOW },
    );
    const steps = out.steps as Out[];
    assert.equal(steps[0]!.value, 'Yes');
    assert.equal(steps[1]!.value, '', 'the first alternative is the blank word, so the field is left empty');
    assert.equal(steps[2]!.value, 'Reimbursement: Employee/HR');
  });

  it('a list of nothing but quoted literals is a boundary set; the first is typed, with the outer quotes the block reader stripped (PL_10_43, RU_03_15)', async () => {
    assert.deepEqual(exampleValuesIn('abc", "-30", "0", "900'), ['abc', '-30', '0', '900']);
    assert.deepEqual(exampleValuesIn('"abc", "1.5", "-", "+", "!@#"'), ['abc', '1.5', '-', '+', '!@#']);
    assert.deepEqual(exampleValuesIn('CDS (C001), B2S (C006)'), [], 'an unquoted list is not one — it may be a multi-select');
    const out = await resolveValues([], [fill('Eligible Claim date', 'abc", "-30", "0", "900')], { caseText: 'nothing', model: null, now: NOW });
    assert.equal((out.steps[0] as Out).value, 'abc');
  });

  it('a space word is one space, typed on purpose; a blank word as the remark of a placeholder is blank (PL_06_17, RU_05_28, PL_06_16)', async () => {
    const calls: string[] = [];
    const out = await resolveValues([], [fill('Benefit Name', 'เว้นวรรค'), fill('Effective End Date', 'Select Date (ไม่ระบุ)')], { caseText: 'nothing', model: model({ calls }), now: NOW });
    const steps = out.steps as Out[];
    assert.equal(steps[0]!.value, ' ');
    assert.match(steps[0]!.valueSource!.detail, /the value is a space/);
    assert.equal(steps[1]!.value, '');
    assert.match(steps[1]!.valueSource!.detail, /leave it blank/);
    assert.deepEqual(calls, []);
  });

  it('an instruction in the cell is a description, never typed: the value is looked up or a flagged stand-in (HIR-EC-001, HIR-EC-008)', async () => {
    assert.equal(isDescription('District', 'เลือกเขตที่อยู่ในกรุงเทพมหานคร'), true);
    assert.equal(isDescription('Postal Code', 'ตาม Sub-District ที่เลือก'), true);
    assert.equal(isDescription('Employee Group', 'A - Permanent'), false);
    assert.equal(isDescription('Entry Route', 'Keyin'), false);
    const out = await resolveValues(
      [],
      [fill('District', 'เลือกเขตที่อยู่ในกรุงเทพมหานคร'), fill('Postal Code', 'ตาม Sub-District ที่เลือก'), fill('Passport', 'ใช้แทน National ID 13 หลัก')],
      { caseText: 'Test data: District = เลือกเขตที่อยู่ในกรุงเทพมหานคร; Postal Code = 10110', model: null, now: NOW },
    );
    const steps = out.steps as Out[];
    assert.equal(steps[0]!.valueSource?.kind, 'generated', 'its own line is the same instruction and answers nothing');
    assert.doesNotMatch(steps[0]!.value, /เลือก/);
    assert.equal(steps[1]!.value, '10110', 'the Test data line with a concrete value answers');
    assert.equal(steps[1]!.valueSource?.kind, 'test-data');
    assert.match(steps[2]!.value, /^\d{13}$/, 'the format the instruction itself states shapes the stand-in');
  });

  it("a value that names its own field and goes on in prose is a description; an option label that merely contains the field's word is not (HIR-EC-017, HIR-EC-026, HIR-EC-032, PL_03_07, PL_07_01)", async () => {
    assert.equal(describesOwnField('Replaced Employee ID', 'Employee ID ที่ลาออกแล้วและเคยครอง Position 40001378'), true);
    assert.equal(describesOwnField('National ID', 'National ID เดียวกับพนักงานเดิม'), true);
    assert.equal(describesOwnField('Contract End Date', 'Contract End Date จริง'), true);
    assert.equal(describesOwnField('Country', 'Mock Country (TH)'), false);
    assert.equal(describesOwnField('Enrollment', 'Manual Enrollment'), false);
    assert.equal(describesOwnField('Employee ID', 'Employee ID'), false);
    const out = await resolveValues([], [fill('Replaced Employee ID', 'Employee ID ที่ลาออกแล้วและเคยครอง Position 40001378')], { caseText: 'nothing', model: null, now: NOW });
    const step = out.steps[0] as Out;
    assert.equal(step.valueSource?.kind, 'generated');
    assert.match(step.value, /^\d{8}$/);
  });

  it('a credential token is never invented: the Test data may answer, a stand-in may not (HIR-EC-044 and 130 more rows)', async () => {
    const calls: string[] = [];
    const log: string[] = [];
    const out = await resolveValues([], [fill('Login', '<HR_ADMIN_ACCOUNT>'), fill('Employee ID', '<EMPLOYEE_ID>')], { caseText: 'nothing', model: model({ calls }), now: NOW, onLog: (l) => log.push(l) });
    const steps = out.steps as Out[];
    assert.equal(steps[0]!.value, '<HR_ADMIN_ACCOUNT>', 'left as authored, for the lint and the persona sign-in');
    assert.equal(steps[0]!.valueSource, undefined);
    assert.ok(log.some((l) => /credential — never generated/.test(l)), log.join('\n'));
    assert.equal(steps[1]!.valueSource?.kind, 'generated', 'an ordinary token still gets its stand-in');
    assert.ok(calls.includes('generated'), 'the generate call was made for the id, not the login');
    assert.equal(calls.filter((c) => c === 'generated').length, 1);
    const stated = await resolveValues([], [fill('Login', '<HR_ADMIN_ACCOUNT>')], { caseText: 'Test data: Login = hr.admin', model: null, now: NOW });
    assert.equal((stated.steps[0] as Out).value, 'hr.admin');
    assert.equal(findUnresolvedValues([], [fill('Login', '<HR_ADMIN_ACCOUNT>')], 'nothing')[0]!.credential, true);
  });

  it("a format stated on another key field's line is not this field's (PRB-EC-088)", async () => {
    const caseText = ['Test data:', '- Reason for fail probation : <TEST_VALUE> ระบุข้อความจริงตอนเล่นเคส', '- พนักงาน Employee ID : EMXXXX (จาก E2E-45)', '- Thailand Format = N-NNNN-NNNNN-NN-N'].join('\n');
    assert.equal(formatStatedFor('Reason for fail probation', caseText)?.mask, 'N-NNNN-NNNNN-NN-N', 'a line keyed by something that is not a field still counts');
    assert.equal(formatStatedFor('Employee ID', caseText)?.mask, 'EMXXXX');
    const only = ['Test data:', '- Reason for fail probation : <TEST_VALUE> ระบุข้อความจริงตอนเล่นเคส', '- พนักงาน Employee ID : EMXXXX (จาก E2E-45)'].join('\n');
    assert.equal(formatStatedFor('Reason for fail probation', only), null);
    const out = await resolveValues([], [fill('Reason for fail probation', '<TEST_VALUE> ระบุข้อความจริงตอนเล่นเคส')], { caseText: only, model: null, now: NOW });
    assert.doesNotMatch((out.steps[0] as Out).value, /^EM/, "the Employee ID's mask does not shape the Reason");
  });

  it('the date grammar the second pass needed (HIR-EC-037, HIR-EC-020, HIR-EC-134, HIR-EC-042, HIR-EC-046, HIR-EC-083)', () => {
    const k = { 'hire date': '2026-09-03' };
    const at = (p: string) => resolveDatePhrase(p, env(k));
    assert.equal(at('วันที่ 20')?.iso, '2026-09-20', 'a bare day is that day of this month');
    assert.equal(at('วันที่ 25 ของเดือนปัจจุบัน')?.iso, '2026-09-25', 'still');
    assert.equal(at('วันที่ก่อน Hire Date 1 ปี')?.iso, '2025-09-03', 'a relation with an amount');
    assert.equal(at('2 weeks after Hire Date')?.iso, '2026-09-17');
    assert.equal(at('14 เมษายน รันคู่กับ E2E-41 เพื่อตรวจขอบเขตวันที่')?.iso, '2026-04-14', 'a complete date, then a remark across a gap');
    assert.match(at('14 เมษายน รันคู่กับ E2E-41')!.detail, /remark set aside/);
    assert.equal(at('วันที่ตั้งแต่ 1 มิถุนายน 2025 เป็นต้นไป')?.iso, '2025-06-01');
    assert.equal(at('สิ้นเดือนแบบถอยหลัง P98'), null, 'a remark glued to the date is an expression nobody understands');
    assert.equal(at('วันที่ 1 ถึงสิ้นเดือน'), null, 'a range is not a date');
    assert.equal(at('Today + 3 วัน ถึง'), null, 'one trailing word is not a remark');
    assert.equal(normalLabel('Hire Date >'), 'hire date', 'a stray symbol on a Test data key is not part of the label');
    assert.equal(isDatePhrase('วันที่ 20'), true);
  });

  it("an age anchored on a key the sheet wrote with a stray symbol still finds it (HIR-EC-020)", async () => {
    const pairs = [
      { phase: null, key: 'Hire Date >', value: 'Today' },
      { phase: null, key: 'Date of Birth', value: 'Age = 60 พอดี ณ Hire Date' },
    ];
    const out = await resolveValues([], [fill('Date of Birth', 'Age = 60 พอดี ณ Hire Date')], { caseText: 'nothing', model: null, now: NOW, testDataPairs: pairs });
    assert.equal((out.steps[0] as Out).value, '1966-09-03');
  });
});

// --- the whole workbook, through the reader the CLI uses ---------------------------------------
//
// `tests/fixtures/qa-task-tracking-cycle1.xlsx` is the real 1,286-row QA
// workbook. Every Test data pair of every row is turned into a fill and
// resolved with no model and no database, and the invariants below are what
// the second pass guarantees over the sheet as a whole — a regression table,
// not a per-cell oracle.

import { readFileSync } from 'node:fs';
import { extractWorkbookSheets } from '../src/catalog/extract.js';
import { parseWorkbookCases, testDataPairs } from '../src/catalog/test-case-table.js';

describe('the QA workbook, every pair resolved offline', () => {
  it('holds the second-pass invariants over all 8,225 pairs', async () => {
    const rows = parseWorkbookCases(extractWorkbookSheets(readFileSync(new URL('./fixtures/qa-task-tracking-cycle1.xlsx', import.meta.url)))) ?? [];
    assert.equal(rows.length, 1286);
    const tally = { pairs: 0, cleaned: 0, dates: 0, credentialsKept: 0, blanks: 0, typedInstruction: 0, typedQuestionRemark: 0, typedAlternatives: 0, generatedOnCredential: 0 };
    for (const row of rows) {
      const pairs = testDataPairs(row.testData);
      const steps = pairs.map((p) => fill(p.key.replace(/"/g, ''), p.value));
      const out = await resolveValues([], steps, { caseText: `Test data:\n${row.testData}\nSteps:\n${row.steps}`, model: null, now: NOW, runKey: 'wb@2026-09-04t00-00-00-000z', caseId: row.caseId, testDataPairs: pairs });
      for (const [i, step] of (out.steps as Out[]).entries()) {
        tally.pairs += 1;
        const written = pairs[i]!.value;
        const kind = step.valueSource?.kind;
        if (kind === 'relative-date') tally.dates += 1;
        if (kind === 'test-data' && step.value === '') tally.blanks += 1;
        if (kind === 'test-data' && step.value !== '' && step.value !== written.trim()) tally.cleaned += 1;
        if (PLACEHOLDER_TOKEN.test(step.value) && /ACCOUNT/.test(step.value)) tally.credentialsKept += 1;
        if (kind === 'generated' && /account|login/i.test(pairs[i]!.key)) tally.generatedOnCredential += 1;
        if (kind === undefined && /^(?:กรอก|ระบุ|เลือก|ใช้|ตาม)\s/u.test(step.value)) tally.typedInstruction += 1;
        if (kind === undefined && /\(.*ดู OQ-[A-Z]+-\d+\)$/.test(step.value)) tally.typedQuestionRemark += 1;
        if (kind === undefined && /\S\s+\/\s+\S/.test(step.value)) tally.typedAlternatives += 1;
      }
    }
    assert.equal(tally.pairs, 8225);
    assert.ok(tally.cleaned >= 600, `cleaned ${tally.cleaned}`);
    assert.ok(tally.dates >= 420, `dates ${tally.dates}`);
    assert.ok(tally.blanks >= 100, `blanks ${tally.blanks}`);
    assert.equal(tally.credentialsKept, 131, 'every account token is left for the persona sign-in');
    assert.equal(tally.generatedOnCredential, 0);
    assert.equal(tally.typedInstruction, 0, 'no instruction is typed as a value');
    assert.equal(tally.typedQuestionRemark, 0, 'no value is typed with its open-question pointer');
    assert.equal(tally.typedAlternatives, 0, 'no list of alternatives is typed whole');
  });
});

// --- an open question cited beside a value is a reference, not the value (multirole.csv HIR-EC-001, 2026-09-04) ---
//
// The Test data reads "Business Unit = CDG (10000075) Policy Profile = CDS ใช้แทน
// CDS ที่เคยระบุ ดู CF-SIT-19": the value IS CDS, and the remark says which
// confirmation question settled it. The classifier read the raw cell and, on
// the id alone, told the author to skip the field the same data set lists as
// "[TD-01] Policy Profile = CDS". An OQ-/CF- id makes a value unconfirmed only
// when it IS the value — at the start, or after the sheet's own "?".

import { unconfirmedValue as unconfirmedCell } from '../src/catalog/test-case-table.js';

describe('an open-question id beside a value is a reference (HIR-EC-001)', () => {
  it('keeps a concrete value that cites a confirmation question, and still reads the value as written', () => {
    const cell = 'CDS ใช้แทน CDS ที่เคยระบุ ดู CF-SIT-19';
    assert.equal(unconfirmedCell(cell), false);
    assert.equal(writtenValueOf(cell), 'CDS');
    assert.equal(unconfirmedCell('20000248 (ดู OQ-HIR-138)'), false);
  });

  it('still refuses a value that IS the question', () => {
    // HIR-EC-001, Expected output: "Probationary Period End Date = ? CF-HIR-08 OQ-HIR-50"
    // and "สูตร/เงื่อนไข Rule Table = ? OQ-HIR-13".
    assert.equal(unconfirmedCell('? CF-HIR-08 OQ-HIR-50'), true);
    assert.equal(unconfirmedCell('OQ-HIR-13'), true);
    assert.equal(unconfirmedCell('  CF-SIT-19'), true);
    assert.equal(unconfirmedCell('? รอตาราง Rule Table'), true);
    assert.equal(unconfirmedCell('TBC'), true);
  });
});

// --- a field the page fills from an earlier choice (HIR-EC-001, 2026-09-08) ---

describe('derived fields: what the page fills is asserted, not keyed', () => {
  const pick = (field: string, value: string, role = 'button'): FlowStep =>
    ({ action: 'selectOption', selector: `role=${role}[name="${field}" i]`, value, intent: `select ${field}` }) as FlowStep;
  const type = (field: string, value: string): FlowStep =>
    ({ action: 'fill', selector: `role=textbox[name="${field}" i]`, value, intent: `fill ${field}` }) as FlowStep;

  // The chosen row carries every value the page copies out of it.
  const ROW = {
    positionCode: 'P-005',
    name: { en: 'Analyst' },
    companyCode: 'C-1',
    costCenterCode: 'CC-07',
    departmentCode: 'ORG-9',
    vacant: true,
  };
  const context = async () => ({
    lookups: await readMasterDataDeclaration(MASTER_DATA_FIXTURE),
    fetch: async () => async (url: string) =>
      url.includes('/api/positions') ? { data: { rows: [ROW], hasNextPage: false } } : [{ code: 'CC-07', title: 'North Office' }],
    testDataPairs: [{ phase: null, key: 'Company', value: 'C-1' }],
  });

  it('turns a picked field the row already carries into the assertion it is', async () => {
    const authored = [
      pick('Company', 'C-1'),
      pick('Position', 'P-005'),
      pick('Cost Center', 'CC-07 — North Office'),
      type('Organization', 'ORG-9'),
    ];
    const out = await assertDerivedFields(authored, await context());

    assert.equal(out.derived.length, 2, out.derived.map((d) => d.field).join(', '));
    // A control that renders a chosen option is read by its label…
    assert.equal(out.steps[2]?.action, 'expectText');
    assert.equal((out.steps[2] as { value?: string }).value, 'North Office');
    // …one that holds an input, by the code it holds.
    assert.equal(out.steps[3]?.action, 'expectValue');
    assert.equal((out.steps[3] as { value?: string }).value, 'ORG-9');
    assert.match((out.steps[2] as { intent?: string }).intent ?? '', /asserted, not keyed/);
    assert.deepEqual(
      out.derived.map((d) => `${d.field}<-${d.from}.${d.path}`),
      ['Cost Center<-Position.costCenterCode', 'Organization<-Position.departmentCode'],
    );
  });

  it('never rewrites a step that ran BEFORE the choice, however the row agrees', async () => {
    // `companyCode` is on the row, but Company is the scope the row was fetched
    // under — it is chosen first, and choosing it is the point.
    const authored = [pick('Company', 'C-1'), pick('Position', 'P-005')];
    const out = await assertDerivedFields(authored, await context());
    assert.deepEqual(out.derived, []);
    assert.deepEqual(out.steps, authored);
  });

  it('leaves a value the row does not carry alone — a disagreement is a finding, not a rewrite', async () => {
    const authored = [pick('Company', 'C-1'), pick('Position', 'P-005'), pick('Cost Center', 'CC-99')];
    const out = await assertDerivedFields(authored, await context());
    assert.deepEqual(out.derived, []);
    assert.equal(out.steps[2]?.action, 'selectOption');
  });

  // The row carries `vacant`, and a field could equal any of a dozen keys by
  // coincidence — live, a position's employeeSubgroupCode "10" against a
  // Personnel Grade of 10. Only what the declaration names is copied.
  it('converts nothing the lookup does not declare, however the row agrees', async () => {
    const authored = [
      pick('Position', 'P-005'),
      pick('Employee Sub-Group', 'P-005'),
      { action: 'fill', selector: 'role=textbox[name="Analyst" i]', value: 'Analyst' } as FlowStep,
    ];
    const out = await assertDerivedFields(authored, await context());
    assert.deepEqual(out.derived, []);
    assert.deepEqual(out.steps, authored);
  });

  it('finds the chosen row by the name the sheet writes, not only by its code', async () => {
    const authored = [pick('Company', 'C-1'), pick('Position', 'Analyst'), pick('Cost Center', 'CC-07')];
    const out = await assertDerivedFields(authored, await context());
    assert.equal(out.derived.length, 1);
    assert.equal(out.steps[2]?.action, 'expectText');
  });

  it('opens no transport when the row cannot be fetched, and changes nothing', async () => {
    const lookups = await readMasterDataDeclaration(MASTER_DATA_FIXTURE);
    const authored = [pick('Position', 'P-005'), pick('Cost Center', 'CC-07')];
    const out = await assertDerivedFields(authored, {
      lookups,
      fetch: async () => null,
      testDataPairs: [{ phase: null, key: 'Company', value: 'C-1' }],
    });
    assert.deepEqual(out.derived, []);
    assert.deepEqual(out.steps, authored);
  });
});
