/**
 * The facts every renderer shows about a step — one reading of the record
 * for the HTML report, the catalog report, the Excel export, the machine
 * report and wowUI (which mirrors these in its own script, function by
 * function, the way it already mirrors `describeValueSource`).
 *
 * Why this exists (enhancedX wave 2, 2026-09-03): the harness grew four step
 * kinds the renderers had never met — `expectAnyVisible` (a list of
 * selectors, no `selector`), `expectFieldError` (a field and the message under
 * it), `upload` (files) and `signIn` (a persona) — and two resolutions
 * (`reveal`, `scroll`). Every renderer read `step.selector` and printed
 * `step.resolution` raw, so an either/or assertion (PY "ระบบประมวลผลสำเร็จหรือ
 * แสดง error ตามเงื่อนไข", 95 rows) rendered as an EMPTY row and a step that
 * only worked because a collapsed section was opened wore a badge that said
 * `reveal` and nothing else. A step kind that renders as an empty row is the
 * failure mode this module is here to make impossible: the target and the
 * facts are computed HERE, from the record, and every renderer asks.
 *
 * Two rules, both load-bearing:
 *
 * - **Never a credential.** A `signIn` step is rendered by its persona LABEL
 *   (`HR_ADMIN_ACCOUNT`) and nothing else. The engine may record the resolved
 *   email on the step; `visibleDetail` drops every credential-shaped key from
 *   the generic detail dump, and a label that IS an email is withheld. The
 *   report travels — by mail, on a USB stick, into a bug tracker.
 * - **Never file contents.** An `upload` shows file NAMES: what was attached
 *   is evidence, what was in it is not the report's to carry (a fixture PDF
 *   is bytes; a CSV may hold the data under test).
 *
 * Everything here is pure and defensive: the engine half of every new kind
 * is being wired in the same wave, so each reader accepts the shape the
 * contract names AND the nearest plausible one, and returns nothing rather
 * than a placeholder that reads like a fact.
 */

import type { AgentAction, ProofBundle, ResolutionSource } from '../engine/proof-bundle.js';
import { describeValueSource as describeEngineValueSource } from '../engine/proof-bundle.js';

export function describeValueSource(step: { detail?: Record<string, unknown> | undefined }): string | null {
  const source = step.detail?.['valueSource'];
  if (typeof source === 'object' && source !== null) {
    const value = source as { kind?: unknown; detail?: unknown };
    if (value.kind === 'master-data') {
      const detail = typeof value.detail === 'string' ? value.detail : '';
      return `from the application's master${detail === '' ? '' : `: ${detail}`}`;
    }
  }
  return describeEngineValueSource(step);
}

/** One labelled fact about a step, rendered wherever the step is. */
export interface StepFact {
  label: string;
  value: string;
}

/** The slice of a step every reader here needs. Structural, so wowUI's cards and half-built records fit. */
export interface StepLike {
  action: string;
  selector?: string | null | undefined;
  resolvedSelector?: string | null | undefined;
  detail?: Record<string, unknown> | undefined;
  /** Who the step ran as and on which Chrome — see `ProofStep.persona` / `.browser`. */
  persona?: string | undefined;
  browser?: string | undefined;
  /** The agent record, when the step was a workflow leg; `observations` (OA-14) is read off it structurally. */
  agent?: object | undefined;
}

/** A persona LABEL and nothing else: no address, no `LABEL=email:password` remnant. See `signInPersona`. */
const LABEL_ONLY = /^[^@:]+$/;
/** An address anywhere in a string — the rule for a `signIn` step's detail, where any string may carry the account. */
const CONTAINS_EMAIL = /[^\s@"']+@[^\s@"']+\.[^\s@"']+/;

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return typeof value === 'string' && value !== '' ? [value] : [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      if (entry !== '') out.push(entry);
    } else if (typeof entry === 'object' && entry !== null) {
      const named = entry as { name?: unknown; path?: unknown; selector?: unknown };
      const name =
        typeof named.name === 'string' ? named.name : typeof named.path === 'string' ? named.path : typeof named.selector === 'string' ? named.selector : null;
      if (name !== null && name !== '') out.push(name);
    }
  }
  return out;
}

