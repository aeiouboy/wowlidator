/**
 * The test-case table: this project's catalog format, read and written.
 *
 * A QA team's catalog is not prose and it is not a list of sentences — it is a
 * spreadsheet with a fixed set of columns, one row per test case, scenario IDs
 * grouping the rows. `src/catalog/catalog.ts` can read *any* document by asking
 * a model what it asserts; this module is the other thing, for the one shape we
 * actually own:
 *
 *   read   a table in this format → claims, with no model call at all
 *   write  cases from a description or a page → a table in this format
 *
 * **Reading it structurally rather than asking a model is the whole point.** The
 * columns already say what the general extractor has to infer: which rows are
 * cases, what each one is called, how important it is, whether it is a negative
 * test, what the steps are and what the expected output is. Handing that to a
 * model to re-derive costs a call, loses the Test Case ID, and can hallucinate a
 * claim the sheet never made. A column read is exact and free.
 *
 * The format is fixed by the file, not by us — column names, their order and
 * their spelling (` Test Data` really does carry a leading space) are matched
 * leniently on read and reproduced exactly on write, so a sheet can go out of
 * here and back into whatever the team already uses.
 *
 * **The sheet grammar lives here too** (2026-09-03). A tracking workbook of
 * 1,286 Thai/English cases showed that the cells have a grammar of their own —
 * packed `Field = value` pairs, `--Insert R1--` phase headers, `รอบที่ 2`
 * rounds, `= ? OQ-HIR-50` open questions, `ต่อจากเคส E2E-01` dependencies,
 * `DB : schema.table` oracles — and that every consumer (the author's prompt,
 * the lints, the value resolver, the scheduler) was re-deriving a piece of it
 * with its own regex. The readers below are the single source: pure, $0,
 * deterministic, and pinned against the real sheet's own lines in
 * `tests/sheet-grammar.test.ts`. Thai has no ASCII word boundaries, so every
 * Thai pattern is a substring or a `\p{Script=Thai}` class under the `u` flag —
 * never `\b`.
 */

import { parseDelimited, sniffDelimiter } from './extract.js';
import type { CatalogClaim } from './catalog.js';
// The words the gates read a Note with are data — a leaf module that imports
// nothing of the parser, so the dependency still runs one way (2026-09-04).
import { AUTHORING } from '../generator/value-rules.js';

/**
 * The header, exactly as the format has it — including the leading space in
 * ` Test Data` and the trailing empty column, both of which are what a
 * spreadsheet exporter produced and both of which round-trip.
 */
export const TEST_CATALOG_HEADER = [
  'No.',
  'Scenario ID',
  'Test Scenario',
  'Test Case ID',
  'Positive/Negative',
  'Priority',
  'Test Case',
  ' Test Data',
  'Menu',
  'Test Script / Steps',
  'Expected Output',
  'Actual Result',
  'Test Date',
  'Test by',
  'Bug ticket',
  'Note',
  '',
] as const;

/** One row. Every field is a string, because every cell is. */
export interface TestCaseRow {
  /** Row number in the sheet. Written as 1..n; ignored on read. */
  no: string;
  /** e.g. `HP_01`. Blank on a continuation row — see `carryForward`. */
  scenarioId: string;
  /** Title of the scenario the case belongs to. Blank on a continuation row. */
  scenario: string;
  /**
   * e.g. `HP_01_02`. This is the case's identity — the ledger key, the claims
   * source, the flow's name, the `--rerun-case` handle. Qualified when the
   * sheet's own id is not unique (`TM:PL_03_01`, `TSH_01_01#2`); the sheet's
   * spelling is then kept in `sheetCaseId`.
   */
  caseId: string;
  /** `Positive` or `Negative`. */
  polarity: string;
  /** `High` / `Medium` / `Low`. */
  priority: string;
  /** One line: what this case checks. */
  testCase: string;
  /**
   * Who signs in and how — a column real sheets carry ("Login / Persona")
   * and this parser used to drop, which cost the author exactly the
   * credentials, selector advice and sign-out choreography the sheet's
   * writer took the trouble to spell out.
   */
  persona: string;
  /** Environment the case assumes — dev server, seeds, viewport ("Preconditions"). */
  preconditions: string;
  /** Inputs, personas, boundary values. */
  testData: string;
  /**
   * Where in the application, as numbered menu levels. A blank cell inherits
   * the previous row's menu within the same scenario — RU_05_32..37 leave it
   * blank under RU_05_31's `HR > Benefits Admin > Eligibility rules`, the same
   * "blank means same as above" the Scenario ID column uses.
   */
  menu: string;
  /** Numbered steps, one per line. */
  steps: string;
  /** Numbered expectations, keyed to the step that produces them (`3.2`). */
  expected: string;
  /**
   * `Pass` / `Fail` / blank. A record of the last manual run, never an input.
   * Read from an "Actual Result" column or, the spelling a tracking workbook
   * uses, a "Test Status" column — both are the sheet's own verdict.
   */
  actual: string;
  testDate: string;
  testBy: string;
  bugTicket: string;
  /**
   * The Note column, plus any blocker columns the sheet has instead of one
   * (the TM sheet's `Blocker group` / `Blocker detail`), each labelled.
   */
  note: string;
  /**
   * The worksheet the row came from (`EC`, `BE`, `TM`, `PY`) when the
   * catalog was a workbook — the module, in a QA tracker's terms. Empty for
   * a single-sheet CSV. Optional so hand-built rows keep their shape.
   */
  sheet?: string | undefined;
  /** The sheet's own grouping under the scenario (`Hiring`, `Benefit Plan`). */
  category?: string | undefined;
  /**
   * The Test Case ID as the sheet spells it, when `caseId` had to be
   * qualified to stay unique (CG-04). Absent when they are the same.
   */
  sheetCaseId?: string | undefined;
  /**
   * Cases this row continues from, takes its data from or runs beside
   * (`ต่อจากเคส E2E-01`, `same Test Data as PL_07_01`, `Plan = PL_03_07`),
   * as their (qualified) ids — only those present in the parsed table.
   */
  dependsOn?: string[] | undefined;
  /** The same references naming a case that is NOT in the table (`E2E-118`). */
  externalRefs?: string[] | undefined;
  /** Set when `testData` was copied from the referenced case (its id). */
  testDataFrom?: string | undefined;
  /** Set when `steps` were copied from the referenced case (its id). */
  stepsFrom?: string | undefined;
}

const EMPTY_ROW: TestCaseRow = {
  no: '',
  scenarioId: '',
  scenario: '',
  caseId: '',
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
};

/** The fields a header cell can feed — every cell is text; the derived list fields are never read from a column. */
type TextField = Exclude<keyof TestCaseRow, 'dependsOn' | 'externalRefs'>;

/** Header cell → field, matched on a squashed form so spacing cannot break it. */
const FIELD_BY_HEADER = new Map<string, TextField>([
  ['no.', 'no'],
  ['no', 'no'],
  ['scenarioid', 'scenarioId'],
  ['testscenario', 'scenario'],
  ['testcaseid', 'caseId'],
  ['positive/negative', 'polarity'],
  ['priority', 'priority'],
  ['testcase', 'testCase'],
  ['login/persona', 'persona'],
  ['loginpersona', 'persona'],
  ['login', 'persona'],
  ['persona', 'persona'],
  ['preconditions', 'preconditions'],
  ['precondition', 'preconditions'],
  ['testdata', 'testData'],
  ['menu', 'menu'],
  ['testscript/steps', 'steps'],
  ['teststeps', 'steps'],
  ['expectedoutput', 'expected'],
  ['expectedresult', 'expected'],
  ['actualresult', 'actual'],
  // A tracking workbook records its verdict as a status, not a result — the
  // same fact under a different heading, and `recordedResult` reads both.
  ['teststatus', 'actual'],
  ['status', 'actual'],
  ['category', 'category'],
  ['module', 'category'],
  ['testdate', 'testDate'],
  ['testby', 'testBy'],
  ['bugticket', 'bugTicket'],
  ['note', 'note'],
  ['notes', 'note'],
  // The TM sheet has no Note column: its caveats sit in `Blocker group` /
  // `Blocker detail` (CG-01). Both land in `note`, labelled, so the gate and
  // the prompt read them where the other sheets' Note is read.
  ['blockergroup', 'note'],
  ['blockerdetail', 'note'],
]);

/** The note-like columns that keep their heading as a label inside `note`. */
const NOTE_LABEL_BY_HEADER = new Map<string, string>([
  ['blockergroup', 'Blocker group'],
  ['blockerdetail', 'Blocker detail'],
]);

const squash = (value: string): string => value.replace(/\s+/g, '').toLowerCase();

/**
 * The columns that make a sheet *this* sheet.
 *
 * Deliberately few, and all three are load-bearing rather than decorative: an
 * identity per case, what to do, and what should happen. A sheet missing any of
 * them is somebody else's spreadsheet and goes to the general extractor, which
 * is the honest outcome — guessing at a table we do not recognise is how a
 * column ends up read as a claim.
 */
const REQUIRED: readonly TextField[] = ['caseId', 'steps', 'expected'];

/**
 * Read a delimited document as a test-case table.
 *
 * `null` when it is not one — the caller falls back to asking a model what the
 * document claims.
 */
export function parseTestCaseTable(raw: string): TestCaseRow[] | null {
  const rows = parseTestCaseRows(parseDelimited(raw, sniffDelimiter(raw)));
  return rows === null ? null : finishTable(rows);
}

/**
 * A workbook's worksheets as one catalog: every sheet that carries the three
 * required columns contributes its rows, each tagged with the sheet it came
 * from. Sheets that are something else — a dashboard, a defect log, a link
 * list — are skipped without a word, because a QA tracking workbook has
 * several of those beside its four case sheets and none of them is a case.
 * `null` when no sheet is a test-case table.
 */
export function parseWorkbookCases(sheets: readonly { name: string; rows: readonly (readonly string[])[] }[]): TestCaseRow[] | null {
  const all: TestCaseRow[] = [];
  for (const sheet of sheets) {
    const rows = parseTestCaseRows(sheet.rows, sheet.name);
    if (rows !== null) all.push(...rows);
  }
  return all.length === 0 ? null : finishTable(all);
}

const POLARITY_CELL = /^(positive|negative)$/i;

/**
 * A data row whose cells slipped one or two columns against the header.
 *
 * Live (ec09.csv, 2026-09-03): the writer left Scenario ID empty and typed the
 * scenario title one cell to the right, so every later cell sat under the
 * wrong heading — "Positive" under Priority, the steps under Expected Output,
 * the ticket numbers under Note. The header still matched, the row still had
 * nineteen cells, and `caseId` read a paragraph, so the row was refused and
 * the whole sheet fell through to the model extractor: 142 s and fifteen
 * claims for one case, against a few milliseconds for the columns read
 * directly.
 *
 * The anchor is the Positive/Negative column: a cell that is exactly
 * `Positive` or `Negative` and sits within two columns of where the header
 * says it should be tells us the offset. A rightward slip is undone by
 * dropping that many EMPTY cells to the left of the anchor (the blank the
 * writer skipped over) — or, when there is no blank, the cells just before
 * it; a leftward slip is undone by inserting blanks before the anchor. A row
 * whose polarity cell is where it belongs, or that has no such cell anywhere
 * near, is returned untouched: this fixes the one shape it recognises and
 * never guesses at another. Returns the offset it undid, for the log.
 */
