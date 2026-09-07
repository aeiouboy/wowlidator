/**
 * Goal evidence — what the page shows about a workflow goal, as against what
 * the agent says about it.
 *
 * The pure rules run always: they are string and URL comparisons with no model
 * and no browser in them, the same tier as `context-engine.test.ts`. The
 * early-exit test is browser-tier, because "the agent stopped spending turns
 * once the page arrived" is a fact about a loop driving a real page, and the
 * bug it guards — an agent that kept deciding after its goal was met — was
 * invisible to every pure assertion about the predicate itself.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  agentModelUnavailable,
  atGoalDestination,
  destinationReached,
  goalDestination,
  goalEvidence,
  goalMentionsSignIn,
  looksLikeSignIn,
  verificationOnlyGoal,
  goalOutcome,
  goalOutcomes,
  outcomesShown,
  describeOutcomes,
  goalCitedValue,
  goalCitedValues,
  anyValueAppears,
  valueShownIn,
  valueSpellings,
  differentPage,
  wanderedOffPage,
  queryAndHash,
  urlMoveNote,
  wizardStepHint,
  outcomeShown, foldValue, valueAppearsAnywhere } from '../src/orchestrator/goal-evidence.js';
import { WorkflowAgent, type AgentDecision } from '../src/orchestrator/workflow-agent.js';
import { withPage } from '../src/engine/runner.js';

describe('goalDestination', () => {
  it('takes the path out of a URL written into the goal', () => {
    assert.equal(
      goalDestination(
        'Enter password hrbp2026, click Sign in, accept PDPA consent if shown, and navigate to ' +
          'probation queue at http://localhost:3000/en/workflows/probation',
      ),
      '/en/workflows/probation',
    );
  });

  it('takes the LAST destination, because a goal ends where it arrives', () => {
    assert.equal(
      goalDestination('from http://x.test/en/login go to http://x.test/en/home'),
      '/en/home',
    );
  });

  it('reads a bare path when no absolute URL is given', () => {
    assert.equal(
      goalDestination('verify the Review link points to /workflows/probation/PB-001'),
      '/workflows/probation/PB-001',
    );
  });

  it('trims the sentence punctuation a URL picked up from its prose', () => {
    assert.equal(goalDestination('then land on http://x.test/en/home.'), '/en/home');
  });

  it('is null for a goal that names no path at all', () => {
    assert.equal(goalDestination('open menu Team Management -> Probation Reviews'), null);
  });

  it('refuses a bare root, which would match every URL there is', () => {
    assert.equal(goalDestination('go to http://x.test/'), null);
  });
});

describe('atGoalDestination', () => {
  it('contains rather than equals, so a locale prefix does not defeat it', () => {
    assert.equal(atGoalDestination('http://x.test/en/workflows/probation', '/workflows/probation'), true);
  });

  it('is false for a different page', () => {
    assert.equal(atGoalDestination('http://x.test/en/consent', '/workflows/probation'), false);
  });
});

describe('goalEvidence', () => {
  const GOAL_URL =
    'Enter password hrbp2026, click Sign in, and navigate to http://localhost:3000/en/workflows/probation';
  const GOAL_LABEL = 'Sign in with password hrbp2026, then open Team Management -> Probation Reviews';

  it('settles a goal whose destination the page reached', () => {
    const evidence = goalEvidence(
      GOAL_URL,
      'http://localhost:3000/en/login',
      'http://localhost:3000/en/workflows/probation',
    );
    assert.equal(evidence?.rule, 'destination');
  });

  it('settles a sign-in goal that left the sign-in page', () => {
    const evidence = goalEvidence(
      GOAL_LABEL,
      'http://localhost:3000/en/login',
      'http://localhost:3000/en/workflows/probation',
    );
    assert.equal(evidence?.rule, 'left-sign-in');
  });

  // The false-pass hazard, and the reason the destination rule is exclusive:
  // this agent DID leave the sign-in page, and it stranded on a consent screen
  // instead of the destination its goal named. Live, 2026-08-19.
  it('never falls through to the weaker rule when the goal named a destination', () => {
    const stranded = goalEvidence(
      'Enter password admin2026, click Sign in, and navigate to employee ' +
        'http://localhost:3000/en/admin/employees/EMP-0005/probation',
      'http://localhost:3000/en/login',
      'http://localhost:3000/en/consent',
    );
    assert.equal(stranded, null, 'stranding short of the destination is not success');
  });

  // The gate between signing in and the application. Leaving /en/login for
  // /en/consent is the sign-in half done, not done: nothing behind the gate is
  // reachable yet, and a claim judged from here is judged against the gate.
  it('does not count a sign-in that stranded on a consent gate', () => {
    assert.equal(
      goalEvidence(GOAL_LABEL, 'http://localhost:3000/en/login', 'http://localhost:3000/en/consent'),
      null,
    );
  });

  it('requires a transition — standing still settles nothing', () => {
    assert.equal(
      goalEvidence(GOAL_URL, 'http://x.test/en/workflows/probation', 'http://x.test/en/workflows/probation'),
      null,
    );
    assert.equal(
      goalEvidence(GOAL_LABEL, 'http://x.test/en/login', 'http://x.test/en/login'),
      null,
    );
  });

  it('says nothing about a goal that mentions no sign-in and names no path', () => {
    assert.equal(
      goalEvidence('Open and inspect all seven probation cases one by one', 'http://x.test/a', 'http://x.test/b'),
      null,
    );
  });
});

describe('verificationOnlyGoal', () => {
  it('is true for a goal that asks only to look — the assertion\'s job, not the agent\'s', () => {
    // be100 PL_03_01 (2026-08-25): this goal cost five turns, ended "agent
    // stalled", failed the step with a `high` defect — and the next step's
    // expectText "75" passed against the very page the agent stood on.
    assert.equal(verificationOnlyGoal('verify the Total Plans summary card shows count 75'), true);
    assert.equal(verificationOnlyGoal('check that the Records box reads 5'), true);
    assert.equal(
      verificationOnlyGoal('ตรวจสอบจำนวน Reimbursement by HR ที่แสดงบนหน้าจอ'),
      true,
      'the sheet\'s own language counts',
    );
  });

  it('is true for "add" and "confirm" used arithmetically, not as an action verb', () => {
    // be100 PL_03_01 (2026-08-26): this exact goal was classed as an ACTION
    // goal on the bare word "add" — arithmetic, not a click — so the
    // verification handoff never fired. The agent, having nothing on the
    // page it could legitimately press, scrolled five times and was
    // recorded stalled with a high defect. A stronger model does not fix a
    // goal that was never actionable to begin with.
    assert.equal(
      verificationOnlyGoal(
        'read the numbers shown in the Reimbursement by Employee and HR box, the Reimbursement by ' +
          'HR box, the Info box and the Records box, add them together, and confirm that the sum ' +
          'equals the Total Plans number',
      ),
      true,
    );
    assert.equal(verificationOnlyGoal('confirm that the total matches the sum shown'), true);
  });

  it('is false the moment the goal asks for any work', () => {
    // Narrow on purpose: a leg that acts and then checks is a real leg, and
    // its failure is a real failure.
    assert.equal(verificationOnlyGoal('open the Status dropdown and verify Active is listed'), false);
    assert.equal(verificationOnlyGoal('click Create Plan, then check the dialog title'), false);
    assert.equal(verificationOnlyGoal('navigate to the plans page and confirm that it loaded'), false);
    // No verify verb at all is not a verification goal either.
    assert.equal(verificationOnlyGoal('reach the application details page'), false);
    // "add"/"confirm" used as real actions still count as action verbs.
    assert.equal(verificationOnlyGoal('add a new plan, then verify it appears in the list'), false);
    assert.equal(verificationOnlyGoal('confirm the delete dialog, then verify the row is gone'), false);
  });
});

describe('provider failure is not an application failure', () => {
  it('recognises the agent model having failed', () => {
    assert.equal(
      agentModelUnavailable(
        'agent model failed: openrouter:google/gemini-3.6-flash structured-output circuit is open',
      ),
      true,
    );
  });

  it('does not mistake an ordinary give-up for one', () => {
    assert.equal(agentModelUnavailable('agent gave up after 8 turns without reaching the goal'), false);
    assert.equal(agentModelUnavailable('agent reported the goal is unreachable: no such control'), false);
  });
});

describe('sign-in detection', () => {
  it('reads the usual authentication paths', () => {
    for (const url of ['http://x.test/en/login', 'http://x.test/signin', 'http://x.test/auth/sso']) {
      assert.equal(looksLikeSignIn(url), true, url);
    }
    assert.equal(looksLikeSignIn('http://x.test/en/workflows/probation'), false);
  });

  it('spots a goal that asks for authentication', () => {
    assert.equal(goalMentionsSignIn('Enter password hrbp2026 and click Sign in'), true);
    assert.equal(goalMentionsSignIn('Open every probation case in turn'), false);
  });
});

describe('wanderedOffPage — the HIR-EC-002 wander (2026-09-03)', () => {
  // Steps 16 "Reopen the saved New Hire" and 19 "Leave the New Hire form":
  // 903 s of 1,377 s, each leg off /en/admin/hire/draft onto /en/requests and
  // on through the admin area, every fresh page scored as progress.
  const START = 'http://localhost:3005/en/admin/hire/draft';
  const REOPEN = 'Reopen the saved New Hire draft from the drafts list and continue the form';

  it('is true off the start page when the goal names no destination', () => {
    assert.equal(wanderedOffPage(REOPEN, START, 'http://localhost:3005/en/requests'), true);
    assert.equal(wanderedOffPage(REOPEN, START, 'http://localhost:3005/en/admin/employees'), true);
  });

  it('is false on the start page, and a ?step= change is still the start page', () => {
    assert.equal(wanderedOffPage(REOPEN, START, START), false);
    assert.equal(wanderedOffPage(REOPEN, START, `${START}?step=2`), false, 'the wizard mirrors its step into the query');
  });

  it('is false at the destination the goal names, and true anywhere else off the page', () => {
    const LEAVE = 'Leave the New Hire form and go to the requests list at /en/requests';
    assert.equal(wanderedOffPage(LEAVE, START, 'http://localhost:3005/en/requests'), false);
    assert.equal(wanderedOffPage(LEAVE, START, 'http://localhost:3005/en/admin/employees'), true);
  });

  it('is false on another origin only if it is the destination — a different host is a wander otherwise', () => {
    assert.equal(wanderedOffPage(REOPEN, START, 'http://elsewhere.test/en/admin/hire/draft'), true);
  });
});

describe('destinationReached', () => {
  it('is the mid-flight rule and never the sign-in one', () => {
    // Left the sign-in page, but the goal named a destination it has not
    // reached: mid-flight this must NOT stop the agent.
    assert.equal(
      destinationReached(
        'sign in then go to http://x.test/en/home',
        'http://x.test/en/login',
        'http://x.test/en/consent',
      ),
      false,
    );
  });
});

// --- the loop itself -------------------------------------------------------

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

describe('the agent stops when the page arrives (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;

  before(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        req.url?.startsWith('/en/workflows/probation')
          ? '<h1>Probation Reviews</h1>'
          // A BUTTON, not a link: a link to the destination would be taken by
          // the agent's pre-flight with no model turn at all, and this test
          // is about the loop stopping on arrival when the model never says
          // finish — so the model has to be the one that clicks.
          : '<h1>Sign in</h1><button id="go" onclick="location.href=\'/en/workflows/probation\'">Continue</button>',
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

  it('spends no turn after reaching the destination the goal names', async () => {
    // A model that never says `finish` — exactly the live failure, where the
    // agent kept re-filling a password field it had already submitted. The
    // loop must stop on the page's evidence, not on the model's say-so.
    let turns = 0;
    const agent = new WorkflowAgent({
      model: {
        id: 'stub:never-finishes',
        async decide(): Promise<AgentDecision> {
          turns += 1;
          return { action: 'click', selector: '#go', value: '', url: '', reasoning: 'keep going' };
        },
      },
      maxSteps: 8,
    });

    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/login`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, `sign in via the Continue button and go to ${origin}/en/workflows/probation`);
    });

    assert.equal(result.success, true, result.summary);
    assert.equal(result.turns, 1, 'arriving is finishing — the remaining budget must go unspent');
    assert.equal(turns, 1);
    assert.match(result.summary, /destination the goal names/);
  });
});

describe('goalOutcome / outcomeShown (S1 — a finish is checked against the page)', () => {
  it('reads "set X to Y" and "X = Y" goals into a checkable end state', () => {
    assert.deepEqual(goalOutcome('On the catalog page, set the "Rows per page" control to 25, then stay on /en/plans'), { control: 'Rows per page', value: '25' });
    assert.deepEqual(goalOutcome('Set the Status filter to Inactive'), { control: 'Status', value: 'Inactive' });
    assert.deepEqual(goalOutcome('Fill Country = "Thailand (TH)" and save'), { control: 'Country', value: 'Thailand (TH)' });
    assert.equal(goalOutcome('Open the main navigation menu and click HR'), null, 'a goal with no end state defers to the claim');
  });

  it('finds the state on the tree, on one line or a label→value neighbour, and never on a truncated tree', () => {
    const tree = 'button "Rows per page"\nStaticText "25"\nbutton "Status: Inactive"\nStaticText "1–25 of 75"';
    assert.match(outcomeShown({ control: 'Rows per page', value: '25' }, tree) ?? '', /Rows per page.*→.*"25"/);
    assert.match(outcomeShown({ control: 'Status', value: 'Inactive' }, tree) ?? '', /Status: Inactive/);
    assert.equal(outcomeShown({ control: 'Rows per page', value: '100' }, tree), null, 'the page shows 25, not 100 — the finish must be refused');
    assert.equal(outcomeShown({ control: 'Rows per page', value: '25' }, `${tree}\n[TREE TRUNCATED: 4 of 90]`), null);
  });
});

describe('goal outcome: multi-word values and dash spellings (HIR-EC-002 leg 12)', () => {
  it('reads a bare value to the end of its clause, not to the first space', () => {
    assert.deepEqual(
      goalOutcome('On /en/admin/hire, set Employee Group = A - Permanent on the New Hire form and stay on /en/admin/hire'),
      { control: 'Employee Group', value: 'A - Permanent' },
    );
    assert.deepEqual(goalOutcome('set Gender = Female and Nationality = Thai'), { control: 'Gender', value: 'Female' });
    assert.deepEqual(goalOutcome('choose the "Rows per page" control to 25.'), { control: 'Rows per page', value: '25' });
  });

  it('folds dashes and spacing so the goal\'s hyphen matches the page\'s em dash', () => {
    assert.equal(foldValue('A - Permanent'), foldValue('A — Permanent'));
    assert.equal(foldValue('A-Permanent'), 'a - permanent');
    const tree = 'button "Employee Group" value="A — Permanent"\nbutton "Gender" value="Female"';
    assert.ok(outcomeShown({ control: 'Employee Group', value: 'A - Permanent' }, tree));
    assert.ok(outcomeShown({ control: 'Gender', value: 'Female' }, tree));
    assert.equal(outcomeShown({ control: 'Gender', value: 'Male' }, tree), null, 'Male is not inside Female');
    assert.ok(valueAppearsAnywhere('A - Permanent', tree));
    assert.equal(valueAppearsAnywhere('Male', tree), false);
    assert.ok(valueAppearsAnywhere('ลาป่วย', 'cell "วันลาป่วย 3 วัน"'), 'Thai has no word boundary — containment stays');
  });
});

// --- OA-13: the sheets' own language --------------------------------------------

describe('goal classifiers in the sheets\' own words (OA-13, 2026-09-03)', () => {
  it('reads a Thai `set X = Y` into an outcome — verb, control and value', () => {
    // Verbatim from EC-Probation-1 ("2. เลือก probation result = Pass
    // probation"), PY-Config ("เลือก Country=TH แล้วกด Save"), EC-Hiring-1
    // ("กำหนด Probation Exemption = Yes") and EC-Hiring-4 ("ตั้ง Disability
    // Status = Yes"). Every one of these parsed to NO control before, so a
    // Thai leg was never settled on the page and always rode the claim.
    assert.deepEqual(goalOutcome('เลือก probation result = Pass probation'), { control: 'probation result', value: 'Pass probation' });
    assert.deepEqual(goalOutcome('เลือก Country=TH แล้วกด Save'), { control: 'Country', value: 'TH' }, 'the Thai continuation ends the value');
    assert.deepEqual(goalOutcome('กำหนด Probation Exemption = Yes'), { control: 'Probation Exemption', value: 'Yes' });
    assert.deepEqual(
      goalOutcome('เพิ่มขั้นตอนย่อยที่การ์ด ข้อมูลทั่วไป ตั้ง Disability Status = Yes'),
      { control: 'Disability Status', value: 'Yes' },
      'the sentence before the verb is not the control',
    );
  });

  it('reads a Thai-named control, and the glued `เป็น` separator', () => {
    assert.deepEqual(goalOutcome('ผลการประเมิน = Pass probation'), { control: 'ผลการประเมิน', value: 'Pass probation' });
    assert.deepEqual(goalOutcome('เลือกประเภทการลาเป็นลาป่วย แล้วกด Submit'), { control: 'ประเภทการลา', value: 'ลาป่วย' });
  });

  it('classes a Thai step as work, and a Thai look as a look', () => {
    // ML_01_01 "กดปุ่ม Submit"; EC-Probation "เลือก … แล้วกดปุ่ม Submit";
    // EC-Hiring "ตรวจสอบ Employee Status, Hire Date และ Pay Group ที่ระบบบันทึก"
    // — the last one says ตรวจสอบ and also บันทึก (save) as a noun phrase,
    // and stays a real leg because the sheet's wording has an action in it.
    assert.equal(verificationOnlyGoal('กดปุ่ม Submit'), false);
    assert.equal(verificationOnlyGoal('เลือก probation result = Pass probation แล้วกดปุ่ม Submit'), false);
    assert.equal(verificationOnlyGoal('อ่านจำนวนแผนที่แสดง'), true, 'อ่าน (read) is a look');
    assert.equal(verificationOnlyGoal('บันทึกค่า Total leave ที่แสดง'), true, 'บันทึกค่า (note the value) is a look; bare บันทึก is Save');
    assert.equal(verificationOnlyGoal('ตรวจสอบข้อมูลเพิ่มเติม'), true, 'เพิ่มเติม (additional) is not เพิ่ม (add)');
    assert.equal(verificationOnlyGoal('read the numbers and note the total'), true);
    assert.equal(goalMentionsSignIn('เข้าสู่ระบบด้วย <EMPLOYEE_ACCOUNT> ระบบพาไปหน้าหนังสือให้ความยินยอม'), true);
  });
});

// --- OA-4: every `set X = Y`, and the values as the page spells them -----------

describe('goalOutcomes — every pair a goal names (OA-4)', () => {
  it('reads every `X = Y` pair, in order, one per control', () => {
    // The EC key-in shape (HIR-EC-037..150): several fields on one leg.
    assert.deepEqual(goalOutcomes('set Gender = Female and Nationality = Thai'), [
      { control: 'Gender', value: 'Female' },
      { control: 'Nationality', value: 'Thai' },
    ]);
    assert.deepEqual(
      goalOutcomes('set Gender = Female, Nationality = Thai and Employee Group = A - Permanent on the New Hire form and stay on /en/admin/hire'),
      [{ control: 'Gender', value: 'Female' }, { control: 'Nationality', value: 'Thai' }, { control: 'Employee Group', value: 'A - Permanent' }],
    );
    assert.equal(goalOutcome('set Gender = Female and Nationality = Thai')?.control, 'Gender', 'goalOutcome is still the first');
    assert.deepEqual(goalCitedValues('set Gender = Female and Nationality = Thai'), ['Female', 'Thai']);
    assert.equal(goalCitedValue('set Gender = Female and Nationality = Thai'), 'Female');
  });

  it('reads a sheet data line, where the next `Key =` ends the value', () => {
    // "- คีย์ Employee Group = A - Permanent Employee Sub Group = 10 ตามชุดข้อมูล" (EC-Hiring-1, 28 rows).
    assert.deepEqual(goalOutcomes('คีย์ Employee Group = A - Permanent Employee Sub Group = 10 ตามชุดข้อมูล'), [
      { control: 'Employee Group', value: 'A - Permanent' },
      { control: 'Employee Sub Group', value: '10' },
    ]);
    assert.deepEqual(goalOutcomes('Personnel Grade (PG) = 10 Employee Group = A - Permanent Employee Sub Group = 10').map((o) => o.control), [
      'Personnel Grade (PG)', 'Employee Group', 'Employee Sub Group',
    ]);
  });

  it('keeps a parenthetical inside a value, and the sentence outside the control', () => {
    // "ระบบสร้างพนักงานสำเร็จ และ Employee Status = A (Active)" — the Expected
    // line of 13 EC rows; "Country = Thailand (TH)" on every PY-Config row.
    assert.deepEqual(goalOutcomes('ระบบสร้างพนักงานสำเร็จ และ Employee Status = A (Active)'), [{ control: 'Employee Status', value: 'A (Active)' }]);
    assert.deepEqual(goalOutcomes('Business Unit = CPN (10000009) Policy Profile = CPN'), [
      { control: 'Business Unit', value: 'CPN' },
      { control: 'Policy Profile', value: 'CPN' },
    ]);
  });

  it('never reads a URL, a clock time, a step reference or a sheet header as a pair', () => {
    assert.deepEqual(goalOutcomes('Enter password hrbp2026, click Sign in, and navigate to http://localhost:3000/en/workflows/probation'), []);
    assert.deepEqual(goalOutcomes('Reach the Benefit Plan Catalog page (test step 1: เข้าสู่เมนูที่กำหนด)'), []);
    assert.deepEqual(
      goalOutcomes('Menu: EC > Hire & Onboard (New Hire). Data: Country = Thailand (TH). at 10:30 open Status: Awaiting manager'),
      [{ control: 'Country', value: 'Thailand (TH)' }],
    );
    assert.deepEqual(goalOutcomes('explore the Employee Group section'), []);
  });

  it('settles a finish on ALL of them, naming the ones the page does not show', () => {
    const outcomes = goalOutcomes('set Gender = Female and Nationality = Thai and Employee Group = A - Permanent');
    const tree = 'button "Gender" value="Female"\nbutton "Nationality" value="Thai"\nbutton "Employee Group" value="— Select —"';
    const result = outcomesShown(outcomes, tree);
    assert.equal(result?.shown.length, 2);
    assert.deepEqual(result?.missing, [{ control: 'Employee Group', value: 'A - Permanent' }]);
    assert.equal(describeOutcomes(result?.missing ?? []), 'Employee Group = "A - Permanent"');
    assert.equal(outcomesShown(outcomes, `${tree}\n[TREE TRUNCATED: 3 of 90]`), null, 'a cut tree refuses nothing');
    const full = outcomesShown(outcomes, tree.replace('— Select —', 'A — Permanent'));
    assert.deepEqual(full?.missing, []);
    assert.ok(anyValueAppears(['Male', 'Thai'], tree), 'the value-hunt judge waits while ANY cited value has shown');
    assert.equal(anyValueAppears(['Male', 'Chinese'], tree), false);
  });
});

describe('valueShownIn — code prefixes and aliases (OA-4)', () => {
  it('shows a status by either half of "A (Active)", and a country by either half of "Thailand (TH)"', () => {
    // The sheet writes "Employee Status = Active" (7 rows) and "= A (Active)"
    // (13 rows) for the same badge; "Country = TH" against "Thailand (TH)".
    assert.ok(valueShownIn('button "Employee Status" value="A (Active)"', 'Active'));
    assert.ok(valueShownIn('button "Employee Status" value="Active"', 'A (Active)'));
    assert.ok(valueShownIn('button "Employee Status" value="A"', 'A (Active)'), 'the one-letter half counts as a whole quoted token');
    assert.equal(valueShownIn('StaticText "Select a status"', 'A (Active)'), false, 'never as a letter in a sentence');
    assert.equal(valueShownIn('button "Employee Status" value="I (Inactive)"', 'Active'), false, 'Active is not inside Inactive');
    assert.ok(valueShownIn('button "Country" value="Thailand (TH)"', 'TH'));
    assert.ok(valueShownIn('StaticText "TH"', 'Thailand (TH)'));
    assert.ok(outcomeShown({ control: 'Employee Status', value: 'Active' }, 'StaticText "Employee Status"\nStaticText "A (Active)"'));
  });

  it('shows a coded option by its label or its code — unless the page pairs the label with ANOTHER code', () => {
    // humi renders "H_NEWHIRE — New Hire"; the sheet writes "Event Reason = New Hire" (15 rows).
    assert.ok(valueShownIn('option "H_NEWHIRE — New Hire"', 'New Hire'));
    assert.ok(valueShownIn('option "New Hire"', 'H_NEWHIRE - New Hire'));
    assert.ok(valueShownIn('option "H_NEWHIRE"', 'H_NEWHIRE - New Hire'));
    assert.equal(valueShownIn('option "H_REHIRE — New Hire"', 'H_NEWHIRE - New Hire'), false, 'same label, different code');
    assert.equal(valueShownIn('button "Employee Group" value="B — Permanent"', 'A - Permanent'), false, 'B — Permanent is not A - Permanent');
    assert.ok(valueShownIn('button "Employee Group" value="Permanent"', 'A - Permanent'));
    assert.deepEqual(valueSpellings('H_NEWHIRE — New Hire'), ['h_newhire - new hire', 'new hire', 'h_newhire']);
  });

  it('shows a business unit by its code inside a longer row name', () => {
    // "Business Unit = CPN (10000009)" against the row "CPN Hotel (10000055)".
    assert.ok(valueShownIn('cell "CPN Hotel (10000055)"', 'CPN'));
    assert.ok(valueShownIn('cell "CPN Hotel (10000055)"', 'CPN (10000055)'));
    assert.equal(valueShownIn('button "Gender" value="Female"', 'Male'), false, 'the whole-word rule stands');
    assert.ok(valueShownIn('cell "วันลาป่วย 3 วัน"', 'ลาป่วย'), 'Thai stays containment');
  });
});

// --- OA-9: the page, not the URL --------------------------------------------------

describe('differentPage / urlMoveNote — ?step=2 is the same page (OA-9)', () => {
  it('tells a wizard step from a navigation', () => {
    // ec10-3x HIR-EC-002 leg 12: /en/admin/hire → /en/admin/hire?step=2 was
    // reported as "the agent ended on … not the page this step began on".
    assert.equal(differentPage('http://localhost:3005/en/admin/hire', 'http://localhost:3005/en/admin/hire?step=2'), false);
    assert.equal(differentPage('http://localhost:3005/en/admin/hire', 'http://localhost:3005/en/admin/employees'), true);
    assert.equal(differentPage('http://a.test/x', 'http://b.test/x'), true, 'another origin is another page');
    assert.equal(differentPage('not a url', 'http://b.test/x'), false, 'unparsable is never called displacement');
    assert.equal(queryAndHash('http://localhost:3005/en/admin/hire?step=2#top'), '?step=2#top');
  });

  it('words the history line so the model does not think it navigated away', () => {
    assert.equal(urlMoveNote('http://x.test/en/admin/hire', 'http://x.test/en/admin/hire?step=2'), 'still on the page, now at ?step=2');
    assert.equal(urlMoveNote('http://x.test/a', 'http://x.test/a'), 'still at http://x.test/a');
    assert.equal(urlMoveNote('http://x.test/a', 'http://x.test/b'), 'moved http://x.test/a → http://x.test/b');
  });
});

// --- OA-11: a missing field on step 1 of 2 --------------------------------------

describe('wizardStepHint — the field is on the next step (OA-11)', () => {
  it('reads "Step 1 of 2" and "ขั้นตอนที่ N จาก M" from the tree', () => {
    // EC-Hiring-4: "กดปุ่มเพิ่มพนักงานใหม่ ระบบเปิดฟอร์ม New Hire ที่ Step 1 of 2",
    // "6. กดปุ่มไปหน้าถัดไป ระบบเปิด Step 2 of 2".
    assert.match(wizardStepHint('heading "New Hire"\nStaticText "Step 1 of 2"\nbutton "Next"') ?? '', /step 1 of 2 of a wizard.*later step.*Next\/ถัดไป/);
    assert.match(wizardStepHint('StaticText "ขั้นตอนที่ 2 จาก 2"\nbutton "ย้อนกลับ"') ?? '', /last step \(2 of 2\).*earlier step/);
  });

  it('reads a lone Next/ถัดไป button as a probable wizard, never a table pager, never ?step= in a url', () => {
    assert.match(wizardStepHint('button "ถัดไป"') ?? '', /Next\/ถัดไป button/);
    assert.equal(wizardStepHint('button "Previous"\nbutton "Next"'), null, 'a pager has a Previous beside its Next');
    assert.equal(wizardStepHint('link "Hire" url="http://x/en/admin/hire?step=2"\nbutton "Save"'), null);
  });
});

describe('an appositive introducer is not part of the control (HIR-EC-001, 2026-09-07)', () => {
  it('reads "including Salutation (EN) = Mr." as the control the page names', () => {
    const goal = 'Step 3: complete the Identity fields including Salutation (EN) = Mr., Country of Birth = Thailand';
    const outcomes = goalOutcomes(goal);
    assert.deepEqual(outcomes.map((o) => o.control), ['Salutation (EN)', 'Country of Birth']);
  });

  it('and the page then settles the finish it used to contradict', () => {
    const goal = 'Step 3: complete the Identity fields including Salutation (EN) = Mr., Country of Birth = Thailand';
    const tree = 'main\n  button "Salutation (EN)*" text "Mr." expanded=false';
    const outcome = goalOutcomes(goal)[0];
    assert.ok(outcome);
    assert.match(outcomeShown(outcome, tree) ?? '', /Salutation \(EN\)/);
  });
});
