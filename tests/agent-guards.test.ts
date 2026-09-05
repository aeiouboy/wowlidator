/**
 * The workflow agent's deterministic guards — what is checked before a
 * decision is acted on, and what the model is shown.
 *
 * The pure guards (`agent-guards.ts`) run always. The loop behaviours — a
 * refused finish, a stall, a fast-failed miss, the origin guard — are
 * browser-tier: each is a fact about a loop driving a real page with a
 * scripted model, and every one of them was invisible to a pure assertion
 * about the predicate alone. Same CDP gate as the other browser suites.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  decisionKey,
  focusTree,
  selectorGrounded,
  selectorName,
  goalAlreadyShowing,
  goalSurfaceNames,
  repeatedToggleClick,
  TOGGLE_CLICK_LIMIT,
  activationKey,
  reactivation,
  reactivationAdvanced,
  unscopedDestructiveClick,
  goalIdentifiers,
  DESTRUCTIVE_NAME,
  menuPathOf,
  menuNodeScore,
  multiPersonaGoal,
  multiPersonaSummary,
  formGaps,
  formatFormGaps,
  listboxCannotOffer,
} from '../src/orchestrator/agent-guards.js';
import {
  AGENT_ACTIONS,
  AGENT_LOOK_ONLY_TURNS,
  AGENT_NO_PROGRESS_OFF_TURNS,
  AGENT_NO_PROGRESS_TURNS,
  AGENT_OFF_PAGE_TURNS,
  AGENT_VALUE_HUNT_TURNS,
  DEFAULT_AGENT_MAX_STEPS,
  WorkflowAgent,
  agentEarlyStopDefault,
  parseWherePairs,
  type AgentDecision,
  type AgentObservation,
} from '../src/orchestrator/workflow-agent.js';
import { withPage } from '../src/engine/runner.js';
import type { AxNode } from '../src/healer/jit-healer.js';

const TREE = `RootWebArea "Queue" url="http://x.test/en/queue"
heading "Probation Reviews"
button "Team"
link "Probation Reviews" url="http://x.test/en/workflows/probation"
textbox "Work email" value="a@b.test"
button "Next"
cell "Somchai Sukjai EMP042"`;

describe('selectorGrounded', () => {
  it('reads the name a role or text selector asks for', () => {
    assert.equal(selectorName('role=button[name="Next" i]'), 'Next');
    assert.equal(selectorName("role=link[name='Probation Reviews']"), 'Probation Reviews');
    assert.equal(selectorName('text="EMP042"'), 'EMP042');
    assert.equal(selectorName('text=EMP042'), 'EMP042');
    assert.equal(selectorName('input[type="password"]'), null, 'CSS names nothing the tree could contradict');
    assert.equal(selectorName('role=textbox >> nth=1'), null);
  });

  it('accepts a name the tree shows, whatever its case, and a longer tree name', () => {
    assert.equal(selectorGrounded('role=button[name="next" i]', TREE), true);
    assert.equal(selectorGrounded('role=cell[name="Somchai Sukjai"]', TREE), true, 'the tree name is longer');
    assert.equal(selectorGrounded('text="EMP042"', TREE), true);
  });

  it('refuses a name made of words the tree never shows', () => {
    assert.equal(selectorGrounded('role=button[name="Create Plan" i]', TREE), false);
    assert.equal(selectorGrounded('role=button[name="HRIS ADMIN" i]', TREE), false);
  });

  it('says nothing about a selector it cannot read', () => {
    assert.equal(selectorGrounded('input[type="password"]', TREE), null);
    assert.equal(selectorGrounded('role=textbox >> nth=1', TREE), null);
  });
});

describe('goalAlreadyShowing', () => {
  const node = (role: string, name: string): AxNode => ({
    role, name, value: '', description: '', disabled: false, checked: false, url: '',
  });

  it("reads the surface a goal says should be showing, in the shapes catalogs actually write", () => {
    // Verbatim from the be100 run of 2026-08-26.
    assert.deepEqual(
      goalSurfaceNames('On /en/admin/benefits/plans click the Create Plan button so the Create Plan dialog opens'),
      ['Create Plan'],
    );
    assert.deepEqual(
      goalSurfaceNames('select one plan and click its Insert action so that the popup titled "Insert New Changes for Benefit" opens'),
      ['Insert New Changes for Benefit'],
    );
    // A placeholder the author left in names nothing.
    assert.deepEqual(goalSurfaceNames('the popup titled "Insert New Changes for Benefit: <plan name>" opens'), []);
    // Most goals name no surface at all, and must fall through untouched.
    assert.deepEqual(goalSurfaceNames('count every plan whose Benefit Type is Reimbursement'), []);
  });

  it('says the leg is done when that surface is already open', () => {
    // Six of ten agent runs in one pass ended after one or two turns having
    // discovered exactly this — the authored step before them had opened it.
    const nodes = [node('heading', 'Benefit Plan Catalog'), node('dialog', 'Create Benefit Plan')];
    assert.equal(
      goalAlreadyShowing('click the Create Plan button so the Create Plan dialog opens', nodes),
      'Create Benefit Plan',
    );
  });

  it('says nothing whenever the evidence is short of unambiguous', () => {
    // The cost of a false yes is a leg that never ran, which is far worse
    // than a leg that ran needlessly — so every uncertain case falls through.
    const noDialog = [node('heading', 'Create Benefit Plan'), node('button', 'Create Plan')];
    assert.equal(goalAlreadyShowing('click Create Plan so the Create Plan dialog opens', noDialog), null,
      'a heading is not an open dialog');
    const otherDialog = [node('dialog', 'Confirm delete plan')];
    assert.equal(goalAlreadyShowing('click Create Plan so the Create Plan dialog opens', otherDialog), null,
      'a different dialog is not this one');
    assert.equal(goalAlreadyShowing('reach the reporting screen', [node('dialog', 'Anything')]), null,
      'a goal that names no surface never fires');
  });
});

describe('listboxCannotOffer names the control across languages', () => {
  const goal = 'Fill the job section with exactly these values: Position = 40106337, Gender = Male';
  const decision = { action: 'selectOption', selector: 'role=button[name="ตำแหน่ง" i]', value: '40106337', url: '' };
  const shown = ['Store Manager', 'Cashier', 'Sales Staff'];

  it('the goal in one language and the selector in another do not meet on their own', () => {
    assert.equal(listboxCannotOffer(decision, shown, goal), null);
  });

  it('the trigger label the page printed carries both names, and the judge fires', () => {
    const verdict = listboxCannotOffer(decision, shown, goal, 'เลือกตำแหน่ง (Select Position)');
    assert.deepEqual(verdict, { control: 'Position', value: '40106337', shown });
  });

  it('a trigger that names a different control is not evidence about this one', () => {
    assert.equal(listboxCannotOffer(decision, shown, goal, 'เลือกบริษัท (Select Company)'), null);
  });

  it('a value the list does show is never a cannot-offer', () => {
    assert.equal(
      listboxCannotOffer(decision, ['40106337 - Studio Traffic Staff'], goal, 'เลือกตำแหน่ง (Select Position)'),
      null,
    );
  });
});

describe('unscopedDestructiveClick', () => {
  const goal = 'delete the plan PL_03_15_16_17_18 and confirm';
  const click = (selector: string) => ({ action: 'click', selector, value: '', url: '' });

  it('refuses "the first Delete button" when the goal names a row', () => {
    // be100 PL_03_18: this exact selector deleted TH_MED_001, a plan the goal
    // never named, and the reasoning said it was the right row.
    const why = unscopedDestructiveClick(click('role=button[name="Delete" i] >> nth=0'), goal);
    assert.match(why ?? '', /^destructive:/);
    assert.match(why ?? '', /PL_03_15_16_17_18/);
    assert.match(why ?? '', /role=row\[name="PL_03_15_16_17_18" i\]/, 'the feedback shows the scoped shape');
    assert.match(unscopedDestructiveClick(click('role=button[name="Remove" i]'), 'remove TH_MED_001') ?? '', /^destructive/);
  });

  it('accepts a delete scoped to the goal\'s row, and a confirmation inside a dialog', () => {
    assert.equal(unscopedDestructiveClick(click('role=row[name="PL_03_15_16_17_18" i] >> role=button[name="Delete" i]'), goal), null);
    assert.equal(unscopedDestructiveClick(click('text=PL_03_15_16_17_18 >> .. >> role=button[name="Delete"]'), goal), null);
    assert.equal(unscopedDestructiveClick(click('role=dialog[name="Confirm delete plan" i] >> role=button[name="Delete"]'), goal), null);
  });

  it('leaves non-destructive clicks, and goals that name no identifier, to the prompt', () => {
    assert.equal(unscopedDestructiveClick(click('role=button[name="Edit" i] >> nth=0'), goal), null);
    assert.equal(unscopedDestructiveClick(click('role=button[name="Delete" i] >> nth=0'), 'delete the first draft'), null);
    assert.equal(unscopedDestructiveClick({ action: 'fill', selector: 'role=textbox[name="Delete reason"]', value: 'x', url: '' }, goal), null);
  });
});

describe('agentEarlyStopDefault (the retry toggle, pure)', () => {
  it('is on unless the env says off', () => {
    assert.equal(agentEarlyStopDefault({}), true);
    assert.equal(agentEarlyStopDefault({ WOWLIDATOR_AGENT_EARLY_STOP: 'off' }), false);
    assert.equal(agentEarlyStopDefault({ WOWLIDATOR_AGENT_EARLY_STOP: 'OFF' }), false);
    assert.equal(agentEarlyStopDefault({ WOWLIDATOR_AGENT_EARLY_STOP: 'on' }), true);
  });
});

describe('repeatedToggleClick', () => {
  const click = { action: 'click', selector: 'role=button[name="Type:" i]', value: '', url: '' };

  it('lets a multi-select re-open its dropdown up to the limit', () => {
    const counts = new Map([[click.selector, TOGGLE_CLICK_LIMIT - 1]]);
    assert.equal(repeatedToggleClick(click, counts), null);
  });

  it('refuses the click past the limit, whatever the tree did since (PL_03_02\'s 8-toggle thrash)', () => {
    const counts = new Map([[click.selector, TOGGLE_CLICK_LIMIT]]);
    const refusal = repeatedToggleClick(click, counts);
    assert.match(refusal ?? '', /^circling:/);
    assert.match(refusal ?? '', /Do something different/);
  });

  it('refuses a PRESS past the limit too (2026-09-02, HIR-EC-009: a date-picker stepper pressed 30+ times escaped a click-only guard)', () => {
    const counts = new Map([[click.selector, TOGGLE_CLICK_LIMIT]]);
    const press = { ...click, action: 'press' as const };
    const refusal = repeatedToggleClick(press, counts);
    assert.match(refusal ?? '', /^circling:/);
    assert.equal(repeatedToggleClick({ ...press, selector: '' }, counts), null, 'a bare keypress with no selector is not an activation of a control');
  });

  it('says nothing about other actions, other selectors, or an empty selector', () => {
    const counts = new Map([[click.selector, 99]]);
    assert.equal(repeatedToggleClick({ ...click, action: 'scroll' }, counts), null);
    assert.equal(repeatedToggleClick({ ...click, selector: 'role=button[name="Other" i]' }, counts), null);
    assert.equal(repeatedToggleClick({ ...click, selector: '' }, counts), null);
  });
});

describe('reactivation — the same control on the same page is not progress (2026-09-03)', () => {
  const PAGE = 'http://localhost:3005/en/admin/hire?step=1';

  it('ec09 HIR-EC-009 leg [14]: a section header re-clicked on the same wizard page is a repeat, credited only if the tree changed', () => {
    // ~60 turns / 320 s re-opening headers, each click ok, each resetting the judge.
    const header = { action: 'click', selector: 'role=button[name="Personal Information" i]', value: '', url: '' };
    const activated = new Set<string>();
    assert.equal(reactivation(header, PAGE, activated), 'first');
    activated.add(activationKey(PAGE, header.selector));
    assert.equal(reactivation(header, PAGE, activated), 'repeat');
    assert.equal(reactivationAdvanced('repeat', false), false, 'the page did not change — not progress');
    assert.equal(reactivationAdvanced('repeat', true), true, 'the header actually opened — progress, bounded by the tree-change credits');
    assert.equal(reactivationAdvanced('first', false), true, 'a first activation is progress as before');
    assert.equal(reactivationAdvanced(null, false), true, 'a non-activation is left to the judge as before');
  });

  it('ec09 job-2, the Position picker: text typed again into the same search box is never progress, whatever the tree did', () => {
    // 122 requests / 18 min: type "40106337", fill "401063", fill "MKB12.12",
    // fill "", fill "4010", fill "40106337" into one textbox, each ok, between
    // failed selectOptions and ok re-clicks of the same button.
    const search = 'role=textbox[name="Search options" i]';
    const position = 'role=button[name="Position" i]';
    const activated = new Set<string>();
    const sequence: Array<{ action: string; selector: string; value: string; ok: boolean }> = [
      { action: 'selectOption', selector: position, value: '40106337', ok: false },
      { action: 'click', selector: position, value: '', ok: true },
      { action: 'type', selector: search, value: '40106337', ok: true },
      { action: 'fill', selector: search, value: '401063', ok: true },
      { action: 'fill', selector: search, value: 'MKB12.12', ok: true },
      { action: 'fill', selector: search, value: '', ok: true },
      { action: 'fill', selector: search, value: '4010', ok: true },
      { action: 'fill', selector: search, value: '40106337', ok: true },
      { action: 'click', selector: position, value: '', ok: true },
    ];
    const kinds: Array<ReturnType<typeof reactivation>> = [];
    for (const step of sequence) {
      if (!step.ok) continue; // a miss activated nothing and is never recorded
      const kind = reactivation({ ...step, url: '' }, PAGE, activated);
      kinds.push(kind);
      activated.add(activationKey(PAGE, step.selector));
    }
    assert.deepEqual(kinds, ['first', 'first', 'text-again', 'text-again', 'text-again', 'text-again', 'text-again', 'repeat']);
    assert.equal(reactivationAdvanced('text-again', true), false, 'the typed value echoes into the tree, so a change test alone would credit it');
    // The failed selectOption never entered the set: the button's first OK activation is still 'first'.
    assert.equal(kinds[1], 'first');
  });

  it('is scoped to the page the action was taken on, and says nothing about looks or a bare key', () => {
    const click = { action: 'click', selector: 'role=button[name="Next" i]', value: '', url: '' };
    const activated = new Set([activationKey(PAGE, click.selector)]);
    assert.equal(reactivation(click, 'http://localhost:3005/en/admin/hire?step=2', activated), 'first', 'the same selector on another URL is a new control');
    assert.equal(reactivation(click, PAGE, activated), 'repeat');
    assert.equal(reactivation({ ...click, action: 'scroll' }, PAGE, activated), null);
    assert.equal(reactivation({ ...click, action: 'goto', selector: '', url: PAGE }, PAGE, activated), null);
    assert.equal(reactivation({ ...click, action: 'press', selector: '' }, PAGE, activated), null, 'a bare keypress activates no named control');
    assert.equal(reactivation({ ...click, action: 'press' }, PAGE, activated), 'repeat', 'a targeted press counts as a click does');
  });

  it('leaves repeatedToggleClick exactly as it was: the whole-run count, not the per-page set', () => {
    const click = { action: 'click', selector: 'role=button[name="Type:" i]', value: '', url: '' };
    assert.equal(repeatedToggleClick(click, new Map([[click.selector, TOGGLE_CLICK_LIMIT - 1]])), null);
    assert.match(repeatedToggleClick(click, new Map([[click.selector, TOGGLE_CLICK_LIMIT]])) ?? '', /^circling:/);
  });
});

describe('the off-page allowance is a judge like the other two', () => {
  it('is small, exported, and lifted to the off ceiling like the others', () => {
    assert.equal(AGENT_OFF_PAGE_TURNS, 8);
    assert.ok(AGENT_OFF_PAGE_TURNS > AGENT_NO_PROGRESS_TURNS, 'a journey of a few moves must never trip it before the stall judge would');
    assert.ok(AGENT_OFF_PAGE_TURNS < AGENT_NO_PROGRESS_OFF_TURNS);
    assert.ok(AGENT_OFF_PAGE_TURNS < DEFAULT_AGENT_MAX_STEPS);
  });
});

describe('decisionKey', () => {
  it('is the same for the same action, selector, value and url — and nothing else', () => {
    const a = { action: 'fill', selector: 'input[type="password"]', value: 'pw', url: '' };
    assert.equal(decisionKey(a), decisionKey({ ...a, selector: ' input[type="password"] ' }));
    assert.notEqual(decisionKey(a), decisionKey({ ...a, value: 'other' }));
    assert.notEqual(decisionKey(a), decisionKey({ ...a, action: 'click' }));
  });
});

describe('focusTree', () => {
  const node = (role: string, name: string): AxNode => ({
    role, name, value: '', description: '', disabled: false, checked: false, url: '',
  });
  it('keeps the nodes the goal names inside the budget, in document order', () => {
    const nodes: AxNode[] = [
      ...Array.from({ length: 50 }, (_, i) => node('button', `Unrelated ${i}`)),
      node('link', 'Probation Reviews'),
      ...Array.from({ length: 50 }, (_, i) => node('StaticText', `Filler ${i}`)),
      node('button', 'Review'),
    ];
    const kept = focusTree(nodes, 'open Probation Reviews and click Review', 20);
    assert.equal(kept.length, 20);
    assert.ok(kept.some((n) => n.name === 'Probation Reviews'), 'the goal\'s link survives the cut');
    assert.ok(kept.some((n) => n.name === 'Review'), 'and so does the goal\'s button');
    // Document order is restored: the link (index 50) comes before the button (index 101).
    assert.ok(kept.findIndex((n) => n.name === 'Probation Reviews') < kept.findIndex((n) => n.name === 'Review'));
  });

  it("keeps the goal's own NUMBER, and the value beside the label it matched", () => {
    // be100 PL_03_01 (2026-08-25): "verify the Total Plans summary card shows
    // count 75" against a 345-node page. "75" is two characters, so the old
    // `length > 2` filter dropped the one term that named the answer; the
    // node called "75" scored zero and lost its place to sixty sidebar links.
    // The agent was shown the LABEL with the value removed, spent five turns
    // scrolling for it, and the next step's expectText "75" passed.
    const nodes: AxNode[] = [
      ...Array.from({ length: 40 }, (_, i) => node('link', `Sidebar ${i}`)),
      node('StaticText', 'TOTAL PLANS'),
      node('StaticText', '75'),
      ...Array.from({ length: 40 }, (_, i) => node('button', `Row action ${i}`)),
    ];
    const kept = focusTree(nodes, 'verify the Total Plans summary card shows count 75', 12);
    const names = kept.map((n) => n.name);
    assert.ok(names.includes('TOTAL PLANS'), 'the label the goal names');
    assert.ok(names.includes('75'), 'and the count, which is the whole answer');
    assert.ok(names.indexOf('TOTAL PLANS') < names.indexOf('75'), 'in document order');
  });

  it('carries a matched label\'s neighbour even when the value shares no goal term', () => {
    // A summary card is a label and a value as siblings, and the value is
    // frequently a number the goal does not state. Keeping the label and
    // cutting the number is the same failure with none of the evidence.
    const nodes: AxNode[] = [
      ...Array.from({ length: 30 }, (_, i) => node('link', `Noise ${i}`)),
      node('StaticText', 'REIMBURSEMENT BY HR'),
      node('StaticText', '4'),
      ...Array.from({ length: 30 }, (_, i) => node('button', `Action ${i}`)),
    ];
    const kept = focusTree(nodes, 'read the Reimbursement by HR card', 10).map((n) => n.name);
    assert.ok(kept.includes('REIMBURSEMENT BY HR'));
    assert.ok(kept.includes('4'), 'the neighbour rides in on the match');
  });

  it('returns everything untouched when it fits', () => {
    const nodes = [node('button', 'A'), node('link', 'B')];
    assert.deepEqual(focusTree(nodes, 'anything', 10), nodes);
  });
});

// --- the loop, against a real page -------------------------------------------

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';

async function cdpAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

const browserReady = await cdpAvailable(CDP_URL);
const skipBrowser = browserReady
  ? false
  : `no CDP endpoint at ${CDP_URL} — start Chrome with --remote-debugging-port=9222 (npm run chrome)`;

/** A model that answers from a script, and records what it was asked. */
function scripted(answers: Array<Partial<AgentDecision> & { action: AgentDecision['action'] }>) {
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
        return { selector: '', value: '', url: '', reasoning: 'scripted', ...next };
      },
    },
  };
}