export function realignRow(cells: readonly string[], polarityColumn: number): { cells: string[]; shift: number } {
  const out = [...cells];
  if (polarityColumn < 0) return { cells: out, shift: 0 };
  const at = (i: number): string => (out[i] ?? '').trim();
  if (POLARITY_CELL.test(at(polarityColumn))) return { cells: out, shift: 0 };
  const near: number[] = [];
  for (let d = -2; d <= 2; d += 1) {
    if (d === 0) continue;
    const j = polarityColumn + d;
    if (j >= 0 && POLARITY_CELL.test(at(j))) near.push(j);
  }
  if (near.length !== 1) return { cells: out, shift: 0 };
  const shift = near[0]! - polarityColumn;
  if (shift > 0) {
    // Slipped right: remove `shift` cells left of the anchor, blanks first.
    let remaining = shift;
    for (let i = near[0]! - 1; i >= 0 && remaining > 0; i -= 1) {
      if (at(i) === '') {
        out.splice(i, 1);
        remaining -= 1;
      }
    }
    if (remaining > 0) out.splice(polarityColumn, remaining);
  } else {
    // Slipped left: the writer dropped a cell; put blanks back before the anchor.
    out.splice(near[0]!, 0, ...new Array<string>(-shift).fill(''));
  }
  return { cells: out, shift };
}

/**
 * Read a grid of cells as a test-case table. `sheet` names the worksheet on
 * every row when there is one. Rows come back as the sheet has them —
 * duplicate ids and cross-references are settled by `finishTable`, once, over
 * the whole catalog, because both are facts about the table rather than a row.
 */
export function parseTestCaseRows(
  rows: readonly (readonly string[])[],
  sheet?: string,
): TestCaseRow[] | null {
  if (rows.length < 2) return null;

  // The header is not always line 1: an exported sheet often carries a title
  // row, or a blank one, above it. Look for it in the first few rows only —
  // further down and it is data that happens to look like a header.
  let headerAt = -1;
  let mapping: (TextField | null)[] = [];
  let labels: (string | null)[] = [];
  for (let i = 0; i < Math.min(rows.length, 5); i += 1) {
    const cells = rows[i] ?? [];
    const candidate = cells.map((cell) => FIELD_BY_HEADER.get(squash(cell)) ?? null);
    if (REQUIRED.every((field) => candidate.includes(field))) {
      headerAt = i;
      mapping = candidate;
      labels = cells.map((cell) => NOTE_LABEL_BY_HEADER.get(squash(cell)) ?? null);
      break;
    }
  }
  if (headerAt === -1) return null;
  // Two headings for one field ("Status" beside "Test Status"): the first wins,
  // the second is dropped rather than overwriting it with a later column. The
  // one exception is `note`, which several columns may feed (Note, Blocker
  // group, Blocker detail) — those are appended, each under its label.
  const seen = new Set<TextField>();
  mapping = mapping.map((field) => {
    if (field === null) return null;
    if (field !== 'note' && seen.has(field)) return null;
    seen.add(field);
    return field;
  });

  const parsed: TestCaseRow[] = [];
  // Scenario ID and Test Scenario are written once per group and left blank on
  // the rows under them. Read literally, case 2 of a scenario belongs to no
  // scenario at all — so the last non-empty value carries down, which is what
  // the blank cell means to the person who wrote it. Menu carries the same
  // way, but only within the scenario it was written in.
  let scenarioId = '';
  let scenario = '';
  let category = '';
  let menu = '';
  let menuScenario = '';

  const polarityColumn = mapping.indexOf('polarity');
  for (const raw of rows.slice(headerAt + 1)) {
    const { cells } = realignRow(raw, polarityColumn);
    const row: TestCaseRow = { ...EMPTY_ROW };
    const notes: string[] = [];
    mapping.forEach((field, column) => {
      if (field === null) return;
      const text = (cells[column] ?? '').trim();
      if (field === 'note') {
        if (text === '') return;
        const label = labels[column] ?? null;
        notes.push(label === null ? text : `${label}: ${text}`);
        return;
      }
      row[field] = text;
    });
    row.note = notes.join('\n');

    if (row.scenarioId !== '') scenarioId = row.scenarioId;
    else row.scenarioId = scenarioId;
    if (row.scenario !== '') scenario = row.scenario;
    else row.scenario = scenario;
    if (row.category !== undefined && row.category !== '') category = row.category;
    else if (category !== '') row.category = category;
    if (row.menu !== '') {
      menu = row.menu;
      menuScenario = row.scenarioId;
    } else if (row.scenarioId === menuScenario) {
      row.menu = menu;
    }

    // A row with no case id and nothing to check is a spacer, not a case.
    if (row.caseId === '' && row.testCase === '') continue;
    // A case id is an identifier, not a sentence: a row whose "id" is a
    // paragraph is a note that drifted into the column (a tracker's
    // sub-heading, a bug remark), not a case.
    if (row.caseId !== '' && (row.caseId.length > 60 || /\n/.test(row.caseId))) continue;
    if (sheet !== undefined) row.sheet = sheet;
    if (row.category === '') delete row.category;
    parsed.push(row);
  }

  return parsed.length === 0 ? null : parsed;
}

/** The whole-table passes, in order: ids first, because references resolve against them. */
function finishTable(rows: TestCaseRow[]): TestCaseRow[] {
  qualifyDuplicateIds(rows);
  linkDependencies(rows);
  return rows;
}

// --- identity ------------------------------------------------------------------

/**
 * Make every `caseId` unique, in place (CG-04).
 *
 * The workbook reuses ids: 35 of them sit in two sheets (TM's Leave Request
 * `PL_03_01` beside BE's Benefit Plan `PL_03_01`) and 14 repeat inside one
 * sheet (`TSH_01_01` six times). Everything downstream keys on the id — the
 * ledger's outcomes, the claims file's `source`, `--rerun-case` — so two rows
 * with one id overwrite each other's verdict and the second is unaddressable.
 *
 * An id present in more than one sheet is prefixed with its sheet
 * (`TM:PL_03_01`); an id repeated inside one sheet gets `#2`, `#3` in row
 * order, the first keeping the bare spelling. Both can apply. The sheet's own
 * spelling is kept in `sheetCaseId` for the prompt's first line and the report.
 */
export function qualifyDuplicateIds(rows: TestCaseRow[]): void {
  const sheetsOf = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.caseId === '') continue;
    const set = sheetsOf.get(row.caseId) ?? new Set<string>();
    set.add(row.sheet ?? '');
    sheetsOf.set(row.caseId, set);
  }
  const seen = new Map<string, number>();
  for (const row of rows) {
    if (row.caseId === '') continue;
    const original = row.caseId;
    let id = original;
    if ((sheetsOf.get(original)?.size ?? 0) > 1 && row.sheet !== undefined && row.sheet !== '') {
      id = `${row.sheet}:${original}`;
    }
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    if (n > 1) id = `${id}#${n}`;
    if (id !== original) {
      row.sheetCaseId = original;
      row.caseId = id;
    }
  }
}

// --- the sheet grammar ---------------------------------------------------------

/**
 * The section headings `describeCase` writes, as one regex every reader of
 * the described row shares (CG-15): `sectionOf` here, `expectedBlockOf` in
 * `exclusivity.ts`, and the flow-author lints that cut the Steps and Expected
 * blocks. Two copies of the terminator list had already drifted apart (one
 * knew `Actual`, the other did not; neither knew `Note (from the sheet)`), and
 * a heading missing from a copy silently folds the next section into the
 * block being judged — the Note counted as script, an option set counted as
 * an Expected item.
 *
 * Matches at a line start, heading through its colon. `Expected-result
 * context` is listed before `Expected` so the alternation cannot stop short.
 */
export const SHEET_SECTION =
  /^[ \t]*(?:Expected-result context|Note(?: \(from the sheet\))?|Test data(?: \([^)\n]*\))?|Steps(?: \([^)\n]*\))?|Expected(?: output)?|Menu path|Destination|Login \/ persona|Preconditions|Actual|Rounds(?: \(\d+\))?|Option set(?: for [^:\n]*)?|Database tables named)[ \t]*:/im;

/** How each section's heading may be spelled, for `sectionOf`. */
const SECTION_HEADING: Record<string, string> = {
  note: 'Note(?: \\(from the sheet\\))?',
  'test data': 'Test data(?: \\([^)\\n]*\\))?',
  steps: 'Steps(?: \\([^)\\n]*\\))?',
  expected: 'Expected(?: output)?',
  'expected output': 'Expected(?: output)?',
  'menu path': 'Menu path',
  destination: 'Destination',
  'login / persona': 'Login \\/ persona',
  preconditions: 'Preconditions',
  actual: 'Actual',
  rounds: 'Rounds(?: \\(\\d+\\))?',
  'option set': 'Option set(?: for [^:\\n]*)?',
  'database tables named': 'Database tables named',
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * One section of a described case — the text after `<name>:` up to the next
 * heading — or null when the text has no such section. The heading may sit
 * at a line start (the prompt form) or after an em dash (the claims file's
 * inline `… — expected: …`). Case-insensitive; `Expected` finds `Expected
 * output:` and `Expected:` alike.
 */
export function sectionOf(text: string, name: string): string | null {
  const key = name.trim().toLowerCase();
  const heading = SECTION_HEADING[key] ?? escapeRegExp(name.trim());
  const open = new RegExp(`(?:^|—)[ \\t]*(?:${heading})[ \\t]*:`, 'im').exec(text);
  if (open === null) return null;
  const rest = text.slice(open.index + open[0].length);
  const close = rest.search(SHEET_SECTION);
  return (close === -1 ? rest : rest.slice(0, close)).replace(/^[ \t]*\n/, '');
}

// Test data ---------------------------------------------------------------------

export interface TestDataPair {
  /**
   * The phase the pair belongs to when the block has them — `Create`,
   * `Insert R1` (from `--Insert R1--`), `TD-21` (from `ชุดข้อมูล TD-21`),
   * `Case 2` (from `Case 2: …`) — else null.
   */
  phase: string | null;
  key: string;
  value: string;
}

const BULLET = /^[-•*]\s*/;
/** `--Create--`, `-- Make Correction --`. */
const PHASE_HEADER = /^-{2,}\s*(.+?)\s*-{2,}$/;
/** `ชุดข้อมูล TD-21` — a named data set, the unit a round refers to. */
const DATASET_HEADER = /^ชุดข้อมูล\s+([A-Z]{1,4}-?\d+[A-Za-z0-9-]*)\s*$/u;
/** `Case 2: งวดพิเศษ`, `รอบที่ 2 …`, `ครั้งที่ 3`, `Round 2`, `Insert R2`, with an optional `N. ` step prefix. */
const ROUND_HEADER = /^(?:\d{1,2}[.)]\s*)?(?:(Case|รอบที่|ครั้งที่|Round|Insert R)\s*(\d+))\s*[:：]?\s*(.*)$/iu;
/**
 * `ดราฟต์เดิมระบุ Department = 30001142 ใช้ 30042174 …` — the draft said X,
 * use Y. X is `key = old` (the EC sheet) or just `old` (`ดราฟต์เดิมระบุ
 * TH_MED_001 ใช้ TH_MED_002`, any pair holding it).
 */
