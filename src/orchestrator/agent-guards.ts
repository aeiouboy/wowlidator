/**
 * The deterministic half of the workflow agent — what is checked BEFORE a
 * model's decision is acted on, and what the model is shown.
 *
 * The agent loop already owned budgeting and origin checks. What it left to
 * the prompt was everything that decides whether a turn is spent well: does
 * the selector name something the tree actually shows, has this exact action
 * already been done with the page unchanged since, is a `finish` true of the
 * page the agent is on. A prompt instruction is a request; each of these is
 * now a guarantee, applied in code, with one informed re-ask before the
 * cheaper outcome (a fast failure, a stall, an unverified finish) is
 * recorded. Same seam the healer's echo check uses, same reason: the commonest
 * thing a weak model does is hand back the thing that did not work, and the
 * value of a second ask is entirely in telling it so.
 *
 * Everything here is pure, so it is tested without a browser or a model.
 */

import { formatAxNode, INTERACTIVE_ROLES, type AxNode } from '../healer/jit-healer.js';
import { tokenize } from '../context/relevance.js';
import { foldValue, goalOutcomes, valueShownIn } from './goal-evidence.js';

/** The shape of a decision the guards read. Kept structural to avoid a cycle. */
export interface DecisionLike {
  action: string;
  selector: string;
  value: string;
  url: string;
}

/** The accessible name a role selector asks for, if it asks for one. */
export function selectorName(selector: string): string | null {
  // The FIRST segment only. A Playwright selector chains with `>>`, and the
  // bare-text pattern below is greedy: on `text=PL_03_18 >> xpath=.. >>
  // role=button[name="Delete"]` it used to read the whole string as the name,
  // which of course appears in no tree — so a correctly scoped click was
  // refused as ungrounded and the agent talked itself into finishing instead
  // (caught 2026-08-25 by the destructive-scope test, which asked for exactly
  // that shape). Grounding asks "does the thing this selector starts from
  // exist", and the first segment is that thing; `targetName` below walks the
  // segments itself for the control the click lands ON.
  const trimmed = (selector.split('>>')[0] ?? selector).trim();
  const m = /^role=[a-z]+\s*\[name=(?:"([^"]+)"|'([^']+)')/i.exec(trimmed);
  if (m) return (m[1] ?? m[2]) as string;
  const quoted = /^text="([^"]+)"$/.exec(trimmed);
  if (quoted) return quoted[1] as string;
  const bare = /^text=(.+)$/.exec(trimmed);
  return bare ? (bare[1] as string) : null;
}

/**
 * Is the control this selector names in the tree the model was shown?
 *
 * Only role-with-name and text selectors can be checked — a CSS selector or
 * a nameless role says nothing the tree text could contradict, and is left
 * alone (the action's own fast-fail covers it). Matching is case-insensitive
 * and word-wise: Chrome's names carry CSS text-transform and the tree may
 * show a longer name than the model quoted, and neither of those is an
 * invention. `null` means "could not say"; `false` means the name is not
 * anywhere in the tree and the click was going to wait eight seconds for
 * nothing.
 */
export function selectorGrounded(selector: string, axTree: string): boolean | null {
  const name = selectorName(selector);
  if (name === null || name.trim() === '') return null;
  const hay = axTree.toLowerCase();
  const needle = name.toLowerCase().trim();
  if (hay.includes(needle)) return true;
  const words = needle.split(/\s+/).filter((w) => w.length > 1);
  if (words.length === 0) return null;
  return words.every((w) => hay.includes(w));
}

/** The one thing about a decision that makes it "the same" as an earlier one. */
export function decisionKey(d: DecisionLike): string {
  return `${d.action} ${d.selector.trim()} ${d.value} ${d.url.trim()}`;
}

/**
 * Keep the nodes a goal is about inside the model's budget.
 *
 * `captureAxTreeDetailed` keeps interactive controls first when it has to
 * cut, which is right for a healer that does not know what it is looking for.
 * The agent does know — the goal names the control — so a node whose name
 * shares a word with the goal outranks an unrelated button, and is never the
 * one that falls past the cut. Document order is restored after ranking so
 * the tree still reads as the page.
 */