describe('the agent loop refuses a wasted turn (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;

  before(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        path === '/en/done'
          ? '<h1>Done</h1>'
          : path === '/en/rows'
            ? '<h1>Plans</h1><table><tr><td>TH_MED_001</td><td><button onclick="document.title=\'deleted TH_MED_001\'">Delete</button></td></tr>' +
              '<tr><td>PL_03_18</td><td><button onclick="document.title=\'deleted PL_03_18\'">Delete</button></td></tr></table>'
            : path === '/en/stepper'
              ? // A date-picker year stepper: pressing Enter on it decrements the
                // shown year, so the tree genuinely changes every time (never
                // reaching the far-off target) — the exact HIR-EC-009 shape,
                // where the page-changed guard cannot see the repetition and
                // only the circling guard can.
                '<h1>Year: <span id="y">2026</span></h1><button id="prev">Previous year</button>' +
                '<script>document.getElementById("prev").addEventListener("keydown", function (e) {' +
                'if (e.key === "Enter") { var y = document.getElementById("y"); y.textContent = String(Number(y.textContent) - 1); } });</script>'
              : '<h1>Start</h1><a id="go" href="/en/done">Continue</a><button>Only button</button>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('does not accept a finish that contradicts the goal\'s destination', async () => {
    // The model insists it is done while still on /en/start. Before, this was
    // success=true and the runner's evidence check — which only runs on
    // failures — never saw it. The destination is one the tree does NOT link
    // to and the goal names a route, so neither zero-call rung can settle it
    // and the model is genuinely asked.
    const { model, seen } = scripted([{ action: 'finish', reasoning: 'done' }]);
    const agent = new WorkflowAgent({ model, maxSteps: 4 });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/start`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, `continue via the button and end on ${origin}/en/elsewhere`);
    });
    assert.equal(result.success, false);
    assert.match(result.summary, /claimed finish, but the goal ends on/);
    assert.equal(seen.length, 2, 'one re-ask, with the reason');
    assert.match(seen[1]?.feedback ?? '', /the goal ends on/);
  });

  it('stops as stalled when an ok action is repeated on an unchanged page', async () => {
    // PB_03_01's shape: the same action, again and again, nothing moving.
    const { model, seen } = scripted([
      { action: 'click', selector: 'role=button[name="Only button"]' },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 8 });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/start`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'press the only button until something happens');
    });
    assert.equal(result.success, false);
    assert.match(result.summary, /stalled/);
    // Turn 1 acts; turn 2 is refused once (feedback), refused again → stall.
    // Three asks in total, not eight turns of the same click.
    assert.equal(seen.length, 3);
    assert.match(seen[2]?.feedback ?? '', /already did/);
    assert.equal(result.turns, 2, 'the budget is not spent on repeats');
  });

  it('runs on the high backstop ceiling by default and stops itself well before it, on no-progress evidence', async () => {
    // No maxSteps given: the FIXED low ceiling is gone (2026-08-24) and the
    // judge that ends a going-nowhere loop is evidence — AGENT_NO_PROGRESS_TURNS
    // consecutive turns in which nothing succeeded. A FRESH failing action
    // every turn slips past the repeat guard (it only catches the same action
    // twice on an unchanged page); this is the stop that catches it.
    // `DEFAULT_AGENT_MAX_STEPS` (2026-09-02) is a much higher backstop for a
    // dead loop neither judge reaches, not a second competing ceiling: this
    // leg stops on the judge, turns short of it.
    const { model, seen } = scripted(
      Array.from({ length: AGENT_NO_PROGRESS_TURNS + 2 }, (_, i) => ({
        action: 'goto' as const,
        url: `https://site-${i}.example/`,
      })),
    );
    const agent = new WorkflowAgent({ model });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/start`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'reach the reporting screen');
    });
    assert.equal(result.success, false);
    assert.match(result.summary, new RegExp(`stalled: nothing advanced in ${AGENT_NO_PROGRESS_TURNS} consecutive turns`));
    assert.equal(result.turns, AGENT_NO_PROGRESS_TURNS, 'stopped by the judge, not a ceiling');
    assert.equal(seen.length, AGENT_NO_PROGRESS_TURNS, 'one ask per turn — a goto is refused in the act, never re-asked');
    assert.equal(result.maxSteps, DEFAULT_AGENT_MAX_STEPS, 'the backstop ceiling is recorded, but the judge stopped the leg first');
  });

  it('lets a repeated scroll or wait through, as a turn that advances nothing — never as a stall', async () => {
    // be100, 2026-08-25: seven runs ended as `stalled: repeated "scroll "` /
    // `"wait "` — the model asked to look again, was told it already had,
    // insisted once, and the run was recorded as a harness error with the
    // goal's control on screen. Looking again cannot change the app, so it is
    // never the stall the repeat guard exists for (the same fill, four
    // times); it is also never progress, so a loop that only looks still
    // ends — on evidence, not on the repeat guard. A goal like this one names
    // no control at all, so it now ends on the FASTER looked-only handoff
    // (2026-08-26, AGENT_LOOK_ONLY_TURNS) rather than riding out the full
    // no-progress judge — the ordinary stall path is covered separately by
    // "does NOT hand off once a real action has landed".
    const { model, seen } = scripted([{ action: 'scroll' }]);
    const agent = new WorkflowAgent({ model });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/start`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'find the export button');
    });
    assert.equal(result.success, false);
    assert.doesNotMatch(result.summary, /repeated/, 'a scroll is not a stall');
    assert.match(result.summary, /looked and found nothing to act on/);
    assert.equal(result.lookedOnly, true);
    assert.equal(result.turns, AGENT_LOOK_ONLY_TURNS);
    assert.ok(
      seen.some((o) => /will not reveal more/.test(o.feedback ?? '')),
      'the model was told once, per turn, that looking again changes nothing',
    );
    assert.ok(
      result.actions.filter((a) => a.action === 'scroll' && a.ok).length >= AGENT_LOOK_ONLY_TURNS,
      'the insisted-on scrolls were performed, not refused',
    );
  });

  it('hands off fast when every control-engaging click misses (PL_07_03: a filter absent from the tree)', async () => {
    // A nameless-role selector passes grounding (there is no name to check
    // against the tree) and then MISSES at the locator, 1.5 s each. The old
    // looked-only handoff needed EVERY action to be a scroll/wait, so a leg
    // that tried clicks and missed rode the full 5-turn stall at 1.5 s a miss
    // (measured: 77 s on one PL_07 leg). Now a leg that never once engages a
    // control hands off at AGENT_LOOK_ONLY_TURNS, softly — the flow's next
    // assertion is the proof.
    const { model } = scripted([{ action: 'click', selector: 'role=combobox >> nth=0' }]);
    const agent = new WorkflowAgent({ model });
    const started = Date.now();
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/start`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'open the Type filter and pick Reimbursement');
    });
    assert.equal(result.success, false);
    assert.equal(result.lookedOnly, true, 'a soft handoff, not a hard failure');
    assert.match(result.summary, /found nothing the goal names to act on/);
    assert.equal(result.turns, AGENT_LOOK_ONLY_TURNS, 'ended at the look-only budget, not the 5-turn stall');
    assert.ok(result.actions.every((a) => !a.ok), 'every click missed — nothing was engaged');
    assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started} ms`);
  });

  it('earlyStop:false lifts the give-up ceilings — the leg runs far longer before conceding', async () => {
    // The toggle. With early-stop ON, this leg hands off at 3 (missed every
    // interaction). With it OFF, both ceilings rise to AGENT_NO_PROGRESS_OFF_TURNS,
    // so the agent keeps trying — the trade the person makes for thoroughness.
    const { model } = scripted([{ action: 'click', selector: 'role=combobox >> nth=0' }]);
    const agent = new WorkflowAgent({ model, earlyStop: false });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/start`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'open the Type filter and pick Reimbursement');
    });
    assert.equal(result.success, false);
    assert.ok(
      result.turns > AGENT_LOOK_ONLY_TURNS,
      `ran ${result.turns} turns — past the ${AGENT_LOOK_ONLY_TURNS}-turn early handoff`,
    );
    assert.equal(result.turns, AGENT_NO_PROGRESS_OFF_TURNS, 'conceded at the lifted ceiling');
  });

  it('a leg of failed GOTOs is a navigation stall, NOT a nothing-to-act-on handoff', async () => {
    // The guard that must not over-fire: failed navigation is not "the page
    // does not offer the control" — it never tried a control. It rides the
    // 5-turn no-progress stall, and a re-visited URL does not reset it.
    const { model } = scripted(
      Array.from({ length: AGENT_NO_PROGRESS_TURNS + 2 }, (_, i) => ({
        action: 'goto' as const,
        url: `https://blocked-${i}.example/`,
      })),
    );
    const agent = new WorkflowAgent({ model });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/start`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'reach the reporting screen');
    });
    assert.equal(result.lookedOnly ?? false, false, 'not a reading-question handoff');
    assert.match(result.summary, /stalled: nothing advanced/);
    assert.equal(result.turns, AGENT_NO_PROGRESS_TURNS);
  });

  it('a leg that only reloads the same page is bounded, never endless', async () => {
    // PL_07_03: the agent reloaded the plans page turn after turn to "get a
    // clean tree". Two guards keep that finite, and the invariant that matters
    // is that the leg STOPS. An exact repeated goto is caught by the repeat
    // guard first (`stalled: repeated "goto…"`); the visited-URL rule (a
    // reload is not progress) bounds the mixed case the repeat guard cannot
    // see — reloads interleaved with scrolls and missed clicks. Either way the
    // turn count is small and finite; the bug was a leg that never ended.
    const { model } = scripted([{ action: 'goto', url: `${origin}/en/start` }]);
    const agent = new WorkflowAgent({ model });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/start`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'reach the reporting screen');
    });
    assert.equal(result.success, false);
    assert.match(result.summary, /stalled/);
    assert.ok(result.turns <= AGENT_NO_PROGRESS_TURNS, `bounded in ${result.turns} turns`);
  });

  it('fails a scroll to a name the tree does not show fast, like a click', async () => {
    // Before: scrollIntoViewIfNeeded waited the full action timeout on a row
    // a virtualised table had not rendered — three turns of 5 s each, and
    // the error the next turn read said nothing about WHY.
    const { model, seen } = scripted([
      { action: 'scroll', selector: 'role=cell[name="PL_99_99 nowhere" i]' },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 2 });
    const started = Date.now();
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/start`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'bring the PL_99_99 row into view');
    });
    assert.equal(result.success, false);
    assert.match(seen[1]?.feedback ?? '', /not in the accessibility tree/, 'refused once with the reason');
    const scroll = result.actions[0];
    assert.equal(scroll?.ok, false);
    assert.match(scroll?.error ?? '', /no element matches/);
    assert.ok(Date.now() - started < 12_000, `took ${Date.now() - started} ms`);
  });

  it('re-asks once when the selector names nothing in the tree, then fails fast', async () => {
    const { model, seen } = scripted([
      { action: 'click', selector: 'role=button[name="Create Plan"]' },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 2 });
    const started = Date.now();
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/start`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'click Create Plan');
    });
    assert.equal(result.success, false);
    assert.match(seen[1]?.feedback ?? '', /not in the accessibility tree/);
    const click = result.actions[0];
    assert.equal(click?.ok, false);
    assert.match(click?.error ?? '', /no element matches/);
    // Two turns of a missing selector, each failing fast — well under the
    // 8 s per action the old path waited.
    assert.ok(Date.now() - started < 12_000, `took ${Date.now() - started} ms`);
  });

  it('never presses an unscoped Delete, however the model insists, and still lets a scoped one through', async () => {
    const { model, seen } = scripted([
      { action: 'click', selector: 'role=button[name="Delete" i] >> nth=0' },
      { action: 'click', selector: 'role=button[name="Delete" i] >> nth=0' },
      // The scoped shape a real run used successfully: find the id's cell,
      // step up to its row, press that row's own Delete.
      { action: 'click', selector: 'text=PL_03_18 >> xpath=.. >> role=button[name="Delete" i]' },
      { action: 'finish', reasoning: 'deleted' },
    ]);
    // A delete is irreversible, so the mutation gate (Phase B, 2026-09-05)
    // asks the host even when no manifest is configured. This test is about
    // the scope guard, so the host says yes — and only for the row the goal
    // names, which the gate must have observed on the page first.
    const approvals: string[][] = [];
    const agent = new WorkflowAgent({
      model,
      maxSteps: 4,
      mutationPolicy: null,
      approveMutation: (request) => {
        approvals.push([...request.targets]);
        return request.category === 'delete' && request.targets.includes('PL_03_18');
      },
    });
    const { result, title } = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/rows`, { waitUntil: 'domcontentloaded' });
      const result = await agent.run(page, 'delete the plan PL_03_18');
      return { result, title: await page.title() };
    });
    assert.equal(title, 'deleted PL_03_18', 'only the row the goal named was deleted');
    assert.deepEqual(approvals, [['PL_03_18']], 'the host was asked once, for the scoped row only — never for the unscoped click');
    assert.equal(result.success, true, result.summary);
    const refused = result.actions[0];
    assert.equal(refused?.ok, false);
    assert.match(refused?.error ?? '', /^destructive:/);
    assert.match(seen[1]?.feedback ?? '', /without naming which row/, 'told once, with the scoped shape');
    // Refused twice in turn 1 (recorded once, never acted on); turn 2 is the scoped click; turn 3 finishes.
    assert.equal(result.turns, 3);
  });

  it('refuses a PRESSED stepper past TOGGLE_CLICK_LIMIT, the same as a clicked toggle (2026-09-02, HIR-EC-009 live: 15.6 minutes hammering "Previous year" via press before this existed)', async () => {
    // A single-entry script that always answers the same press: exactly the
    // shape a model insisting on one control produces. The page genuinely
    // changes every turn (the year decrements), so the repeated-on-unchanged
    // -page guard cannot see this — only the circling guard, extended to
    // `press`, can.
    const { model } = scripted([{ action: 'press', selector: 'role=button[name="Previous year" i]', value: 'Enter' }]);
    const agent = new WorkflowAgent({ model, maxSteps: 10 });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/stepper`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'press Previous year on the date picker until it reads 1995');
    });
    assert.equal(result.success, false);
    assert.match(result.summary, /stalled/);
    const landed = result.actions.filter((a) => a.ok && a.action === 'press');
    assert.equal(landed.length, TOGGLE_CLICK_LIMIT, 'exactly the tolerated number of presses landed before the guard closed');
    const refused = result.actions.find((a) => !a.ok && (a.error ?? '').startsWith('circling:'));
    assert.ok(refused, 'a circling refusal was recorded — the press-shaped escape hatch is closed');
    assert.ok(result.turns < 10, `stopped well short of the ceiling, at turn ${result.turns}`);
  });

  it('refuses a goto off every known origin, and allows the goal\'s own', async () => {
    const { model } = scripted([
      { action: 'goto', url: 'https://example.com/' },
      { action: 'goto', url: `${origin}/en/done` },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 3 });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto('about:blank');
      return agent.run(page, `open ${origin}/en/done`);
    });
    assert.equal(result.actions[0]?.ok, false, 'the public internet is refused');
    assert.match(result.actions[0]?.error ?? '', /off-origin/);
    assert.equal(result.success, true, 'the origin the goal names is allowed, and arriving finishes');
  });
});

