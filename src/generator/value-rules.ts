/**
 * The vocabulary the authoring plane reads a sheet with — as DATA.
 *
 * Two halves, one file, one schema, one override point:
 *
 * - `values`: the words the value resolver (`value-resolution.ts`) reads a
 *   Test data cell with — "today", "leave it blank", "and above", "does not
 *   exist", the date grammar, field aliases.
 * - `authoring`: the words the authoring lints (`flow-author.ts`) and the
 *   sheet gates (`catalog/test-case-table.ts`) read a row's Steps, Expected
 *   and Note with — which verbs ask the tester to TYPE, to CHOOSE, to ACT;
 *   which words make a claim about wording, about two readings agreeing;
 *   which prefixes name an open question; which Note words cancel a row.
 *
 * The MECHANISMS stay in code and are structural (a word class, a trailing
 * clause, a step shape, a selector role); the WORDS live here, in both of the
 * languages the sheets use, and `.wowlidator/value-rules.json` may replace any
 * list wholesale (`loadValueRules`). No entry names a field of one catalog, a
 * case id, a page, or a test-data literal — the user's standing rule
 * (2026-09-03): no field-, phrase- or locale-keyed fix.
 *
 * Every word is a LITERAL: regex-escaped, then anchored the way its class
 * needs — Latin on a word boundary, Thai as a substring (Thai has no word
 * boundaries), a blank word as the whole value.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

export interface DateWords {
  today: readonly string[];
  tomorrow: readonly string[];
  yesterday: readonly string[];
  future: readonly string[];
  past: readonly string[];
  thisMonth: readonly string[];
  nextMonth: readonly string[];
  previousMonth: readonly string[];
  before: readonly string[];
  after: readonly string[];
  at: readonly string[];
  prefixes: readonly string[];
  exact: readonly string[];
  back: readonly string[];
  forward: readonly string[];
  units: { day: readonly string[]; week: readonly string[]; month: readonly string[]; year: readonly string[] };
  birthFieldWords: readonly string[];
  ageWords: readonly string[];
  ageUnder: readonly string[];
  ageOver: readonly string[];
  ageAtLeast: readonly string[];
  ageAtMost: readonly string[];
  ageExact: readonly string[];
  /** The fields an age is measured at when the phrase names no anchor (`Age < 60` on a hire). */
  ageAnchorFields: readonly string[];
}

export interface Vocabulary {
  keyFieldWords: readonly string[];
  qaKeyPrefixes: readonly string[];
  nonExistingWords: readonly string[];
  describedValueWords: readonly string[];
  alreadyExistsWords: readonly string[];
  blankWords: readonly string[];
  noteIntroducers: readonly string[];
  /** The value is one whitespace character (`เว้นวรรค`): a name of nothing but a space, typed on purpose. */
  spaceWords: readonly string[];
  /** A value that BEGINS with one of these is an instruction to the tester, not a value (`เลือกแขวงที่อยู่ใน …`). */
  inputVerbs: readonly string[];
  /** A token or field naming a credential is never invented: the run's persona supplies it, or nobody does. */
  credentialWords: readonly string[];
  boundWords: readonly string[];
  exampleIntroducers: readonly string[];
  formatWords: { digitUnits: readonly string[]; leadingDigit: readonly string[]; lengthUnits: readonly string[]; over: readonly string[]; under: readonly string[] };
  dates: DateWords;
  /** Groups of labels that name ONE field across languages, so `วันก่อนวันที่จ้าง` finds the `Hire Date = Today` line. */
  fieldAliases: readonly (readonly string[])[];
}

