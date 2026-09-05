/**
 * Specialised browser tactics, loaded on demand (Phase C, 2026-09-05 —
 * docs/research/commerce-agents-patterns.md, "load specialized browser
 * guidance on demand").
 *
 * The agent's system prompt carried every tactic it had ever learned —
 * two-screen sign-ins, required-field sweeps, long-table search, read-only
 * date displays, wizards — on every turn of every leg, whether or not the
 * page had a form, a table or a date on it. Those paragraphs now live here,
 * VERBATIM (the wording was measured live; this move changes where it is
 * sent, not what it says), and `selectSkills` picks the ones a leg needs
 * from the goal, the first tree and the first required-fields line. The
 * choice is deterministic and costs no model turn; it is made once per leg
 * (`WorkflowAgent.run`) so the system bytes stay identical across the leg's
 * turns and a provider's prompt cache keeps paying.
 *
 * Skill bodies are tactics only. The action contract, the loop's refusals
 * and the safety rules stay in the base prompt for every variant — a skill
 * may never weaken the policy layer, and `tests/agent-skills.test.ts` pins
 * that the policy sentences are not in any body.
 */

export type AgentSkillId =
  | 'auth-and-consent'
  | 'forms-and-required-fields'
  | 'tables-and-pagination'
  | 'date-pickers'
  | 'wizards';

/** What a skill is chosen from: the goal's words, the page as first seen, the required-fields line if any. */
export interface SkillSignal {
  goal: string;
  axTree: string;
  formGaps: string | null;
}

export interface AgentSkill {
  id: AgentSkillId;
  /** The tactic, sent under `GUIDANCE FOR THIS GOAL:` when it applies. */
  body: string;
  applies(signal: SkillSignal): boolean;
}

// --- the signals, one named pattern each -------------------------------------

/** Sign-in, consent and credential words, in English and the sheets' Thai. */
const AUTH_WORDS = /\b(?:sign\s*in|log\s*in|login|sign\s*out|log\s*out|password|consent|pdpa|terms)\b|เข้าสู่ระบบ|เข้าระบบ|ออกจากระบบ|รหัสผ่าน|ยินยอม/i;
/** A password field in the tree: a textbox whose name says so, or the canonical input. */
const PASSWORD_FIELD = /textbox\s+"[^"]*password[^"]*"|input\[type="password"\]/i;
/** A form-filling goal: required / mandatory sweeps, "fill in", the Thai for both. */
const FORM_WORDS = /\b(?:required|mandatory|asterisk|fill\s+in|fill\s+out|key\s*-?\s*in)\b|กรอก|ครบ|ดอกจัน|บังคับ/i;
/** A custom select (a button carrying a value) or a collapsed section's Expand control. */
const FORM_TREE = /button\s+"[^"]+"\s+value=|button\s+"Expand(?: all)?"/i;
/** Finding a row: table, filter, search, pager words. */
const TABLE_WORDS = /\b(?:row|table|filter|search|page|pager|paginat\w*|records?)\b|แถว|ตาราง|ค้นหา|กรอง|หน้า\s*\d/i;
/** A table on the page. */
const TABLE_TREE = /^\s*(?:table|grid|row|rowgroup)\s+"/im;
/** A date on the goal or the page. */
const DATE_WORDS = /\b(?:date|calendar|day|month|year|dd\/mm\/yyyy|yyyy-mm-dd)\b|วันที่|ปฏิทิน|วันเกิด/i;
/** A date control in the tree: the readonly display, a calendar dialog, or a spinbutton part. */
const DATE_TREE = /"Select date"|readonly|spinbutton\s+"(?:Day|Month|Year)|dialog\s+"[^"]*(?:calendar|date)[^"]*"/i;
/** A multi-step wizard: "Step 2 of 4", ขั้นตอนที่ 2 จาก 4, or the word itself. */
const WIZARD_WORDS = /\bstep\s+\d+\s+of\s+\d+\b|ขั้นตอนที่\s*\d+|\bwizard\b/i;