describe('the value-hunt guard (CDP) — a set-X-to-Y goal whose value never appears', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;

  before(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      // Ten distinct, always-clickable buttons — none of their text, or
      // anything else on the page, ever contains "G - Internship". Every
      // click succeeds (genuine no-progress-judge "progress"), on a
      // DIFFERENT selector each time, so neither the no-progress judge nor
      // the toggle-circling guard ever fires — the live HIR-EC-010 shape.
      if (path === '/en/found') {
        const buttons = Array.from({ length: 10 }, (_, i) => `<button>Other section ${i}</button>`).join('');
        res.end(
          `<h1>Employee Group</h1><select aria-label="Employee Group"><option>1</option><option>G - Internship</option></select>${buttons}`,
        );
        return;
      }
      const buttons = Array.from({ length: 10 }, (_, i) => `<button>Open section ${i}</button>`).join('');
      res.end(`<h1>Employee Group</h1><select aria-label="Employee Group"><option>1</option><option>2</option></select>${buttons}`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('gives up once the value has appeared on NO tree over AGENT_VALUE_HUNT_TURNS, without wasting a decide call on the tripping turn', async () => {
    const { model, seen } = scripted(
      Array.from({ length: AGENT_VALUE_HUNT_TURNS + 3 }, (_, i) => ({
        action: 'click' as const,
        selector: `text="Open section ${i}"`,
      })),
    );
    const agent = new WorkflowAgent({ model });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'set Employee Group to "G - Internship"');
    });
    assert.equal(result.success, false);
    assert.match(result.summary, /the goal's value "G - Internship" never appeared/);
    assert.ok(result.actions.every((a) => a.ok), 'every click genuinely landed — this is not the no-progress stall');
    assert.equal(seen.length, AGENT_VALUE_HUNT_TURNS, 'the tripping turn cost no model call — the guard fires before asking');
    assert.equal(result.turns, AGENT_VALUE_HUNT_TURNS + 1);
  });

  it('never fires again once the value has appeared once, however many turns follow', async () => {
    // The leg STARTS on the page that renders the value — the guard's
    // `huntedValueSeenAtTurn` latches on the first tree — then MORE turns than
    // `AGENT_VALUE_HUNT_TURNS` follow, each a genuine click on a still-wrong
    // control, exactly like the trip test above. The only difference is that
    // the value was visible once, and that alone must be enough to silence
    // the guard for the rest of the leg. It starts there rather than going
    // there because a leg that leaves its page and stays away is ended by the
    // off-page allowance (`AGENT_OFF_PAGE_TURNS`, 2026-09-03) after eight
    // turns — a different judge, which this test must not trip.
    const clicks = Array.from({ length: AGENT_VALUE_HUNT_TURNS + 3 }, (_, i) => ({
      action: 'click' as const,
      selector: `text="Other section ${i}"`,
    }));
    const { model, seen } = scripted(clicks);
    // Capped exactly to the script's length: nothing here is meant to test
    // termination, only that the value-hunt guard stays quiet throughout.
    const agent = new WorkflowAgent({ model, maxSteps: clicks.length });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/found`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'set Employee Group to "G - Internship"');
    });
    assert.doesNotMatch(result.summary, /never appeared/);
    // The leg ran well past AGENT_VALUE_HUNT_TURNS without the guard ending
    // it — proof it stayed silent, not merely that it hadn't looked yet.
    assert.ok(seen.length > AGENT_VALUE_HUNT_TURNS, `expected more than ${AGENT_VALUE_HUNT_TURNS} turns, saw ${seen.length}`);
  });

  it('never fires on a goal `goalOutcome` cannot parse — no value to hunt for', async () => {
    const { model, seen } = scripted(
      Array.from({ length: AGENT_VALUE_HUNT_TURNS + 3 }, (_, i) => ({
        action: 'click' as const,
        selector: `text="Open section ${i}"`,
      })),
    );
    const agent = new WorkflowAgent({ model, maxSteps: AGENT_VALUE_HUNT_TURNS + 2 });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'explore the Employee Group section');
    });
    assert.doesNotMatch(result.summary, /never appeared/);
    assert.equal(seen.length, AGENT_VALUE_HUNT_TURNS + 2, 'the instance ceiling ended it, not the value-hunt guard');
  });
});

describe('a stall made only of looking (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>Plans</h1><p>Nothing here names a control the goal could press.</p>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('hands off after 3 idle-only turns, never reaching the 5-turn stall', async () => {
    // be100 PL_03_01 (2026-08-26): a goal read as arithmetic ("add them
    // together"), the wording classifier missed it, and the agent — with
    // nothing on the page it could press — scrolled and waited until it hit
    // the stall judge. This is the runtime backstop: three turns of nothing
    // but looking end the leg as a handoff, at three turns rather than five,
    // and the run is never even asked past that point.
    // Alternating action/selector on every entry, so no two decisions ever
    // share a `decisionKey` on this unchanged page — that keeps the idle
    // repeat-guard's informed re-ask out of the trace entirely, and the
    // turn count exact rather than inflated by a refused repeat.
    const { model, seen } = scripted([
      { action: 'scroll', selector: 'role=heading[name="Plans" i]' },
      { action: 'wait' },
      { action: 'scroll' },
    ]);
    const agent = new WorkflowAgent({ model });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/plans`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'add the numbers shown and confirm the sum matches the total');
    });

    assert.equal(result.success, false);
    assert.match(result.summary, /looked and found nothing to act on/);
    assert.doesNotMatch(result.summary, /stalled: nothing advanced/, 'never falls through to the 5-turn judge');
    assert.equal(result.lookedOnly, true);
    assert.equal(result.turns, AGENT_LOOK_ONLY_TURNS, 'ends at 3 turns, not 5');
    assert.ok(result.turns < AGENT_NO_PROGRESS_TURNS, 'the handoff pre-empts the ordinary stall judge');
    // Every action taken really was idle — nothing was ever attempted to click.
    assert.ok(result.actions.every((a) => a.action === 'scroll' || a.action === 'wait'));
    assert.equal(seen.length, AGENT_LOOK_ONLY_TURNS);
  });

  it('does NOT hand off once a real action has landed — that stays the ordinary stall', async () => {
    // A leg that clicked something for real and only got stuck looking
    // afterward is a different, more ordinary failure: the 5-turn judge,
    // not the 3-turn handoff. Whole-leg scope is deliberate — see the
    // comment at the call site in workflow-agent.ts.
    // Every entry a distinct decisionKey, for the same reason as the test
    // above — the idle repeat-guard's re-ask must not shift the turn count.
    const { model } = scripted([
      { action: 'click', selector: 'role=heading[name="Plans" i]' },
      { action: 'scroll', selector: 'role=heading[name="Plans" i]' },
      { action: 'wait' },
      { action: 'scroll', selector: 'p' },
      { action: 'wait', url: 'x' },
      { action: 'scroll' },
    ]);
    const agent = new WorkflowAgent({ model });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/plans`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'click the heading, then add the numbers and confirm the total');
    });

    assert.equal(result.lookedOnly, undefined);
    // Turn 1's click is a real action and resets the no-progress counter, so
    // it takes AGENT_NO_PROGRESS_TURNS more turns after it — not instead of
    // it — to reach the stall.
    assert.match(result.summary, new RegExp(`stalled: nothing advanced in ${AGENT_NO_PROGRESS_TURNS} consecutive turns`));
    assert.equal(result.turns, AGENT_NO_PROGRESS_TURNS + 1);
  });
});

describe('a read-only agent run', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;

  before(async () => {
    // A summary card, the be100 shape: label and value in separate elements,
    // plus a button the agent must not be able to press.
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<h1>Plans</h1><div id="card"><span>TOTAL PLANS</span><span>75</span></div>' +
          '<button onclick="document.title=\'the agent acted\'">Delete everything</button>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('refuses every action that could change the page, and still lets it answer', async () => {
    // Asking an assertion's question is only safe if the agent structurally
    // cannot make the claim true. A prompt saying "do not click" is a
    // promise; this is a guarantee.
    const { model, seen } = scripted([
      { action: 'click', selector: 'role=button[name="Delete everything" i]' },
      { action: 'scroll' },
      { action: 'finish', selector: '#card', reasoning: 'the card holds the label and the count' },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 5 });
    const { result, title } = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/cards`, { waitUntil: 'domcontentloaded' });
      const result = await agent.run(page, 'which element holds the text "75" for TOTAL PLANS?', {
        readOnly: true,
      });
      return { result, title: await page.title() };
    });

    assert.notEqual(title, 'the agent acted', 'the button was never pressed');
    assert.equal(result.actions.some((a) => a.action === 'click' && a.ok), false);
    assert.match(seen[1]?.feedback ?? '', /is not available to this run/, 'told once, with the reason');
    assert.match(seen[1]?.feedback ?? '', /it may only wait, scroll/, 'and told what it may do');
    // And the answer still comes back: the finish carries the selector.
    const answer = [...result.actions].reverse().find((a) => a.action === 'finish');
    assert.equal(answer?.selector, '#card');
  });
});

