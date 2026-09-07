/**
 * The runner's wave-2 wiring (2026-09-03): the ladder rungs and step kinds
 * that let the HR workbook's cases run deterministically against humi-shaped
 * primitives — the searchable listbox behind `selectOption`, the calendar
 * behind a `fill`, field-scoped validation, uploads and downloads, the
 * not-found and absence stops, per-step patience, the persona `signIn`, the
 * row-scope and open-popup rungs, and a dialog the flow opened staying open.
 *
 * Two tiers, same rule as everywhere else:
 *   - unit: the vocabulary that is parsed off attempt lines
 *     (`isStateContradiction`, `describeAttempt`), the comparators
 *     (`relaxedTextMatch`, `valueMatches`), the persona resolver, the vault's
 *     per-account keying — pure, run always.
 *   - browser: that each rung actually fires against a real page is a fact
 *     about a real browser, and every one of them was invisible to a stub.
 *
 *   npm test                                 # unit + browser (if Chrome is up)
 *   WOWLIDATOR_CDP_URL=http://localhost:9222 npx tsx --test tests/runner-wave2.test.ts
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import {
  MAX_STEP_TIMEOUT_MS,
  StepResolutionError,
  describeAttempt,
  dependentTail,
  fieldNamesIn,
  isStateContradiction,
  isoDateOf,
  normalisedTextMatch,
  relaxedTextMatch,
  resolvePersona,
  runFlow,
  signsInItself,
  skipAfterFailedLeg,
  stopAfterFirstIssue,
  stepPatience,
  valueMatches,
  type Flow,
} from '../src/engine/runner.js';
import { SessionVault } from '../src/engine/session-vault.js';
import { ANY_OFFERED } from '../src/engine/listbox.js';

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';

// --- Unit tier -------------------------------------------------------------

describe('state contradictions the wave-2 rungs read off an attempt line', () => {
  it('finds only the steps that depend on a failed workflow leg', () => {
    const workflow = { action: 'workflow', goal: 'open the order' } as const;
    const tail = [
      { action: 'expectVisible', selector: 'text=Order' },
      { action: 'saveText', selector: 'text=ID', as: 'id' },
      { action: 'expectText', selector: 'text=Status', value: 'Open' },
    ] as const;
    assert.deepEqual(dependentTail([workflow, ...tail, { action: 'goto', url: '/app' }] as Flow['steps'], 0), [1, 2, 3]);
    assert.deepEqual(dependentTail([workflow] as Flow['steps'], 0), []);
    assert.deepEqual(dependentTail([workflow, { action: 'workflow', goal: 'recover' }] as Flow['steps'], 0), []);
    // A request reads nothing off the page: it and its own assertions still run.
    assert.deepEqual(
      dependentTail(
        [workflow, ...tail, { action: 'request', method: 'GET', url: '/api/status' }, { action: 'expectStatus', status: 200 }] as Flow['steps'],
        0,
      ),
      [1, 2, 3],
    );
    for (const action of ['goto', 'signIn', 'signOut', 'workflow', 'back', 'forward', 'setClock', 'clearStorage'] as const) {
      const reset = action === 'goto'
        ? { action, url: '/app' }
        : action === 'signIn'
          ? { action, as: 'TEST_ACCOUNT' }
          : action === 'workflow'
            ? { action, goal: 'recover' }
            : action === 'setClock'
              ? { action, now: '2026-09-05T00:00:00Z' }
              : { action };
      assert.deepEqual(dependentTail([workflow, tail[0], reset] as Flow['steps'], 0), [1], action);
    }
  });

  it('runs dependent tails only when the kill-switch restores the old behavior', () => {
    assert.equal(skipAfterFailedLeg({}), true);
    assert.equal(skipAfterFailedLeg({ WOWLIDATOR_SKIP_AFTER_FAILED_LEG: 'off' }), false);
  });
  it('enables first-issue triage only when explicitly requested', () => {
    assert.equal(stopAfterFirstIssue({}), false);
    assert.equal(stopAfterFirstIssue({ WOWLIDATOR_STOP_AFTER_FIRST_ISSUE: 'on' }), true);
    assert.equal(stopAfterFirstIssue({ WOWLIDATOR_STOP_AFTER_FIRST_ISSUE: 'ON' }), true);
  });

  it('a missing option, a disabled control and an out-of-range day are verdicts', () => {
    assert.ok(isStateContradiction('fast "#grp": opened "Employee Group" but no option named "Z" appeared (looked for role=option, menuitem, menuitemradio; 3 shown: A, B, C)'));
    assert.ok(isStateContradiction('fast "#submit": locator.click: Timeout 400ms exceeded. (element is not enabled)'));
    assert.ok(isStateContradiction('calendar "#hire-date": date 2027-09-40 is outside the picker\'s allowed range — its day button under "September 2027" is disabled (element is not enabled)'));
    assert.equal(isStateContradiction('fast "#x": locator.click: Timeout 400ms exceeded.'), false);
  });

  it('describeAttempt lifts the state out of Playwright\'s call log onto the first line', () => {
    const error = new Error(
      'locator.click: Timeout 400ms exceeded.\nCall log:\n  - waiting for locator(\'#submit\')\n  - locator resolved to <button disabled>…</button>\n  - element is not enabled\n  - retrying click action',
    );
    assert.equal(describeAttempt(error), 'locator.click: Timeout 400ms exceeded. (element is not enabled)');
    assert.equal(describeAttempt(new Error('plain\nsecond line')), 'plain');
  });

  it('a verdict option classifies the failure as content-only whatever the lines say', () => {
    const error = new StepResolutionError('#x', ['fast "#x": Timeout 400ms exceeded.', 'absence: "Ghost" is not in the page\'s visible text'], {
      verdict: 'the text is not on the page',
    });
    assert.equal(error.contentOnly, true);
    assert.match(error.message, /^"#x" — the text is not on the page after 2 attempt\(s\)/);
    assert.equal(new StepResolutionError('#x', ['fast "#x": Timeout 400ms exceeded.']).contentOnly, false);
  });
});

describe('the comparators concede the sheet\'s own spelling last (EH-05)', () => {
  it('relaxedTextMatch adds a normalised kind after case and template', () => {
    assert.deepEqual(relaxedTextMatch('A - Permanent', 'Employee Group A — Permanent'), { found: 'a - permanent', relaxation: 'normalised' });
    assert.equal(relaxedTextMatch('Active', 'Status: ACTIVE')?.relaxation, 'case');
    assert.equal(relaxedTextMatch('Somchai', 'สมชาย สุขใจ'), null, 'script is never folded');
    assert.equal(relaxedTextMatch('Ghost', 'nothing like it'), null);
  });

  it('a one-letter code never matches as a whole word — "A" is an article, not "A - Permanent"', () => {
    assert.equal(normalisedTextMatch('A - Permanent', 'a temporary contract'), null);
    assert.equal(normalisedTextMatch('A - Permanent', 'Permanent staff'), 'permanent');
    assert.equal(normalisedTextMatch('H_NEWHIRE - New Hire', 'Reason: H_NEWHIRE'), 'h_newhire');
  });

  it('valueMatches keeps its containment rule and adds the fold', () => {
    assert.ok(valueMatches('New Hire', 'Event Reason\nNew Hire'));
    assert.ok(!valueMatches('New Hire', 'Rehire'));
    assert.ok(valueMatches('A - Permanent', 'A — Permanent'));
    assert.ok(valueMatches('CDS (C001)', 'C001'));
  });
});

describe('fieldNamesIn reads the Thai field phrase after a data-entry verb (EH-03)', () => {
  it('yields the label a hidden input is named by', () => {
    assert.ok(fieldNamesIn('กรอกวันเกิด = 15 ก.ย. 2569').includes('วันเกิด'));
    assert.ok(fieldNamesIn('ระบุวันที่มีผล เป็น 1 ต.ค. 2569').includes('วันที่มีผล'));
    assert.ok(fieldNamesIn('key Hire Date = 15 Sep 2027 into the Hire Date field').includes('Hire Date'));
    assert.deepEqual(fieldNamesIn(undefined), []);
  });

  it('isoDateOf keeps the runner\'s answers and reads a locale', () => {
    assert.equal(isoDateOf('01 Sep 2027'), '2027-09-01');
    assert.equal(isoDateOf('01/09/2027'), null);
    assert.equal(isoDateOf('01/09/2027', 'th'), '2027-09-01');
    assert.equal(isoDateOf('15 ก.ย. 2569'), '2026-09-15');
  });
});

describe('per-step patience (EH-07)', () => {
  it('clamps to the ceiling and ignores nonsense', () => {
    assert.equal(stepPatience(undefined), undefined);
    assert.equal(stepPatience(0), undefined);
    assert.equal(stepPatience(-5), undefined);
    assert.equal(stepPatience(3_000), 3_000);
    assert.equal(stepPatience(MAX_STEP_TIMEOUT_MS * 4), MAX_STEP_TIMEOUT_MS);
  });
});

describe('personas (EH-10)', () => {
  const personas = {
    HR_ADMIN_ACCOUNT: { email: 'admin@cnext.test', password: 'admin2026' },
    MANAGER_ACCOUNT: { email: 'manager@cnext.test', password: 'mgr2026' },
  };

  it('resolves the four spellings the sheets use, and an email', () => {
    assert.equal(resolvePersona('<HR_ADMIN_ACCOUNT>', personas)?.email, 'admin@cnext.test');
    assert.equal(resolvePersona('HR admin', personas)?.label, 'HR_ADMIN_ACCOUNT');
    assert.equal(resolvePersona('hr-admin', personas)?.label, 'HR_ADMIN_ACCOUNT');
    assert.equal(resolvePersona('manager@cnext.test', personas)?.label, 'MANAGER_ACCOUNT');
    assert.equal(resolvePersona('EMPLOYEE_ACCOUNT', personas), null);
    assert.equal(resolvePersona('', personas), null);
  });

  it('a flow with a signIn step signs in itself — the bootstrap never races it', () => {
    const flow: Flow = { name: 'x', steps: [{ action: 'signIn', as: 'HR_ADMIN_ACCOUNT' }, { action: 'expectVisible', selector: 'h1' }] };
    assert.equal(signsInItself(flow), true);
    assert.equal(signsInItself({ name: 'y', steps: [{ action: 'goto', url: 'http://a.test/app' }] }), false);
  });

  it('the vault keys by account, and without one answers with the latest', () => {
    const state = (name: string) => ({
      cookies: [{ name, value: 'v', domain: 'a.test', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const }],
      origins: [],
    });
    const vault = new SessionVault();
    assert.ok(vault.put('http://a.test', state('emp'), 'employee@a.test'));
    assert.ok(vault.put('http://a.test', state('mgr'), 'manager@a.test'));
    assert.equal(vault.get('http://a.test', 'employee@a.test')?.cookies[0]?.name, 'emp');
    assert.equal(vault.get('http://a.test', 'Manager@A.test')?.cookies[0]?.name, 'mgr', 'accounts fold case');
    assert.equal(vault.get('http://a.test')?.cookies[0]?.name, 'mgr', 'the latest when nobody is named');
    assert.equal(vault.get('http://a.test', 'nobody@a.test'), null, 'an account that never banked one inherits nothing');
    assert.equal(vault.get('http://b.test'), null);
    assert.deepEqual(vault.accounts('http://a.test'), ['employee@a.test', 'manager@a.test']);
  });
});

// --- Browser tier ----------------------------------------------------------

/** humi-SIT's primitives, in miniature: custom-select, DateField, FormField, dropzone, DataTable, dialogs, not-found. */
const FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>wave-2 fixture</title>
  <style>[hidden]{display:none!important} .popup{border:1px solid #999;padding:4px;background:#fff}</style>
  </head>
  <body>
    <h1>Benefit Plan</h1>
    <p id="status">idle</p>

    <!-- custom-select (searchable): trigger + input above ul[role=listbox]; options render "CODE — Label" -->
    <span id="grp-label">Employee Group</span>
    <button id="grp" type="button" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="grp-label">— Select —</button>
    <div id="grp-pop" class="popup" hidden>
      <input id="grp-search" type="text" placeholder="Type to search...">
      <ul id="grp-list" role="listbox" aria-labelledby="grp-label"></ul>
    </div>
    <input id="group-code" aria-label="Group code" value="A — Permanent">
    <p id="group-badge">Employee Group: A — Permanent</p>
    <select id="native-choice">
      <option value="">Choose one</option>
      <option value="blocked" disabled>Unavailable</option>
      <option value="alpha">Alpha</option>
      <option value="beta">Beta</option>
    </select>

    <!-- a closed popup whose options carry aria-disabled -->
    <button id="gender" type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="Gender">Select Gender</button>
    <ul id="gender-list" role="listbox" hidden>
      <li role="option" tabindex="-1">Female</li>
      <li role="option" tabindex="-1">Male</li>
      <li role="option" tabindex="-1" aria-disabled="true">Other</li>
    </ul>

    <!-- DateField: button[aria-haspopup=dialog] → role=dialog calendar -->
    <button id="hire-date" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="Hire Date">Select date</button>

    <!-- FormField: label + control + aria-describedby message -->
    <div class="field">
      <label for="plan-name">Plan Name<span aria-hidden="true" class="text-danger">*</span></label>
      <input id="plan-name" aria-required="true" aria-invalid="true" aria-describedby="plan-name-error">
      <p id="plan-name-error" role="alert">Plan Name is required</p>
    </div>
    <div class="field">
      <label for="amount">Amount</label>
      <input id="amount">
      <p class="hint">In baht</p>
    </div>

    <!-- AttachmentDropzone -->
    <div id="dropzone" tabindex="0"><p>Click or drag file here</p><input id="import-file" type="file" accept=".csv" style="display:none"></div>
    <a id="download-link" href="/sample.csv" download="sample.csv">Download Sample CSV</a>

    <!-- a gated submit -->
    <button id="submit" type="button" disabled>Submit</button>

    <!-- either/or toasts -->
    <div id="toast-ok" role="status" hidden>Created</div>
    <div id="toast-err" role="alert">Plan ID already exists</div>

    <!-- DataTable: the row's accessible name is every cell joined -->
    <table>
      <thead><tr><th>Plan ID</th><th>Plan name</th><th></th></tr></thead>
      <tbody>
        <tr><td>PL_07_01</td><td>Medical Reimbursement</td><td><button type="button" class="fix">Make Correction</button></td></tr>
        <tr><td>PL_07_02</td><td>Medical Checkup</td><td><button type="button" class="fix">Make Correction</button></td></tr>
      </tbody>
    </table>

    <!-- a dialog the flow opens on purpose -->
    <button id="open-edit" type="button">Edit rule</button>
    <div id="edit-dialog" role="dialog" hidden>
      <div class="eyebrow">Benefit Rule · RU_05_01</div>
      <h2>Edit rule</h2>
      <label for="rule-name">Rule name</label><input id="rule-name">
      <button type="button" id="edit-cancel">Cancel</button>
      <button type="button" id="edit-save">Save</button>
    </div>

    <!-- a link into a route the app does not have: rendered in place, status 200 -->
    <a id="view-details" href="/missing">View Details</a>

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
      // --- gender popup
      var gender = document.getElementById('gender'), genderList = document.getElementById('gender-list');
      gender.addEventListener('click', function () { var open = genderList.hidden; genderList.hidden = !open; gender.setAttribute('aria-expanded', String(open)); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { genderList.hidden = true; gender.setAttribute('aria-expanded', 'false'); grpPop.hidden = true; grp.setAttribute('aria-expanded', 'false'); } });
      // --- DateField (day view + month nav, humi shape)
      var EN = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      var ENS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      (function () {
        var btn = document.getElementById('hire-date');
        var view = { y: 2027, m: 8 }, popup = null, value = null;
        function close() { if (popup) { popup.remove(); popup = null; } btn.setAttribute('aria-expanded', 'false'); }
        function render() {
          popup.innerHTML = '';
          var head = document.createElement('div');
          var prev = document.createElement('button'); prev.type = 'button'; prev.setAttribute('aria-label', 'Previous month'); prev.textContent = '‹';
          prev.addEventListener('click', function () { view.m -= 1; if (view.m < 0) { view.m = 11; view.y -= 1; } render(); });
          var title = document.createElement('span'); title.textContent = EN[view.m] + ' ' + view.y;
          var next = document.createElement('button'); next.type = 'button'; next.setAttribute('aria-label', 'Next month'); next.textContent = '›';
          next.addEventListener('click', function () { view.m += 1; if (view.m > 11) { view.m = 0; view.y += 1; } render(); });
          head.appendChild(prev); head.appendChild(title); head.appendChild(next); popup.appendChild(head);
          var grid = document.createElement('div');
          var days = new Date(view.y, view.m + 1, 0).getDate();
          for (var d = 1; d <= days; d++) {
            (function (day) {
              var date = new Date(view.y, view.m, day);
              var b = document.createElement('button'); b.type = 'button'; b.textContent = String(day);
              b.setAttribute('aria-pressed', String(value !== null && value.getTime() === date.getTime()));
              b.addEventListener('click', function () {
                value = date; btn.textContent = day + ' ' + ENS[view.m] + ' ' + view.y;
                setStatus('date:' + view.y + '-' + String(view.m + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0'));
                close();
              });
              grid.appendChild(b);
            })(d);
          }
          popup.appendChild(grid);
        }
        btn.addEventListener('click', function () {
          if (popup) { close(); return; }
          btn.setAttribute('aria-expanded', 'true');
          popup = document.createElement('div'); popup.setAttribute('role', 'dialog'); popup.setAttribute('aria-label', 'Calendar');
          popup.className = 'popup'; popup.style.position = 'fixed'; popup.style.top = '10px'; popup.style.left = '10px';
          document.body.appendChild(popup); render();
        });
      })();
      // --- dropzone
      document.getElementById('import-file').addEventListener('change', function (e) {
        var f = e.target.files[0]; setStatus('file:' + (f ? f.name + ':' + f.size : 'none'));
      });
      document.getElementById('dropzone').addEventListener('click', function () { document.getElementById('import-file').click(); });
      // --- table
      Array.prototype.forEach.call(document.querySelectorAll('button.fix'), function (b) {
        b.addEventListener('click', function () { setStatus('corrected:' + b.closest('tr').firstElementChild.textContent); });
      });
      // --- dialog
      var dlg = document.getElementById('edit-dialog');
      document.getElementById('open-edit').addEventListener('click', function () { dlg.hidden = false; });
      document.getElementById('edit-cancel').addEventListener('click', function () { dlg.hidden = true; setStatus('cancelled'); });
      document.getElementById('edit-save').addEventListener('click', function () { dlg.hidden = true; setStatus('saved:' + document.getElementById('rule-name').value); });
      // --- not-found rendered in place, like a Next.js not-found.tsx after a client-side click
      document.getElementById('view-details').addEventListener('click', function (e) {
        e.preventDefault();
        history.pushState({}, '', '/missing');
        document.body.innerHTML = '<main><p class="eyebrow">404 — ไม่พบหน้าที่ค้นหา</p><h1>หน้านี้ถูกย้ายหรือลบไปแล้ว</h1><a href="/">กลับสู่หน้าหลัก</a></main>';
        document.title = 'Not found';
      });
    </script>
  </body>
</html>`;

/** A page whose content arrives late, and a toast that dismisses itself. */
const LATE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>late</title></head>
<body>
  <h1>Payroll run</h1>
  <p id="status">Processing</p>
  <div id="toast" role="alert">Saved</div>
  <script>
    setTimeout(function () { document.getElementById('status').textContent = 'Complete'; }, 2500);
    setTimeout(function () { document.getElementById('toast').remove(); }, 1800);
  </script>
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

describe('the wave-2 rungs and steps against a real page (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;
  let dir: string;

  before(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/sample.csv') {
        res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="sample.csv"' });
        res.end('Plan ID,Plan name\nPL_00_01,Sample\n');
        return;
      }
      if (path === '/late') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(LATE_HTML);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-wave2-'));
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(dir, { recursive: true, force: true });
  });

  const run = (flow: Flow, extra: Record<string, unknown> = {}) =>
    runFlow(
      { baseUrl: origin, ...flow },
      {
        cdpUrl: CDP_URL,
        cachePath: join(dir, `${flow.name.replace(/[^a-z0-9]+/gi, '-')}.json`),
        healer: null,
        video: 'off',
        screenshots: 'off',
        isolate: true,
        coverage: false,
        fastTimeoutMs: 400,
        healedTimeoutMs: 1_200,
        ...extra,
      },
    );

  it('selectOption drives the searchable listbox: types the code, picks "CODE — Label", reads it back (EH-01)', async () => {
    const bundle = await run({
      name: 'listbox pick',
      steps: [
        { action: 'goto', url: '/' },
        { action: 'selectOption', selector: '#grp', value: 'A - Permanent' },
        { action: 'expectText', selector: '#status', value: 'grp:A' },
      ],
    });
    assert.equal(bundle.status, 'passed', bundle.error ?? '');
    const step = bundle.steps.find((s) => s.action === 'selectOption');
    assert.deepEqual(step?.detail?.['selected'], ['A — Permanent']);
    assert.equal(step?.detail?.['readBack'], 'A — Permanent');
  });

  it('selectOption records the first non-placeholder native option chosen for ANY_OFFERED', async () => {
    const bundle = await run({
      name: 'native any offered',
      steps: [
        { action: 'goto', url: '/' },
        { action: 'selectOption', selector: '#native-choice', value: ANY_OFFERED },
      ],
    });
    assert.equal(bundle.status, 'passed', bundle.error ?? '');
    const detail = bundle.steps.find((step) => step.action === 'selectOption')?.detail;
    assert.equal(detail?.['actual'], 'Alpha');
    assert.deepEqual(detail?.['valueSource'], {
      kind: 'generated',
      detail: 'the sheet named no value; took the first option the control offered: "Alpha"',
    });
  });

  it('a disabled option is a state verdict in seconds, never a dead end (EH-01/EH-14)', async () => {
    const started = Date.now();
    const bundle = await run({
      name: 'disabled option',
      steps: [
        { action: 'goto', url: '/' },
        { action: 'selectOption', selector: '#grp', value: 'C - Contract' },
      ],
    });
    assert.equal(bundle.status, 'failed', `verdict, not dead-end: ${bundle.error ?? ''}`);
    const step = bundle.steps.find((s) => s.action === 'selectOption');
    assert.match(step?.error ?? '', /element is not enabled|no option named/);
    assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started}ms`);
  });

  it('a click on a disabled control is a failed verdict, not a four-rung timeout (EH-14)', async () => {
    const started = Date.now();
    const bundle = await run({
      name: 'disabled click',
      steps: [
        { action: 'goto', url: '/' },
        { action: 'click', selector: '#submit', intent: 'try to submit while the form is incomplete' },
      ],
    });
    assert.equal(bundle.status, 'failed', bundle.error ?? '');
    assert.match(bundle.steps[1]?.error ?? '', /element is not enabled/);
    assert.ok(Date.now() - started < 12_000, `took ${Date.now() - started}ms`);
  });

  it('fill on a calendar button drives the dialog to the day and reads the field back (EH-11)', async () => {
    const bundle = await run({
      name: 'calendar rung',
      steps: [
        { action: 'goto', url: '/' },
        { action: 'fill', selector: 'role=button[name="Hire Date" i]', value: '15 Nov 2027', intent: 'key Hire Date = 15 Nov 2027' },
        { action: 'expectText', selector: '#status', value: 'date:2027-11-15' },
      ],
    });
    assert.equal(bundle.status, 'passed', bundle.error ?? '');
    const step = bundle.steps.find((s) => s.action === 'fill');
    assert.equal(step?.resolution, 'narrow');
    assert.equal(step?.detail?.['enteredIso'], '2027-11-15');
    assert.match(String(step?.detail?.['enteredAs'] ?? ''), /15 Nov 2027/);
  });

  it('expectFieldError reads the message the field names, and only a field that has one (EH-12)', async () => {
    const bundle = await run({
      name: 'field error',
      steps: [
        { action: 'goto', url: '/' },
        { action: 'expectFieldError', selector: '#plan-name', value: 'Plan Name is required' },
        { action: 'expectFieldError', selector: '#amount' },
      ],
    });
    const [, ok, missing] = bundle.steps;
    assert.equal(ok?.status, 'passed', ok?.error ?? '');
    assert.equal(ok?.detail?.['via'], 'aria-describedby');
    assert.equal(missing?.status, 'failed', 'help text under a valid field is not an error');
    assert.match(missing?.error ?? '', /no validation message|none is shown/);
  });

  it('upload attaches through the dropzone and download lands in the variable store (EH-08)', async () => {
    const fixture = join(dir, 'import.csv');
    await writeFile(fixture, 'Plan ID,Plan name\nPL_10_07,Import\n');
    const downloads = join(dir, 'downloads');
    const bundle = await run(
      {
        name: 'upload and download',
        steps: [
          { action: 'goto', url: '/' },
          { action: 'upload', selector: '#dropzone', files: ['import.csv'] },
          { action: 'expectText', selector: '#status', value: 'file:import.csv' },
          { action: 'download', selector: 'text=Download Sample CSV', as: 'sample' },
        ],
      },
      { flowDir: dir, downloadDir: downloads },
    );
    assert.equal(bundle.status, 'passed', bundle.error ?? '');
    const up = bundle.steps.find((s) => s.action === 'upload');
    assert.equal(up?.detail?.['via'], 'descendant');
    const down = bundle.steps.find((s) => s.action === 'download');
    const captured = down?.detail?.['download'] as { filename: string; path: string } | undefined;
    assert.equal(captured?.filename, 'sample.csv');
    assert.match(await readFile(captured!.path, 'utf8'), /PL_00_01/);
  });

  it('a missing fixture is a harness error, never a defect against the app (EH-08)', async () => {
    const bundle = await run({ name: 'missing fixture', steps: [{ action: 'goto', url: '/' }, { action: 'upload', selector: '#dropzone', files: ['nope.csv'] }] }, { flowDir: dir });
    assert.equal(bundle.status, 'error');
    assert.match(bundle.steps[1]?.error ?? '', /fixture file not found/);
  });

  it('a click into the app\'s own 404 is a failed verdict with the heading as evidence, in seconds (EH-09)', async () => {
    const started = Date.now();
    const bundle = await run({
      name: 'not found',
      steps: [
        { action: 'goto', url: '/' },
        { action: 'click', selector: 'text=View Details' },
        { action: 'expectText', selector: 'body', value: 'Employee Profile' },
      ],
    });
    assert.equal(bundle.status, 'failed', bundle.error ?? '');
    assert.ok(!bundle.steps.some((s) => s.unsure !== undefined), 'the 404 heading is the evidence — no wording for a judge');
    const click = bundle.steps[1];
    assert.equal(click?.status, 'passed');
    assert.match(String(click?.detail?.['landedOnNotFound'] ?? ''), /404|หน้านี้ถูกย้าย/);
    const check = bundle.steps[2];
    assert.equal(check?.status, 'failed');
    assert.match(check?.error ?? '', /not-found: the page is showing/);
    assert.ok(check?.pageContext?.some((c) => /404|หน้านี้ถูกย้าย/.test(c)), JSON.stringify(check?.pageContext));
    assert.ok(bundle.defects.some((d) => /missing page/.test(d.title)));
    assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started}ms`);
  });

  it('text nowhere on the page is an absence verdict after one patience window (EH-06)', async () => {
    const started = Date.now();
    const bundle = await run({
      name: 'absence',
      steps: [
        { action: 'goto', url: '/' },
        { action: 'expectText', selector: 'body', value: 'Employee Profile' },
        { action: 'expectVisible', selector: 'role=button[name="Ghost control"]' },
        // Held by the page: the strict claim still fails, but through the ordinary path.
        { action: 'expectVisible', selector: 'role=heading[name="Benefit Plan"]' },
      ],
    });
    // A verdict, judge-eligible: `failed`, or `needs-review` when the gate
    // reads the miss as a wording question — never a dead end.
    assert.ok(bundle.status === 'failed' || bundle.status === 'needs-review', bundle.status);
    assert.equal(bundle.steps[1]?.status, 'failed');
    assert.equal(bundle.steps[2]?.status, 'failed');
    assert.match(bundle.steps[1]?.error ?? '', /absence: "Employee Profile" is not in the page's visible text/);
    assert.match(bundle.steps[2]?.error ?? '', /absence: "Ghost control"/);
    assert.equal(bundle.steps[3]?.status, 'passed');
    assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started}ms`);
  });

  it('a declared timeoutMs is the patience window — and when it runs out, the verdict (EH-07)', async () => {
    const bundle = await run(
      {
        name: 'declared patience',
        steps: [
          { action: 'goto', url: '/late' },
          { action: 'expectHidden', selector: '#toast', timeoutMs: 5_000 },
          { action: 'expectText', selector: '#status', value: 'Complete', timeoutMs: 8_000 },
          { action: 'waitFor', selector: '#never', timeoutMs: 1_000 },
        ],
      },
      { fastTimeoutMs: 300, healedTimeoutMs: 500 },
    );
    const [, hidden, late, never] = bundle.steps;
    assert.equal(hidden?.status, 'passed', hidden?.error ?? '');
    assert.ok(Number(hidden?.detail?.['waitedMs']) > 500, 'the toast needed the declared window');
    assert.equal(late?.status, 'passed', late?.error ?? '');
    assert.equal(late?.resolution, 'late');
    assert.equal(never?.status, 'failed', 'a declared wait that ran out is a verdict, not a dead end');
    assert.match(never?.error ?? '', /declared its own patience \(1000ms\)/);
  });

  it('expectAnyVisible passes on the first visible alternative and names it (CG-08)', async () => {
    const bundle = await run({
      name: 'either or',
      steps: [
        { action: 'goto', url: '/' },
        { action: 'expectAnyVisible', selectors: ['#toast-ok', 'text=Plan ID already exists'] },
        { action: 'expectAnyVisible', selectors: ['#toast-ok', '#toast-never'] },
      ],
    });
    assert.equal(bundle.steps[1]?.status, 'passed', bundle.steps[1]?.error ?? '');
    assert.equal(bundle.steps[1]?.detail?.['matched'], 'text=Plan ID already exists');
    assert.equal(bundle.steps[2]?.status, 'failed');
    assert.match(bundle.steps[2]?.error ?? '', /none of 2 visible: "#toast-ok", "#toast-never"/);
  });

  it('a row named by one cell is acted on when exactly one row holds it, never when two do (EH-04)', async () => {
    const bundle = await run({
      name: 'row scope',
      steps: [
        { action: 'goto', url: '/' },
        { action: 'click', selector: 'role=row[name="PL_07_01" i] >> role=button[name="Make Correction" i]' },
        { action: 'expectText', selector: '#status', value: 'corrected:PL_07_01' },
        { action: 'click', selector: 'role=row[name="Medical" i] >> role=button[name="Make Correction" i]' },
      ],
    });
    assert.equal(bundle.steps[1]?.status, 'passed', bundle.steps[1]?.error ?? '');
    assert.equal(bundle.steps[1]?.resolution, 'narrow');
    assert.equal(bundle.steps[2]?.status, 'passed');
    assert.notEqual(bundle.steps[3]?.status, 'passed');
    assert.match(bundle.steps[3]?.error ?? '', /2 rows contain "Medical" — ambiguous/);
  });

  it('an assertion about an option inside a closed popup opens the list the intent names (EH-14)', async () => {
    const bundle = await run({
      name: 'open popup',
      steps: [
        { action: 'goto', url: '/' },
        { action: 'expectDisabled', selector: 'role=option[name="Other" i]', intent: 'the Gender option Other cannot be chosen' },
      ],
    });
    assert.equal(bundle.status, 'passed', bundle.error ?? '');
    assert.equal(bundle.steps[1]?.resolution, 'reveal');
  });

  it('a dialog the flow opened stays open when a step inside it misses (EH-02)', async () => {
    const bundle = await run({
      name: 'dialog context',
      steps: [
        { action: 'goto', url: '/' },
        { action: 'click', selector: 'role=button[name="Edit rule" i]' },
        { action: 'expectModal', name: 'Edit rule' },
        { action: 'fill', selector: 'role=textbox[name="Rule name" i]', value: 'R1' },
        // Misses, inside the dialog, after a fill: neither reason may close it.
        { action: 'expectText', selector: 'role=dialog >> role=textbox[name="Rule name" i]', value: 'zzz' },
        { action: 'expectVisible', selector: 'role=dialog' },
        { action: 'click', selector: 'role=dialog >> role=button[name="Save" i]' },
        { action: 'expectText', selector: '#status', value: 'saved:R1' },
      ],
    });
    assert.equal(bundle.steps[2]?.status, 'passed', bundle.steps[2]?.error ?? '');
    assert.equal(bundle.steps[2]?.detail?.['mentionedVia'], 'heading', 'the eyebrow comes first; the heading names it');
    assert.equal(bundle.steps[4]?.status, 'failed');
    assert.match(bundle.steps[4]?.error ?? '', /treated as the intended context, not a blocker/);
    assert.equal(bundle.steps[5]?.status, 'passed', 'the dialog survived the miss');
    assert.equal(bundle.steps[7]?.status, 'passed', bundle.steps[7]?.error ?? '');
    assert.equal(bundle.summary.dialogsDismissed ?? 0, 0);
  });

  it('expectValue and expectText concede the sheet\'s dash, and say so (EH-05)', async () => {
    const bundle = await run({
      name: 'normalised',
      steps: [
        { action: 'goto', url: '/' },
        { action: 'expectValue', selector: '#group-code', value: 'A - Permanent' },
        { action: 'expectText', selector: '#group-badge', value: 'A - Permanent' },
        { action: 'expectText', selector: '#group-badge', value: 'B - Temporary' },
      ],
    });
    assert.equal(bundle.steps[1]?.status, 'passed', bundle.steps[1]?.error ?? '');
    assert.equal(bundle.steps[1]?.detail?.['relaxation'], 'normalised');
    assert.equal(bundle.steps[2]?.status, 'passed', bundle.steps[2]?.error ?? '');
    assert.equal(bundle.steps[2]?.detail?.['relaxation'], 'normalised');
    assert.equal(bundle.steps[3]?.status, 'failed', 'a different value is still a failure');
  });
});
