/**
 * Value resolution at authoring time (asked for 2026-09-02).
 *
 * A sheet leaves some inputs as TOKENS — `<NON_EXISTING_EMPLOYEE_ID>`,
 * `<VALID_EMPLOYEE_ID>`, `<HR_ADMIN_ACCOUNT>` — or as a description — "Replaced
 * Employee ID ของพนักงานที่มีอยู่จริง". Live (ec10_2 HIR-EC-012) the author
 * typed the token itself into the field; the page URL-encoded it, the API
 * rejected malformed input, and the step "proved" a rejection the case never
 * asked about. Refusing the row instead (`typesPlaceholderToken`) is honest and
 * useless: the tester still has no run.
 *
 * So a token is RESOLVED, from the cheapest source that can answer, and the
 * step says which one did:
 *
 * 0. **relative-date** — the sheet writes dates the way a tester thinks about
 *    them: `Hire Date = Today`, `Effective Start Date = Next day`, `Date of
 *    Birth = Age < 60`, `Period End Date = Hire Date + 119 Day`, `วันที่ 25
 *    ของเดือนปัจจุบัน`, `31 Dec 9999` (278 rows of the HR workbook, 2026-09-03).
 *    `fromRelativeDate` computes the ISO date from an injected `now`, $0 and
 *    deterministic, and a later field may lean on an earlier one by label.
 *    Then, before anything else, **unique-per-run**: a key value that IS the
 *    case id (`Benefit Plan ID = PL_06_21`) or a `QA-`/`SIT_` name gets the
 *    run's suffix, because on any rerun the app says "already exists" and the
 *    create case fails for a reason it never asked about (49 rows).
 * 1. **test-data** — the case's own text names a concrete value for the same
 *    field (`Replaced Employee ID = 20001234`). $0. Packed lines
 *    (`Position = 40106337 Job Code = MKB12.12`) and phase headers
 *    (`--Insert R1--`) are read pair by pair.
 * 2. **repo** — the context documents and the repository's prompt slice are
 *    retrieved against the field and token words, and the agent role is asked
 *    ONE structured question over those passages. Accepted only when the value
 *    appears verbatim in a passage — the model's word is never the evidence.
 * 3. **db** — read-only, only when a connection is configured: the agent role
 *    names `{table, column, where}` in `dbCount`'s own shape, every identifier
 *    is checked against the introspected schema, one `SELECT … LIMIT 1` runs,
 *    the value passes through redaction. A NON_EXISTING token is proved
 *    non-existent instead: a well-formed candidate from the case's stated
 *    format, `count(*) = 0`, up to five tries.
 * 4. **generated** — the generator role invents a well-formed value from the
 *    case's stated format (or a deterministic one when no model answers), and
 *    the step is FLAGGED: `valueSource.kind = 'generated'`, the intent says so,
 *    every report shows it. A generated value is a stand-in the reader must
 *    know about, never evidence.
 *
 * Never fatal: a source that throws is a source that did not answer, and the
 * stage as a whole leaves a step untouched when nothing answered — the lint
 * then refuses it, as before.
 *
 * **The sheet's own shapes** (2026-09-04). Read over the 1,286-row QA workbook,
 * the sheet writes a value several more ways than a token: a value followed
 * by a note (`10 ตามชุดข้อมูล`, `D05H0830 ตามที่ Position กำหนด`), a bound
 * (`11 ขึ้นไป`), a blank word (`Blank`, `ว่าง`, `null`), a mask standing for a
 * value made elsewhere (`EMXXXX (จาก E2E-01)`, `BE-XXX-999 (ไม่มีในระบบ)`), an
 * invalid value with its own examples (`ค่าอื่นที่ไม่ถูกต้อง เช่น "Active", "X"`),
 * a length (`ข้อความความยาวเกิน 255 ตัวอักษร`), a quoted literal with a remark
 * (`"32/13/2026" (วันที่ผิดรูปแบบ)`), and dates in many grammars — `31-Dec-9999`,
 * `13 เมษายน`, `1 มกราคมของปีก่อนหน้า`, `< Current Date`, `วันก่อนวันที่จ้าง`,
 * `Age = 60 พอดี ณ Hire Date`, `ย้อนหลังจากวันที่ทดสอบ 5`, a value that IS another
 * date field's label. Each is handled by a STRUCTURAL mechanism here (a
 * trailing clause, a quoted example, a label reference, an anchor clause)
 * over the built-in `VOCABULARY` below, compiled once into `R`. The
 * single-source rule holds for every shape: a written value is cleaned or
 * left as written, never handed to a model.
 */

import { z } from 'zod';

import type { ExtractedDocument } from '../catalog/extract.js';
import { selectRelevantContext } from '../catalog/retrieve.js';
import { uniquePerRun } from '../data/mock-data.js';
import type { DbClient, DbSchema } from '../db/client.js';
import { quoteIdent } from '../db/db-actions.js';
import { redactValue } from '../db/redact-row.js';
import type { FlowStep } from '../engine/runner.js';
import { codeAndLabelOf } from '../engine/normalise.js';
import {
  LookupFetcher,
  codeText,
  groundCodes,
  readPath,
  sameField,
  templateTokens,
  type FetchJson,
  type MasterDataLookup,
} from '../context/master-data.js';
import { lenientObject } from '../providers/model-output.js';
import { generateStructuredForModel, type ModelSource } from '../providers/llm-factory.js';
import { unconfirmedValue } from '../catalog/test-case-table.js';
import { AUTHORING, VALUE_RULES, type Vocabulary } from './value-rules.js';

/** The sheet's angle-bracket placeholder: `<NON_EXISTING_EMPLOYEE_ID>`. */
export const PLACEHOLDER_TOKEN = /<[A-Z][A-Z0-9_\- ]{2,}>/;
/**
 * A mask standing for a value made elsewhere: `EMXXXX` (the id E2E-01 will
 * create), `BE-XXX-999`, `N-NNNN-NNNNN-NN-N`. Three or more `X`/`N` in a run,
 * with at most a short literal prefix/suffix — a rule NAME that merely
 * contains `XXX` is not one.
 */
export const MASK_VALUE = /^(?:[A-Z]{1,4}[-_]?)?[NX]{3,}(?:[-_][NX0-9]{1,6}){0,4}$|^[NX]{1,4}(?:-[NX]{1,6}){2,}$/;
/** Columns whose values are never handed out as test input, whatever the redaction rule says. */
const SENSITIVE_COLUMN = /pass(word|wd)?|secret|token|hash|salt|\bssn\b|national_?id|citizen|passport|card_?(no|number)|cvv|pin\b/i;
/** The open-question marker — asserted never, typed never; not this module's business. */
const OPEN_QUESTION = AUTHORING.openQuestion;
/** A quoted literal, the sheet's way of saying "this exact string": `"32/13/2026"`, `"N"`. */
const QUOTED = /"([^"]*)"|“([^”]*)”|'([^']*)'/g;
/** The other case a value comes from: `(จาก E2E-01)`, `(from TC-12)`. */
const CASE_REFERENCE = /\b([A-Z][A-Z0-9]{1,5}-[A-Z0-9]{1,4}(?:-\d{1,4})?|[A-Z]{2,6}_\d{2,3}(?:_\d{2,3})*)\b/;

// --- the vocabulary -----------------------------------------------------------------
//
// The words that mean "today", "leave it blank", "and above", "does not
// exist" when a sheet's cell is read. The MECHANISMS below are structural (a
// word class, a trailing clause, a quoted example, a label reference); the
// words are listed here once, compiled once into `R`, and no entry names a
// field of one catalog, a case id or a test-data literal. Every word is a
// LITERAL: regex-escaped, then anchored the way its class needs — Latin on a
// word boundary, Thai as a substring, a blank word as the whole value.

/** A label or a Test data key, normalised for matching: no `*`, no parenthetical, no trailing colon, one space. */
export function normalLabel(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\*/g, '')
    .replace(/:$/, '')
    .replace(/[^\p{L}\p{M}\p{N})]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The key names the field, or the field qualified (`Invalid Replaced Employee ID`), or the field names the key. */
export function keyMatchesLabel(key: string, label: string): boolean {
  if (key === '' || label === '') return false;
  return key === label || key.endsWith(` ${label}`) || label.endsWith(` ${key}`);
}

/**
 * The vocabulary is DATA (`value-rules.ts`, 2026-09-04): the built-ins merged
 * with `.wowlidator/value-rules.json`, loaded once per process. Kept under its
 * old name so every function below reads as it always did.
 */
export const VOCABULARY: Vocabulary = VALUE_RULES.values;

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isWordChar = (ch: string): boolean => /[A-Za-z0-9]/.test(ch);
const hasThai = (w: string): boolean => /\p{Script=Thai}/u.test(w);
/** A Latin word sits on word boundaries; Thai has none, so a Thai word is a substring. */
function bounded(w: string): string {
  const body = escape(w);
  const head = isWordChar(w[0]!) ? '\\b' : '';
  const tail = isWordChar(w[w.length - 1]!) ? '\\b' : '';
  return `${head}${body}${tail}`;
}
/** Longest first, so `ก่อนหน้า` is tried before `ก่อน` and `next day` before `next`. */
const longestFirst = (list: readonly string[]): string[] => [...new Set(list)].sort((a, b) => b.length - a.length);
/** `(?:a|b|c)` of bounded literals; `(?!)` (matches nothing) when the list is empty. */
function alternation(list: readonly string[], each: (w: string) => string = bounded): string {
  const parts = longestFirst(list).map(each);
  return parts.length === 0 ? '(?!)' : `(?:${parts.join('|')})`;
}
/**
 * A literal whose spaces, hyphens and underscores may be any of them or
 * nothing, matched as a substring: `non-existing` reads `NON_EXISTING_ID` and
 * `NonExisting` too. No boundaries — a token glues the word to what follows
 * (`<NOT_FOUND_ID>`).
 */
const flexible = (w: string): string => escape(w).replace(/[-_ ]+/g, '[_\\- ]?');
/** A word relation (`before`, `วันก่อน`) is a bounded literal; a symbol one (`<`) must be followed by a space, so `<runtime>` is never a date. */
const relationWord = (w: string): string => (/\p{L}/u.test(w[0]!) ? bounded(w) : `${escape(w)}(?=\\s)`);
/** A symbol word (`<`, `>=`) is a bare literal; a Latin one is bounded. */
const symbolOrWord = (w: string): string => (isWordChar(w[0]!) ? bounded(w) : escape(w));
/** Thai month names, full and abbreviated, as the sheet writes them. */
const THAI_MONTH_ALT =
  '(?:ม\\.?ค\\.?|ก\\.?พ\\.?|มี\\.?ค\\.?|เม\\.?ย\\.?|พ\\.?ค\\.?|มิ\\.?ย\\.?|ก\\.?ค\\.?|ส\\.?ค\\.?|ก\\.?ย\\.?|ต\\.?ค\\.?|พ\\.?ย\\.?|ธ\\.?ค\\.?|มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)';

interface CompiledVocabulary {
  keyField: RegExp;
  qaKey: RegExp;
  nonExisting: RegExp;
  describedValue: RegExp;
  alreadyExists: RegExp;
  /** The whole value (Latin) or its start (Thai) says "leave it blank". */
  blankValue: RegExp;
  /** The whole value says "a space". */
  spaceValue: RegExp;
  /** The value opens with an input verb or a note introducer: an instruction, not a value. */
  describedHead: RegExp;
  credential: RegExp;
  /** Where a value's trailing note begins: ` ตามชุดข้อมูล`, ` as per …`. */
  noteStart: RegExp;
  /** A trailing bound: ` ขึ้นไป`, ` or more`. */
  boundTail: RegExp;
  /** An example introducer, after which quoted strings are the examples. */
  exampleIntroducer: RegExp;
  format: { digits: RegExp; leading: RegExp; length: RegExp; over: RegExp; under: RegExp };
  date: {
    today: RegExp;
    tomorrow: RegExp;
    yesterday: RegExp;
    future: RegExp;
    past: RegExp;
    /** The month word after `ของเดือน` / `of … month`; group 1. */
    monthWord: string;
    thisMonth: RegExp;
    nextMonth: RegExp;
    previousMonth: RegExp;
    before: RegExp;
    after: RegExp;
    /** `ณ <label>` anywhere in a phrase; group 1 is the label. */
    atClause: RegExp;
    prefix: RegExp;
    exactTail: RegExp;
    back: RegExp;
    forward: RegExp;
    /** Alternations (no anchors) of the unit words, per kind and all together. */
    unitAlt: { day: string; week: string; month: string; year: string; any: string };
    /** Which kind a unit word is; `day` when the word is none of them (`Next day + 1`). */
    unitKindOf(word: string): 'day' | 'week' | 'month' | 'year';
    birthField: RegExp;
    ageWord: string;
    ageOp: string;
    ageTail: string;
    ageUnder: RegExp;
    ageOver: RegExp;
    ageAtLeast: RegExp;
    ageAtMost: RegExp;
    ageAnchorFields: readonly string[];
    /** The shapes a typed value must take to be read as a date phrase at all. */
    phraseShapes: RegExp[];
  };
  /** Every label that names the same field as `label`, normalised, `label` itself first. */
  aliasesOf(label: string): string[];
}

