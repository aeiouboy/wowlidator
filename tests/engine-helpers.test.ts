/**
 * The engine helpers landed for the HR-workbook programme (2026-09-03):
 * value normalisation, the dates a sheet writes, `{{date:…}}` / `{{x+1}}`
 * tokens, the cache key's page params, the listbox driver, the calendar
 * driver, field-scoped errors, uploads/downloads, the not-found surface,
 * Thai dismiss names, and the healer's visibility check + `required` flag.
 *
 * Two tiers, same rule as everywhere else:
 *   - unit: everything pure runs always — normalise, dates, variables,
 *     scopeUrl, the patterns, prompt text.
 *   - browser: that a searchable listbox filters, a dependent list fills
 *     late, a calendar navigates, a file input takes a file, a 404 renders in
 *     place — those are facts about a real page and need one. Fixtures are
 *     shaped like humi-SIT's primitives (custom-select, HumiSearchableSelect,
 *     searchable-multi-select, DateField, FormField, AttachmentDropzone,
 *     not-found.tsx), because those are the controls the 1,300 cases meet.
 *
 *   npm test                                 # unit + browser (if Chrome is up)
 *   WOWLIDATOR_CDP_URL=http://localhost:9222 npm test
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import { chromium } from 'playwright';

import { CacheManager, scopeUrl } from '../src/cache/cache-manager.js';
import { UnknownVariableError, VariableStore, firstInteger } from '../src/api/variables.js';
import { codeAndLabelOf, foldValue, foldedIncludes, foldedMatch, valueEquivalents } from '../src/engine/normalise.js';
import {
  dateBuiltin,
  dateRenderings,
  formatDate,
  isoDateOf,
  monthYearOf,
  resolveDateExpression,
} from '../src/engine/dates.js';
import { headRoleOf, optionNamePatterns, targetsPopupContent } from '../src/engine/selector.js';
import {
  ListboxOptionDisabledError,
  ListboxOptionMissingError,
  optionCandidates,
  uniquePrefixMatch,
  selectFromListbox,
  splitMultiValue,
} from '../src/engine/listbox.js';
import { DateOutOfRangeError, pickDateInDialog, showsDate } from '../src/engine/calendar.js';
import { readFieldError, readFieldRequired } from '../src/engine/field-error.js';
import { FixtureMissingError, attachFiles, captureDownload } from '../src/engine/upload.js';
import { NOT_FOUND_HEADING_PATTERN, notFoundSurface } from '../src/engine/not-found.js';
import {
  AFFIRMATIVE_DISMISS_NAME_PATTERN,
  DISMISS_NAME_PATTERN,
  NEUTRAL_DISMISS_NAME_PATTERN,
  describeDialog,
  dialogIsIntendedContext,
  dialogMentions,
  findDismissButton,
  openDialogNow,
  selectorInsideDialog,
} from '../src/engine/modal.js';
import { foldValue as goalFoldValue } from '../src/orchestrator/goal-evidence.js';
import {
  JitHealer,
  buildUserPrompt,
  captureAxTree,
  formatAxNode,
  type HealRequest,
  type HealerModel,
} from '../src/healer/jit-healer.js';

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';

// --- Unit tier -------------------------------------------------------------

describe('normalise: foldValue is a superset of goal-evidence\'s', () => {
  it('agrees with goal-evidence on its inputs', () => {
    for (const input of ['A - Permanent', 'A — Permanent', 'A-Permanent', 'Female', '  New  Hire ', 'H_NEWHIRE — New Hire']) {
      assert.equal(foldValue(input), goalFoldValue(input), input);
    }
    assert.equal(foldValue('A-Permanent'), 'a - permanent');
    assert.equal(foldValue('A - Permanent'), foldValue('A — Permanent'));
  });

  it('folds money, quotes and number formatting the sheets write', () => {
    assert.equal(foldValue('฿30,000.00'), foldValue('30,000.00'));
    assert.equal(foldValue('30,000.00'), '30000');
    assert.equal(foldValue('THB 1,234,567.50'), '1234567.50');
    assert.equal(foldValue('"Active"'), 'active');
    assert.equal(foldValue('“Active”'), 'active');
    assert.equal(foldValue('1, 2, 3'), '1, 2, 3', 'a list keeps its commas');
  });

  it('never folds script — Thai and Latin are not one value', () => {
    assert.notEqual(foldValue('สมชาย'), foldValue('Somchai'));
    assert.equal(foldValue('กรุงเทพมหานคร'), 'กรุงเทพมหานคร');
  });

  it('splits code and label the three ways the page renders them', () => {
    assert.deepEqual(codeAndLabelOf('A - Permanent'), { code: 'A', label: 'Permanent' });
    assert.deepEqual(codeAndLabelOf('H_NEWHIRE — New Hire'), { code: 'H_NEWHIRE', label: 'New Hire' });
    assert.deepEqual(codeAndLabelOf('A (Active)'), { code: 'A', label: 'Active' });
    assert.deepEqual(codeAndLabelOf('Contract- Yearly (C2)'), { code: 'C2', label: 'Contract- Yearly' });
    assert.deepEqual(codeAndLabelOf('40106337 (Job Title)'), { code: '40106337', label: 'Job Title' });
    assert.equal(codeAndLabelOf('Active'), null);
    assert.deepEqual(valueEquivalents('A - Permanent'), ['a - permanent', 'a', 'permanent']);
  });

  it('compares the way the sheet reads it, never plain substring', () => {
    assert.equal(foldedMatch('Active', 'A (Active)'), 'contains');
    assert.equal(foldedMatch('A (Active)', 'Active'), 'label');
    assert.equal(foldedMatch('A - Permanent', 'A — Permanent'), 'exact');
    assert.equal(foldedMatch('30,000.00', 'Amount ฿30,000.00'), 'contains');
    assert.equal(foldedMatch('Male', 'Female'), null, 'Male is not inside Female');
    assert.equal(foldedMatch('Inactive', 'Status INACTIVE'), 'contains');
    assert.ok(foldedIncludes('Event Reason\nH_NEWHIRE — New Hire', 'New Hire'));
    assert.ok(!foldedIncludes('Rehire', 'hire'));
  });
});

describe('dates: isoDateOf is a superset of the runner\'s', () => {
  it('keeps every answer the runner gave', () => {
    assert.equal(isoDateOf('01 Sep 2027'), '2027-09-01');
    assert.equal(isoDateOf('1 Sep 2027'), '2027-09-01');
    assert.equal(isoDateOf('1 September 2027'), '2027-09-01');
    assert.equal(isoDateOf('Sep 1, 2027'), '2027-09-01');
    assert.equal(isoDateOf('2027-09-01'), '2027-09-01');
    assert.equal(isoDateOf('01/09/2027'), null, 'January or September — never guessed');
    assert.equal(isoDateOf('New Hire'), null);
    assert.equal(isoDateOf('32 Sep 2027'), null);
  });

  it('reads Thai months and converts their Buddhist year', () => {
    assert.equal(isoDateOf('15 ก.ย. 2569'), '2026-09-15');
    assert.equal(isoDateOf('15 กันยายน 2569'), '2026-09-15');
    assert.equal(isoDateOf('1 มี.ค. 2570'), '2027-03-01');
    assert.equal(isoDateOf('15 ก.ย. 2026'), '2026-09-15', 'a CE year beside a Thai month stays');
  });

  it('reads dd/mm/yyyy under a locale, or when the day part is unambiguous', () => {
    assert.equal(isoDateOf('01/09/2027', 'th'), '2027-09-01');
    assert.equal(isoDateOf('01/09/2027', 'en-GB'), '2027-09-01');
    assert.equal(isoDateOf('01/09/2027', 'en-US'), '2027-01-09');
    assert.equal(isoDateOf('01/09/2027', 'en'), null);
    assert.equal(isoDateOf('31/12/9999'), '9999-12-31', 'the sentinel is unambiguous everywhere');
    assert.equal(isoDateOf('25-12-2027'), '2027-12-25');
    assert.equal(isoDateOf('01.02.2021', 'th'), '2021-02-01');
  });

  it('converts a Buddhist year only under th — HIR-EC-024 types 2567 to be rejected', () => {
    assert.equal(isoDateOf('01/02/2567', 'th'), '2024-02-01');
    assert.equal(isoDateOf('01/02/2567', 'en-GB'), '2567-02-01');
    assert.equal(isoDateOf('2569-09-15', 'th'), '2026-09-15');
    assert.equal(isoDateOf('2569-09-15'), '2569-09-15');
  });

  it('reads a calendar heading in either language', () => {
    assert.deepEqual(monthYearOf('September 2027'), { year: 2027, month: 9 });
    assert.deepEqual(monthYearOf('Previous month\nSep 2027\nNext month'), { year: 2027, month: 9 });
    assert.deepEqual(monthYearOf('กันยายน 2570'), { year: 2027, month: 9 });
    assert.equal(monthYearOf('Today Clear'), null);
  });

  it('resolves the relative tokens the sheets write', () => {
    const now = new Date(2026, 8, 3); // 3 Sep 2026, local
    assert.equal(resolveDateExpression('today', now), '2026-09-03');
    assert.equal(resolveDateExpression('Today+30d', now), '2026-10-03');
    assert.equal(resolveDateExpression('today+119d', now), '2026-12-31');
    assert.equal(resolveDateExpression('today-1y', now), '2025-09-03');
    assert.equal(resolveDateExpression('+30 Day', now), '2026-10-03');
    assert.equal(resolveDateExpression('next day', now), '2026-09-04');
    assert.equal(resolveDateExpression('Next day+1', now), '2026-09-05');
    assert.equal(resolveDateExpression('monthEnd', now), '2026-09-30');
    assert.equal(resolveDateExpression('nextMonthEnd', now), '2026-10-31');
    assert.equal(resolveDateExpression('day(25)', now), '2026-09-25');
    assert.equal(resolveDateExpression('2027-09-01', now), '2027-09-01');
    assert.equal(resolveDateExpression('2027-01-31+1m', now), '2027-02-28', 'month offsets clamp the day');
    assert.equal(resolveDateExpression('31/12/9999', now), '9999-12-31');
    assert.equal(resolveDateExpression('yesterweek', now), null);
    assert.equal(resolveDateExpression('today+3 fortnights', now), null);
  });

  it('renders a date the way a page shows it', () => {
    assert.equal(formatDate('2026-09-15'), '2026-09-15');
    assert.equal(formatDate('2026-09-15', 'dd/MM/yyyy'), '15/09/2026');
    assert.equal(formatDate('2026-09-15', 'd MMM yyyy'), '15 Sep 2026');
    assert.equal(formatDate('2026-09-15', 'short', 'th'), '15 ก.ย. 2569', "humi's formatThaiDate");
    assert.equal(formatDate('2026-09-15', 'long', 'th'), '15 กันยายน 2569');
    assert.equal(formatDate('9999-12-31', 'slash', 'th'), '31/12/9999', 'the sentinel year is never shifted');
    assert.ok(dateRenderings('2026-09-15').includes('15 ก.ย. 2569'));
    assert.equal(dateBuiltin('today+30d|dd/MM/yyyy', new Date(2026, 8, 3)), '03/10/2026');
    assert.equal(dateBuiltin('monthEnd|short|th', new Date(2026, 8, 3)), '30 ก.ย. 2569');
    assert.equal(dateBuiltin('nonsense', new Date(2026, 8, 3)), null);
  });

  it('recognises its own entry on a trigger', () => {
    assert.ok(showsDate('15 ก.ย. 2569', '2026-09-15'));
    assert.ok(showsDate('15 Sep 2026', '2026-09-15'));
    assert.ok(showsDate('15/09/2026', '2026-09-15'));
    assert.ok(!showsDate('Select date', '2026-09-15'));
    assert.ok(!showsDate('16 Sep 2026', '2026-09-15'));
  });
});

describe('variables: {{date:…}} builtins and {{x+N}} arithmetic', () => {
  const now = () => new Date(2026, 8, 3);

  it('resolves date tokens at interpolation time', () => {
    const store = new VariableStore({ now });
    assert.equal(store.interpolate('{{date:today}}'), '2026-09-03');
    assert.equal(store.interpolate('Hire Date {{date:today+30d}}'), 'Hire Date 2026-10-03');
    assert.equal(store.interpolate('{{ date: monthEnd | dd/MM/yyyy }}'), '30/09/2026');
    assert.equal(store.interpolate('{{date:31/12/9999}}'), '9999-12-31');
    assert.throws(() => store.interpolate('{{date:yesterweek}}'), UnknownVariableError);
    assert.throws(() => store.interpolate('{{clock:now}}'), UnknownVariableError, 'an unknown builtin is a stray brace pair');
  });

  it('adds and subtracts from a saved number, keeping its style', () => {
    const store = new VariableStore();
    store.set('before_total', '75');
    store.set('rows-before', '1,234 rows');
    store.set('pending', 'Pending 1D 0h');
    store.set('label', 'Active');
    assert.equal(store.interpolate('{{before_total+1}}'), '76');
    assert.equal(store.interpolate('{{ before_total - 1 }}'), '74');
    assert.equal(store.interpolate('{{before_total}}'), '75');
    assert.equal(store.interpolate('{{rows-before+1}}'), '1,235 rows', 'thousands separators survive');
    assert.equal(store.interpolate('{{rows-before-1}}'), '1,233 rows', 'a hyphenated name followed by -N is arithmetic');
    assert.equal(store.interpolate('{{pending+1}}'), 'Pending 2D 0h');
    assert.throws(() => store.interpolate('{{label+1}}'), /is not a number/);
    assert.throws(() => store.interpolate('{{missing+1}}'), UnknownVariableError);
    assert.deepEqual(firstInteger('-3 left'), { start: 0, end: 2, n: -3, grouped: false });
    assert.equal(firstInteger('none'), null);
  });
});

describe('listbox: uniquePrefixMatch is the one option that starts with the value', () => {
  it('picks the single prefix match, in either half of a code - label name', () => {
    assert.equal(uniquePrefixMatch(['Thailand - Thailand', 'Taiwan - Taiwan'], 'Thai'), 'Thailand - Thailand');
    assert.equal(uniquePrefixMatch(['TH - Thailand', 'TW - Taiwan'], 'thai'), 'TH - Thailand');
    assert.equal(uniquePrefixMatch(['  New  Hire  '], 'new hire'), null, 'a whole match is the rung above, not a prefix');
  });

  it('never a substring and never one of several', () => {
    assert.equal(uniquePrefixMatch(['Male', 'Female'], 'Male'), null, '"Male" is whole, "Female" is not a prefix match');
    assert.equal(uniquePrefixMatch(['Female'], 'Male'), null, 'a substring is not a prefix');
    assert.equal(uniquePrefixMatch(['New Hire — A', 'New Hire — B'], 'New Hire'), null, 'two prefix matches decide nothing');
    assert.equal(uniquePrefixMatch(['Assistant Store Manager'], 'A'), null, 'one character is not a value');
    assert.equal(uniquePrefixMatch([], 'Thai'), null);
  });
});

describe('cache: scopeUrl keeps the page-naming params only', () => {
  it('drops navigation and tracking noise, keeps ?step= and friends, sorted', () => {
    assert.equal(scopeUrl('https://example.test/login?next=/home'), 'https://example.test/login');
    assert.equal(scopeUrl('https://example.test/admin/hire?utm_source=x&step=2'), 'https://example.test/admin/hire?step=2');
    assert.equal(scopeUrl('https://example.test/plans?tab=rules&page=2'), 'https://example.test/plans?page=2&tab=rules');
    assert.equal(scopeUrl('https://example.test/plans/?tab=rules'), 'https://example.test/plans?tab=rules');
    assert.notEqual(CacheManager.key('https://example.test/hire?step=1', '#x'), CacheManager.key('https://example.test/hire?step=2', '#x'));
    assert.equal(scopeUrl('not a url'), 'not a url');
  });
});

describe('selector: option-name patterns and popup-only roles', () => {
  it('matches the whole name, then a whole word, dash-folded', () => {
    const [exact, contains] = optionNamePatterns('A - Permanent');
    assert.ok(exact.test('A — Permanent'));
    assert.ok(exact.test('  a-permanent '));
    assert.ok(!exact.test('AB — Permanent'));
    assert.ok(contains.test('Group: A — Permanent (default)'));
    const [, male] = optionNamePatterns('Male');
    assert.ok(!male.test('Female'));
    assert.ok(male.test('Male ✓'));
    const [, thai] = optionNamePatterns('กรุงเทพมหานคร');
    assert.ok(thai.test('10 — กรุงเทพมหานคร'));
  });

  it('names the head role and knows which live inside a popup', () => {
    assert.equal(headRoleOf('role=option[name="X"] >> nth=0'), 'option');
    assert.equal(headRoleOf('#x'), null);
    assert.ok(targetsPopupContent('role=option[name="New Hire" i]'));
    assert.ok(targetsPopupContent('role=menuitem[name="Delete"]'));
    assert.ok(!targetsPopupContent('role=button[name="Gender" i]'));
    assert.deepEqual(splitMultiValue('CDS (C001), B2S (C006)'), ['CDS (C001)', 'B2S (C006)']);
    assert.deepEqual(splitMultiValue('A - Permanent'), ['A - Permanent'], 'a dash never splits');
    assert.deepEqual(optionCandidates('A - Permanent').map((c) => c.by), ['whole', 'code', 'label']);
  });
});

describe('not-found and modal patterns', () => {
  it('recognises a missing-page heading in either language, and not a toast', () => {
    for (const heading of ['404 — ไม่พบหน้าที่ค้นหา', 'หน้านี้ถูกย้ายหรือลบไปแล้ว', 'Page not found', '404', 'This page could not be found', 'Error 404: Not Found']) {
      assert.ok(NOT_FOUND_HEADING_PATTERN.test(heading), heading);
    }
    for (const text of ['No options found', 'ไม่พบข้อมูล', '1404 rows', 'Employee E404 profile', 'Not found in table']) {
      assert.ok(!NOT_FOUND_HEADING_PATTERN.test(text), text);
    }
  });

  it('splits dismiss names into neutral and affirmative, with Thai', () => {
    for (const name of ['Close', 'Cancel', 'ปิด', 'ยกเลิก', 'ย้อนกลับ', 'Not now']) {
      assert.ok(NEUTRAL_DISMISS_NAME_PATTERN.test(name), name);
      assert.ok(!AFFIRMATIVE_DISMISS_NAME_PATTERN.test(name), name);
    }
    for (const name of ['OK', 'Continue', 'Accept all', 'ตกลง', 'รับทราบ', 'ยอมรับ']) {
      assert.ok(AFFIRMATIVE_DISMISS_NAME_PATTERN.test(name), name);
      assert.ok(!NEUTRAL_DISMISS_NAME_PATTERN.test(name), name);
      assert.ok(DISMISS_NAME_PATTERN.test(name), name);
    }
    assert.ok(!DISMISS_NAME_PATTERN.test('Delete plan'));
    assert.ok(!DISMISS_NAME_PATTERN.test('ยืนยันการปฏิเสธ'));
  });

  it('treats any interaction as the context an open dialog belongs to', () => {
    for (const action of ['click', 'press', 'fill', 'type', 'selectOption', 'check', 'expectModal']) {
      assert.ok(dialogIsIntendedContext(action), action);
    }
    assert.ok(!dialogIsIntendedContext('goto'));
    assert.ok(!dialogIsIntendedContext(null));
  });
});

describe('healer: the prompt says what an entry step needs; the tree says required', () => {
  const request: HealRequest = {
    failedSelector: 'role=combobox[name="Employee Group"]',
    action: 'selectOption',
    url: 'http://localhost/hire',
    axTree: 'button "Employee Group" value="— Select —"',
  };

  it('adds one line for an entry step and none otherwise — identical inputs stay byte-identical', () => {
    assert.equal(buildUserPrompt(request), buildUserPrompt({ ...request }));
    assert.doesNotMatch(buildUserPrompt(request), /ENTERS a value/);
    const withEntry = buildUserPrompt({ ...request, entry: 'A - Permanent' });
    assert.match(withEntry, /This step ENTERS a value \("A - Permanent"\)/);
    assert.ok(withEntry.indexOf('ENTERS a value') < withEntry.indexOf('Accessibility tree:'), 'before the tree');
    assert.doesNotMatch(buildUserPrompt({ ...request, action: 'click', entry: 'x' }), /ENTERS a value/);
  });

  it('renders required on a node', () => {
    assert.equal(
      formatAxNode({ role: 'textbox', name: 'Bank', value: '', description: '', disabled: false, checked: false, required: true, url: '' }),
      'textbox "Bank" required',
    );
  });
});

// --- Browser tier ----------------------------------------------------------

const FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>engine helpers fixture</title>
  <style>[hidden]{display:none!important} .popup{border:1px solid #999;padding:4px;background:#fff} button[disabled]{opacity:.4}</style>
  </head>
  <body>
    <!-- custom-select (searchable): trigger + input above ul[role=listbox] -->
    <span id="grp-label">Employee Group</span>
    <button id="grp" type="button" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="grp-label">— Select —</button>
    <div id="grp-pop" class="popup" hidden>
      <input id="grp-search" type="text" placeholder="Type to search...">
      <ul id="grp-list" role="listbox" aria-labelledby="grp-label"></ul>
    </div>

    <!-- HumiSearchableSelect shape: portaled to body with a Thai search box; District depends on Province -->
    <button id="province" type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="Province">Select Province</button>
    <button id="district" type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="District">Select District</button>

    <!-- searchable-multi-select: checkbox rows -->
    <button id="company" type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="Company">Select companies</button>
    <ul id="company-list" role="listbox" hidden>
      <li role="option"><label><input type="checkbox" value="C001"> CDS (C001)</label></li>
      <li role="option"><label><input type="checkbox" value="C006"> B2S (C006)</label></li>
      <li role="option"><label><input type="checkbox" value="C009"> OfficeMate (C009)</label></li>
    </ul>

    <button id="gender" type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="Gender">Select Gender</button>
    <ul id="gender-list" role="listbox" hidden>
      <li role="option" tabindex="-1">Female</li>
      <li role="option" tabindex="-1">Male</li>
    </ul>

    <!-- DateField: button[aria-haspopup=dialog] → role=dialog calendar -->
    <button id="hire-date" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="Hire Date">Select date</button>
    <button id="start-date" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="วันที่มีผล">เลือกวันที่</button>

    <!-- FormField: label + control + aria-describedby message -->
    <div class="field">
      <label for="plan-name">Plan Name<span aria-hidden="true" class="text-danger">*</span></label>
      <input id="plan-name" aria-required="true" aria-invalid="true" aria-describedby="plan-name-help plan-name-error">
      <p id="plan-name-help">Up to 50 characters</p>
      <p id="plan-name-error" role="alert">Plan Name is required</p>
    </div>
    <div class="field">
      <label for="amount">Amount</label>
      <input id="amount">
      <p class="hint">In baht</p>
    </div>
    <div class="field">
      <label for="grade">Personal Grade</label>
      <input id="grade">
      <p class="text-xs text-danger">กรุณาระบุ Personal Grade</p>
    </div>
    <div class="field">
      <label for="bank">Bank</label>
      <input id="bank" required>
    </div>

    <!-- AttachmentDropzone / FileUploadField / a chooser button -->
    <div id="dropzone" tabindex="0"><p>Click or drag file here</p><input id="import-file" type="file" accept=".csv" style="display:none"></div>
    <label for="cert-file">Medical certificate</label><input id="cert-file" type="file" hidden>
    <button id="choose-btn" type="button">Choose file</button><input id="chooser-input" type="file" hidden>
    <a id="download-link" href="/sample.csv" download="sample.csv">Download Sample CSV</a>
    <p id="upload-status">none</p>

    <!-- Thai dialogs -->
    <button id="open-delete" type="button">ลบแผน</button>
    <div id="delete-dialog" role="dialog" hidden>
      <div class="eyebrow">Benefit Plan · PL_07_01</div>
      <h2>ยืนยันการลบแผน</h2>
      <p>แผนจะถูกลบถาวร</p>
      <button type="button" id="delete-cancel">ยกเลิก</button>
      <button type="button" id="delete-ok">ตกลง</button>
    </div>
    <button id="open-wizard" type="button">Wizard</button>
    <div id="wizard-dialog" role="dialog" aria-label="Wizard" hidden>
      <p>Step 1 of 2</p>
      <input id="wizard-name" aria-label="Rule name">
      <button type="button">ดำเนินการต่อ</button>
    </div>
    <button id="open-cookie" type="button">Cookie</button>
    <div id="cookie-dialog" role="dialog" hidden>
      <p>เว็บไซต์นี้ใช้คุกกี้ (PDPA consent)</p>
      <button type="button">ยอมรับ</button>
    </div>

    <div hidden><button id="hidden-only" type="button">Hidden only</button></div>
    <p id="status">idle</p>

    <script>
      var setStatus = function (t) { document.getElementById('status').textContent = t; };
      // --- custom-select
      var grpOptions = [
        { code: 'A', label: 'Permanent' }, { code: 'B', label: 'Temporary' },
        { code: 'C', label: 'Contract', disabled: true }, { code: 'AB', label: 'Apprentice' }
      ];
      var grp = document.getElementById('grp'), grpPop = document.getElementById('grp-pop');
      var grpList = document.getElementById('grp-list'), grpSearch = document.getElementById('grp-search');
      function renderGrp() {
        var filter = grpSearch.value.toLowerCase();
        grpList.innerHTML = '';
        var shown = grpOptions.filter(function (o) { return (o.code + ' — ' + o.label).toLowerCase().indexOf(filter) >= 0; });
        if (!shown.length) { var li0 = document.createElement('li'); li0.textContent = 'No options'; grpList.appendChild(li0); return; }
        shown.forEach(function (o) {
          var li = document.createElement('li'); li.setAttribute('role', 'option'); li.textContent = o.code + ' — ' + o.label;
          if (o.disabled) li.setAttribute('aria-disabled', 'true');
          li.addEventListener('click', function () {
            if (o.disabled) return;
            grp.textContent = o.code + ' — ' + o.label; grpPop.hidden = true; grp.setAttribute('aria-expanded', 'false');
            setStatus('grp:' + o.code);
          });
          grpList.appendChild(li);
        });
      }
      grp.addEventListener('click', function () {
        var open = grpPop.hidden; grpPop.hidden = !open; grp.setAttribute('aria-expanded', String(open));
        if (open) { grpSearch.value = ''; renderGrp(); setTimeout(function () { grpSearch.focus(); }, 10); }
      });
      grpSearch.addEventListener('input', renderGrp);
      // --- portaled searchable selects (Province → District)
      var provinces = ['กรุงเทพมหานคร', 'เชียงใหม่', 'ภูเก็ต'];
      var districts = { 'กรุงเทพมหานคร': ['บางรัก', 'ปทุมวัน', 'บางนา'], 'เชียงใหม่': ['เมืองเชียงใหม่', 'สันทราย'], 'ภูเก็ต': ['เมืองภูเก็ต'] };
      var chosenProvince = null;
      function portalSelect(btn, getOptions, onPick, delayMs) {
        var portal = null;
        function close() { if (portal) { portal.remove(); portal = null; } btn.setAttribute('aria-expanded', 'false'); }
        btn.addEventListener('click', function () {
          if (portal) { close(); return; }
          btn.setAttribute('aria-expanded', 'true');
          portal = document.createElement('div'); portal.className = 'popup'; portal.style.position = 'fixed'; portal.style.top = '10px'; portal.style.left = '10px'; portal.style.zIndex = '9999';
          var bar = document.createElement('div'); var input = document.createElement('input'); input.type = 'text';
          input.placeholder = 'ค้นหา...'; input.setAttribute('aria-label', 'ค้นหาตัวเลือก');
          bar.appendChild(input); portal.appendChild(bar);
          var ul = document.createElement('ul'); ul.setAttribute('role', 'listbox'); portal.appendChild(ul);
          document.body.appendChild(portal);
          var options = null;
          function render() {
            ul.innerHTML = '';
            if (options === null) { var w = document.createElement('li'); w.textContent = 'Loading...'; ul.appendChild(w); return; }
            var f = input.value; var shown = options.filter(function (o) { return o.indexOf(f) >= 0; });
            if (!shown.length) { var e = document.createElement('li'); e.textContent = 'ไม่พบข้อมูล'; ul.appendChild(e); return; }
            shown.forEach(function (o) {
              var li = document.createElement('li'); li.setAttribute('role', 'option'); li.textContent = o;
              li.addEventListener('click', function () { btn.textContent = o; onPick(o); close(); });
              ul.appendChild(li);
            });
          }
          input.addEventListener('input', render);
          render();
          setTimeout(function () { options = getOptions(); render(); }, delayMs);
          setTimeout(function () { input.focus(); }, 10);
        });
      }
      portalSelect(document.getElementById('province'), function () { return provinces; }, function (p) { chosenProvince = p; document.getElementById('district').textContent = 'Select District'; setStatus('province:' + p); }, 0);
      portalSelect(document.getElementById('district'), function () { return chosenProvince ? districts[chosenProvince] : []; }, function (d) { setStatus('district:' + d); }, 300);
      // --- multi-select
      var company = document.getElementById('company'), companyList = document.getElementById('company-list');
      company.addEventListener('click', function () { var open = companyList.hidden; companyList.hidden = !open; company.setAttribute('aria-expanded', String(open)); });
      companyList.addEventListener('change', function () {
        var picked = Array.prototype.map.call(companyList.querySelectorAll('input:checked'), function (c) { return c.parentElement.textContent.trim(); });
        company.textContent = picked.length ? picked.join(', ') : 'Select companies';
      });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { companyList.hidden = true; company.setAttribute('aria-expanded', 'false'); genderList.hidden = true; gender.setAttribute('aria-expanded', 'false'); grpPop.hidden = true; grp.setAttribute('aria-expanded', 'false'); } });
      // --- gender
      var gender = document.getElementById('gender'), genderList = document.getElementById('gender-list');
      gender.addEventListener('click', function () { var open = genderList.hidden; genderList.hidden = !open; gender.setAttribute('aria-expanded', String(open)); });
      Array.prototype.forEach.call(genderList.querySelectorAll('[role=option]'), function (li) {
        li.addEventListener('click', function () { gender.textContent = li.textContent; genderList.hidden = true; gender.setAttribute('aria-expanded', 'false'); setStatus('gender:' + li.textContent); });
      });
      // --- DateField calendars (day view + month view, humi shape)
      var EN = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      var ENS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      var TH = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
      var THS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
      function dateField(btn, locale, initial, min, max) {
        var th = locale === 'th';
        var copy = th
          ? { calendar: 'ปฏิทิน', prev: 'เดือนก่อนหน้า', next: 'เดือนถัดไป', selMonth: 'เลือกเดือน', selYear: 'เลือกปี', prevYear: 'ปีก่อนหน้า', nextYear: 'ปีถัดไป', today: 'วันนี้', clear: 'ล้าง' }
          : { calendar: 'Calendar', prev: 'Previous month', next: 'Next month', selMonth: 'Select month', selYear: 'Select year', prevYear: 'Previous year', nextYear: 'Next year', today: 'Today', clear: 'Clear' };
        var yearOf = function (y) { return th ? y + 543 : y; };
        var view = { y: initial.getFullYear(), m: initial.getMonth() }, mode = 'day', popup = null, value = null;
        function label(d) { return d.getDate() + ' ' + (th ? THS : ENS)[d.getMonth()] + ' ' + yearOf(d.getFullYear()); }
        function disabled(d) { return d < min || d > max; }
        function close() { if (popup) { popup.remove(); popup = null; } btn.setAttribute('aria-expanded', 'false'); }
        function render() {
          popup.innerHTML = '';
          function nav(text, onClick) { var b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-label', text); b.textContent = text === copy.prev || text === copy.prevYear ? '‹' : '›'; b.addEventListener('click', onClick); return b; }
          if (mode === 'day') {
            var head = document.createElement('div');
            head.appendChild(nav(copy.prev, function () { view.m -= 1; if (view.m < 0) { view.m = 11; view.y -= 1; } render(); }));
            var title = document.createElement('button'); title.type = 'button'; title.textContent = (th ? TH : EN)[view.m] + ' ' + yearOf(view.y);
            title.addEventListener('click', function () { mode = 'month'; render(); });
            head.appendChild(title);
            head.appendChild(nav(copy.next, function () { view.m += 1; if (view.m > 11) { view.m = 0; view.y += 1; } render(); }));
            popup.appendChild(head);
            var grid = document.createElement('div');
            var first = new Date(view.y, view.m, 1), days = new Date(view.y, view.m + 1, 0).getDate();
            for (var p = 0; p < first.getDay(); p++) { var pad = document.createElement('div'); pad.setAttribute('aria-hidden', 'true'); grid.appendChild(pad); }
            for (var d = 1; d <= days; d++) {
              (function (day) {
                var date = new Date(view.y, view.m, day);
                var b = document.createElement('button'); b.type = 'button'; b.textContent = String(day);
                b.setAttribute('aria-pressed', String(value !== null && value.getTime() === date.getTime()));
                if (disabled(date)) b.disabled = true;
                b.addEventListener('click', function () { if (disabled(date)) return; value = date; btn.textContent = label(date); setStatus('date:' + btn.id + ':' + date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')); close(); });
                grid.appendChild(b);
              })(d);
            }
            popup.appendChild(grid);
            var foot = document.createElement('div');
            var today = document.createElement('button'); today.type = 'button'; today.textContent = copy.today; foot.appendChild(today);
            var clear = document.createElement('button'); clear.type = 'button'; clear.textContent = copy.clear; foot.appendChild(clear);
            popup.appendChild(foot);
          } else {
            var mh = document.createElement('div');
            mh.appendChild(nav(copy.prev, function () { view.m = (view.m + 11) % 12; render(); }));
            var sel = document.createElement('select'); sel.setAttribute('aria-label', copy.selMonth);
            (th ? THS : ENS).forEach(function (m, i) { var o = document.createElement('option'); o.value = String(i); o.textContent = m; if (i === view.m) o.selected = true; sel.appendChild(o); });
            sel.addEventListener('change', function () { view.m = Number(sel.value); render(); });
            mh.appendChild(sel);
            mh.appendChild(nav(copy.next, function () { view.m = (view.m + 1) % 12; render(); }));
            popup.appendChild(mh);
            var yh = document.createElement('div');
            yh.appendChild(nav(copy.prevYear, function () { view.y -= 1; render(); }));
            var yin = document.createElement('input'); yin.type = 'number'; yin.setAttribute('aria-label', copy.selYear); yin.value = String(yearOf(view.y));
            var commit = function () { var n = Number(yin.value); if (n) { view.y = th ? n - 543 : n; render(); } };
            yin.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
            yh.appendChild(yin);
            yh.appendChild(nav(copy.nextYear, function () { view.y += 1; render(); }));
            popup.appendChild(yh);
            var mg = document.createElement('div');
            (th ? THS : ENS).forEach(function (m, i) {
              var b = document.createElement('button'); b.type = 'button'; b.textContent = m; b.setAttribute('aria-pressed', String(i === view.m));
              b.addEventListener('click', function () { view.m = i; mode = 'day'; render(); });
              mg.appendChild(b);
            });
            popup.appendChild(mg);
          }
        }
        btn.addEventListener('click', function () {
          if (popup) { close(); return; }
          var base = value || initial; view = { y: base.getFullYear(), m: base.getMonth() }; mode = 'day';
          popup = document.createElement('div'); popup.setAttribute('role', 'dialog'); popup.setAttribute('aria-label', copy.calendar);
          popup.className = 'popup'; popup.style.position = 'fixed'; popup.style.top = '40px'; popup.style.left = '40px'; popup.style.zIndex = '100';
          document.body.appendChild(popup); btn.setAttribute('aria-expanded', 'true'); render();
        });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
      }
      dateField(document.getElementById('hire-date'), 'en', new Date(2026, 8, 3), new Date(2025, 0, 1), new Date(2028, 10, 30));
      dateField(document.getElementById('start-date'), 'th', new Date(2026, 8, 3), new Date(2025, 0, 1), new Date(2028, 10, 30));
      // --- uploads
      function reportFiles(input) { input.addEventListener('change', function () { document.getElementById('upload-status').textContent = input.id + ':' + Array.prototype.map.call(input.files, function (f) { return f.name; }).join(','); }); }
      reportFiles(document.getElementById('import-file')); reportFiles(document.getElementById('cert-file')); reportFiles(document.getElementById('chooser-input'));
      document.getElementById('dropzone').addEventListener('click', function () { document.getElementById('import-file').click(); });
      document.getElementById('choose-btn').addEventListener('click', function () { document.getElementById('chooser-input').click(); });
      // --- dialogs
      document.getElementById('open-delete').addEventListener('click', function () { document.getElementById('delete-dialog').hidden = false; });
      document.getElementById('delete-cancel').addEventListener('click', function () { document.getElementById('delete-dialog').hidden = true; setStatus('delete:cancelled'); });
      document.getElementById('delete-ok').addEventListener('click', function () { document.getElementById('delete-dialog').hidden = true; setStatus('delete:DELETED'); });
      document.getElementById('open-wizard').addEventListener('click', function () { document.getElementById('wizard-dialog').hidden = false; });
      document.getElementById('open-cookie').addEventListener('click', function () { document.getElementById('cookie-dialog').hidden = false; });
    </script>
  </body>
</html>`;

const NOT_FOUND_HTML = `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><title>Humi</title></head>
<body>
  <nav aria-label="Main"><a href="/">หน้าหลัก</a></nav>
  <div class="humi-eyebrow">404 — ไม่พบหน้าที่ค้นหา</div>
  <h1>หน้านี้ถูกย้ายหรือลบไปแล้ว</h1>
  <p>บางฟีเจอร์ของ Humi ถูกจัดเรียงใหม่</p>
  <a href="/">กลับสู่หน้าหลัก</a>
</body></html>`;

async function cdpAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

const browserReady = await cdpAvailable(CDP_URL);
const skipBrowser = browserReady
  ? false
  : `no CDP endpoint at ${CDP_URL} — start Chrome with --remote-debugging-port=9222 (npm run chrome)`;

describe('engine helpers against a real page (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;
  let dir: string;
  let csvPath: string;

  before(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith('/missing')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(NOT_FOUND_HTML);
        return;
      }
      if (req.url?.startsWith('/sample.csv')) {
        res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="sample.csv"' });
        res.end('employee_id,name\nE001,Somchai\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-helpers-'));
    csvPath = join(dir, 'import.csv');
    await writeFile(csvPath, 'plan_id,name\nPL_07_01,Medical\n');
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(dir, { recursive: true, force: true });
  });

  async function withPage<T>(run: (page: import('playwright').Page) => Promise<T>): Promise<T> {
    const browser = await chromium.connectOverCDP(CDP_URL);
    const context = await browser.newContext({ acceptDownloads: true });
    try {
      const page = await context.newPage();
      await page.goto(origin);
      return await run(page);
    } finally {
      await context.close();
      await browser.close();
    }
  }

  it('listbox: types the code into the search box, picks the whole name, reads it back (HIR-EC-001 Employee Group)', async () => {
    await withPage(async (page) => {
      const result = await selectFromListbox(page, page.locator('#grp'), 'A - Permanent');
      assert.equal(result.typed, 'A', 'the stable head — the code half — is what gets typed');
      assert.deepEqual(result.picked, ['A — Permanent']);
      assert.equal(result.matchedBy, 'whole', 'dash folding finds the em-dash rendering of the whole value');
      assert.ok(result.confirmed, `trigger shows ${result.readBack}`);
      assert.equal(await page.locator('#status').innerText(), 'grp:A');
      assert.equal(await page.locator('#grp').getAttribute('aria-expanded'), 'false');
    });
  });

  it('listbox: a bare code picks by whole word, never "AB" for "A"', async () => {
    await withPage(async (page) => {
      const result = await selectFromListbox(page, page.locator('#grp'), 'A');
      assert.deepEqual(result.picked, ['A — Permanent']);
    });
  });

  it('listbox: a disabled option is a state verdict, not a missing one', async () => {
    await withPage(async (page) => {
      await assert.rejects(selectFromListbox(page, page.locator('#grp'), 'C - Contract'), ListboxOptionDisabledError);
      assert.equal(await page.locator('#grp').getAttribute('aria-expanded'), 'false', 'closed again');
    });
  });

  it('listbox: waits for a dependent list to fill after the parent pick (Province → District)', async () => {
    await withPage(async (page) => {
      const province = await selectFromListbox(page, page.locator('#province'), 'กรุงเทพมหานคร');
      assert.ok(province.confirmed);
      const started = Date.now();
      const district = await selectFromListbox(page, page.locator('#district'), 'บางรัก');
      assert.deepEqual(district.picked, ['บางรัก']);
      assert.ok(district.waitedMs >= 200, `waited ${district.waitedMs} ms for the fetch`);
      assert.ok(Date.now() - started < 5_000);
      assert.equal(await page.locator('#status').innerText(), 'district:บางรัก');
    });
  });

  it('listbox: an option that never appears closes the list and keeps the parsed wording', async () => {
    await withPage(async (page) => {
      await assert.rejects(
        selectFromListbox(page, page.locator('#gender'), 'Other'),
        (error: unknown) => {
          assert.ok(error instanceof ListboxOptionMissingError);
          assert.match(error.message, /no option named "Other" appeared/);
          assert.match(error.message, /2 shown: "Female", "Male"/);
          return true;
        },
      );
      assert.equal(await page.locator('#gender').getAttribute('aria-expanded'), 'false');
      assert.ok(await page.locator('#gender-list').isHidden());
    });
  });

  it('listbox: "Male" is never found inside "Female"', async () => {
    await withPage(async (page) => {
      const result = await selectFromListbox(page, page.locator('#gender'), 'Male');
      assert.deepEqual(result.picked, ['Male']);
      assert.equal(await page.locator('#status').innerText(), 'gender:Male');
    });
  });

  it('listbox: a multi-value ticks each checkbox row (BE Company "CDS (C001), B2S (C006)")', async () => {
    await withPage(async (page) => {
      const result = await selectFromListbox(page, page.locator('#company'), 'CDS (C001), B2S (C006)');
      assert.equal(result.via, 'checkbox');
      assert.equal(result.picked.length, 2);
      assert.equal(await page.locator('#company').innerText(), 'CDS (C001), B2S (C006)');
      assert.ok(await page.locator('#company-list').isHidden(), 'Escape closed the list');
      assert.ok(!(await page.locator('#company-list input[value="C009"]').isChecked()));
    });
  });

  it('calendar: navigates a month and picks the day; the trigger reads back (BE Effective Start)', async () => {
    await withPage(async (page) => {
      const result = await pickDateInDialog(page, page.locator('#hire-date'), '2026-10-15');
      assert.equal(result.via, 'month-nav');
      assert.equal(result.navigated, 1);
      assert.equal(result.shown, '15 Oct 2026');
      assert.ok(result.confirmed);
      assert.equal(await page.locator('#status').innerText(), 'date:hire-date:2026-10-15');
      assert.equal(await openDialogNow(page), null, 'the dialog closed');
    });
  });

  it('calendar: reads a Buddhist heading and confirms a Thai rendering', async () => {
    await withPage(async (page) => {
      const result = await pickDateInDialog(page, page.locator('#start-date'), '2026-08-05');
      assert.equal(result.navigated, 1);
      assert.match(result.heading, /สิงหาคม 2569/);
      assert.equal(result.shown, '5 ส.ค. 2569');
      assert.ok(result.confirmed);
    });
  });

  it('calendar: a long jump goes through the month view', async () => {
    await withPage(async (page) => {
      const result = await pickDateInDialog(page, page.locator('#hire-date'), '2028-06-20');
      assert.equal(result.via, 'month-view');
      assert.equal(result.shown, '20 Jun 2028');
      assert.ok(result.confirmed);
    });
  });

  it('calendar: a disabled day is out of range — a verdict with the heading as evidence', async () => {
    await withPage(async (page) => {
      await assert.rejects(pickDateInDialog(page, page.locator('#hire-date'), '2028-12-05'), (error: unknown) => {
        assert.ok(error instanceof DateOutOfRangeError);
        assert.match(error.message, /2028-12-05 is outside the picker's allowed range/);
        assert.match(error.message, /December 2028/);
        return true;
      });
      assert.equal(await openDialogNow(page), null, 'closed again');
    });
  });

  it('field-error: reads the message the control names, and only under a field that has one', async () => {
    await withPage(async (page) => {
      const named = await readFieldError(page, page.locator('#plan-name'));
      assert.deepEqual(named, { text: 'Plan Name is required', via: 'aria-describedby', invalid: true });
      assert.equal(await readFieldError(page, page.locator('#amount')), null, 'help text is not an error');
      const container = await readFieldError(page, page.locator('#grade'));
      assert.deepEqual(container, { text: 'กรุณาระบุ Personal Grade', via: 'container', invalid: false });
      const required = await readFieldRequired(page, page.locator('#plan-name'));
      assert.deepEqual(required, { required: true, via: 'aria-required', label: 'Plan Name*' });
      assert.deepEqual(await readFieldRequired(page, page.locator('#bank')), { required: true, via: 'required', label: 'Bank' });
      assert.equal((await readFieldRequired(page, page.locator('#amount')))?.required, false);
    });
  });

  it('upload: through the dropzone, the label, and the native chooser; a missing fixture is a harness fault', async () => {
    await withPage(async (page) => {
      const dropzone = await attachFiles(page, page.locator('#dropzone'), [csvPath]);
      assert.equal(dropzone.via, 'descendant');
      assert.equal(dropzone.files[0]?.name, 'import.csv');
      assert.ok((dropzone.files[0]?.bytes ?? 0) > 0);
      assert.equal(await page.locator('#upload-status').innerText(), 'import-file:import.csv');

      const label = await attachFiles(page, page.locator('label[for="cert-file"]'), ['import.csv'], { baseDir: dir });
      assert.equal(label.via, 'label-for');
      assert.equal(await page.locator('#upload-status').innerText(), 'cert-file:import.csv');

      const chooser = await attachFiles(page, page.locator('#choose-btn'), [csvPath]);
      assert.equal(chooser.via, 'filechooser');
      assert.equal(await page.locator('#upload-status').innerText(), 'chooser-input:import.csv');

      await assert.rejects(attachFiles(page, page.locator('#dropzone'), [join(dir, 'nope.csv')]), FixtureMissingError);
    });
  });

  it('download: arms the event and saves the file (PL_10_06 Download Sample CSV)', async () => {
    await withPage(async (page) => {
      const saved = await captureDownload(page, () => page.locator('#download-link').click(), { dir: join(dir, 'downloads') });
      assert.equal(saved.filename, 'sample.csv');
      assert.ok(saved.bytes > 0);
      assert.ok(saved.path.endsWith('sample.csv'));
    });
  });

  it('not-found: reads the in-place 404 from its headings, and nothing from a normal page', async () => {
    await withPage(async (page) => {
      assert.equal(await notFoundSurface(page), null);
      await page.goto(`${origin}/missing/admin/hire`);
      const surface = await notFoundSurface(page);
      assert.ok(surface, 'the 404 page should be recognised');
      assert.equal(surface.via, 'heading');
      assert.equal(surface.heading, 'หน้านี้ถูกย้ายหรือลบไปแล้ว');
      assert.ok(surface.url.endsWith('/missing/admin/hire'));
    });
  });

  it('modal: the automatic policy never confirms; the explicit one may; a consent notice is accepted', async () => {
    await withPage(async (page) => {
      await page.locator('#open-delete').click();
      const dialog = await openDialogNow(page);
      assert.ok(dialog);
      assert.equal(await describeDialog(dialog), 'ยืนยันการลบแผน', 'the heading, not the eyebrow');
      assert.equal((await dialogMentions(dialog, 'ลบแผน'))?.via, 'heading');
      assert.equal((await dialogMentions(dialog, 'ถาวร'))?.via, 'text');
      assert.equal(await dialogMentions(dialog, 'Checkout'), null);
      assert.ok(await selectorInsideDialog(dialog, 'role=button[name="ตกลง"]'));
      assert.ok(!(await selectorInsideDialog(dialog, '#status')));
      const auto = await findDismissButton(dialog, { policy: 'automatic' });
      assert.equal(auto?.text, 'ยกเลิก');
      await page.keyboard.press('Escape');
      await page.locator('#delete-cancel').click();

      await page.locator('#open-wizard').click();
      const wizard = await openDialogNow(page);
      assert.ok(wizard);
      assert.equal(await findDismissButton(wizard, { policy: 'automatic' }), null, '"ดำเนินการต่อ" would advance the wizard');
      assert.equal((await findDismissButton(wizard))?.text, 'ดำเนินการต่อ', 'an explicit closeModal may');
      assert.ok(await selectorInsideDialog(wizard, 'role=textbox[name="Rule name" i]'));
      await page.evaluate("document.getElementById('wizard-dialog').hidden = true");

      await page.locator('#open-cookie').click();
      const cookie = await openDialogNow(page);
      assert.ok(cookie);
      assert.equal((await findDismissButton(cookie, { policy: 'automatic' }))?.text, 'ยอมรับ', 'accepting a consent notice is the neutral act');
    });
  });

  it('healer: a hidden-only candidate is refused for a click, accepted for a count; the tree shows required', async () => {
    await withPage(async (page) => {
      const tree = await captureAxTree(page);
      assert.match(tree, /textbox "Bank" required/);
      assert.match(tree, /textbox "Plan Name"[^\n]* required/);

      const stub: HealerModel = {
        id: 'stub',
        suggest: async () => ({ selector: '#hidden-only', strategy: 'css', confidence: 0.9, reasoning: 'the hidden one' }),
      };
      const cache = new CacheManager({ filePath: join(dir, 'heal.json'), warn: false });
      const healer = new JitHealer({ model: stub, cache, verifyTimeoutMs: 500 });
      await assert.rejects(
        healer.heal({ page, action: 'click', selector: 'role=button[name="Missing"]' }),
        (error: unknown) => {
          assert.match((error as Error).message, /matched 1 element\(s\), none visible/);
          return true;
        },
      );
      const counted = await healer.heal({ page, action: 'expectCount', selector: 'role=button[name="Missing"]' });
      assert.equal(counted.selector, '#hidden-only');
    });
  });
});