export const AGENT_SKILLS: readonly AgentSkill[] = [
  {
    id: 'auth-and-consent',
    applies: ({ goal, axTree }) => AUTH_WORDS.test(goal) || AUTH_WORDS.test(axTree) || PASSWORD_FIELD.test(axTree),
    body: `SIGN-IN, when the goal asks for it:
- A sign-in may take two screens: an identity field and a Next / Continue
  button first, and only THEN a password field. Fill the identity, click Next,
  wait if needed, fill the password (a nameless textbox on the password screen
  is the password; input[type="password"] addresses it), click Sign in. Once
  each — a second fill of the same field with the same value is never right.
- If the URL leaves the sign-in page after the submit click, the sign-in TOOK.
  Do not go back and fill anything again. Continue with the next part of the
  goal, or finish if that was the goal.
- A consent / terms page after sign-in: click its accept control ONLY if the
  goal asks you to accept, or the goal cannot be reached without it. Say which
  in "reasoning".`,
  },
  {
    id: 'forms-and-required-fields',
    applies: ({ goal, axTree, formGaps }) => formGaps !== null || FORM_WORDS.test(goal) || FORM_TREE.test(axTree),
    body: `FORMS:
- A dropdown the tree lists as a BUTTON with a value (button "Gender"
  value="Select Gender") is a custom select: selectOption on
  role=button[name="Gender" i] — never role=combobox, which is not in the
  tree. Its value= is the CURRENT selection: when it already shows the option
  the goal wants, that part of the goal is done — do not select it again.
- A field the goal names that is NOT in the tree may sit inside a collapsed
  section: the tree shows the section's header (button "Personal
  Information*") with an "Expand" button beside it, or an "Expand all". Act on
  the field by its label anyway (selectOption role=button[name="Gender" i]) —
  the harness opens the section for you — or click the section's own header
  first. Never conclude the field is missing while a section is collapsed.
- When the goal says every required / mandatory / asterisked field (ครบ,
  ดอกจัน): work down the REQUIRED AND STILL EMPTY list under the tree, one
  control per turn, with a plausible value for its label (a name, a phone, a
  13-digit ID, an amount, the first option of a dropdown). Finish when that
  list is empty and the values the goal names are shown.`,
  },
  {
    id: 'tables-and-pagination',
    applies: ({ goal, axTree }) => TABLE_WORDS.test(goal) || TABLE_TREE.test(axTree),
    body: `TABLES:
- To find one row in a long table, use the table's search or filter textbox
  (fill it, then wait) or the pager BEFORE scrolling. Scroll only when rows
  render lazily and each scroll shows new rows; the history says when a look
  rendered more.`,
  },
  {
    id: 'date-pickers',
    applies: ({ goal, axTree }) => DATE_WORDS.test(goal) || DATE_TREE.test(axTree),
    body: `DATES:
- A tree line ending in "readonly" is a DISPLAY, not an input: writing into it
  changes nothing. Its real input is beside it, named by the field's label
  (textbox "Hire Date" next to textbox "Select date" readonly) — fill or paste
  into THAT, and give a date input its value as YYYY-MM-DD. A date field shown
  as a BUTTON (button "Start Date" that opens a calendar dialog) is a picker:
  click it, then use the dialog's month/year controls and click the day button
  (its name is the day number); paste YYYY-MM-DD instead only if the dialog
  offers a textbox.`,
  },
  {
    id: 'wizards',
    applies: ({ goal, axTree }) => WIZARD_WORDS.test(goal) || WIZARD_WORDS.test(axTree),
    body: `WIZARDS:
- On a wizard (Step N of M / ขั้นตอนที่ N จาก M), fill the CURRENT step's fields
  the goal names, then click Next/ถัดไป; do not re-open section headers to
  find a field that belongs to the next step. A goal that says "stay on
  /path" is satisfied on any step of that path (?step=2 is the same page).`,
  },
];

/** The skills a leg needs, in `AGENT_SKILLS` order. Pure and deterministic. */
export function selectSkills(signal: SkillSignal): AgentSkillId[] {
  return AGENT_SKILLS.filter((skill) => skill.applies(signal)).map((skill) => skill.id);
}

/** The bodies for a set of ids, in canonical order, unknown ids ignored. */
export function skillBodies(ids: readonly string[]): string[] {
  const wanted = new Set(ids);
  return AGENT_SKILLS.filter((skill) => wanted.has(skill.id)).map((skill) => skill.body);
}