/** The regexes and tables the resolver runs, built once from the vocabulary. Pure. */
function compileVocabulary(v: Vocabulary): CompiledVocabulary {
  const d = v.dates;
  const f = v.formatWords;
  const monthWord = `(${alternation([...d.thisMonth, ...d.nextMonth, ...d.previousMonth], escape)})`;
  const unit = alternation([...d.units.day, ...d.units.week, ...d.units.month, ...d.units.year]);
  const ageOp = alternation([...d.ageUnder, ...d.ageOver, ...d.ageAtLeast, ...d.ageAtMost, ...d.ageExact], symbolOrWord);
  const groups = v.fieldAliases.map((g) => g.map(normalLabel));
  const aliasIndex = new Map<string, string[]>();
  for (const g of groups) for (const label of g) aliasIndex.set(label, g);
  const wordThenGap = (w: string): string => (hasThai(w) ? `${escape(w)}(?=\\s|$|\\p{Script=Thai})` : `${bounded(w)}`);
  /** The whole value (Latin) or its start (Thai) is one of the words. */
  const wholeOrThaiHead = (list: readonly string[]): RegExp =>
    new RegExp(`^(?:${alternation(list.filter((w) => !hasThai(w)), escape)}\\s*$|${alternation(list.filter(hasThai), escape)})`, 'iu');
  const anchored = (list: readonly string[]): RegExp => new RegExp(`^${alternation(list, symbolOrWord)}$`, 'iu');
  return {
    keyField: new RegExp(alternation(v.keyFieldWords), 'iu'),
    qaKey: new RegExp(`^${alternation(v.qaKeyPrefixes, escape)}`, 'iu'),
    nonExisting: new RegExp(alternation(v.nonExistingWords, flexible), 'iu'),
    describedValue: new RegExp(alternation(v.describedValueWords, escape), 'iu'),
    alreadyExists: new RegExp(alternation(v.alreadyExistsWords, escape), 'iu'),
    blankValue: wholeOrThaiHead(v.blankWords),
    spaceValue: wholeOrThaiHead(v.spaceWords),
    describedHead: new RegExp(`^${alternation([...v.inputVerbs, ...v.noteIntroducers], wordThenGap)}`, 'iu'),
    credential: new RegExp(alternation(v.credentialWords, flexible), 'iu'),
    noteStart: new RegExp(`\\s+${alternation(v.noteIntroducers, wordThenGap)}`, 'iu'),
    boundTail: new RegExp(`\\s+${alternation(v.boundWords)}\\s*$`, 'iu'),
    exampleIntroducer: new RegExp(alternation(v.exampleIntroducers, (w) => (hasThai(w) ? escape(w) : `${isWordChar(w[0]!) ? '\\b' : ''}${escape(w)}`)), 'iu'),
    format: {
      digits: new RegExp(`(\\d{1,3})\\s*-?\\s*${alternation(f.digitUnits)}`, 'iu'),
      leading: new RegExp(`${alternation(f.leadingDigit)}\\s*(\\d)`, 'iu'),
      length: new RegExp(`(\\d{1,4})\\s*${alternation(f.lengthUnits)}`, 'iu'),
      over: new RegExp(alternation(f.over, symbolOrWord), 'iu'),
      under: new RegExp(alternation(f.under, symbolOrWord), 'iu'),
    },
    date: {
      today: new RegExp(`^${alternation(d.today)}`, 'iu'),
      tomorrow: new RegExp(`^${alternation(d.tomorrow)}`, 'iu'),
      yesterday: new RegExp(`^${alternation(d.yesterday)}`, 'iu'),
      future: new RegExp(`^${alternation(d.future)}\\s*$`, 'iu'),
      past: new RegExp(`^${alternation(d.past)}\\s*$`, 'iu'),
      monthWord,
      thisMonth: new RegExp(`^${alternation(d.thisMonth, escape)}$`, 'iu'),
      nextMonth: new RegExp(`^${alternation(d.nextMonth, escape)}$`, 'iu'),
      previousMonth: new RegExp(`^${alternation(d.previousMonth, escape)}$`, 'iu'),
      before: new RegExp(`^${alternation(d.before, relationWord)}\\s*`, 'iu'),
      after: new RegExp(`^${alternation(d.after, relationWord)}\\s*`, 'iu'),
      atClause: new RegExp(`(?:^|\\s)${alternation(d.at)}\\s*([\\p{L}\\p{M}\\p{N} /().'*-]+?)(?=\\s*(?:${ageOp}|\\d)|\\s*$)`, 'iu'),
      prefix: new RegExp(`^${alternation(d.prefixes)}\\s*`, 'iu'),
      exactTail: new RegExp(`\\s*${alternation(d.exact)}\\s*$`, 'iu'),
      back: new RegExp(`^${alternation(d.back)}`, 'iu'),
      forward: new RegExp(`^${alternation(d.forward)}`, 'iu'),
      unitAlt: {
        day: alternation(d.units.day),
        week: alternation(d.units.week),
        month: alternation(d.units.month),
        year: alternation(d.units.year),
        any: unit,
      },
      unitKindOf: (word) => {
        const w = word.trim();
        for (const kind of ['month', 'year', 'week'] as const) {
          if (new RegExp(`^${alternation(d.units[kind])}$`, 'iu').test(w)) return kind;
        }
        return 'day';
      },
      birthField: new RegExp(alternation(d.birthFieldWords), 'iu'),
      ageWord: alternation(d.ageWords),
      ageOp,
      ageTail: alternation([...d.ageAtLeast, ...d.ageAtMost, ...d.ageExact], symbolOrWord),
      ageUnder: anchored(d.ageUnder),
      ageOver: anchored(d.ageOver),
      ageAtLeast: anchored(d.ageAtLeast),
      ageAtMost: anchored(d.ageAtMost),
      ageAnchorFields: d.ageAnchorFields.map(normalLabel),
      phraseShapes: [
        new RegExp(`^${alternation([...d.today, ...d.tomorrow, ...d.yesterday, ...d.future, ...d.past])}`, 'iu'),
        new RegExp(`^${alternation(d.prefixes)}`, 'iu'),
        new RegExp(`^${alternation([...d.before, ...d.after], relationWord)}\\s*\\S`, 'iu'),
        new RegExp(`^${alternation(d.back)}`, 'iu'),
        new RegExp(`(?:^|\\s)${alternation(d.at)}\\s`, 'iu'),
        /วันนี้|วันถัดไป|วันพรุ่งนี้|พรุ่งนี้|เมื่อวาน|วันที่ปัจจุบัน|ย้อนหลัง|วันก่อน|ล่วงหน้า|ของเดือน|สิ้นเดือน|ต้นเดือน|วันสุดท้าย|วันแรก|ของปี|อายุ/u,
        /^วันที่\s*\d{1,2}\s*$/u,
        new RegExp(`^${alternation(d.ageWords)}\\s*(?:${ageOp})`, 'iu'),
        /\b9999\b/,
        new RegExp(`[+\\-−]\\s*\\d+\\s*${unit}`, 'iu'),
        /\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+\d{4}\b/i,
        /\b\d{1,2}-(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*-\d{4}\b/i,
        /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i,
        new RegExp(`^\\d{1,2}\\s*${THAI_MONTH_ALT}\\s*(?:พ\\.?ศ\\.?\\s*)?\\d{2,4}$`, 'u'),
        new RegExp(`^\\d{1,2}\\s*${THAI_MONTH_ALT}(?:\\s|$|ของ)`, 'u'),
        /^\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?$/i,
        /\b(?:day \d{1,2}|last day|first day|end|start|beginning) of (?:this|the|next|previous|last|current)\b/i,
        /\b\d{1,2}(?:st|nd|rd|th) of (?:this|the|next|previous|last|current) month\b/i,
      ],
    },
    aliasesOf: (label) => {
      const want = normalLabel(label);
      const group = aliasIndex.get(want);
      return group === undefined ? [want] : [want, ...group.filter((l) => l !== want)];
    },
  };
}

/** The vocabulary, compiled once — what every function below reads. */
const R = compileVocabulary(VOCABULARY);

export type ValueSourceKind = 'relative-date' | 'unique-per-run' | 'test-data' | 'repo' | 'db' | 'generated' | 'master-data';

/** One `Field = value` pair of the case's Test data, with the phase header it sat under (`--Insert R1--`). */
export interface TestDataPair {
  phase: string | null;
  key: string;
  value: string;
}

/** Where a step's value came from, carried on the step into every report. */
export interface ValueSource {
  kind: ValueSourceKind;
  /** One line a reader can check: the sheet line, the passage, the query, or the format generated from. */
  detail: string;
}

export type ValueSection = 'setup' | 'steps';

export interface MasterDataExpansion {
  section: ValueSection;
  index: number;
  field: string;
  code: string;
  label: string;
  /** The declared lookup's own field list, for the log and the note. */
  fields: readonly string[];
}

export interface MasterDataContext {
  lookups: readonly MasterDataLookup[];
  /** Lazy and memoised by the caller; may answer null when no transport exists. */
  fetch: () => Promise<FetchJson | null>;
  appUrl?: string | undefined;
  testDataPairs?: readonly TestDataPair[] | undefined;
  onLog?: ((line: string) => void) | undefined;
}

/** One input step whose value is not yet a value. */
export interface ValueNeed {
  section: ValueSection;
  index: number;
  /** The field's label as the selector or intent names it (`Replaced Employee ID`). */
  field: string;
  /** The token as written, or null when the value was a description / empty. */
  token: string | null;
  /** The case wants something that does NOT exist (an invalid id to be rejected). */
  nonExisting: boolean;
  /** The format the case states for this field, when it does. */
  format: ValueFormat | null;
  /**
   * The value as written is a DATE PHRASE (`Today`, `Hire Date + 119 Day`,
   * `Age < 60`), left in place for the resolver. Only `fromRelativeDate` may
   * answer such a need; when it cannot, the step is left as authored.
   */
  phrase?: string | undefined;
  /**
   * The value as written is a key that IS the case id or a `QA-`/`SIT_` name.
   * Only `fromUniquePerRun` may rewrite it; when the case says the value must
   * already exist, the step is left as authored.
   */
  uniqueKey?: string | undefined;
  /**
   * The value as written says to leave the field EMPTY (`Blank`, `ว่าง`,
   * `null`). Resolved to the empty string from the case's own word; no other
   * source is asked.
   */
  blank?: boolean | undefined;
  /** The value as written is ONE SPACE (`เว้นวรรค`): a whitespace-only value, typed on purpose. */
  space?: boolean | undefined;
  /**
   * The token or the field names a credential (`<HR_ADMIN_ACCOUNT>`, `Login`).
   * The Test data, a document or the database may answer; a stand-in is
   * never invented — a made-up login fails for a reason no case asked about.
   */
  credential?: boolean | undefined;
  /**
   * The value as written carries the value plus a remark — a trailing note
   * (`10 ตามชุดข้อมูล`), a bound (`11 ขึ้นไป`), a parenthetical, a quoted
   * literal with a comment (`"32/13/2026" (วันที่ผิดรูปแบบ)`), or an example
   * list (`เช่น "Active", "X"`). `written` is the value with the remark
   * removed; only that cleaning may answer, never a model.
   */
  written?: string | undefined;
  /** The other case the value comes from, when the sheet cites one (`EMXXXX (จาก E2E-01)`). */
  reference?: string | undefined;
}

/** What the case says a well-formed value looks like. */
export interface ValueFormat {
  digits?: number | undefined;
  leading?: string | undefined;
  /** A literal pattern the case quotes, e.g. `N-NNNN-NNNNN-NN-N`, `EMXXXX`. */
  mask?: string | undefined;
  /** A text length the case states (`เกิน 255 ตัวอักษร`, `at most 50 characters`). */
  length?: number | undefined;
  lengthRelation?: 'over' | 'under' | 'exact' | undefined;
}

export interface ResolvedValue {
  need: ValueNeed;
  value: string;
  source: ValueSource;
}

/** The three questions the resolver may ask a model — one small structured call each. */
export interface ValueResolverModel {
  readonly id: string;
  /** Which concrete value in these passages satisfies the need? `value: null` when none does. */
  fromPassages(q: { field: string; token: string | null; caseText: string; passages: readonly string[] }): Promise<{ value: string | null; evidence: string }>;
  /** Which table/column holds such a value, and how to narrow it? `null` when the schema offers nothing. */
  chooseDbLookup(q: { field: string; token: string | null; caseText: string; schema: string }): Promise<{ table: string; column: string; where: Record<string, string> } | null>;
  /** Invent a well-formed value. */
  generate(q: { field: string; token: string | null; caseText: string; format: ValueFormat | null }): Promise<{ value: string }>;
}

export interface ValueResolutionContext {
  /** The case's own words (`describeCase`); the test-data source and the format reader work on this. */
  caseText: string;
  /** The context documents the author saw, for retrieval. Optional; the prompt text stands in. */
  documents?: readonly ExtractedDocument[] | undefined;
  /** The repository's prompt slice — routes, components, tables, declared strings. */
  projectContext?: string | undefined;
  /** The whole authoring prompt, when the documents are not available as objects. */
  promptText?: string | undefined;
  /** Read-only client, resolved lazily so a run that needs no value never connects. */
  db?: (() => Promise<DbClient | null>) | undefined;
  model: ValueResolverModel | null;
  /** Per-call budget for the retrieval passages handed to the model. */
  passageBudgetChars?: number | undefined;
  onLog?: ((line: string) => void) | undefined;
  /**
   * What "today" is, for the relative-date source. Injected so a run is
   * reproducible from its record; the stage takes the wall clock only when
   * nothing is passed.
   */
  now?: Date | undefined;
  /** The catalog run's key; its last six alphanumerics make a key value unique to this run. */
  runKey?: string | undefined;
  /** The row's own case id (`PL_06_21`) — a value equal to it is a key the sheet reused. */
  caseId?: string | undefined;
  /** The Test data already split into pairs (`testDataPairs` in `catalog/test-case-table.ts`); the case text is split here when absent. */
  testDataPairs?: readonly TestDataPair[] | undefined;
}

// --- finding what needs a value ---------------------------------------------

const INPUT_ACTIONS = new Set(['fill', 'fillRetry', 'type', 'selectOption']);

/** The field's label: the role selector's name, else the intent's first Title-Case run, else the selector. */
export function fieldLabelOf(step: FlowStep): string {
  const selector = (step as { selector?: unknown }).selector;
  if (typeof selector === 'string') {
    const m = /\[name=(?:"([^"]+)"|'([^']+)')/.exec(selector);
    if (m) return (m[1] ?? m[2] ?? '').trim();
  }
  const intent = (step as { intent?: unknown }).intent;
  if (typeof intent === 'string') {
    const body = intent.replace(/^(?:Step|Case step)\s*\d+:\s*/i, '');
    const m = /\b([A-Z][A-Za-z]+(?:(?:\s+(?:of|the|and|&|\/)\s*|\s+)[A-Z][A-Za-z]*)*)\b/.exec(body);
    if (m) return m[1]!.trim();
    // A Thai label after the sheet's own verb — `กรอก ชื่อแผน = X`, `เลือก
    // ประเภทสวัสดิการ เป็น Y`. Title-Case has nothing to find here, and a
    // Test data key spelled in Thai (BE Rule rows) never matched (CG-02).
    // `\p{M}` because Thai vowels and tone marks are combining marks, not letters.
    const th = /(?:กรอก|ระบุ|เลือก|ใส่|คีย์|กำหนด|พิมพ์)\s*(?:ช่อง|ฟิลด์|field|ค่า)?\s*([\p{L}\p{N}][\p{L}\p{M}\p{N} /().'*-]{1,40}?)\s*(?:=|:|เป็น|ด้วย|$)/u.exec(body);
    if (th) return th[1]!.trim();
  }
  return typeof selector === 'string' ? selector : 'value';
}

/**
 * The format the case states for a field: `8 หลัก` / `8 digits`, `หลักแรกเป็น 2` /
 * `starts with 2`, a quoted mask like `N-NNNN-NNNNN-NN-N` or `EMXXXX`, or a
 * length (`เกิน 255 ตัวอักษร`, `at most 50 characters`). Looked for near the
 * field's words first, then anywhere in the case.
 */
export function formatStatedFor(field: string, caseText: string): ValueFormat | null {
  const read = (text: string): ValueFormat | null => {
    const digits = R.format.digits.exec(text);
    const leading = R.format.leading.exec(text);
    const mask = /(?:^|[\s=:"'(])((?:[A-Z]{1,4}[-_]?)?[NX]{3,}(?:[-_][NX0-9]{1,6}){0,4}|[NX]{1,4}(?:-[NX]{1,6}){2,})(?=$|[\s,;)"'])/.exec(text);
    const length = R.format.length.exec(text);
    if (!digits && !leading && !mask && !length) return null;
    const before = length ? text.slice(Math.max(0, length.index - 24), length.index) : '';
    const relation = !length ? undefined : R.format.over.test(before) ? 'over' : R.format.under.test(before) ? 'under' : 'exact';
    return {
      ...(digits ? { digits: Number(digits[1]) } : {}),
      ...(leading ? { leading: leading[1] } : {}),
      ...(mask ? { mask: mask[1] } : {}),
      ...(length ? { length: Number(length[1]), lengthRelation: relation } : {}),
    };
  };
  const words = field.split(/\s+/).filter((w) => w.length > 2).map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''));
  for (const line of caseText.split('\n')) {
    if (words.some((w) => w !== '' && line.toLowerCase().includes(w.toLowerCase()))) {
      const near = read(line);
      if (near !== null) return near;
    }
  }
  // Anywhere else in the case — but never on ANOTHER key field's own `Key =
  // value` line: the Employee ID's `EMXXXX` mask is not the Reason's format.
  // A line keyed by something that is not a field (`Thailand Format = N-NNNN…`)
  // still counts.
  const elsewhere = caseText
    .split('\n')
    .filter((line) => {
      const sep = /\s*(?:=|:\s)/.exec(line);
      if (sep === null || sep.index === 0) return true;
      const key = normalLabel(line.slice(0, sep.index).replace(/^\s*(?:[-•*]|\d+[.)])\s*/, ''));
      return key === '' || key.split(' ').length > 6 || !R.keyField.test(key) || keyMatchesLabel(key, normalLabel(field));
    })
    .join('\n');
  return read(elsewhere);
}

/**
 * The example values a description offers — the quoted strings after an
 * example introducer: `ค่าอื่นที่ไม่ถูกต้อง เช่น "Active", "X"` → `["Active", "X"]`.
 * Empty when there is no introducer or nothing quoted after it.
 */
export function exampleValuesIn(text: string): string[] {
  const quoted = (span: string): string[] => {
    const out: string[] = [];
    for (const q of span.matchAll(QUOTED)) {
      const v = (q[1] ?? q[2] ?? q[3] ?? '').trim();
      if (v !== '') out.push(v);
    }
    return out;
  };
  const m = R.exampleIntroducer.exec(text);
  if (m !== null) return quoted(text.slice(m.index + m[0].length));
  // A list that is NOTHING but quoted literals — `"abc", "-30", "0", "900"`
  // — is its own example list, the sheet's boundary set for one field. The
  // block reader strips a cell's outer quotes, so the list arrives as
  // `abc", "-30", "0", "900`; re-wrapping restores the shape either way.
  const t = text.trim();
  const wrapped = t.includes('", "') && !t.startsWith('"') ? `"${t}"` : t;
  const items = quoted(wrapped);
  if (items.length >= 2 && wrapped.replace(QUOTED, '').replace(/[\s,;]/g, '') === '') return items;
  return [];
}

/**
 * A cell offering ALTERNATIVES — `Yes / No`, `Inactive / Terminated`,
 * `PL_06_25 / PL_06_25_70813`, `ว่าง/วันที่ในอดีต`, `Job Change หรือ Salary
 * Adjustment` — means any one of them; the first is typed. A slash counts
 * only with spaces around it or Thai on a side: `Employee/HR` and
 * `01/02/2021` are one value.
 */
const ALTERNATIVES = /\s+\/\s+|(?<=\p{Script=Thai})\/|\/(?=\p{Script=Thai})|\s+หรือ\s+/u;

/**
 * The value a written cell means, with its remark removed: the first quoted
 * example when the cell gives examples; else a leading quoted literal; else
 * the first of several alternatives (`Yes / No`); else
 * the text before a parenthetical, a double-space tail, a trailing note
 * (` ตามชุดข้อมูล`, ` as per …`) or a trailing bound (` ขึ้นไป`, ` or more`),
 * trailing punctuation dropped and whole-value quotes unwrapped. Returns the
 * input unchanged (trimmed) when nothing applies, so a caller can compare.
 */
export function writtenValueOf(raw: string, options: { keepParenthetical?: boolean | undefined } = {}): string {
  let text = raw.trim();
  const examples = exampleValuesIn(text);
  if (examples.length > 0) return examples[0]!;
  const leadQuote = /^(?:"([^"]*)"|“([^”]*)”)/.exec(text);
  if (leadQuote !== null) return (leadQuote[1] ?? leadQuote[2] ?? '').trim();
  text = text.split(ALTERNATIVES)[0]!.trim();
  for (let guard = 0; guard < 4; guard += 1) {
    const before = text;
    // A remark in parentheses after a space: `CDG (10000075)`, `43 (3 หน้า)`.
    // Not a bracket glued to a name (`Permanent(7-16)-(12/31/9999)`), not one
    // of several in a list (`CDS (C001), B2S (C006)`), and an option's label
    // may BE `CDS (C001)`, so a selectOption keeps its parenthetical.
    if (options.keepParenthetical !== true && (text.match(/\(/g) ?? []).length === 1) text = text.replace(/\s+\([^()]*\)\s*$/, '').trim();
    text = text.split(/\s{2,}/)[0]!.trim();
    text = text.split(R.noteStart)[0]!.trim();
    text = text.replace(R.boundTail, '').trim();
    text = text.replace(/[,;]+$/, '').trim();
    if (text === before) break;
  }
  const whole = /^(?:"([^"]*)"|“([^”]*)”)$/.exec(text);
  if (whole !== null) text = (whole[1] ?? whole[2] ?? '').trim();
  return text;
}

/**
 * A value that names its OWN field and goes on in prose — `Replaced Employee
 * ID = Employee ID ที่ลาออกแล้วและเคยครอง Position 40001378`, `National ID =
 * National ID เดียวกับพนักงานเดิม`, `Contract End Date = Contract End Date
 * จริง` — describes the value instead of giving it. The label (or a two-word
 * tail of it) must appear whole, and what remains must be words, not a code:
 * `Country = Mock Country (TH)` and `Enrollment = Manual Enrollment` are
 * option labels and stay.
 */
export function describesOwnField(field: string, value: string): boolean {
  const label = normalLabel(field);
  const v = normalLabel(value);
  if (label === '' || v === '' || v === label) return false;
  const words = label.split(' ');
  const tails = words.map((_, i) => words.slice(i).join(' ')).filter((_, i) => i === 0 || words.length - i >= 2);
  for (const tail of tails) {
    const at = v.indexOf(tail);
    if (at < 0) continue;
    const before = v[at - 1];
    const after = v[at + tail.length];
    if ((before !== undefined && /[\p{L}\p{N}]/u.test(before)) || (after !== undefined && /[A-Za-z0-9]/.test(after))) continue;
    const rest = `${v.slice(0, at)} ${v.slice(at + tail.length)}`;
    if (/\p{Script=Thai}/u.test(rest)) return true;
  }
  return false;
}

/**
 * A cleaned value that DESCRIBES the value instead of giving it: "an existing
 * …", "ค่าอื่นที่ไม่ถูกต้อง", a text described only by its length ("ข้อความความยาว
 * เกิน 255 ตัวอักษร"), an instruction ("เลือกแขวงที่อยู่ใน District ที่เลือก",
 * "ตาม Sub-District ที่เลือก"), or a value naming its own field. One predicate,
 * so the need finder and the Test data reader cannot disagree about it.
 */
export function isDescription(field: string, cleaned: string): boolean {
  return R.describedValue.test(cleaned) || R.format.length.test(cleaned) || R.describedHead.test(cleaned) || describesOwnField(field, cleaned);
}

/** The case another value comes from — `(จาก E2E-01)` — when the cell cites one. */
function referenceIn(raw: string): string | null {
  const paren = /\(([^()]*)\)\s*$/.exec(raw.trim());
  const m = CASE_REFERENCE.exec(paren?.[1] ?? '');
  return m === null ? null : m[1]!;
}

/** What `findUnresolvedValues` needs beyond the steps to see the two concrete-value needs. */
export interface NeedOptions {
  /** The row's case id: a typed value equal to it (any `-`/`_` spelling, or with the sheet's `_R1` tail) is a reused key. */
  caseId?: string | undefined;
  /** The Test data pairs, so a value that IS another date field's label (`Probationary Period End Date = Hire Date`) is seen as a date. */
  pairs?: readonly TestDataPair[] | undefined;
}

/** `PL_06_21`, `PL-06-21`, `pl_06_21_R3` → `PL_06_21` — the sheet's own spellings of one case id. */
function keySpelling(value: string): string {
  return value.trim().toUpperCase().replace(/[-_\s]+/g, '_');
}

/**
 * A typed value that IS the case id (`Benefit Plan ID = PL_06_21`, the sheet's
 * `PL_06_21_R3` rerun spelling) or a QA-owned name (`QA-Insert`, `SIT_CNS_01`),
 * on a field the app keeps unique. Only such a value is made unique per run —
 * a value the tester chose for its meaning (`TH_MED_001`) is left alone.
 */
export function isReusedKeyValue(value: string, field: string, caseId: string | undefined): boolean {
  const text = value.trim();
  if (text === '' || text.length > 80 || PLACEHOLDER_TOKEN.test(text)) return false;
  if (!R.keyField.test(field)) return false;
  if (R.qaKey.test(text)) return true;
  if (caseId === undefined || caseId.trim() === '') return false;
  const want = keySpelling(caseId);
  const have = keySpelling(text);
  return have === want || new RegExp(`^${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_R\\d{1,2}$`).test(have);
}

/**
 * Every input step whose value is a token, a mask, a description in place of
 * a value (a described value, an instruction, a value naming its own field),
 * a date phrase (or another date field's label), a reused key, a blank or a
 * space word, or a value written with a remark or alternatives.
 */
export function findUnresolvedValues(
  setup: readonly FlowStep[],
  steps: readonly FlowStep[],
  caseText: string,
  options: NeedOptions = {},
): ValueNeed[] {
  const needs: ValueNeed[] = [];
  let pairs: readonly TestDataPair[] | null = options.pairs ?? null;
  const pairsOf = (): readonly TestDataPair[] => (pairs ??= testDataPairsOf(caseText));
  const scan = (section: ValueSection, list: readonly FlowStep[]): void => {
    for (const [index, step] of list.entries()) {
      if (!INPUT_ACTIONS.has(step.action)) continue;
      const value = (step as { value?: unknown }).value;
      const intent = (step as { intent?: unknown }).intent;
      const text = typeof value === 'string' ? value : '';
      // A value that IS an open question (`? OQ-HIR-13`, `TBD`) is nobody's
      // to resolve; one that merely CITES a question beside a concrete value
      // (`30009285 (คีย์ที่ช่อง Organization ดู OQ-HIR-138)`) is a value.
      if (unconfirmedValue(text)) continue;
      const field = fieldLabelOf(step);
      const cleaned = writtenValueOf(text, { keepParenthetical: step.action === 'selectOption' });
      if (OPEN_QUESTION.test(cleaned)) continue;
      // A mask (`EMXXXX`, `BE-XXX-999`) stands for a value made elsewhere,
      // the same need a token is; the format it states travels with it.
      const mask = MASK_VALUE.test(cleaned) ? cleaned : null;
      const token = PLACEHOLDER_TOKEN.exec(text)?.[0] ?? mask;
      // A date phrase left as written (`Today`, `Hire Date + 119 Day`) is a
      // need of its own kind: computed, never looked up. A selectOption's
      // value is an option label, which may legitimately read "Next day".
      // A value that IS another date field's label is a phrase too.
      const phrase =
        token === null && step.action !== 'selectOption' && (isDatePhrase(cleaned, field) || labelOfDatePair(cleaned, pairsOf()) !== null)
          ? cleaned
          : null;
      const uniqueKey = token === null && phrase === null && isReusedKeyValue(text, field, options.caseId) ? text.trim() : null;
      // A blank word as the value (`Blank`, `ว่าง`) or as the remark beside a
      // placeholder (`Select Date (ไม่ระบุ)`): the field is left empty.
      const remark = /\(([^()]*)\)\s*$/.exec(text.trim())?.[1]?.trim() ?? '';
      const blank = token === null && phrase === null && uniqueKey === null && text.trim() !== '' && (R.blankValue.test(text.trim()) || (remark !== '' && R.blankValue.test(remark)));
      const space = token === null && phrase === null && uniqueKey === null && !blank && R.spaceValue.test(text.trim());
      // A description in place of a value — "an existing …", "ค่าอื่นที่ไม่ถูกต้อง",
      // a text described only by its length ("ข้อความความยาวเกิน 255 ตัวอักษร"),
      // an instruction ("เลือกแขวงที่อยู่ใน District ที่เลือก"), or a value that
      // names its own field and goes on in prose. Judged on the cleaned value,
      // so a remark beside a concrete value cannot make it a description.
      const described =
        token === null &&
        phrase === null &&
        uniqueKey === null &&
        !blank &&
        !space &&
        (text === '' || isDescription(field, cleaned));
      // A remark beside the value (`10 ตามชุดข้อมูล`, `"N" (comment)`) or a
      // list of alternatives is cleaned off; the value itself is what the sheet wrote.
      const written = token === null && phrase === null && uniqueKey === null && !blank && !space && !described && cleaned !== '' && cleaned !== text.trim() ? cleaned : null;
      if (token === null && phrase === null && uniqueKey === null && !blank && !space && !described && written === null) continue;
      // An empty value is only a need when something SAYS a value belongs here.
      if (token === null && phrase === null && uniqueKey === null && !blank && !space && written === null && text === '' && !(typeof intent === 'string' && R.describedValue.test(intent))) continue;
      const around = `${token ?? ''} ${text} ${typeof intent === 'string' ? intent : ''}`;
      const credential = (token !== null || described) && R.credential.test(`${token ?? ''} ${field}`);
      const reference = referenceIn(text);
      // The cell's own words state the format first (`ใช้แทน National ID 13 หลัก`), then the case.
      const stated = formatStatedFor(field, `${text}\n${caseText}`);
      const format = mask === null ? stated : { ...(stated ?? {}), mask };
      needs.push({
        section,
        index,
        field,
        token,
        nonExisting: R.nonExisting.test(around),
        format,
        ...(phrase === null ? {} : { phrase }),
        ...(uniqueKey === null ? {} : { uniqueKey }),
        ...(blank ? { blank: true } : {}),
        ...(space ? { space: true } : {}),
        ...(credential ? { credential: true } : {}),
        ...(written === null ? {} : { written }),
        ...(reference === null ? {} : { reference }),
      });
    }
  };
  scan('setup', setup);
  scan('steps', steps);
  return needs;
}

/**
 * The Test data pair whose KEY the value names, when that pair holds a date
 * (`Probationary Period End Date = Hire Date`, with `Hire Date = Today`
 * elsewhere in the block). Aliases count. Null otherwise.
 */
export function labelOfDatePair(value: string, pairs: readonly TestDataPair[]): TestDataPair | null {
  const want = normalLabel(value);
  if (want === '' || want.length > 60 || /\d/.test(want)) return null;
  const names = R.aliasesOf(want);
  for (const pair of pairs) {
    const key = normalLabel(pair.key);
    if (!names.includes(key)) continue;
    const rhs = pair.value.trim();
    if (rhs === '' || normalLabel(rhs) === want) continue;
    if (ISO_DATE_VALUE.test(rhs) || absoluteDateOf(rhs) !== null || isDatePhrase(writtenValueOf(rhs), pair.key)) return pair;
  }
  return null;
}

/** The case's lines that mention the field. */
function linesAbout(field: string, caseText: string): string {
  const words = field.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  return caseText
    .split('\n')
    .filter((line) => words.some((w) => line.toLowerCase().includes(w)))
    .join('\n');
}

// --- the sources ----------------------------------------------------------------

/** `--Create--`, `-- Insert R1 --`: the BE sheet's phase headers inside one Test data cell. */
const PHASE_HEADER = /^-{2,}\s*(.+?)\s*-{2,}$/;
/**
 * Where a packed line breaks into its next pair: `Position = 40106337 Job Code
 * = MKB12.12` (278 rows pack several pairs on one line). A key is up to six
 * Title-Case words (or a bracketed `[OPERATOR]`) followed by `=`; a value's
 * own `+ 1 Day` never looks like one. Found LEFTMOST after each value starts
 * — a `split` on the same lookahead breaks `Job Code` at `Code` too.
 */
const PACKED_PAIR_BREAK = /\s+(?=(?:[A-Z[][A-Za-z0-9\]/().'*-]*)(?:\s+[A-Z(][A-Za-z0-9)/().'*-]*){0,5}\s*=\s)/;

/** `Position = 40106337 Job Code = MKB12.12` → two pieces, each with one `=`. */
function splitPacked(part: string): string[] {
  const out: string[] = [];
  let rest = part;
  for (let guard = 0; guard < 40; guard += 1) {
    const eq = rest.indexOf('=');
    if (eq <= 0) break;
    const after = rest.slice(eq + 1);
    const brk = PACKED_PAIR_BREAK.exec(after);
    if (brk === null || brk.index === 0) break;
    out.push(rest.slice(0, eq + 1 + brk.index));
    rest = after.slice(brk.index + brk[0].length);
  }
  out.push(rest);
  return out;
}
/** `ดราฟต์เดิมระบุ X ใช้ Y` — the sheet correcting its own earlier draft; Y is the value. */
const DRAFT_CORRECTION = /ดราฟต์เดิมระบุ\s*(.+?)\s*ใช้\s*(\S+)/gu;

/**
 * The case's `Field = value` pairs, one per entry, as the parser
 * (`testDataPairs` in `catalog/test-case-table.ts`) will hand them — and, until
 * it does, split out of the case text here: `describeCase` folds the Test data
 * block onto one line with `; `, a sheet line packs several pairs, a phase
 * header sits between blocks, and a draft correction renames a value.
 */
export function testDataPairsOf(caseText: string): TestDataPair[] {
  const corrections: [string, string][] = [];
  for (const m of caseText.matchAll(DRAFT_CORRECTION)) corrections.push([m[1]!.trim(), m[2]!.trim()]);
  const pairs: TestDataPair[] = [];
  let phase: string | null = null;
  // A bullet is one dash; two or more open a phase header and stay.
  const unbullet = (text: string): string => text.replace(/^(?:[•*]|-(?!-))\s*/, '');
  for (const raw of caseText.split('\n')) {
    const line = unbullet(raw.trim()).replace(/^Test data:\s*/i, '');
    if (line === '') continue;
    for (const segment of line.split(/;\s+/)) {
      const part = unbullet(segment.trim());
      const header = PHASE_HEADER.exec(part);
      if (header) {
        phase = header[1]!.trim();
        continue;
      }
      for (const piece of splitPacked(part)) {
        const eq = piece.indexOf('=');
        if (eq <= 0) continue;
        const key = piece.slice(0, eq).trim();
        let value = piece.slice(eq + 1).trim();
        if (key === '') continue;
        for (const [was, now] of corrections) if (value === was || value.startsWith(`${was} `)) value = now;
        pairs.push({ phase, key, value });
      }
    }
  }
  return pairs;
}

/** The pair naming this field — first in sheet order — when its value is concrete (or says "blank"). */
function pairFor(need: ValueNeed, pairs: readonly TestDataPair[]): TestDataPair | null {
  const label = normalLabel(need.field);
  for (const pair of pairs) {
    if (!keyMatchesLabel(normalLabel(pair.key), label)) continue;
    // A non-existing need must not take the VALID id's line and vice versa;
    // the line says which it is on its key (`Invalid Replaced Employee ID`)
    // or its value (`ค่าอื่นที่ไม่ถูกต้อง เช่น "Active"`).
    if (R.nonExisting.test(`${pair.key} ${pair.value}`) !== need.nonExisting) continue;
    const rhs = pair.value;
    if (rhs === '') continue;
    if (R.blankValue.test(rhs.trim())) return pair;
    // The remark beside a value is not the value: `20000248 (ดู OQ-HIR-138)`
    // is a concrete id with a pointer to an open question, not an open one.
    const cleaned = writtenValueOf(rhs);
    // An unconfirmed value (`= ? รอตาราง…`, an OQ- id, TBD, an instruction)
    // is not a value: the field stays unresolved and its step is skipped. A
    // description with its own examples (`เช่น "Active"`) is one.
    if (cleaned === '' || PLACEHOLDER_TOKEN.test(cleaned) || OPEN_QUESTION.test(cleaned) || unconfirmedValue(cleaned)) continue;
    if (isDescription(need.field, cleaned) && exampleValuesIn(rhs).length === 0) continue;
    return pair;
  }
  return null;
}

/**
 * The unconfirmed Test data pair a field's label names EXACTLY, or null. Used
 * by the author's `usesUnconfirmedValue` lint: a fill into "DVT: Course of
 * Time" while the sheet says `Course of Time = ? ยังไม่ยืนยันหน่วย/รูปแบบ` is
 * a value the model invented for a field nobody has a value for. Exact after
 * normalising (a `Prefix: ` on the label stripped, `*` and parentheticals
 * dropped) — never the resolver's looser suffix match, because an unconfirmed
 * key such as `Type` would otherwise claim every "Contract Type" and
 * "Employee Type" on the form.
 */
export function unconfirmedFieldIn(field: string, pairs: readonly TestDataPair[]): TestDataPair | null {
  const label = normalLabel(field);
  const unprefixed = label.replace(/^[^:]{1,30}:\s*/, '');
  for (const pair of pairs) {
    if (!unconfirmedValue(pair.value)) continue;
    const key = normalLabel(pair.key);
    if (key === label || key === unprefixed) return pair;
  }
  return null;
}

/** `Field = value` on a line of the case, when the value is concrete — the remark beside it removed. */
export function fromTestData(need: ValueNeed, caseText: string, pairs?: readonly TestDataPair[]): ResolvedValue | null {
  const pair = pairFor(need, pairs ?? testDataPairsOf(caseText));
  if (pair === null) return null;
  const stated = `${pair.phase === null ? '' : `[${pair.phase}] `}${pair.key} = ${pair.value}`;
  if (R.blankValue.test(pair.value.trim())) {
    return { need, value: '', source: { kind: 'test-data', detail: `the case says to leave it blank: "${stated.slice(0, 100)}"` } };
  }
  const value = writtenValueOf(pair.value);
  if (value === '') return null;
  return { need, value, source: { kind: 'test-data', detail: `the case states "${stated.slice(0, 100)}"` } };
}

// --- relative dates -----------------------------------------------------------------

/**
 * A year-month-day with no clock and no zone: the sheet's "today" is the
 * tester's calendar day, and the machine the run is on is that tester's.
 */
interface Ymd {
  y: number;
  m: number;
  d: number;
}

const ymdOf = (now: Date): Ymd => ({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() });
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
function addDays(date: Ymd, n: number): Ymd {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
/** Month arithmetic keeps the day and clamps it to the month's end: 31 Jan + 1 month = 28/29 Feb. */
function addMonths(date: Ymd, n: number): Ymd {
  const total = date.y * 12 + (date.m - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return { y, m, d: Math.min(date.d, daysInMonth(y, m)) };
}
const isoOf = (date: Ymd): string => `${String(date.y).padStart(4, '0')}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
const ISO_DATE_VALUE = /^(\d{4})-(\d{2})-(\d{2})$/;

const EN_MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
/** Full and abbreviated Thai month names, as the sheet writes them (`25 ธ.ค. 2569`, `25 ธันวาคม 2569`). */
const TH_MONTHS: [RegExp, number][] = [
  [/^ม\.?ค\.?$|^มกราคม$/u, 1],
  [/^ก\.?พ\.?$|^กุมภาพันธ์$/u, 2],
  [/^มี\.?ค\.?$|^มีนาคม$/u, 3],
  [/^เม\.?ย\.?$|^เมษายน$/u, 4],
  [/^พ\.?ค\.?$|^พฤษภาคม$/u, 5],
  [/^มิ\.?ย\.?$|^มิถุนายน$/u, 6],
  [/^ก\.?ค\.?$|^กรกฎาคม$/u, 7],
  [/^ส\.?ค\.?$|^สิงหาคม$/u, 8],
  [/^ก\.?ย\.?$|^กันยายน$/u, 9],
  [/^ต\.?ค\.?$|^ตุลาคม$/u, 10],
  [/^พ\.?ย\.?$|^พฤศจิกายน$/u, 11],
  [/^ธ\.?ค\.?$|^ธันวาคม$/u, 12],
];

/** A Buddhist-era year (2569 = 2026) is any year the sheet could mean that way: 2400–2700, or two digits ≥ 40. */
function gregorianYear(raw: string, thai: boolean): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (raw.length === 2) return thai ? (n >= 40 ? 2500 + n - 543 : 2000 + n) : 2000 + n;
  if (n >= 2400 && n <= 2700) return n - 543;
  return n;
}

/**
 * A date written out — `31 Dec 9999`, `31-Dec-9999`, `Dec 31, 9999`,
 * `25 ธันวาคม 2569`, `25 ธ.ค. 69`, `2026-09-03`, and, when `now` is given, a
 * day and month with no year (`13 เมษายน`, `13 April`) in the current year —
 * as Y-M-D, or null when it is not unambiguously one. `01/09/2027` is left
 * alone on purpose: whether that is January or September depends on who wrote
 * it (the engine's own rule, `isoDateOf`), with the single exception of the
 * sheet's `31/12/9999` sentinel, which reads the same either way round.
 */
export function absoluteDateOf(text: string, now?: Ymd): Ymd | null {
  const t = text.trim();
  const iso = ISO_DATE_VALUE.exec(t);
  if (iso) return { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
  if (/^(?:31\/12\/9999|12\/31\/9999|9999-12-31)$/.test(t)) return { y: 9999, m: 12, d: 31 };
  const dmy = /^(\d{1,2})[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+(\d{4})$/.exec(t);
  const mdy = /^([A-Za-z]{3,9})\.?[\s-]+(\d{1,2}),?[\s-]+(\d{4})$/.exec(t);
  const dm = now === undefined ? null : /^(\d{1,2})[\s-]+([A-Za-z]{3,9})\.?$/.exec(t);
  const en = dmy
    ? { d: dmy[1]!, mon: dmy[2]!, y: dmy[3]! }
    : mdy
      ? { d: mdy[2]!, mon: mdy[1]!, y: mdy[3]! }
      : dm
        ? { d: dm[1]!, mon: dm[2]!, y: String(now!.y) }
        : null;
  if (en) {
    const m = EN_MONTHS[en.mon.slice(0, 4).toLowerCase()] ?? EN_MONTHS[en.mon.slice(0, 3).toLowerCase()];
    const y = gregorianYear(en.y, false);
    if (m === undefined || y === null) return null;
    const d = Number(en.d);
    return d >= 1 && d <= daysInMonth(y, m) ? { y, m, d } : null;
  }
  const th = /^(\d{1,2})\s*([\p{Script=Thai}.]{2,12})\s*(?:พ\.?ศ\.?\s*)?(\d{2}|\d{4})$/u.exec(t);
  const thNoYear = now === undefined ? null : /^(\d{1,2})\s*([\p{Script=Thai}.]{2,12})$/u.exec(t);
  const thai = th ? { d: th[1]!, mon: th[2]!, y: th[3]! } : thNoYear ? { d: thNoYear[1]!, mon: thNoYear[2]!, y: String(now!.y) } : null;
  if (thai) {
    const m = TH_MONTHS.find(([re]) => re.test(thai.mon))?.[1];
    const y = gregorianYear(thai.y, true);
    if (m === undefined || y === null) return null;
    const d = Number(thai.d);
    return d >= 1 && d <= daysInMonth(y, m) ? { y, m, d } : null;
  }
  return null;
}

/**
 * True when a typed value is a date phrase the resolver computes, not a value
 * to type as written. The shapes come from the rules' date vocabulary; a
 * leading filler (`ทำให้`) and an anchor clause (`ณ Hire Date`) are set aside
 * first, and neither is a shape on its own. The bare `N ปี M เดือน` form is an
 * age only on a birth-date field — on a claim period it is the duration it
 * says.
 */
export function isDatePhrase(text: string, field?: string): boolean {
  let t = text.trim();
  if (t === '' || t.length > 80 || ISO_DATE_VALUE.test(t)) return false;
  t = t.replace(R.date.prefix, '').replace(R.date.atClause, ' ').trim();
  if (t === '') return false;
  if (R.date.phraseShapes.some((re) => re.test(t))) return true;
  return field !== undefined && R.date.birthField.test(field) && new RegExp(`^\\d{1,3}\\s*${R.date.unitAlt.year}(?:\\s*\\d{1,2}\\s*${R.date.unitAlt.month})?$`, 'iu').test(t);
}

/** What the resolver knows when it computes a phrase: today, and the fields already resolved by label. */
export interface DateEnvironment {
  now: Date;
  /** An earlier field's ISO date by its label (`hire date`), or null. */
  lookup: (label: string) => string | null;
}

export interface ResolvedDate {
  iso: string;
  /** One line a reader can check: `Hire Date + 119 Day = 2026-12-31 (Hire Date = 2026-09-03)`. */
  detail: string;
}

type MonthWord = 'this' | 'next' | 'previous';
function monthWordOf(text: string | undefined): MonthWord {
  if (text === undefined) return 'this';
  const w = text.trim();
  if (R.date.previousMonth.test(w)) return 'previous';
  if (R.date.nextMonth.test(w)) return 'next';
  return 'this';
}
const monthOffset = (word: MonthWord): number => (word === 'next' ? 1 : word === 'previous' ? -1 : 0);

function applyOffset(date: Ymd, sign: number, n: number, unit: string): Ymd {
  const kind = R.date.unitKindOf(unit);
  if (kind === 'month') return addMonths(date, sign * n);
  if (kind === 'year') return addMonths(date, sign * n * 12);
  if (kind === 'week') return addDays(date, sign * n * 7);
  return addDays(date, sign * n);
}

/**
 * `Age < 60`, `อายุน้อยกว่า 60 ปี`, `อายุ 60 ปีขึ้นไป`, `อายุพอดี 60 ปีเป๊ะ`,
 * `35 ปี 6 เดือน`, `อายุ เท่ากับ 59 ปี 11 เดือน` — a DATE OF BIRTH such that the
 * age holds at the anchor: the clause the phrase names (`ณ Hire Date`, passed
 * in), else the first anchor field the rules name that this case set (Hire
 * Date, by any alias), else today. Strict bounds land half a year inside
 * (`< 60` → 59 y 6 m): the sheet's `Age < 60` rows (82 of them) are about the
 * under-60 branch of the SSO rule, not its boundary, and the boundary rows say
 * `พอดี`/`เป๊ะ`/`=` and get the exact day.
 */
function ageDateOf(phrase: string, env: DateEnvironment, anchorClause: string | null, written = phrase): ResolvedDate | null {
  const text = phrase.trim();
  const m = new RegExp(
    `^(?:${R.date.ageWord})?\\s*(${R.date.ageOp})?\\s*(\\d{1,3})\\s*(?:${R.date.unitAlt.year})?\\s*(?:(\\d{1,2})\\s*(?:${R.date.unitAlt.month}))?\\s*(${R.date.ageTail})?\\s*$`,
    'iu',
  ).exec(text);
  if (!m) return null;
  const saysAge = new RegExp(`^${R.date.ageWord}`, 'iu').test(text);
  if (!saysAge && m[3] === undefined) return null;
  const years = Number(m[2]);
  const months = m[3] === undefined ? null : Number(m[3]);
  const op = `${m[1] ?? ''} ${m[4] ?? ''}`.trim();
  let anchorLabel: string | null = null;
  let anchorIso: string | null = null;
  if (anchorClause !== null) {
    anchorIso = env.lookup(anchorClause);
    if (anchorIso !== null) anchorLabel = anchorClause;
    else if (R.date.today.test(anchorClause)) anchorLabel = null;
    else return null;
  } else {
    anchorLabel = R.date.ageAnchorFields.find((l) => env.lookup(l) !== null) ?? null;
    anchorIso = anchorLabel === null ? null : env.lookup(anchorLabel);
  }
  const anchor = anchorIso === null ? ymdOf(env.now) : (absoluteDateOf(anchorIso) ?? ymdOf(env.now));
  let relation: 'under' | 'exact' | 'over' = 'exact';
  if (months === null) {
    if (R.date.ageUnder.test(op)) relation = 'under';
    else if (R.date.ageOver.test(op)) relation = 'over';
  }
  const back = years * 12 + (months ?? 0) + (relation === 'under' ? -6 : relation === 'over' ? 6 : 0);
  const dob = addMonths(anchor, -back);
  const shown = relation === 'under' ? `${years - 1} y 6 m` : relation === 'over' ? `${years} y 6 m` : months === null ? `${years} y` : `${years} y ${months} m`;
  const at = anchorIso === null ? `today ${isoOf(anchor)}` : `${anchorLabel} ${anchorIso}`;
  return { iso: isoOf(dob), detail: `${written.trim()} = ${isoOf(dob)} (age ${shown} at ${at})` };
}

/**
 * The phrase as a date. Grammar, all deterministic: a BASE — today / next day
 * / yesterday / a future or past date, `31 Dec 9999`, a written date (Thai
 * months and Buddhist years included, a day-month with no year in the current
 * year), `วันที่ N ของเดือน(ปัจจุบัน|ถัดไป)`, `วันสุดท้ายของเดือนถัดไป`, `01/01
 * ของปีก่อนหน้า`, `1 มกราคมของปีก่อนหน้า`, `ย้อนหลังจากวันที่ทดสอบ 5`, or an
 * earlier field by label (`Hire Date`, any alias) — optionally under a
 * RELATION (`< Current Date`, `ก่อน Hire Date`, `the day after …`: one day
 * either side) — then any number of OFFSETS: `+ 119 Day`, `- 1 Day`, `+ 1
 * Year`, `ย้อนหลัง 3 วัน`, `Next day + 1`. An age expression is its own shape,
 * with an optional anchor clause (`ณ Hire Date`). A trailing remark
 * (`(หรือมากกว่า…)`, `ให้มาก่อน …`) is set aside first. Null when a word is not
 * understood, so nothing half-computed is ever typed. Every word comes from
 * the rules' date vocabulary.
 */
export function resolveDatePhrase(phrase: string, env: DateEnvironment, depth = 0): ResolvedDate | null {
  let text = writtenValueOf(phrase).replace(R.date.prefix, '').trim();
  if (text === '' || depth > 3) return null;
  let anchorClause: string | null = null;
  const at = R.date.atClause.exec(text);
  if (at !== null) {
    anchorClause = at[1]!.trim();
    text = `${text.slice(0, at.index)} ${text.slice(at.index + at[0].length)}`.replace(/\s+/g, ' ').trim();
  }
  text = text.replace(R.date.exactTail, '').trim();
  if (text === '') return null;
  const age = ageDateOf(text, env, anchorClause, phrase);
  if (age !== null) return age;

  const today = ymdOf(env.now);
  const notes: string[] = [];
  let base: Ymd | null = null;
  let fromToday = true;
  // Whether the last piece taken ended at whitespace — a remark may follow a
  // date only across a gap (`14 เมษายน รันคู่กับ …`), never glued to it
  // (`สิ้นเดือนแบบถอยหลัง` is one expression nobody here understands).
  let gap = false;
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(text);
    if (m) {
      const rest = text.slice(m[0].length);
      gap = /\s$/.test(m[0]) || /^\s/.test(rest) || rest === '';
      text = rest.trim();
    }
    return m;
  };
  const MW = R.date.monthWord;
  const unitRe = R.date.unitAlt.any;
  const backRe = alternation(VOCABULARY.dates.back);
  const forwardRe = alternation(VOCABULARY.dates.forward);

  // --- relation: one day before or after the base
  let relation = 0;
  if (take(R.date.before)) relation = -1;
  else if (take(R.date.after)) relation = 1;

  // --- base
  let m: RegExpExecArray | null;
  if (take(R.date.today)) base = today;
  else if (take(R.date.tomorrow)) base = addDays(today, 1);
  else if (take(R.date.yesterday)) base = addDays(today, -1);
  else if (take(R.date.future)) {
    base = addDays(today, 1);
    notes.push('a future date: tomorrow');
  } else if (take(R.date.past)) {
    base = addDays(today, -1);
    notes.push('a past date: yesterday');
  } else if ((m = take(new RegExp(`^วันที่\\s*(\\d{1,2})(?:\\s*ของเดือน\\s*${MW}?)?(?=\\s|$)`, 'iu')))) {
    // `วันที่ 25 ของเดือนปัจจุบัน`; a bare `วันที่ 20` is that day of this month.
    base = dayOfMonth(today, Number(m[1]), monthWordOf(m[2]));
    if (base === null) return null;
  } else if ((m = take(new RegExp(`^day\\s+(\\d{1,2})\\s+of\\s+(?:the\\s+)?${MW}\\s+month`, 'iu')))) {
    base = dayOfMonth(today, Number(m[1]), monthWordOf(m[2]));
    if (base === null) return null;
  } else if ((m = take(new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)\\s+of\\s+(?:the\\s+)?${MW}\\s+month`, 'iu')))) {
    base = dayOfMonth(today, Number(m[1]), monthWordOf(m[2]));
    if (base === null) return null;
  } else if ((m = take(new RegExp(`^(?:วันสุดท้ายของเดือน|สิ้นเดือน)\\s*${MW}?`, 'iu')))) {
    const month = addMonths({ ...today, d: 1 }, monthOffset(monthWordOf(m[1])));
    base = { ...month, d: daysInMonth(month.y, month.m) };
  } else if ((m = take(new RegExp(`^(?:(?:last day|end)\\s+of\\s+(?:the\\s+)?${MW}\\s+month|month\\s+end)`, 'iu')))) {
    const month = addMonths({ ...today, d: 1 }, monthOffset(monthWordOf(m[1])));
    base = { ...month, d: daysInMonth(month.y, month.m) };
  } else if ((m = take(new RegExp(`^(?:วันแรกของเดือน|ต้นเดือน)\\s*${MW}?`, 'iu')))) {
    base = addMonths({ ...today, d: 1 }, monthOffset(monthWordOf(m[1])));
  } else if ((m = take(new RegExp(`^(?:first day|start|beginning)\\s+of\\s+(?:the\\s+)?${MW}\\s+month`, 'iu')))) {
    base = addMonths({ ...today, d: 1 }, monthOffset(monthWordOf(m[1])));
  } else if ((m = take(new RegExp(`^(\\d{1,2})\\/(\\d{1,2})\\s*ของปี\\s*${MW}`, 'iu')))) {
    // `01/01 ของปีก่อนหน้า` — day/month, the Thai reading.
    base = dayMonthOfYear(today.y + monthOffset(monthWordOf(m[3])), Number(m[2]), Number(m[1]));
    if (base === null) return null;
  } else if ((m = take(new RegExp(`^(\\d{1,2})\\s*([\\p{Script=Thai}.]{2,12}?)\\s*(?:ของ)?ปี\\s*${MW}`, 'iu')))) {
    // `1 มกราคมของปีก่อนหน้า`.
    const mm = TH_MONTHS.find(([re]) => re.test(m![2]!))?.[1];
    base = mm === undefined ? null : dayMonthOfYear(today.y + monthOffset(monthWordOf(m[3])), mm, Number(m[1]));
    if (base === null) return null;
  } else if ((m = take(new RegExp(`^(\\d{1,2})\\s+([A-Za-z]{3,9})\\.?\\s+of\\s+(?:the\\s+)?${MW}\\s+year`, 'iu')))) {
    const mm = EN_MONTHS[m[2]!.slice(0, 4).toLowerCase()] ?? EN_MONTHS[m[2]!.slice(0, 3).toLowerCase()];
    base = mm === undefined ? null : dayMonthOfYear(today.y + monthOffset(monthWordOf(m[3])), mm, Number(m[1]));
    if (base === null) return null;
  } else if ((m = peekAbsolute(text, today)) !== null) {
    // A written date; `3 วันก่อน` and `3 days ago` look like one and are not,
    // so the shape is only taken when it reads as a real date.
    gap = /^\s/.test(text.slice(m[0].length)) || text.length === m[0].length;
    text = text.slice(m[0].length).trim();
    base = absoluteDateOf(m[0], today);
    fromToday = false;
  } else if ((m = take(new RegExp(`^(${backRe}|${forwardRe})(?:\\s*(?:จาก|from)\\s*|\\s*)(?:${alternation(VOCABULARY.dates.today)}\\s*)?(\\d+)\\s*(?:${unitRe})?`, 'iu')))) {
    // `ย้อนหลัง 3 วัน`, `ย้อนหลังจากวันที่ทดสอบ 5`, `in 3 days`: from today.
    const back = new RegExp(`^${backRe}`, 'iu').test(m[1]!);
    const unit = /\S+$/.exec(m[0].slice(m[0].indexOf(m[2]!) + m[2]!.length))?.[0] ?? '';
    base = applyOffset(today, back ? -1 : 1, Number(m[2]), unit);
  } else if ((m = take(new RegExp(`^(\\d+)\\s*(${unitRe})\\s*(?:${backRe})`, 'iu')))) {
    // `3 วันก่อน`, `3 days ago`.
    base = applyOffset(today, -1, Number(m[1]), m[2]!);
  } else if ((m = take(new RegExp(`^([\\p{L}][\\p{L}\\p{M}\\p{N} /().'*-]{1,40}?)(?=\\s*(?:[+\\-−]\\s*\\d|${backRe}|${forwardRe}|$)${relation === 0 ? '' : `|\\s+\\d+\\s*(?:${unitRe})(?=\\s|$)`})`, 'iu')))) {
    // An earlier field by label: `Hire Date + 119 Day`, `วันที่จ้าง`.
    const label = m[1]!.trim();
    const iso = env.lookup(label);
    if (iso === null) return null;
    base = absoluteDateOf(iso);
    if (base === null) return null;
    notes.push(`${label} = ${iso}`);
    fromToday = false;
  }
  if (base === null) return null;

  // --- offsets, any number, in order
  let date = base;
  let o: RegExpExecArray | null;
  if (relation !== 0 && (o = take(new RegExp(`^(\\d+)\\s*(${unitRe})(?=\\s|$)`, 'iu')))) {
    // `วันที่ก่อน Hire Date 1 ปี`, `2 weeks after Today`: the relation names
    // the direction and the amount follows the base.
    date = applyOffset(base, relation, Number(o[1]), o[2]!);
    notes.push(`${relation < 0 ? 'minus' : 'plus'} ${o[1]} ${o[2]}`);
  } else if (relation !== 0) {
    date = addDays(base, relation);
    notes.push(relation < 0 ? 'the day before' : 'the day after');
  }
  let guard = 0;
  while (text !== '' && guard++ < 8) {
    if ((o = take(new RegExp(`^([+\\-−])\\s*(\\d+)\\s*(${unitRe})?`, 'iu')))) {
      // `Next day + 1` with no unit is a day, the sheet's own shorthand.
      date = applyOffset(date, o[1] === '+' ? 1 : -1, Number(o[2]), o[3] ?? VOCABULARY.dates.units.day[0] ?? 'day');
    } else if ((o = take(new RegExp(`^${backRe}\\s*(\\d+)\\s*(${unitRe})`, 'iu')))) {
      date = applyOffset(date, -1, Number(o[1]), o[2]!);
    } else if ((o = take(new RegExp(`^${forwardRe}\\s*(\\d+)\\s*(${unitRe})`, 'iu')))) {
      date = applyOffset(date, 1, Number(o[1]), o[2]!);
    } else if (take(/^(?:และ|and)\b/iu)) {
      continue;
    } else if (gap && text.split(/\s+/).length >= 2 && !/[+\-−]\s*\d/.test(text) && !new RegExp(`^(?:${backRe}|${forwardRe})`, 'iu').test(text)) {
      // A complete date followed by words that are not an offset — `14 เมษายน
      // รันคู่กับ E2E-41` — is a date with a remark; the remark is set aside.
      // One trailing word (`ถึงสิ้นเดือน`, a range) is not understood, and
      // nothing half-computed is typed.
      notes.push(`remark set aside: ${JSON.stringify(text)}`);
      text = '';
    } else {
      return null;
    }
  }
  const iso = isoOf(date);
  // `Next day + 1 = 2026-09-05 (today = 2026-09-03)` — the reader can check it;
  // `Today = 2026-09-03` needs no second telling.
  const bareToday = new RegExp(`^${alternation(VOCABULARY.dates.today)}$`, 'iu').test(phrase.trim());
  const tail = [...notes, ...(fromToday && !bareToday ? [`today = ${isoOf(today)}`] : [])];
  return { iso, detail: `${phrase.trim()} = ${iso}${tail.length ? ` (${tail.join(', ')})` : ''}` };
}