const DEFAULT_VALUE_VOCABULARY: Vocabulary = {
  keyFieldWords: ['ID', 'Code', 'Name', 'Key', 'No', 'No.', 'รหัส', 'ชื่อ'],
  qaKeyPrefixes: ['QA-', 'SIT_'],
  nonExistingWords: [
    'non-existing',
    'non-existent',
    'nonexist',
    'not exist',
    'not-existing',
    'invalid',
    'unknown',
    'not found',
    'not in the list',
    'ไม่มีอยู่จริง',
    'ไม่ถูกต้อง',
    'ไม่มีในระบบ',
    'ยังไม่มีในระบบ',
    'ไม่อยู่ใน list',
  ],
  describedValueWords: [
    'ที่มีอยู่จริง',
    'มีอยู่แล้ว',
    'existing',
    'any valid',
    'a valid',
    'ของพนักงาน',
    'ค่าที่ไม่อยู่ใน',
    'ค่าอื่น',
    'ค่าใหม่',
    'ไม่มีในระบบ',
    'ยังไม่มีในระบบ',
    'ที่ยังไม่มี',
  ],
  alreadyExistsWords: ['มีอยู่แล้ว', 'มีในระบบ', 'ที่มีอยู่', 'ซ้ำกับ', 'already exist', 'already exists', 'duplicate', 'existing'],
  blankWords: ['blank', '(blank)', 'empty', 'leave blank', 'leave empty', 'null', 'none', 'n/a', 'na', 'ว่าง', 'เว้นว่าง', 'ไม่กรอก', 'ไม่ระบุ', 'ปล่อยว่าง'],
  noteIntroducers: ['ตาม', 'ให้', 'ใช้', 'เพื่อ', 'เป็น', 'ซึ่ง', 'แต่', 'ถ้า', 'หาก', 'เพราะ', 'เมื่อ', 'ดู', 'แก้จาก', 'as per', 'per', 'according to', 'based on', 'see', 'if', 'when', 'because', 'which'],
  spaceWords: ['เว้นวรรค', 'space', 'a space', 'spaces', 'whitespace'],
  inputVerbs: ['กรอก', 'ระบุ', 'เลือก', 'ใส่', 'คีย์', 'กำหนด', 'พิมพ์', 'enter', 'fill', 'key in', 'select', 'choose', 'pick', 'use'],
  credentialWords: ['account', 'login', 'log-in', 'user', 'username', 'password', 'passwd', 'pwd', 'credential', 'credentials'],
  boundWords: ['ขึ้นไป', 'หรือมากกว่า', 'ลงมา', 'หรือน้อยกว่า', 'or more', 'or above', 'and above', 'or higher', 'or greater', 'or less', 'or below', 'and below', 'or lower'],
  exampleIntroducers: ['เช่น', 'e.g.', 'eg.', 'such as', 'for example', 'ex.', 'อาทิ'],
  formatWords: {
    digitUnits: ['หลัก', 'digit', 'digits'],
    leadingDigit: ['หลักแรกเป็น', 'หลักแรกคือ', 'หลักแรก', 'starts with', 'start with', 'first digit is', 'first digit', 'leading digit is', 'leading digit'],
    lengthUnits: ['ตัวอักษร', 'characters', 'character', 'chars'],
    over: ['เกิน', 'มากกว่า', 'more than', 'over', 'longer than', 'exceeds', 'exceeding', '>'],
    under: ['ไม่เกิน', 'น้อยกว่า', 'at most', 'up to', 'no more than', 'less than', 'under', 'shorter than', '<'],
  },
  dates: {
    today: ['today', 'now', 'current date', 'the current date', 'test date', 'วันนี้', 'วันที่ปัจจุบัน', 'ปัจจุบัน', 'วันที่ทดสอบ'],
    tomorrow: ['tomorrow', 'next day', 'nextday', 'วันถัดไป', 'วันพรุ่งนี้', 'พรุ่งนี้'],
    yesterday: ['yesterday', 'เมื่อวานนี้', 'เมื่อวาน', 'วันก่อนหน้า'],
    future: ['a future date', 'future date', 'in the future', 'วันในอนาคต', 'วันที่ในอนาคต', 'อนาคต'],
    past: ['a past date', 'past date', 'in the past', 'วันในอดีต', 'วันที่ในอดีต', 'อดีต'],
    thisMonth: ['ปัจจุบัน', 'นี้', 'ที่ทดสอบ', 'this', 'current'],
    nextMonth: ['ถัดไป', 'หน้า', 'next'],
    previousMonth: ['ก่อนหน้า', 'ก่อน', 'ที่แล้ว', 'previous', 'last'],
    before: ['before', 'prior to', 'the day before', 'day before', 'วันก่อน', 'ก่อน', '<'],
    after: ['after', 'the day after', 'day after', 'วันหลัง', 'หลัง', '>'],
    at: ['ณ', 'at', 'as of', 'as at'],
    prefixes: ['ทำให้', 'ให้', 'set to', 'make', 'use', 'ใช้', 'ตั้งแต่', 'วันที่ตั้งแต่'],
    exact: ['พอดี', 'เป๊ะ', 'exactly'],
    back: ['ย้อนหลัง', 'ก่อนหน้า', 'ก่อน', 'ลบ', 'ago', 'back', 'earlier', 'minus'],
    forward: ['ล่วงหน้า', 'อีก', 'บวก', 'in', 'from now', 'plus'],
    units: {
      day: ['day', 'days', 'd', 'วัน'],
      week: ['week', 'weeks', 'w', 'สัปดาห์'],
      month: ['month', 'months', 'เดือน'],
      year: ['year', 'years', 'y', 'ปี'],
    },
    birthFieldWords: ['birth', 'dob', 'เกิด', 'age', 'อายุ'],
    ageWords: ['age', 'อายุ'],
    ageUnder: ['<', 'น้อยกว่า', 'ต่ำกว่า', 'ไม่ถึง', 'under', 'below', 'younger than', 'less than'],
    ageOver: ['>', 'มากกว่า', 'เกิน', 'over', 'above', 'older than', 'more than'],
    ageAtLeast: ['>=', '≥', 'ตั้งแต่', 'at least', 'ขึ้นไป', 'or more', 'or older', 'or above', 'or over', 'and above', 'and over', 'and older'],
    ageAtMost: ['<=', '≤', 'at most', 'ลงมา', 'or less', 'or younger', 'or below', 'or under', 'and below', 'and under', 'and younger'],
    ageExact: ['=', 'พอดี', 'ครบ', 'เป๊ะ', 'exactly', 'เท่ากับ', 'equal to', 'equals'],
    ageAnchorFields: ['Hire Date', 'Start Date'],
  },
  fieldAliases: [['Hire Date', 'วันที่จ้าง', 'วันที่เข้างาน', 'วันเริ่มงาน', 'Hiring Date']],
};