/** The last path segment — a file NAME, never where it sat on the author's disk. */
function fileName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * The selectors an `expectAnyVisible` offered. The contract records them
 * under `detail.selectors`; a runner that joined them into `selector` with
 * ` | ` (the CLI's own spelling of an alternative) is read too.
 */
export function anyVisibleSelectors(step: StepLike): string[] {
  const listed = stringsOf(step.detail?.['selectors']);
  if (listed.length > 0) return listed;
  const joined = step.selector ?? '';
  return joined.includes(' | ') ? joined.split(' | ').map((s) => s.trim()).filter((s) => s !== '') : joined === '' ? [] : [joined];
}

/** The file names an `upload` attached. Names only — see the module note. */
export function uploadedFileNames(step: StepLike): string[] {
  const detail = step.detail ?? {};
  const listed = stringsOf(detail['files']);
  const named = listed.length > 0 ? listed : stringsOf(detail['fileNames'] ?? detail['file']);
  return named.map(fileName);
}

/**
 * The persona a `signIn` step signed in as — its LABEL, and only ever a label.
 *
 * A label is what the flow is supposed to carry (`<MANAGER_ACCOUNT>`, `HR
 * admin`). Anything holding an `@` or a `:` is not one: an address is a
 * credential's other half, and a colon is the persona wire format's own
 * separator (`LABEL=email:password`), so everything after it is a password.
 * Both are withheld.
 *
 * The previous rule tested for a well-formed address, which let two shapes
 * through that a person actually produces: a value with no dot in the domain
 * (`mgr@intranet:pw`) and a label with a password appended (`HRBP_ACCOUNT:pw`).
 * Structure decides this, not well-formedness — the cost of withholding a
 * legitimate label is one generic phrase in the report, and the cost of
 * printing is a password.
 */
export function signInPersona(step: StepLike): string | null {
  const detail = step.detail ?? {};
  const raw = detail['as'] ?? detail['persona'] ?? detail['personaLabel'];
  if (typeof raw !== 'string' || raw === '') return null;
  return LABEL_ONLY.test(raw) ? raw : 'an account named by its credentials (withheld from the report)';
}

/** The author's own timeout on a step, when they set one (`timeoutMs` on the FlowStep, recorded on the detail). */
export function authoredTimeout(step: StepLike): string | null {
  const raw = step.detail?.['timeoutMs'];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  return raw >= 1000 ? `${(raw / 1000).toFixed(raw % 1000 === 0 ? 0 : 1)}s` : `${Math.round(raw)}ms`;
}

/**
 * What the step was aimed at, for the one line every renderer prints beside
 * the action. The resolved selector, else the authored one, else — for the
 * kinds that have no single selector — a description built from the record.
 * Null only when the record truly names nothing (a `goto`, an HTTP step).
 */
export function stepTarget(step: StepLike): string | null {
  const selector = step.resolvedSelector ?? step.selector ?? null;
  if (selector !== null && selector !== '') return selector;
  switch (step.action) {
    case 'expectAnyVisible': {
      const selectors = anyVisibleSelectors(step);
      return selectors.length === 0 ? null : selectors.join(' | ');
    }
    case 'signIn': {
      const persona = signInPersona(step);
      return persona === null ? null : `persona ${persona}`;
    }
    case 'upload': {
      const files = uploadedFileNames(step);
      return files.length === 0 ? null : files.join(', ');
    }
    default:
      return null;
  }
}

/**
 * The labelled facts a step kind carries beyond its selector, in the order
 * a reader checks them. Empty for the ordinary kinds — the selector line and
 * `expectedActual` already say everything about a `click` or an `expectText`.
 */
export function stepKindFacts(step: StepLike): StepFact[] {
  const facts: StepFact[] = [];
  const detail = step.detail ?? {};
  switch (step.action) {
    case 'expectAnyVisible': {
      const selectors = anyVisibleSelectors(step);
      if (selectors.length > 0) facts.push({ label: 'any of', value: selectors.map((s, i) => `${i + 1}. ${s}`).join('\n') });
      const matched = detail['matched'] ?? detail['visible'] ?? detail['satisfiedBy'];
      if (typeof matched === 'string' && matched !== '') facts.push({ label: 'satisfied by', value: matched });
      break;
    }
    case 'expectFieldError': {
      const field = step.selector ?? null;
      if (field !== null && field !== '') facts.push({ label: 'field', value: field });
      const via = detail['via'] ?? detail['readVia'];
      if (typeof via === 'string' && via !== '') facts.push({ label: 'message read via', value: via });
      break;
    }
    case 'upload': {
      const files = uploadedFileNames(step);
      if (files.length > 0) facts.push({ label: files.length === 1 ? 'file' : 'files', value: files.join(', ') });
      const via = detail['via'] ?? detail['attachedVia'];
      if (typeof via === 'string' && via !== '') facts.push({ label: 'attached via', value: via });
      break;
    }
    case 'signIn': {
      const persona = signInPersona(step);
      if (persona !== null) facts.push({ label: 'persona', value: persona });
      // One Chrome per persona: a switch back to a person already signed
      // in keeps their session; a new person got a browser of their own.
      if (detail['keptSession'] === true) facts.push({ label: 'session', value: 'kept — switched to this persona\'s own browser, no login' });
      else if (detail['inheritedSession'] === true) facts.push({ label: 'session', value: 'inherited from the suite, no login' });
      else if (typeof detail['openedBrowser'] === 'string') facts.push({ label: 'session', value: 'new — on a browser of its own' });
      break;
    }
    default:
      break;
  }
  const browser = browserFact(step);
  if (browser !== null) facts.push({ label: 'browser', value: browser });
  const timeout = authoredTimeout(step);
  if (timeout !== null) facts.push({ label: 'timeout', value: `${timeout} (set by the author)` });
  return facts;
}

/**
 * Which Chrome a step ran on, as its port (`9223`), when the run spread
 * personas over more than one — the step's own stamp, else the `signIn`
 * detail that opened or switched to it. Null on a single-browser run,
 * where "browser 9222" on every line would be noise.
 */
export function browserFact(step: StepLike): string | null {
  const detail = step.detail ?? {};
  const raw = step.browser ?? detail['browser'] ?? detail['switchedTo'] ?? detail['openedBrowser'];
  if (typeof raw !== 'string' || raw === '') return null;
  const port = raw.match(/:(\d+)\/?$/)?.[1];
  const who = step.persona !== undefined && step.persona !== '' ? ` (${step.persona})` : '';
  return `${port ?? raw}${who}`;
}

/**
 * Detail keys that can carry a credential or its other half. Dropped from
 * every generic detail dump, on every step kind — an `email` on a `fill` is
 * the sheet's own test data, but an `email` beside a `password` key is a
 * login, and the dump cannot tell which; the facts above say what matters.
 */
export const CREDENTIAL_DETAIL_KEYS = /password|passwd|pwd|secret|token|credential|signedIn|personas|^email$|^as$/i;

/**
 * Keys a renderer has already shown as a dedicated line — the intent, the
 * comparison, the kind facts, the observations — so the generic dump does
 * not repeat them verbatim underneath.
 */
const DEDICATED_DETAIL_KEYS = new Set([
  'intent',
  'expected',
  'actual',
  'selectors',
  'files',
  'fileNames',
  'file',
  'persona',
  'personaLabel',
  'timeoutMs',
  'observed',
  'valueSource',
]);

/**
 * The generic key/value entries a renderer may dump for a step: everything
 * the dedicated lines did not already show, minus anything credential-shaped
 * (see `CREDENTIAL_DETAIL_KEYS`), and on a `signIn` step minus any string
 * that carries an email whatever its key.
 */
export function visibleDetail(step: StepLike): [string, unknown][] {
  const detail = step.detail;
  if (!detail) return [];
  const out: [string, unknown][] = [];
  for (const [key, value] of Object.entries(detail)) {
    if (key === 'intent' && typeof value === 'string') continue;
    if (DEDICATED_DETAIL_KEYS.has(key) && key !== 'intent') continue;
    if (CREDENTIAL_DETAIL_KEYS.test(key)) continue;
    if (step.action === 'signIn' && typeof value === 'string' && CONTAINS_EMAIL.test(value)) continue;
    out.push([key, value]);
  }
  return out;
}

/**
 * Plain-language name and explanation for every way a selector resolves.
 * `fast` has no label — every ordinary step resolves that way and badging
 * it would mark exactly the steps that need no attention. The explanation
 * is what the report's `<abbr>` shows and what the Excel Proof column and
 * wowUI's "rung" line append, so a reader meeting `reveal` for the first
 * time is told what was done on their behalf.
 */
export const RESOLUTION_EXPLANATIONS: Record<Exclude<ResolutionSource, 'fast'>, { label: string; explanation: string }> = {
  case: {
    label: 'matched ignoring letter-case',
    explanation:
      'The selector matched once letter-case was ignored. Chrome and Playwright compute accessible names differently when CSS changes text case.',
  },
  narrow: {
    label: 're-matched against the page text',
    explanation:
      "A text selector that did not match as written, re-matched for free against what the page actually contains: an unquoted substring form narrowed to exact text when it hit several elements, or a quoted exact form relaxed to a substring when the page renders the value with formatting around it. The asserted text is on the page; the selector was written tighter or broader than the rendering.",
  },
  reveal: {
    label: 'a collapsed section was opened first',
    explanation:
      "The author's selector matched a control folded inside a collapsed section (an accordion, a <details>, a tab), so its disclosure was clicked and the SAME selector run again. Free and deterministic — no model, no rewrite of the selector. The step passed on its own terms; the flow could add the click that opens the section.",
  },
  scroll: {
    label: 'scrolled clear of a fixed bar',
    explanation:
      "The author's selector resolved, but a fixed or sticky bar was covering it and intercepted the pointer, so the control was scrolled to the middle of the viewport and the same selector acted. Free and deterministic; nothing about the selector changed.",
  },
  kin: {
    label: 'held against the control\'s container',
    explanation:
      "The author's selector resolved, only its TEXT missed, and the claim held against the element's container instead — a label whose value sits beside it rather than inside it. Free and deterministic.",
  },
  'agent-read': {
    label: 'the agent pointed, the harness checked',
    explanation:
      "The agent was asked the assertion's own question — read-only, it could not act — and named the element holding the answer; the harness then re-ran the author's comparison against it. The agent's answer is checked, never believed.",
  },
  late: {
    label: 'resolved late',
    explanation:
      'The content appeared, but only when given the longer healed-selector window — slower than the fast-path budget. The feature works; the page is slow or hydrates late, and a timing defect records it.',
  },
  cache: { label: 'reused an earlier repair', explanation: 'A selector repaired on a previous run was reused here, at no cost.' },
  jit: {
    label: 'selector auto-repaired',
    explanation:
      'The selector in the test did not match; a model proposed a replacement, which was verified to match exactly one element before being used. Worth updating the test.',
  },
  dialog: {
    label: 'dialog dismissed first',
    explanation: 'Something was covering the page — a cookie banner, a modal — so it was dismissed and the original selector retried.',
  },
  agent: {
    label: 'agent cleared the way',
    explanation:
      'The control was not reachable — behind a closed menu, below the fold, or on a view still loading — so an agent drove the browser until it was, and then the step ran the original selector. The test passed on its own terms; it just could not get there unaided. Add the steps that reveal the control.',
  },
};

/**
 * Label + explanation for a resolution, or null for `fast` and for nothing.
 * A resolution this module has never heard of comes back under its own name
 * with a one-line note — a rung added later must never silently vanish from
 * the account of how a step resolved.
 */
export function describeResolution(resolution: string | null | undefined): { label: string; explanation: string } | null {
  if (!resolution || resolution === 'fast') return null;
  const known = (RESOLUTION_EXPLANATIONS as Record<string, { label: string; explanation: string }>)[resolution];
  return known ?? { label: resolution, explanation: `The selector resolved through the "${resolution}" rung of the escalation ladder.` };
}

/** One observation the workflow agent read off the live page, carried as evidence. */
export interface ObservedItem {
  selector: string | null;
  text: string;
  url: string | null;
}

function observedItemOf(raw: unknown): ObservedItem | null {
  if (typeof raw === 'string') return raw === '' ? null : { selector: null, text: raw, url: null };
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as { selector?: unknown; text?: unknown; url?: unknown; value?: unknown };
  const text = typeof item.text === 'string' ? item.text : typeof item.value === 'string' ? item.value : '';
  if (text === '') return null;
  return {
    selector: typeof item.selector === 'string' && item.selector !== '' ? item.selector : null,
    text,
    url: typeof item.url === 'string' && item.url !== '' ? item.url : null,
  };
}

/**
 * What a `workflow` step's agent OBSERVED (its `read` actions), from
 * `detail.observed` — the contract — or, failing that, the record's own
 * `observations`. The observe-and-record legs ("บันทึกค่าที่ระบบแสดงจริง",
 * ~250 lines across EC/PRB/TM) end with these as their only evidence, and a
 * report that lost them under one 120-character history line had nothing to
 * show for the leg.
 */
export function observedEvidence(step: StepLike): ObservedItem[] {
  const fromDetail = step.detail?.['observed'];
  const fromAgent = (step.agent as { observations?: unknown } | undefined)?.observations;
  const raw: unknown[] = Array.isArray(fromDetail) ? fromDetail : Array.isArray(fromAgent) ? fromAgent : [];
  const out: ObservedItem[] = [];
  for (const entry of raw) {
    const item = observedItemOf(entry);
    if (item !== null) out.push(item);
  }
  return out;
}

/** The slice of an agent action every renderer reads. `observed` is OA-14's optional field. */
export type AgentActionLike = Pick<AgentAction, 'action' | 'selector' | 'value' | 'url'> & { observed?: unknown };

const PASSWORD_SELECTOR = /password|passwd|pwd/i;

/**
 * How one agent turn is shown: what it was aimed at, and a note when the
 * action's meaning is not in its target. Knows the two actions the agent
 * gained in this wave — `save` (a page value into the run's variables for
 * later steps, OA-8) and `signOut` (end the session so the next person can
 * sign in, OA-15) — and treats every other name by the old rule, so an
 * action added later still renders with its selector rather than as `—`.
 * A password-shaped fill shows the value's length, never its characters.
 */
export function describeAgentAction(action: AgentActionLike): { target: string; note: string | null } {
  const selector = action.selector ?? '';
  const value = action.value ?? '';
  const observed = typeof action.observed === 'string' && action.observed !== '' ? action.observed : null;
  switch (action.action) {
    case 'save':
      return {
        target: selector === '' ? (value === '' ? '—' : `{{${value}}}`) : value === '' ? selector : `${selector} → {{${value}}}`,
        note: observed === null ? 'saved a value the page shows for later steps' : `saved ${JSON.stringify(observed)} for later steps`,
      };
    case 'signOut':
      return { target: 'the current session', note: 'signed out so another person can sign in' };
    case 'read':
      return { target: selector === '' ? action.url : selector, note: observed === null ? null : `observed ${JSON.stringify(observed)}` };
    case 'fill':
    case 'type':
    case 'paste':
      return {
        target: selector === '' ? action.url : selector,
        note:
          value === ''
            ? null
            : PASSWORD_SELECTOR.test(selector)
              ? `•••• (${value.length} chars)`
              : `= ${JSON.stringify(value)}`,
      };
    default:
      return {
        target: selector !== '' ? selector : action.url !== '' ? action.url : value !== '' ? value : '—',
        note: observed === null ? null : `observed ${JSON.stringify(observed)}`,
      };
  }
}

/* --------------------------------------------------------------- cases */

/**
 * The sheet-side facts a bundle's provenance may carry once the catalog
 * plane stamps them (CG-04's `sheetCaseId`, the workbook's `sheet` and
 * `category`, CG-09's `recordOnly`). `GenerationProvenance` is engine-owned
 * and gains the fields in the same wave; this reads them structurally so
 * the renderers are right on the day they land and honest until then.
 */
export interface ProvenanceExtras {
  /** The sheet's own spelling of the case id, when the run's id was qualified (`BE:PL_03_01` → `PL_03_01`). */
  sheetCaseId: string | null;
  sheet: string | null;
  category: string | null;
  /** The sheet's recorded result — `passed` / `failed` / `blocked` — or null when it recorded nothing. */
  sheetVerdict: string | null;
  /** Every Expected line was record-only: the case has no oracle and ends in review with its captures. */
  recordOnly: boolean;
}

export function provenanceExtras(bundle: Pick<ProofBundle, 'generatedBy'> | null | undefined): ProvenanceExtras {
  const raw = (bundle?.generatedBy ?? {}) as Record<string, unknown>;
  const str = (key: string): string | null => (typeof raw[key] === 'string' && raw[key] !== '' ? (raw[key] as string) : null);
  return {
    sheetCaseId: str('sheetCaseId'),
    sheet: str('sheet'),
    category: str('category'),
    sheetVerdict: str('knownResult'),
    recordOnly: raw['recordOnly'] === true,
  };
}

/**
 * How a case id is shown: the sheet's own spelling when the run qualified it
 * (two sheets carrying `PL_03_01`, or `TSH_01_01` six times in one), with the
 * qualified id kept beside it so the ledger row and a `--rerun-case` can be
 * matched by eye. Null `qualified` when the two are one and the same.
 */
export function displayCaseId(caseId: string, sheetCaseId: string | null | undefined): { shown: string; qualified: string | null } {
  if (!sheetCaseId || sheetCaseId === caseId) return { shown: caseId, qualified: null };
  return { shown: sheetCaseId, qualified: caseId };
}

/** `EC · Hiring` — the sheet and its category, whichever of the two the row carries. */
export function sheetLabel(extras: Pick<ProvenanceExtras, 'sheet' | 'category'>): string | null {
  const parts = [extras.sheet, extras.category].filter((p): p is string => p !== null);
  return parts.length === 0 ? null : parts.join(' · ');
}

/** The slice of a catalog case `recordOnlyCase` reads — structural, so the CLI's outcome fits too. */
export interface CaseLike {
  verdict: string;
  status?: string | null | undefined;
  reason?: string | null | undefined;
  bundle?: Pick<ProofBundle, 'generatedBy'> | null | undefined;
}

/**
 * A case that ended in `review` because it was WHOLLY record-only (CG-09:
 * the sheet's Expected lines all say "บันทึกค่าที่ระบบแสดงจริง" — record what
 * the system shows; there is no oracle to assert against). Distinct from
 * proved-? (a wording near-miss awaiting a human): that one has a bundle
 * status of `needs-review`, this one has captures and no claim. Read from
 * the provenance stamp first, the outcome's own reason second.
 */
export function recordOnlyCase(c: CaseLike): boolean {
  if (c.verdict !== 'review') return false;
  if (provenanceExtras(c.bundle).recordOnly) return true;
  if (c.status === 'needs-review') return false;
  return /observed only|record(?:ed)?[- ]only|no oracle/i.test(c.reason ?? '');
}

/** One value a record-only case captured, named as the flow saved it. */
export interface Capture {
  name: string;
  value: string;
}

/**
 * The captures a record-only case is judged by: the run's saved variables
 * (`record_<n>` first, the author's naming rail), then the recorded value of
 * every `saveText`/`saveCount` step. These are what a reader compares to the
 * sheet's open question; a review row with no captures listed would be a
 * verdict colour over nothing.
 */
export function recordedCaptures(bundle: Pick<ProofBundle, 'variables' | 'steps'> | null | undefined): Capture[] {
  if (!bundle) return [];
  const out: Capture[] = [];
  const seen = new Set<string>();
  const variables = Object.entries(bundle.variables ?? {});
  const ordered = [...variables.filter(([k]) => /^record[_-]/i.test(k)), ...variables.filter(([k]) => !/^record[_-]/i.test(k))];
  for (const [name, value] of ordered) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, value: String(value) });
  }
  for (const step of bundle.steps ?? []) {
    if (step.superseded || (step.action !== 'saveText' && step.action !== 'saveCount')) continue;
    const name = typeof step.detail?.['as'] === 'string' ? (step.detail['as'] as string) : `step ${step.index}`;
    if (seen.has(name)) continue;
    const value = step.detail?.['actual'] ?? step.detail?.['value'] ?? step.detail?.['saved'];
    if (value === undefined || value === null) continue;
    seen.add(name);
    out.push({ name, value: typeof value === 'string' ? value : JSON.stringify(value) });
  }
  return out;
}