/** The written-date shapes at the head of a phrase, when they read as a date; null otherwise. */
function peekAbsolute(text: string, today: Ymd): RegExpExecArray | null {
  const m =
    /^(?:31\/12\/9999|12\/31\/9999|9999-12-31|\d{4}-\d{2}-\d{2}|\d{1,2}[\s-]+[A-Za-z]{3,9}\.?,?[\s-]+\d{4}|[A-Za-z]{3,9}\.?[\s-]+\d{1,2},?[\s-]+\d{4}|\d{1,2}\s*[\p{Script=Thai}.]{2,12}\s*(?:พ\.?ศ\.?\s*)?\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}\.?|\d{1,2}\s*[\p{Script=Thai}.]{2,12})(?=$|\s)/u.exec(
      text,
    );
  return m !== null && absoluteDateOf(m[0], today) !== null ? m : null;
}

/** Day N of this/next/previous month, or null when the month has no such day. */
function dayOfMonth(today: Ymd, day: number, word: MonthWord): Ymd | null {
  const month = addMonths({ ...today, d: 1 }, monthOffset(word));
  if (day < 1 || day > daysInMonth(month.y, month.m)) return null;
  return { ...month, d: day };
}
function dayMonthOfYear(y: number, m: number, d: number): Ymd | null {
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

/**
 * The FIRST source: a date phrase the step carries as written, or one the
 * case's Test data states for the field, computed from `now`. `earlier` holds
 * the fields this case already resolved, by label, so `Period End Date = Hire
 * Date + 119 Day` follows the Hire Date the same case set (probation rows,
 * 32 of them); a label not resolved yet is read from the Test data pairs
 * (`Hire Date = Today`) so sheet order does not matter.
 */
export function fromRelativeDate(
  need: ValueNeed,
  caseText: string,
  now: Date,
  pairs?: readonly TestDataPair[],
  earlier?: ReadonlyMap<string, string>,
): ResolvedValue | null {
  const all = pairs ?? testDataPairsOf(caseText);
  const known = earlier ?? new Map<string, string>();
  const env: DateEnvironment = {
    now,
    lookup: (label) => lookupDate(label, all, known, now, 0),
  };
  const phrase =
    need.phrase ??
    (() => {
      const pair = pairFor(need, all);
      if (pair === null) return null;
      const value = writtenValueOf(pair.value);
      return isDatePhrase(value, need.field) || labelOfDatePair(value, all) !== null ? value : null;
    })();
  if (phrase === null) return null;
  const date = resolveDatePhrase(phrase, env, 0);
  if (date === null) return null;
  return { need, value: date.iso, source: { kind: 'relative-date', detail: date.detail } };
}

/** An earlier field's date by label (any alias): resolved this case, or stated in the Test data (recursively, bounded). */
function lookupDate(label: string, pairs: readonly TestDataPair[], known: ReadonlyMap<string, string>, now: Date, depth: number): string | null {
  const names = R.aliasesOf(label);
  for (const name of names) {
    const hit = known.get(name);
    if (hit !== undefined) return hit;
  }
  if (depth > 3) return null;
  for (const pair of pairs) {
    const key = normalLabel(pair.key);
    if (!names.some((name) => keyMatchesLabel(key, name))) continue;
    const value = writtenValueOf(pair.value);
    if (ISO_DATE_VALUE.test(value)) return value;
    const absolute = absoluteDateOf(value, ymdOf(now));
    if (absolute !== null) return isoOf(absolute);
    if (names.includes(normalLabel(value))) continue;
    if (!isDatePhrase(value, pair.key) && labelOfDatePair(value, pairs) === null) continue;
    const resolved = resolveDatePhrase(value, { now, lookup: (l) => lookupDate(l, pairs, known, now, depth + 1) }, depth + 1);
    if (resolved !== null) return resolved.iso;
  }
  return null;
}

// --- unique per run ------------------------------------------------------------------

/** The case says this value must ALREADY be in the system — the lines about the field, the value's own line, the step's intent. */
function saysAlreadyExists(need: ValueNeed, value: string, caseText: string, intent: string | undefined): boolean {
  if (intent !== undefined && R.alreadyExists.test(intent)) return true;
  const lines = caseText.split('\n').filter((line) => line.includes(value));
  return `${linesAbout(need.field, caseText)}\n${lines.join('\n')}`.split('\n').some((line) => R.alreadyExists.test(line));
}

/**
 * A key value the sheet reused across runs (`Benefit Plan ID = PL_06_21`,
 * `Benefit name = QA-Insert`, Consent `SIT_*`), made unique to this run —
 * unless the case says the value must already exist, in which case the
 * duplicate IS the test and the value stays.
 */
export function fromUniquePerRun(need: ValueNeed, caseText: string, runKey: string | undefined, intent?: string): ResolvedValue | null {
  if (need.uniqueKey === undefined || runKey === undefined || runKey.trim() === '') return null;
  if (saysAlreadyExists(need, need.uniqueKey, caseText, intent)) return null;
  const value = uniquePerRun(need.uniqueKey, runKey);
  if (value === need.uniqueKey) return null;
  return { need, value, source: { kind: 'unique-per-run', detail: `unique per run: ${need.uniqueKey} → ${value}` } };
}

/** Passages worth asking about: documents ranked by retrieval, else the prompt's own paragraphs ranked by overlap. */
function passagesFor(need: ValueNeed, ctx: ValueResolutionContext): string[] {
  const query = [need.field, need.token ?? '', linesAbout(need.field, ctx.caseText).slice(0, 400)].join('\n');
  const budget = ctx.passageBudgetChars ?? 12_000;
  if (ctx.documents !== undefined && ctx.documents.length > 0) {
    const selected = selectRelevantContext(ctx.documents, query, { budgetChars: budget });
    return selected.documents.map((d) => d.text).filter((t) => t.trim() !== '');
  }
  const pool = `${ctx.projectContext ?? ''}\n\n${ctx.promptText ?? ''}`;
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2);
  const scored = pool
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => ({ p, score: terms.reduce((n, t) => n + (p.toLowerCase().includes(t) ? 1 : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const out: string[] = [];
  let used = 0;
  for (const { p } of scored) {
    if (used + p.length > budget) break;
    out.push(p);
    used += p.length;
  }
  return out;
}

/** A value the documents or the repository state, grounded: the answer must appear verbatim in a passage. */
export async function fromRepo(need: ValueNeed, ctx: ValueResolutionContext): Promise<ResolvedValue | null> {
  if (ctx.model === null || need.nonExisting) return null;
  const passages = passagesFor(need, ctx);
  if (passages.length === 0) return null;
  const answer = await ctx.model.fromPassages({ field: need.field, token: need.token, caseText: ctx.caseText.slice(0, 3000), passages });
  if (answer.value === null || answer.value.trim() === '') return null;
  const value = cleanModelValue(answer.value);
  if (value === '') return null;
  const grounded = passages.some((p) => p.includes(value));
  if (!grounded) {
    ctx.onLog?.(`  value for ${need.field}: the model offered ${JSON.stringify(value)} but no passage contains it — not accepted`);
    return null;
  }
  return { need, value, source: { kind: 'repo', detail: `from the documents/repository: ${answer.evidence.slice(0, 120) || value}` } };
}

/** `schema.table` or `table` → the introspected table, case-insensitively. */
function tableIn(schema: DbSchema, name: string): DbSchema['tables'][number] | null {
  const want = name.trim().toLowerCase();
  return (
    schema.tables.find((t) => t.name.toLowerCase() === want) ??
    schema.tables.find((t) => t.name.toLowerCase().endsWith(`.${want}`)) ??
    null
  );
}

function qualifiedIdent(table: string): string {
  return table.split('.').map(quoteIdent).join('.');
}

function schemaSummary(schema: DbSchema): string {
  return schema.tables
    .slice(0, 80)
    .map((t) => `${t.name}(${t.columns.map((c) => c.name).slice(0, 30).join(', ')})`)
    .join('\n');
}

/**
 * A model's answer, reduced to the value it meant. Live (ec09 HIR-EC-009,
 * 2026-09-03): asked to reply `{"value": "<the value>"}` under structured
 * output, the model put that envelope INSIDE the value field —
 * `{"value":"{\"value\": \"1999900123459\"}"}` — and the resolver typed the
 * envelope into the National ID box verbatim. Packaging is unwrapped here,
 * repeatedly: code fences, a JSON object whose single `value` (or lone) key
 * is a string, surrounding quotes or backticks, and everything after the
 * first line. Never changes a value that is already plain.
 */
export function cleanModelValue(raw: string): string {
  let text = raw.trim();
  for (let i = 0; i < 4; i++) {
    const before = text;
    text = text.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
    if (/^\{[\s\S]*\}$/.test(text)) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed !== null && typeof parsed === 'object') {
          const entries = Object.entries(parsed as Record<string, unknown>);
          const inner = (parsed as { value?: unknown }).value ?? (entries.length === 1 ? entries[0]![1] : undefined);
          if (typeof inner === 'string' || typeof inner === 'number') text = String(inner).trim();
          else if (inner !== null && typeof inner === 'object') text = JSON.stringify(inner);
        }
      } catch {
        // not JSON after all — leave it
      }
    }
    if (/^(["'`])[\s\S]*\1$/.test(text) && text.length >= 2) text = text.slice(1, -1).trim();
    const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '');
    if (firstLine !== undefined) text = firstLine.trim();
    if (text === before) break;
  }
  return text;
}

/** A well-formed candidate from the stated format — deterministic, so a retry can step it. */
export function candidateFor(format: ValueFormat | null, attempt = 0): string {
  const digits = format?.digits ?? 8;
  const leading = format?.leading ?? '9';
  if (format?.mask) {
    // `N-NNNN-NNNNN-NN-N` → digits; `EMXXXX` keeps its literal letters.
    let n = 0;
    return format.mask.replace(/[NX]/g, () => String((9 - ((n++ + attempt) % 10) + 10) % 10));
  }
  if (format?.length !== undefined) {
    // A stated length: one over it, one under it, or exactly it — letters, so
    // a length check is what it exercises and nothing else.
    const n = format.lengthRelation === 'over' ? format.length + 1 + attempt : format.lengthRelation === 'under' ? Math.max(1, format.length - 1 - attempt) : format.length;
    return Array.from({ length: n }, (_, i) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i % 26]).join('');
  }
  const body = String(9_999_999_999_999).slice(0, Math.max(1, digits - leading.length));
  const stepped = (BigInt(body) - BigInt(attempt)).toString().padStart(Math.max(1, digits - leading.length), '0');
  return `${leading}${stepped}`.slice(0, digits);
}

/** A real value from the database, or the proof that a candidate does not exist there. */
export async function fromDb(need: ValueNeed, ctx: ValueResolutionContext): Promise<ResolvedValue | null> {
  if (ctx.model === null || ctx.db === undefined) return null;
  const client = await ctx.db();
  if (client === null) return null;
  const schema = await client.introspect();
  const choice = await ctx.model.chooseDbLookup({ field: need.field, token: need.token, caseText: ctx.caseText.slice(0, 3000), schema: schemaSummary(schema) });
  if (choice === null) return null;
  const table = tableIn(schema, choice.table);
  if (table === null) throw new Error(`the model named table "${choice.table}", which the schema does not declare`);
  const columns = new Set(table.columns.map((c) => c.name.toLowerCase()));
  const column = table.columns.find((c) => c.name.toLowerCase() === choice.column.trim().toLowerCase());
  if (column === undefined) throw new Error(`the model named column "${choice.column}" on ${table.name}, which the schema does not declare`);
  for (const key of Object.keys(choice.where)) {
    if (!columns.has(key.trim().toLowerCase())) throw new Error(`the model filtered on "${key}", which ${table.name} does not have`);
  }
  const whereKeys = Object.keys(choice.where);
  const params = whereKeys.map((k) => choice.where[k]);
  const where = whereKeys.length === 0 ? '' : ` WHERE ${whereKeys.map((k, i) => `${quoteIdent(k)} = $${i + 1}`).join(' AND ')}`;
  const from = qualifiedIdent(table.name);

  if (need.nonExisting) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = candidateFor(need.format, attempt);
      const result = await client.query(`SELECT count(*) AS n FROM ${from} WHERE ${quoteIdent(column.name)} = $1`, [candidate]);
      const n = Number((result.rows[0] as { n?: unknown } | undefined)?.n ?? 0);
      if (n === 0) {
        return {
          need,
          value: candidate,
          source: { kind: 'db', detail: `${table.name}.${column.name} holds no row with this value (count = 0), so it does not exist` },
        };
      }
    }
    return null;
  }

  const result = await client.query(`SELECT ${quoteIdent(column.name)} AS v FROM ${from}${where} ORDER BY 1 DESC LIMIT 1`, params);
  const row = result.rows[0] as { v?: unknown } | undefined;
  if (row === undefined || row.v === null || row.v === undefined) return null;
  // A sensitive column never becomes a typed value, whatever the model asked
  // for: the redaction rule the reports use, plus the names that rule is too
  // narrow for (`password_hash`, `salt`, `token`, an id document number).
  const shown = redactValue(column.name, row.v);
  if (/redact/i.test(shown) || SENSITIVE_COLUMN.test(column.name)) {
    ctx.onLog?.(`  value for ${need.field}: ${table.name}.${column.name} is a sensitive column — not used`);
    return null;
  }
  return {
    need,
    value: String(row.v),
    source: {
      kind: 'db',
      detail: `${table.name}.${column.name}${whereKeys.length ? ` where ${whereKeys.map((k) => `${k}=${choice.where[k]}`).join(', ')}` : ''}`,
    },
  };
}