describe('a consent gate met mid-run (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;

  before(async () => {
    // The measured shape: the plans page redirects to /en/consent until the
    // session has accepted; accepting lands on the app's HOME, not on the
    // page that was asked for.
    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      const consented = /(^|;\s*)consent=1/.test(req.headers.cookie ?? '');
      if (path === '/en/plans' && !consented) {
        res.writeHead(302, { location: '/en/consent' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (path === '/en/consent') {
        res.end(
          '<h1>Consent</h1><p>Personal data notice</p>' +
            '<button onclick="document.cookie=\'consent=1; path=/\'; location.href=\'/en/home\'">Accept and continue</button>',
        );
      } else if (path === '/en/plans') {
        res.end(
          '<h1>Plans</h1><button id="do" onclick="document.body.insertAdjacentHTML(\'beforeend\', \'<p>Thing done</p>\')">Do the thing</button>',
        );
      } else {
        res.end(path === '/en/home' ? '<h1>Home</h1>' : '<h1>Start</h1>');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('is cleared without a model turn, and the agent is returned to the page its goto asked for', async () => {
    // be100 PL_03_16, 2026-08-25: a goto to the plans page landed on
    // /en/consent; the model scrolled, waited, waited, and the run ended as a
    // stall with the accept control on screen. The preflight's gate rung
    // only ran before the first turn.
    const { model, seen } = scripted([
      { action: 'goto', url: `${origin}/en/plans` },
      { action: 'click', selector: 'role=button[name="Do the thing" i]' },
      { action: 'finish', reasoning: 'the thing is done' },
    ]);
    const agent = new WorkflowAgent({ model });
    const result = await withPage(CDP_URL, async (page) => {
      await page.context().clearCookies();
      await page.goto(`${origin}/en/start`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'open the plans page and press Do the thing');
    });
    assert.equal(result.success, true, result.summary);
    const gate = result.actions.find((a) => /consent gate/.test(a.reasoning));
    assert.ok(gate?.ok, 'the gate was accepted by the loop, not the model');
    assert.match(gate?.reasoning ?? '', /on turn 2/);
    assert.ok(
      seen.every((o) => !/consent/i.test(o.url)),
      'the model was never asked to decide from the consent page',
    );
    const click = result.actions.find((a) => a.action === 'click' && /Do the thing/.test(a.selector ?? ''));
    assert.ok(click?.ok, 'the click landed on the plans page the goto asked for');
    assert.match(click?.url ?? '', /\/en\/plans$/);
  });
});

describe('parseWherePairs', () => {
  it('reads equality pairs into a record', () => {
    assert.deepEqual(parseWherePairs('benefit_type=REIMBURSEMENT_HR, status = ACTIVE'), {
      benefit_type: 'REIMBURSEMENT_HR',
      status: 'ACTIVE',
    });
  });
  it('an empty value means the whole table', () => {
    assert.deepEqual(parseWherePairs(''), {});
  });
  it('refuses a pair it cannot read, naming it', () => {
    assert.throws(() => parseWherePairs('not-a-pair'), /could not read "not-a-pair"/);
  });
});

describe('the dbCount action (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>Plans</h1><p>Reimbursement by HR: 3</p>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('is in the vocabulary, and the observed count is the evidence in the record', async () => {
    assert.ok((AGENT_ACTIONS as readonly string[]).includes('dbCount'));
    const asked: Array<{ table: string; where: Record<string, string> }> = [];
    const { model, seen } = scripted([
      {
        action: 'dbCount',
        selector: 'benefit_management.benefit_plan',
        value: 'benefit_type=REIMBURSEMENT_HR',
      },
      { action: 'finish', reasoning: 'the database says 3 and the box says 3' },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 4 });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'verify the Reimbursement by HR count matches the database', {
        dbProbe: async (table, where) => {
          asked.push({ table, where });
          return 3;
        },
      });
    });
    // The probe was asked the grounded question the decision encoded…
    assert.deepEqual(asked, [
      { table: 'benefit_management.benefit_plan', where: { benefit_type: 'REIMBURSEMENT_HR' } },
    ]);
    // …and what the database actually said is on the record and in the
    // history the model reasons from — evidence, never just the claim.
    assert.equal(result.actions[0]?.ok, true);
    assert.match(seen[1]?.history.join('\n') ?? '', /dbCount benefit_management\.benefit_plan — ok \(observed 3 row\(s\)\)/);
  });

  it('fails with advice, not a connection error, when no database is configured', async () => {
    const { model } = scripted([
      { action: 'dbCount', selector: 'benefit_management.benefit_plan', value: '' },
      { action: 'fail', reasoning: 'cannot verify without a database' },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 3 });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'verify the count matches the database');
    });
    assert.equal(result.actions[0]?.ok, false);
    assert.match(result.actions[0]?.error ?? '', /no database is configured .* verify through the page/);
  });
});