const CORRECTION = /ดราฟต์เดิมระบุ\s*(.+?)\s*ใช้\s*(\S+)/u;
const correctionOf = (line: string): { key: string | null; from: string; to: string } | null => {
  const m = CORRECTION.exec(line);
  if (m === null) return null;
  const keyed = /^(.+?)\s*=\s*(\S+)$/.exec(m[1]!.trim());
  return keyed === null ? { key: null, from: m[1]!.trim(), to: m[2]! } : { key: keyed[1]!.trim(), from: keyed[2]!, to: m[2]! };
};
/** A bare heading the block uses to change subject: conditions, remarks, what to key. */
const BLOCK_HEADING = /^(?:เงื่อนไข|หมายเหตุ|ค่าที่ต้องคีย์)/u;
/** Words that join a key's tokens without starting it. */
const CONNECTOR = /^(?:of|the|and|per|to|for|in|by|on|from|or|ที่|ของ|และ)$/iu;
/** `-`, `/`, `+`, `&`: a token that binds the words either side of it into one value. */
const JOINER = /^[-–/+&:]$/;
/**
 * A token a key is made of: begins with a capital or Thai letter, holds no
 * digit. `\p{M}` because Thai vowels and tone marks are combining marks, not
 * letters — without it `ที่ต้องคีย์` is not a word and the pair stays glued to
 * the one before it.
 */