/** The last resort: a well-formed stand-in, flagged. */
export async function generated(need: ValueNeed, ctx: ValueResolutionContext): Promise<ResolvedValue> {
  const formatNote = need.format
    ? `the case's stated format (${[need.format.digits ? `${need.format.digits} digits` : '', need.format.leading ? `leading ${need.format.leading}` : '', need.format.mask ?? '', need.format.length ? `${need.format.lengthRelation ?? 'exactly'} ${need.format.length} characters` : ''].filter(Boolean).join(', ')})`
    : 'no stated format';
  let value = '';
  if (ctx.model !== null) {
    try {
      value = cleanModelValue((await ctx.model.generate({ field: need.field, token: need.token, caseText: ctx.caseText.slice(0, 3000), format: need.format })).value);
    } catch {
      value = '';
    }
  }
  const lengthHolds = (v: string): boolean => {
    const f = need.format;
    if (f?.length === undefined) return true;
    return f.lengthRelation === 'over' ? v.length > f.length : f.lengthRelation === 'under' ? v.length < f.length : v.length === f.length;
  };
  if (value === '' || PLACEHOLDER_TOKEN.test(value) || /[{}\[\]"]/.test(value) || (need.format?.digits !== undefined && !new RegExp(`^\\d{${need.format.digits}}$`).test(value)) || !lengthHolds(value)) {
    value = candidateFor(need.format);
  }
  return {
    need,
    value,
    source: {
      kind: 'generated',
      detail: `GENERATED by the author from ${formatNote} — no test data, document, repository or database source named one`,
    },
  };
}

// --- the stage ------------------------------------------------------------------

export interface ValueResolutionOutcome {
  setup: FlowStep[];
  steps: FlowStep[];
  resolved: ResolvedValue[];
}

/**
 * Resolve every need, cheapest source first, and write the answer onto the
 * step: its `value`, a suffix on its `intent`, and `valueSource`.
 *
 * Needs are taken in step order, and every date resolved is remembered by its
 * field's label so a later phrase (`Hire Date + 119 Day`) can lean on it. A
 * date-phrase or reused-key need has exactly one source; when that source
 * declines, the step is left as authored and the log says so — a stand-in for
 * a date, or for a key the case says must already exist, would be a lie.
 */
export async function resolveValues(
  setup: readonly FlowStep[],
  steps: readonly FlowStep[],
  ctx: ValueResolutionContext,
): Promise<ValueResolutionOutcome> {
  const nextSetup = setup.map((s) => ({ ...s })) as FlowStep[];
  const nextSteps = steps.map((s) => ({ ...s })) as FlowStep[];
  const resolved: ResolvedValue[] = [];
  // The one place the wall clock is read: everything below takes `now`.
  const now = ctx.now ?? new Date();
  const pairs = ctx.testDataPairs ?? testDataPairsOf(ctx.caseText);
  const earlier = new Map<string, string>();
  for (const need of findUnresolvedValues(nextSetup, nextSteps, ctx.caseText, { caseId: ctx.caseId, pairs })) {
    const list = need.section === 'setup' ? nextSetup : nextSteps;
    const step = list[need.index] as FlowStep & { value?: string; intent?: string | undefined; valueSource?: ValueSource | undefined };
    let answer: ResolvedValue | null = null;
    const tried: string[] = [];
    if (need.phrase !== undefined || need.uniqueKey !== undefined || need.blank === true || need.space === true || need.written !== undefined) {
      // The single-source needs: computed, suffixed, blanked or cleaned from
      // the case's own words — a model is never asked, and a source that
      // declines leaves the step as authored.
      answer =
        need.phrase !== undefined
          ? fromRelativeDate(need, ctx.caseText, now, pairs, earlier)
          : need.uniqueKey !== undefined
            ? fromUniquePerRun(need, ctx.caseText, ctx.runKey, step.intent)
            : need.blank === true
              ? { need, value: '', source: { kind: 'test-data', detail: `the case says to leave it blank: ${JSON.stringify(step.value ?? '')}` } }
              : need.space === true
                ? { need, value: ' ', source: { kind: 'test-data', detail: `the case says the value is a space: ${JSON.stringify(step.value ?? '')}` } }
                : { need, value: need.written!, source: { kind: 'test-data', detail: `the case writes ${JSON.stringify(step.value ?? '')}; the value is ${JSON.stringify(need.written)}` } };
      if (answer === null) {
        ctx.onLog?.(
          need.phrase !== undefined
            ? `  ${need.field}: the date phrase ${JSON.stringify(need.phrase)} was not understood — left as written`
            : `  ${need.field}: ${JSON.stringify(need.uniqueKey)} kept as written${ctx.runKey === undefined ? ' (no run key)' : ' (the case says it already exists)'}`,
        );
        continue;
      }
    } else {
      for (const [name, source] of [
        ['relative-date', async (): Promise<ResolvedValue | null> => fromRelativeDate(need, ctx.caseText, now, pairs, earlier)],
        ['test-data', async (): Promise<ResolvedValue | null> => fromTestData(need, ctx.caseText, pairs)],
        ['repo', async (): Promise<ResolvedValue | null> => fromRepo(need, ctx)],
        ['db', async (): Promise<ResolvedValue | null> => fromDb(need, ctx)],
      ] as const) {
        try {
          answer = await source();
        } catch (error) {
          tried.push(`${name}: ${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}`);
          answer = null;
        }
        if (answer !== null) break;
      }
      if (answer === null && need.credential === true) {
        // A login, account or password is never invented: the run's persona
        // (a `signIn` by label) supplies it, and a made-up one fails for a
        // reason no case asked about. Left as authored, so the lint refuses
        // the token and the author is asked for the persona instead.
        for (const line of tried) ctx.onLog?.(`  value for ${need.field}: ${line}`);
        ctx.onLog?.(`  ${need.field}: ${JSON.stringify(need.token ?? step.value ?? '')} is a credential — never generated; the run's persona supplies it`);
        continue;
      }
      if (answer === null) answer = await generated(need, ctx);
      // A value the Test data states that IS the case id gets the run's suffix
      // too — the sheet's `Benefit Plan ID = PL_06_21` reaches here through a
      // `<PLAN_ID>` token as often as typed outright.
      if (answer.source.kind === 'test-data' && isReusedKeyValue(answer.value, need.field, ctx.caseId)) {
        const unique = fromUniquePerRun({ ...need, uniqueKey: answer.value }, ctx.caseText, ctx.runKey, step.intent);
        if (unique !== null) answer = { need, value: unique.value, source: { kind: 'unique-per-run', detail: `${unique.source.detail}; ${answer.source.detail}` } };
      }
    }
    for (const line of tried) ctx.onLog?.(`  value for ${need.field}: ${line}`);
    step.value = answer.value;
    step.valueSource = answer.source;
    const suffix =
      answer.source.kind === 'generated'
        ? ` — value GENERATED by the author: ${answer.source.detail}`
        : answer.source.kind === 'unique-per-run'
          ? ` — value ${answer.source.detail}`
          : ` — value from ${answer.source.kind}: ${answer.source.detail}`;
    step.intent = `${step.intent ?? `${step.action} ${need.field}`}${suffix}`;
    if (ISO_DATE_VALUE.test(answer.value)) earlier.set(normalLabel(need.field), answer.value);
    ctx.onLog?.(
      `  ${need.field} ← ${answer.source.kind}${answer.source.kind === 'generated' ? '' : ` (${answer.value})`}` +
        (answer.source.kind === 'generated' ? ` ${answer.value} — flagged` : ''),
    );
    resolved.push(answer);
  }
  return { setup: nextSetup, steps: nextSteps, resolved };
}

export async function expandMasterDataCodes(
  setup: readonly FlowStep[],
  steps: readonly FlowStep[],
  ctx: MasterDataContext,
): Promise<{ setup: FlowStep[]; steps: FlowStep[]; expanded: MasterDataExpansion[] }> {
  const nextSetup = setup.map((step) => ({ ...step })) as FlowStep[];
  const nextSteps = steps.map((step) => ({ ...step })) as FlowStep[];
  const candidates = new Map<MasterDataLookup, MasterDataExpansion[]>();

  for (const [section, list] of [['setup', nextSetup], ['steps', nextSteps]] as const) {
    list.forEach((step, index) => {
      if (!INPUT_ACTIONS.has(step.action)) return;
      const value = 'value' in step && typeof step.value === 'string' ? step.value.trim() : '';
      if (value === '' || codeAndLabelOf(value) !== null) return;
      const field = fieldLabelOf(step).trim();
      if (field === '') return;
      const lookup = ctx.lookups.find((entry) => entry.field.some((declared) => sameField(declared, field)));
      if (lookup === undefined) return;
      const pending = candidates.get(lookup) ?? [];
      pending.push({ section, index, field, code: value, label: '', fields: lookup.field });
      candidates.set(lookup, pending);
    });
  }

  if (candidates.size === 0) return { setup: nextSetup, steps: nextSteps, expanded: [] };
  const pairs = ctx.testDataPairs ?? [];
  const bindingsByLookup = new Map<MasterDataLookup, Record<string, string>>();
  const unbound = new Map<MasterDataLookup, string[]>();
  for (const lookup of candidates.keys()) {
    const bindings: Record<string, string> = {};
    const missing: string[] = [];
    for (const token of templateTokens(lookup.url)) {
      const pair = pairs.find((entry) => sameField(entry.key, token) && entry.value.trim() !== '');
      if (pair === undefined) missing.push(token);
      else bindings[token] = pair.value.trim();
    }
    if (missing.length > 0) unbound.set(lookup, missing);
    else bindingsByLookup.set(lookup, bindings);
  }
  for (const [lookup, missing] of unbound) {
    ctx.onLog?.(`  master data ${lookup.field.join(' / ')} skipped: token(s) ${missing.map((token) => `{${token}}`).join(', ')} not in this row's Test Data`);
    candidates.delete(lookup);
  }
  if (candidates.size === 0) return { setup: nextSetup, steps: nextSteps, expanded: [] };

  let fetchJson: FetchJson | null;
  try {
    fetchJson = await ctx.fetch();
  } catch (error) {
    ctx.onLog?.(`master-data expansion did not run: ${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}`);
    return { setup: nextSetup, steps: nextSteps, expanded: [] };
  }
  if (fetchJson === null) {
    ctx.onLog?.('master-data expansion did not run: no transport is available');
    return { setup: nextSetup, steps: nextSteps, expanded: [] };
  }

  const fetcher = new LookupFetcher(fetchJson);
  const expanded: MasterDataExpansion[] = [];
  for (const [lookup, uses] of candidates) {
    const fetched = await fetcher.fetch(lookup, bindingsByLookup.get(lookup) ?? {}, ctx.appUrl);
    if (fetched.status === 'unknown') {
      ctx.onLog?.(`  master data ${lookup.field.join(' / ')} could not be read: ${fetched.reason}`);
      continue;
    }
    const grounded = new Map(groundCodes(lookup, fetched.rows, uses.map((use) => use.code)).map((item) => [item.code, item]));
    for (const use of uses) {
      const found = grounded.get(use.code);
      if (found === undefined || !found.found) {
        ctx.onLog?.(`  ${use.field}: ${JSON.stringify(use.code)} did not appear in master data ${lookup.field.join(' / ')}`);
        continue;
      }
      const label = found.label?.trim() ?? '';
      if (label === '' || label === use.code) continue;
      const list = use.section === 'setup' ? nextSetup : nextSteps;
      const step = list[use.index];
      if (step === undefined) continue;
      const detail = `${use.field} code ${JSON.stringify(use.code)} is labelled ${JSON.stringify(label)} in ${lookup.field.join(' / ')}`;
      const intent = 'intent' in step && typeof step.intent === 'string' ? step.intent : `${step.action} ${use.field}`;
      Object.assign(step, {
        value: `${use.code} — ${label}`,
        valueSource: { kind: 'master-data', detail },
        intent: `${intent} — value from master-data: ${detail}`,
      });
      const result = { ...use, label };
      expanded.push(result);
      ctx.onLog?.(`  ${use.field} ← master-data (${use.code} — ${label})`);
      if (found.reachable === false) ctx.onLog?.(`  ${use.field}: ${JSON.stringify(use.code)} was found but is unreachable in the picker`);
    }
  }
  return { setup: nextSetup, steps: nextSteps, expanded };
}

/** One field the page fills from an earlier choice, turned into the assertion it is. */
export interface DerivedAssertion {
  index: number;
  field: string;
  /** The field whose master row carried this value (`Position`). */
  from: string;
  /** The key on that row that carried it (`costCenterCode`). */
  path: string;
  action: 'expectValue' | 'expectText';
  expected: string;
}

/** The roles whose value a person reads out of an input, not off a label. */
const VALUE_ROLES = /^role=(textbox|spinbutton|combobox|searchbox)\b/i;

/** Every scalar key on a master row, so a later field's value can be found on it. */
function scalarEntries(row: unknown): [string, string][] {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return [];
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value).trim();
      // Two characters is the floor: a one-character match is coincidence.
      if (text.length >= 2) out.push([key, text]);
    }
  }
  return out;
}