// --- OA-12: identifiers without digits, quoted names, deactivate/terminate ----------

describe('unscopedDestructiveClick — identifiers without a digit, and the sheets\' destructive verbs (OA-12)', () => {
  const click = (selector: string) => ({ action: 'click', selector, value: '', url: '' });

  it('names the row of a digit-less identifier, a quoted name and a Capitalised target', () => {
    // EC-Consent teardown "5. คืนค่าเดิมโดยปิดใช้งานเอกสารรหัส SIT_DUP_DOC";
    // BE "Delete plan Medical Reimbursement (ICU) (TH_MED_005)"; BE
    // "Benefit Name = QA-Delete"; a plan named with no code at all.
    assert.deepEqual(goalIdentifiers('ปิดใช้งานเอกสารรหัส SIT_DUP_DOC / SIT_TARGET_DOC'), ['SIT_DUP_DOC', 'SIT_TARGET_DOC']);
    assert.deepEqual(goalIdentifiers('Delete plan Medical Reimbursement (ICU) (TH_MED_005) and confirm'), ['TH_MED_005', 'Medical Reimbursement']);
    assert.deepEqual(goalIdentifiers('delete the Dental plan'), ['Dental']);
    assert.deepEqual(goalIdentifiers('delete the row "QA-Delete while filter Type"'), ['QA-Delete', 'QA-Delete while filter Type']);
    assert.deepEqual(goalIdentifiers('delete the first draft'), [], 'a goal that names no row is left to the prompt');
    // A quoted button label, dialog title or answer is what the click lands on, never what it is scoped to.
    assert.deepEqual(goalIdentifiers('click "Delete", then in the "Confirm delete plan" dialog answer "Yes, delete"'), []);
  });

  it('refuses the first Deactivate / พ้นสภาพ the way it refuses the first Delete', () => {
    assert.match(DESTRUCTIVE_NAME.source, /deactivate/);
    assert.ok(DESTRUCTIVE_NAME.test('ปิดใช้งาน') && DESTRUCTIVE_NAME.test('พ้นสภาพ') && DESTRUCTIVE_NAME.test('Terminate'));
    assert.equal(DESTRUCTIVE_NAME.test('ยกเลิก'), false, 'Cancel is the Cancel button of every Thai dialog');
    const why = unscopedDestructiveClick(click('role=button[name="Deactivate" i] >> nth=0'), 'ปิดใช้งานเอกสาร SIT_DUP_DOC');
    assert.match(why ?? '', /^destructive:/);
    assert.match(why ?? '', /SIT_DUP_DOC/);
    assert.match(unscopedDestructiveClick(click('role=button[name="พ้นสภาพ"]'), 'พ้นสภาพพนักงาน EMP042') ?? '', /EMP042/);
    assert.equal(unscopedDestructiveClick(click('role=row[name="SIT_DUP_DOC" i] >> role=button[name="ปิดใช้งาน"]'), 'ปิดใช้งานเอกสาร SIT_DUP_DOC'), null);
  });

  it('accepts a row scoped by part of a long name, and still refuses the bare button', () => {
    const goal = 'Delete plan Medical Reimbursement (ICU) (TH_MED_005)';
    assert.equal(unscopedDestructiveClick(click('role=row[name="Medical Reimbursement" i] >> role=button[name="Delete" i]'), goal), null);
    assert.match(unscopedDestructiveClick(click('role=button[name="Delete" i] >> nth=0'), goal) ?? '', /^destructive:/);
    assert.match(unscopedDestructiveClick(click('role=button[name="Delete" i] >> nth=0'), 'delete the Dental plan') ?? '', /about Dental/);
    assert.equal(unscopedDestructiveClick(click('role=row[name="Dental" i] >> role=button[name="Delete" i]'), 'delete the Dental plan'), null);
  });
});

