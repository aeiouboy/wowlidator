/**
 * Specialised tactics are selected deterministically and never carry policy
 * (Phase C, 2026-09-05). Unit tier: no browser, no model.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_SKILLS, selectSkills, skillBodies } from '../src/orchestrator/agent-skills.js';
import { agentContract } from '../src/orchestrator/workflow-agent.js';

const PLAIN_TREE = `RootWebArea "Home" url="http://x.test/en/home"
heading "Welcome"
link "EC" url="http://x.test/en/ec"
button "Hire & Onboard"`;

const FORM_TREE = `RootWebArea "New Hire" url="http://x.test/en/admin/hire"
heading "Personal Information"
button "Gender" value="Select Gender"
textbox "First name*"
button "Expand"`;

const TABLE_TREE = `RootWebArea "Plans" url="http://x.test/en/plans"
table "Benefit plans"
row "PL_03_18 Dental Delete"
cell "PL_03_18"
button "Delete"`;

const WIZARD_TREE = `RootWebArea "New Hire" url="http://x.test/en/admin/hire?step=2"
heading "Step 2 of 4"
button "Next"`;

describe('selectSkills — deterministic, from the goal and the first page', () => {
  it('sends the sign-in tactic to a sign-in goal, and nothing else', () => {
    assert.deepEqual(selectSkills({ goal: 'sign in as the HR admin and open /en/employees', axTree: PLAIN_TREE, formGaps: null }), ['auth-and-consent']);
    assert.deepEqual(selectSkills({ goal: 'เข้าสู่ระบบด้วย HRBP', axTree: PLAIN_TREE, formGaps: null }), ['auth-and-consent']);
    // A password field on the page is the same signal without the goal saying so.
    assert.deepEqual(selectSkills({ goal: 'continue', axTree: `${PLAIN_TREE}\ntextbox "Password"`, formGaps: null }), ['auth-and-consent']);
  });

  it('sends the forms tactic to a required-field sweep, a Thai key-in, or a page with a custom select', () => {
    assert.deepEqual(selectSkills({ goal: 'กรอกข้อมูล Mandatory ให้ครบถ้วน', axTree: PLAIN_TREE, formGaps: 'REQUIRED AND STILL EMPTY (2): textbox "Bank*" · button "Currency*"' }), ['forms-and-required-fields']);
    assert.deepEqual(selectSkills({ goal: 'set Gender to Female', axTree: FORM_TREE, formGaps: null }), ['forms-and-required-fields']);
  });

  it('sends the tables tactic when a row must be found, the dates tactic for a date, the wizard tactic for a stepper', () => {
    assert.deepEqual(selectSkills({ goal: 'find the row PL_03_18 and click its Delete', axTree: TABLE_TREE, formGaps: null }), ['tables-and-pagination']);
    assert.deepEqual(selectSkills({ goal: 'set Hire Date to 2026-01-15', axTree: PLAIN_TREE, formGaps: null }), ['date-pickers']);
    assert.deepEqual(selectSkills({ goal: 'fill in this step and click Next', axTree: WIZARD_TREE, formGaps: null }), ['forms-and-required-fields', 'wizards']);
  });

  it('sends nothing for a plain navigation, and is the same answer every time, in canonical order', () => {
    const signal = { goal: 'open EC > Hire & Onboard (New Hire)', axTree: PLAIN_TREE, formGaps: null };
    assert.deepEqual(selectSkills(signal), []);
    const busy = { goal: 'sign in, then find the row for PL_03_18 and set its Hire Date on Step 2 of 4', axTree: TABLE_TREE, formGaps: null };
    const first = selectSkills(busy);
    assert.deepEqual(first, ['auth-and-consent', 'tables-and-pagination', 'date-pickers', 'wizards']);
    assert.deepEqual(selectSkills(busy), first);
  });
});

/** Sentences that belong to the policy layer and may appear in no skill body. */
const POLICY_SENTENCES = [
  'WHAT THE LOOP WILL REFUSE',
  'Do not take destructive actions',
  'A destructive click (Delete, Remove',
  'A goto to any origin but the application',
  'DETERMINISM',
];

describe('skill bodies are tactics, not policy', () => {
  it('every skill has a non-empty body free of policy sentences', () => {
    assert.equal(AGENT_SKILLS.length, 5);
    for (const skill of AGENT_SKILLS) {
      assert.ok(skill.body.trim().length > 40, skill.id);
      for (const sentence of POLICY_SENTENCES) assert.ok(!skill.body.includes(sentence), `${skill.id} carries policy: ${sentence}`);
    }
    assert.deepEqual(skillBodies(['wizards', 'auth-and-consent', 'nope']).map((b) => b.split('\n')[0]), ['SIGN-IN, when the goal asks for it:', 'WIZARDS:']);
  });

  it('the base prompt no longer carries the moved paragraphs; a selected skill brings its own back', () => {
    const base = agentContract({ dbCount: true, skills: [] }).system;
    const withAuth = agentContract({ dbCount: true, skills: ['auth-and-consent'] }).system;
    assert.ok(!base.includes('A sign-in may take two screens'), 'sign-in tactic left the base prompt');
    assert.ok(!base.includes('To find one row in a long table'), 'table tactic left the base prompt');
    assert.ok(!base.includes('A tree line ending in "readonly"'), 'date tactic left the base prompt');
    assert.ok(!base.includes('On a wizard (Step N of M'), 'wizard tactic left the base prompt');
    assert.ok(!base.includes('REQUIRED AND STILL EMPTY list'), 'forms tactic left the base prompt');
    assert.ok(withAuth.startsWith(base), 'a skill is appended, never spliced into the base bytes');
    assert.match(withAuth, /GUIDANCE FOR THIS GOAL:\n\nSIGN-IN, when the goal asks for it:/);
    assert.ok(!withAuth.includes('To find one row in a long table'), 'only the selected skill is sent');
  });
});