// --- the authoring vocabulary ----------------------------------------------------
//
// What the lints key on is STRUCTURAL — a numbered line, an action kind, a
// selector's role, a `= ?` beside an id — and the words below only name the
// classes those structures are read through. Each list carries both of the
// languages the sheets are written in; a word that exists in one and not the
// other is a rule that works for one sheet's wording only.

export interface AuthoringRules {
  attachmentWords: readonly string[];
  /** How the Steps column asks the tester to do things, by the action that performs it. */
  script: {
    /** Asks for something to be TYPED — performed only by a fill / type / upload. */
    typing: readonly string[];
    /** Asks for something to be CHOSEN — a selectOption / check, or a click on a choice. */
    choosing: readonly string[];
    /** Asks the tester to ACT — a click, a key press or an agent leg performs it. */
    acting: readonly string[];
    /** A line that names the page to open, never a step to perform (`ไปที่ HR > Benefits`). */
    routeLine: readonly string[];
    /** The word before a step number in an intent or a goal (`Step 5:`, `ขั้นตอนที่ 5`). */
    stepWords: readonly string[];
    /** The word that marks a step as skipped on purpose (`skipped step 4: …`). */
    skipWords: readonly string[];
  };
  /** A claim about how the page is WORDED, as opposed to what it holds. */
  wordingClaim: readonly string[];
  /** A claim that two readings agree, or that a quantity did not move. */
  matchClaim: {
    agree: readonly string[];
    unchanged: readonly string[];
    /** What a reading is read from: a table, a tile, a card. */
    readings: readonly string[];
    /** What is counted: a count, a total, a number. */
    quantities: readonly string[];
  };
  /**
   * The prefixes of an id that NAMES A QUESTION nobody has answered (`OQ-HIR-140`,
   * `CF-SIT-19`). The structural half — any id-shaped token the case writes after
   * `= ?` — needs no prefix at all; see `openQuestionIdsIn`.
   */
  openQuestionPrefixes: readonly string[];
  /** The Note column's own verdicts on a row. */
  sheetNote: {
    /** The requirement dropped the case. */
    cancelled: readonly string[];
    /** The case cannot be run yet. */
    notYet: readonly string[];
    /** A retest — a status that says cancelled AND retest is not a cancelled row. */
    retest: readonly string[];
  };
}