/** The code half of a value the expansion may already have written as `code — label`. */
function codeHalfOf(value: string): string {
  return codeAndLabelOf(value)?.code ?? value.trim();
}

function labelHalfOf(value: string): string | null {
  return codeAndLabelOf(value)?.label ?? null;
}

/**
 * A field the application fills for you is asserted, never keyed in.
 *
 * The hire wizard's R199 rule fills Organization, Cost Center, Work Location,
 * Job Code and a dozen more the moment a Position is chosen — every one of
 * them off the position's own master row. A sheet that names those values is
 * describing what the page must SHOW, not asking a tester to pick them; live
 * (HIR-EC-001, 2026-09-08) `Cost Center = C00132653` and
 * `Work Location = 50000127` are exactly what position `40106337` carries.
 * Authored as `selectOption` they either re-pick what is already there — a
 * step that passes while proving nothing — or fail at a picker that never
 * offered the value, and the run reads it as a defect.
 *
 * The evidence is the master row itself, so nothing here is declared or
 * guessed: when a later step's value equals a field on the row an earlier
 * step's choice resolves to, that later field is derived, and the step becomes
 * the assertion. Two guards keep it honest — only a step AFTER the choice can
 * be filled by it (which is what stops `Company = C001`, the scope the
 * position was fetched under, from reading as derived), and a disagreement is
 * left alone: a sheet naming a value the row does not carry is a finding for a
 * person, not a step for this pass to rewrite.
 */
