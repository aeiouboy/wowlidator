/**
 * What the page shows about a workflow goal, as opposed to what the agent says
 * about it.
 *
 * The rule this module exists to enforce is already stated twice in this
 * codebase and was implemented in neither place that needed it here: **what
 * the agent claims is never the evidence.** The ladder's `#agentRescue` obeys
 * it structurally — the agent prepares the page and then the *author's own
 * selector* is retried, so the agent's account of itself decides nothing. The
 * `workflow` action did not: `SmartRunner.workflow()` read `record.success`
 * and stopped there.
 *
 * Measured on a real catalog run (PB_03_01, 2026-08-19): the agent filled a
 * password field four times, clicked Sign in, and kept going — it had already
 * signed in successfully at turn 5 and spent the remaining three turns
 * re-filling a field it could not see the effect of. It then reported "agent
 * gave up after 8 turns without reaching the goal", the step was recorded
 * failed, a `high` functional defect was filed against the application, and
 * the very next step — `expectVisible role=heading[name="Probation Reviews"]`
 * — passed on the fast path in 14ms, from the destination the goal named. The
 * run was reported `error` about an application that had done exactly what was
 * asked of it, and it cost 37 seconds plus a reconstruction model call to
 * arrive there.
 *
 * Every predicate below is deterministic, costs nothing, and is written to
 * **understate**: each one requires an observed *transition*, so none of them
 * can be satisfied by an agent that did nothing at all. That asymmetry is the
 * whole safety argument — the dangerous direction here is calling a genuinely
 * unreached goal reached, so no rule may hold on the starting state alone.
 */

/**
 * Whether a path reads as an authentication page. Presentation only.
 *
 * Lives here rather than in `runner.ts` because both the runner's session
 * guard and the agent's own loop need it, and `runner` imports
 * `workflow-agent` — so the shared predicate cannot sit in either of them
 * without a cycle.
 */