const KEY_TOKEN = /^\(?[A-Z\p{Script=Thai}][\p{L}\p{M}.'&/-]*\)?,?$/u;

const cleanValue = (value: string): string => {
  const trimmed = value.trim().replace(/[,;]+$/, '').trim();
  const quoted = /^"(.*)"$/.exec(trimmed);
  return quoted ? quoted[1]! : trimmed;
};

/**
 * The `key = value` pairs on one line — one, or several when the sheet packs
 * them (`Position = 40106337 Job Code = MKB12.12`; measured 248 such lines).
 *
 * The first `=` keys on everything before it. Each later `=` keys on the
 * run of capitalised, digit-free tokens right before it (`Job Code`, `SSO
 * Location`, `O.T. Flag`, a Thai run), always leaving the previous pair at
 * least one value token, so `Company = CDS Policy Profile = CDS` reads
 * `Company = CDS` + `Policy Profile = CDS` and `Date of Birth = Age = 60`
 * stays one pair because no key fits before its second `=`. A line with no
 * spaced `=` may be `key=value` or the sheet's `Entry Route : Probation
 * Review` colon form; a round header is never a pair. Empty when the line is
 * prose.
 */
export function splitPairs(line: string): { key: string; value: string }[] {
  const text = line.replace(BULLET, '').trim();
  if (text === '' || ROUND_HEADER.test(text) || CORRECTION.test(text)) return [];
  // A sheet may pack several pairs onto one line with semicolons —
  // `Company = C001; Business Group = 51000000; Business Unit = 10000075`
  // (QA_Task_Revised, 2026-09-08, every TD-01 block). The whitespace grammar
  // below reads a packed line, but the semicolon rides along on the value
  // (`C001;`) and a `/` inside the next key swallows words into the one
  // before it: `Position = 40106337; Department / Organization = 30042174`
  // came out as a single Position of `40106337; Department /`, and the code
  // grounded against no master at all.
  //
  // Split only where what FOLLOWS the semicolon is itself a `key = value`, so
  // a value that merely contains one is left whole.
  const packed = text.split(/;\s+(?=[^=;\n]{1,60}\s=\s)/u);
  if (packed.length > 1) return packed.flatMap((part) => splitPairs(part));
  if (!/\s=\s/.test(text)) {
    const unspaced = /^([^=:\s][^=:]{0,60}?)=(.+)$/.exec(text);
    if (unspaced !== null && !/\s=|=\s/.test(text)) {
      return [{ key: unspaced[1]!.trim(), value: cleanValue(unspaced[2]!) }];
    }
    const colon = /^([\p{L}][\p{L}\p{M}\p{N} /().'&-]{0,40}?)\s*:\s+(.+)$/u.exec(text);
    if (colon !== null && !/\d$/.test(colon[1]!.trim()) && colon[2]!.trim() !== '') {
      return [{ key: colon[1]!.trim(), value: cleanValue(colon[2]!) }];
    }
    return [];
  }
  const tokens = text.split(/\s+/);
  const eqs = tokens.map((token, i) => (token === '=' ? i : -1)).filter((i) => i >= 0);
  if (eqs.length === 0 || eqs[0] === 0) return [];
  // Where each `=`'s key begins; -1 when no key fits (the `=` is value text).
  const keyStart: number[] = [0];
  for (let k = 1; k < eqs.length; k += 1) {
    const eq = eqs[k]!;
    const minStart = eqs[k - 1]! + 2;
    let start = eq;
    for (let i = eq - 1; i >= minStart && KEY_TOKEN.test(tokens[i]!); i -= 1) start = i;
    // A key cannot begin right after a joiner: in `Employee Group = A -
    // Permanent Employee Sub Group = 11` the `-` binds `Permanent` to `A`,
    // so the key is `Employee Sub Group` and the value keeps `A - Permanent`.
    while (start < eq && (CONNECTOR.test(tokens[start]!) || JOINER.test(tokens[start - 1] ?? ''))) start += 1;
    keyStart.push(start === eq ? -1 : start);
  }
  const pairs: { key: string; value: string }[] = [];
  let k = 0;
  while (k < eqs.length) {
    if (keyStart[k] === -1) {
      k += 1;
      continue;
    }
    let next = k + 1;
    while (next < eqs.length && keyStart[next] === -1) next += 1;
    const valueEnd = next < eqs.length ? keyStart[next]! : tokens.length;
    const key = tokens.slice(keyStart[k]!, eqs[k]!).join(' ').replace(/,$/, '');
    const value = cleanValue(tokens.slice(eqs[k]! + 1, valueEnd).join(' '));
    if (key !== '') pairs.push({ key, value });
    k = next;
  }
  return pairs;
}

/**
 * Every `Field = value` in a Test Data block, one entry per pair (CG-02),
 * with the phase it sits under and the sheet's own corrections applied: a
 * `ดราฟต์เดิมระบุ X = A ใช้ B` line rewrites the pair `X = A` to `X = B`
 * where the block still carries the old value, and is never a pair itself.
 * Prose lines (`รายละเอียดเต็มดูชีท Hiring Test Data`) contribute nothing.
 */
export function testDataPairs(text: string): TestDataPair[] {
  const pairs: TestDataPair[] = [];
  const corrections: { key: string | null; from: string; to: string }[] = [];
  let phase: string | null = null;
  for (const raw of text.split('\n')) {
    // The phase header is read before the bullet is stripped: `--Create--`
    // begins with the bullet character and would lose a dash.
    const header = PHASE_HEADER.exec(raw.trim()) ?? DATASET_HEADER.exec(raw.replace(BULLET, '').trim());
    const line = raw.replace(BULLET, '').trim();
    if (line === '') continue;
    const correction = correctionOf(line);
    if (correction !== null) {
      corrections.push(correction);
      continue;
    }
    if (header !== null) {
      phase = header[1]!.trim();
      continue;
    }
    const round = ROUND_HEADER.exec(line);
    if (round !== null) {
      phase = `${round[1]!.replace(/\s+$/, '')} ${round[2]!}`.replace(/^Insert R /, 'Insert R');
      continue;
    }
    if (!/[=:]/.test(line) && BLOCK_HEADING.test(line)) {
      phase = null;
      continue;
    }
    for (const pair of splitPairs(line)) pairs.push({ phase, ...pair });
  }
  for (const fix of corrections) {
    const key = fix.key === null ? null : squash(fix.key);
    for (const pair of pairs) {
      if (key !== null && squash(pair.key) !== key) continue;
      if (pair.value === fix.from || pair.value.startsWith(`${fix.from} `)) {
        pair.value = pair.value === fix.from ? fix.to : `${fix.to}${pair.value.slice(fix.from.length)}`;
      }
    }
  }
  return pairs;
}

/**
 * A Test data VALUE that is not a value: the sheet's own "nobody knows yet"
 * marks. Live (ec09 HIR-EC-009, 2026-09-03): `DVT Project Name = ? รอตาราง
 * โครงการ DVT` (waiting for the DVT project table), `Type = ? ยังไม่ยืนยัน
 * ตารางที่ใช้` (the table is not confirmed), `Course of Time = ? ยังไม่ยืนยัน
 * หน่วย/รูปแบบ` (unit/format not confirmed), and `University Type = ต้องระบุ
 * เป็น DVT Partnered University หรือ Other University ก่อน Execute` — an
 * INSTRUCTION to decide before executing, not a value. Rendered to the author
 * as ordinary pairs, the first three were dropped silently and the fourth was
 * resolved by the model's own choice into a workflow goal; the app then
 * refused Submit for the required field nobody could fill. The shapes: a
 * leading `?`; the sheet's open-question ids (`OQ-HIR-78`, `CF-SIT-19`);
 * English TBD / TBC / "to be confirmed" / "not yet confirmed" / "pending
 * confirmation"; Thai ยังไม่ยืนยัน / ยังไม่ได้กำหนด / ยังไม่ทราบ / ยังไม่มีคำตอบ
 * (not yet confirmed / defined / known / answered), รอ + ยืนยัน / ตาราง /
 * ข้อมูล / คำตอบ / BA / SA (waiting for confirmation / the table / data / an
 * answer / BA / SA), and an instruction that starts ต้องระบุ / ต้องกำหนด /
 * ต้องเลือก (must specify / define / choose) or ends ก่อน Execute.
 *
 * Deliberately NOT matched, because each is a real value somewhere in the
 * sheets: `No`, `Pending` / `รออนุมัติ` (a status), `N/A` (handled by the
 * block reader), a bare `รอ` (waiting — a status word too).
 *
 * An open-question id counts only where it IS the value — at the start, or
 * after the sheet's own `?` (2026-09-04, multirole HIR-EC-001): `Policy
 * Profile = CDS ใช้แทน CDS ที่เคยระบุ ดู CF-SIT-19` names the value and then
 * the question that settled it, and `writtenValueOf` reads it as `CDS`; the
 * same rule `fixtureFacts` applies to a case id after "same as".
 */
export const UNCONFIRMED_VALUE =
  /^\?|\b(?:TBD|TBC|TBA)\b|\b(?:TBD|TBC|TBA)\b|\bto be (?:confirmed|decided|determined|defined|announced)\b|\bnot yet (?:confirmed|decided|defined|determined|known|available)\b|\bpending (?:confirmation|confirm|decision|BA|SA)\b|\bawaiting (?:confirmation|decision|BA|SA)\b|ยังไม่(?:ได้)?(?:ยืนยัน|กำหนด|ระบุ|ทราบ|สรุป|มีคำตอบ)|รอ(?:การ)?(?:ยืนยัน|สรุป|คอนเฟิร์ม)|รอ(?:ตาราง|ข้อมูล|คำตอบ)|รอ\s*(?:BA|SA)\b|^ต้อง(?:ระบุ|กำหนด|เลือก|ยืนยัน)|ก่อน\s*Execute\b/iu;

/** Is this Test data value one nobody has confirmed yet? See `UNCONFIRMED_VALUE`. */
export function unconfirmedValue(value: string): boolean {
  // The open-question prefixes are data (`generator/value-rules.ts`,
  // `authoring.openQuestionPrefixes`); the position — at the START of the
  // value — is the structure (2026-09-04, HIR-EC-001).
  return UNCONFIRMED_VALUE.test(value.trim()) || AUTHORING.openQuestionAtStart.test(value);
}

/**
 * The pairs of a Test data block whose value is unconfirmed — the fields a
 * case cannot key, assert or hand to an agent, listed for the author, the
 * case card and the run log so the gap is visible instead of hunted.
 */
export function unconfirmedTestData(text: string): TestDataPair[] {
  return testDataPairs(text).filter((pair) => unconfirmedValue(pair.value));
}

/**
 * The Test Data block as the author should read it: one pair per line with
 * its phase in brackets, corrections applied, prose lines kept verbatim —
 * so the value resolver's line scan finds `Job Code = MKB12.12` on a line of
 * its own instead of inside `Position`'s value.
 */
function renderTestData(text: string): string[] {
  const out: string[] = [];
  const corrected = new Map<string, TestDataPair[]>();
  for (const pair of testDataPairs(text)) {
    const list = corrected.get(`${pair.phase ?? ''}\u0000${pair.key}`) ?? [];
    list.push(pair);
    corrected.set(`${pair.phase ?? ''}\u0000${pair.key}`, list);
  }
  let phase: string | null = null;
  for (const raw of text.split('\n')) {
    const header = PHASE_HEADER.exec(raw.trim()) ?? DATASET_HEADER.exec(raw.replace(BULLET, '').trim());
    const line = raw.replace(BULLET, '').trim();
    if (line === '') continue;
    if (CORRECTION.test(line)) {
      out.push(line);
      continue;
    }
    if (header !== null) {
      phase = header[1]!.trim();
      continue;
    }
    const round = ROUND_HEADER.exec(line);
    if (round !== null) {
      phase = `${round[1]!.replace(/\s+$/, '')} ${round[2]!}`.replace(/^Insert R /, 'Insert R');
      out.push(line);
      continue;
    }
    if (!/[=:]/.test(line) && BLOCK_HEADING.test(line)) {
      phase = null;
      out.push(line);
      continue;
    }
    const pairs = splitPairs(line);
    if (pairs.length === 0) {
      out.push(line);
      continue;
    }
    for (const pair of pairs) {
      const fixed = corrected.get(`${phase ?? ''}\u0000${pair.key}`)?.shift();
      const value = fixed?.value ?? pair.value;
      out.push(`${phase === null ? '' : `[${phase}] `}${pair.key} = ${value}`);
    }
  }
  return out;
}

// Expected output ---------------------------------------------------------------

/**
 * An Expected line that asks the tester to RECORD what the system shows
 * rather than to check it (CG-09): `= ? OQ-HIR-50`, `ยังไม่มีคำตอบ ให้บันทึก
 * ค่าที่ระบบแสดงจริง`, `บันทึกเป็น Actual Result`, `ส่งให้ BA หรือ SA ยืนยัน`.
 * Measured on the workbook: 179 rows carry one, 17 rows carry nothing else.
 * Asserted, such a line can only fail; invented into an assertion it proves
 * a value the sheet never gave.
 */
export const OBSERVE_ONLY_RE =
  /=\s*\?|ยังไม่มีคำตอบ|(?:^|[^A-Za-z])(?:OQ|CF)-[A-Z]+-\d+|ให้บันทึก(?:ค่า|ข้อความ|ผล|Actual)|บันทึก.{0,40}ที่ระบบ(?:แสดง|ให้)|บันทึกเป็น Actual Result|ส่งให้\s*(?:BA|SA)|หมายเลขคำถามที่ต้องเก็บคำตอบ/u;

/**
 * A line whose oracle is a channel the browser cannot see — an email, an
 * SMS. Recorded, never asserted: the page has nothing to show for it.
 */
const CHANNEL_RE = /ทาง\s*(?:Business\s|Personal\s)?E-?mail|ส่ง\s*sms|ได้รับ\s*(?:E-?mail|SMS)\b/iu;

/** "ตรงตาม Spec" with no text — an assertion whose value lives in a document nobody attached. */
const SPEC_ONLY_RE = /ตรงตาม\s*spec|ตาม error message ที่ spec/iu;

export interface ExpectedLine {
  /** The line's own number (`3.2`, `4`) when it has one. */
  no: string | null;
  /** The line without its number or bullet. */
  text: string;
  /** A record-only line: captured as evidence, never asserted. */
  observeOnly: boolean;
  /** Why it is record-only, for the prompt and the report. */
  why?: string | undefined;
}

/** A two-letter module heading (`EC`, `BE`) the EC sheet opens its Expected with. */
const MODULE_HEADING = /^[A-Z]{2,3}$/;

/**
 * The Expected column, line by line, each marked assertable or record-only.
 * Module headings (`EC`) are dropped; numbering is read off but kept in
 * `no` so an intent can still cite it.
 */
export function expectedLines(expected: string): ExpectedLine[] {
  const lines: ExpectedLine[] = [];
  for (const raw of expected.split('\n')) {
    const stripped = raw.trim().replace(BULLET, '').trim();
    if (stripped === '' || MODULE_HEADING.test(stripped)) continue;
    const numbered = /^(\d+(?:\.\d+)*)[.)]?(?:\s+|$)(.*)$/.exec(stripped);
    const no = numbered?.[1] ?? null;
    const text = (numbered?.[2] ?? stripped).trim();
    if (text === '' && no !== null) continue; // "3." alone: a group heading for 3.1, 3.2
    const entry: ExpectedLine = { no, text, observeOnly: false };
    if (OBSERVE_ONLY_RE.test(text)) {
      entry.observeOnly = true;
      entry.why = 'the sheet asks for the value to be recorded, not checked';
    } else if (CHANNEL_RE.test(text)) {
      entry.observeOnly = true;
      entry.why = 'delivered by email/SMS — not visible in the browser';
    }
    lines.push(entry);
  }
  return lines;
}

/**
 * True when the case has Expected lines and every one of them is record-only
 * — the row has no oracle the browser can contradict, and its honest verdict
 * is `review` with the captures, not a pass and not a block.
 */
export function observeOnlyCase(row: TestCaseRow): boolean {
  const lines = expectedLines(row.expected);
  return lines.length > 0 && lines.every((line) => line.observeOnly);
}

// Rounds ------------------------------------------------------------------------

export interface CaseRound {
  /** `รอบที่ 2 หน่วยธุรกิจ CU ใช้ชุดข้อมูล TD-21`, `Case 2: งวดพิเศษ (Off-Cycle)`, `Insert R1`. */
  label: string;
  /** The round's number. */
  n: number;
  /** The named data set the round uses (`TD-21`), when the header says. */
  dataSet?: string | undefined;
  /** `Field = value; …` — the pairs written under this round's header, in Steps or Test Data. */
  dataOverrides: string;
  /** `ทำซ้ำขั้นตอนที่ 1 ถึง 10` — which steps to repeat, when the round says so. */
  stepsRef?: string | undefined;
}

const STEPS_REF = /ทำซ้ำขั้นตอน(?:ที่)?\s*(\d+)\s*(?:ถึง|-|–)\s*(\d+)/u;
const DATASET_REF = /ชุดข้อมูล\s*([A-Z]{1,4}-?\d+[A-Za-z0-9-]*)/u;
/** `Country/Min/Max/Effective start/end ว่างทีละช่อง` — one round per field left empty. */
const ONE_FIELD_AT_A_TIME = /([A-Za-z][A-Za-z0-9 /()-]{2,80}?)\s*ว่างทีละช่อง/u;

/**
 * The rounds a single row packs (CG-10): `รอบที่ N` legs of a hire, `Case N:`
 * sub-runs of a payroll period, `--Insert R1--` phases, a per-field
 * `ว่างทีละช่อง` loop. Each carries the data that differs in that round, read
 * from the pair lines under its header in Steps and in Test Data (a data set
 * the header names — `TD-21` — pulls that set's pairs too). Measured: 97
 * rows. Empty for a row with fewer than two rounds.
 */
export function roundsOf(row: TestCaseRow): CaseRound[] {
  const byN = new Map<number, CaseRound>();
  const dataByPhase = new Map<string, string[]>();
  for (const pair of testDataPairs(row.testData)) {
    if (pair.phase === null) continue;
    const list = dataByPhase.get(pair.phase) ?? [];
    list.push(`${pair.key} = ${pair.value}`);
    dataByPhase.set(pair.phase, list);
  }
  const note = (label: string, n: number, lines: string[], sourceIsSteps: boolean): void => {
    const existing = byN.get(n);
    const dataSet = DATASET_REF.exec(label)?.[1];
    // Only lines that ARE pairs: a step sentence with an `=` inside it
    // ("กรอก Salutation, First Name … และ Event Reason = H_NEWHIRE") keys on
    // half a sentence and is not this round's data.
    const overrides = lines.flatMap((line) =>
      splitPairs(line)
        .filter((p) => p.key.split(/\s+/).length <= 5 && !/[,]/.test(p.key))
        .map((p) => `${p.key} = ${p.value}`),
    );
    if (dataSet !== undefined) overrides.push(...(dataByPhase.get(dataSet) ?? []));
    const stepsRef = STEPS_REF.exec(lines.join('\n'));
    const round: CaseRound = existing ?? { label, n, dataOverrides: '' };
    if (existing !== undefined && sourceIsSteps && existing.label.length < label.length) round.label = label;
    if (dataSet !== undefined) round.dataSet = dataSet;
    const merged = [...round.dataOverrides.split('; ').filter(Boolean), ...overrides];
    round.dataOverrides = [...new Set(merged)].join('; ');
    if (stepsRef !== null) round.stepsRef = `${stepsRef[1]}–${stepsRef[2]}`;
    byN.set(n, round);
  };
  const scan = (text: string, sourceIsSteps: boolean): void => {
    let current: { label: string; n: number; lines: string[] } | null = null;
    const flush = (): void => {
      if (current !== null) note(current.label, current.n, current.lines, sourceIsSteps);
      current = null;
    };
    for (const raw of text.split('\n')) {
      const header = PHASE_HEADER.exec(raw.trim());
      const line = raw.replace(BULLET, '').trim();
      const round = ROUND_HEADER.exec(header === null ? line : header[1]!);
      if (round !== null) {
        flush();
        current = { label: (header === null ? line : header[1]!).replace(/^\d{1,2}[.)]\s*/, ''), n: Number(round[2]), lines: [] };
        continue;
      }
      if (current !== null) current.lines.push(line);
    }
    flush();
  };
  scan(row.steps, true);
  scan(row.testData, false);
  const rounds = [...byN.values()].sort((a, b) => a.n - b.n);
  if (rounds.length >= 2) return rounds;
  // A per-field loop is rounds too: one per field the step leaves empty.
  const loop = ONE_FIELD_AT_A_TIME.exec(row.steps);
  if (loop !== null) {
    const fields = loop[1]!.split('/').map((f) => f.trim()).filter(Boolean);
    if (fields.length >= 2) {
      return fields.map((field, i) => ({ label: `ว่างช่อง ${field}`, n: i + 1, dataOverrides: `${field} = (empty)` }));
    }
  }
  return [];
}

// Menu and destination ----------------------------------------------------------

/**
 * The Menu column as breadcrumbs (CG-11): numbering stripped, split on line
 * breaks and `>`/`›`/`→`, `N/A` and stray numbers dropped, a parenthesised
 * URL (the PY sheet's `SSO Base Amount (https://…/sso)`) lifted off the crumb
 * — `destinationOf` reads it. Empty when the sheet gives none.
 */
export function menuPathOf(row: TestCaseRow): string[] {
  return row.menu
    .split(/\n|\s*(?:>|›|→|->)\s*/)
    .map((crumb) => crumb.replace(/^\d+[.)]\s*/, '').replace(/\s*\(https?:\/\/[^)]*\)\s*$/i, '').trim())
    .filter((crumb) => crumb !== '' && !/^(?:n\/?a|-|\d+)$/i.test(crumb));
}