export async function assertDerivedFields(
  steps: readonly FlowStep[],
  ctx: MasterDataContext,
): Promise<{ steps: FlowStep[]; derived: DerivedAssertion[] }> {
  const next = steps.map((step) => ({ ...step })) as FlowStep[];
  const pairs = ctx.testDataPairs ?? [];

  // The choices whose master row may fill a later field, in flow order.
  const sources: { index: number; field: string; code: string; lookup: MasterDataLookup }[] = [];
  next.forEach((step, index) => {
    if (step.action !== 'selectOption') return;
    const raw = 'value' in step && typeof step.value === 'string' ? step.value.trim() : '';
    if (raw === '') return;
    const field = fieldLabelOf(step).trim();
    if (field === '') return;
    const lookup = ctx.lookups.find((entry) => entry.field.some((declared) => sameField(declared, field)));
    if (lookup === undefined) return;
    sources.push({ index, field, code: codeHalfOf(raw), lookup });
  });
  if (sources.length === 0) return { steps: next, derived: [] };

  let fetchJson: FetchJson | null;
  try {
    fetchJson = await ctx.fetch();
  } catch (error) {
    ctx.onLog?.(`derived-field assertions did not run: ${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}`);
    return { steps: next, derived: [] };
  }
  if (fetchJson === null) return { steps: next, derived: [] };

  const fetcher = new LookupFetcher(fetchJson);
  const derived: DerivedAssertion[] = [];
  const claimed = new Set<number>();
  for (const source of sources) {
    const bindings: Record<string, string> = {};
    let bound = true;
    for (const token of templateTokens(source.lookup.url)) {
      const pair = pairs.find((entry) => sameField(entry.key, token) && entry.value.trim() !== '');
      if (pair === undefined) { bound = false; break; }
      bindings[token] = pair.value.trim();
    }
    if (!bound) continue;
    const fetched = await fetcher.fetch(source.lookup, bindings, ctx.appUrl);
    if (fetched.status === 'unknown') continue;
    const row = fetched.rows.find((candidate) => codeText(readPath(candidate, source.lookup.code)) === source.code);
    if (row === undefined) continue;
    const onRow = scalarEntries(row);

    for (let index = source.index + 1; index < next.length; index += 1) {
      if (claimed.has(index)) continue;
      const step = next[index]!;
      if (!INPUT_ACTIONS.has(step.action)) continue;
      const raw = 'value' in step && typeof step.value === 'string' ? step.value.trim() : '';
      if (raw === '') continue;
      const field = fieldLabelOf(step).trim();
      if (field === '' || sameField(field, source.field)) continue;
      const code = codeHalfOf(raw);
      if (code.length < 2 || code === source.code) continue;
      const hit = onRow.find(([, value]) => value === code);
      if (hit === undefined) continue;

      const selector = 'selector' in step && typeof step.selector === 'string' ? step.selector : '';
      const byValue = VALUE_ROLES.test(selector);
      // A control that holds an input shows the code; one that renders a
      // chosen option shows that option's label.
      const expected = byValue ? code : (labelHalfOf(raw) ?? code);
      const action: 'expectValue' | 'expectText' = byValue ? 'expectValue' : 'expectText';
      const detail =
        `the page fills ${field} from ${source.field}: position-master field ${hit[0]} on the chosen row ` +
        `is ${JSON.stringify(code)}, so the sheet's value is what the page must SHOW, not something to key in`;
      const intent = 'intent' in step && typeof step.intent === 'string' ? step.intent : `${step.action} ${field}`;
      next[index] = {
        ...step,
        action,
        value: expected,
        intent: `${intent} — asserted, not keyed: ${detail}`,
      } as FlowStep;
      claimed.add(index);
      derived.push({ index, field, from: source.field, path: hit[0], action, expected });
      ctx.onLog?.(`  ${field} ← derived from ${source.field} (${hit[0]}); ${step.action} became ${action} ${JSON.stringify(expected)}`);
    }
  }
  return { steps: next, derived };
}