export function focusTree(nodes: readonly AxNode[], goal: string, maxNodes: number): AxNode[] {
  if (nodes.length <= maxNodes) return [...nodes];
  // A NUMBER in the goal survives the length filter. `tokenize` returns "75"
  // and the old `length > 2` cut it — so on "verify the Total Plans summary
  // card shows count 75" the one term that names the answer scored nothing,
  // the node named "75" ranked below every sidebar link, and the agent was
  // shown the label with the value removed. Live (be100 PL_03_01,
  // 2026-08-25): five turns of scrolling for a number that was on screen,
  // "the required numeric values are not present in the accessibility tree",
  // and the very next step's `expectText "75"` passed.
  const goalTerms = new Set(tokenize(goal).filter((t) => t.length > 2 || /^\d+$/.test(t)));
  const score = (n: AxNode): number => {
    const text = `${n.name} ${n.value} ${n.description}`.toLowerCase();
    let hits = 0;
    for (const term of goalTerms) if (text.includes(term)) hits += 1;
    return hits * 10 + (INTERACTIVE_ROLES.has(n.role) ? 1 : 0);
  };
  const order = new Map(nodes.map((n, i) => [n, i]));
  const ranked = [...nodes].sort(
    (a, b) => score(b) - score(a) || (order.get(a) ?? 0) - (order.get(b) ?? 0),
  );
  // A matched node's DOCUMENT NEIGHBOURS come with it. A summary card is a
  // label and a value as sibling nodes — `StaticText "TOTAL PLANS"` then
  // `StaticText "75"` — and neither reads as the card alone: keeping the
  // label and cutting the number is exactly the shape that sent PL_03_01
  // hunting. The neighbour rides in on the match's own rank, so it cannot
  // push out a higher-scoring node; it only fills the budget ahead of
  // unrelated ones.
  const kept = new Set<AxNode>();
  for (const node of ranked) {
    if (kept.size >= maxNodes) break;
    kept.add(node);
    if (score(node) < 10) continue; // only a goal MATCH earns neighbours
    const at = order.get(node) ?? -1;
    for (const near of [nodes[at - 1], nodes[at + 1]]) {
      if (near !== undefined && kept.size < maxNodes) kept.add(near);
    }
  }
  return [...kept].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/** Render a focused tree the same way the healer renders its own. */
export function renderTree(nodes: readonly AxNode[], total: number): string {
  if (nodes.length === 0) return '(no accessible elements found)';
  const body = nodes.map(formatAxNode).join('\n');
  if (nodes.length >= total) return body;
  return (
    `${body}\n[TREE TRUNCATED: showing ${nodes.length} of ${total} nodes, the ones closest to the ` +
    `goal kept. Elements may exist that are not listed — scroll or navigate before concluding ` +
    `anything is missing.]`
  );
}

/**
 * A control whose accessible name says it destroys something. Deactivate,
 * inactivate and terminate joined (2026-09-03): the consent teardown "ปิดใช้งาน
 * เอกสารรหัส SIT_DUP_DOC" (EC-Consent) and the probation "พ้นสภาพ" (terminate,
 * EC-Probation E2E-166) are as irreversible on the authoritative replica as a
 * delete. The Thai names sit outside the `\b` group, which cannot bound them.
 * `ยกเลิก` (Cancel) is deliberately NOT here: it is the Cancel button of every
 * Thai dialog.
 */
export const DESTRUCTIVE_NAME = /^(?:(delete|remove|destroy|purge|discard|erase|deactivate|inactivate|terminate)\b|(ลบ|ปิดใช้งาน|พ้นสภาพ))/i;
/**
 * The identifier-shaped tokens a goal names: PL_03_15_16_17_18, TH_MED_001,
 * BE-CYC-001 — and, since 2026-09-03, ones with no digit in them: SIT_DUP_DOC,
 * WORK_RULES, HR_PRIVACY_POLICY, QA-Delete. The digit filter meant "ปิดใช้งาน
 * เอกสาร SIT_DUP_DOC" named nothing to the guard, and the click on the first
 * Deactivate ran — the PL_03_18 incident shape with a different id spelling.
 */
const GOAL_IDENTIFIER = /\b[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+){1,}\b/g;
/** An upper-case code with a digit in it: EMP042, PB001, T643. */
const CODED_IDENTIFIER = /\b[A-Z]{1,}[A-Z0-9]*\d[A-Z0-9]*\b/g;
/**
 * A quoted name — "Medical Reimbursement (ICU)", 'Dental plan' — is the row a
 * goal is about when it is not the name of a surface or a control the goal
 * mentions ("the "Confirm delete plan" dialog", "click "Delete""): those are
 * what the click lands on, not what it must be scoped to.
 */
const QUOTED_IDENTIFIER = /(?<!(?:dialog|popup|modal|panel|button|titled|named|called|message|toast|text|label|ปุ่ม)\s*)(?:"([^"\n]{3,80})"|“([^”\n]{3,80})”|(?<![\p{L}\p{N}])'([^'\n]{3,80})'(?![\p{L}\p{N}]))/gu;
/**
 * The Capitalised name after a destructive verb: "delete the Dental plan",
 * "Delete plan Medical Reimbursement (ICU)", "Remove Somchai from the team".
 * The BE sheet names most plans this way and codes only some of them.
 */
// Case-spelled rather than flagged `i`, because the NAME must stay
// case-sensitive: "delete the first draft" names nothing, "delete the Dental
// plan" names Dental.
const NAMED_TARGET =
  /(?:\b(?:[Dd]elete|[Rr]emove|[Dd]eactivate|[Ii]nactivate|[Tt]erminate|[Dd]estroy|[Pp]urge)\s+(?:the\s+|this\s+|that\s+)?(?:(?:plan|document|row|record|item|entry|rule|request|employee|case|file|user)\s+)?|(?:ลบ|ปิดใช้งาน)(?:เอกสาร|แผน|รายการ)?(?:รหัส)?\s*)([A-Z][\w./-]*(?:\s+[A-Z][\w./-]*)*)/gu;

/**
 * Everything a goal names that a destructive click could be scoped to, in
 * the order it names them. Empty for a goal that names nothing — "delete the
 * first draft" — which is left to the prompt's rule, as before.
 */
export function goalIdentifiers(goal: string): string[] {
  const ids: string[] = [];
  for (const m of goal.matchAll(GOAL_IDENTIFIER)) ids.push(m[0]);
  for (const m of goal.matchAll(CODED_IDENTIFIER)) ids.push(m[0]);
  for (const m of goal.matchAll(QUOTED_IDENTIFIER)) {
    const quoted = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    // A quoted button label or answer ("Yes, delete", "Confirm") scopes nothing.
    if (quoted !== '' && !DESTRUCTIVE_NAME.test(quoted) && !/^(?:yes|no|ok|confirm|cancel|save|submit)\b/i.test(quoted)) ids.push(quoted);
  }
  for (const m of goal.matchAll(NAMED_TARGET)) if (m[1]) ids.push(m[1].trim());
  return [...new Set(ids)].filter((id) => id.length >= 2 && !/^(?:the|a|an|this|that)$/i.test(id));
}