export interface CaseDestination {
  /** A literal URL the row navigates to, from Steps or Menu. */
  url: string | null;
  /** A tab the row selects on arrival (`เลือกแท็บ "SSO Base Amount"`). */
  tab: string | null;
  /** The menu breadcrumbs, `menuPathOf`. */
  path: string[];
}

const URL_RE = /https?:\/\/[^\s)"'<>]+/i;
const TAB_RE = /(?:เลือก|กด|เปิด)?\s*(?:แท็บ|tab)\s*["“]([^"”]+)["”]/iu;

/**
 * Where the case starts: the literal URL in Steps (`Navigate ไปที่ https://…`)
 * or Menu, the tab it selects, and the menu path. Null when the row says
 * nothing usable about any of the three.
 */
export function destinationOf(row: TestCaseRow): CaseDestination | null {
  const url = URL_RE.exec(row.steps)?.[0] ?? URL_RE.exec(row.menu)?.[0] ?? null;
  const tab = TAB_RE.exec(row.steps)?.[1]?.trim() ?? null;
  const path = menuPathOf(row);
  if (url === null && tab === null && path.length === 0) return null;
  return { url, tab, path };
}

// Cross-references --------------------------------------------------------------

const CASE_ID = '(?:E2E|HIR-EC|PRB-EC|CNS-EC|PL|RU|TC|ML|OT|MC|TSH)[A-Z0-9_-]*\\d';
/**
 * `ต่อจากเคส E2E-01`, `same Test Data as PL_07_01`, `ตามขั้นตอนของ E2E-128`,
 * `เงื่อนไขเดียวกับ E2E-258`, `รันคู่กับ E2E-34`, `(จาก E2E-118)`. Not
 * `ตัดจากเคส E2E-01` — "cut from case E2E-01" is where the row CAME from,
 * every EC row says it, and none of them depends on it.
 */
const PROSE_REF = new RegExp(
  `(?:same Test Data as|(?<!ตัด)(?:จาก|ต่อจาก)|ตามขั้นตอนของ|เงื่อนไขเดียวกับ|ข้อมูลทดสอบเดียวกับ|รันคู่กับ)\\s*(?:เคส\\s*)?(${CASE_ID})`,
  'giu',
);
/** `Plan = PL_03_07`, `Benefit Plan ID = PL_06_21`, `Employee ID : EM (จาก …)` — a case id used as data. */
const DATA_REF = new RegExp(`(?:Plan|Rule|Employee ID|Data|ID|Name)\\s*[:=]\\s*"?((?:PL|RU|HIR-EC|PRB-EC)[A-Z0-9_]*\\d[A-Z0-9_]*)`, 'gu');

export interface CaseReference {
  id: string;
  /**
   * What the reference asks for: the other case's data (`same Test Data
   * as`), its steps (`ตามขั้นตอนของ`), its outcome (`ต่อจากเคส` — the
   * employee it created), or nothing (`รันคู่กับ`, "run beside" — a
   * pairing note; HIR-EC-044 says it of E2E-01 and needs nothing from it).
   */
  kind: 'data' | 'steps' | 'follows' | 'beside';
}

/** Every other case a row names, in order of appearance, deduplicated. */
export function referencedCases(row: TestCaseRow): CaseReference[] {
  const text = `${row.testData}\n${row.preconditions}\n${row.steps}\n${row.note}`;
  const refs: CaseReference[] = [];
  const seen = new Set<string>();
  const add = (id: string, kind: CaseReference['kind']): void => {
    if (seen.has(id)) return;
    seen.add(id);
    refs.push({ id, kind });
  };
  for (const m of text.matchAll(PROSE_REF)) {
    const phrase = m[0];
    const kind: CaseReference['kind'] = /same Test Data|ข้อมูลทดสอบเดียวกับ|เงื่อนไขเดียวกับ/iu.test(phrase)
      ? 'data'
      : /ตามขั้นตอนของ/u.test(phrase)
        ? 'steps'
        : /รันคู่กับ/u.test(phrase)
          ? 'beside'
          : 'follows';
    add(m[1]!, kind);
  }
  for (const m of text.matchAll(DATA_REF)) add(m[1]!, 'data');
  return refs;
}

/**
 * Resolve every row's references against the table (CG-12), in place:
 * `dependsOn` for ids the table has (as their qualified ids, same sheet
 * first), `externalRefs` for the rest; a row with no Test Data inherits the
 * referenced case's, a `ตามขั้นตอนของ X` row with no Steps inherits X's.
 *
 * An external reference is recorded only where the row actually NEEDS the
 * other case: it follows it (`ต่อจากเคส E2E-01` — the probation rows need
 * the employee E2E-01 hired), or it takes data or steps from it and carries
 * none of its own. `ข้อมูลทดสอบเดียวกับ E2E-01` on a row whose Test Data is
 * written out in full (HIR-EC-029) is a citation, and refusing the row for
 * a case that is not in the catalog would strike a case that has everything
 * it needs. A data-shaped reference to an id the table lacks (`Plan =
 * PL_08`) is data, not a dependency, and is dropped. A row never depends on
 * itself.
 *
 * **A reference is resolved against SCENARIO ids too** (2026-09-04, multirole
 * PRB-EC-001). The workbook names a hire by its scenario (`ต่อจากเคส E2E-01`:
 * the E2E scenario whose rows are HIR-EC-001, HIR-EC-002 …), never by one of
 * those rows' Test Case IDs, so a scenario id is a name this table may hold.
 * The row's OWN scenario id is itself — the probation rows of scenario
 * E2E-01 "continue from E2E-01" — and is never a dependency, external or
 * otherwise. Another scenario the table holds resolves to its first row
 * (the one that creates what the scenario's later rows use), same sheet
 * first. Only a scenario the table does NOT hold is external. Structural: the
 * ids come from the table's own columns, never from a list of prefixes.
 */
export function linkDependencies(rows: TestCaseRow[]): void {
  const bySheet = new Map<string, TestCaseRow>();
  const byId = new Map<string, TestCaseRow[]>();
  const byScenario = new Map<string, TestCaseRow[]>();
  for (const row of rows) {
    if (row.scenarioId !== '') byScenario.set(row.scenarioId, [...(byScenario.get(row.scenarioId) ?? []), row]);
    const own = row.sheetCaseId ?? row.caseId;
    if (own === '') continue;
    bySheet.set(`${row.sheet ?? ''}\u0000${own}`, bySheet.get(`${row.sheet ?? ''}\u0000${own}`) ?? row);
    byId.set(own, [...(byId.get(own) ?? []), row]);
  }
  const resolve = (row: TestCaseRow, id: string): TestCaseRow | null => {
    const same = bySheet.get(`${row.sheet ?? ''}\u0000${id}`);
    if (same !== undefined) return same;
    const any = byId.get(id);
    if (any !== undefined && any.length > 0) return any[0]!;
    // The row's own scenario is the row itself (skipped by the caller); another
    // scenario the table holds is its first row, this sheet's before another's.
    if (id === row.scenarioId) return row;
    const scenario = byScenario.get(id);
    if (scenario === undefined) return null;
    return scenario.find((other) => (other.sheet ?? '') === (row.sheet ?? '')) ?? scenario[0] ?? null;
  };
  for (const row of rows) {
    const dependsOn: string[] = [];
    const external: string[] = [];
    let dataSource: TestCaseRow | null = null;
    let stepsSource: TestCaseRow | null = null;
    const blankData = row.testData.trim() === '' || /^(?:-|n\/?a)$/i.test(row.testData.trim());
    for (const ref of referencedCases(row)) {
      const target = resolve(row, ref.id);
      if (target === null) {
        const needed =
          ref.kind === 'follows' ||
          (ref.kind === 'steps' && row.steps.trim() === '') ||
          (ref.kind === 'data' && blankData && /^(?:E2E|HIR-EC|PRB-EC|CNS-EC)/.test(ref.id));
        if (needed) external.push(ref.id);
        continue;
      }
      if (target === row) continue;
      if (!dependsOn.includes(target.caseId)) dependsOn.push(target.caseId);
      if (ref.kind === 'data' && dataSource === null) dataSource = target;
      if (ref.kind === 'steps' && stepsSource === null) stepsSource = target;
    }
    if (dependsOn.length > 0) row.dependsOn = dependsOn;
    if (external.length > 0) row.externalRefs = [...new Set(external)];
    const source = dataSource ?? (dependsOn.length > 0 ? resolve(row, dependsOn[0]!.replace(/^[^:]+:/, '').replace(/#\d+$/, '')) : null);
    if (blankData && source !== null && source !== row && source.testData.trim() !== '') {
      row.testData = source.testData;
      row.testDataFrom = source.caseId;
    }
    if (row.steps.trim() === '' && stepsSource !== null && stepsSource.steps.trim() !== '') {
      row.steps = stepsSource.steps;
      row.stepsFrom = stepsSource.caseId;
    }
  }
}

// Unique keys -------------------------------------------------------------------

export interface UniqueKey {
  key: string;
  value: string;
  phase: string | null;
}

const UNIQUE_KEY_NAME = /(?:^|[\s(])(?:ID|Code|Name|Plan|Rule)(?:$|[\s)])|รหัส|ชื่อ/iu;
const GENERATED_NAME = /^"?(?:QA-|SIT_)/;
const EXISTS_ALREADY = /มีอยู่แล้ว|already exists|ที่มีอยู่|existing/iu;

/**
 * Test Data pairs whose value is the case's own id or a QA-minted name (CG-13):
 * `Benefit Plan ID = PL_06_21`, `Benefit name = QA-Create Plan …`, a
 * `_R3` the tester appended by hand after the first rerun collided. On any
 * rerun the application answers "already exists" and the create case fails
 * for a reason that is not the application's. Skipped when the row says the
 * value is MEANT to exist (`มีอยู่แล้ว`) — the negative duplicate case must
 * reuse it. The substitution itself is the caller's: same literal in Test
 * Data, Steps and Expected, recorded as generated.
 */
export function uniqueKeys(row: TestCaseRow): UniqueKey[] {
  const own = normaliseId(row.sheetCaseId ?? row.caseId);
  if (own === '') return [];
  const out: UniqueKey[] = [];
  for (const pair of testDataPairs(row.testData)) {
    if (!UNIQUE_KEY_NAME.test(pair.key)) continue;
    const value = pair.value.replace(/^"|"$/g, '');
    const normalised = normaliseId(value);
    const isOwnId = normalised === own || /^(?:R?\d+)$/.test(normalised.slice(own.length)) && normalised.startsWith(own);
    if (!isOwnId && !GENERATED_NAME.test(value)) continue;
    if (EXISTS_ALREADY.test(`${row.testCase}\n${pair.key} = ${pair.value}`)) continue;
    out.push({ key: pair.key, value, phase: pair.phase });
  }
  return out;
}

const normaliseId = (value: string): string => value.replace(/[-_\s"]/g, '').toUpperCase();

// Option sets -------------------------------------------------------------------

export interface OptionSet {
  /** The control the set belongs to, as the sheet names it. */
  field: string;
  /** Whether the list is the whole set (`ครบถ้วน ดังนี้`, `มีแค่ N ค่า`) or examples (`เช่น`). */
  exact: boolean;
  /** The size the sheet states, when it states one. */
  count: number | null;
  members: string[];
  /** Names the sheet says must NOT be offered. */
  forbidden: string[];
  /** The Expected line that carried the claim. */
  line: string;
}

const SET_COMPLETE = /(?:แสดง)?ตัวเลือก\s*(.+?)\s*ครบถ้วน\s*ดังนี้\s*[:：]?\s*(.*)$/u;
const SET_COUNTED = /(?:dropdown|ตัวเลือก)?\s*(.*?)\s*(?:dropdown)?\s*(?:มีแค่|แสดงครบ|แสดง|ครบ)\s*(\d+)\s*(?:ค่า|รายการ|ตัวเลือก)\s*[:：]?\s*(.*)$/u;
const SET_ONLY = /(?:^|\s)(.*?)\s*แสดงเฉพาะ\s*(.+)$/u;
const SET_FORBIDDEN = /ไม่มี\s*([A-Z][A-Z0-9_]+)(?:\s*และไม่มี\s*([A-Z][A-Z0-9_]+))*/gu;
const EXAMPLES = /เช่น|e\.g\.|\.\.\.$|…$/u;
const MEMBER_SPLIT = /\s*\/\s*|\s*,\s*|\s*\|\s*/;

/** Item-ish lines — `A`, `A=Fixed Amount` — that follow a `ดังนี้` header until the next numbered line. */
function membersBelow(lines: readonly string[], from: number): string[] {
  const members: string[] = [];
  for (let i = from + 1; i < lines.length; i += 1) {
    const line = lines[i]!.trim().replace(BULLET, '');
    if (line === '' || /^\d+(?:\.\d+)*[.)]?\s/.test(line) || SHEET_SECTION.test(line)) break;
    if (line.length > 80) break;
    members.push(line);
  }
  return members;
}

const cleanMember = (member: string): string => member.trim().replace(/[()\s]+$/, '').replace(/\s*เท่านั้น$/u, '').trim();

/**
 * The option-set claims in an Expected column (CG-14): `แสดงตัวเลือก X ครบถ้วน
 * ดังนี้` + one member per line (BE), `dropdown มีแค่ 3 ค่า: F=…, A=…, P=…`
 * (PY), `Event Reason … แสดงเฉพาะ New Hire / Replacement / Migration` and
 * `ไม่มี RE_REHIRE_GE1 และไม่มี RE_REHIRE_LT1` (EC Hiring). Exact unless the
 * list is introduced as examples (`เช่น`) or trails off. A count is what the
 * line states; the member list is what it enumerates — both are handed on,
 * so a set whose count and list disagree is visible rather than resolved.
 */
export function optionSetsIn(expected: string): OptionSet[] {
  const lines = expected.split('\n');
  const sets: OptionSet[] = [];
  lines.forEach((raw, i) => {
    const line = raw.trim().replace(BULLET, '').trim();
    if (line === '') return;
    const body = line.replace(/^\d+(?:\.\d+)*[.)]?\s+/, '');
    const forbidden = [...body.matchAll(SET_FORBIDDEN)].flatMap((m) => {
      const all = m[0].match(/[A-Z][A-Z0-9_]+/g) ?? [];
      return all;
    });
    let field = '';
    let count: number | null = null;
    let members: string[] = [];
    let matched = false;
    const complete = SET_COMPLETE.exec(body);
    const counted = complete === null ? SET_COUNTED.exec(body) : null;
    const only = complete === null && counted === null ? SET_ONLY.exec(body) : null;
    if (complete !== null) {
      matched = true;
      field = complete[1]!.trim();
      members = complete[2]!.trim() === '' ? membersBelow(lines, i) : complete[2]!.split(MEMBER_SPLIT);
    } else if (counted !== null) {
      matched = true;
      count = Number(counted[2]);
      field = counted[1]!.replace(/^(?:ตรวจสอบ|ระบบ)\s*/u, '').replace(/\s*(?:dropdown|แสดง|บนหน้า.*)$/iu, '').trim();
      const tail = counted[3]!.replace(/^[(]|[)]$/g, '');
      members = tail.trim() === '' ? membersBelow(lines, i) : tail.split(MEMBER_SPLIT);
      // "แสดง 3 ค่า : Event Reason บนหน้า Key-in แสดงเฉพาะ A / B / C" — the
      // enumeration and the field sit after the colon, behind "แสดงเฉพาะ".
      const inner = SET_ONLY.exec(tail);
      if (inner !== null) {
        field = inner[1]!.replace(/\s*บนหน้า.*$/u, '').trim() || field;
        members = inner[2]!.split(MEMBER_SPLIT);
      }
    } else if (only !== null && forbidden.length === 0) {
      // "… เท่านั้น เช่น rule-med-001, rule-med-002" lists examples after the
      // word; the condition before it is not a member.
      const tail = only[2]!.trim().replace(/^[\s\S]*?เช่น\s*/u, '');
      const listed = tail.split(MEMBER_SPLIT).map(cleanMember).filter(Boolean);
      // "แสดงเฉพาะ New Hire / Replacement / Migration" enumerates; "แสดงเฉพาะ
      // เอกสารที่เปิดใช้งาน" (only the enabled documents) is a filter, not a set.
      if (listed.length >= 2) {
        matched = true;
        field = only[1]!.replace(/^(?:ตรวจสอบ|ระบบ|หน้าจอ|รายการ|ตาราง)\s*/u, '').replace(/\s*บนหน้า.*$/u, '').trim();
        members = listed;
      }
    }
    if (!matched && forbidden.length === 0) return;
    const cleaned = [...new Set(members.map(cleanMember).filter((m) => m !== '' && !/^เท่านั้น$/u.test(m)))];
    if (!matched && forbidden.length > 0) {
      field = body.replace(/^(?:dropdown)?\s*/iu, '').split(/\s*ไม่มี/u)[0]!.replace(/^dropdown\s*/iu, '').trim();
    }
    sets.push({
      field: field.replace(/^dropdown\s*/iu, '').trim() || 'the list',
      exact: matched && !EXAMPLES.test(body),
      count,
      members: cleaned,
      forbidden: [...new Set(forbidden)],
      line,
    });
  });
  return sets;
}

// Database tables ---------------------------------------------------------------

export interface NamedTable {
  /** `employee_center.probation_transactions`, `employment_jobs`. */
  table: string;
  /** Columns the line names alongside it. */
  columns: string[];
}

const DB_LIST = /DB\s*[:：]\s*([a-z_]+\.[a-z_]+(?:\s*,\s*[a-z_]+\.[a-z_]+)*)/giu;
const TABLE_COLUMN = /\btable\s+([a-z_]+(?:\.[a-z_]+)?)\s+column\s+([a-z_]+(?:\s*[,/]\s*[a-z_]+)*)/giu;
const IN_TABLE = /(?:ใน|in|from)\s+([a-z_]+\.[a-z_]+)(?![.\w])/giu;
const DOTTED_COLUMN = /(?<![.\w])([a-z_]{3,})\.([a-z_]{3,})(?![.\w])\s*(?:=|ว่าง|ถูกเขียน|เป็น|is|equals)/giu;

/**
 * Tables the Expected column names as its oracle (CG-17): `DB :
 * time_management.leave_requests , …`, `record ใน employee_center.
 * probation_transactions`, `table employment_jobs column probation_result`,
 * `employment_jobs.contract_end_date = 31/12/9999`. The last shape is
 * table.column, not schema.table — it is compared to a value — and is read
 * as such. Measured: 29 rows. The caller checks each name against the
 * introspected inventory; an unknown name is logged, never asserted.
 */
export function dbTablesNamed(row: TestCaseRow): NamedTable[] {
  const found = new Map<string, Set<string>>();
  const add = (table: string, columns: readonly string[] = []): void => {
    const set = found.get(table) ?? new Set<string>();
    for (const column of columns) if (column !== '') set.add(column);
    found.set(table, set);
  };
  const text = row.expected;
  for (const m of text.matchAll(DB_LIST)) for (const table of m[1]!.split(/\s*,\s*/)) add(table.trim());
  for (const m of text.matchAll(TABLE_COLUMN)) add(m[1]!, m[2]!.split(/\s*[,/]\s*/));
  for (const m of text.matchAll(IN_TABLE)) add(m[1]!);
  for (const m of text.matchAll(DOTTED_COLUMN)) add(m[1]!, [m[2]!]);
  return [...found.entries()].map(([table, columns]) => ({ table, columns: [...columns] }));
}

// --- gates -----------------------------------------------------------------------

/**
 * Steps only a hand on the machine can take, or an oracle the browser cannot
 * read — each a literal rule with the sheet line that motivated it, because a
 * broad guess here strikes testable rows. Authoring such a row as assertions
 * guarantees they fail against the healthy environment — seen live as a
 * dead-end run filing high frontend defects for an outage nobody caused.
 */
const ENVIRONMENT_STEP_RE =
  /\b(brew services (stop|start)|systemctl (stop|start|restart)|pg_ctl\s+(stop|start)|docker (stop|kill)|service \S+ (stop|start))\b/i;
const SQL_WRITE_PIVOT_RE = /\bdirect sql\b/i;
/** `[TBD - ยังไม่มี UI จริง, NO-SPEC]` — TC_TAX_054..060, TC_FUND_025..027. */
const NO_SPEC_RE = /ยังไม่มี UI จริง|NO-SPEC|\[TBD[^\]]*(?:UI|URL|SPEC)/iu;
/** A step that IS waiting for a calendar day: `6. รอวัน Effective Start Date` (PL_06_24, RU_05_34). Line-initial, so a comparison that mentions waiting does not trip it. */
const CALENDAR_WAIT_RE = /^\s*(?:\d{1,2}[.)]\s*)?(?:-\s*)?รอ(?:วัน|เลย|ถึงวัน)/mu;
/**
 * A numbered step handed to another team: `3. รอถึงวันที่ 119 แล้วให้ทีมพัฒนา
 * run daily batch` (PRB-EC-048), `2. ส่งรายการตำแหน่ง…ให้ทีมเตรียมข้อมูล`
 * (HIR-EC-129). Numbered lines only: the `- แจ้งผู้ดูแลระบบให้ยกเลิกพนักงาน`
 * bullet under ขั้นตอนคืนค่าเดิม is cleanup after the case, on thirty
 * otherwise-runnable hiring rows.
 */
const OTHER_TEAM_RE =
  /^\s*\d{1,2}[.)]\s*.*?(?:(?:ให้|ขอให้|ประสาน)ทีม(?:พัฒนา| ?FO| ?PY| ?BE| ?TM| ?SA| ?เตรียม)?|ทีมพัฒนา(?:รัน|จำลอง|เตรียม)|แจ้งผู้ดูแลระบบ(?!ให้ยกเลิก))/mu;
const NETWORK_RE = /Network หลุด|connection หลุด|ไม่มีสัญญาณ|server timeout ระหว่าง/iu;
/** `Not Start`, `Cancelled`, `4356` (an Excel date serial in the TM sheet's E2E rows) — a status or a number is not an oracle. */
const STATUS_OR_NUMBER_RE = /^(?:[A-Z]: )?(?:Not Start(?:ed)?|Cancelled|Blocked|\d+)$/i;

/**
 * Why a row cannot be checked from the browser, or null when it can.
 *
 * `startUrl` is the origin the run opens on; with it, a row whose Steps or
 * Menu navigate to another host is refused up front — the 234 PY rows that
 * open payroll-cnext-dev cost an authoring call and a dead-end each when
 * the run was pointed at humi. Without it, host is not judged.
 */
export function beyondHarnessReason(row: TestCaseRow, startUrl?: string): string | null {
  const steps = `${row.steps}\n${row.preconditions}`;
  if (ENVIRONMENT_STEP_RE.test(steps)) {
    return 'requires stopping or starting services — beyond the browser; held for a human';
  }
  if (SQL_WRITE_PIVOT_RE.test(row.testCase) || SQL_WRITE_PIVOT_RE.test(row.scenario)) {
    return "pivots on a direct SQL write — wowlidator's database access is read-only by design; held for a human";
  }
  if (startUrl !== undefined && startUrl !== '') {
    const startHost = hostOf(startUrl);
    const other = [...`${row.steps}\n${row.menu}`.matchAll(new RegExp(URL_RE.source, 'gi'))]
      .map((m) => hostOf(m[0]))
      .find((host) => host !== null && host !== startHost);
    if (startHost !== null && other !== undefined && other !== null) {
      return `navigates to ${other} — a different origin from the run's start URL (${startHost}); held for a human`;
    }
  }
  const surface = `${row.testCase}\n${row.menu}\n${row.steps}\n${row.testData}`;
  const noSpec = NO_SPEC_RE.exec(surface);
  if (noSpec !== null) {
    return `the screen has no UI or spec yet ("${noSpec[0]}"); held for a human`;
  }
  const wait = CALENDAR_WAIT_RE.exec(row.steps);
  if (wait !== null) {
    const line = lineHolding(row.steps, wait.index);
    return `a step waits for a calendar day ("${line}") — the browser cannot advance the clock; held for a human`;
  }
  const team = OTHER_TEAM_RE.exec(row.steps);
  if (team !== null) {
    const line = lineHolding(row.steps, team.index);
    return `a step is carried out by another team ("${line}"); held for a human`;
  }
  const network = NETWORK_RE.exec(`${row.testCase}\n${row.steps}`);
  if (network !== null) {
    return `simulates a dropped connection ("${network[0]}") — beyond the browser; held for a human`;
  }
  const expected = row.expected.trim();
  if (expected === '') return 'the Expected output is blank — no oracle to check; held for a human';
  if (STATUS_OR_NUMBER_RE.test(expected)) {
    return `the Expected output holds no oracle ("${expected}"); held for a human`;
  }
  const lines = expectedLines(row.expected);
  if (lines.length > 0 && lines.every((line) => SPEC_ONLY_RE.test(line.text))) {
    return 'every Expected line defers to a spec that is not attached ("ตรงตาม Spec"); held for a human';
  }
  return null;
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
};

const lineHolding = (text: string, index: number): string => {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? undefined : end).trim().slice(0, 100);
};

/**
 * The sheet's own recorded outcome for a case, normalised — the ground truth
 * accuracy is measured against, because Positive/Negative says what a case
 * MEANS to prove and only the Actual Result column says how the application
 * actually behaved when a person last ran it.
 *
 * `Passed` / `Re-Test Passed` → 'passed'; `Failed` / `Re-Test Failed` →
 * 'failed'. Everything else — blank, `Cancelled`, `Pending confirm`,
 * `Re-Testing` — is `undefined`: the sheet has no verdict there, and inventing
 * one would put fabricated ground truth under a percentage. Same
 * understate-never-overstate rule as `statedPolarity`. `sheetVerdict` is the
 * wider reading that also knows `blocked`.
 */
export function recordedResult(raw: string): 'passed' | 'failed' | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (/^(re-?test(ed)?[\s-]*)?pass(ed)?$/.test(trimmed)) return 'passed';
  if (/^(re-?test(ed)?[\s-]*)?fail(ed)?$/.test(trimmed)) return 'failed';
  return undefined;
}