export function looksLikeSignIn(url: string): boolean {
  try {
    return /(^|\/)(login|signin|sign-in|auth|sso)(\/|$)/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Trailing prose punctuation is not part of a URL someone wrote into a sentence. */
function trimTrailing(token: string): string {
  return token.replace(/[.,;:!?)\]}'"]+$/, '');
}

/**
 * The destination a goal names, as a path.
 *
 * A goal is prose, but the useful half of it is frequently a literal: "…and
 * navigate to probation queue at http://localhost:3000/en/workflows/probation".
 * That path is the one part of a goal a machine can check.
 *
 * The **last** url-shaped token wins, because goals read "do X, then end up at
 * Y" — the destination is where the sentence arrives, not where it departs. A
 * path is returned rather than a whole URL: a flow may be pointed at a
 * different host than the goal was written against, and the path is the part
 * that carries the meaning. A bare `/` is not a destination; it matches every
 * URL there is and would settle every goal for free.
 */
export function goalDestination(goal: string): string | null {
  const absolute: string[] = [];
  for (const match of goal.matchAll(/\bhttps?:\/\/\S+/gi)) {
    try {
      const url = new URL(trimTrailing(match[0]));
      const path = url.pathname;
      if (path.length > 1) absolute.push(path);
    } catch {
      // Not a URL after all — a sentence that merely contains "http".
    }
  }
  if (absolute.length > 0) return absolute[absolute.length - 1]!;

  const paths: string[] = [];
  for (const match of goal.matchAll(/(?:^|[\s"'(])(\/[A-Za-z0-9._~%-]+(?:\/[A-Za-z0-9._~%-]+)*)/g)) {
    const path = trimTrailing(match[1]!);
    if (path.length > 1) paths.push(path);
  }
  return paths.length > 0 ? paths[paths.length - 1]! : null;
}

/**
 * Is this URL at that destination?
 *
 * Containment, deliberately — the same comparison `expectUrl` makes ("expected
 * url to contain"), so a goal and an assertion written from the same words
 * agree about what arriving means. A locale prefix the goal omits (`/en`)
 * therefore does not defeat it.
 */
export function atGoalDestination(url: string, destination: string): boolean {
  try {
    return new URL(url).pathname.includes(destination);
  } catch {
    return url.includes(destination);
  }
}

/**
 * Whether a path reads as a page that stands BETWEEN signing in and the
 * application — a consent gate, a terms acceptance, a second factor. Leaving
 * the sign-in page for one of these is not the sign-in having taken: the
 * application is still not reachable, and a claim judged from here would be
 * judged against the gate. Measured on the application this was written
 * against, whose first sign-in per person lands on /en/consent.
 */
function looksLikeInterstitial(url: string): boolean {
  try {
    return /(^|\/)(consent|pdpa|terms|agreement|mfa|otp|verify|2fa)(\/|$)/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Does this goal ask the agent to authenticate? */
export function goalMentionsSignIn(goal: string): boolean {
  // The Thai spellings sit outside the `\b` group — see ACTION_VERB. "Login
  // ด้วย <HR_ADMIN_ACCOUNT>" is caught by `log in`; "เข้าสู่ระบบด้วย
  // <EMPLOYEE_ACCOUNT>" (EC-Consent) was not.
  return /\b(sign[- ]?in|log[- ]?in|password|credential|authenticate)\b|เข้าสู่ระบบ|เข้าระบบ|ล็อกอิน|รหัสผ่าน/i.test(goal);
}

/** What settled a goal, when something did. */
export interface GoalEvidence {
  /** Which rule held — recorded on the step so a reader can audit the call. */
  rule: 'destination' | 'left-sign-in' | 'verification-deferred';
  /** One line, in the report's voice, saying what the page showed. */
  reason: string;
}

/**
 * Has the page arrived at the destination the goal names?
 *
 * Split out from `goalEvidence` because this is the only rule safe to consult
 * **mid-flight**. It is the end of the goal's own sentence, so reaching it
 * cannot cut the agent off early — whereas "the page left the sign-in screen"
 * is true the moment a consent interstitial appears, which is the middle of a
 * multi-part goal and not the end of one.
 */
export function destinationReached(goal: string, before: string, after: string): boolean {
  const destination = goalDestination(goal);
  return (
    destination !== null &&
    !atGoalDestination(before, destination) &&
    atGoalDestination(after, destination)
  );
}

/**
 * Did the page itself demonstrate that the goal was met?
 *
 * Two rules, both requiring a transition between `before` and `after`, and
 * they are **not** tried in sequence — the first one that *applies* is the
 * only one that decides:
 *
 * 1. **destination** — the goal names a path, the page is on it now, and was
 *    not on it when the step began. Arriving somewhere the goal asked for is
 *    the goal, in the only part of it that is checkable.
 * 2. **left-sign-in** — consulted *only when the goal names no destination*.
 *    The goal asks the agent to authenticate, the step began on a sign-in
 *    page, and it no longer is. An application does not leave its own login
 *    screen for a credential it rejected, so this is the outcome of the
 *    sign-in rather than a guess about it. This is the rule that covers the
 *    common shape, where the goal names where it ends by label ("open Team
 *    Management -> Probation Reviews") and no URL appears in the text at all:
 *    two of the three expensive false failures in the run that prompted this
 *    were exactly that.
 *
 * **A goal that names a destination is judged on that destination and nothing
 * else.** Falling through to the weaker rule when the strong one says *no* is
 * precisely the overstatement this module exists to refuse — live, the agent
 * that ended stranded on `/en/consent` while its goal named
 * `/en/admin/employees/EMP-0005/probation` had indeed left the sign-in page,
 * and calling that a success would have turned the one genuine non-completion
 * in the run into a green step.
 *
 * Returns `null` when nothing was demonstrated, which is not a demonstration
 * of failure: it means this module has nothing to say and the agent's own
 * report stands.
 */
export function goalEvidence(goal: string, before: string, after: string): GoalEvidence | null {
  const destination = goalDestination(goal);
  if (destination !== null) {
    return destinationReached(goal, before, after)
      ? {
        rule: 'destination',
        reason: `the page reached ${destination}, the destination the goal names, having started at ${before}`,
      }
      : null;
  }

  if (
    goalMentionsSignIn(goal) &&
    looksLikeSignIn(before) &&
    !looksLikeSignIn(after) &&
    !looksLikeInterstitial(after)
  ) {
    return {
      rule: 'left-sign-in',
      reason: `the sign-in the goal asked for took: the page left ${before} and ended at ${after}`,
    };
  }

  return null;
}

/**
 * Did the agent fail because the *model* did, rather than because the
 * application did?
 *
 * `WorkflowAgent.run()` never throws — a model that cannot answer is reported
 * in the record like any other outcome — so the only thing distinguishing "the
 * provider is down" from "the feature is broken" is the summary it wrote. Six
 * of eleven non-passing workflow steps in the run that prompted this were the
 * structured-output circuit breaker tripping on the agent role's model; each
 * one filed a `high` functional defect against an application the agent never
 * so much as clicked, and each turned its run's verdict to `error`.
 *
 * Same rule the healer already follows for `HealUnavailableError`: this is a
 * provider fact, not a page fact, and it must never read as "the goal is
 * unreachable".
 */
/**
 * Verbs that ask the agent to CHANGE something. A goal carrying any of them
 * wants work done, and an agent that could not do it failed at something real.
 *
 * The Thai verbs (2026-09-03) sit OUTSIDE the `\b` group, as `VERIFY_VERB`'s
 * does and for the same reason: there is no word character next to a Thai
 * one for a boundary to sit on. They are the sheets' own step verbs — "กดปุ่ม
 * Submit" (ML_01_01), "เลือก probation result = Pass probation" (EC-Probation),
 * "กรอกข้อมูล Mandatory อื่นให้ครบถ้วน" (HIR-EC-1xx), "Login ด้วย
 * <HR_ADMIN_ACCOUNT>" — because a Thai leg with no English verb in it was
 * classed as look-only the moment it also said ตรวจสอบ, and handed off work.
 * `เพิ่ม` excludes `เพิ่มเติม` ("additional": "ข้อมูลเพิ่มเติม" is a noun phrase in
 * verify lines) and `บันทึก` excludes `บันทึกค่า`/`บันทึกว่า` ("note the value",
 * a look) — bare `บันทึก` is Save.
 */
const ACTION_VERB =
  /\b(click|press|open|fill|type|enter|select|choose|submit|save|create|insert|delete|remove|edit|update|change|correct|navigate|go to|search|filter|sort|upload|download|sign in|log in|sign out|accept|apply|toggle|expand|collapse|scroll to)\b|กด|คลิก|กรอก|คีย์|เลือก|บันทึก(?!ค่า|ว่า)|ยื่น|ส่ง|อนุมัติ|เพิ่ม(?!เติม)|แนบ|สร้าง|แก้ไข|เปลี่ยน|เปิด|ไปที่|เข้าสู่ระบบ|เข้าระบบ|ออกจากระบบ|ยกเลิก|ปฏิเสธ/i;
/**
 * Verbs that are actions on a PAGE only when they take a page-shaped object.
 *
 * "add a plan" acts; "add them together" is arithmetic. "confirm the delete"
 * acts; "confirm that the sum equals" is a check. Live (be100 PL_03_01,
 * 2026-08-26): a goal reading "read the numbers … add them together, and
 * confirm that the sum equals the Total Plans number" was classed as an
 * action goal on the single word `add`, so the verification handoff never
 * fired, the agent was asked to be a calculator, and — having nothing on the
 * page it could legitimately click — it scrolled five times and was recorded
 * as a stall. A stronger model does not fix this; it was never the model.
 */
const CONTEXTUAL_ACTION_VERB = /\b(add|confirm)\s+(?:a|an|the|new|this|that\s+\w+)\b(?!\s+(?:sum|total|count|number|value|equals?|matches?|is\b))/i;
/**
 * Verbs that ask only to LOOK. The Thai verb sits outside the `\b` group on
 * purpose: JavaScript's word boundary is defined over `[A-Za-z0-9_]`, so
 * `\bตรวจสอบ\b` can never match — there is no word character next to a Thai
 * one for the boundary to sit on. (Caught by the test that asserts the
 * sheet's own language counts; be100's goals are written in it.)
 */
const VERIFY_VERB =
  /\b(verify|check|confirm that|ensure|assert|observe|read|see|compare|validate|record|note|capture)\b|ตรวจสอบ|บันทึกค่า|บันทึกว่า|อ่าน|สังเกต|เทียบ|ดูว่า/i;

/**
 * Is this goal asking the agent to VERIFY something and nothing else?
 *
 * The agent's contract in this codebase is **prepare, never perform**: it
 * drives the browser to where a claim can be checked, and the flow's own
 * assertion is what checks it (`#agentRescue` has always worked this way —
 * the agent prepares the page, then the author's own selector is retried).
 * A goal like "verify the Total Plans summary card shows count 75" asks the
 * agent to do the assertion's job instead, and an agent cannot produce
 * evidence — only an account of itself, which this module exists to distrust.
 *
 * Live (be100 PL_03_01, 2026-08-25): that goal, five turns of the agent
 * scrolling for a number the tree had (the count was being cut from its view
 * — see `focusTree`), "agent stalled: nothing advanced", the step recorded
 * failed with a `high` defect — and then `expectText "75"` PASSED against the
 * very page the agent had been standing on the whole time. The agent never
 * needed to succeed; it needed to hand off.
 *
 * Deliberately narrow: any action verb anywhere in the goal disqualifies it,
 * so a goal that acts and then checks ("open the dialog and verify the title")
 * is a real leg whose failure is real. Only a goal that asks for nothing but
 * looking defers.
 */
export function verificationOnlyGoal(goal: string): boolean {
  return VERIFY_VERB.test(goal) && !ACTION_VERB.test(goal) && !CONTEXTUAL_ACTION_VERB.test(goal);
}

export function agentModelUnavailable(summary: string): boolean {
  return /^agent model failed:/i.test(summary);
}

/**
 * The leg was refused because its goal names more than one person.
 *
 * `multiPersonaSummary` returns before the first turn with a `multi-persona
 * goal:` prefix, and the comment where it is built calls that prefix "the
 * protocol `run-cases` reads so it can file this as an authoring refusal".
 * Nothing read it: the refusal fell through to the ordinary failed-leg path
 * and was filed as `functional` / `high`, "Workflow goal not reached" — a
 * fact about how the flow was WRITTEN, reported as a defect in the
 * application under test. The same mistake the provider-refusal branch beside
 * this one exists to prevent.
 *
 * Like `agentModelUnavailable`, this can only be true of a summary produced
 * by a return that happens before any turn is spent, so it can never change
 * the outcome of a leg that actually ran.
 */
export function personaRefusal(summary: string): boolean {
  return /^multi-persona goal:/i.test(summary);
}

/**
 * The checkable END STATE a goal describes, or null when it names none.
 *
 * Audit 2026-08-28 (be100): 20 of 22 agent legs on PASSED cases were settled
 * by the agent's own `finish` text — "shows 1–75 of 75, *meaning* 100 was
 * selected", "picked, *as confirmed by* the successful clicks" — inference
 * presented as observation, never checked against the page. The rule "what
 * the agent claims is never the evidence" was enforced for failures only.
 * This is the success half: a goal that says what the page should hold when
 * it is done is turned into a predicate the harness evaluates on the live
 * tree, and a `finish` is accepted on the tree's word, not the model's.
 *
 * Two shapes, both from the way catalog goals are actually written:
 *  - `set/select/choose/change <control> to <value>` → `{ control, value }`:
 *    some node whose name or value carries the control's words must show the
 *    value (a filter button reading "Type: Info", a combobox value, a readout).
 *  - `<control> = <value>` / `<control> to "<value>"` → the same.
 * Deliberately narrow — a goal it cannot read falls through to today's
 * behaviour, and the record says so (`settledBy: 'agent-claim'`), so an
 * all-claim run is visible as one rather than passing silently.
 */
export interface GoalOutcome {
  control: string;
  value: string;
}

// Two spellings each of the control and the value: quoted (any quote style)
// or bare. Written as alternations rather than optional quotes so a quoted
// control followed by a bare value ("set the "Rows per page" control to 25")
// cannot be mis-split across the quote characters.
const Q = String.raw`(?:"([^"]{1,60})"|“([^”]{1,60})”|'([^']{1,60})')`;
// A bare control starts with a letter of ANY script (2026-09-03): the sheets
// name controls in Thai — "ผลการประเมิน = Pass probation" (EC-Probation-1),
// "ประเภทการลา" — and the old `[A-Za-z]` first letter read those as no
// control at all, so a Thai `set X = Y` was never settled on the page.
const BARE_CONTROL = String.raw`(\p{L}[^"“'=:,\n]{1,40}?)`;
// Where a bare value ENDS. It runs to the end of its clause, not to the first
// space: "set Employee Group = A - Permanent on the New Hire form" names the
// value "A - Permanent", and reading it as "A" refused a finish the page had
// earned (ec10 HIR-EC-002 leg 12, 2026-09-02). It stops before punctuation,
// before the conjunctions and prepositions an English sentence continues
// with, before the Thai continuations a sheet step goes on with ("เลือก
// Country=TH แล้วกด Save", PY-Config — written with no boundary, because Thai
// glues the next word on), and before the NEXT `Key =` pair of a data line
// ("Employee Group = A - Permanent Employee Sub Group = 10", HIR-EC-1xx):
// one to three words and then "=" is the next pair, not more of this value.
// The next-pair words carry no comma or semicolon (2026-09-03, ec09
// HIR-EC-009 leg [38]): in "Partner University = 06 Burapha University,
// Degree Level = zDVTDegreeLv_3 Vocational Certificate, Course = …" the lazy
// value took the EARLIEST end, and "University, Degree Level =" read as the
// next pair — so the value became "06 Burapha", the next "zDVTDegreeLv_3",
// and a finish that had set every field was refused on truncated values.
const VALUE_END = String.raw`(?=\s*(?:$|[,.;)\n]|\s+(?:and|then|on|in|so|while|before|after|but|via|from|at)\b|\s+(?:แล้ว|และ|จากนั้น|โดย|เพื่อ|ก่อน|หลัง|เสมอ|ตาม|พร้อม)|\s+(?:[^\s=\-,;][^\s=,;]*\s+){1,3}=))`;
// A value may carry ONE balanced parenthetical: "A (Active)", "Thailand
// (TH)", "CPN (10000009)" are single values in the sheets (Employee Status,
// Country, Business Unit on every EC key-in row), and the old `[^)]` class
// cut them at the bracket.
const BARE_VALUE = String.raw`((?:[^"“',.;()=\n]|\([^()\n]*\)){1,60}?)${VALUE_END}`;
// The English verbs keep their word boundary; the Thai ones — "เลือก probation
// result = Pass probation", "กำหนด Probation Exemption = Yes", "ตั้ง Disability
// Status = Yes", "ระบุ", "กรอก", "คีย์ Employee Group = A - Permanent" (all
// verbatim from EC-Hiring/EC-Probation steps) — cannot have one and take
// optional whitespace instead, because a Thai control follows with none.
const SET_VERB = String.raw`(?:\b(?:set|select|choose|change|switch|pick)\s+|(?:เลือก|กำหนด|ตั้งค่า|ตั้ง|เปลี่ยน|ระบุ|กรอก|คีย์)\s*)`;
const SET_SEP = String.raw`(?:\s+(?:to|as)\s+|\s*(?:=|เป็น)\s*)`;
const OUTCOME_SET = new RegExp(
  String.raw`${SET_VERB}(?:the\s+)?(?:${Q}|${BARE_CONTROL})(?:\s+(?:control|dropdown|filter|field))?${SET_SEP}(?:${Q}|${BARE_VALUE})`,
  'giu',
);
// Groups: 1–3 quoted control, 4 bare control, 5 separator, 6–8 quoted value,
// 9 bare value. The separator is kept so "at 10:30" can be told from a pair.
const OUTCOME_EQ = new RegExp(String.raw`(?:${Q}|${BARE_CONTROL})\s*(=|:)\s*(?:${Q}|${BARE_VALUE})`, 'gu');

function firstDefined(groups: readonly (string | undefined)[], from: number, count: number): string {
  for (let i = from; i < from + count; i += 1) {
    const g = groups[i];
    if (g !== undefined && g !== '') return g;
  }
  return '';
}

/**
 * A goal's provenance annotation — `(test step 1: เข้าสู่เมนูที่กำหนด)`, which
 * the authoring prompt attaches to every catalog goal so a reader can trace the
 * leg back to its sheet row.
 *
 * Stripped before the outcome is parsed, because the colon inside it is not a
 * control/value separator and `OUTCOME_EQ` cannot tell the difference.
 * Measured (PL_02_07, run a8ae1bb5): the annotation's colon was matched, the
 * bare-control alternation ran backwards into the sentence, and the agent was
 * asked to prove a control named `he Benefit Plan Catalog page (test step 1`
 * shows `เข้าสู่เมนูที่กำหนด`. No page shows that, so a leg that HAD reached
 * `/en/admin/benefits/plans` — exactly the page the goal named — was recorded
 * as a claimed finish the page contradicts.
 */
const GOAL_ANNOTATION = /\s*\((?:test\s+step|step|case|row)\b[^)]*\)\s*\.?/gi;
/** A URL in a goal is a destination (`goalDestination`), never a `key: value`. */
const GOAL_URL = /\bhttps?:\/\/\S+/gi;
/**
 * A bare path in a goal ("On /en/admin/hire fill …") is a destination too,
 * and its letters are not the tail of a control: without this, "On
 * /en/admin/hire fill the DVT-Specific Fields: …" yielded the control
 * `n/admin/hire fill the DVT-Specific Fields` (2026-09-03, ec09 leg [38]).
 * Only a slash-led token after whitespace or at the start — a date
 * `31/03/2027` or a code `major006/x` starts with no slash and is left alone.
 */
const GOAL_PATH = /(?<=^|\s)\/[\w\-./]+/g;

// A bare control in the `X = "Y"` form runs back to the sentence start and
// picks up whatever precedes it ("Fill Country", "On the New Hire form with
// Employee Status", "ระบบสร้างพนักงานสำเร็จ และ Employee Status"). Only the
// tail after the last connector is the control, and a leading verb or
// preposition is not part of it.
const CONTROL_CONNECTOR =
  /\s+(?:and|then|with|where|so|via|while|before|after|but|form|page|dialog|section|card|tab|screen|whose|which|that|และ|แล้ว|จากนั้น|โดย|คีย์|กำหนด|ตั้งค่า|ตั้ง|เลือก|กรอก|ระบุ|เปลี่ยน)\s+/iu;
// `including` and its siblings introduce an APPOSITIVE — "complete the
// Identity fields including Salutation (EN) = Mr." — and the bare `X = Y`
// form runs back into the sentence and takes the introducer with it. Live
// (HIR-EC-001, 2026-09-07): the control was read as `including Salutation
// (EN)`, `outcomeShown` requires EVERY word of the control on the line, no
// tree line says "including", and a leg that had set the field to "Mr." —
// the observation on the record reads `text "Mr."` — was recorded as a
// claim the page contradicts.
const CONTROL_LEAD =
  /^(?:(?:on|in|at|to|for|from|the|a|an|its|this|that|and|then|with|where|so|via|while|but|fill|set|select|choose|change|switch|enter|type|pick|including|include|namely|especially)\s+|(?:และ|แล้ว|จากนั้น|โดย|คีย์|กำหนด|ตั้งค่า|ตั้ง|เลือก|กรอก|ระบุ|เปลี่ยน|ให้|รวมถึง|ได้แก่)\s*)+/iu;
const CONTROL_TAIL = /(?:\s+(?:control|dropdown|filter|field|selector|box|button|value)|\s*\*)+$/iu;
// What is never a control: a number, a step/case reference, the sheet's own
// column headers when a goal quotes a row ("Menu: EC > Hire & Onboard",
// "Data: -", "Expected: 3.1 Country = TH"), a clock time ("at 10:30").
const NOT_A_CONTROL =
  /^(?:\d+|(?:test\s+)?(?:step|case|row|scenario)\s*\d*|menu(?:\s+path)?|steps?|data|test\s+data|expected(?:\s+result)?|actual(?:\s+result)?|note|login|persona|url|preconditions?|result|(?:at|by|from|until|before|after|around)\s+\d+)$/iu;

function cleanControl(raw: string): string | null {
  const pieces = raw.trim().split(CONTROL_CONNECTOR);
  const control = (pieces[pieces.length - 1] ?? '').trim().replace(CONTROL_LEAD, '').replace(CONTROL_TAIL, '').trim();
  if (control.length < 2 || !/\p{L}/u.test(control) || NOT_A_CONTROL.test(control)) return null;
  return control;
}

// A DESCRIPTION standing where a value should be names nothing a page could
// show (2026-09-03, ec09 HIR-EC-009 leg [13]): "set Employee Group to a value
// other than F - DVT (for example Permanent)" was read as the value `a value
// other than F - DVT (for example Permanent)`, which no tree can render, so
// the finish was refused twice and a leg that had set the field was recorded
// as a claim the page contradicts. An article or quantifier followed by a
// word (never by a dash — "A - Permanent" is a value), "other than", or a
// "for example" aside is a description; the pair is dropped and the record
// says the finish rode the claim, as for any goal naming no checkable pair.
const DESCRIBED_GOAL_VALUE = /^(?:a|an|any|some|another|other|different|something|anything)\s+(?!-)\p{L}|\bother than\b|\(for example\b|\be\.g\.|\bsuch as\b/iu;

function cleanValue(raw: string): string | null {
  const value = raw.trim();
  // A placeholder the author left in ("<plan name>") names no value.
  if (value === '' || value.length > 60 || /^<[^>]*>$/.test(value)) return null;
  if (DESCRIBED_GOAL_VALUE.test(value)) return null;
  return value;
}

/**
 * EVERY checkable end state a goal names, in the order it names them, one per
 * control.
 *
 * `goalOutcome` returned the first `set X = Y` only, so "set Gender = Female
 * and Nationality = Thai and Employee Group = A - Permanent" — the shape of
 * every EC key-in leg (HIR-EC-037..150: Employee Group, Employee Sub Group,
 * Nationality, Event Reason, Probation Exemption on one row) — was settled on
 * Gender alone, and every other field rode on the agent's claim. All pairs
 * are read now, so a finish can be held to all of them and a refusal can name
 * the ones the page does not show.
 *
 * Still deliberately narrow: a control it cannot read is dropped, not
 * guessed, and a goal that names no pair returns `[]` — `settledBy:
 * 'agent-claim'` stays visible in the record for those.
 */
export function goalOutcomes(goal: string): GoalOutcome[] {
  const text = goal.replace(GOAL_URL, ' ').replace(GOAL_PATH, ' ').replace(GOAL_ANNOTATION, ' ');
  const found: Array<{ at: number; end: number; valueAt: number; colon: boolean; outcome: GoalOutcome }> = [];
  const collect = (re: RegExp, controlFrom: number, valueFrom: number, separatorAt: number | null): void => {
    for (const m of text.matchAll(re)) {
      const rawValue = firstDefined(m, valueFrom, 4);
      const control = cleanControl(firstDefined(m, controlFrom, 4));
      const value = cleanValue(rawValue);
      if (control === null || value === null) continue;
      // "10:30", "ratio 3:1" — digits either side of a colon are a time or a
      // ratio, never a control and its value.
      if (separatorAt !== null && m[separatorAt] === ':' && /\d$/.test(control) && /^\d/.test(value)) continue;
      const at = m.index ?? 0;
      const end = at + m[0].length;
      found.push({ at, end, valueAt: end - rawValue.length, colon: separatorAt !== null && m[separatorAt] === ':', outcome: { control, value } });
    }
  };
  collect(OUTCOME_SET, 1, 5, null);
  collect(OUTCOME_EQ, 1, 6, 5);
  found.sort((a, b) => a.at - b.at);
  // A colon that INTRODUCES a list of pairs is not a pair (2026-09-03, ec09
  // HIR-EC-009 leg [38]): "fill the DVT-Specific Fields: Partner University =
  // 06 Burapha University, …" read as `DVT-Specific Fields = "Partner"` — the
  // colon's value is exactly where the first real pair's control begins. A
  // colon pair whose value span holds the start of another pair is dropped.
  const introductions = new Set(
    found.filter((f) => f.colon && found.some((g) => g !== f && g.at >= f.valueAt && g.at <= f.end)),
  );
  for (const f of introductions) found.splice(found.indexOf(f), 1);
  // The same pair read twice — once by the verb form, once by the bare `X =
  // Y` form running back into the sentence ("ที่การ์ด ข้อมูลทั่วไป ตั้ง
  // Disability Status" beside "Disability Status") — is one outcome, and the
  // shorter control is the one a page could show.
  const outcomes: GoalOutcome[] = [];
  for (const { outcome } of found) {
    const key = foldValue(outcome.control);
    const twin = outcomes.findIndex(
      (o) => foldValue(o.control) === key || (foldValue(o.value) === foldValue(outcome.value) && (foldValue(o.control).endsWith(` ${key}`) || key.endsWith(` ${foldValue(o.control)}`))),
    );
    if (twin === -1) outcomes.push(outcome);
    else if (outcome.control.length < (outcomes[twin] as GoalOutcome).control.length) outcomes[twin] = outcome;
  }
  return outcomes;
}

/** The first end state a goal names — see `goalOutcomes`. */
export function goalOutcome(goal: string): GoalOutcome | null {
  return goalOutcomes(goal)[0] ?? null;
}

/** `Nationality = "Thai", Employee Group = "A - Permanent"` — the record's spelling of a set of outcomes. */
export function describeOutcomes(outcomes: readonly GoalOutcome[]): string {
  return outcomes.map((o) => `${o.control} = ${JSON.stringify(o.value)}`).join(', ');
}

/**
 * Does the rendered tree show the outcome? A node is evidence when its
 * name+value carries BOTH the control's words and the value (a filter button
 * "Type: Info"), or when a node carrying the control's words is followed
 * within a few lines by one carrying the value (a label and its readout as
 * siblings — the same shape `focusTree` keeps neighbours for). Returns the
 * evidencing line, or null. Case-folded; a truncated tree declines (null),
 * absence of evidence is not evidence of absence.
 */
export function outcomeShown(outcome: GoalOutcome, axTree: string): string | null {
  if (axTree.includes('TREE TRUNCATED')) return null;
  const lines = axTree.split('\n');
  const ctl = outcome.control.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const hasCtl = (l: string): boolean => ctl.every((w) => l.toLowerCase().includes(w));
  const hasVal = (l: string): boolean => valueShownIn(l, outcome.value);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (hasCtl(line) && hasVal(line)) return line.trim();
    if (hasCtl(line)) {
      for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j += 1) {
        if (hasVal(lines[j] as string)) return `${line.trim()} → ${(lines[j] as string).trim()}`;
      }
    }
  }
  return null;
}

/** Which of a goal's outcomes the tree shows, and which it does not. */
export interface OutcomesShown {
  shown: Array<{ outcome: GoalOutcome; line: string }>;
  missing: GoalOutcome[];
}

/**
 * `outcomeShown` over every outcome a goal names. `null` on a truncated tree
 * — the same rule as the single form: absence from a cut tree is not absence
 * from the page, so nothing is refused on it. A finish settles only when
 * `missing` is empty; the refusal names `missing` so the model is told WHICH
 * field the page contradicts, not merely that one does.
 */
export function outcomesShown(outcomes: readonly GoalOutcome[], axTree: string): OutcomesShown | null {
  if (axTree.includes('TREE TRUNCATED')) return null;
  const shown: OutcomesShown['shown'] = [];
  const missing: GoalOutcome[] = [];
  for (const outcome of outcomes) {
    const line = outcomeShown(outcome, axTree);
    if (line === null) missing.push(outcome);
    else shown.push({ outcome, line });
  }
  return { shown, missing };
}

/**
 * The values a goal names — every `set X to Y` value, deduplicated. The
 * value-hunt judge fires only when NONE of them has ever appeared: a key-in
 * leg naming five fields spends its early turns on the first two, and a judge
 * watching one value would have ended it while it was working.
 *
 * Deliberately reuses `goalOutcomes`' narrow parse rather than a looser one —
 * a false positive here (claiming a value was named when it was not) would
 * end a leg that never asked for anything checkable.
 */
export function goalCitedValues(goal: string): string[] {
  return [...new Set(goalOutcomes(goal).map((o) => o.value))];
}

/** The first value a goal names — see `goalCitedValues`. */
export function goalCitedValue(goal: string): string | null {
  return goalCitedValues(goal)[0] ?? null;
}

/** Has ANY of these values appeared in this tree? See `valueAppearsAnywhere`. */
export function anyValueAppears(values: readonly string[], axTree: string): boolean {
  return values.some((value) => valueAppearsAnywhere(value, axTree));
}

/**
 * Has this value appeared ANYWHERE in this tree — no control pairing, unlike
 * `outcomeShown`. Deliberately loose in the direction that costs nothing: a
 * false "seen" only means the hunt guard below stays quiet one turn longer,
 * where a false "not seen" would end a leg that could still succeed. A
 * truncated tree never counts — absence from it is not absence from the page.
 */
/**
 * A value as the page and the goal might each spell it: case-folded, every
 * dash the same dash, whitespace collapsed. "A - Permanent" in a goal and
 * "A — Permanent" on the page are one value.
 */
export function foldValue(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Is `spelling` in the folded `hay` as a WHOLE WORD — bounded on anything
 * that is not a letter or digit, which is what makes `value="Female"` and
 * "A — Permanent" both match and "Male" not match inside "Female"? A spelling
 * in a script with no word boundaries (Thai, Han, Kana) cannot be bounded that
 * way and is matched by containment. A ONE-character spelling (the "A" of
 * "A (Active)") is evidence only as a whole quoted token — `value="a"` — never
 * as a letter inside a sentence.
 */
function shownAs(hay: string, spelling: string): boolean {
  if (spelling === '') return false;
  if (spelling.length < 2) return hay.includes(`"${spelling}"`);
  if (!/^[\p{Script=Latin}\p{N}\s\-_.,:;()/%&+#'"]+$/u.test(spelling)) return hay.includes(spelling);
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(spelling)}([^\\p{L}\\p{N}]|$)`, 'u').test(hay);
}

/**
 * Does the page pair this label with a DIFFERENT code? "B — Permanent" shows
 * the word "Permanent" and is not "A - Permanent"; the label alone is
 * evidence only where the page shows it without another code in front.
 */
function pairedWithOtherCode(hay: string, code: string, label: string): boolean {
  let other = false;
  for (const m of hay.matchAll(new RegExp(`([^\\s"=]+) - ${escapeRegExp(label)}`, 'gu'))) {
    if (m[1] === code) return false;
    other = true;
  }
  return other;
}

/**
 * The spellings a value may take between the sheet and the page, after
 * folding. Measured on the ec10 reruns (2026-09-03): the sheet writes
 * "Active" and the badge reads "A (Active)"; the sheet writes "TH" and the
 * page reads "Thailand (TH)"; the sheet writes "New Hire" and the option
 * reads "H_NEWHIRE — New Hire"; the sheet writes "CPN" and the row reads
 * "CPN Hotel (10000055)". Each is one value with a code or an alias attached
 * on one side, so a `code — label` value is also its label and its code, and
 * a `name (alias)` value is also its name and its alias. Returned best first.
 */
export function valueSpellings(value: string): string[] {
  const full = foldValue(value);
  if (full === '') return [];
  const out = [full];
  const coded = /^([\p{L}\p{N}_./]{1,20}) - (.{2,})$/u.exec(full);
  if (coded) out.push(coded[2] as string, coded[1] as string);
  const aliased = /^(.+?)\s*\(([^()]{1,30})\)$/u.exec(full);
  if (aliased) out.push((aliased[1] as string).trim(), (aliased[2] as string).trim());
  return [...new Set(out)].filter((s) => s !== '');
}

/**
 * Does `text` show `value`? Whole-word after folding (`shownAs`), in any of
 * its spellings (`valueSpellings`) — with one asymmetry: the label half of a
 * `code — label` value counts only when the page does not pair that label
 * with another code (`pairedWithOtherCode`), because "B — Permanent" must not
 * satisfy "Employee Group = A - Permanent" the way "Female" once satisfied
 * "Gender = Male".
 */
export function valueShownIn(text: string, value: string): boolean {
  const val = foldValue(value);
  if (val === '') return false;
  const hay = foldValue(text);
  if (shownAs(hay, val)) return true;
  const coded = /^([\p{L}\p{N}_./]{1,20}) - (.{2,})$/u.exec(val);
  if (coded) {
    const code = coded[1] as string;
    const label = coded[2] as string;
    if (shownAs(hay, code)) return true;
    if (shownAs(hay, label) && !pairedWithOtherCode(hay, code, label)) return true;
  }
  const aliased = /^(.+?)\s*\(([^()]{1,30})\)$/u.exec(val);
  if (aliased) {
    return shownAs(hay, (aliased[1] as string).trim()) || shownAs(hay, (aliased[2] as string).trim());
  }
  return false;
}

export function valueAppearsAnywhere(value: string, axTree: string): boolean {
  if (value.trim() === '' || axTree.includes('TREE TRUNCATED')) return false;
  return valueShownIn(axTree, value);
}

/**
 * Are these two URLs different PAGES — a different origin or path — as
 * opposed to the same page at a different query or hash?
 *
 * Live (ec10-3x HIR-EC-002 leg 12, 2026-09-02): the agent clicked Next on the
 * hire wizard, `/en/admin/hire` became `/en/admin/hire?step=2`, and the
 * step's failure note read "the agent ended on …?step=2, not the page this
 * step began on" — displacement, to the diagnosis and the report, when the
 * agent had gone exactly where the field was. humi mirrors the wizard step
 * into `?step=`; every tab page and two-stage form on one route does the
 * same. The same predicate the runner's unrequested-navigation flag already
 * uses, placed in the leaf so the runner's displacement note and the agent's
 * own history line can share it (`runner` imports `workflow-agent`, so
 * neither can import it from the other).
 */
export function differentPage(before: string, after: string): boolean {
  try {
    const a = new URL(before);
    const b = new URL(after);
    return a.origin !== b.origin || a.pathname !== b.pathname;
  } catch {
    return false;
  }
}

/**
 * Is the agent off the page its step began on, somewhere the goal did not
 * name?
 *
 * Live (HIR-EC-002, 2026-09-03 13:00): steps 16 "Reopen the saved New Hire"
 * and 19 "Leave the New Hire form" spent 903 s of a 1,377 s case. Each leg
 * left the step's page (/en/admin/hire/draft → /en/requests → on through the
 * admin area), and every goto or click onto a fresh page was progress by the
 * no-progress judge's own rule, so only DEFAULT_AGENT_MAX_STEPS ended them —
 * 60 turns at ~7 s each. True when the URL is on a different origin or path
 * from `startUrl` (a `?step=` change is the same page, see `differentPage`)
 * AND is not at the destination the goal names — a goal naming no
 * destination has nowhere off its page that counts. Pure: what the loop
 * does with it (the AGENT_OFF_PAGE_TURNS allowance, the consent exemption,
 * the reset on return) lives beside the other judges in `workflow-agent`.
 */
export function wanderedOffPage(goal: string, startUrl: string, url: string): boolean {
  if (!differentPage(startUrl, url)) return false;
  const destination = goalDestination(goal);
  return destination === null || !atGoalDestination(url, destination);
}

/** `?step=2#top` — the part of a URL that is not the page. Empty when unparsable. */
export function queryAndHash(url: string): string {
  try {
    const u = new URL(url);
    return `${u.search}${u.hash}`;
  } catch {
    return '';
  }
}

/**
 * The history line's account of where an action left the page: `still at
 * URL` when nothing moved, `still on the page, now at ?step=2` when only the
 * query or hash changed, `moved A → B` when the page itself did. The middle
 * form is the point — told "moved …/hire → …/hire?step=2", the model reasons
 * as if it navigated away and clicks back to where it was.
 */
export function urlMoveNote(before: string, after: string): string {
  if (before === after) return `still at ${after}`;
  if (!differentPage(before, after)) return `still on the page, now at ${queryAndHash(after) || after}`;
  return `moved ${before} → ${after}`;
}

// A step indicator as the pages render it: "Step 1 of 2", "ขั้นตอนที่ 1 จาก 2"
// (EC-Hiring-4/5/6: "ระบบเปิดฟอร์ม New Hire ที่ Step 1 of 2", "กดปุ่มไปหน้าถัดไป
// ระบบเปิด Step 2 of 2"). `\bstep` needs digits straight after it, so the
// `?step=2` inside a tree's url= never reads as one.
const STEP_INDICATOR = /(?:\bstep|ขั้นตอนที่|ขั้นที่)\s*(\d+)\s*(?:of|จาก|\/)\s*(\d+)/iu;
const NEXT_BUTTON = /^\s*button\s+"(?:next|next step|ถัดไป|ไปหน้าถัดไป|ขั้นตอนถัดไป|continue|proceed)(?:\s*[>›→»])?"/imu;
// A pager has a Previous beside its Next; a wizard has a Back. Only the
// former is not a wizard.
const PAGER_BUTTON = /^\s*button\s+"(?:previous|prev|previous page|ก่อนหน้า)(?:\s*page)?"/imu;

/**
 * Why a control is not on THIS page of a wizard, or null when the tree shows
 * no wizard.
 *
 * Live (ec10-3x HIR-EC-002 leg 12): the goal named a field that lives on
 * step 2 of the hire wizard; on step 1 it is not in the DOM at all, so the
 * collapsed-section reveal could not find it, "no element matches" told the
 * model nothing about WHY, and 18 turns went on re-opening section headers
 * before Next was tried. Appended to the miss the model reads next turn — a
 * deterministic sentence, no loop change, $0. Read from the tree text the
 * loop already rendered.
 */
export function wizardStepHint(treeText: string): string | null {
  const step = STEP_INDICATOR.exec(treeText);
  if (step) {
    const n = Number(step[1]);
    const m = Number(step[2]);
    if (n >= 1 && m >= n) {
      return n < m
        ? `this page is step ${n} of ${m} of a wizard: the field is probably on a later step — fill this step's fields the goal names, then click Next/ถัดไป`
        : `this page is the last step (${n} of ${m}) of a wizard: the field is probably on an earlier step — click Back/ย้อนกลับ`;
    }
  }
  if (NEXT_BUTTON.test(treeText) && !PAGER_BUTTON.test(treeText)) {
    return 'this page has a Next/ถัดไป button and may be one step of a wizard: the field is probably on a later step — fill this step\'s fields the goal names, then click it';
  }
  return null;
}
