/**
 * Fixture files for `upload` steps (`src/data/fixtures.ts`).
 *
 * Entirely unit-tier: a fixture is bytes from a spec, a run key and a case
 * id. The PDF is read back through `catalog/extract.ts`'s own PDF reader and
 * the workbook through its `extractWorkbookSheets` — independent readers
 * written against real files, on the rule the `.xlsx` fixture in this folder
 * established: a writer tested only against its own reader proves nothing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractDocument, extractWorkbookSheets } from '../src/catalog/extract.js';
import {
  BUILTIN_TEMPLATES,
  buildFixture,
  fixtureDir,
  headerTemplateFrom,
  isFixtureSpec,
  parseFixtureSpec,
  writeFixture,
} from '../src/data/fixtures.js';
import { runSuffix, uniquePerRun } from '../src/data/mock-data.js';

const RUN = 'be100@2026-08-31t07-20-25-957z';
const opts = { runKey: RUN, caseId: 'PL_10_05' };

const csvRows = (bytes: Buffer): string[][] =>
  bytes
    .toString('utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => l.split(','));

describe('the run suffix', () => {
  it('is the key\'s last six alphanumerics, and a value carries it once', () => {
    assert.equal(runSuffix(RUN), '25957z');
    assert.equal(uniquePerRun('PL_06_21', RUN), 'PL_06_21_25957z');
    assert.equal(uniquePerRun('PL_06_21', ''), 'PL_06_21', 'no key, no suffix');
  });
});

describe('the spec vocabulary', () => {
  it('parses kind, name, template and mutations', () => {
    assert.deepEqual(parseFixtureSpec('csv:benefit-plans@template!blank=Country!bad-enum=[OPERATOR]:Del'), {
      kind: 'csv',
      name: 'benefit-plans',
      template: 'template',
      mutations: [
        { name: 'blank', arg: 'Country' },
        { name: 'bad-enum', arg: '[OPERATOR]:Del' },
      ],
      raw: 'csv:benefit-plans@template!blank=Country!bad-enum=[OPERATOR]:Del',
    });
    assert.deepEqual(parseFixtureSpec('pdf:medical-certificate')?.mutations, []);
    assert.equal(parseFixtureSpec('csv:x!nope=1'), null, 'an unknown mutation is not a spec');
    assert.equal(parseFixtureSpec('Today'), null);
    assert.equal(isFixtureSpec('xlsx:benefit-plans!rows=3'), true);
    assert.equal(isFixtureSpec('benefit-plans (1).csv'), false, 'a file name the tester had is not a spec');
  });
});

describe('a csv from a header template', () => {
  it('uses the built-in benefit-plans header, and every row is valid by construction', () => {
    const file = buildFixture('csv:benefit-plans@template', opts);
    assert.equal(file.fileName, 'benefit-plans-25957z.csv');
    assert.equal(file.mediaType, 'text/csv');
    const rows = csvRows(file.bytes);
    assert.deepEqual(rows[0], [...BUILTIN_TEMPLATES['benefit-plans']!]);
    assert.equal(rows.length, 3, 'header + two data rows');
    const plan = rows[1]![3]!;
    assert.equal(plan, 'PL_10_05_25957z_R1', 'the id column carries case, run and row');
    assert.equal(rows[1]![0], 'Create');
    assert.equal(rows[1]![7], '9999-12-31', 'an end date is the sentinel the sheet uses');
    assert.match(file.description, /2 data row\(s\) under 16 columns/);
  });

  it('is deterministic: same spec, same run, same bytes; another run, another id', () => {
    const a = buildFixture('csv:benefit-plans@template!rows=5', opts);
    const b = buildFixture('csv:benefit-plans@template!rows=5', opts);
    assert.ok(a.bytes.equals(b.bytes));
    const c = buildFixture('csv:benefit-plans@template!rows=5', { ...opts, runKey: 'be100@2026-09-01t00-00-00-000z' });
    assert.ok(!a.bytes.equals(c.bytes));
    assert.equal(csvRows(c.bytes)[1]![3], 'PL_10_05_00000z_R1');
  });

  it('takes the header the case text lists, near the name it mentions', () => {
    const text = [
      '3. กด Download Sample CSV',
      '3.1 Download Sample file สำเร็จ แสดง Template สำหรับการ Import Benefit Plan',
      '3.2 Template แสดง Column [OPERATOR], Country, Benefit Category, Benefit Plan ID, Benefit Name, Status, Effective Start Date, Effective End Date, Company',
    ].join('\n');
    assert.deepEqual(headerTemplateFrom(text, 'benefit-plans'), [
      '[OPERATOR]', 'Country', 'Benefit Category', 'Benefit Plan ID', 'Benefit Name', 'Status', 'Effective Start Date', 'Effective End Date', 'Company',
    ]);
    // A downloaded sample's own first line.
    assert.deepEqual(headerTemplateFrom('[OPERATOR],Country,Benefit Category,Benefit Plan ID\nCreate,TH,Medical,TH_MED_001\n'), ['[OPERATOR]', 'Country', 'Benefit Category', 'Benefit Plan ID']);
    assert.equal(headerTemplateFrom('ระบบแสดงข้อความ, แล้วกด Save, และปิดหน้าต่าง'), null, 'Thai prose with commas is not a header');
    const file = buildFixture('csv:benefit-plans@template', { ...opts, templateText: text });
    assert.equal(csvRows(file.bytes)[0]!.length, 9, 'the case\'s nine columns, not the built-in sixteen');
  });

  it('carries exactly the defect named — a blank column, a bad enum, a bad date, an extra column', () => {
    const blank = csvRows(buildFixture('csv:benefit-plans@template!blank=Country', opts).bytes);
    assert.equal(blank[1]![1], '');
    assert.equal(blank[2]![1], '');
    assert.equal(blank[1]![0], 'Create', 'the other columns are untouched');

    const bad = csvRows(buildFixture('csv:benefit-plans@template!bad-enum=[OPERATOR]:Del', opts).bytes);
    assert.equal(bad[1]![0], 'Del');
    const badDefault = csvRows(buildFixture('csv:benefit-plans@template!bad-enum=Status', opts).bytes);
    assert.equal(badDefault[1]![5], 'X');

    const date = csvRows(buildFixture('csv:benefit-plans@template!bad-date=Effective Start Date', opts).bytes);
    assert.equal(date[1]![6], '31/02/2026');

    const extra = csvRows(buildFixture('csv:benefit-plans@template!extra-column=Remark', opts).bytes);
    assert.equal(extra[0]!.length, 17);
    assert.equal(extra[0]![16], 'Remark');

    const long = csvRows(buildFixture('csv:benefit-plans@template!too-long=Benefit Name', opts).bytes);
    assert.equal(long[1]![4]!.length, 256);

    const dup = csvRows(buildFixture('csv:benefit-plans@template!duplicate', opts).bytes);
    assert.equal(dup[1]![3], dup[2]![3]);

    assert.throws(() => buildFixture('csv:benefit-plans@template!blank=Nonesuch', opts), /names column "Nonesuch", which the header does not have/);
  });

  it('rows, no header, header only, empty, size', () => {
    assert.equal(csvRows(buildFixture('csv:benefit-plans@template!rows=1001', opts).bytes).length, 1002);
    const noHeader = csvRows(buildFixture('csv:benefit-plans@template!no-header', opts).bytes);
    assert.equal(noHeader[0]![0], 'Create', 'the first row is data');
    assert.equal(csvRows(buildFixture('csv:benefit-plans@template!header-only', opts).bytes).length, 1);
    assert.equal(buildFixture('csv:benefit-plans@template!empty', opts).bytes.length, 0);
    const big = buildFixture('csv:benefit-plans@template!size=1', opts);
    assert.ok(big.bytes.length > 1024 * 1024, 'past one megabyte');
    assert.equal(csvRows(big.bytes)[0]![0], '[OPERATOR]', 'still a well-formed CSV');
  });

  it('a delimiter, CRLF, and the encodings the sheet names', () => {
    const semi = buildFixture('csv:benefit-plans@template!delimiter=;', opts);
    assert.equal(semi.fileName, 'benefit-plans-25957z.delimiter-semicolon.csv');
    assert.ok(semi.bytes.toString('utf8').startsWith('[OPERATOR];Country;'));
    const tab = buildFixture('csv:benefit-plans@template!delimiter=tab', opts);
    assert.ok(tab.bytes.toString('utf8').startsWith('[OPERATOR]\tCountry\t'));
    assert.ok(buildFixture('csv:benefit-plans@template!crlf', opts).bytes.toString('utf8').includes('\r\n'));

    // TIS-620: Thai is one byte per character in 0xA1–0xFB, and there is Thai
    // to encode only when a column asks for it.
    const thai = buildFixture('csv:benefit-plans@template!value=Benefit Name:ค่ารักษาพยาบาล!encoding=tis-620', opts);
    const utf8 = buildFixture('csv:benefit-plans@template!value=Benefit Name:ค่ารักษาพยาบาล', opts);
    assert.ok(utf8.bytes.toString('utf8').includes('ค่ารักษาพยาบาล'));
    assert.ok(!thai.bytes.toString('utf8').includes('ค่ารักษาพยาบาล'), 'not UTF-8 any more');
    assert.ok(thai.bytes.length < utf8.bytes.length, 'one byte per Thai character, not three');
    assert.ok([...thai.bytes].some((b) => b >= 0xa1 && b <= 0xfb));
    assert.ok([...thai.bytes].every((b) => b < 0x80 || (b >= 0xa1 && b <= 0xfb)), 'every high byte is in the TIS-620 Thai block');

    const bom = buildFixture('csv:benefit-plans@template!encoding=utf-8-bom', opts);
    assert.deepEqual([...bom.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const utf16 = buildFixture('csv:benefit-plans@template!encoding=utf-16le', opts);
    assert.deepEqual([...utf16.bytes.subarray(0, 2)], [0xff, 0xfe]);
  });
});

describe('the other kinds', () => {
  it('a one-page PDF the independent reader can read, with the marker line', () => {
    const file = buildFixture('pdf:medical-certificate', opts);
    assert.equal(file.fileName, 'medical-certificate-25957z.pdf');
    assert.equal(file.mediaType, 'application/pdf');
    assert.ok(file.bytes.subarray(0, 5).toString('latin1') === '%PDF-');
    assert.ok(file.bytes.toString('latin1').trimEnd().endsWith('%%EOF'));
    const text = extractDocument('medical-certificate.pdf', file.bytes).text;
    assert.match(text, /Medical Certificate/);
    assert.match(text, /wowlidator fixture medical-certificate for run 25957z case PL_10_05/);
    // The xref table points at the objects it says it does.
    const body = file.bytes.toString('latin1');
    const startxref = Number(/startxref\n(\d+)/.exec(body)![1]);
    assert.equal(body.slice(startxref, startxref + 4), 'xref');
    const first = Number(/xref\n0 \d+\n0000000000 65535 f \n(\d{10})/.exec(body)![1]);
    assert.equal(body.slice(first, first + 7), '1 0 obj');
    assert.ok(buildFixture('pdf:medical-certificate', opts).bytes.equals(file.bytes), 'deterministic');
  });

  it('a small xlsx the workbook reader reads back as a grid', () => {
    const file = buildFixture('xlsx:benefit-plans!rows=3', opts);
    assert.equal(file.fileName, 'benefit-plans-25957z.rows-3.xlsx');
    const sheets = extractWorkbookSheets(file.bytes);
    assert.equal(sheets.length, 1);
    assert.equal(sheets[0]!.name, 'benefit-plans');
    assert.equal(sheets[0]!.rows.length, 4);
    assert.deepEqual(sheets[0]!.rows[0]!.slice(0, 4), ['[OPERATOR]', 'Country', 'Benefit Category', 'Benefit Plan ID']);
    assert.equal(sheets[0]!.rows[3]![3], 'PL_10_05_25957z_R3');
    // Mutations apply to the grid the same way.
    const blank = extractWorkbookSheets(buildFixture('xlsx:benefit-plans!blank=Country', opts).bytes);
    assert.equal(blank[0]!.rows[1]![1], '');
  });

  it('a text file for the "not a csv" rows', () => {
    const file = buildFixture('txt:not-a-csv', opts);
    assert.equal(file.fileName, 'not-a-csv-25957z.txt');
    assert.match(file.bytes.toString('utf8'), /wowlidator fixture not-a-csv/);
  });

  it('a spec that is not one throws, naming the shape', () => {
    assert.throws(() => buildFixture('benefit-plans (1).csv', opts), /not a fixture spec/);
  });
});

describe('writing under the run folder', () => {
  it('lands in <root>/<runKey>/, path-safe, and rewrites the same bytes in place', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wow-fixtures-'));
    const first = await writeFixture('csv:benefit-plans@template!blank=Country', { ...opts, root });
    assert.equal(first.path, join(root, 'be100@2026-08-31t07-20-25-957z', 'benefit-plans-25957z.blank-country.csv'));
    assert.ok(existsSync(first.path));
    const again = await writeFixture('csv:benefit-plans@template!blank=Country', { ...opts, root });
    assert.equal(again.path, first.path);
    assert.ok(readFileSync(first.path).equals(first.bytes));
  });

  it('a run key cannot climb out of the root', () => {
    assert.equal(fixtureDir('../../etc', '/tmp/root'), join('/tmp/root', '_._etc'));
    assert.equal(fixtureDir('', '/tmp/root'), join('/tmp/root', 'run'));
  });
});

describe('the spec an authored upload carries is minted, and a shape that will not build is caught (2026-09-07, run 15)', () => {
  // `writeFixture` had no caller anywhere in `src/`: the author emitted
  // `pdf:HIR-EC-001-attachment` and the runner handed that string to
  // `attachFiles` as a PATH, which died `fixture file not found:
  // …/e2e-01/pdf:HIR-EC-001-attachment`. It was the first errored step of run
  // 15 and the whole case's verdict — `error`, not a defect, over a file the
  // harness was supposed to write itself. `SmartRunner.upload` mints it now.
  it('mints the shapes the author writes, and leaves a real path alone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wowlidator-mint-'));
    for (const spec of ['pdf:HIR-EC-001-attachment', 'pdf:personal-information']) {
      assert.equal(isFixtureSpec(spec), true, spec);
      const written = await writeFixture(spec, { runKey: 'run-15', caseId: 'HIR-EC-001', root });
      assert.equal(existsSync(written.path), true, written.path);
      assert.equal(written.mediaType, 'application/pdf');
      assert.ok(written.bytes.length > 0);
    }
    for (const path of ['./fixtures/real.pdf', '/tmp/a.csv', 'C:\\docs\\x.pdf', '']) {
      assert.equal(isFixtureSpec(path), false, path);
    }
  });

  it('a spec whose SHAPE passes but whose parts do not build is a caught error, never a throw at the step', () => {
    // The two functions disagree on purpose — `isFixtureSpec` tests the shape
    // and `buildFixture` validates the parts — so the runner's minting is
    // wrapped: the string is kept and `attachFiles` reports the honest
    // "fixture file not found" rather than an unhandled throw that reads as a
    // browser fault.
    assert.equal(isFixtureSpec('pdf:x!nosuchmutation'), true);
    assert.throws(() => buildFixture('pdf:x!nosuchmutation', { runKey: 'r' }), /is not a fixture spec/);
  });
});