export type SheetVerdict = 'passed' | 'failed' | 'blocked';

/** `Blocked`, `Pending deploy`, `รอ deploy` — the sheet says the case could not be run. */
const BLOCKED_STATUS_RE = /^(?:blocked|pending deploy|รอ ?deploy)/iu;
/** `Pending confirm` waits on a person's word about a result that exists; gated with the blocked ones, but no verdict. */
const PENDING_STATUS_RE = /^pending confirm/iu;

/**
 * `recordedResult` plus `blocked` (CG-01): a Test Status of `Blocked` or
 * `Pending deploy` is the sheet recording that the case had no verdict for a
 * reason outside the application — a verdict class of its own in the truth
 * table (shown as "sheet: blocked", excluded from accuracy), not a blank.
 * `Not Start` / `Ready to test` / `Pending confirm` stay `undefined`.
 */
export function sheetVerdict(raw: string): SheetVerdict | undefined {
  const known = recordedResult(raw);
  if (known !== undefined) return known;
  return BLOCKED_STATUS_RE.test(raw.trim()) ? 'blocked' : undefined;
}

/**
 * Why a sheet row must not be authored at all, or null (CG-01; the pure
 * form of the CLI's `sheetGate`, which delegates here). `Cancelled` in the
 * status, or a Note that says the case is cancelled/dropped, is a row about
 * a feature the requirement no longer has — authoring it can only produce a
 * false failure. A Note that says the case cannot be run yet is the sheet's
 * own verdict (CNS-EC-028: authored anyway, the model narrowed five steps to
 * three "the page exists" assertions and went green about an absent
 * feature). And a status of `Blocked` / `Pending deploy` / `Pending confirm`
 * — 114 rows, most with a bug ticket — is a case the sheet's own testers
 * could not run: authored, it fails against a known defect and files it
 * again. `includeBlocked` lets a run retest them on purpose.
 */
