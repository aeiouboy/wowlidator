/**
 * The sheet grammar — the readers in `src/catalog/test-case-table.ts` that
 * turn a tracking workbook's cells into what the author, the resolver, the
 * scheduler and the gates need (CG-01..04, 09..15, 17).
 *
 * Unit tier, always: every reader is a pure function over strings. The
 * lines are the real workbook's (QA_Task_Tracking_Cycle1, 2026-09-03) with
 * the case id that carried them, because a Thai regex tested against prose
 * the author of the regex wrote proves nothing about the sheet.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SHEET_SECTION,
  beyondHarnessReason,
  dbTablesNamed,
  describeCase,
  destinationOf,
  expectedLines,
  linkDependencies,
  menuPathOf,
  observeOnlyCase,
  optionSetsIn,
  parseTestCaseRows,
  qualifyDuplicateIds,
  referencedCases,
  roundsOf,
  sectionOf,
  sheetGateReason,
  sheetVerdict,
  splitPairs,
  testDataPairs,
  uniqueKeys,
  type TestCaseRow,
} from '../src/catalog/test-case-table.js';
import { exclusivityClaimIn, optionSetsIn as viaExclusivity } from '../src/generator/exclusivity.js';

const row = (over: Partial<TestCaseRow>): TestCaseRow => ({
  no: '',
  scenarioId: '',
  scenario: '',
  caseId: 'X_01',
  polarity: '',
  priority: '',
  testCase: '',
  persona: '',
  preconditions: '',
  testData: '',
  menu: '',
  steps: '',
  expected: '',
  actual: '',
  testDate: '',
  testBy: '',
  bugTicket: '',
  note: '',
  ...over,
});

describe('Test data pairs (CG-02)', () => {
  it('unpacks the EC sheet\'s packed lines, one pair each', () => {
    // HIR-EC-001, TD-01 — five pairs across three "lines" the sheet packed.
    assert.deepEqual(splitPairs('- Business Unit = CDG (10000075) Policy Profile = CDS'), [
      { key: 'Business Unit', value: 'CDG (10000075)' },
      { key: 'Policy Profile', value: 'CDS' },
    ]);
    // QA_Task_Revised (2026-09-08) packs its TD-01 block with semicolons. The
    // whitespace grammar read the line, but `C001;` kept its semicolon and a
    // `/` in the next key swallowed words into the value before it — the
    // Position came out as `40106337; Department /` and grounded against
    // nothing.
    assert.deepEqual(splitPairs('- Company = C001; Business Group = 51000000; Business Unit = 10000075'), [
      { key: 'Company', value: 'C001' },
      { key: 'Business Group', value: '51000000' },
      { key: 'Business Unit', value: '10000075' },
    ]);
    assert.deepEqual(splitPairs('- Position = 40106337; Department / Organization = 30042174; Division = 20000079'), [
      { key: 'Position', value: '40106337' },
      { key: 'Department / Organization', value: '30042174' },
      { key: 'Division', value: '20000079' },
    ]);
    // A value that merely contains semicolons is one value, not three.
    assert.deepEqual(splitPairs('- Note = a; b; c'), [{ key: 'Note', value: 'a; b; c' }]);

    assert.deepEqual(splitPairs('- Position = 40106337 Job Code = MKB12.12'), [
      { key: 'Position', value: '40106337' },
      { key: 'Job Code', value: 'MKB12.12' },
    ]);
    assert.deepEqual(splitPairs('- Department = 30042174 Branch = T153_1733 SSO Location = T153'), [
      { key: 'Department', value: '30042174' },
      { key: 'Branch', value: 'T153_1733' },
      { key: 'SSO Location', value: 'T153' },
    ]);
  });

  it('a Thai key is a key — vowels and tone marks are marks, not letters', () => {
    assert.deepEqual(splitPairs('- Personnel Grade (PG) = 10 Employee Sub Group ที่ต้องคีย์ = 10'), [
      { key: 'Personnel Grade (PG)', value: '10' },
      { key: 'Employee Sub Group ที่ต้องคีย์', value: '10' },
    ]);
    assert.deepEqual(splitPairs('- ตารางกำหนด Time Status = 01 O.T. Flag = yes สิทธิ์ลาพักผ่อนปีแรก = 6 วัน'), [
      { key: 'ตารางกำหนด Time Status', value: '01' },
      { key: 'O.T. Flag', value: 'yes' },
      { key: 'สิทธิ์ลาพักผ่อนปีแรก', value: '6 วัน' },
    ]);
  });

  it('leaves the previous pair a value, and keeps a joined value whole', () => {
    // HIR-EC-030: the second "=" has no key before it — it is the value.
    assert.deepEqual(splitPairs('- Date of Birth = Age = 60 พอดี ณ Hire Date'), [{ key: 'Date of Birth', value: 'Age = 60 พอดี ณ Hire Date' }]);
    // HIR-EC-027: "A - Permanent" is one value; the dash binds it.
    assert.deepEqual(splitPairs('Employee Group = A - Permanent Employee Sub Group = 11'), [
      { key: 'Employee Group', value: 'A - Permanent' },
      { key: 'Employee Sub Group', value: '11' },
    ]);
    assert.deepEqual(splitPairs('Company = CDS Policy Profile = CDS'), [
      { key: 'Company', value: 'CDS' },
      { key: 'Policy Profile', value: 'CDS' },
    ]);
  });

  it('reads the colon form, strips trailing commas and quotes, and ignores prose and round headers', () => {
    assert.deepEqual(splitPairs('- Entry Route : Probation Review - Supervisor View'), [{ key: 'Entry Route', value: 'Probation Review - Supervisor View' }]);
    assert.deepEqual(splitPairs('Status = Active, '), [{ key: 'Status', value: 'Active' }]);
    assert.deepEqual(splitPairs('Plan = "PL_08"'), [{ key: 'Plan', value: 'PL_08' }]);
    assert.deepEqual(splitPairs('Case 1: งวดปกติ (Normal Period)'), []);
    assert.deepEqual(splitPairs('- รายละเอียดเต็มดูชีท Hiring Test Data'), []);
    assert.deepEqual(splitPairs('- สร้างก่อนรอบส่งไฟล์ 12:00 อย่างน้อย 1 ชั่วโมง'), []);
  });

  it('carries phases: --Create-- / --Insert R1-- and a named data set', () => {
    // PL_08_08 — the bullet character opens the phase header; it must not be eaten as a bullet.
    const pairs = testDataPairs('Plan = PL_08/PL_08_08_R1\n--Create--\nStatus = Active, \nCompany = CDS\n--Insert R1--\nStatus = Inactive, \nEffective Start Date = Today');
    assert.deepEqual(pairs, [
      { phase: null, key: 'Plan', value: 'PL_08/PL_08_08_R1' },
      { phase: 'Create', key: 'Status', value: 'Active' },
      { phase: 'Create', key: 'Company', value: 'CDS' },
      { phase: 'Insert R1', key: 'Status', value: 'Inactive' },
      { phase: 'Insert R1', key: 'Effective Start Date', value: 'Today' },
    ]);
    // HIR-EC-101 — "ชุดข้อมูล TD-21" names the set; "เงื่อนไขเฉพาะของเคสนี้" ends it.
    const sets = testDataPairs('ชุดข้อมูล TD-21\n- Company = C013\nเงื่อนไขเฉพาะของเคสนี้\n- Probation Exemption = No');
    assert.deepEqual(sets, [
      { phase: 'TD-21', key: 'Company', value: 'C013' },
      { phase: null, key: 'Probation Exemption', value: 'No' },
    ]);
  });

  it('applies the sheet\'s own draft corrections, in both spellings, and never reads one as a pair', () => {
    // HIR-EC-001's หมายเหตุ, against a block that still carries the old value.
    const keyed = testDataPairs('- Department = 30001142\n- Work Schedule = D05H0800_01\nหมายเหตุ\n- ดราฟต์เดิมระบุ Department = 30001142 ใช้ 30042174 ตามชุดข้อมูลจริงในถัง SIT');
    assert.deepEqual(keyed, [
      { phase: null, key: 'Department', value: '30042174' },
      { phase: null, key: 'Work Schedule', value: 'D05H0800_01' },
    ]);
    const valueOnly = testDataPairs('- Benefit plan ID = TH_MED_001\n- Note: ดราฟต์เดิมระบุ TH_MED_001 ใช้ TH_MED_002');
    assert.deepEqual(valueOnly, [{ phase: null, key: 'Benefit plan ID', value: 'TH_MED_002' }]);
  });
});

describe('Expected lines: record-only versus asserted (CG-09)', () => {
  const HIR_EC_001 =
    'EC\n- Employee Status = Active\n- Probationary Period End Date = ? CF-HIR-08 OQ-HIR-50\n\n' +
    'จุดที่ยังไม่มีคำตอบในเคสนี้ ให้รันจริงแล้วบันทึกค่าที่ระบบแสดงลงช่อง Actual Result Image และช่อง Note เพื่อใช้เป็นคำตอบ แล้วส่งให้ BA หรือ SA ยืนยัน\n' +
    'หมายเลขคำถามที่ต้องเก็บคำตอบระหว่างรัน CF-HIR-08, OQ-HIR-50, OQ-HIR-13';

  it('marks the open-question lines and the recording instruction, not the assertion', () => {
    const lines = expectedLines(HIR_EC_001);
    assert.deepEqual(lines.map((l) => l.observeOnly), [false, true, true, true]);
    assert.equal(lines[0]!.text, 'Employee Status = Active');
    assert.ok(lines[1]!.text.startsWith('Probationary Period End Date = ? CF-HIR-08'));
    assert.ok(lines[2]!.text.startsWith('จุดที่ยังไม่มีคำตอบในเคสนี้'));
    assert.ok(lines[3]!.text.startsWith('หมายเลขคำถามที่ต้องเก็บคำตอบ'));
    assert.equal(lines[0]!.no, null, 'the EC heading is dropped; a bullet has no number');
  });

  it('keeps the numbering, drops a bare group number, and reads an email as record-only', () => {
    const lines = expectedLines('3.\n3.1 งวดปกติ (Normal Period): ตรวจสอบ ดึงข้อมูล\n4.4 ระบบส่ง sms ถึง maneger\n- HRBP ได้รับ Notification ทาง Business Email');
    assert.deepEqual(lines.map((l) => [l.no, l.observeOnly]), [
      ['3.1', false],
      ['4.4', true],
      [null, true],
    ]);
    assert.match(lines[2]!.why ?? '', /email\/SMS/);
  });

  it('a wholly-recorded case is one (HIR-EC-094); a checkable one is not', () => {
    assert.equal(
      observeOnlyCase(row({ expected: 'EC\n- ระบบต้องอนุญาตหรือปฏิเสธการสร้างพนักงานใน Department ที่ไม่มี Policy Profile = ? OQ-HIR-175\n\nจุดที่ยังไม่มีคำตอบในเคสนี้ ให้รันจริงแล้วบันทึกค่าที่ระบบแสดง' })),
      true,
    );
    assert.equal(observeOnlyCase(row({ expected: HIR_EC_001 })), false);
    assert.equal(observeOnlyCase(row({ expected: '' })), false, 'no lines is not "all recorded"');
  });

  it('describeCase prefixes exactly those lines with [RECORD ONLY]', () => {
    const described = describeCase(row({ caseId: 'HIR-EC-001', testCase: 'x', expected: HIR_EC_001 }));
    assert.match(described, /\n {2}- Employee Status = Active\n {2}\[RECORD ONLY\] - Probationary Period End Date = \? CF-HIR-08/);
    assert.equal((described.match(/\[RECORD ONLY\]/g) ?? []).length, 3);
  });
});

describe('Rounds inside one row (CG-10)', () => {
  it('reads the hiring sheet\'s รอบที่ legs with their overrides and data sets', () => {
    // HIR-EC-101, compacted: three rounds in Steps, each closing with the values that differ.
    const r = row({
      steps:
        '1. รอบที่ 1 หน่วยธุรกิจ CFR ใช้ชุดข้อมูล TD-10\n\n2. Login ด้วย <HR_ADMIN_ACCOUNT>\n- กรอก Salutation, First Name / Last Name (TH และ EN), Date of Birth และ Event Reason = H_NEWHIRE ตาม Test Data\n' +
        '7. กด Submit เพื่อสร้างพนักงานใหม่\n- ค่าที่ต่างจากรอบอื่นในรอบนี้\nBusiness Unit = CFR (10000003) Company = C004 Position = 40005896\n' +
        'รอบที่ 2 หน่วยธุรกิจ CU ใช้ชุดข้อมูล TD-21\n\n8. Login ด้วย <HR_ADMIN_ACCOUNT>\n13. กด Submit\n- ค่าที่ต่างจากรอบอื่นในรอบนี้\nBusiness Unit = CU (10000013) Company = C013 Position = 40016128\n' +
        'รอบที่ 3 หน่วยธุรกิจ CPN ใช้ชุดข้อมูล TD-36\n\n19. กด Submit\nBusiness Unit = CPN (10000009) Company = C066 Position = 40051041',
      testData: 'ชุดข้อมูล TD-21\n- Business Group = CU\n- Company = C013\nชุดข้อมูล TD-36\n- Business Group = CPN',
    });
    const rounds = roundsOf(r);
    assert.deepEqual(rounds.map((x) => [x.n, x.dataSet]), [[1, 'TD-10'], [2, 'TD-21'], [3, 'TD-36']]);
    assert.equal(rounds[0]!.label, 'รอบที่ 1 หน่วยธุรกิจ CFR ใช้ชุดข้อมูล TD-10');
    assert.equal(rounds[1]!.dataOverrides, 'Business Unit = CU (10000013); Company = C013; Position = 40016128; Business Group = CU');
    assert.doesNotMatch(rounds[0]!.dataOverrides, /Salutation/, 'a step sentence with an = inside is not this round\'s data');
  });

  it('reads a repeat-steps reference, Case N: sub-runs, Insert phases and a per-field loop', () => {
    const repeat = roundsOf(
      row({ steps: '1. รอบที่ 1 ใช้ชุดข้อมูล TD-60\n10. กด Submit\nรอบที่ 2 หน่วยธุรกิจ CHR กลุ่ม D ใช้ชุดข้อมูล TD-61\n- ทำซ้ำขั้นตอนที่ 1 ถึง 10 โดยเปลี่ยนเป็นชุดข้อมูล TD-61' }),
    );
    assert.equal(repeat[1]!.stepsRef, '1–10');
    const py = roundsOf(row({ testData: 'Case 1: งวดปกติ (Normal Period)\nCase 2: งวดพิเศษ (Off-Cycle)\nCase 3: งวดสวัสดิการ (Benefit Period)' }));
    assert.deepEqual(py.map((x) => x.label), ['Case 1: งวดปกติ (Normal Period)', 'Case 2: งวดพิเศษ (Off-Cycle)', 'Case 3: งวดสวัสดิการ (Benefit Period)']);
    const insert = roundsOf(row({ testData: '--Create--\nStatus = Active\n--Insert R1--\nStatus = Inactive\n--Insert R2--\nStatus = Active' }));
    assert.deepEqual(insert.map((x) => [x.label, x.dataOverrides]), [['Insert R1', 'Status = Inactive'], ['Insert R2', 'Status = Active']]);
    // TC_SSO_009_001
    const loop = roundsOf(row({ steps: '3. Required field validation — Country/Min/Max/Effective start/end ว่างทีละช่อง แล้วกด "Save"' }));
    assert.deepEqual(loop.map((x) => x.label), ['ว่างช่อง Country', 'ว่างช่อง Min', 'ว่างช่อง Max', 'ว่างช่อง Effective start', 'ว่างช่อง end']);
    assert.deepEqual(roundsOf(row({ steps: '1. รอบที่ 1 เท่านั้น\n2. กด Submit' })), [], 'one round is no rounds');
  });
});

describe('Menu path and destination (CG-11)', () => {
  it('normalises the four spellings the workbook uses', () => {
    assert.deepEqual(menuPathOf(row({ menu: '1. HR\n2. Benefits Admin\n3. Benefit Plans' })), ['HR', 'Benefits Admin', 'Benefit Plans']);
    assert.deepEqual(menuPathOf(row({ menu: 'EC > Hire & Onboard (New Hire)' })), ['EC', 'Hire & Onboard (New Hire)']);
    assert.deepEqual(menuPathOf(row({ menu: 'SPD Admin > Payroll > Run Payroll' })), ['SPD Admin', 'Payroll', 'Run Payroll']);
    assert.deepEqual(menuPathOf(row({ menu: 'SSO Base Amount (https://payroll-cnext-dev.central.co.th/admin/config/sso)' })), ['SSO Base Amount']);
    assert.deepEqual(menuPathOf(row({ menu: 'N/A' })), []);
    assert.deepEqual(menuPathOf(row({ menu: '4854' })), [], 'a stray Excel serial is not a crumb');
  });

  it('reads the PY sheet\'s Navigate ไปที่ … → เลือกแท็บ "…" and the Menu cell\'s URL', () => {
    const py = destinationOf(
      row({
        menu: 'SSO Base Amount (https://payroll-cnext-dev.central.co.th/admin/config/sso)',
        steps: '1. Login เข้าระบบด้วย SPD Admin -> Navigate ไปที่ https://payroll-cnext-dev.central.co.th/admin/config/sso -> เลือกแท็บ "SSO Base Amount"\n2. กดปุ่ม "Add" / "+"',
      }),
    );
    assert.deepEqual(py, { url: 'https://payroll-cnext-dev.central.co.th/admin/config/sso', tab: 'SSO Base Amount', path: ['SSO Base Amount'] });
    assert.equal(destinationOf(row({ menu: 'N/A', steps: '1. เข้า DB' })), null);
    const described = describeCase(row({ caseId: 'TC_SSO_009_001', testCase: 'x', menu: 'SSO Base Amount (https://h/x)', steps: '1. Navigate ไปที่ https://h/x -> เลือกแท็บ "SSO Base Amount"' }));
    assert.match(described, /\nMenu path: SSO Base Amount\nDestination: https:\/\/h\/x \(tab "SSO Base Amount"\)\n/);
  });

  it('a blank Menu cell inherits the row above within its scenario', () => {
    const rows = parseTestCaseRows([
      ['Scenario ID', 'Test Case ID', 'Menu', 'Test Script / Steps', 'Expected Output'],
      ['RU_05', 'RU_05_31', '1. HR\n2. Benefits Admin\n3. Eligibility rules', '1. x', 'y'],
      ['', 'RU_05_32', '', '1. เข้าสู่เมนูที่กำหนด', 'y'],
      ['RU_06', 'RU_06_01', '', '1. x', 'y'],
    ])!;
    assert.equal(rows[1]!.menu, '1. HR\n2. Benefits Admin\n3. Eligibility rules');
    assert.equal(rows[2]!.menu, '', 'a new scenario inherits nothing');
  });
});

describe('Cross-case references (CG-12)', () => {
  it('classifies the sheet\'s phrasings, and "ตัดจากเคส" is provenance, not a dependency', () => {
    const refs = referencedCases(
      row({
        testData: 'ต่อจากเคส E2E-01 ชุดข้อมูล TD-01 ใช้พนักงานคนเดิม\n- Employee ID = EMXXXX (จาก E2E-118)\n- Benefit Plan ID = PL_03_07',
        steps: '- ตามขั้นตอนของ E2E-128\n- รันคู่กับ E2E-34',
        note: 'ตัดจากเคส E2E-99 ไฟล์ HR_SIT_E2E_V.0.1 (28).xlsx\nข้อมูลทดสอบเดียวกับ PL_07_01 ทุกค่า',
      }),
    );
    assert.deepEqual(refs, [
      { id: 'E2E-01', kind: 'follows' },
      { id: 'E2E-118', kind: 'follows' },
      { id: 'E2E-128', kind: 'steps' },
      { id: 'E2E-34', kind: 'beside' },
      { id: 'PL_07_01', kind: 'data' },
      { id: 'PL_03_07', kind: 'data' },
    ]);
  });

  it('links what the table has, records what it lacks only where the row needs it, and inherits data and steps', () => {
    const rows: TestCaseRow[] = [
      row({ caseId: 'PL_03_07', sheet: 'BE', testData: 'Benefit Plan ID = PL_03_07\nStatus = Active', steps: '1. create' }),
      row({ caseId: 'PL_03_08', sheet: 'BE', testData: 'Benefit Plan ID = PL_03_07', steps: '1. correct' }),
      row({ caseId: 'PL_07_02', sheet: 'BE', testData: '', note: 'same Test Data as PL_03_07', steps: '' }),
      row({ caseId: 'PL_07_03', sheet: 'BE', testData: '-', steps: '', note: 'ตามขั้นตอนของ PL_03_07' }),
      // HIR-EC-029: cites E2E-01's data but carries its own — no dependency.
      row({ caseId: 'HIR-EC-029', sheet: 'EC', testData: 'ข้อมูลทดสอบเดียวกับ E2E-01 ทุกค่า\n- Event Reason = New Hire', steps: '1. x' }),
      // PRB-EC-001: needs the employee E2E-01 hired, and E2E-01 is not here.
      row({ caseId: 'PRB-EC-001', sheet: 'EC', testData: 'ต่อจากเคส E2E-01 ชุดข้อมูล TD-01', steps: '1. x' }),
      row({ caseId: 'HIR-EC-044', sheet: 'EC', testData: 'รันคู่กับ E2E-01', steps: '1. x' }),
    ];
    linkDependencies(rows);
    assert.equal(rows[0]!.dependsOn, undefined, 'a row never depends on itself');
    assert.deepEqual(rows[1]!.dependsOn, ['PL_03_07']);
    assert.deepEqual(rows[2]!.dependsOn, ['PL_03_07']);
    assert.equal(rows[2]!.testData, 'Benefit Plan ID = PL_03_07\nStatus = Active');
    assert.equal(rows[2]!.testDataFrom, 'PL_03_07');
    assert.equal(rows[3]!.steps, '1. create');
    assert.equal(rows[3]!.stepsFrom, 'PL_03_07');
    assert.equal(rows[3]!.testDataFrom, 'PL_03_07', 'a dash is a blank Test Data cell');
    assert.equal(rows[4]!.externalRefs, undefined);
    assert.deepEqual(rows[5]!.externalRefs, ['E2E-01']);
    assert.equal(rows[6]!.externalRefs, undefined, '"run beside" needs nothing');
    const described = describeCase(rows[2]!);
    assert.match(described, /\nTest data \(inherited from PL_03_07\):\n {2}Benefit Plan ID = PL_03_07\n/);
    assert.match(sectionOf(described, 'test data') ?? '', /Status = Active/);
  });

  it('resolves a reference against the Scenario ID column: the row\'s own scenario is itself, another scenario in the table is its first row (multirole PRB-EC-001, 2026-09-04)', () => {
    // multirole.csv: PRB-EC-001 "ต่อจากเคส E2E-01" was refused as "depends on
    // E2E-01, which is not in this catalog" while HIR-EC-001 — the row whose
    // Scenario ID IS E2E-01 — sat two rows above it.
    const rows: TestCaseRow[] = [
      row({ caseId: 'HIR-EC-001', scenarioId: 'E2E-01', sheet: 'EC', testData: 'Province = กรุงเทพมหานคร', steps: '1. hire' }),
      row({ caseId: 'HIR-EC-002', scenarioId: 'E2E-01', sheet: 'EC', testData: 'ต่อจากเคส E2E-01 ใช้พนักงานคนเดิม', steps: '1. x' }),
      row({ caseId: 'PRB-EC-001', scenarioId: 'E2E-152', sheet: 'EC', testData: 'ต่อจากเคส E2E-01 ชุดข้อมูล TD-01', steps: '1. x' }),
      row({ caseId: 'PRB-EC-002', scenarioId: 'E2E-153', sheet: 'EC', testData: 'ต่อจากเคส E2E-99', steps: '1. x' }),
    ];
    linkDependencies(rows);
    assert.equal(rows[1]!.dependsOn, undefined, 'a row never depends on its own scenario');
    assert.equal(rows[1]!.externalRefs, undefined);
    assert.deepEqual(rows[2]!.dependsOn, ['HIR-EC-001'], 'the scenario resolves to the row that creates what it uses');
    assert.equal(rows[2]!.externalRefs, undefined);
    assert.deepEqual(rows[3]!.externalRefs, ['E2E-99'], 'a scenario the table does not hold is still external');
  });
});

describe('Duplicate ids (CG-04)', () => {
  it('qualifies by sheet across sheets and by #n within one, keeping the sheet\'s spelling', () => {
    const rows: TestCaseRow[] = [
      row({ caseId: 'PL_10_02', sheet: 'BE' }),
      row({ caseId: 'PL_10_02', sheet: 'TM' }),
      row({ caseId: 'PL_10_02', sheet: 'TM' }),
      row({ caseId: 'PL_10_02', sheet: 'TM' }),
      row({ caseId: 'TSH_01_01', sheet: 'TM' }),
      row({ caseId: 'TSH_01_01', sheet: 'TM' }),
      row({ caseId: 'HIR-EC-001', sheet: 'EC' }),
    ];
    qualifyDuplicateIds(rows);
    assert.deepEqual(
      rows.map((r) => r.caseId),
      ['BE:PL_10_02', 'TM:PL_10_02', 'TM:PL_10_02#2', 'TM:PL_10_02#3', 'TSH_01_01', 'TSH_01_01#2', 'HIR-EC-001'],
    );
    assert.equal(rows[2]!.sheetCaseId, 'PL_10_02');
    assert.equal(rows[6]!.sheetCaseId, undefined, 'a unique id is untouched');
    assert.match(describeCase(rows[2]!), /^PL_10_02: /, 'the prompt opens with the sheet\'s own id');
  });

  it('a single-sheet CSV still gets #n', () => {
    const rows = [row({ caseId: 'A_01' }), row({ caseId: 'A_01' })];
    qualifyDuplicateIds(rows);
    assert.deepEqual(rows.map((r) => r.caseId), ['A_01', 'A_01#2']);
  });
});

describe('Unique keys (CG-13)', () => {
  it('finds the case id in any spelling, the tester\'s _R3, and QA-/SIT_ names — on key fields only', () => {
    const r = row({ caseId: 'PL_06_21', sheet: 'BE', testData: '--Create--\nBenefit Plan ID = PL_06_21_R3\nBenefit name = QA-Create Plan Success/History\nCountry = TH\nCompany = PL_06_21' });
    assert.deepEqual(uniqueKeys(r), [
      { key: 'Benefit Plan ID', value: 'PL_06_21_R3', phase: 'Create' },
      { key: 'Benefit name', value: 'QA-Create Plan Success/History', phase: 'Create' },
    ]);
    assert.deepEqual(uniqueKeys(row({ caseId: 'BE:PL_06_22', sheetCaseId: 'PL_06_22', testData: 'Benefit Plan ID = pl-06-22' })).map((k) => k.value), ['pl-06-22']);
    assert.deepEqual(uniqueKeys(row({ caseId: 'CNS-EC-003', testData: 'Document code = SIT_CNS_03' })).map((k) => k.value), ['SIT_CNS_03']);
  });

  it('another case\'s id is a reference, and a value the row says already exists stays', () => {
    assert.deepEqual(uniqueKeys(row({ caseId: 'PL_03_08', testData: 'Benefit Plan ID = PL_03_07' })), []);
    assert.deepEqual(uniqueKeys(row({ caseId: 'PL_03_23', testCase: 'สร้าง Plan ด้วย ID ที่มีอยู่แล้วในระบบ', testData: 'Benefit Plan ID = PL_03_23' })), []);
  });
});

describe('Option sets (CG-14)', () => {
  it('reads the three sheet shapes and the forbidden form', () => {
    // HIR-EC-029 (a benchmark case)
    const [ec] = optionSetsIn('- dropdown แสดง 3 ค่า : Event Reason บนหน้า Key-in แสดงเฉพาะ New Hire / Replacement / Migration\n- ไม่แสดง Event Reason : H_CORENTRY');
    assert.deepEqual(ec, {
      field: 'Event Reason',
      exact: true,
      count: 3,
      members: ['New Hire', 'Replacement', 'Migration'],
      forbidden: [],
      line: 'dropdown แสดง 3 ค่า : Event Reason บนหน้า Key-in แสดงเฉพาะ New Hire / Replacement / Migration',
    });
    // PL_04_04 — members one per line under the header, until the next numbered line.
    const [be] = optionSetsIn('3.1 สามารถกดเลือก Filter ได้\n3.2 แสดงตัวเลือก Benefit Category ครบถ้วน ดังนี้\nMedical\nPhysical check\nGasoline\n3.3 เมื่อเลือก Filter แล้ว');
    assert.equal(be?.field, 'Benefit Category');
    assert.deepEqual(be?.members, ['Medical', 'Physical check', 'Gasoline']);
    assert.equal(be?.exact, true);
    assert.equal(be?.count, null);
    // TC_TAX_044_001
    const [py] = optionSetsIn('3. ตรวจสอบ Limit Method dropdown มีแค่ 3 ค่า: F=Fixed Amount, A=Actual Amount, P=Percentage Limit');
    assert.equal(py?.field, 'Limit Method');
    assert.equal(py?.count, 3);
    assert.deepEqual(py?.members, ['F=Fixed Amount', 'A=Actual Amount', 'P=Percentage Limit']);
    // HIR-EC-027
    const [forbidden] = optionSetsIn('- dropdown Event Reason ไม่มี RE_REHIRE_GE1 และไม่มี RE_REHIRE_LT1');
    assert.equal(forbidden?.field, 'Event Reason');
    assert.deepEqual(forbidden?.forbidden, ['RE_REHIRE_GE1', 'RE_REHIRE_LT1']);
    assert.deepEqual(forbidden?.members, []);
  });

  it('a filter is not a set, and examples are not exact', () => {
    assert.deepEqual(optionSetsIn('3.1 ขั้นตอนที่ 3 รายการแสดงเฉพาะเอกสารที่เปิดใช้งาน'), []);
    // RU_03_19
    const [examples] = optionSetsIn('3.1 ตารางแสดงเฉพาะ Rule ที่มีค่า PG From เท่ากับ 1 (หรือ PG Range ที่ครอบคลุมค่า 1) เท่านั้น เช่น rule-med-001, rule-med-002, rule-med-003');
    assert.equal(examples?.exact, false);
    assert.deepEqual(examples?.members, ['rule-med-001', 'rule-med-002', 'rule-med-003']);
  });

  it('is one function: exclusivity.ts re-exports it, and a ครบถ้วน ดังนี้ set is an exclusivity claim sized by its members', () => {
    assert.equal(viaExclusivity, optionSetsIn);
    const described = describeCase(row({ caseId: 'PL_04_04', testCase: 'ตรวจสอบ Filter Benefit Category', expected: '3.2 แสดงตัวเลือก Benefit Category ครบถ้วน ดังนี้\nMedical\nGasoline\nToll\n3.3 เมื่อเลือก Filter' }));
    assert.match(described, /\nOption set for Benefit Category \(exact, 3\): Medical \| Gasoline \| Toll\n/);
    const claim = exclusivityClaimIn(described);
    assert.equal(claim?.count, 3);
    assert.equal(claim?.marker, 'ครบถ้วน ดังนี้');
    const forbiddenOnly = describeCase(row({ caseId: 'HIR-EC-027', testCase: 'x', expected: '- dropdown Event Reason ไม่มี RE_REHIRE_GE1 และไม่มี RE_REHIRE_LT1' }));
    assert.match(forbiddenOnly, /\nOption set for Event Reason: forbidden: RE_REHIRE_GE1, RE_REHIRE_LT1\n/);
  });
});

describe('The shared section grammar (CG-15)', () => {
  const described = describeCase(
    row({
      caseId: 'PL_03_07',
      testCase: 'สร้าง Plan',
      menu: '1. HR\n2. Benefits Admin',
      testData: 'Benefit Plan ID = PL_03_07',
      steps: '1. เข้าสู่เมนูที่กำหนด\n2. กด Create',
      expected: '2.1 จำนวนใน Total Plans +1\nType: Reimbursement\n2.2 แสดง Filter Type: Dropdown',
      note: 'KNOWN FAIL: 6.2 counts 119',
    }),
  );

  it('sectionOf cuts each block on the one heading list, and stops at "Note (from the sheet)"', () => {
    assert.equal(sectionOf(described, 'expected'), '  2.1 จำนวนใน Total Plans +1\n  Type: Reimbursement\n  2.2 แสดง Filter Type: Dropdown\n');
    assert.equal(sectionOf(described, 'steps'), '  1. เข้าสู่เมนูที่กำหนด\n  2. กด Create\n');
    assert.equal(sectionOf(described, 'note'), '  KNOWN FAIL: 6.2 counts 119');
    assert.equal(sectionOf(described, 'menu path'), ' HR > Benefits Admin\n');
    assert.equal(sectionOf(described, 'rounds'), null);
  });

  it('reads the claims file\'s inline form and Flow.caseContext\'s "Expected:"', () => {
    assert.equal(sectionOf('PL_03_07 สร้าง — expected: 6.1 +1 in Total Plans; - 6.2 x — note: KNOWN', 'expected'), ' 6.1 +1 in Total Plans; - 6.2 x — note: KNOWN');
    assert.equal(sectionOf('Case: x\nExpected: the tile matches\nTest data: a = 1', 'expected'), ' the tile matches\n');
  });

  it('SHEET_SECTION knows every heading describeCase writes, and only at a line start', () => {
    for (const heading of ['Note (from the sheet):', 'Test data (inherited from X):', 'Expected output:', 'Menu path:', 'Destination:', 'Rounds (3):', 'Option set for Event Reason (exact, 3):', 'Database tables named:', 'Login / persona:', 'Preconditions:', 'Steps:']) {
      assert.match(`  ${heading} x`, SHEET_SECTION, heading);
    }
    assert.doesNotMatch('2.2 แสดง Filter Type: Dropdown', SHEET_SECTION, 'a Type: inside an Expected line is not a section');
    assert.doesNotMatch('  - Note: ดราฟต์เดิมระบุ', SHEET_SECTION, 'a "Note:" bullet is the sheet\'s text, not the section');
  });
});

describe('Database tables named in Expected (CG-17)', () => {
  it('reads the four sheet shapes, telling table.column from schema.table', () => {
    assert.deepEqual(dbTablesNamed(row({ expected: '- DB : time_management.leave_requests , time_management.leave_request_decisions , time_management.leave_request_attachments' })), [
      { table: 'time_management.leave_requests', columns: [] },
      { table: 'time_management.leave_request_decisions', columns: [] },
      { table: 'time_management.leave_request_attachments', columns: [] },
    ]);
    // PRB-EC-036
    assert.deepEqual(dbTablesNamed(row({ expected: '4.1 table employment_jobs column probation_result ถูกเขียนค่าผ่าน และ employment_information.pass_probation_date_confirm_date = วันที่บรรจุ' })), [
      { table: 'employment_jobs', columns: ['probation_result'] },
      { table: 'employment_information', columns: ['pass_probation_date_confirm_date'] },
    ]);
    // PRB-EC-054, PRB-EC-061
    assert.deepEqual(dbTablesNamed(row({ expected: '3.1 ไม่มี record ใน employee_center.probation_transactions หลัง daily batch run ครบรอบ\n2.1 employment_jobs.contract_end_date = 31/12/9999' })), [
      { table: 'employee_center.probation_transactions', columns: [] },
      { table: 'employment_jobs', columns: ['contract_end_date'] },
    ]);
    assert.deepEqual(dbTablesNamed(row({ expected: '4.1 ระบบบันทึกเวลาตามที่กด ลง data base ถูกต้อง' })), []);
    const described = describeCase(row({ caseId: 'ML_01_01', testCase: 'x', expected: '- DB : time_management.leave_requests' }));
    assert.match(described, /\nDatabase tables named: time_management\.leave_requests\n/);
  });
});

describe('Beyond the browser (CG-03)', () => {
  const HUMI = 'http://localhost:3005/humi/en/login';
  const PY_STEPS = '1. Login เข้าระบบด้วย SPD Admin -> Navigate ไปที่ https://payroll-cnext-dev.central.co.th/admin/config/sso -> เลือกแท็บ "SSO Base Amount"';

  it('another host is refused only against a start URL, and only when it differs', () => {
    assert.match(beyondHarnessReason(row({ steps: PY_STEPS, expected: 'x' }), HUMI) ?? '', /navigates to payroll-cnext-dev\.central\.co\.th — a different origin from the run's start URL \(localhost:3005\)/);
    assert.equal(beyondHarnessReason(row({ steps: PY_STEPS, expected: 'x' }), 'https://payroll-cnext-dev.central.co.th/admin'), null);
    assert.equal(beyondHarnessReason(row({ steps: PY_STEPS, expected: 'x' })), null, 'no start URL, no judgement');
  });

  it('names each rule with the sheet line that trips it', () => {
    assert.match(beyondHarnessReason(row({ menu: 'Payment Setup [TBD - ยังไม่มี UI จริง, NO-SPEC]', steps: '1. x', expected: 'y' })) ?? '', /no UI or spec yet/);
    assert.match(beyondHarnessReason(row({ steps: '5. กด Save\n6. รอวัน Effective Start Date\n7. ตรวจสอบ', expected: 'y' })) ?? '', /waits for a calendar day \("6\. รอวัน Effective Start Date"\)/);
    assert.equal(beyondHarnessReason(row({ steps: '2. เทียบว่าระบบเขียนวันที่กด Approve หรือรอถึงวันครบกำหนดเวลา 00.00', expected: 'y' })), null, 'a mention of waiting inside a comparison is not a wait step');
    assert.match(beyondHarnessReason(row({ steps: '3. รอถึงวันที่ 119 แล้วให้ทีมพัฒนา run daily batch', expected: 'y' })) ?? '', /calendar day/);
    assert.match(beyondHarnessReason(row({ steps: '2. ส่งรายการตำแหน่งทั้งห้าชุดให้ทีมเตรียมข้อมูล และขอให้เปิดตำแหน่งให้ว่าง', expected: 'y' })) ?? '', /carried out by another team/);
    assert.equal(
      beyondHarnessReason(row({ steps: '7. กด Submit\nขั้นตอนคืนค่าเดิม\n- แจ้งผู้ดูแลระบบให้ยกเลิกพนักงานที่สร้างในเคสนี้ทุกราย', expected: 'y' })),
      null,
      'cleanup after the case is not a step of it',
    );
    assert.match(beyondHarnessReason(row({ testCase: 'กรณี Network หลุดระหว่าง Submit', steps: '1. x', expected: 'y' })) ?? '', /dropped connection/);
  });

  it('refuses a row with no oracle: blank, a status word, a number, or every line deferring to a spec', () => {
    assert.match(beyondHarnessReason(row({ steps: '1. x', expected: '' })) ?? '', /blank/);
    assert.match(beyondHarnessReason(row({ steps: '1. x', expected: '4356' })) ?? '', /no oracle \("4356"\)/);
    assert.match(beyondHarnessReason(row({ steps: '1. x', expected: 'Not Start' })) ?? '', /no oracle/);
    assert.match(beyondHarnessReason(row({ steps: '1. x', expected: '1.1 ข้อความสะกดถูกต้องตรงตาม Spec' })) ?? '', /defers to a spec/);
    assert.equal(beyondHarnessReason(row({ steps: '1. x', expected: '1.1 ข้อความสะกดถูกต้องตรงตาม Spec\n1.2 คำแสดงตรงกันทุกหน้า' })), null);
    // A wholly-recorded case is CG-09's (review with captures), not a refusal.
    assert.equal(beyondHarnessReason(row({ steps: '1. x', expected: '- ระยะ Probation ของ Employee Group = G = ? OQ-HIR-50' })), null);
  });
});

describe('The sheet\'s status as a gate and as ground truth (CG-01)', () => {
  it('sheetVerdict widens recordedResult with blocked, and nothing else', () => {
    assert.equal(sheetVerdict('Blocked'), 'blocked');
    assert.equal(sheetVerdict('Pending deploy'), 'blocked');
    assert.equal(sheetVerdict('Re-Test Passed'), 'passed');
    assert.equal(sheetVerdict('Failed'), 'failed');
    assert.equal(sheetVerdict('Pending confirm'), undefined);
    assert.equal(sheetVerdict('Not Start'), undefined);
    assert.equal(sheetVerdict('Ready to test'), undefined);
  });

  it('sheetGateReason refuses Blocked and Pending rows with their ticket, unless asked to include them', () => {
    const blocked = row({ actual: 'Blocked', bugTicket: '#71906' });
    assert.equal(sheetGateReason(blocked), 'the sheet records this case as Blocked — bug ticket #71906');
    assert.equal(sheetGateReason(row({ actual: 'Pending deploy' })), 'the sheet records this case as Pending deploy');
    assert.match(sheetGateReason(row({ actual: 'Pending confirm', bugTicket: '#1\n#2' })) ?? '', /Pending confirm — bug ticket #1; #2/);
    assert.equal(sheetGateReason(blocked, { includeBlocked: true }), null);
    assert.match(sheetGateReason(row({ actual: 'Cancelled' })) ?? '', /Cancelled/);
    assert.match(sheetGateReason(row({ note: 'Blocker group: Data\nBlocker detail: ยังรันไม่ได้ รอ seed' })) ?? '', /cannot be run yet: "Blocker detail: ยังรันไม่ได้ รอ seed"/);
    assert.equal(sheetGateReason(row({ actual: 'Not Start' })), null);
    assert.equal(sheetGateReason(row({ actual: 'Ready to test' })), null);
  });

  it('the TM sheet\'s Blocker group / Blocker detail columns land in note, labelled', () => {
    const rows = parseTestCaseRows([
      ['Test Case ID', 'Test Script / Steps', 'Expected Output', 'Test Status', 'Bug ticket', 'Blocker group', 'Blocker detail'],
      ['MC_05_01', '1. x', 'y', 'Blocked', '71906', 'Environment', 'GPS mock ยังไม่พร้อม'],
      ['MC_05_02', '1. x', 'y', 'Passed', '', '', ''],
    ])!;
    assert.equal(rows[0]!.note, 'Blocker group: Environment\nBlocker detail: GPS mock ยังไม่พร้อม');
    assert.equal(rows[1]!.note, '');
    assert.match(describeCase(rows[0]!), /Note \(from the sheet\):\n {2}Blocker group: Environment\n {2}Blocker detail: GPS mock ยังไม่พร้อม$/);
  });
});