/**
 * Does the selector carry the identifier — literally, or through a named
 * `role=row`/`listitem`/`text=` segment whose name is part of it?
 * `role=row[name="Medical Reimbursement" i] >> role=button[name="Delete" i]`
 * scopes "Medical Reimbursement (ICU)" even though it does not spell the
 * whole identifier; `role=button[name="Delete" i]` scopes nothing.
 */
export function selectorCarries(selector: string, id: string): boolean {
  const needle = id.toLowerCase();
  if (selector.toLowerCase().includes(needle)) return true;
  for (const m of selector.matchAll(/\[name=(?:"([^"]+)"|'([^']+)')|text="?([^">]+?)"?(?=\s*>>|\s*$)/g)) {
    const name = (m[1] ?? m[2] ?? m[3] ?? '').trim().toLowerCase();
    if (name.length >= 3 && !DESTRUCTIVE_NAME.test(name) && needle.includes(name)) return true;
  }
  return false;
}

/** The accessible name of the LAST role segment — the control the click lands on. */
export function targetName(selector: string): string | null {
  const segments = selector.split('>>').map((seg) => seg.trim());
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const name = selectorName(segments[i] ?? '');
    if (name !== null) return name;
    if (/^role=/.test(segments[i] ?? '')) return null;
  }
  return null;
}

/**
 * Why a destructive click must not run as written, or null.
 *
 * Live (be100 PL_03_18, 2026-08-25 06:28): the goal named the row to delete
 * (PL_03_15_16_17_18), the agent could not find it, clicked
 * `role=button[name="Delete" i] >> nth=0` — the first Delete button on a
 * 75-row table — confirmed the dialog, and the network shows
 * `DELETE /api/benefit-plans?planId=TH_MED_001`: a plan the goal never named,
 * gone for good on an authoritative database, and every later case that
 * asserted on it dead-ended. Its reasoning said it was the right row. The
 * rule "no destructive action unless the goal asks" was met on paper.
 *
 * So: when the goal names an identifier and the click's target is a
 * destructive control, the selector must carry one of those identifiers —
 * the row scoped by the thing the goal is about — or be inside a dialog
 * (the confirmation of a delete already scoped). A goal that names no
 * identifier has nothing to scope to and is left to the prompt's rule.
 */
export function unscopedDestructiveClick(decision: DecisionLike, goal: string): string | null {
  if (decision.action !== 'click' || decision.selector.trim() === '') return null;
  const name = targetName(decision.selector);
  if (name === null || !DESTRUCTIVE_NAME.test(name.trim())) return null;
  const ids = goalIdentifiers(goal);
  if (ids.length === 0) return null;
  const selector = decision.selector.toLowerCase();
  // Inside a dialog: the confirmation of a delete already scoped (BE's
  // "Delete plan {name} ({id})?" confirm names the row itself).
  if (/^role=(alert)?dialog\b/.test(selector)) return null;
  if (ids.some((id) => selectorCarries(decision.selector, id))) return null;
  return (
    `destructive: "${decision.selector}" presses "${name}" without naming which row — the goal is about ` +
    `${ids.join(' / ')}, and this would act on whatever row comes first. Scope the click to that row ` +
    `(role=row[name="${ids[0]}" i] >> role=button[name="${name}" i]), or call fail if the row is not on the page`
  );
}

/**
 * How many ok activations (click or press) of the SAME selector one run
 * tolerates before the next one is refused. Three, not two: a multi-select
 * legitimately re-opens its dropdown once per pick (be100 PL_03_17 needed
 * three), and the page-changed guard already lets those through — the
 * pathology this exists for starts at the fourth.
 */
export const TOGGLE_CLICK_LIMIT = 3;

/**
 * Why a control that keeps getting re-activated must not run again, or null.
 *
 * Live (PL_03_02, 2026-08-27): a filter button whose listbox options never
 * appeared in the truncated tree was clicked EIGHT times across 38 turns —
 * each toggle changed the tree (open ↔ closed), so the repeated-on-unchanged-
 * page guard never fired, the URL even changed mid-thrash, and the per-URL
 * done-set restarted. 310 s of wall time on one leg, ok every time, learning
 * nothing. Counted per run and per selector, across URLs, exactly because
 * that is the shape the existing guards cannot see.
 *
 * **`press` counts too, since 2026-09-02** — the same reason, a second
 * escape hatch. Live (HIR-EC-009): a Date of Birth calendar's "Previous
 * year" stepper was PRESSED (not clicked) upward of thirty times hunting a
 * decades-distant year — 15.6 minutes on one leg — because this guard
 * counted `click` alone and a model that reaches for `press` on a focused
 * button (both activate it identically) walked straight past a limit that
 * exists for exactly this shape. A stepper genuinely needing four-plus
 * presses to reach a distant value is real, but the fix for that is a
 * faster route (type the year, jump via a year/month picker), never more of
 * the same press — which is exactly what the refusal below tells the model
 * to do.
 */
export function repeatedToggleClick(
  decision: DecisionLike,
  okClicksThisRun: ReadonlyMap<string, number>,
): string | null {
  if (
    (decision.action !== 'click' && decision.action !== 'press') ||
    decision.selector.trim() === ''
  )
    return null;
  const count = okClicksThisRun.get(decision.selector.trim()) ?? 0;
  if (count < TOGGLE_CLICK_LIMIT) return null;
  return (
    `circling: you have already activated "${decision.selector}" ${count} times this run (click or press) ` +
    `and it has not produced what the goal needs — it likely toggles open and closed, or is a stepper ` +
    `too far from the target to reach one step at a time. Do something different: type the value directly ` +
    `if the control accepts typed input, look for a faster jump (a month/year picker, a search box) instead ` +
    `of stepping to it, act on another control the tree shows, or call fail and say what the page will not reveal`
  );
}

/**
 * The actions that activate a named control — the loop's INTERACTION_ACTIONS
 * minus `signOut`, which names no selector. Mirrored here rather than
 * imported: this is the leaf, and `workflow-agent` imports it.
 */
export const ACTIVATION_ACTIONS: ReadonlySet<string> = new Set([
  'click',
  'press',
  'hover',
  'check',
  'uncheck',
  'fill',
  'type',
  'paste',
  'selectOption',
]);
/** Text entry: the value typed is the only thing the action changes on the page. */
const TEXT_ENTRY_ACTIONS: ReadonlySet<string> = new Set(['fill', 'type', 'paste']);

/** The per-leg key of "this selector was activated on this page". */
export function activationKey(url: string, selector: string): string {
  return `${url} :: ${selector.trim()}`;
}

/**
 * What an ok activation is, seen against the leg so far:
 *  - `first` — this selector has not been activated on this URL this leg;
 *  - `repeat` — it has, by a click-shaped action (click/press/hover/check/
 *    uncheck/selectOption);
 *  - `text-again` — it has, and this is another fill/type/paste into it.
 */
export type Reactivation = 'first' | 'repeat' | 'text-again';

/**
 * Whether this activation re-engages a control already activated on this
 * page this leg, or null when the decision is not an activation at all.
 *
 * Live (ec09 HIR-EC-009 job-3 leg [14], 2026-09-03): ~60 turns and 320 s
 * re-clicking section headers on one wizard page. Every click was ok and
 * each ok click reset the no-progress judge; `repeatedToggleClick` counts
 * three per selector, and with a dozen headers on the page that is thirty-
 * six free turns. Then (job-2, the Position picker, same day): 122 requests
 * and 18 minutes of ok `fill` into `role=textbox[name="Search options" i]`
 * — a different search string each time — between failed `selectOption`s
 * and ok re-clicks of the same button. The judge saw an ok interaction on
 * every turn and never fired.
 *
 * The rule the loop applies through `reactivationAdvanced`: a `first`
 * activation is progress as before; a `repeat` is progress only if the full
 * tree changed after it (a header that opened, a tab that switched — and
 * bounded by AGENT_TREE_CHANGE_CREDITS, so a control that toggles forever
 * still ends the leg); a `text-again` is never progress, because the value
 * it typed is echoed into the tree and would pass a change test on its own
 * evidence. Keyed by the URL the action was taken on: the same selector on
 * a new page is a new control. Only OK activations belong in
 * `activatedHere` — a miss activated nothing.
 */
export function reactivation(
  decision: DecisionLike,
  url: string,
  activatedHere: ReadonlySet<string>,
): Reactivation | null {
  if (!ACTIVATION_ACTIONS.has(decision.action) || decision.selector.trim() === '') return null;
  if (!activatedHere.has(activationKey(url, decision.selector))) return 'first';
  return TEXT_ENTRY_ACTIONS.has(decision.action) ? 'text-again' : 'repeat';
}

/**
 * Whether an ok activation of that kind counts as the turn advancing.
 * `treeChanged` is consulted for a `repeat` only — the loop pays the extra
 * capture just for that case.
 */
export function reactivationAdvanced(kind: Reactivation | null, treeChanged: boolean): boolean {
  if (kind === null || kind === 'first') return true;
  if (kind === 'text-again') return false;
  return treeChanged;
}

/**
 * The named thing a goal says should be SHOWING when it is done.
 *
 * Goals in a catalog are written to a shape: an action, then the state it
 * produces — "click Create Plan **so that the Create Plan dialog opens**",
 * "click its Insert action **so that the popup titled \"Insert New Changes\"
 * opens**". The second half is a checkable claim about the page, and when it
 * is already true the whole leg is already done.
 *
 * Returns the names to look for, best first. Empty when the goal names no
 * such state — which is most goals, and they fall through to the model
 * exactly as before.
 */
/**
 * The name at the END of a phrase, cut at the last connector.
 *
 * "the Create Plan button so the Create Plan" is one match of the bare
 * pattern, and only its tail is the dialog's name — everything up to and
 * including the last `so`/`that`/`the` belongs to the sentence, not the
 * surface. Returns null when what is left does not read like a name.
 */
function trailingName(phrase: string): string | null {
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  const CUT = new Set(['so', 'that', 'the', 'a', 'an', 'and', 'then', 'until', 'button', 'control', 'action', 'link', 'its', 'opens', 'open']);
  let start = 0;
  for (let i = 0; i < words.length; i += 1) {
    if (CUT.has((words[i] ?? '').toLowerCase())) start = i + 1;
  }
  const name = words.slice(start).join(' ').trim();
  // A name is at most a short phrase and starts like one.
  if (name.length < 2 || name.split(/\s+/).length > 5) return null;
  return /^[A-Z]/.test(name) ? name : null;
}

export function goalSurfaceNames(goal: string): string[] {
  const names: string[] = [];
  // A quoted name following the word that says what kind of surface it is —
  // in English, or in the sheets' own words for one (2026-09-03): "ป็อปอัพ
  // "ยืนยันการลบ"", "หน้าต่าง "Confirm Delete"", "กล่องโต้ตอบ". The name may be
  // Thai; the Capitalised-Latin rule below is for the bare form only.
  const titled =
    /(?:dialog|popup|modal|panel|drawer|sheet|ป็อปอัพ|ป๊อปอัพ|กล่องโต้ตอบ|กล่องข้อความ|กล่อง|หน้าต่าง|ไดอะล็อก)\s*(?:titled|named|called|ชื่อ|ที่ชื่อ)?\s*["“]([^"”]{2,80})["”]/giu;
  for (const m of goal.matchAll(titled)) if (m[1]) names.push(m[1].trim());
  // The Thai bare form puts the noun FIRST: "หน้าต่าง Confirm Delete เปิดขึ้น".
  // Only a Latin-capitalised name is readable there, since Thai prose gives
  // the name no boundary of its own.
  const thaiBare = /(?:ป็อปอัพ|ป๊อปอัพ|กล่องโต้ตอบ|หน้าต่าง|ไดอะล็อก)\s*([A-Z][A-Za-z0-9&/-]*(?:\s+[A-Za-z0-9&/-]+){0,4})(?=\s*(?:$|[,.;]|\s*(?:เปิด|แสดง|ปรากฏ|ขึ้น|ต้อง|จะ)))/gu;
  for (const m of goal.matchAll(thaiBare)) if (m[1]) names.push(m[1].trim());
  // The bare form: "the Create Plan dialog opens", "the Confirm delete plan
  // popup appears". Only the words IMMEDIATELY before the surface noun are
  // the name — a goal usually names the control first ("click the Create Plan
  // button so the Create Plan dialog opens"), and a greedy match swallows the
  // sentence between them and matches nothing on the page.
  const bare = /([A-Za-z0-9][^.,;"”]{0,60}?)\s+(?:dialog|popup|modal)\b/g;
  for (const m of goal.matchAll(bare)) {
    const trimmed = trailingName(m[1] ?? '');
    if (trimmed !== null) names.push(trimmed);
  }
  // A placeholder the author left in ("<plan name>") names nothing.
  return [...new Set(names)].filter((n) => !/[<>]/.test(n) && n.length >= 2);
}

/**
 * Is the state this goal describes ALREADY showing on the page?
 *
 * Live (be100, 2026-08-26): six of ten agent runs in one pass finished in one
 * or two turns having discovered nothing to do — "the tree shows dialog
 * … already present", "the dialog … is already open". The preceding authored
 * step had opened it, and the workflow leg then paid a model call, its
 * process startup and two turns to find that out. Sixty per cent of the
 * agent's work in that pass was rediscovering a fact the tree already stated.
 *
 * Deliberately narrow, and biased to saying no: it fires only when the goal
 * names a surface AND a node of that role carries that name. A goal that
 * names nothing, or a name the tree does not show, falls through to the
 * model exactly as before — the cost of a false yes is a leg that never ran,
 * which is far worse than a leg that ran needlessly.
 */
export function goalAlreadyShowing(goal: string, nodes: readonly AxNode[]): string | null {
  const names = goalSurfaceNames(goal);
  if (names.length === 0) return null;
  const surfaces = nodes.filter((n) => /^(dialog|alertdialog)$/i.test(n.role));
  if (surfaces.length === 0) return null;
  for (const name of names) {
    const needle = name.toLowerCase().trim();
    const words = needle.split(/\s+/).filter((w) => w.length > 1);
    if (words.length === 0) continue;
    const hit = surfaces.find((n) => {
      const shown = n.name.toLowerCase();
      // Word-wise, the rule `selectorGrounded` already uses, and for the same
      // reason: the page's own name is routinely longer than the goal's. The
      // measured pair is a goal saying "the Create Plan dialog" against a
      // dialog the application calls "Create Benefit Plan" — the same
      // surface, one inserted word apart. Substring matching misses it.
      return shown.includes(needle) || words.every((w) => shown.includes(w));
    });
    if (hit !== undefined) return hit.name || name;
  }
  return null;
}


// --- the menu path a goal names (OA-2, pure half) -----------------------------

/**
 * One level of a menu path: the label the sheet wrote, plus every spelling a
 * node may carry for it — the label itself and a parenthetical alias
 * ("Hire & Onboard (New Hire)" is the rail group "Hire & Onboard" on one
 * build and the leaf "New Hire" on another).
 */
export interface MenuSegment {
  name: string;
  alternatives: string[];
}

/** A URL in a goal is a destination, never a menu label. */
const MENU_URL = /\bhttps?:\/\/\S+/gi;
/** `A > B > C`, `A › B`, `A -> B`, `A » B`. */
const MENU_CHAIN =
  /([\p{L}\p{N}&][^>›→»\n,.;]{0,50}?)((?:\s*(?:->|>|›|→|»)\s*[\p{L}\p{N}][^>›→»\n,.;]{0,50}?){1,6})(?=\s*(?:$|[,.;\n]|\s+(?:to|and|then|so|until|where)\b|\s*(?:แล้ว|จากนั้น|เพื่อ|และ)))/u;
const MENU_SEPARATOR = /\s*(?:->|>|›|→|»)\s*/u;
/** The numbered form the BE and TM sheets use, only when a menu word precedes it. */
const MENU_NUMBERED = /(?:menu(?:\s+path)?|เมนู|via|through)\s*[:：]?\s*(?=1\.\s)/iu;
const MENU_LEAD =
  /^(?:(?:navigate|navigating|go|goes|open|opens|click|clicks|press|select|via|through|under|to|the|a|an|menu|path|from|in|on|and|then|use|using)\s+|(?:เปิดเมนู|กดเมนู|เข้าเมนู|เข้าสู่เมนู|เมนู|ไปที่|เปิด|กด|เข้า)\s*)+/iu;
const MENU_TAIL = /(?:\s+(?:menu|page|tab|screen|section|เมนู|หน้า)|\s*[-–:]+)+$/iu;
const MENU_CUT = /\s+(?:to|and|then|so|until|where)\b.*$|\s*(?:แล้ว|จากนั้น|เพื่อ|และ).*$/iu;

function menuSegment(raw: string): MenuSegment | null {
  let text = raw.replace(MENU_CUT, '').trim().replace(MENU_LEAD, '').replace(MENU_TAIL, '').trim();
  const alternatives: string[] = [];
  const aliased = /^(.+?)\s*\(([^()]{1,40})\)$/u.exec(text);
  if (aliased) {
    text = (aliased[1] as string).trim();
    const alias = (aliased[2] as string).trim();
    // A live count ("(3)") or a URL is not a second name for the level.
    if (!/^\d+$/.test(alias) && !/^https?:/i.test(alias)) alternatives.push(alias);
  }
  if (text.length < 2 || text.length > 60 || text.split(/\s+/).length > 6) return null;
  return { name: text, alternatives: [text, ...alternatives] };
}

/**
 * The menu path a goal names, or null when it names none.
 *
 * Every case's first leg is a walk down the shell's menu — "EC > Hire &
 * Onboard (New Hire)" (272 EC rows), "1. HR 2. Benefits Admin 3. Benefit
 * Plans" (BE), "SPD Admin > Payroll > Run Payroll" (PY), "ME > Time &
 * Attendance > Leave request" (TM) — and each level costs a model turn today
 * because ROUTE_WORDS keeps the preflight's goto rung off any goal that
 * names a route. The path is a literal, and a literal is a $0 rung: the
 * agent's walker (wave 2, `#walkMenuPath` in workflow-agent.ts) clicks the
 * tab/button/link whose name matches each segment in turn and hands the
 * rest to the model at the first segment the tree does not show.
 *
 * Read from three shapes: an arrow chain after any wording ("Navigate via
 * HR > Benefits Admin > Benefit Plans to the …", "open EC > Hire & Onboard
 * (New Hire)", "เปิดเมนู Setup > ระบบ > ความปลอดภัย > Consent Form"), the
 * numbered form after a menu word ("menu path: 1. HR 2. Benefits Admin
 * 3. Benefit Plans"), and nothing else — a single level ("via the sidebar")
 * is not a path, and is left to the link and goto rungs as before.
 */
export function menuPathOf(goal: string): MenuSegment[] | null {
  const text = goal.replace(MENU_URL, ' ').replace(/\((?:test\s+step|step|case|row)\b[^)]*\)/gi, ' ');
  let parts: string[] = [];
  const chain = MENU_CHAIN.exec(text);
  if (chain) {
    parts = `${chain[1] as string}${chain[2] as string}`.split(MENU_SEPARATOR);
  } else {
    const numbered = MENU_NUMBERED.exec(text);
    if (numbered) {
      const rest = text.slice(numbered.index + numbered[0].length);
      let expected = 1;
      for (const m of rest.matchAll(/(\d+)\.\s+(.+?)(?=\s*(?:\n|$)|\s+\d+\.\s)/gu)) {
        if (Number(m[1]) !== expected) break;
        parts.push(m[2] as string);
        expected += 1;
      }
    }
  }
  const segments: MenuSegment[] = [];
  for (const part of parts) {
    const segment = menuSegment(part);
    if (segment === null) return segments.length >= 2 ? segments : null;
    segments.push(segment);
  }
  return segments.length >= 2 ? segments : null;
}

/**
 * How well a tree node's name answers a menu segment: 2 when it IS the
 * label (a live-count badge aside — "Probation Reviews 3"), 1 when it
 * contains it whole-word ("HR Analytics" contains "HR", and is the wrong
 * node when an exact "HR" exists — so the walker prefers 2 over 1), 0
 * otherwise. Either spelling of the segment counts; Thai is containment.
 */
export function menuNodeScore(segment: MenuSegment, nodeName: string): 0 | 1 | 2 {
  const shown = foldValue(nodeName.replace(/\s*[([]?\d+[)\]]?\s*$/u, ''));
  if (shown === '') return 0;
  let best: 0 | 1 | 2 = 0;
  for (const alternative of segment.alternatives) {
    const want = foldValue(alternative);
    if (want === '') continue;
    if (shown === want) return 2;
    if (valueShownIn(shown, want)) best = 1;
  }
  return best;
}

// --- a goal that needs more than one person (OA-15, pure half) ---------------

/** `<HR_ADMIN_ACCOUNT>` → "hr admin"; the sheet's own persona placeholders. */
const ACCOUNT_TOKEN = /<([A-Z][A-Z0-9_]*?)_ACCOUNT>/g;
const ROLE_WORD = String.raw`(manager|hrbp|hr\s+admin|admin|employee|approver|supervisor|line\s+manager|หัวหน้า|ผู้อนุมัติ|ผู้จัดการ|พนักงาน|ผู้ดูแล)`;
/** "as the manager", "ในฐานะหัวหน้า", "Login ด้วย manager", "sign in as employee". */
const PERSONA_AS = new RegExp(
  String.raw`(?:\bas\s+(?:the\s+|an?\s+)?|ในฐานะ\s*|(?:\blog\s*in|\bsign\s*in|\blogin|เข้าสู่ระบบ|เข้าระบบ)\s*(?:ด้วย|as|with)?\s*(?:the\s+)?)${ROLE_WORD}(?![\p{L}])`,
  'giu',
);
/** "the manager approves", "หัวหน้าอนุมัติ", "HRBP rejects" — a second actor doing the deciding. */
const PERSONA_ACTS = new RegExp(
  String.raw`(?:\b(?:the\s+)?(manager|hrbp|approver|supervisor|line\s+manager)\s+(?:then\s+)?(?:approves?|rejects?|กด|อนุมัติ|ปฏิเสธ)|(หัวหน้า|ผู้อนุมัติ)\s*(?:กด|อนุมัติ|ปฏิเสธ))`,
  'giu',
);
/** Wording that says the session changes hands, whoever the second person is. */
const PERSONA_SWITCH =
  /\b(?:signs?|logs?)\s+(?:in|on)\s+again\b|\bsign(?:s)?\s+out\s+and\s+(?:sign|log)|\bswitch(?:es)?\s+(?:user|account|persona|to\s+the\s+(?:manager|employee|hrbp|admin))\b|\bre-?login\b|เข้าสู่ระบบอีกครั้ง|สลับผู้ใช้|ออกจากระบบแล้วเข้า/iu;

function personaLabel(raw: string): string {
  const word = raw.toLowerCase().replace(/[_\s]+/g, ' ').trim();
  const thai: Record<string, string> = {
    'หัวหน้า': 'manager', 'ผู้จัดการ': 'manager', 'ผู้อนุมัติ': 'approver', 'พนักงาน': 'employee', 'ผู้ดูแล': 'admin',
  };
  const english: Record<string, string> = { supervisor: 'manager', 'line manager': 'manager' };
  return thai[word] ?? english[word] ?? word;
}

/**
 * The distinct personas a goal asks for, when there are two or more — or
 * null when one person can do the whole leg.
 *
 * ~130 hand-off cases in the workbook — PRB manager → HRBP → HR admin
 * ("Data: ผู้ทดสอบ <MANAGER_ACCOUNT> ผู้ประเมิน และ <HRBP_ACCOUNT> ผู้อนุมัติ",
 * "3. Login ด้วย <HRBP_ACCOUNT> แล้วกด Open case รายการเดิมแล้วกด Approve"),
 * TM leave "9. Manager กดปุ่ม approve request leave" after an employee
 * submits, the consent admin↔employee alternation — and the agent has no
 * sign-out, one credential pair, and a finish rule that judges one page. A
 * leg written for two people either stalls on the sign-in page or is refused
 * a finish; both cost turns to learn what the goal already said. Read up
 * front so `run()` can return the split as a summary (wave 2), never a
 * throw, and `run-cases` records an authoring refusal rather than a failed
 * step.
 *
 * Three signals: two distinct `<X_ACCOUNT>` tokens; two different role words
 * after "as"/"ในฐานะ"/a sign-in verb; a second actor doing the approving; or
 * wording that the session changes hands. A parenthetical qualifier on a
 * token — "<HR_ADMIN_ACCOUNT> (HRBP)" is one account acting in a role, and
 * needs a human mapping, not a split — is ignored. Biased to null: a goal
 * that merely mentions the approval route ("Approval route = Manager") names
 * no second actor.
 */
export function multiPersonaGoal(goal: string): string[] | null {
  const text = goal.replace(/(<[A-Z][A-Z0-9_]*_ACCOUNT>)\s*\([^)]*\)/g, '$1');
  const personas: string[] = [];
  const add = (label: string): void => {
    if (label !== '' && !personas.includes(label)) personas.push(label);
  };
  for (const m of text.matchAll(ACCOUNT_TOKEN)) add(personaLabel(m[1] as string));
  for (const m of text.matchAll(PERSONA_AS)) add(personaLabel(m[1] as string));
  for (const m of text.matchAll(PERSONA_ACTS)) {
    // "Login web humi … submit … then Manager กดปุ่ม approve" (ML_01_01): the
    // first person is whoever the run signed in as, named by no role word
    // at all — the submit before the approver is what says there are two.
    if (personas.length === 0 && /\b(?:submit|sign\s*in|log\s*in|login)\b|ยื่น|ส่งคำขอ|เข้าสู่ระบบ/iu.test(text.slice(0, m.index ?? 0))) {
      add('the signed-in person');
    }
    add(personaLabel((m[1] ?? m[2]) as string));
  }
  const switches = PERSONA_SWITCH.test(text);
  if (personas.length >= 2) return personas;
  if (switches) return [...personas, 'another person'];
  return null;
}

/**
 * The summary `run()` returns for a multi-persona goal. Protocol: it starts
 * with `multi-persona goal:` so `run-cases` can file it as an authoring
 * refusal (the leg must be split around `signOut`), the way `agent model
 * failed:` is read by prefix today.
 */
export function multiPersonaSummary(personas: readonly string[]): string {
  const second = personas[1] ?? 'the next person';
  return (
    `multi-persona goal: this leg must be authored as separate steps (signOut → sign-in as ${second} → workflow) — ` +
    `it names ${personas.join(' and ')}, and one session cannot be both`
  );
}

// --- required fields still empty (OA-6, pure half) ---------------------------

/**
 * The shape of a node the gap scan reads. Structural rather than `AxNode`
 * because `required` is being added to `AxNode` by the engine-helpers change
 * (`captureAxNodes` reading the CDP `required` property); this compiles with
 * or without it, and a label ending in `*` is read as required either way.
 */
export interface FormNodeLike {
  role: string;
  name: string;
  value: string;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  readonly?: boolean | undefined;
  checked?: boolean | undefined;
}

/** A required control the agent has not filled yet, and the tree line that shows it. */
export interface FormGap {
  role: string;
  name: string;
  value: string;
  line: string;
}

/** The roles a form value lives in. `button` is the custom-select trigger (its value= is the pick). */
export const FORM_INPUT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton', 'slider', 'button', 'checkbox', 'radio', 'switch']);
/** A value that is a placeholder, not a pick: "", "—", "— Select —", "เลือก…", "กรุณาเลือก", "dd/mm/yyyy". */
const EMPTY_VALUE = /^[\s\-–—]*(?:$|(?:select|choose|please|none|n\/a|dd\/mm\/yyyy|mm\/dd\/yyyy|yyyy-mm-dd)(?![\p{L}])|เลือก|กรุณา)/iu;

/**
 * The required controls the tree shows still EMPTY, in document order.
 *
 * "กรอกข้อมูล Mandatory อื่นให้ครบถ้วนเพื่อให้สามารถ Submit ได้" (HIR-EC-106 and
 * every EC key-in row), "ให้ครบทุกช่องที่มีเครื่องหมายดอกจัน" (EC-Hiring-4/5/6),
 * "กรอก Required field อื่นๆ ให้ครบถ้วน" (BE-Plan) — the sheet delegates the
 * required set to the tester's eyes, and the agent's prompt shows a goal, a
 * card and a tree with nothing that summarises the form's state, so a "fill
 * all required" goal is a hunt across a truncated tree. Required is the
 * `required` flag when the capture carries it, or a label ending in `*`
 * ("Employee Group*" in the ec10 report) when it does not; empty is a blank
 * value or a placeholder pick; a required checkbox is a gap while unchecked.
 * Rendered by `formatFormGaps` under the tree (wave 2: `buildUserPrompt`,
 * between the tree and "Current URL:").
 */
export function formGaps(nodes: readonly FormNodeLike[]): FormGap[] {
  const gaps: FormGap[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (!FORM_INPUT_ROLES.has(node.role) || node.disabled === true) continue;
    const required = node.required === true || /\*\s*$/u.test(node.name);
    if (!required) continue;
    const empty =
      node.role === 'checkbox' || node.role === 'radio' || node.role === 'switch'
        ? node.checked !== true
        : EMPTY_VALUE.test(node.value);
    if (!empty) continue;
    const line = `${node.role} ${JSON.stringify(node.name)}${node.value ? ` value=${JSON.stringify(node.value)}` : ''}`;
    if (seen.has(line)) continue;
    seen.add(line);
    gaps.push({ role: node.role, name: node.name, value: node.value, line });
  }
  return gaps;
}

/**
 * `REQUIRED AND STILL EMPTY (3): textbox "Bank*" · button "Currency*"
 * value="— Select —" · …` — one line for the prompt, or null when there is
 * nothing to say. Capped so a 60-field form cannot crowd out the tree; the
 * count says how many there really are.
 */
export function formatFormGaps(gaps: readonly FormGap[], cap = 40): string | null {
  if (gaps.length === 0) return null;
  const shown = gaps.slice(0, cap).map((g) => g.line);
  const more = gaps.length > cap ? ` · … and ${gaps.length - cap} more` : '';
  return `REQUIRED AND STILL EMPTY (${gaps.length}): ${shown.join(' · ')}${more}`;
}

/**
 * What a `selectOption` miss that ENUMERATED the control's options says about
 * the goal: the pair `control = value` the goal names for that control, when
 * the value is among none of the options shown.
 *
 * Live (ec09 HIR-EC-009, panel job-3 leg [23], 2026-09-03): `selectOption
 * Employee Group = "F - DVT"` opened the list, which held exactly three
 * options — "1 — พนักงานประจำ (Active) ✓", "2 — พนักงานชั่วคราว (Temporary)",
 * "3 — พนักงานนอกเวลา (Part-time)" — and closed it again. The loop recorded a
 * failed action and asked the model what to do next; the model tried "DVT",
 * saw the same three, and called `fail` with the same sentence the first
 * error already contained. Three model turns for a fact the first action
 * had established. The judge that should have fired did not exist: no rule
 * read the enumeration as evidence.
 *
 * Deliberately narrow, in the direction that costs nothing when it declines:
 *  - the decision's value must be the goal's OWN value for that control
 *    (`goalOutcomes`, folded) — a paraphrase the model tried ("DVT"; though
 *    "F — DVT" for "F - DVT" folds equal) is not the goal's claim, and a
 *    miss on it proves nothing;
 *  - the control the selector names must be the control the goal names
 *    (the selector's name holds the control's words or vice versa);
 *  - the list must have held at least one option — an empty list is a list
 *    still loading or a search that hid everything, never an enumeration;
 *  - the caller passes only a WHOLE enumeration (`ListboxOptionMissingError
 *    .filtered === false`): a list narrowed by a typed head says nothing
 *    about what the filter hid.
 * None of the shown options may show the value (`valueShownIn`, so "F — DVT"
 * on the page satisfies "F - DVT" in the goal and the rule stays quiet).
 *
 * The loop, not this predicate, decides what to do with it — it retries the
 * pick once after the page settles at $0 (a list still loading is not a list
 * without the option: in the same run this control offered "F — DVT" three
 * minutes later) and ends the leg only on a second identical enumeration.
 */
export function listboxCannotOffer(
  decision: DecisionLike,
  shown: readonly string[],
  goal: string,
): { control: string; value: string; shown: string[] } | null {
  if (decision.action !== 'selectOption' || shown.length === 0 || decision.value.trim() === '') return null;
  const asked = foldValue(decision.value);
  const name = selectorName(decision.selector);
  if (name === null) return null;
  const nameKey = foldValue(name.replace(/\*+\s*$/u, ''));
  for (const outcome of goalOutcomes(goal)) {
    if (foldValue(outcome.value) !== asked) continue;
    const ctl = foldValue(outcome.control);
    if (ctl !== nameKey && !nameKey.includes(ctl) && !ctl.includes(nameKey)) continue;
    if (shown.some((option) => valueShownIn(option, outcome.value))) return null;
    return { control: outcome.control, value: outcome.value, shown: [...shown] };
  }
  return null;
}

/** Two enumerations of one list are the same list: same options, order aside, a current-pick tick ignored. */
export function sameOptions(a: readonly string[], b: readonly string[]): boolean {
  const fold = (list: readonly string[]): string =>
    [...list]
      .map((o) => foldValue(o.replace(/\s*[✓✔]\s*$/u, '')))
      .sort()
      .join('\n');
  return a.length === b.length && fold(a) === fold(b);
}