// --- OA-13: a Thai surface name -----------------------------------------------------

describe('goalSurfaceNames in Thai (OA-13)', () => {
  const node = (role: string, name: string): AxNode => ({
    role, name, value: '', description: '', disabled: false, checked: false, url: '',
  });
  it('reads a quoted name after ป็อปอัพ / หน้าต่าง, and a Latin name before เปิดขึ้น', () => {
    assert.deepEqual(goalSurfaceNames('กดปุ่ม Delete แล้วป็อปอัพ "ยืนยันการลบ" แสดงขึ้น'), ['ยืนยันการลบ']);
    assert.deepEqual(goalSurfaceNames('หน้าต่าง Confirm Delete เปิดขึ้น'), ['Confirm Delete']);
    assert.equal(goalAlreadyShowing('กดปุ่ม Delete แล้วป็อปอัพ "ยืนยันการลบ" แสดงขึ้น', [node('dialog', 'ยืนยันการลบแผน')]), 'ยืนยันการลบแผน');
  });
});

// --- OA-2: the menu path a goal names (pure half) ----------------------------------

describe('menuPathOf (OA-2, pure half)', () => {
  it('reads the arrow chain the EC, PY and consent sheets write', () => {
    // Menu column verbatim: "EC > Hire & Onboard (New Hire)", "SPD Admin >
    // Payroll > Run Payroll", "เปิดเมนู Setup > ระบบ > ความปลอดภัย > Consent Form".
    assert.deepEqual(menuPathOf('open EC > Hire & Onboard (New Hire) and click Add'), [
      { name: 'EC', alternatives: ['EC'] },
      { name: 'Hire & Onboard', alternatives: ['Hire & Onboard', 'New Hire'] },
    ]);
    assert.deepEqual(menuPathOf('SPD Admin > Payroll > Run Payroll')?.map((s) => s.name), ['SPD Admin', 'Payroll', 'Run Payroll']);
    assert.deepEqual(menuPathOf('เปิดเมนู Setup > ระบบ > ความปลอดภัย > Consent Form')?.map((s) => s.name), ['Setup', 'ระบบ', 'ความปลอดภัย', 'Consent Form']);
    assert.deepEqual(
      menuPathOf('Navigate via HR > Benefits Admin > Benefit Plans to the Benefit Plan Catalog page and end on /en/benefits/plans')?.map((s) => s.name),
      ['HR', 'Benefits Admin', 'Benefit Plans'],
      'the sentence after the path is not a segment',
    );
    assert.deepEqual(menuPathOf('Sign in, then open Team Management -> Probation Reviews and end on /en/workflows/probation')?.map((s) => s.name), ['Team Management', 'Probation Reviews']);
  });

  it('reads the numbered form the BE and TM sheets write, only after a menu word', () => {
    // "Menu: 1. HR\n2. Benefits Admin\n3. Benefit Plans" (359 BE rows); "1. ME\n2. Time & Attendance\n3. Leave request" (TM).
    assert.deepEqual(menuPathOf('menu path:\n1. ME\n2. Time & Attendance\n3. Leave request')?.map((s) => s.name), ['ME', 'Time & Attendance', 'Leave request']);
    assert.deepEqual(menuPathOf('Follow the menu path: 1. HR 2. Benefits Admin 3. Benefit Plans and end on /en/benefits/plans')?.map((s) => s.name), ['HR', 'Benefits Admin', 'Benefit Plans']);
    assert.equal(menuPathOf('Steps: 1. กด Menu 2. ตรวจสอบการมองเห็นเมนู HR'), null, 'numbered STEPS are not a menu path');
  });

  it('is null for a single level, so the link and goto rungs keep their goals', () => {
    // tests/agent-economy.test.ts "leaves a goal that names a route the tree does not show to the model".
    assert.equal(menuPathOf('Navigate via the Eligibility rules tile and end on /hub/rules'), null);
    assert.equal(menuPathOf('Open the main navigation menu and click HR'), null);
    assert.equal(menuPathOf('Use the menu to reach /hub/plans'), null);
  });

  it('scores a node exactly-named above one that merely contains the label, badge aside', () => {
    const hr = { name: 'HR', alternatives: ['HR'] };
    assert.equal(menuNodeScore(hr, 'HR'), 2);
    assert.equal(menuNodeScore(hr, 'HR Analytics'), 1);
    assert.equal(menuNodeScore(hr, 'Chrome'), 0);
    assert.equal(menuNodeScore({ name: 'Probation Reviews', alternatives: ['Probation Reviews'] }, 'Probation Reviews 3'), 2, 'a live-count badge is not part of the name');
    assert.equal(menuNodeScore({ name: 'Hire & Onboard', alternatives: ['Hire & Onboard', 'New Hire'] }, 'New Hire'), 2, 'the alias counts');
  });
});