export function sheetGateReason(row: TestCaseRow, options: { includeBlocked?: boolean | undefined } = {}): string | null {
  const actual = row.actual.trim();
  const lower = actual.toLowerCase();
  const note = row.note.trim();
  if (/^cancel+ed$|^ยกเลิก/u.test(lower)) return 'the sheet records this case as Cancelled — the requirement dropped it';
  // The Note's words are data (`generator/value-rules.ts`, `authoring.sheetNote`),
  // both languages; the column read — the Note, never the Steps — is the structure.
  if (options.includeBlocked !== true && (BLOCKED_STATUS_RE.test(actual) || PENDING_STATUS_RE.test(actual))) {
    const ticket = oneLine(row.bugTicket);
    return `the sheet records this case as ${actual}${ticket === '' ? '' : ` — bug ticket ${ticket}`}`;
  }
  if (AUTHORING.sheetNote.cancelled.test(note) && !AUTHORING.sheetNote.retest.test(lower)) {
    return `the sheet's Note says the case was cancelled: "${note.slice(0, 80)}"`;
  }
  const notYet = AUTHORING.sheetNote.notYet.exec(note);
  if (notYet !== null) {
    const line = note.split('\n').find((l) => l.includes(notYet[0])) ?? notYet[0];
    return `the sheet's Note says the case cannot be run yet: "${line.trim().slice(0, 140)}"`;
  }
  return null;
}

// --- claims ------------------------------------------------------------------------

/**
 * The claims a table asserts.
 *
 * One claim per row, and the claim text is the case title plus what the sheet
 * says should happen — because "Saving is blocked when no HRBP is assigned" on
 * its own is a topic, and the Expected Output column is the actual assertion.
 * The Test Case ID becomes `source`, so every claim in the gate points back at
 * the row a reviewer can find.
 *
 * **`Actual Result` is ignored on purpose.** It records what a person saw last
 * time they ran it by hand. Reading it would let a sheet marked Fail arrive
 * pre-judged, and the run about to happen is the thing that decides.
 *
 * `startUrl`, when given, lets `beyondHarnessReason` refuse rows that
 * navigate to another host.
 */
export function tableToClaims(rows: readonly TestCaseRow[], startUrl?: string): CatalogClaim[] {
  return rows.map((row) => {
    const beyond = beyondHarnessReason(row, startUrl);
    return {
      claim: claimTextOf(row),
      priority: row.priority.trim().toLowerCase() || 'medium',
      source:
        (row.caseId || row.scenarioId || row.testCase.slice(0, 40)) +
        (beyond === null ? '' : ` (${beyond})`),
      // Every row of this sheet is a case someone wrote to be run. A row that
      // only sets the scene does not get a Test Case ID and a set of
      // expectations. The exception is a row whose steps only a hand on the
      // machine can take — kept, shown at the gate with the boundary named,
      // never authored into assertions that must fail. Re-tick `testable` in
      // the claims file to run its checkable subset anyway.
      testable: beyond === null,
    };
  });
}

function claimTextOf(row: TestCaseRow): string {
  const expected = row.expected.trim();
  const title = row.testCase.trim() || row.scenario.trim() || row.caseId;
  const note = row.note.trim();
  // The Note column is where the sheet's writer parked the caveats — a KNOWN
  // FAIL, "the SQL is the only authoritative proof", a pending BA decision.
  // Dropping it authored claims stripped of exactly the context that decides
  // what an honest assertion looks like.
  return (
    (expected === '' ? title : `${title} — expected: ${oneLine(expected)}`) +
    (note === '' ? '' : ` — note: ${oneLine(note)}`)
  );
}

const oneLine = (value: string): string => value.split('\n').map((l) => l.trim()).filter(Boolean).join('; ');

/**
 * Everything the flow author should know about one case.
 *
 * The general catalog prompt hands the model a sentence. This hands it the row:
 * the steps a tester would take, what each should produce, the menu path to get
 * there, and the data to use. That is the difference between a model guessing a
 * journey and being told it — and the numbered expectations (`3.2`) say which
 * step each assertion belongs after, which is exactly what a flow needs.
 *
 * The derived sections (option sets, tables, rounds) sit between Test data
 * and Steps, so a reader that cuts the Steps or Expected block by the
 * headings it already knows sees exactly the block it saw before them.
 */