export const DEFAULT_AUTHORING_RULES: AuthoringRules = {
  attachmentWords: ['attachment', 'attach file', 'file upload', 'upload', 'แนบไฟล์', 'เอกสารแนบ', 'อัปโหลด'],
  script: {
    typing: ['กรอก', 'คีย์', 'ระบุ', 'พิมพ์', 'ใส่ค่า', 'แนบ', 'fill', 'fill in', 'fill out', 'key in', 'key-in', 'enter', 'type', 'attach'],
    choosing: ['เลือก', 'ติ๊ก', 'select', 'choose', 'pick', 'tick', 'check', 'uncheck', 'toggle'],
    acting: [
      'กด', 'กดปุ่ม', 'คลิก', 'บันทึก', 'ยอมรับ', 'ประกาศ', 'เปิดไฟล์', 'เปิดหน้า', 'เปิดเมนู', 'อัปโหลด', 'ลบ', 'แก้ไข', 'สร้าง',
      'เข้าสู่ระบบ', 'ล็อกอิน', 'ส่ง', 'อนุมัติ', 'ปฏิเสธ',
      'click', 'press', 'tap', 'submit', 'save', 'accept', 'approve', 'reject', 'publish', 'announce', 'open', 'upload',
      'log in', 'login', 'sign in', 'sign-in', 'delete', 'edit', 'create', 'send',
    ],
    routeLine: ['ไปที่', 'ไปยัง', 'เข้าไปที่', 'เข้าที่', 'เปิดเมนู', 'เมนู', 'menu', 'go to', 'navigate', 'open the'],
    stepWords: ['step', 'ขั้นตอนที่', 'ขั้นตอน', 'ข้อที่', 'ข้อ'],
    skipWords: ['skip', 'skipped', 'ข้าม'],
  },
  wordingClaim: [
    'spelling', 'spelled', 'spell', 'misspelled', 'wording', 'worded', 'label', 'labels', 'labelled', 'labeled', 'caption', 'captions',
    'typo', 'typos', 'terminology', 'copy text', 'text is', 'text matches', 'text reads', 'text appears',
    'ข้อความ', 'สะกด', 'คำแสดง', 'คำที่แสดง', 'ตัวสะกด', 'ป้ายชื่อ',
  ],
  matchClaim: {
    agree: [
      'match', 'matches', 'matching', 'reconcile', 'reconciles', 'reconciled', 'reconciliation', 'agree with', 'agrees with',
      'equal', 'equals', 'same as', 'ตรงกับ', 'เท่ากับ', 'สอดคล้อง', 'ตรงกัน',
    ],
    unchanged: ['no change', 'unchanged', 'does not change', 'did not change', 'stays the same', 'ไม่เปลี่ยน', 'ไม่เปลี่ยนแปลง', 'เท่าเดิม', 'คงเดิม'],
    readings: ['table', 'column', 'row', 'tile', 'summary', 'card', 'list', 'ตาราง', 'คอลัมน์', 'การ์ด', 'รายการ'],
    quantities: ['count', 'number', 'total', 'tile', 'จำนวน', 'ตัวเลข', 'ยอดรวม'],
  },
  openQuestionPrefixes: ['OQ-', 'CF-'],
  sheetNote: {
    cancelled: [
      'cancelled', 'canceled', 'dropped', 'removed from req', 'removed from the req', 'removed from requirement', 'out of scope',
      'ยกเลิกเคส', 'เคสถูกยกเลิก', 'ยกเลิก test case', 'ตัดออกจาก requirement', 'นอกขอบเขต',
    ],
    notYet: [
      'ยังรันไม่ได้', 'ยังทดสอบไม่ได้', 'ยังไม่สามารถทดสอบ', 'บันทึกผลเป็นยังทดสอบไม่ได้',
      'cannot be run yet', 'cannot run yet', 'cannot be tested yet', 'cannot test yet', 'not testable', 'not yet testable',
      'blocked until dev', 'blocked until the team', 'blocked until delivery',
    ],
    retest: ['re-test', 'retest', 'ทดสอบซ้ำ', 'ทดสอบใหม่'],
  },
};

// --- the rule set, its schema and its file -----------------------------------------

export interface ValueRules {
  values: Vocabulary;
  authoring: AuthoringRules;
}

export const DEFAULT_VALUE_RULES: ValueRules = {
  values: DEFAULT_VALUE_VOCABULARY,
  authoring: DEFAULT_AUTHORING_RULES,
};

/** Where a project overrides the built-ins; relative to the working directory, like every other `.wowlidator/` file. */
export const VALUE_RULES_FILE = '.wowlidator/value-rules.json';

const words = z.array(z.string().min(1)).optional();
const wordGroups = z.array(z.array(z.string().min(1))).optional();

/**
 * The file's shape: every list optional, every present list REPLACING the
 * built-in one wholesale — so a tester can remove a word, not only add one.
 * `.partial()` at every level; an unknown key is a validation error, so a
 * typo in a list name is reported, never silently ignored.
 */