// --- OA-15: a goal for two people (pure half) --------------------------------------

describe('multiPersonaGoal (OA-15, pure half)', () => {
  it('names the split when a goal needs two people', () => {
    // PRB "Data: ผู้ทดสอบ <MANAGER_ACCOUNT> ผู้ประเมิน และ <HRBP_ACCOUNT> ผู้อนุมัติ";
    // TM ML_01_01 "1. Login web humi … 8. กดปุ่ม Submit 9. Manager กดปุ่ม approve request leave".
    assert.deepEqual(multiPersonaGoal('ผู้ทดสอบ <MANAGER_ACCOUNT> ผู้ประเมิน และ <HRBP_ACCOUNT> ผู้อนุมัติ: submit the review then approve'), ['manager', 'hrbp']);
    assert.deepEqual(multiPersonaGoal('Submit the leave request as the employee, then the manager approves it'), ['employee', 'manager']);
    assert.deepEqual(multiPersonaGoal('Login web humi, submit Sick Leave, then Manager กดปุ่ม approve request leave'), ['the signed-in person', 'manager']);
    assert.deepEqual(multiPersonaGoal('sign out and sign in again as the manager'), ['manager', 'another person']);
    assert.match(multiPersonaSummary(['employee', 'manager']), /^multi-persona goal: .*signOut → sign-in as manager → workflow/);
  });

  it('is null for one person, however many times the goal names them', () => {
    // "3. Login ด้วย <HR_ADMIN_ACCOUNT> (HRBP)" (PRB, 18 rows) is one account
    // acting in a role — a human mapping, not a split.
    assert.equal(multiPersonaGoal('Login ด้วย <HR_ADMIN_ACCOUNT> (HRBP) แล้วกด Open case รายการเดิมแล้วกด Approve'), null);
    assert.equal(multiPersonaGoal('as HR admin, delete the plan, then as HR admin verify the row is gone'), null);
    assert.equal(multiPersonaGoal('Login ด้วย <MANAGER_ACCOUNT> ของพนักงานที่ประเมิน แล้วกด Submit'), null, 'ของพนักงาน (of the employee) names no second actor');
    assert.equal(multiPersonaGoal('submit the request; the approval route shows Manager'), null, 'mentioning the route is not acting as the approver');
    assert.equal(multiPersonaGoal('Login as manager, then the manager approves the pending request'), null);
  });
});