export function describeCase(row: TestCaseRow): string {
  const parts = [`${row.sheetCaseId ?? row.caseId ?? row.scenarioId}: ${row.testCase}`];
  if (row.scenario !== '') parts.push(`Scenario: ${row.scenario}`);
  if (row.polarity !== '') parts.push(`Type: ${row.polarity}`);
  // The sheet's own sign-in and environment columns, verbatim: the writer
  // spelled out which account, which selectors resolve, and what the
  // deployment looks like — precisely what an authored setup gets wrong when
  // it has to guess.
  if (row.persona !== '') parts.push(`Login / persona:\n${indent(row.persona)}`);
  if (row.preconditions !== '') parts.push(`Preconditions:\n${indent(row.preconditions)}`);
  const path = menuPathOf(row);
  if (path.length > 0) parts.push(`Menu path: ${path.join(' > ')}`);
  const destination = destinationOf(row);
  if (destination !== null && (destination.url !== null || destination.tab !== null)) {
    parts.push(
      `Destination: ${destination.url ?? '(the menu path above)'}${destination.tab === null ? '' : ` (tab "${destination.tab}")`}`,
    );
  }
  if (row.testData !== '' && !/^(?:n\/?a|-)$/i.test(row.testData.trim())) {
    const heading = row.testDataFrom === undefined ? 'Test data:' : `Test data (inherited from ${row.testDataFrom}):`;
    parts.push(`${heading}\n${renderTestData(row.testData).map((line) => `  ${line}`).join('\n')}`);
    // The pairs nobody has confirmed, named as such (`UNCONFIRMED_VALUE`):
    // the author skips their steps and says so, never types the marker,
    // never names them in a workflow goal, never asserts them.
    const unconfirmed = unconfirmedTestData(row.testData);
    if (unconfirmed.length > 0) {
      parts.push(
        'Unconfirmed test data (no value yet — never type it, never assert it, never name it in a workflow goal; ' +
          'write the scripted step for such a field as "skipped step N: unconfirmed test data — <Field>"):\n' +
          unconfirmed.map((pair) => `  ${pair.key} = ${pair.value}`).join('\n'),
      );
    }
  }
  for (const set of optionSetsIn(row.expected)) {
    const size = set.count === null ? String(set.members.length) : String(set.count);
    const head =
      set.members.length === 0 ? `Option set for ${set.field}:` : `Option set for ${set.field} (${set.exact ? 'exact' : 'examples'}, ${size}):`;
    const listed = set.members.length === 0 ? '' : ` ${set.members.join(' | ')}`;
    const banned = set.forbidden.length === 0 ? '' : `${listed === '' ? '' : ';'} forbidden: ${set.forbidden.join(', ')}`;
    parts.push(`${head}${listed}${banned}`);
  }
  const tables = dbTablesNamed(row);
  if (tables.length > 0) {
    parts.push(
      `Database tables named: ${tables.map((t) => (t.columns.length === 0 ? t.table : `${t.table} (${t.columns.join(', ')})`)).join('; ')}`,
    );
  }
  const rounds = roundsOf(row);
  if (rounds.length > 1) {
    parts.push(
      `Rounds (${rounds.length}):\n${rounds
        .map((r) => {
          const ref = r.stepsRef === undefined ? '' : ` (repeat steps ${r.stepsRef})`;
          return `  round ${r.n} — ${r.label}${ref}${r.dataOverrides === '' ? '' : `: ${r.dataOverrides}`}`;
        })
        .join('\n')}`,
    );
  }
  if (row.steps !== '') {
    const heading = row.stepsFrom === undefined ? 'Steps:' : `Steps (inherited from ${row.stepsFrom}):`;
    parts.push(`${heading}\n${indent(row.steps)}`);
  }
  if (row.expected !== '') parts.push(`Expected output:\n${markRecordOnly(row.expected)}`);
  // Last on purpose: the caveats read best once the case is understood — a
  // KNOWN FAIL note is the difference between filing a defect and pinning one.
  if (row.note !== '') parts.push(`Note (from the sheet):\n${indent(row.note)}`);
  return parts.join('\n');
}

/** The Expected column indented, each record-only line prefixed `[RECORD ONLY]`. */
function markRecordOnly(expected: string): string {
  return expected
    .split('\n')
    .map((raw) => {
      const line = raw.trim();
      if (line === '') return '  ';
      const stripped = line.replace(BULLET, '').replace(/^\d+(?:\.\d+)*[.)]?\s+/, '');
      const record = OBSERVE_ONLY_RE.test(stripped) || CHANNEL_RE.test(stripped);
      return `  ${record ? '[RECORD ONLY] ' : ''}${line}`;
    })
    .join('\n');
}

const indent = (value: string): string =>
  value
    .split('\n')
    .map((line) => `  ${line.trim()}`)
    .join('\n');

// --- writing -----------------------------------------------------------------

/** Quote a cell the way a spreadsheet does: only when it has to be quoted. */
function cell(value: string): string {
  const text = value ?? '';
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Render rows as a catalog in this format.
 *
 * `No.` is renumbered from 1 and **`Scenario ID` / `Test Scenario` are blanked
 * on continuation rows**, because that is how the format expresses grouping and
 * a sheet that repeats them on every line looks, to a reader, like every row is
 * its own scenario. Result columns (`Actual Result` through `Bug ticket`) are
 * written empty: nothing here has been run by a person yet, and pre-filling
 * `Pass` would be a claim about work nobody did.
 */
export function renderTestCaseTable(rows: readonly TestCaseRow[]): string {
  const lines = [TEST_CATALOG_HEADER.map(cell).join(',')];
  let lastScenario = '';

  rows.forEach((row, index) => {
    const startsScenario = row.scenarioId !== lastScenario;
    lastScenario = row.scenarioId;
    lines.push(
      [
        String(index + 1),
        startsScenario ? row.scenarioId : '',
        startsScenario ? row.scenario : '',
        row.caseId,
        row.polarity,
        row.priority,
        row.testCase,
        row.testData,
        row.menu,
        row.steps,
        row.expected,
        row.actual,
        row.testDate,
        row.testBy,
        row.bugTicket,
        row.note,
        '',
      ]
        .map(cell)
        .join(','),
    );
  });

  return `${lines.join('\n')}\n`;
}

/**
 * Fill in what the format derives rather than states: ids, numbering, polarity.
 *
 * A model asked for test cases returns the interesting columns and is unreliable
 * at the bookkeeping ones — it repeats a Test Case ID, or numbers scenarios from
 * whatever it saw last. Those are a function of position, so they are computed
 * here and never asked for.
 */
export function numberCases(
  cases: readonly Omit<TestCaseRow, 'no' | 'scenarioId' | 'caseId'>[],
  prefix: string,
): TestCaseRow[] {
  const scenarioIds = new Map<string, string>();
  const perScenario = new Map<string, number>();
  const rows: TestCaseRow[] = [];

  for (const one of cases) {
    const key = one.scenario.trim() || 'General';
    let scenarioId = scenarioIds.get(key);
    if (scenarioId === undefined) {
      scenarioId = `${prefix}_${String(scenarioIds.size + 1).padStart(2, '0')}`;
      scenarioIds.set(key, scenarioId);
    }
    const n = (perScenario.get(scenarioId) ?? 0) + 1;
    perScenario.set(scenarioId, n);

    rows.push({
      ...one,
      scenario: key,
      no: String(rows.length + 1),
      scenarioId,
      caseId: `${scenarioId}_${String(n).padStart(2, '0')}`,
      polarity: /^neg/i.test(one.polarity) ? 'Negative' : 'Positive',
      priority: titleCase(one.priority) || 'Medium',
      // Never pre-filled: see `renderTestCaseTable`.
      actual: '',
      testDate: '',
      testBy: '',
      bugTicket: '',
    });
  }

  return rows;
}

function titleCase(value: string): string {
  const word = value.trim().toLowerCase();
  if (word === '') return '';
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** A short, stable id prefix from whatever the catalog is about. */
export function prefixFor(subject: string): string {
  const words = subject
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2);
  const initials = words.slice(0, 2).map((word) => word[0]?.toUpperCase() ?? '').join('');
  return initials.length >= 2 ? initials : 'TC';
}

/**
 * The persona labels a row names, in order of first appearance (CG-05): the
 * workbook's `<HR_ADMIN_ACCOUNT>` tokens (424 mentions), and the role words
 * the PY and TM sheets use instead of a token — `Login ด้วย SPD Admin` (every
 * PY row), `หัวหน้าอนุมัติ` / `Manager approve` (the hand-off rows), `HRBP`,
 * `Login web humi` / `พนักงานเข้าสู่ระบบ` (an employee's own session). A bare
 * "Manager" is NOT a persona — `Approval route = Manager` is a field value —
 * so the role word must be doing something (approving, signing in).
 */
export function personasOf(row: TestCaseRow): string[] {
  const text = [row.persona, row.preconditions, row.testData, row.steps, row.testCase].join('\n');
  const found: { label: string; at: number }[] = [];
  for (const match of text.matchAll(/<([A-Z][A-Z0-9_]*_ACCOUNT)>/g)) {
    found.push({ label: match[1]!, at: match.index ?? 0 });
  }
  const ROLE_WORDS: readonly [RegExp, string][] = [
    [/SPD\s*Admin/iu, 'SPD_ADMIN'],
    [/\bHR\s*Admin\b/iu, 'HR_ADMIN_ACCOUNT'],
    [/\bHRBP\b/u, 'HRBP_ACCOUNT'],
    [/\b(?:line\s+)?manager\b[^\n.]{0,24}?(?:approv|reject|log ?in|sign ?in|อนุมัติ|ปฏิเสธ|เข้าสู่ระบบ)|หัวหน้า(?:งาน)?\s*(?:อนุมัติ|ปฏิเสธ|เข้าสู่ระบบ|กด|login)/iu, 'MANAGER_ACCOUNT'],
    [/login\s+web\s+humi|พนักงานเข้าสู่ระบบ|\bemployee\b[^\n.]{0,16}?(?:log ?in|sign ?in|เข้าสู่ระบบ)/iu, 'EMPLOYEE_ACCOUNT'],
  ];
  for (const [re, label] of ROLE_WORDS) {
    const match = re.exec(text);
    if (match !== null) found.push({ label, at: match.index });
  }
  found.sort((a, b) => a.at - b.at);
  const out: string[] = [];
  for (const { label } of found) if (!out.includes(label)) out.push(label);
  return out;
}

/**
 * Every persona the WHOLE document needs, and which cases need each — the
 * hand-off that lets a surface ask for credentials before anything is spent.
 *
 * It exists because the claims file was the first parsed artefact the panel
 * ever held and it said nothing about accounts: `claimTextOf` composes a claim
 * from the title, the expectation and the note, and the Steps column — where
 * `Login ด้วย <MANAGER_ACCOUNT>` actually lives — is not among them. So a
 * catalog needing two logins looked exactly like one needing none until the
 * authoring loop refused a row, by which time a browser was open and tokens
 * were spent.
 *
 * Labels and case ids ONLY. No email, no password: the claims file is plain
 * JSON a person opens, edits and mails around, and a credential has no
 * business in it. Which account fills a label is decided later, by the run,
 * from its environment.
 *
 * Order is first appearance across the document, and `cases` keeps sheet
 * order, so a surface can render "3 cases sign in as this account" without
 * sorting anything itself.
 */
export interface PersonaNeed {
  /** The label as the sheet spells it, e.g. `MANAGER_ACCOUNT`. */
  label: string;
  /** The ids of the cases that need it, in sheet order. */
  cases: string[];
}

export function tablePersonas(rows: readonly TestCaseRow[]): PersonaNeed[] {
  const found = new Map<string, string[]>();
  for (const row of rows) {
    const id = row.caseId || row.scenarioId;
    if (id === '') continue;
    for (const label of personasOf(row)) {
      const cases = found.get(label);
      if (cases === undefined) found.set(label, [id]);
      else if (!cases.includes(id)) cases.push(id);
    }
  }
  return [...found].map(([label, cases]) => ({ label, cases }));
}