export const ValueRulesSchema = z
  .object({
    values: z
      .object({
        keyFieldWords: words,
        qaKeyPrefixes: words,
        nonExistingWords: words,
        describedValueWords: words,
        alreadyExistsWords: words,
        blankWords: words,
        noteIntroducers: words,
        boundWords: words,
        exampleIntroducers: words,
        formatWords: z.object({ digitUnits: words, leadingDigit: words, lengthUnits: words, over: words, under: words }).strict().optional(),
        dates: z
          .object({
            today: words, tomorrow: words, yesterday: words, future: words, past: words,
            thisMonth: words, nextMonth: words, previousMonth: words, before: words, after: words, at: words,
            prefixes: words, exact: words, back: words, forward: words,
            units: z.object({ day: words, week: words, month: words, year: words }).strict().optional(),
            birthFieldWords: words, ageWords: words, ageUnder: words, ageOver: words, ageAtLeast: words, ageAtMost: words, ageExact: words,
            ageAnchorFields: words,
          })
          .strict()
          .optional(),
        fieldAliases: wordGroups,
      })
      .strict()
      .optional(),
    authoring: z
      .object({
        attachmentWords: words,
        script: z.object({ typing: words, choosing: words, acting: words, routeLine: words, stepWords: words, skipWords: words }).strict().optional(),
        wordingClaim: words,
        matchClaim: z.object({ agree: words, unchanged: words, readings: words, quantities: words }).strict().optional(),
        openQuestionPrefixes: words,
        sheetNote: z.object({ cancelled: words, notYet: words, retest: words }).strict().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ValueRulesOverride = z.infer<typeof ValueRulesSchema>;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Objects merge key by key; an array in the override REPLACES the built-in list; an absent key keeps the built-in. */
function mergeRules<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) return (override === undefined ? base : override) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = mergeRules(base[key], value);
  }
  return out as T;
}

/** The built-ins with an override applied. Pure. */
export function withOverride(override: ValueRulesOverride | undefined, base: ValueRules = DEFAULT_VALUE_RULES): ValueRules {
  return override === undefined ? base : mergeRules(base, override);
}

/**
 * The built-ins merged with `.wowlidator/value-rules.json` when the file
 * exists. An unreadable or invalid file is ONE stderr warning and the
 * built-ins — never a throw: a typo in a word list must not stop a run.
 */
export function loadValueRules(cwd: string = process.cwd()): ValueRules {
  const path = resolve(cwd, VALUE_RULES_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return DEFAULT_VALUE_RULES;
  }
  try {
    const parsed = ValueRulesSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      process.stderr.write(`wowlidator: ${VALUE_RULES_FILE} ignored — ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}\n`);
      return DEFAULT_VALUE_RULES;
    }
    return withOverride(parsed.data);
  } catch (error) {
    process.stderr.write(`wowlidator: ${VALUE_RULES_FILE} ignored — ${error instanceof Error ? error.message : String(error)}\n`);
    return DEFAULT_VALUE_RULES;
  }
}

// --- compiling the authoring half ---------------------------------------------------

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isWordChar = (ch: string): boolean => /[A-Za-z0-9]/.test(ch);
const hasThai = (w: string): boolean => /\p{Script=Thai}/u.test(w);
/** A Latin word sits on word boundaries; Thai has none, so a Thai word is a substring. */
export function boundedWord(w: string): string {
  const body = escapeRe(w);
  const head = isWordChar(w[0]!) ? '\\b' : '';
  const tail = isWordChar(w[w.length - 1]!) ? '\\b' : '';
  return `${head}${body}${tail}`;
}
/** Longest first, so a longer phrase is tried before the word it starts with. */
const longestFirst = (list: readonly string[]): string[] => [...new Set(list)].sort((a, b) => b.length - a.length);
/** `(?:a|b|c)` of bounded literals; `(?!)` (matches nothing) when the list is empty. */
export function wordAlternation(list: readonly string[], each: (w: string) => string = boundedWord): string {
  const parts = longestFirst(list).map(each);
  return parts.length === 0 ? '(?!)' : `(?:${parts.join('|')})`;
}
/**
 * A verb of the Steps column: Thai after a line start, whitespace, a bullet
 * or a step number (so a verb glued to the previous word is not read out of
 * it); Latin on word boundaries. The same anchoring the lints always used.
 */
