/**
 * The agent's wave-2 hub halves (2026-09-03): the menu-path walker, the
 * listbox-backed selectOption, the date-input redirect, the DONE ledger, the
 * REQUIRED AND STILL EMPTY line, the full-tree finish settlement over every
 * `set X = Y`, `save`/`signOut`, observations on the record, the tree-change
 * progress credit, the wizard hint and the multi-persona refusal.
 *
 * The ledger, the prompt layout, the action sets and the multi-persona
 * refusal are pure and run always. Everything that drives a page is
 * browser-tier with a scripted `AgentModel` (no LLM key), the way
 * tests/agent-guards.test.ts does it — whether an open trigger is re-clicked,
 * whether a hidden date input takes the value, whether the walker prefers an
 * exact tab over a containing one, are facts about a real browser. The page
 * is opened over CDP directly rather than through `withPage`, because the
 * orchestrator never imports the runner and neither should its own suite.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { chromium, type Page } from 'playwright';

import {
  AGENT_ACTIONS,
  AGENT_NO_PROGRESS_TURNS,
  AGENT_TREE_CHANGE_CREDITS,
  IDLE_ACTIONS,
  INTERACTION_ACTIONS,
  READ_ONLY_ACTIONS,
  REVEAL_ACTIONS,
  WorkflowAgent,
  buildUserPrompt,
  deploymentAwareAgentUrl,
  doneLedger,
  type AgentDecision,
  type AgentModel,
  type AgentObservation,
  type ObservedAgentAction,
} from '../src/orchestrator/workflow-agent.js';
import type { AgentAction } from '../src/engine/proof-bundle.js';

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';
async function cdpAvailable(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}
const skipBrowser = (await cdpAvailable(CDP_URL)) ? false : `no CDP endpoint at ${CDP_URL}`;

describe('deploymentAwareAgentUrl', () => {
  it('keeps the deployment base path when an agent emits a locale-rooted URL', () => {
    assert.equal(
      deploymentAwareAgentUrl(
        'https://humi-sit-int.central.co.th/th/admin/system/security/consent',
        'https://humi-sit-int.central.co.th/humi/th/home',
      ),
      'https://humi-sit-int.central.co.th/humi/th/admin/system/security/consent',
    );
  });

  it('leaves an already deployment-prefixed URL unchanged', () => {
    assert.equal(
      deploymentAwareAgentUrl(
        'https://humi-sit-int.central.co.th/humi/en/profile/me?tab=consent',
        'https://humi-sit-int.central.co.th/humi/th/home',
      ),
      'https://humi-sit-int.central.co.th/humi/en/profile/me?tab=consent',
    );
  });
});

async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 720 });
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

function scripted(answers: Partial<AgentDecision>[]): { model: AgentModel; seen: AgentObservation[] } {
  const seen: AgentObservation[] = [];
  let i = 0;
  return {
    seen,
    model: {
      id: 'stub:scripted',
      async decide(observation: AgentObservation): Promise<AgentDecision> {
        seen.push(observation);
        const next = answers[Math.min(i, answers.length - 1)]!;
        i += 1;
        return { action: 'fail', selector: '', value: '', url: '', reasoning: 'scripted', ...next };
      },
    },
  };
}

function okAction(index: number, action: string, selector: string, value: string | null = null): AgentAction {
  return { index, action, selector, value, url: 'http://x.test/form', reasoning: 'r', ok: true, durationMs: 1 };
}

// ---------------------------------------------------------------------------
// Pure tier
// ---------------------------------------------------------------------------

describe('the DONE ledger (OA-7)', () => {
  it('renders every field of a 30-fill history once, the last value winning, repeats counted', () => {
    const actions: AgentAction[] = [];
    for (let i = 0; i < 30; i += 1) {
      actions.push(okAction(i, 'fill', `role=textbox[name="Field ${i}" i]`, `v${i}`));
    }
    // A refill of Field 3 with a new value, two Next clicks, a failed action
    // and an idle read — only the ok interactions count, once per control.
    actions.push(okAction(30, 'fill', 'role=textbox[name="Field 3" i]', 'again'));
    actions.push(okAction(31, 'click', 'role=button[name="Next" i]'));
    actions.push(okAction(32, 'click', 'role=button[name="Next" i]'));
    actions.push({ ...okAction(33, 'fill', 'role=textbox[name="Broken" i]', 'x'), ok: false, error: 'no' });
    actions.push(okAction(34, 'read', 'role=textbox[name="Field 1" i]'));
    const ledger = doneLedger(actions, 100_000);
    assert.ok(ledger !== null);
    assert.match(ledger, /^DONE so far \(33 actions\): /);
    for (let i = 0; i < 30; i += 1) {
      const hits: number = ledger.split(`fill Field ${i}=`).length - 1;
      assert.equal(hits, 1, `Field ${i} appears exactly once`);
    }
    assert.ok(ledger.includes('fill Field 3="again"'), 'the last value wins');
    assert.ok(!ledger.includes('"v3"'));
    assert.ok(ledger.includes('click Next(x2)'), 'repeated activations are counted');
    assert.ok(!ledger.includes('Broken'), 'a failed action is not done');
    assert.ok(!ledger.includes('read'), 'a look is not an interaction');
  });

  it('masks a password-shaped value, caps its length, and is null when nothing is done', () => {
    const ledger = doneLedger([okAction(0, 'fill', 'input[type="password"]', 'hunter2')]);
    assert.ok(ledger !== null && ledger.includes('•••• (7 chars)') && !ledger.includes('hunter2'));
    const long = doneLedger(
      Array.from({ length: 80 }, (_, i) => okAction(i, 'fill', `role=textbox[name="A long field label number ${i}" i]`, `value ${i}`)),
    );
    assert.ok(long !== null && long.length <= 700 && long.endsWith('…'));
    assert.equal(doneLedger([okAction(0, 'wait', '')]), null);
    assert.equal(doneLedger([]), null);
  });
});

describe('the turn prompt carries the form gaps and the ledger in their stable slots (OA-6, OA-7)', () => {
  const base = {
    goal: 'fill every required field',
    url: 'http://x/form',
    axTree: 'textbox "Bank*"\nbutton "Save"',
    history: Array.from({ length: 12 }, (_, i) => `fill role=textbox[name="F${i}" i] = "v" — ok, still at http://x/form`),
    stepsRemaining: 5,
  };
  const at = (prompt: string, needle: string): number => {
    const index = prompt.indexOf(needle);
    assert.ok(index >= 0, `${needle} missing`);
    return index;
  };

  it('prints REQUIRED AND STILL EMPTY after the tree and before the URL, and the ledger where the elision line was', () => {
    const prompt = buildUserPrompt({
      ...base,
      caseContext: 'Case: HIR-EC-106',
      formGaps: 'REQUIRED AND STILL EMPTY (1): textbox "Bank*"',
      ledger: 'DONE so far (12 actions): fill F0="v" · fill F1="v"',
      feedback: 'that selector is not in the tree',
    });
    assert.ok(at(prompt, 'GOAL:') < at(prompt, 'THE TEST CASE THIS STEP SERVES'));
    assert.ok(at(prompt, 'THE TEST CASE') < at(prompt, 'Accessibility tree:'));
    assert.ok(at(prompt, 'Accessibility tree:') < at(prompt, 'REQUIRED AND STILL EMPTY (1)'));
    assert.ok(at(prompt, 'REQUIRED AND STILL EMPTY (1)') < at(prompt, 'Current URL:'));
    assert.ok(at(prompt, 'Current URL:') < at(prompt, 'What you have tried:'));
    assert.ok(at(prompt, 'What you have tried:') < at(prompt, 'DONE so far (12 actions)'));
    assert.ok(at(prompt, 'DONE so far') < at(prompt, 'fill role=textbox[name="F4" i]'), 'the ledger precedes the verbatim tail');
    assert.ok(!prompt.includes('earlier action(s) elided'), 'the ledger replaces the elision line');
    assert.ok(prompt.trimEnd().endsWith('that selector is not in the tree'), 'feedback stays last');
    assert.ok(!/remaining/i.test(prompt));
  });

  it('keeps the elision line when no ledger is given, and prints nothing extra when there are no gaps', () => {
    const prompt = buildUserPrompt(base);
    assert.ok(prompt.includes('(4 earlier action(s) elided)'));
    assert.ok(!prompt.includes('REQUIRED AND STILL EMPTY'));
    assert.ok(!prompt.includes('DONE so far'));
  });
});

describe('the vocabulary gained save and signOut (OA-8, OA-15)', () => {
  it('save is idle and read-only-safe; signOut is an interaction and never a reveal or read-only action', () => {
    assert.ok((AGENT_ACTIONS as readonly string[]).includes('save'));
    assert.ok((AGENT_ACTIONS as readonly string[]).includes('signOut'));
    assert.ok(IDLE_ACTIONS.has('save'));
    assert.ok(READ_ONLY_ACTIONS.has('save'));
    assert.ok(!INTERACTION_ACTIONS.has('save'));
    assert.ok(INTERACTION_ACTIONS.has('signOut'));
    assert.ok(!REVEAL_ACTIONS.has('signOut'));
    assert.ok(!READ_ONLY_ACTIONS.has('signOut'));
    assert.ok(!IDLE_ACTIONS.has('signOut'));
  });

  it('the tree-change credit is bounded by the no-progress budget', () => {
    assert.equal(AGENT_TREE_CHANGE_CREDITS, AGENT_NO_PROGRESS_TURNS * 3);
  });
});

describe('a multi-persona goal is refused before the first turn (OA-15)', () => {
  it('returns the split as a summary with the protocol prefix, no model call, no action', async () => {
    const { model, seen } = scripted([{ action: 'finish', reasoning: 'done' }]);
    const agent = new WorkflowAgent({ model, maxSteps: 3 });
    const page = { url: () => 'http://x.test/en/leave' } as unknown as Page;
    const result = await agent.run(
      page,
      'Login as <EMPLOYEE_ACCOUNT>, submit the leave request, then sign in as <MANAGER_ACCOUNT> and approve it',
    );
    assert.equal(result.success, false);
    assert.match(result.summary, /^multi-persona goal: this leg must be authored as separate steps \(signOut → sign-in as manager → workflow\)/);
    assert.match(result.summary, /names employee and manager/);
    assert.equal(seen.length, 0, 'no model turn spent');
    assert.equal(result.turns, 0);
    assert.equal(result.actions.length, 0);
    assert.equal(result.settledBy, undefined);
  });

  it('is recognised as an AUTHORING refusal, so the runner cannot file it against the application', async () => {
    // The prefix was declared to be "the protocol run-cases reads" and had no
    // reader anywhere in src/: the refused leg fell through to the ordinary
    // failed-leg path and became `functional` / `high`, "Workflow goal not
    // reached" — a fact about how the goal was worded, filed as a broken
    // feature. `personaRefusal` is the reader; the runner branches on it
    // beside the provider refusal and files no defect.
    const { personaRefusal, agentModelUnavailable } = await import('../src/orchestrator/goal-evidence.js');
    const { model } = scripted([{ action: 'finish', reasoning: 'done' }]);
    const agent = new WorkflowAgent({ model, maxSteps: 3 });
    const page = { url: () => 'http://x.test/en/leave' } as unknown as Page;
    const result = await agent.run(page, 'sign in as <EMPLOYEE_ACCOUNT> and submit it, then as <MANAGER_ACCOUNT> approve it');

    assert.equal(personaRefusal(result.summary), true, 'the summary the guard actually produces is recognised');
    // The two harness-class branches stay distinct: a refused goal is not a
    // dead provider, and neither is an ordinary failed leg.
    assert.equal(agentModelUnavailable(result.summary), false);
    assert.equal(personaRefusal('agent model failed: the provider refused'), false);
    assert.equal(personaRefusal('agent stalled: nothing advanced'), false);
    assert.equal(personaRefusal('the button does not exist on this page'), false);
  });

  it('a read-only look is exempt — it acts as nobody', async () => {
    const { model } = scripted([{ action: 'finish', reasoning: 'looked' }]);
    const agent = new WorkflowAgent({ model, maxSteps: 2 });
    const page = {
      url: () => 'http://x.test/en/leave',
      context: () => {
        throw new Error('no browser in this test');
      },
    } as unknown as Page;
    // Past the refusal the loop needs a browser (the already-showing rung
    // captures the tree); what matters here is that it GOT past it.
    await assert.rejects(
      agent.run(page, 'Login as <EMPLOYEE_ACCOUNT>, then as <MANAGER_ACCOUNT> approve it', { readOnly: true }),
      /no browser in this test/,
    );
  });
});

// ---------------------------------------------------------------------------
// Browser tier
// ---------------------------------------------------------------------------

const PAGE = (body: string, head = ''): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>f</title>${head}</head><body>${body}</body></html>`;

const SHELL = PAGE(
  `<div role="tablist" aria-label="กลุ่มเมนู">
     <button role="tab" id="hra" onclick="document.getElementById('which').textContent='analytics'">HR Analytics</button>
     <button role="tab" id="hr" onclick="document.getElementById('which').textContent='hr'">HR</button>
     <button role="tab">ME</button>
   </div>
   <span id="which"></span>
   <nav>
     <button id="ba" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.getElementById('sub').hidden=false">Benefits Admin</button>
     <div id="sub" hidden><a href="/shell/plans">Benefit Plans</a><a href="/shell/rules">Eligibility Rules</a></div>
     <button aria-expanded="false">Time Admin</button>
   </nav>`,
);

const SELECT = PAGE(
  `<div id="field">
     <span id="gl">Gender</span>
     <button id="trig" aria-labelledby="gl" aria-haspopup="listbox" aria-expanded="false" aria-controls="lst">Select Gender</button>
     <div id="pop" hidden>
       <input id="search" type="text" placeholder="Type to search..." aria-label="Search options">
       <ul id="lst" role="listbox" aria-label="Gender options">
         <li role="option">H_NEWHIRE — New Hire</li>
         <li role="option">H_REHIRE — Re-hire</li>
         <li role="option">Female</li>
         <li role="option">Male</li>
       </ul>
     </div>
   </div>
   <p id="log"></p>
   <script>
     var trig = document.getElementById('trig'), pop = document.getElementById('pop'), log = document.getElementById('log');
     function setOpen(open) { trig.setAttribute('aria-expanded', open ? 'true' : 'false'); pop.hidden = !open; log.textContent += open ? 'open;' : 'close;'; }
     trig.addEventListener('click', function () { setOpen(trig.getAttribute('aria-expanded') !== 'true'); });
     document.getElementById('search').addEventListener('input', function (e) {
       var q = e.target.value.toLowerCase();
       document.querySelectorAll('#lst [role=option]').forEach(function (o) { o.hidden = q !== '' && o.textContent.toLowerCase().indexOf(q) === -1; });
     });
     document.querySelectorAll('#lst [role=option]').forEach(function (o) {
       o.addEventListener('click', function () { trig.textContent = o.textContent; setOpen(false); });
     });
     document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });
   </script>`,
);

const DATE = PAGE(
  `<form>
     <div class="field">
       <label for="hd">Hire Date</label>
       <input id="disp" readonly aria-label="Select date" placeholder="Select date" value="">
       <input id="hd" type="date" aria-required="true" style="position:absolute;opacity:0">
     </div>
     <button type="button">Save</button>
   </form>`,
);

const WIZARD = PAGE(`<h1>New Hire</h1><p>Step 1 of 2</p><label>First name <input></label><button>Next</button>`);

const FORM = PAGE(
  `<form>
     <label>Bank* <input required></label>
     <label>Nickname <input></label>
     <label>Currency* <input required value="THB"></label>
     <label><input type="checkbox" required> Accept terms*</label>
     <button type="button">Submit</button>
   </form>`,
);

const SAVE = PAGE(`<h1>Employee created</h1><div id="emp">Employee ID: 20001234</div><p>Other text</p>`);

const LAZY = PAGE(
  `<h1>Employees</h1><div id="rows">${Array.from({ length: 12 }, (_, i) => `<p>Row ${i + 1}</p>`).join('')}</div>
   <script>
     var n = 12;
     window.addEventListener('scroll', function () { for (var k = 0; k < 4; k++) { n += 1; var p = document.createElement('p'); p.textContent = 'Row ' + n; document.getElementById('rows').appendChild(p); } });
   </script>`,
  '<style>body{min-height:40000px}</style>',
);

const STATIC = PAGE(`<h1>Employees</h1><p>Row 1</p><p>Row 2</p>`, '<style>body{min-height:40000px}</style>');

const APP = PAGE(`<h1>Home</h1><button onclick="location.href='/login'">Sign out</button>`);
const LOGIN = PAGE(`<h1>Login</h1><input aria-label="Email">`);

const STEPPED = PAGE(`<h1>Hire</h1><a href="?step=2">Next</a>`);

const NOISE = Array.from({ length: 80 }, (_, i) => `<li>Sidebar item ${i}</li>`).join('');
const PROFILE_FULL = PAGE(`<h1>Profile</h1><ul>${NOISE}</ul><p>Gender: Female</p><p>Nationality: Thai</p>`);
const PROFILE_HALF = PAGE(`<h1>Profile</h1><ul>${NOISE}</ul><p>Gender: Female</p><p>Nationality: (none)</p>`);

describe('the agent wave-2 hub halves (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;

  before(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const pages: Record<string, string> = {
        '/shell': SHELL,
        '/shell/plans': PAGE('<h1>Plans</h1>'),
        '/shell/rules': PAGE('<h1>Rules</h1>'),
        '/select': SELECT,
        '/date': DATE,
        '/wizard': WIZARD,
        '/form': FORM,
        '/save': SAVE,
        '/lazy': LAZY,
        '/static': STATIC,
        '/app': APP,
        '/login': LOGIN,
        '/stepped': STEPPED,
        '/profile-full': PROFILE_FULL,
        '/profile-half': PROFILE_HALF,
      };
      res.end(pages[path] ?? PAGE('<h1>Start</h1>'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  // ---- OA-2 -------------------------------------------------------------

  it('walks "A > B > C" from the goal at $0, preferring the exact tab over the containing one', async () => {
    const { model, seen } = scripted([]);
    const agent = new WorkflowAgent({ model, maxSteps: 4 });
    const result = await withPage(async (page) => {
      await page.goto(`${origin}/shell`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'Navigate via HR > Benefits Admin > Benefit Plans and end on /shell/plans');
    });
    assert.equal(result.success, true, result.summary);
    assert.equal(seen.length, 0, 'no model turn');
    assert.equal(result.turns, 0);
    assert.match(result.summary, /walking the menu path HR > Benefits Admin > Benefit Plans/);
    const clicks = result.actions.filter((a) => a.action === 'click' && a.ok);
    assert.equal(clicks.length, 3, JSON.stringify(result.actions));
    assert.equal(clicks[0]?.selector, 'role=tab[name="HR" i]', 'the exact "HR" tab, not "HR Analytics" which comes first');
    assert.equal(clicks[1]?.selector, 'role=button[name="Benefits Admin" i]');
    assert.equal(clicks[2]?.selector, 'role=link[name="Benefit Plans" i]');
    assert.match(clicks[0]?.reasoning ?? '', /menu path segment 1 of 3: "HR"/);
  });

  it('hands the model a partial walk when a segment is not in the tree', async () => {
    const { model, seen } = scripted([{ action: 'goto', url: `${origin}/shell/plans`, reasoning: 'x' }]);
    const agent = new WorkflowAgent({ model, maxSteps: 3 });
    const result = await withPage(async (page) => {
      await page.goto(`${origin}/shell`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'Navigate via HR > Payroll > Run Payroll and end on /shell/plans');
    });
    assert.equal(result.success, true, result.summary);
    assert.equal(seen.length, 1, 'the model was asked once, after the walk stopped');
    assert.ok(seen[0]!.history.some((h) => /click role=tab\[name="HR" i\] — ok \(menu path\)/.test(h)), JSON.stringify(seen[0]!.history));
    assert.ok(seen[0]!.history.some((h) => /menu path: "Payroll" is not in the tree after 1 level\(s\); asking the model/.test(h)));
  });

  it('does not click a section trigger that is already open', async () => {
    const { model } = scripted([]);
    const agent = new WorkflowAgent({ model, maxSteps: 3 });
    const result = await withPage(async (page) => {
      await page.goto(`${origin}/shell`, { waitUntil: 'domcontentloaded' });
      await page.locator('#ba').click();
      return agent.run(page, 'open Benefits Admin > Benefit Plans and end on /shell/plans');
    });
    assert.equal(result.success, true, result.summary);
    const clicks = result.actions.filter((a) => a.action === 'click');
    assert.equal(clicks.length, 1, 'the open trigger was not clicked again (a second click folds it)');
    assert.equal(clicks[0]?.selector, 'role=link[name="Benefit Plans" i]');
  });

  // ---- OA-1 -------------------------------------------------------------

  it('selectOption picks "Male" from a custom listbox — never "Female" by substring — and reports the read-back', async () => {
    const { model, seen } = scripted([
      { action: 'selectOption', selector: 'role=button[name="Gender" i]', value: 'Male', reasoning: 'pick' },
      { action: 'finish', reasoning: 'done' },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 3 });
    const result = await withPage(async (page) => {
      await page.goto(`${origin}/select`, { waitUntil: 'domcontentloaded' });
      const r = await agent.run(page, 'choose the gender option Male');
      return { r, shown: await page.locator('#trig').innerText(), expanded: await page.locator('#trig').getAttribute('aria-expanded') };
    });
    assert.equal(result.r.actions[0]?.ok, true, result.r.actions[0]?.error);
    assert.equal(result.shown, 'Male');
    assert.equal(result.expanded, 'false', 'the list is closed after the pick');
    const line = seen[1]!.history.find((h) => h.startsWith('selectOption'));
    assert.match(line ?? '', /picked "Male"/);
    assert.match(line ?? '', /the control now shows "Male"/);
  });

  it('selectOption does not re-click an open trigger, types into the popup search, and matches a code-prefixed option by whole words', async () => {
    const { model, seen } = scripted([
      { action: 'selectOption', selector: 'role=button[name="Gender" i]', value: 'New Hire', reasoning: 'pick' },
      { action: 'finish', reasoning: 'done' },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 3 });
    const result = await withPage(async (page) => {
      await page.goto(`${origin}/select`, { waitUntil: 'domcontentloaded' });
      await page.locator('#trig').click();
      assert.equal(await page.locator('#trig').getAttribute('aria-expanded'), 'true');
      const r = await agent.run(page, 'choose the event reason New Hire');
      return { r, shown: await page.locator('#trig').innerText(), log: await page.locator('#log').innerText() };
    });
    assert.equal(result.r.actions[0]?.ok, true, result.r.actions[0]?.error);
    assert.equal(result.shown, 'H_NEWHIRE — New Hire');
    assert.equal(result.log, 'open;close;', 'opened once by the test, closed once by the pick — never toggled shut by a second click');
    const line = seen[1]!.history.find((h) => h.startsWith('selectOption')) ?? '';
    assert.match(line, /typed "New Hire" into the list search/);
    assert.match(line, /picked "H_NEWHIRE — New Hire"/);
  });

  it('selectOption names the options the list actually offered when the value is not among them, and closes the list', async () => {
    const { model, seen } = scripted([
      { action: 'selectOption', selector: 'role=button[name="Gender" i]', value: 'Other', reasoning: 'pick' },
      { action: 'fail', reasoning: 'not offered' },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 3 });
    const result = await withPage(async (page) => {
      await page.goto(`${origin}/select`, { waitUntil: 'domcontentloaded' });
      const r = await agent.run(page, 'choose the gender option Other');
      return { r, expanded: await page.locator('#trig').getAttribute('aria-expanded') };
    });
    assert.equal(result.r.actions[0]?.ok, false);
    assert.match(result.r.actions[0]?.error ?? '', /no option named "Other" appeared/);
    assert.match(result.r.actions[0]?.error ?? '', /"Female"/);
    assert.equal(result.expanded, 'false', 'the list was closed again after the miss');
    assert.ok(seen[1]!.history.some((h) => /FAILED: .*no option named "Other"/.test(h)));
  });

  // ---- OA-5 -------------------------------------------------------------

  it('a paste at a read-only date display writes ISO into the date input beside it', async () => {
    const { model, seen } = scripted([
      { action: 'paste', selector: 'role=textbox[name="Select date" i]', value: '15/09/2027', reasoning: 'date' },
      { action: 'finish', reasoning: 'done' },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 3 });
    const result = await withPage(async (page) => {
      await page.goto(`${origin}/date`, { waitUntil: 'domcontentloaded' });
      const r = await agent.run(page, 'enter the hire date 15/09/2027');
      return { r, held: await page.locator('#hd').inputValue() };
    });
    assert.equal(result.r.actions[0]?.ok, true, result.r.actions[0]?.error);
    assert.equal(result.held, '2027-09-15');
    const line = seen[1]!.history.find((h) => h.startsWith('paste')) ?? '';
    assert.match(line, /read-only display — wrote to the date input beside it/);
    assert.match(line, /wrote 2027-09-15 for "15\/09\/2027"/);
  });

  it('a fill at a read-only display with no date input beside it is still refused with advice', async () => {
    const { model } = scripted([
      { action: 'fill', selector: 'role=textbox[name="Nickname" i]', value: 'x', reasoning: 'fill' },
      { action: 'fail', reasoning: 'stop' },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 3 });
    const result = await withPage(async (page) => {
      await page.goto(`${origin}/form`, { waitUntil: 'domcontentloaded' });
      await page.locator('role=textbox[name="Nickname" i]').evaluate((el) => {
        (el as unknown as { readOnly: boolean }).readOnly = true;
      });
      return agent.run(page, 'set Nickname = x');
    });
    assert.equal(result.actions[0]?.ok, false);
    assert.match(result.actions[0]?.error ?? '', /READ-ONLY field/);
  });

  // ---- OA-11 ------------------------------------------------------------

  it('a miss on a wizard step says which step the page is on', async () => {
    const { model, seen } = scripted([
      { action: 'fill', selector: 'role=textbox[name="Salary" i]', value: '50000', reasoning: 'fill' },
      { action: 'fill', selector: 'role=textbox[name="Salary" i]', value: '50000', reasoning: 'fill again' },
      { action: 'fail', reasoning: 'stop' },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 4 });
    const result = await withPage(async (page) => {
      await page.goto(`${origin}/wizard`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'fill in the Salary');
    });
    const miss = result.actions.find((a) => a.action === 'fill' && !a.ok);
    assert.ok(miss, JSON.stringify(result.actions));
    assert.match(miss.error ?? '', /no element matches/);
    assert.match(miss.error ?? '', /this page is step 1 of 2 of a wizard: the field is probably on a later step/);
    assert.ok(seen.some((o) => o.history.some((h) => /step 1 of 2 of a wizard/.test(h))), 'the hint reaches the next turn');
  });

  // ---- OA-6 / OA-14 -----------------------------------------------------

  it('lists the required controls still empty under the tree, and a read carries its observation onto the record', async () => {
    const { model, seen } = scripted([
      { action: 'read', selector: 'role=textbox[name="Bank*" i]', reasoning: 'look' },
      { action: 'finish', reasoning: 'done' },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 3 });
    const result = await withPage(async (page) => {
      await page.goto(`${origin}/form`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'read the Bank field');
    });
    const gaps = seen[0]!.formGaps ?? '';
    assert.match(gaps, /^REQUIRED AND STILL EMPTY \(2\): /, gaps);
    assert.ok(gaps.includes('textbox "Bank*"'));
    assert.ok(gaps.includes('checkbox "Accept terms*"'));
    assert.ok(!gaps.includes('Currency'), 'a required field that holds a value is not a gap');
    assert.ok(!gaps.includes('Nickname'), 'an optional field is not a gap');
    const read = result.actions[0] as ObservedAgentAction;
    assert.equal(read.ok, true, read.error);
    assert.match(read.observed ?? '', /required/);
    assert.deepEqual(result.observations?.map((o) => o.selector), ['role=textbox[name="Bank*" i]']);
    assert.match(result.observations?.[0]?.text ?? '', /required/);
  });

  // ---- OA-8 -------------------------------------------------------------

  it('save reads the value the page shows, strips the label the goal names, and hands it to the run\'s store', async () => {
    const saved: Array<[string, string]> = [];
    const { model, seen } = scripted([
      { action: 'save', selector: '#emp', value: 'EMPLOYEE_ID', reasoning: 'remember' },
      { action: 'finish', reasoning: 'done' },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 3 });
    const result = await withPage(async (page) => {
      await page.goto(`${origin}/save`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'save the generated Employee ID as EMPLOYEE_ID', {
        saveVariable: (name, value) => {
          saved.push([name, value]);
        },
      });
    });
    assert.equal(result.success, true, result.summary);
    assert.deepEqual(saved, [['EMPLOYEE_ID', '20001234']]);
    assert.ok(seen[1]!.history.some((h) => /save #emp — ok \(saved EMPLOYEE_ID = "20001234"\)/.test(h)), JSON.stringify(seen[1]!.history));
    assert.equal((result.actions[0] as ObservedAgentAction).observed, 'EMPLOYEE_ID = "20001234"');
    assert.equal(result.observations?.length, 1);
  });

  // ---- OA-15 ------------------------------------------------------------

  it('signOut ends the session through the app\'s own control', async () => {
    const { model, seen } = scripted([{ action: 'signOut', reasoning: 'next person' }, { action: 'finish', reasoning: 'done' }]);
    const agent = new WorkflowAgent({ model, maxSteps: 3 });
    const result = await withPage(async (page) => {
      await page.goto(`${origin}/app`, { waitUntil: 'domcontentloaded' });
      const r = await agent.run(page, 'sign out of the application');
      return { r, url: page.url() };
    });
    assert.equal(result.r.actions[0]?.ok, true, result.r.actions[0]?.error);
    assert.equal(result.r.actions[0]?.action, 'signOut');
    assert.match(result.url, /\/login$/);
    assert.ok(seen[1]!.history.some((h) => /signOut .*signed out via button "Sign out"/.test(h)), JSON.stringify(seen[1]!.history));
  });

  // ---- OA-9 -------------------------------------------------------------

  it('a query-only URL change reads as "still on the page, now at ?step=2"', async () => {
    const { model, seen } = scripted([
      { action: 'click', selector: 'role=link[name="Next" i]', reasoning: 'next step' },
      { action: 'finish', reasoning: 'done' },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 3 });
    await withPage(async (page) => {
      await page.goto(`${origin}/stepped`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'go to the next step of the form');
    });
    const line = seen[1]!.history.find((h) => h.startsWith('click')) ?? '';
    assert.match(line, /still on the page, now at \?step=2/);
    assert.doesNotMatch(line, /moved/);
  });

  // ---- OA-3 / OA-4 ------------------------------------------------------

  it('settles a finish against the FULL tree, every set X = Y shown, on a page larger than the prompt budget', async () => {
    const { model, seen } = scripted([{ action: 'finish', reasoning: 'both shown' }]);
    const agent = new WorkflowAgent({ model, maxSteps: 2 });
    const result = await withPage(async (page) => {
      await page.goto(`${origin}/profile-full`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'set Gender = Female and Nationality = Thai');
    });
    assert.ok(seen[0]!.axTree.includes('TREE TRUNCATED'), 'the prompt tree is over budget — the old settlement declined here');
    assert.equal(result.success, true, result.summary);
    assert.equal(result.settledBy, 'observed-state');
    assert.match(result.settledEvidence ?? '', /Gender: Female/);
    assert.match(result.settledEvidence ?? '', /Nationality: Thai/);
  });

  it('refuses a finish naming the pairs the page does not show, then records the contradiction', async () => {
    const { model, seen } = scripted([{ action: 'finish', reasoning: 'done' }]);
    const agent = new WorkflowAgent({ model, maxSteps: 4 });
    const result = await withPage(async (page) => {
      await page.goto(`${origin}/profile-half`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'set Gender = Female and Nationality = Thai');
    });
    assert.equal(result.success, false);
    assert.equal(result.summary, 'agent claimed finish, but the page does not show Nationality = "Thai"');
    assert.equal(seen.length, 2, 'refused once with the missing pair, then recorded');
    assert.ok(seen[1]!.history.some((h) => /refused finish: the page does not show Nationality = "Thai"/.test(h)), JSON.stringify(seen[1]!.history));
    assert.ok(!seen[1]!.history.some((h) => /Gender/.test(h)), 'the pair the page does show is not named as missing');
  });

  // ---- OA-10 ------------------------------------------------------------

  it('a scroll that renders more rows counts as progress; on a static page it does not', async () => {
    const scrolls = Array.from({ length: AGENT_NO_PROGRESS_TURNS + 3 }, () => ({ action: 'scroll' as const, reasoning: 'more rows' }));
    const lazy = scripted([...scrolls, { action: 'finish', reasoning: 'seen enough' }]);
    const lazyResult = await withPage(async (page) => {
      await page.goto(`${origin}/lazy`, { waitUntil: 'domcontentloaded' });
      return new WorkflowAgent({ model: lazy.model, maxAxNodes: 400 }).run(page, 'scroll through the employee list until it has rendered every row');
    });
    assert.equal(lazyResult.success, true, lazyResult.summary);
    assert.equal(lazy.seen.length, scrolls.length + 1, 'every scroll landed and the finish was asked for');
    assert.ok(lazy.seen[lazy.seen.length - 1]!.history.some((h) => /the page rendered more after that look/.test(h)));

    const still = scripted([...scrolls, { action: 'finish', reasoning: 'x' }]);
    const stillResult = await withPage(async (page) => {
      await page.goto(`${origin}/static`, { waitUntil: 'domcontentloaded' });
      return new WorkflowAgent({ model: still.model, maxAxNodes: 400 }).run(page, 'scroll through the employee list until it has rendered every row');
    });
    assert.equal(stillResult.success, false);
    assert.match(stillResult.summary, /looked and found nothing to act on/, 'an unchanged tree keeps the look-only handoff exactly as before');
  });
});