// --- the model ------------------------------------------------------------------

const RULES = `Answer from the evidence given and nothing else. A value you cannot point at in the passages is null. Never invent an id, a name or a code when asked what the evidence says; inventing is a separate question you will be asked explicitly.`;

/** The three questions, each one small structured call on the agent role. */
export class LlmValueResolverModel implements ValueResolverModel {
  readonly id: string;
  readonly #source: ModelSource;

  constructor(options: { factory: import('../providers/llm-factory.js').LlmFactory; role?: 'agent' | 'generator' | undefined } | { model: import('ai').LanguageModel; id?: string | undefined }) {
    if ('factory' in options) {
      this.#source = { factory: options.factory, role: options.role ?? 'agent' };
      this.id = `value-resolver:${options.role ?? 'agent'}`;
    } else {
      this.#source = { model: options.model };
      this.id = options.id ?? 'value-resolver:model';
    }
  }

  async fromPassages(q: { field: string; token: string | null; caseText: string; passages: readonly string[] }): Promise<{ value: string | null; evidence: string }> {
    const { object } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      schema: lenientObject({ value: z.string().nullable(), evidence: z.string() }),
      system: `You find concrete values in evidence.\n${RULES}`,
      prompt:
        `FIELD: ${q.field}\nTOKEN: ${q.token ?? '(a described value)'}\nCASE:\n${q.caseText}\n\nPASSAGES:\n` +
        q.passages.map((p, i) => `--- passage ${i + 1} ---\n${p}`).join('\n') +
        `\n\nWhich concrete value in the passages satisfies the field? Reply {"value": "<verbatim from a passage>", "evidence": "<the passage line>"} or {"value": null, "evidence": ""}.`,
      maxOutputTokens: 300,
    });
    return { value: object.value, evidence: object.evidence ?? '' };
  }

  async chooseDbLookup(q: { field: string; token: string | null; caseText: string; schema: string }): Promise<{ table: string; column: string; where: Record<string, string> } | null> {
    const { object } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      schema: lenientObject({
        table: z.string().nullable(),
        column: z.string().nullable(),
        where: z.string().describe('column=value pairs joined by commas, or empty'),
      }),
      system: `You choose a read-only database lookup.\n${RULES} Name only a table and columns that appear in the schema list.`,
      prompt:
        `FIELD: ${q.field}\nTOKEN: ${q.token ?? '(a described value)'}\nCASE:\n${q.caseText}\n\nSCHEMA (table(columns)):\n${q.schema}\n\n` +
        `Which table and column hold a real value for this field, and which column=value filter narrows to a usable row (e.g. status=active)? Reply {"table":..., "column":..., "where": "col=value, col2=value"} or {"table": null, "column": null, "where": ""}.`,
      maxOutputTokens: 200,
    });
    if (!object.table || !object.column) return null;
    const where: Record<string, string> = {};
    for (const pair of (object.where ?? '').split(',')) {
      const t = pair.trim();
      if (t === '') continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      where[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    return { table: object.table, column: object.column, where };
  }

  async generate(q: { field: string; token: string | null; caseText: string; format: ValueFormat | null }): Promise<{ value: string }> {
    const { object } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      schema: lenientObject({ value: z.string() }),
      system: 'You invent ONE well-formed test value for a form field. Match the stated format exactly and make it obviously synthetic. The value goes in the "value" field as a plain string — never JSON, quotes or an object inside it.',
      prompt:
        `FIELD: ${q.field}\nTOKEN: ${q.token ?? '(a described value)'}\nFORMAT: ${q.format ? JSON.stringify(q.format) : 'not stated — infer from the case'}\nCASE:\n${q.caseText}\n\nReply {"value": "<the value as a plain string>"}.`,
      maxOutputTokens: 60,
    });
    return { value: object.value };
  }
}