const scriptVerb = (w: string): string => (hasThai(w) ? `(?:^|[\\s\\-•\\d.)])${escapeRe(w)}` : boundedWord(w));

export interface CompiledAuthoringRules {
  attachment: RegExp;
  script: {
    /** The verbs of each tier, in the order they are judged: typing, choosing, acting. */
    typing: RegExp;
    choosing: RegExp;
    acting: RegExp;
    /** A whole script line that only names the page to open. */
    routeLine: RegExp;
    /**
     * A step citation in an intent or goal: group 1 is the skip word when the
     * citation marks a skip, group 2 the step number. Global; run with `matchAll`.
     */
    citation: RegExp;
  };
  wordingClaim: RegExp;
  matchClaim: RegExp;
  /** An id that carries one of the open-question prefixes. */
  openQuestion: RegExp;
  /** The same, anchored at the start of a value (`^\s*OQ-…`). */
  openQuestionAtStart: RegExp;
  sheetNote: { cancelled: RegExp; notYet: RegExp; retest: RegExp };
}

/** The regexes the lints run, built once from the rules. Pure. */
export function compileAuthoringRules(rules: AuthoringRules = DEFAULT_AUTHORING_RULES): CompiledAuthoringRules {
  const s = rules.script;
  const m = rules.matchClaim;
  const prefixes = wordAlternation(rules.openQuestionPrefixes, escapeRe);
  const openQuestionBody = `${prefixes}[A-Za-z]+-\\d+\\b`;
  const stepWord = wordAlternation(s.stepWords);
  const skipWord = wordAlternation(s.skipWords);
  return {
    attachment: new RegExp(wordAlternation(rules.attachmentWords), 'iu'),
    script: {
      typing: new RegExp(wordAlternation(s.typing, scriptVerb), 'iu'),
      choosing: new RegExp(wordAlternation(s.choosing, scriptVerb), 'iu'),
      acting: new RegExp(wordAlternation(s.acting, scriptVerb), 'iu'),
      routeLine: new RegExp(`^\\s*[-•\\d.)\\s]*${wordAlternation(s.routeLine, (w) => (hasThai(w) ? escapeRe(w) : `${boundedWord(w)}`))}`, 'iu'),
      citation: new RegExp(`(?:(${skipWord})\\s+)?${stepWord}\\s*(\\d{1,2})\\b`, 'giu'),
    },
    wordingClaim: new RegExp(wordAlternation(rules.wordingClaim), 'iu'),
    matchClaim: new RegExp(
      `${wordAlternation(m.agree)}[^.\\n]{0,80}${wordAlternation(m.readings)}` +
        `|${wordAlternation(m.unchanged)}[^.\\n]{0,60}${wordAlternation(m.quantities)}` +
        `|${wordAlternation(m.quantities)}[^.\\n]{0,60}${wordAlternation(m.unchanged)}`,
      'iu',
    ),
    openQuestion: new RegExp(`\\b${openQuestionBody}`, 'u'),
    openQuestionAtStart: new RegExp(`^\\s*${openQuestionBody}`, 'u'),
    sheetNote: {
      cancelled: new RegExp(wordAlternation(rules.sheetNote.cancelled), 'iu'),
      notYet: new RegExp(wordAlternation(rules.sheetNote.notYet), 'iu'),
      retest: new RegExp(wordAlternation(rules.sheetNote.retest), 'iu'),
    },
  };
}

/**
 * The open-question ids a case names STRUCTURALLY — an id-shaped token the
 * sheet writes right after its `?` (`… = ? OQ-HIR-140`, `= ? CF-HIR-08
 * OQ-HIR-50`). Needs no prefix list: whatever id family a sheet uses for its
 * questions, the `?` is what says "nobody knows yet".
 */
export function openQuestionIdsIn(caseText: string): Set<string> {
  const ids = new Set<string>();
  for (const m of caseText.matchAll(/\?\s*((?:[A-Z]{2,6}-)+\d+(?:\s+(?:[A-Z]{2,6}-)+\d+)*)/g)) {
    for (const id of (m[1] ?? '').split(/\s+/)) if (id !== '') ids.add(id);
  }
  return ids;
}

/** The rules, loaded once per process from the built-ins plus the project's file. */
export const VALUE_RULES: ValueRules = loadValueRules();
/** The authoring half of `VALUE_RULES`, compiled once. */
export const AUTHORING: CompiledAuthoringRules = compileAuthoringRules(VALUE_RULES.authoring);