// --- OA-6: required and still empty (pure half) -------------------------------------

describe('formGaps (OA-6, pure half)', () => {
  it('lists the required controls still empty, by flag or by the asterisk in the label', () => {
    // "กรอกข้อมูล Mandatory อื่นให้ครบถ้วนเพื่อให้สามารถ Submit ได้" (HIR-EC-106
    // and 20 more); "Employee Group*" as the ec10 report renders the label.
    const gaps = formGaps([
      { role: 'textbox', name: 'Bank*', value: '' },
      { role: 'button', name: 'Currency', value: '— Select —', required: true },
      { role: 'textbox', name: 'Nickname', value: '' },
      { role: 'button', name: 'Employee Group*', value: 'A — Permanent' },
      { role: 'checkbox', name: 'I agree*', value: '', checked: false },
      { role: 'button', name: 'Submit', value: '' },
      { role: 'textbox', name: 'Hire Date', value: 'dd/mm/yyyy', required: true },
      { role: 'button', name: 'Gender*', value: 'กรุณาเลือก' },
      { role: 'textbox', name: 'Off*', value: '', disabled: true },
      { role: 'heading', name: 'Personal Information*', value: '' },
    ]);
    assert.deepEqual(gaps.map((g) => g.line), [
      'textbox "Bank*"',
      'button "Currency" value="— Select —"',
      'checkbox "I agree*"',
      'textbox "Hire Date" value="dd/mm/yyyy"',
      'button "Gender*" value="กรุณาเลือก"',
    ]);
    assert.equal(
      formatFormGaps(gaps),
      'REQUIRED AND STILL EMPTY (5): textbox "Bank*" · button "Currency" value="— Select —" · checkbox "I agree*" · textbox "Hire Date" value="dd/mm/yyyy" · button "Gender*" value="กรุณาเลือก"',
    );
    assert.equal(formatFormGaps([]), null);
    assert.match(formatFormGaps(gaps, 2) ?? '', /^REQUIRED AND STILL EMPTY \(5\): textbox "Bank\*" · button "Currency" value="— Select —" · … and 3 more$/);
  });
});