/**
 * The suite-level split every roll-up prints: proved / test-failed / awaiting
 * review / no verdict (the harness alone broke) / never ran. Counted apart
 * on purpose — the first cut of the suite index counted every non-pass as a
 * failure, so a catalog whose harness fell over on twenty rows read as
 * twenty product defects (the false-failure audit in `src/api/CLAUDE.md`).
 */
export interface VerdictCounts {
  passed: number;
  failed: number;
  review: number;
  noVerdict: number;
  blocked: number;
  total: number;
}

export function countVerdicts(cases: readonly { verdict: string; status?: string | null | undefined }[]): VerdictCounts {
  const counts: VerdictCounts = { passed: 0, failed: 0, review: 0, noVerdict: 0, blocked: 0, total: cases.length };
  for (const c of cases) {
    if (c.verdict === 'passed') counts.passed += 1;
    else if (c.verdict === 'review') counts.review += 1;
    else if (c.verdict === 'blocked' || c.verdict === 'never-ran') counts.blocked += 1;
    else if (c.status === 'error') counts.noVerdict += 1;
    else counts.failed += 1;
  }
  return counts;
}

/** `3 of 5 passed · 1 failed · 1 recorded only` — the breakdown after the headline count. */
export function describeVerdictCounts(counts: VerdictCounts, labels: Partial<Record<keyof VerdictCounts, string>> = {}): string {
  const parts = [`${counts.passed} of ${counts.total} passed`];
  if (counts.failed > 0) parts.push(`${counts.failed} ${labels.failed ?? 'failed'}`);
  if (counts.review > 0) parts.push(`${counts.review} ${labels.review ?? 'awaiting review'}`);
  if (counts.noVerdict > 0) parts.push(`${counts.noVerdict} ${labels.noVerdict ?? 'no verdict'}`);
  if (counts.blocked > 0) parts.push(`${counts.blocked} ${labels.blocked ?? 'never ran'}`);
  return parts.join(' · ');
}
