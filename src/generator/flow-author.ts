/**
 * Prompt-driven flow authoring.
 *
 * `TestGenerator` answers "what should this page be tested for" — the model
 * chooses the cases. This module answers a different question: *the author*
 * already knows what they want tested, and describes it in a sentence. The
 * model's only job is to turn that intent into a valid, runnable flow.
 *
 * The difference that matters is **grounding**. A prompt alone can only produce
 * guessed selectors, and a guessed selector is a test that fails on the first
 * run for a reason that has nothing to do with the application. So when a live
 * page is supplied, its accessibility tree is sent along and the model is held
 * to selectors that actually appear in it. Without a page we still emit a flow,
 * but it is explicitly marked ungrounded and its selectors are placeholders to
 * be edited — never something to trust into CI.
 *
 * Routing reuses the existing `generator` role rather than introducing a fourth:
 * this is the same job (write tests) against the same shape of prompt (a page
 * plus instructions), so it wants the same large-context model, and `wowlidator
 * doctor` keeps covering it for free.
 */

import type { LanguageModel } from 'ai';
import { formatElapsed, wrapText } from '../log-format.js';
import { CONSENT_ACCEPT_NAME } from '../engine/consent-gate.js';
import type { Page } from 'playwright';
import { z } from 'zod';

import { lenientObject } from '../providers/model-output.js';
import { parseExpectedCallEntry, type ExpectedCall } from '../api/expect-calls.js';
import { parseDbConditions } from '../db/db-actions.js';
import { BACKEND_TIER_ACTIONS } from '../engine/proof-bundle.js';

import { SELECTOR_SYNTAX_RULES, captureAxTree } from '../healer/jit-healer.js';
import { DETERMINISM_RULES, procedure } from '../providers/prompt-discipline.js';
import { fence, sanitizeInline } from '../providers/model-fence.js';
import { withQualifiedRole, withRelaxedRoleName, withStableGreeting, withLabelForNonAriaRole } from '../engine/selector.js';
import {
  PLACEHOLDER_TOKEN,
  fieldLabelOf,
  formatStatedFor,
  fromDb,
  fromRepo,
  fromTestData,
  expandMasterDataCodes,
  resolveValues,
  unconfirmedFieldIn,
  type TestDataPair,
  type ValueNeed,
  type ValueResolutionContext,
  type ValueResolverModel,
} from './value-resolution.js';
import { fieldNamesIn, hasAssertion, type ConsentPolicy } from '../engine/runner.js';
import { matchesRoutePattern } from '../context/context-engine.js';
import { nearestRoutes, pathnameOf, routeIsDeclared } from '../context/route-match.js';
import { formatProbeReport, probeInteractions } from '../context/page-probe.js';
import { focusTreeText } from '../context/retriever.js';
import {
  LlmFactory,
  generateStructuredForModel,
  type ModelSource,
} from '../providers/llm-factory.js';
import { observationSteps, vacuousClaim } from './vacuous.js';
import { describeUnprovedExclusivity, optionSetsIn, unprovedExclusivity } from './exclusivity.js';
// The words the lints read a row with are DATA (`value-rules.ts`, 2026-09-04):
// every list bilingual, every list replaceable from `.wowlidator/value-rules.json`.
// The lints below key on STRUCTURE — a numbered line, an action kind, a
// selector's role — and read it through these compiled classes.
import { AUTHORING, openQuestionIdsIn,
  DEFAULT_AUTHORING_RULES,
} from './value-rules.js';
// The sheet grammar (CG-15): one regex names every heading `describeCase`
// writes, so the lints that cut the described row — the Steps script, the
// Expected block, the Test data pairs — cut on the same list the parser does.
// The parser imports nothing of the generator, so the dependency runs one way.
import { expectedLines, sectionOf, unconfirmedValue } from '../catalog/test-case-table.js';
import { isFixtureSpec } from '../data/fixtures.js';
import { multiPersonaGoal } from '../orchestrator/agent-guards.js';
import { goalOutcomes } from '../orchestrator/goal-evidence.js';
import type { Flow, FlowStep, StepValueSource } from '../engine/runner.js';
import { ANY_OFFERED } from '../engine/listbox.js';
import { DEFAULT_MUTATION_POLICY, type MutationPolicy } from './test-generator.js';
import type { FlowReviewer, ReviewRecord } from './flow-review.js';

/** Same budget as the generator: the AX tree dominates the prompt either way. */
/**
 * The journey capture's node budget. 200 → 600 (2026-09-07, HIR-EC-001): this
 * is `captureAxTree`'s BLIND cap — the first N nodes in capture order, not
 * `focusTree`'s ranked selection — so on a form whose sections are now
 * expanded before the read (`expandCollapsedSections`), 200 would keep the
 * top of Step 1 and cut every Employment field below it, which is the same
 * blindness one level up. Sized to the hire form's 102 controls plus their
 * labels and structure. The cost lands on ONE call per case, where the node
 * budget that matters for a run's bill is the agent's, paid every turn.
 */
export const DEFAULT_AUTHOR_MAX_NODES = 600;

/**
 * Journey-tree lines kept after ranking against the row's own request —
 * see the narrowing in `author()`. The start tree is never narrowed this way:
 * it is the page the flow's first steps are written against, and on a catalog
 * it is the one section shared across rows.
 *
 * **800, not 80** (2026-09-07). Measured on run 13: the hire form's two pages
 * are 743 nodes and the model was shown 80 of them — 11%. `Event Reason`,
 * `Hire Date`, `Position` and every Employment control fell outside the cut,
 * and the review answered `unsure` four times in a row with the reason
 * printed in its own words: *"the captured hire-page tree is explicitly
 * narrowed (80 of 743 nodes) … there is no evidence to replace it with, only
 * insufficient evidence to confirm it."* A budget that hides the form from
 * the author saves tokens on a flow that cannot be written.
 *
 * The captures it is spent on are each already capped at
 * `DEFAULT_AUTHOR_MAX_NODES`, so this is a ceiling over an evidence set that
 * is bounded anyway — it shows a whole ordinary form and still cuts a
 * pathological page. `WOWLIDATOR_JOURNEY_TREE_MAX_LINES` lowers it for a run
 * that would rather pay less than see more.
 */
export const JOURNEY_TREE_MAX_LINES = 800;

/**
 * The lines of a journey tree that are kept through narrowing whatever they
 * score: the markers that say a page was reached by a click, and so which
 * page the controls under them belong to. See `focusTreeText`'s `alwaysKeep`.
 */
export const STRUCTURAL_EVIDENCE_LINE = /WIZARD ADVANCED BEFORE READING|FORM EXPANDED BEFORE READING/;

/** The journey-tree budget for this process — the constant unless the environment lowers it. */
export function journeyTreeMaxLines(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['WOWLIDATOR_JOURNEY_TREE_MAX_LINES'];
  if (raw === undefined || raw.trim() === '') return JOURNEY_TREE_MAX_LINES;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : JOURNEY_TREE_MAX_LINES;
}

/**
 * Total authoring attempts, including the first. Same shape and same reason
 * as the healer's `HEAL_ATTEMPTS`: the failure that actually happens is a
 * model ignoring one rule of a long prompt, and the one ask that knows what
 * was refused is worth far more than the first.
 *
 * It was two — one informed re-ask — on the argument that a model ignoring
 * explicit named feedback once will ignore it twice. That held while the lint
 * set was small. It stopped holding as the set grew (`countPinnedName`,
 * `interruptedCredentialSubmit`, `unpinnedDateEntry`, `loginProofCannotFail`,
 * plus the CLI's DB-inventory gate): measured, one prompt ended with **no flow
 * at all** in 1 of 2 attempts, refused for "contains no assertion", because
 * removing the model's easiest assertion left it with nothing and there was
 * exactly one ask left to recover in. Three costs one more call on the runs
 * that were going to fail anyway, and is the difference between a weak test
 * and no test on the runs that were not.
 */
export const AUTHOR_ATTEMPTS = 3;

/**
 * How many distinct refusal shapes a suite carries forward into later rows'
 * FIRST attempt.
 *
 * Measured on be100-rip (2026-08-31): the run's refusals were the same two or
 * three families over and over — an `expectDbRows` on the case's own test data,
 * a `workflow` goal naming controls the repository declares. Each cost a full
 * authoring attempt (57 s, ~$0.44 on opus), per row, to teach the model a rule
 * it had already been taught on the row before. The feedback text already
 * exists and already works; it just never leaves the row that earned it.
 *
 * Six, and by frequency rather than recency: a lint that fired twenty times is
 * the one worth pre-empting, and a long list of near-misses would crowd the
 * request itself out of the model's attention — the failure mode this bound
 * exists to prevent.
 */
export const SUITE_REFUSAL_MEMORY = 6;

/**
 * A refusal's SHAPE — the rule it broke, with this row's particulars removed.
 *
 * Two refusals of the same lint differ only in the quoted names, the step
 * index and the numbers, so those are exactly what is stripped. Without this
 * the memory would fill with six variants of one lint and teach nothing.
 * Pure, so `tests/flow-author.test.ts` can pin it without a model.
 */
export function refusalShape(message: string): string {
  return message
    .split('\n')[0]!
    .toLowerCase()
    .replace(/"[^"]*"/g, '""')
    .replace(/\(step \d+\)/g, '(step)')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The shapes of a FATAL refusal's complaints, or null for a weak one. The
 * identical-refusal guard in `FlowAuthor.author` compares two attempts by
 * these: names, indexes and numbers vary between two answers to one question,
 * the rule broken does not.
 */
function fatalShapesOf(error: AuthoringError): Set<string> | null {
  if (error.severity !== 'fatal') return null;
  return new Set(error.messages.map(refusalShape).filter((shape) => shape !== ''));
}

function sameShapes(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size || a.size === 0) return false;
  for (const shape of a) if (!b.has(shape)) return false;
  return true;
}

/**
 * Actions the author may emit.
 *
 * A deliberate subset of `FlowStep`. `fillEach` and `expectTabOrder` are absent
 * because both carry a nested array, and a flat object with every field required
 * is what free-tier models can actually produce reliably (the same reasoning
 * that shapes `GeneratedStepSchema`). Both remain available when hand-writing a
 * flow — see `examples/template.flow.json`.
 */
export const AUTHOR_ACTIONS = [
  'goto',
  'click',
  // Click a control only if it is on the page; otherwise carry on. Narrows to
  // the engine's `when { visible } then [click]`, whose condition is a probe
  // that never heals — so a consent gate, a "remember this device" prompt or
  // a cookie banner that appears on some runs and not others is one authored
  // step rather than a `workflow` leg (a model call per run) or a `click`
  // that fails setup on the runs where the gate does not show.
  'clickIfVisible',
  'fill',
  'selectOption',
  'check',
  'uncheck',
  'type',
  'waitFor',
  'press',
  'workflow',
  'setLocalStorage',
  'clearStorage',
  // End the session through the application's own sign-out control — the
  // persona-switch step. Deterministic engine procedure, no selector needed.
  'signOut',
  // Sign in as a PERSONA LABEL (`HR_ADMIN_ACCOUNT`, `MANAGER_ACCOUNT`), the
  // credentials held by the harness, never typed by the author (CG-05,
  // EH-10, OA-15). A `<X_ACCOUNT>` token in the sheet, "Login ด้วย SPD
  // Admin", "Manager กด Approve" each name one; a hand-off in the numbered
  // steps (PRB-EC: "2. Login ด้วย <MANAGER_ACCOUNT> … 4. Login ด้วย
  // <HRBP_ACCOUNT> แล้วกด Approve") is a signIn as the OTHER persona in the
  // middle of the same case. 271 rows carry tokens, 98 hand off.
  'signIn',
  // Attach a deterministic fixture file — `pdf:medical-certificate`,
  // `csv:benefit-plans@template!blank=Country` — written by
  // `src/data/fixtures.ts` under the run's own folder (CG-19). 95 rows attach,
  // import or upload something; before this every one became an agent leg the
  // agent could not perform either.
  'upload',
  'back',
  'forward',
  'scrollTo',
  'expectScrollable',
  // Read a COUNT of matching elements / an element's TEXT into a named
  // variable (`value` = the name), for a later expectCount/expectText that
  // carries `{{name}}`. This is how "A matches B" is authored as a real
  // check: save the table's count, then expect the tile's text to hold it —
  // and how "no change after the action" is authored: save before, act,
  // expect the same reading after. EN-2 audit: ten missed bugs were
  // reconciliation claims asserted as mere presence.
  'saveCount',
  'saveText',
  // `snapshot` (a visual baseline) is deliberately NOT authorable (2026-09-04):
  // its first run writes the baseline and every later run diffs against it,
  // so a record-only observation turned into a red "changed" step on the
  // second run of the same case (ec09 HIR-EC-009 step 58, record_oq_hir_78,
  // 10% of pixels changed by the data the run itself typed). A state the
  // sheet wants recorded is `saveText` of the region; the film and the
  // per-step screenshot already keep the picture.
  'expectText',
  'expectVisible',
  'expectHidden',
  // Either/or: the Expected line offers alternatives ("ระบบประมวลผลสำเร็จหรือ
  // แสดง error ตามเงื่อนไข ไม่ crash", "กรณีสร้างสำเร็จ … / กรณีปฏิเสธ …")
  // and the flow accepts whichever the page shows (CG-08). 95 rows; before
  // this the author picked one branch and the other branch failed a correct
  // application. Selectors ride ";"-separated in `value`, the expectCalls
  // precedent, one per acceptable outcome.
  'expectAnyVisible',
  // The validation message shown FOR a named field — "ระบบแสดง Error
  // message "…" ด้านล่าง Field X", "error ใต้ช่องนั้นทันทีเมื่อกด Save" —
  // read from the field's own aria-errormessage/describedby/container, so a
  // message under the WRONG field cannot pass a page-wide expectText (EH-12).
  'expectFieldError',
  'expectEnabled',
  'expectDisabled',
  'expectCount',
  'expectUrl',
  'expectValue',
  'expectAttribute',
  'expectFocused',
  // Backend claims. `expectCalls` entries and the DB conditions ride in the
  // existing flat string fields (see the field descriptions) — a nested array
  // here would break the very convention this list's absentees exist for.
  'expectCalls',
  'dbSnapshot',
  'expectDbRow',
  'expectDbDelta',
  'expectDbUnchanged',
  // The deliberate-HTTP family. Without it, an API-level claim (a health
  // endpoint, a seed endpoint, a JSON contract) could only be authored as a
  // goto to the endpoint or as an expectCalls the page never fires — both
  // seen live, both guaranteed-false against a working app.
  'request',
  'expectStatus',
  'expectJson',
  // Narrows to the runner's `expectDbRow` with an exact count and no/partial
  // where — the API-number-vs-database-number cross-check spelled flat.
  'expectDbCount',
  // A pinned clock is what makes "days remaining"-style claims checkable at
  // all; see the vocabulary entry.
  'setClock',
  // Deliberate modal interaction: assert the dialog opened before filling
  // its fields, close it when the journey is done.
  'expectModal',
  'closeModal',
] as const;

export type AuthorAction = (typeof AUTHOR_ACTIONS)[number];

/**
 * Flat on purpose — see the module note in `test-generator.ts`. Every field is
 * required and unused ones come back as empty strings, then get narrowed in
 * `toFlowStep`.
 */
const AuthoredStepFields = {
  action: z.enum(AUTHOR_ACTIONS),
  // The one field a step may decline to fill. It is organisational — it decides
  // how the body is *divided*, not what any step does — so a model that has no
  // case in mind should cost the isolation between cases, never the whole
  // authoring call. No case anywhere means one case, which is exactly what this
  // produced before cases existed.
  //
  // Nullable rather than `.default('')`, and the difference is not stylistic:
  // zod emits a *defaulted* field as absent from `required`, and strict
  // structured-output providers (Groq's `openai/gpt-oss-*`, and OpenAI's own)
  // reject any object schema whose `required` omits a key of `properties` —
  // failing the whole authoring call before the model is ever asked, with an
  // error naming this field. Nullable keeps the key in `required` while still
  // giving the model a way to say "no case". Every other field here keeps the
  // flat empty-string convention; this one cannot, because "" is a legitimate
  // case name to a constrained decoder.
  case: z
    .string()
    .nullable()
    .describe(
      'Short name of the discrete case this step belongs to. Steps that stand or fall together share one name. Null when the whole body is one case.',
    ),
  selector: z.string().describe('Playwright selector. Empty when the action takes none.'),
  value: z
    .string()
    .describe(
      'Text to fill or type, the visible label of the option to select, expected substring, ' +
        'expected count as digits, storage value, or the goal for a workflow step. For ' +
        'expectCalls: the expected entries, ";"-separated, each "METHOD /path" with optional ' +
        '"-> status" and a "never:" prefix for forbidden calls. For expectDbRow: the expected ' +
        'column values as "col = value AND col = value" (may be empty). For expectDbDelta: ' +
        'the signed row-count change as digits. For request: the JSON body, or empty for none. ' +
        'For expectStatus: the expected status as digits. For expectJson: the expected value ' +
        '(empty asserts the path merely exists). For expectDbCount: the exact row count — ' +
        'digits or a saved {{variable}}. For setClock: the ISO date or date-time to pin the ' +
        'page clock to. For expectAnyVisible: two or more selectors, ";"-separated, one per ' +
        'acceptable outcome. For expectFieldError: the exact message the case quotes, or empty ' +
        'for "any error under this field". For upload: the fixture spec kind:name[@template]' +
        '[!mutation] (pdf:medical-certificate, csv:benefit-plans@template!blank=Country). ' +
        'Else empty.',
    ),
  url: z.string().describe('URL or path for goto, or the sign-in page for signIn when the case names one. Else empty.'),
  key: z
    .string()
    .describe(
      'Key name for press, or storage key for setLocalStorage. For DB checks: the WHERE ' +
        'conditions as "col = value AND col = value" (expectDbRow, and optionally ' +
        'expectDbCount), or the snapshot name (dbSnapshot/expectDbDelta/expectDbUnchanged). ' +
        'For request: values to save from the response as "var = $.json.path AND var2 = $.x" ' +
        '(may be empty). For expectJson: the JSON path to read, e.g. "$.counts.persons". ' +
        'Else empty.',
    ),
  name: z
    .string()
    .describe(
      'Snapshot name, attribute name for expectAttribute, or the table name for DB checks ' +
        '(comma-separated tables for dbSnapshot/expectDbUnchanged; single table for ' +
        'expectDbRow/expectDbCount). For request: "METHOD /path", e.g. "POST /api/db/seed". ' +
        'For expectModal: the dialog\'s accessible name, or empty for any. For signIn: the ' +
        'persona LABEL exactly as the PERSONAS section lists it (HR_ADMIN_ACCOUNT). Else empty.',
    ),
  // A declared wait, in milliseconds as digits, for the six steps the engine
  // can wait on (expectText, expectVisible, expectHidden, expectCount,
  // waitFor, expectModal) — "สถานะเปลี่ยนเป็น Complete" after Run Payroll
  // (TC_PY_REC_*: minutes), import progress "100%" / "Status = Completed"
  // (PL_10_24/26/57), a toast that "หายไปอัตโนมัติ 5-6 วินาที" (RU_05_02).
  // EH-07: a declared wait that expires is a verdict about time, never a
  // selector to heal, and the fast ladder cannot await a payroll run.
  // Empty for every other step; capped at MAX_STEP_TIMEOUT_MS on narrowing.
  timeoutMs: z
    .string()
    .describe(
      'For expectText / expectVisible / expectHidden / expectCount / waitFor / expectModal ONLY: ' +
        'how long to keep waiting, in milliseconds as digits (e.g. 300000), when the case says to ' +
        'wait until a status changes, a job completes, progress reaches 100% or a toast disappears. ' +
        'Empty for an ordinary check and for every other action.',
    ),
  intent: z.string().describe('What this step is for, in plain language. Always fill this in.'),
};

/**
 * The longest wait an authored step may declare (EH-07). Ten minutes covers a
 * payroll run and an import of thousands of rows; anything longer is a case
 * the sheet marks "รอวันที่" and the harness refuses before authoring.
 */
export const MAX_STEP_TIMEOUT_MS = 600_000;

/**
 * `case` is required *on the wire* and optional *in what we accept back*, and
 * no single zod field expresses both: `.nullable()` puts the key in `required`
 * but then rejects a payload that omits it, and `.default()`/`.optional()` do
 * the reverse. `lenientObject` is what separates the two — the emitted schema
 * is byte-for-byte the strict one, so strict providers stay satisfied, while a
 * lenient provider that drops the key is read as "no case" instead of failing
 * the call. That degradation is the whole reason this field is not an ordinary
 * required string; see the note on `case` above.
 *
 * This was hand-written here for `case` alone, and it is now the shared rule —
 * because z.ai turned out to drop `selector`, `value` and `url` on exactly the
 * same reasoning, and fixing that one field at a time is how a class of bug
 * gets rediscovered once per field. See `providers/model-output.ts`.
 */
const AuthoredStepSchema = lenientObject(AuthoredStepFields);

/**
 * Exported for the contract test in `tests/flow-author.test.ts`, which asserts
 * the emitted JSON Schema stays acceptable to a strict provider. Same reason
 * `GENERATOR_ACTIONS` is exported from `test-generator.ts`: the invariant is
 * only checkable from outside, and it is the kind that breaks silently.
 */
export const AuthoredFlowSchema = z.object({
  name: z.string().describe('Short, stable name for the flow.'),
  rationale: z.string().describe('One sentence: what this flow proves.'),
  setup: z.array(AuthoredStepSchema).describe('Preconditions. Empty array if none needed.'),
  steps: z.array(AuthoredStepSchema).describe('The test body. Must contain an assertion.'),
  teardown: z.array(AuthoredStepSchema).describe('Cleanup. Empty array if none needed.'),
  notes: z
    .string()
    .describe(
      'Anything the author must check or fill in by hand — a guessed selector, an assumed credential, an ambiguity in the request. Empty if none.',
    ),
});

/** One declared table, formatted for the prompt's inventory section. */
export interface TableInventoryEntry {
  name: string;
  /** `id:uuid pk · status:text · …` — from the schema ingester's meta. */
  summary: string;
}

/**
 * How far the test is meant to reach.
 *
 * `unit` — one page, one thing proved. What authoring has always done, so it
 * stays the default: a default that silently changed what every existing
 * invocation produces would be wrong.
 *
 * `e2e` — the journey. Reach the page the way a user does, act, and verify on
 * the page that results. Asking for this is not a hint: it turns the journey
 * capture on regardless of `--capture-journey` (an end-to-end test whose
 * destination page was never read cannot be grounded — measured, 9 of 9 runs
 * without the journey tree handed the middle to a `workflow` step, 0 of 3
 * with it), and `notEndToEnd` refuses a flow that never leaves its first page.
 * A prompt instruction is a request; those two are the guarantee.
 */
export type TestScope = 'unit' | 'e2e';

export const TEST_SCOPES = ['unit', 'e2e'] as const;

export interface AuthorRequest {
  /** The author's description of the test they want. */
  prompt: string;
  /** URL the AX tree was captured from, when grounded. */
  url?: string | undefined;
  /** Accessibility tree of the live page. Absent means ungrounded. */
  axTree?: string | undefined;
  /**
   * The application's declared database tables, from the indexed schema.
   * Presence is the permission: with no inventory the prompt never mentions
   * DB checks and `toFlowStep` drops any the model emits anyway — the model
   * chooses among declared tables or not at all, the OpenAPI rule pointed at
   * state.
   */
  tables?: readonly TableInventoryEntry[] | undefined;
  /**
   * Whether backend steps may be written at all — see
   * `FlowAuthorOptions.backend`. Absent means yes, which is what every caller
   * meant before the toggle existed.
   */
  backend?: boolean | undefined;
  /**
   * Controls that exist only after an interaction, from `probeInteractions`.
   * Separate from `axTree` on purpose — "behind a menu" is a different claim
   * from "on the page", and a flow that confuses them clicks a menu item
   * without opening the menu.
   */
  interactions?: string | undefined;
  /**
   * The accessibility tree of a page further along the journey, captured
   * because the description named its route — see `--capture-journey`.
   *
   * Its own field, never merged into `axTree`. The tree the flow's selectors
   * are checked against is the page the run STARTS on; this is a different
   * page, and a model that conflates them writes a click for a control that is
   * three navigations away. Same separation as `interactions`, and for a
   * sharper reason: the probe's controls are at least on the current page.
   *
   * It exists because the start page is frequently a login screen, so the
   * journey's real controls were structurally invisible: 9 of 9 measured
   * authoring runs delegated the middle of the test to a `workflow` step, one
   * of them saying so in its own notes.
   */
  journeyTree?: string | undefined;
  /**
   * What the application's repository declares — routes, components, API
   * operations, existing coverage — from a saved repo's indexed graph
   * (`toPromptContext`). Its own labelled section, apart from the tree and the
   * catalog: "declared in the code" is a different claim from "on the page",
   * and the page outranks it wherever they disagree.
   */
  projectContext?: string | undefined;
  /**
   * The account to sign in as, when the person running the command supplied
   * one. Its own labelled section in the prompt, and the only place a password
   * may come from: measured over nine authoring runs, a model with no
   * credentials invented one nine times out of nine, and a flow that cannot
   * sign in proves nothing about anything behind the login.
   */
  credentials?: { email: string; password: string } | undefined;
  /**
   * The personas the run holds credentials for, by LABEL — the sheet's own
   * `<HR_ADMIN_ACCOUNT>` / `<MANAGER_ACCOUNT>` / `<HRBP_ACCOUNT>` tokens and
   * the role words the CLI maps onto them (`SPD Admin` → `SPD_ADMIN`). Its
   * own labelled section in the prompt, listing the label and the email and
   * NEVER the password: with this present every sign-in is a `signIn` step
   * naming the label, and the engine types the secret (CG-05, EH-10). A
   * prompt that carried four passwords for four personas was the model's
   * invitation to type them — and to invent the fifth.
   */
  personas?: Readonly<Record<string, { email: string; password: string }>> | undefined;
  /**
   * How far the test should reach — see `TestScope`. Absent means `unit`,
   * and an absent scope leaves the prompt byte-for-byte what it was before
   * this existed.
   */
  scope?: TestScope | undefined;
  policy?: MutationPolicy | undefined;
  /**
   * Why earlier attempts at this same flow were refused — the validation
   * errors, verbatim. Same seam as `HealRequest.rejected`: a model has no way
   * to know it is repeating a mistake unless the next ask says what the last
   * answer got wrong, and the value of a retry is entirely in that knowledge.
   */
  feedback?: readonly string[] | undefined;
  /**
   * Rules OTHER rows in this suite have already been refused for — see
   * `SUITE_REFUSAL_MEMORY`. Kept apart from `feedback` because the two are
   * different claims and the prompt must not conflate them: `feedback` says
   * "your previous answer to THIS question was wrong", which is a fact; this
   * says "the suite keeps making this mistake", which is a warning about a
   * pattern, and wording it as the former on a first attempt would be a lie
   * the model would then try to fix.
   */
  commonRefusals?: readonly string[] | undefined;
  /**
   * The cases the previous attempt authored, when there were several and the
   * refusal is about (at most) some of them. Rendered with the feedback so
   * the model rewrites ONLY the cases the feedback names and the harness
   * keeps the rest verbatim (`mergePriorCases`). Measured live (ec09, 8
   * claims in one prompt): a refusal on one case cost a 193 s re-emit of all
   * seven, of which six came back unchanged.
   */
  priorCases?: readonly AuthoredCase[] | undefined;
  /**
   * The request is one catalog row, and one row is one case: every Expected
   * line is asserted inside that single case, in the sheet's order, and the
   * body is never partitioned. Set by `FlowAuthor` whenever a row's own text
   * (`caseText`) is supplied. Measured live (ec09 HIR-EC-009): left to
   * itself the model split one row into four cases, each re-running the
   * sign-in and each a browser of its own, and stopped the script at step 8
   * of 9 — the ledger then showed "HIR-EC-009 / 5" for what the sheet calls
   * one test.
   */
  singleCase?: boolean | undefined;
}

/**
 * A discrete case inside an authored body: a run of steps that proves one thing
 * and can be run on its own, from `setup`, without any other case having run.
 *
 * This is what lets one failure be *noted* rather than fatal. A flat step list
 * stops at its first failure — correctly, because everything after it is in an
 * unknown state — so a catalog of six independent claims would report on one and
 * say nothing about five. Split into cases, each is its own run: a failure ends
 * that case and nothing else.
 */
export interface AuthoredCase {
  /** Short name, from the model. Used in the flow name and the report. */
  name: string;
  steps: FlowStep[];
}

export interface AuthorResult {
  name: string;
  rationale: string;
  setup: FlowStep[];
  steps: FlowStep[];
  /**
   * `steps`, partitioned. Always concatenates back to `steps` exactly, so a
   * caller that ignores this sees the flow it always saw. Absent from a stub
   * that predates cases; `FlowAuthor` then treats the body as one case.
   */
  cases?: AuthoredCase[] | undefined;
  teardown: FlowStep[];
  notes: string;
  /**
   * Steps the model emitted that could not be narrowed into a valid `FlowStep`
   * — a `click` with no selector, an `expectCount` whose value was not a number.
   * Reported rather than silently swallowed: a rising count is a prompt problem.
   */
  droppedSteps: number;
  /** Each dropped step with the reason, so the re-ask can say what to fix. */
  dropped?: DroppedStep[] | undefined;
  /**
   * Steps the model wrote in a form the harness could not run, rewritten
   * mechanically into the nearest form it can (`repairAuthoredStep`) and
   * marked `[generated: …]` in their intent. Each entry names the original
   * claim so a reader sees what was substituted.
   */
  substituted?: SubstitutedStep[] | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

export interface DroppedStep {
  action: string;
  reason: string;
  intent: string;
}

/** One step `repairAuthoredStep` rewrote instead of dropping. */
export interface SubstitutedStep {
  /** The action as the model wrote it. */
  action: string;
  /** What the rewrite did, one clause, as the intent's `[generated: …]` marker says it. */
  how: string;
  /** The model's own intent — the original claim, verbatim. */
  intent: string;
}

/** Pluggable backend, so authoring can be tested without a network call. */
export interface FlowAuthorModel {
  readonly id: string;
  author(request: AuthorRequest): Promise<AuthorResult>;
}

const POLICY_RULES: Record<MutationPolicy, string> = {
  'read-only':
    '- Read-only and navigational actions ONLY. Do NOT submit any form, create, update, or delete.',
  forms:
    '- You MAY submit forms with EMPTY or INVALID input to exercise validation.\n' +
    '- Do NOT submit VALID data that would create or modify a record.\n' +
    '- NEVER delete, purchase, or perform a bulk operation.',
  mutations:
    '- You MAY submit valid data to create or update records.\n' +
    '- NEVER purchase or perform a bulk or irreversible operation.\n' +
    '- Deleting is allowed ONLY when the request itself explicitly asks for the deletion ' +
    'AND names how the data comes back (a seed endpoint, a fixture reset). The claims ' +
    'gate approved that request; with no named restoration, do not delete — an ' +
    'irrecoverable delete is an irreversible operation whatever the claim says.',
};

const GROUNDED_RULES = `<grounding>
You have the accessibility tree of the live page.
- Every selector must correspond to a node in a tree you were given. Do not
  invent an id, class or test id the tree does not show.
- The tree describes one page state. For a later page or dialog no tree
  covers, ground each step in what the repository declares (role + declared
  label) when it names the control's rendered string; use a workflow step only
  where neither a tree nor the repository declares the control. Where a tree
  and the repository disagree, the tree wins: it is the live page.
- If the request asks for something no tree contains, emit the steps you can
  support and say in "notes" which part could not be expressed and why.
</grounding>`;

const UNGROUNDED_RULES = `<grounding>
You have not been given a page; you are working from the request alone.
- When the repository declares a control's rendered string, quote it as a real
  selector (role=button[name="Create Plan" i]). Otherwise use readable
  role-based placeholders an author will correct, and list every placeholder
  in "notes" as needing verification.
- Keep the shape right even where details must be guessed: correct actions,
  correct order, a real assertion.
</grounding>`;

/** The scope halves — short on purpose; every word here is paid on every call. */
const UNIT_SCOPE_RULES = `<scope>UNIT — prove one thing on one page. Do not navigate away from
the page you were given and do not sign in unless that page demands it. A
short flow that proves its one claim is the right answer; do not widen it.</scope>`;

const E2E_SCOPE_RULES = `<scope>END-TO-END — carry the whole journey: reach the page the way a user
does, act, and verify on the page that results. The flow must leave the page it
starts on; a flow confined to one page is refused. Write grounded steps against
every tree you were given, including a later page's; keep workflow for a leg no
captured tree covers.</scope>`;

/**
 * The scope block, or nothing at all: callers that pass no scope must get the
 * same prompt they always got (the `projectGraph` contract, applied again).
 */
const scopeRules = (scope: TestScope | undefined): string =>
  scope === undefined ? '' : `${scope === 'e2e' ? E2E_SCOPE_RULES : UNIT_SCOPE_RULES}\n\n`;

/**
 * The system prompt, restructured 2026-09-03 against the Opus 5 prompting
 * guide (platform.claude.com …/prompting-claude-opus-5) and measured before
 * and after on the same three request shapes:
 *
 *   before  54.5k chars (~13.6k est. tokens, 580 lines)
 *   after   28.2k chars (~7.1k est. tokens, 419 lines) — 48% smaller
 *
 * What changed and why, so the next edit does not undo it:
 *
 * - **Each rule is stated once, in the section that applies it.** The old
 *   prompt said the "only means only → count it" rule three times (procedure
 *   8, procedure 21, checklist 3), "perform every scripted step" three times
 *   (4, 7, 19) and the sign-in proof four times. Repetition does not make a
 *   rule stronger on Opus 5; it makes the prompt longer and gives the model
 *   two slightly different wordings to reconcile.
 * - **No shouting.** Whole sentences in capitals read as alarm, and the guide
 *   notes the model follows such emphasis literally, at the expense of the
 *   rules around it. Emphasis is now a short lead phrase, at most.
 * - **XML sections, not prose walls.** Opus 5 keys on tagged structure; the
 *   sections are `<role>`, `<procedure>`, `<claims>`, `<sign_in>`,
 *   `<workflow_goals>`, `<actions>`, `<cases>`, `<language>`, `<grounding>`,
 *   `<scope>`, `<final_check>`.
 * - **The self-check shrank to the refusal triggers.** The guide says Opus 5
 *   verifies its own work and explicit "re-check everything" instructions
 *   cause over-verification. What survives is the six lints that actually
 *   refuse a flow and cost a second 20–100 s generator call (measured on
 *   job-40: three refusals in a row for the same two lints).
 * - **Workflow legs are fewer and fuller.** Measured on HIR-EC-009 (job-3,
 *   2026-09-03): seven single-section goals against one hire wizard cost 763 s
 *   of agent time, each leg a fresh agent re-hunting the same form and told to
 *   "stay on /en/admin/hire" — which the agent read as "do not click Next".
 *   The rule is now one goal per uncaptured stretch, the required fields
 *   spelled out, and a same-page goal ends with the state the page will show,
 *   never with "stay on".
 *
 * Still zero-shot, as `prompt-discipline.ts` explains: a procedure teaches
 * how any answer is built; an example teaches the surface of one.
 */
export const buildSystemPrompt = (
  policy: MutationPolicy,
  grounded: boolean,
  scope: TestScope | undefined,
): string =>
  `<role>
You turn a plain-language test request into one runnable UI test flow.

The author has already decided what to test. Express their intent faithfully as
steps: do not redesign the test, broaden it, or add cases they did not ask for.
If the request is narrow, the flow is narrow. Deliver the whole case, through its
last scripted step; a flow that stops early has tested a form, not the claim.

The evidence you need is in this prompt: the request, its documents, the trees
and the repository excerpts. If a context-search tool is offered, use it at most
twice, only for a route, table or label the evidence does not give; never to
re-read what is already here.
</role>

${DETERMINISM_RULES}

<procedure>
${procedure('How to build the flow', [
  'Every quoted name in the examples below (a menu path, a field, a button, a persona word) is an illustration from some other application: never look for it, never type it — the request, its documents and the trees are the only source of names.',
  'Read the request and note for yourself: the persona; the page or route under test; each claim (one per numbered line of the Expected output, or one per asserting sentence); any date a claim depends on; anything the request says is already true.',
  'Setup: setClock first if a date matters; sign in (see <sign_in>); reach the page under test; assert who is signed in by the name the chrome renders (text=ผู้ดูแลระบบ), never by a time-of-day greeting. Nothing else goes in setup.',
  'Reach the page the way the sheet says. "Menu path: HR > Benefits Admin > Benefit Plans": after sign-in, click each crumb in order as the tree names it; open a collapsed group by its header first. "Destination: <url> (tab "X")": goto the URL, then click role=tab[name="X" i]. Never derive a route from a label and never goto a path the sheet does not state. A route in parentheses ("EC > New Hire (Manual Key-in)") names the page to open; its words are not steps.',
  'Perform the case\'s Steps column as a script, in order, with the Test data\'s own values: กรอก/คีย์/enter → fill, เลือก → selectOption or click, กด/click → click, Submit → the submit control. Asserting that a field exists is not performing the step that fills it. Cite the step in each intent ("Step 5: …"). Skip a step only when it is genuinely impossible here (a value no tree and no document supplies), and then write a step whose intent says "skipped step N: <why>" so the gap is visible.',
  'Cover every claim in ONE answer. A claim you cannot ground is still written, in the nearest form the vocabulary accepts — a cleared textbox is expectValue with an empty value; a closed set is expectCount of the item role the opened list exposes plus each member\'s presence; a value the sheet states is quoted as that value — and when even that is impossible the step\'s intent ends with "not covered: <why>". Never answer with fewer steps because one claim was hard, and never leave a claim out silently: the harness rewrites what it can and marks it [generated: …]; what it cannot, it names in notes.',
  'Test data arrives one pair per line, "[phase] Field = value", already split. Use each pair for the field it names in that phase; never re-split, merge, or borrow a value from another phase. A "ดราฟต์เดิมระบุ X ใช้ Y" line has already been applied; the pair carries Y. A case id in the data ("same test data as E2E-01") is a cross-reference, never a value to type or assert.',
  'A pair listed under "Unconfirmed test data" (a value that starts with "?", an open-question id — the id the sheet writes after its "= ?" —, TBD/TBC, ยังไม่ยืนยัน/รอตาราง…, or an instruction such as "ต้องระบุเป็น A หรือ B ก่อน Execute") has NO value: never type the marker, never choose a value for it yourself, never name that field in a workflow goal, never assert it. Write its scripted step as a step whose intent says "skipped step N: unconfirmed test data — <Field>", and go on with the fields that do have values.',
  'Leave these values exactly as written; the harness resolves them after you and records the provenance: an angle-bracket token (<HR_ADMIN_ACCOUNT>, <NON_EXISTING_EMPLOYEE_ID>) stays in "value" as the token; a date phrase ("Today", "Next day+1", "Hire Date + 119 Day", "วันที่ 25 ของเดือนปัจจุบัน", "Age < 60") stays as the phrase and needs no setClock; an id that is the case id (the case id itself, QA-Delete) is typed as the sheet writes it and the run makes it unique. Resolving any of these yourself loses the provenance.',
  'One case per claim, named by the request\'s own case id verbatim (TC_01_01, API_02_03); several independent claims under one id become " / 1", " / 2" in the order stated. Never invent a case name when the request has an id, and never merge two claims into one case.',
  'For each case: the fewest steps that reach the claim, then the assertion(s) that would fail if the claim were false. Every numbered Expected line (6.1, 6.2, …) gets its own assertion on the very element the line names, with the intent citing the line. The sign-in proof and an expectUrl are preparation, never the claim; a backend check may corroborate a line about an on-screen value, never replace it. See <claims> for how each kind of line is asserted.',
  'Pick the control the label points at, with the role the tree shows. A textbox named by a placeholder ("Select date", "เลือกวันที่", "Search…") is usually a read-only display over the real input: fill the textbox named by the field\'s label instead. A date input takes YYYY-MM-DD (2027-09-01). A dropdown the tree lists as a button (aria-haspopup) is a button: selectOption on role=button[name="Event Reason" i], never role=combobox.',
  'Every selector comes from a tree, in canonical form (see the selector rules). A control in no tree but named by what the repository declares is written deterministically against that string. Only when neither a tree nor the repository declares the control may the leg be a workflow step (see <workflow_goals>): deterministic steps cost nothing; an agent leg costs a model call per turn.',
])}
</procedure>

<claims>
How each kind of Expected line becomes an assertion. Every assertion must be
able to fail: never assert that a selector contains the very text used to find
it, and prefer the observable consequence of an action over the control just
clicked still existing.

- Concrete value stated ("the extension date is 18 Nov 2026", "the tile shows
  1"): assert that value with expectText / expectValue / expectVisible
  text="<value>". A visibility check of the field is the claim going untested.
  Anchor at the node holding the value, or a container the tree shows holding
  both label and value; never at the label alone (expectText text=HIRE DATE =
  "20 Jul 2026" resolves the label's node and fails against a correct page).
- Derived value (due date = hire date + N days, a total, a count an API
  reported): read the operands from the tree or a request, compute the result,
  assert the concrete value.
- Known-fail note: assert the value the claim requires, not the wrong value the
  note reports; the run then reports the documented defect instead of hiding
  it.
- Values are quoted, never invented: from the case's Expected output, Test data
  or Note; then a document section; then what the repository declares, in that
  order. When none holds a value, say so in "notes" and assert the observable
  shape (the named element exists and holds a number).
- "Only / just / exactly / nothing but" (เฉพาะ, แสดงเฉพาะ, แค่, เพียง, เท่านั้น)
  about a set, or an exact count ("dropdown แสดง 3 ค่า"): a claim about the
  whole set, proved by counting it. Open the control once, expectCount on the
  item role the opened list exposes (role=option, role=menuitem …) with "value"
  = the number enumerated, then one expectVisible per listed member, then one
  expectHidden per member named as absent, then press Escape. Do not re-click
  the trigger between checks. Presence and hidden checks alone are refused:
  they pass when a fourth, unlisted item appears. A set marked "examples" is
  proved by its listed members only, no count.
- Two readings agree ("the tile matches the table"), or +1 / -1 / no change
  ("จำนวนเพิ่มขึ้น +1 ใน Total Plans", "ไม่เปลี่ยนแปลง", "Pending 1D → 2D"):
  saveText or saveCount the very box the line names before the action, the
  variable name in "value" (before_total_plans); act; then expectText /
  expectCount the same box with {{before_total_plans+1}}, {{…-1}} or
  {{before_total_plans}}, the arithmetic inside the braces. A number printed in
  the sheet ("75 → 76", "1-15 of 43") is an illustration, never the value.
- Either/or ("A หรือ B", "กรณีสร้างสำเร็จ … / กรณีปฏิเสธ …", "success or a
  validation message"): one expectAnyVisible with one selector per named
  outcome in "value", ";"-separated. Never for a line that states one outcome,
  and never a selector for an outcome the line does not name.
- Wait-until ("สถานะเปลี่ยนเป็น Complete", "100%", "ป็อปอัพปิดลง", "Warning
  หายไปอัตโนมัติ 5-6 วินาที", "ระบบ direct ไปหน้า My Request"): the checking
  step carries "timeoutMs" in digits, as long as the job really takes (a
  payroll run 300000, an import 120000, an auto-dismissing toast 10000), never
  above 600000.
- Error under a field ("Error message "X" ด้านล่าง Field Y", "error ใต้ช่อง",
  "ข้อความที่ช่อง Personal Grade"): expectFieldError with the field's control as
  selector and the quoted message as "value" (empty for "any error here"). A
  page-wide expectText passes when the message sits under the wrong field.
  "ทุกช่องที่ปล่อยว่าง" is one expectFieldError per field, each in its own
  case.
- Open question (an id after the sheet's "= ?", e.g. "= ? OQ-HIR-140"): nobody knows the value yet.
  Never assert the id or invent the answer; assert the fact around it the case
  does state (the field is there, the notice appears, the record was created).
- [RECORD ONLY] line ("ยังไม่มีคำตอบ ให้รันจริงแล้วบันทึกค่า", "ส่งให้ BA/SA", an
  email/SMS oracle the browser cannot see): saveText the element the line
  points at into record_<lineNo> (record_3_2 for line 3.2; when it is a state
  rather than one value, saveText the region that shows it — never a visual
  snapshot), cite the line in the intent, and write no expect* for it. A case
  whose lines are all [RECORD ONLY] is the script plus those observations; its
  verdict is "review", read by a person.
- A record this flow creates is identified by a value this flow typed: put a
  distinctive string in a free-text field and assert that in the list
  afterwards. "A row appeared" and "my row appeared" are different claims.
- A status is asserted in the application's own words, taken from the tree
  ("In review"), never from the state name or the requirement's wording.
- Never pin a live count inside a selector ("Status (3)"); match the stable
  part (role=tab >> text=Status). Never assert a bare number the request does
  not state: a count tile counts today's data. When the count itself is the
  claim and tables are declared, expectDbCount.
- A date typed into a form needs setClock in setup: date fields are gated on a
  window computed from today, and an unpinned flow rots when the window moves.
- Claim the database only when the evidence shows the page reaching a backend.
  Otherwise prove persistence the way the application does: repeat the
  navigation and check the record is still there.
- If the journey creates something the application keeps, start from a known
  state: clearStorage after the first goto, then goto again.
- A precondition no browser step can produce (a stopped database, a redeploy,
  direct SQL) is disclosed in "notes" and in the first affected step's intent,
  never authored as assertions that fail against a healthy environment. Never
  follow such a disclosure with an assertion only the undisclosed action could
  make true, and never use a spare request step as a comment carrier.
- Asserting a raw token must not appear: text="extended" (quoted, exact) for
  a literal key or code; unquoted text=extended is a substring match that fires
  on the page's legitimate "Extended" label.
</claims>

<sign_in>
Personas section present: every sign-in, the first in setup and every hand-off
after it, is one signIn step with the persona label in "name" (signIn, name:
HR_ADMIN_ACCOUNT). The harness gives each person a browser of their own,
opens the sign-in page there, types the credentials it holds and proves the
login; a signIn naming a persona who already signed in earlier in this case
returns to that person's own browser with their session intact — no sign-out,
no second login. Do not goto the login page, fill an email or password,
signOut by hand, or assert the login yourself. "Login ด้วย <HR_ADMIN_ACCOUNT>", "Manager กด Approve", "HRBP Approve",
"หัวหน้าอนุมัติ", "Login web <app>" (the employee) each name a persona. A hand-off
mid-script ("2. Login ด้วย <MANAGER_ACCOUNT> … 4. Login ด้วย <HRBP_ACCOUNT>") is a
second signIn in the same case followed by that persona's own steps; never one
workflow goal naming two people. A persona the section does not list cannot be
signed in as: say so in "notes" and the first affected step's intent.

No personas section: sign in explicitly and completely.
1. goto the sign-in page.
2. Fill every field the form has, adjacent to each other. A password field
   usually has no accessible name: the nameless textbox beside the identity
   field is it, addressed as input[type="password"]. Two-step sign-in (identity
   field and Next, no password field in the tree): fill identity → click Next →
   fill input[type="password"] → click Sign in; the password field is absent
   from the tree because it does not exist yet, which is not a reason for a
   workflow step. If the identity field shows a value, fill it anyway.
3. Click the submit control, immediately after the fills: nothing between the
   credential fields and the click, because the engine recovers a submit that
   landed before hydration by replaying that block, and only recognises it
   when adjacent. If a consent / terms / PDPA gate can appear, the next step is
   clickIfVisible on its accept control (name exactly as given), never click
   and never workflow.
4. Then prove the login: expectHidden of the submit control you clicked
   (role=button[name="Sign in" i]). Use expectUrl only with a path the evidence
   states outright (a SIGN-IN LANDING line or a url= in a tree), never one
   inferred from a route name or persona.
5. goto the page under test and assert who is signed in with the display name,
   role label or user id the chrome renders, quoted from a tree. Never assert
   that a credential the flow typed is displayed. When no tree shows the
   signed-in chrome, the expectHidden proof already carries the sign-in.

Credentials, in order: the request's own "Login / persona" line, verbatim;
otherwise the SIGN IN AS section, exactly as given; otherwise an obvious
placeholder, with "notes" saying the credentials are a guess. Never invent a
password when a source gives one.

Personas and cases: cases about different personas are separate cases, each
signing in in its own body; setup then holds only setClock and the first goto,
because setup runs again before every case. Switching persona inside one flow:
one signIn step naming the next label — never a signOut before it (each persona
keeps their own browser and session; the employee may return after the manager
approves and find their page as they left it), never fill a login form while
signed in, and never substitute clearStorage for a sign-out (a cookie session
survives it). A flow that switches personas is end-to-end whatever scope was
asked for.
</sign_in>

<workflow_goals>
A workflow step hands the browser to a navigation agent. Use it only for a leg
whose controls appear in no tree and are not declared by the repository; never
for signing in when a tree shows the form, for a consent gate (clickIfVisible),
for making an assertion true, or for anything a captured tree contains. When a
section headed ANOTHER PAGE IN THIS JOURNEY is present, that page is captured:
write grounded steps against it.

Write one goal per uncaptured stretch of the journey, not one per form section:
each leg is a fresh agent with no memory of the last, and seven legs against one
form re-hunt it seven times. A goal must:
- name every field and value it is to set, verbatim from the request, and say
  "fill this step's required fields, then click Next" when the form is a wizard;
- when the leg ends on a different page, end with the URL path the page will be
  on ("… and end on /orders/pending"), which proves arrival the moment it
  happens;
- when the leg stays on the page, end with the state the page will show ("… so
  that Status reads Inactive"), never with "stay on /path": the agent
  reads that as "do not click Next" and stalls on the wrong wizard step.
Then settle the claim with evidence independent of the agent: page content
read afterwards, a request assertion, or a DB check. An assertion the agent
made true proves nothing; an agent-driven edit proven by the database row is
evidence like any other. A flow that hands a leg to the agent and then checks
nothing is refused.
</workflow_goals>

<actions>
A flow has three parts: setup (preconditions; a failure aborts the flow),
steps (the body), teardown (always runs). Leave unused fields as empty strings,
and always write "intent": it is what lets a broken selector be repaired.

Navigation and input
- goto            URL or path in "url".
- click           press a control.
- clickIfVisible  press a control only if present right now, and carry on
                  either way. For an interstitial that appears on some runs
                  (consent page, cookie banner). Never for a control the
                  journey depends on.
- fill            type into a field; text in "value".
- type            key-by-key with real keyboard events, only for fields that
                  react per keystroke (autocomplete, masked input).
- selectOption    pick a dropdown option: the option's visible label in
                  "value", the control in "selector" (native select or custom
                  widget alike; role=combobox / role=button by the tree, never
                  DOM internals like option:checked).
- check / uncheck tick or untick a checkbox, radio or toggle when the resulting
                  state is the point.
- press           key name in "key" (Enter, Escape, Tab); optional "selector"
                  focuses first.
- waitFor         wait for an element to be visible.
- scrollTo        scroll a control into view.
- back / forward  history.
- upload          "selector" is the file input, dropzone or opener ("Attach",
                  "แนบเอกสาร", "Browse"); "value" is a fixture spec the harness
                  writes: kind:name (pdf:medical-certificate,
                  csv:benefit-plans, xlsx:employees, txt:note), "@template"
                  for the case's header, "!mutation" for one named defect in a
                  negative case (!blank=Country, !bad-enum=Status,
                  !bad-date=Effective Start Date, !extra-column, !rows=5000,
                  !encoding=tis-620, !delimiter=;, !no-header, !empty,
                  !too-long=Plan Name, !duplicate).
- workflow        goal in "value"; see <workflow_goals>.

Session
- signIn          persona label in "name"; optional sign-in URL in "url". No
                  selector, no email, no password.
- signOut         the application's own sign-out control; no selector. Only
                  when the case itself says to sign out — a persona switch is
                  a signIn alone.
- setLocalStorage "key" and "value"; must follow a goto (origin-scoped). If
                  the key signs the user in, follow it with another goto: an
                  application reads its session once, at load.
- clearStorage    must follow a goto. Not opening hygiene: a fresh page holds
                  nothing.
- setClock        pin the page clock to "value" (ISO date or date-time), in
                  setup before the first goto, for any claim that depends on
                  what day it is.

Assertions ("timeoutMs" accepted on expectText, expectVisible, expectHidden,
expectCount, waitFor and expectModal)
- expectText      element text contains "value".
- expectVisible / expectHidden
- expectAnyVisible  any of the ";"-separated selectors in "value" is visible.
- expectFieldError  the validation message shown for the field in "selector"
                  equals "value", or with empty "value" that some error is
                  shown there.
- expectEnabled / expectDisabled
- expectCount     exactly "value" matches: digits or a {{variable}}.
- expectUrl       URL contains "value"; take the path from a url= in the tree,
                  never from a link's label.
- expectValue     input value equals "value"; an EMPTY "value" asserts the
                  field is empty (cleared). Only for a control that holds a
                  value (textbox, combobox, spinbutton); a dropdown the tree
                  lists as a button holds none — assert the text its trigger
                  shows, or expectHidden of the choice that was cleared.
- expectAttribute attribute "name" equals "value".
- expectFocused
- expectScrollable  the page or the container in "selector" really scrolls.
- expectModal     a dialog is open (name in "name", or empty). Assert it
                  before filling fields inside a dialog; fields of a dialog
                  that has not opened resolve nowhere.
- closeModal      optional close-button selector.

Reading values
- saveCount       how many elements match, into the variable named in "value".
- saveText        the element's text, into the variable named in "value".
  Later steps use {{name}} anywhere a value goes.

HTTP and database
- request         "name" is "METHOD /path"; optional JSON body in "value";
                  saves in "key" as "var = $.json.path AND v2 = $.x". Use it
                  for any endpoint the claim says to call (health checks,
                  seeds, contracts). Never goto an API endpoint.
- expectStatus    the last request's status equals "value".
- expectJson      the last request's body at the path in "key" equals
                  "value"; empty "value" asserts the path exists.
- expectCalls     traffic the page itself makes: ";"-separated "METHOD /path"
                  entries in "value" (templates like /api/orders/:id, optional
                  "-> 201", "never:" prefix). Only when the request claims
                  specific traffic (a sequence diagram); place it after the
                  action said to provoke the calls. A call nothing on the page
                  makes can never be observed.
- dbSnapshot      row counts of the tables in "name" (comma-separated) under
                  the snapshot name in "key" (default "before"); in setup.
- expectDbRow     table in "name", WHERE in "key" ("col = value AND …"),
                  optional expected columns in "value"; key on a {{variable}}
                  a request saved so the row is tied to this run.
- expectDbDelta   count changed by exactly "value" (signed) since "key".
- expectDbUnchanged  counts did not move for the tables in "name".
- expectDbCount   exactly "value" rows (digits or {{variable}}); optional
                  WHERE in "key".
  Database checks are allowed only when the request lists declared tables,
  and only against those tables.
</actions>

<cases>
Group the body with "case": one thing proved, the steps that reach it and the
assertion that settles it, under the request's case id. Every case runs on its
own, so a case never depends on an earlier case; whatever they all need goes in
setup, which runs again before each one. Every case contains an assertion of
its own; steps that only prepare the next case belong to that case. Set "case"
to null on setup and teardown steps, and on every body step when the whole body
is one case. The body must contain at least one expect* step: a flow that only
clicks passes whether or not the feature works, and displaces the manual check
that would have caught the bug.
</cases>

<policy>
${POLICY_RULES[policy]}
</policy>

${grounded ? GROUNDED_RULES : UNGROUNDED_RULES}

${scopeRules(scope)}<language>
The application may render in a different language or script than the request
quotes. Unless the claim is about language or locale: prefer language-neutral
anchors (ids, codes, numbers, hrefs); quote user-facing text as the tree
renders it, never as the request words it ("สมชาย สุขใจ" on the page is not
"Somchai Sukjai"); when the request insists on wording the tree does not show,
assert the neutral anchor and note the discrepancy.
</language>

${SELECTOR_SYNTAX_RULES}

<final_check>
These are the checks that refuse a flow and cost a second authoring call; make
the flow satisfy them rather than explain a miss:
- Every scripted step is performed through the last one, with the Test data's
  values; a skipped step has an intent saying "skipped step N: <why>".
- Every Expected line has its own assertion on the element it names, one that
  would fail if the claim were false; an "only" or exact-count line has an
  expectCount; a [RECORD ONLY] line has a saveText and no expect*.
- expectAnyVisible only where the line names alternatives.
- Every workflow step is followed by evidence independent of the agent.
- With a personas section, every sign-in is a signIn by label and no step fills
  an email or password; without one, nothing sits between the credential fills
  and the submit click, and the login proof follows the click.
- Every selector token appears in a tree in canonical form; every expectUrl
  fragment appears in a tree's url=, one of this flow's gotos, or the request.
</final_check>

<tone_preference>
Keep "notes", "rationale" and each "intent" to one or two sentences.
</tone_preference>`;


export function buildUserPrompt(request: AuthorRequest): string {
  // FENCED at assembly (`src/providers/model-fence.ts`). Everything the model
  // is shown here is third-party — a workbook row, an accessibility tree, a
  // static index of somebody's repository — and this is the prompt that WRITES
  // the tests, so a forged instruction inside a sheet cell would be obeyed
  // most cheaply of all. Two things deliberately stay outside the fence: the
  // supplied credentials and the persona lines below, whose whole contract is
  // "use these characters exactly", and the request objects the harness itself
  // composed. And nothing here mutates a source: the trees, the case text and
  // the resolved values keep their own bytes everywhere else in this file.
  const lines = ['Test request:', fence('catalog', request.prompt)];
  if (request.url) lines.push(`Page URL: ${sanitizeInline(request.url)}`);
  // One line, next to the request it qualifies. The rules for each scope are
  // in the system prompt; this is only which of them applies to THIS test.
  if (request.scope) {
    lines.push(
      request.scope === 'e2e'
        ? 'Test scope: END-TO-END — the whole journey, and it must leave the page it starts on.'
        : 'Test scope: UNIT — one thing, on this page only.',
    );
  }
  // The toggle, stated before the tables it overrides. A person who turned
  // the backend off gets visual proof with a note, not a wall of blocked
  // cases — and the note is the point: it says a stronger proof exists and
  // this run did not take it.
  if (request.backend === false) {
    lines.push(
      '',
      'BACKEND TESTING IS OFF for this run. Write NO request, expectStatus, expectJson, ' +
        'expectHeader, expectCalls, dbSnapshot or expectDb* step — every one of them will be ' +
        'dropped. Prove each claim through the PAGE: read the number the screen shows, assert the ' +
        'row the table renders, check the message the form displays. When a claim would be proved ' +
        'better against HTTP or the database (a count that must match the database, a status a ' +
        'request returns), still prove it visually AND say so in that step\'s "intent", beginning ' +
        'with "backend could prove this: " and naming what would be checked. Never skip the claim, ' +
        'and never pretend the visual check is the stronger one.',
    );
  }
  // Its own labelled section, apart from the tree — "declared in the schema"
  // and "on the page" are different claims, the probe-report separation.
  if (request.tables?.length) {
    lines.push(
      '',
      'DECLARED DATABASE TABLES (from the indexed schema — DB checks may use these and no others):',
      ...request.tables.map((table) => `  ${sanitizeInline(table.name)} (${sanitizeInline(table.summary)})`),
    );
  }
  // Also its own labelled section, and the caveat is part of the label: a
  // static index can lag the deployed page, and a model that trusts it over
  // the tree writes selectors for code that has not shipped.
  if (request.projectContext) {
    lines.push(
      '',
      'WHAT THE REPOSITORY DECLARES (a static index of the application code — routes, endpoints, coverage. It may lag the live page; where they disagree, the accessibility tree wins):',
      fence('repository', request.projectContext),
    );
  }
  // Its own labelled section for the same reason as the two above: what the
  // person supplied is a different kind of claim from what the page shows, and
  // this one is the only fact in the prompt the model is forbidden to improve on.
  if (request.credentials) {
    lines.push(
      '',
      'SIGN IN AS (supplied by the person running this — use these characters exactly, ' +
        'never a variation and never an invention):',
      `  email: ${request.credentials.email}`,
      `  password: ${request.credentials.password}`,
    );
  }
  // The personas, by label and email only — the password never leaves the
  // harness (CG-05). Its own section for the same reason SIGN IN AS is: what
  // the run holds is a different kind of fact from what the sheet says, and
  // a label the model must copy verbatim is not something to improve on.
  const personaLabels = Object.keys(request.personas ?? {});
  if (personaLabels.length > 0) {
    lines.push(
      '',
      'PERSONAS (the harness holds the password for each — sign in with a signIn step naming ' +
        'the LABEL exactly; never type these credentials, never invent an account):',
      ...personaLabels.map((label) => `  ${label}: ${request.personas![label]!.email}`),
    );
  }
  if (request.singleCase) {
    lines.push(
      '',
      'THIS ROW IS ONE CASE. Write the whole body as a single case — set "case" to null on ' +
        'every step, never partition it — that performs EVERY numbered step of the script in ' +
        'order, through the last one, and then asserts EVERY line of the Expected output in the ' +
        'sheet\'s order, each with its own expect* step citing the line. One sign-in, one journey, ' +
        'one verdict: the sheet counts this row as one test, and so does the report.',
    );
  }
  if (request.axTree) lines.push('', 'Accessibility tree:', fence('page', request.axTree));
  if (request.interactions) lines.push('', fence('page', request.interactions));
  // Last, and under a label that says which page it is. The order matters as
  // much as the label: the start page's tree is what the flow's early steps
  // are written against, and burying it under a second tree invites the model
  // to write step 1 for a page it has not navigated to yet.
  if (request.journeyTree) lines.push('', fence('page', request.journeyTree));
  // Refusal feedback goes LAST, after every byte the retry shares with the
  // first attempt: the trees and context above are then an identical prefix
  // across all three authoring attempts, which is what lets a provider's
  // implicit prompt cache bill the resent capture at cache rates instead of
  // full price. Recency also puts the correction where the model weighs it most.
  // Before the row's own feedback and after every shared byte, for the same
  // caching reason — and because a correction about THIS flow should be the
  // last thing read.
  if (request.commonRefusals?.length) {
    lines.push(
      '',
      'MISTAKES ALREADY REFUSED ON OTHER ROWS OF THIS SUITE. They are not about this flow — ' +
        'they are the rules this catalog keeps breaking. Do not make them here:',
      ...request.commonRefusals.map((entry) => `  - ${sanitizeInline(entry)}`),
    );
  }
  if (request.feedback?.length) {
    lines.push(
      '',
      'Your previous attempt at this flow was REFUSED. Fix exactly this — do not repeat it:',
      ...request.feedback.map((entry) => `  - ${sanitizeInline(entry)}`),
    );
  }
  if (request.feedback?.length && request.priorCases?.length) {
    lines.push(
      '',
      'THE CASES OF YOUR PREVIOUS ATTEMPT, as the harness kept them. The harness keeps every ' +
        'one of them VERBATIM unless you return a case with the SAME "case" name — return ONLY ' +
        'the cases the refusal above requires changing, each under its previous name, and do ' +
        'not re-emit a case the refusal does not concern. A refusal about setup or the whole ' +
        'flow means every case is returned. Names, then the steps of each:',
      ...request.priorCases.map(
        (one) => `  - ${JSON.stringify(one.name)}: ${JSON.stringify(one.steps)}`,
      ),
    );
  }
  return lines.join('\n');
}

export interface LlmFlowAuthorModelOptions {
  /** A concrete AI SDK model. Omit to resolve the `generator` role from config. */
  model?: LanguageModel | undefined;
  id?: string | undefined;
  maxOutputTokens?: number | undefined;
  maxRetries?: number | undefined;
  factory?: LlmFactory | undefined;
}

/**
 * The only place this module constructs a `LanguageModel`. Everything else
 * depends on the `FlowAuthorModel` interface, which is what keeps the tests
 * offline and the provider swappable from config.
 */
export class LlmFlowAuthorModel implements FlowAuthorModel {
  readonly id: string;

  readonly #source: ModelSource;
  readonly #maxOutputTokens: number;
  readonly #maxRetries: number;

  constructor(options: LlmFlowAuthorModelOptions = {}) {
    if (options.model) {
      this.#source = { model: options.model };
      this.id = options.id ?? 'custom:author';
      this.#maxRetries = options.maxRetries ?? 2;
    } else {
      const factory = options.factory ?? new LlmFactory();
      this.#source = { factory, role: 'generator' };
      this.id = options.id ?? factory.forRole('generator').id;
      this.#maxRetries = options.maxRetries ?? factory.maxRetries;
    }
    // 16k, not 8k: measured on the live catalog every authoring call of any
    // size was cut at 8k+cap and re-asked at double — the re-ask always
    // succeeded, and always cost a second call. A budget is billed only as
    // far as it is used, so the larger one is the cheaper one.
    this.#maxOutputTokens = options.maxOutputTokens ?? 16_384;
  }

  async author(request: AuthorRequest): Promise<AuthorResult> {
    const { object, inputTokens, outputTokens } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      schema: AuthoredFlowSchema,
      system: buildSystemPrompt(
        request.policy ?? DEFAULT_MUTATION_POLICY,
        request.axTree !== undefined,
        request.scope,
      ),
      prompt: buildUserPrompt(request),
      maxOutputTokens: this.#maxOutputTokens,
      maxRetries: this.#maxRetries,
    });

    let dropped = 0;
    const droppedDetail: DroppedStep[] = [];
    const substituted: SubstitutedStep[] = [];
    // What a mechanical rewrite may read: every tree the model was given, the
    // probe report, and the case's Test data pairs as `describeCase` rendered
    // them in the prompt (`testDataPairsOfCaseText`).
    const repairEvidence = {
      trees: [request.axTree, request.journeyTree, request.interactions].filter((t): t is string => typeof t === 'string' && t !== '').join('\n'),
      testData: testDataPairsOfCaseText(request.prompt),
    };
    // Backend off (the run's own toggle) removes the whole family, DB
    // checks included: the person said this run does not test the backend,
    // and an indexed schema is permission, not an instruction.
    const allowBackend = request.backend ?? true;
    const allowDb = allowBackend && (request.tables?.length ?? 0) > 0;
    const policy = request.policy ?? DEFAULT_MUTATION_POLICY;
    // Narrow and keep each surviving step next to the case it was labelled with:
    // `toFlowStep` returns the runner's own union, which has no room for a label
    // that means nothing at execution time. A step that does not narrow is
    // kept as a REASON — measured on be100, the dropped steps were the whole
    // middle of the test, and a count alone told nobody what to fix.
    const narrow = (steps: z.infer<typeof AuthoredStepSchema>[]): LabelledStep[] => {
      const kept: LabelledStep[] = [];
      for (const raw of steps) {
        const step = allowBackend || !BACKEND_TIER_ACTIONS.has(raw.action)
          ? toFlowStep(raw, allowDb, policy)
          : null;
        if (step === null) {
          const reason =
            !allowBackend && BACKEND_TIER_ACTIONS.has(raw.action)
              ? BACKEND_OFF_REASON
              : dropReasonFor(raw, allowDb, policy);
          // The nearest runnable form first (`repairAuthoredStep`); only a
          // step with nothing to rewrite from is dropped.
          const repaired = allowBackend || !BACKEND_TIER_ACTIONS.has(raw.action) ? repairAuthoredStep(raw, reason, repairEvidence) : null;
          const fixed = repaired === null ? null : toFlowStep(repaired.step, allowDb, policy);
          if (repaired !== null && fixed !== null) {
            (fixed as { intent?: string | undefined }).intent = markGenerated(raw.intent, repaired.how);
            if (repaired.valueSource !== undefined) (fixed as { valueSource?: StepValueSource }).valueSource = repaired.valueSource;
            substituted.push({ action: raw.action, how: repaired.how, intent: raw.intent });
            kept.push({ step: fixed, label: (raw.case ?? '').trim() });
            continue;
          }
          dropped += 1;
          droppedDetail.push({ action: raw.action, reason, intent: raw.intent });
          continue;
        }
        kept.push({ step, label: (raw.case ?? '').trim() });
      }
      return kept;
    };

    const body = narrow(object.steps);

    return {
      name: object.name,
      rationale: object.rationale,
      setup: narrow(object.setup).map(({ step }) => step),
      steps: body.map(({ step }) => step),
      cases: splitIntoCases(body, object.name),
      teardown: narrow(object.teardown).map(({ step }) => step),
      notes: object.notes,
      droppedSteps: dropped,
      dropped: droppedDetail,
      ...(substituted.length === 0 ? {} : { substituted }),
      inputTokens,
      outputTokens,
    };
  }
}

interface LabelledStep {
  step: FlowStep;
  /** The model's `case` value, trimmed. Empty means it named no case. */
  label: string;
}

/**
 * Partition an authored body into discrete cases.
 *
 * Two rules, and both are about not producing a case that lies:
 *
 * - **Consecutive steps with the same label are one case, and order is never
 *   changed.** Re-ordering to gather a label that appears twice would move steps
 *   past ones they depend on; two runs of the same name are two cases and get
 *   told apart by `uniqueNames`.
 * - **A case with no assertion is not a case.** It is preparation for the case
 *   that follows (or, at the end of the body, cleanup for the one before), so it
 *   is folded into that neighbour rather than run on its own — a case that
 *   asserts nothing passes whether or not the feature works, which is the exact
 *   false-confidence `hasAssertion` exists to stop.
 *
 * The concatenation of the returned cases always equals the input, so nothing is
 * dropped or duplicated by grouping.
 */
/**
 * Fold the cases a re-ask did NOT return back in from the previous attempt.
 *
 * The retry prompt asks for the refused cases only, each under its previous
 * name; every prior case with no returned case of that name is kept verbatim,
 * in its original position, and `steps` is rebuilt as the concatenation so the
 * `cases`/`steps` invariant holds. A returned case whose name matches nothing
 * prior is new and appended. Mutates `result`; the counts are for the log.
 */
export function mergePriorCases(
  result: AuthorResult,
  prior: readonly AuthoredCase[],
): { kept: number; rewritten: number } {
  const key = (name: string): string => name.trim().toLowerCase();
  const returned = new Map<string, AuthoredCase>();
  for (const one of result.cases ?? []) if (!returned.has(key(one.name))) returned.set(key(one.name), one);
  // Nothing returned at all is a failed answer, not "every case is fine".
  if (returned.size === 0) return { kept: 0, rewritten: 0 };
  const merged: AuthoredCase[] = [];
  let kept = 0;
  for (const one of prior) {
    const fresh = returned.get(key(one.name));
    if (fresh !== undefined) {
      merged.push(fresh);
      returned.delete(key(one.name));
    } else {
      merged.push({ name: one.name, steps: [...one.steps] });
      kept += 1;
    }
  }
  for (const one of returned.values()) merged.push(one);
  if (kept === 0) return { kept: 0, rewritten: merged.length };
  result.cases = merged;
  result.steps = merged.flatMap((one) => one.steps);
  return { kept, rewritten: merged.length - kept };
}

function splitIntoCases(body: readonly LabelledStep[], flowName: string): AuthoredCase[] {
  if (body.length === 0) return [];

  const runs: AuthoredCase[] = [];
  for (const { step, label } of body) {
    const current = runs[runs.length - 1];
    if (current !== undefined && current.name === label) current.steps.push(step);
    else runs.push({ name: label, steps: [step] });
  }

  // Fold every assertion-free run into a neighbour: forward by preference, since
  // a preamble belongs to what it prepares; backward for a trailing one, which
  // has nothing left to prepare.
  const merged: AuthoredCase[] = [];
  let pending: FlowStep[] = [];
  for (const run of runs) {
    if (!hasAssertion(run.steps)) {
      pending.push(...run.steps);
      continue;
    }
    merged.push({ name: run.name, steps: [...pending, ...run.steps] });
    pending = [];
  }
  if (pending.length > 0) {
    const last = merged[merged.length - 1];
    // No case asserted anything at all: hand the body back as one unnamed case
    // and let `FlowAuthor` refuse it, rather than inventing a case here.
    if (last === undefined) return [{ name: '', steps: [...pending] }];
    last.steps.push(...pending);
  }

  // An unlabelled single case takes the flow's own name; several unlabelled ones
  // would be indistinguishable in a report, so they are numbered.
  return uniqueNames(merged, flowName);
}

function uniqueNames(cases: AuthoredCase[], flowName: string): AuthoredCase[] {
  if (cases.length === 1) return [{ ...cases[0]!, name: cases[0]!.name || flowName }];
  const seen = new Map<string, number>();
  return cases.map((one, index) => {
    const base = one.name || `case ${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { ...one, name: count === 1 ? base : `${base} (${count})` };
  });
}

/**
 * HTTP verbs an authored `request` may carry, by policy tier — the same
 * filter-not-sentence guarantee `ApiTestGenerator` applies to its operation
 * inventory, applied to the one authored action that reaches a server
 * directly. DELETE appears at no tier, ever.
 */
const REQUEST_VERBS_BY_POLICY: Record<MutationPolicy, readonly string[]> = {
  'read-only': ['GET', 'HEAD'],
  forms: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH'],
  mutations: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH'],
};

/**
 * Narrow the flat authored shape back into the runner's step union.
 *
 * `allowDb` is the structural half of the DB permission: with no table
 * inventory in the request, a DB step the model emitted anyway narrows to
 * null — a prompt instruction is a request, a filter is a guarantee. The
 * `policy` gates authored `request` verbs the same way.
 */
/**
 * Rewrite a selector written in the AX TREE'S OWN notation into real selector
 * syntax.
 *
 * A model that reads the tree sometimes answers in the tree's vocabulary
 * (glm-4.5-flash, live, all three shapes in one catalog run):
 *
 * - `StaticText[text="20 Jul 2026"]` — CSS for a tag named StaticText;
 *   matches nothing, ever. The meaning is the text engine: `text="…"`.
 * - `role=cell[text="…"]` — the role engine has no `text` attribute and
 *   throws. A node's accessible name IS its text for these roles: `[name=]`.
 * - `role=link[url*="/en/…"]` — the tree prints `url=` on links; the role
 *   engine has no such attribute. A link's URL is its href: `a[href*="…"]`.
 *
 * Each rewrite is meaning-preserving and deterministic — the same $0 repair
 * `qualifyBareRole` makes for a dropped `role=` prefix, applied to the other
 * direction of the same confusion. Anything not matching these exact shapes
 * is returned untouched.
 */
export function fromTreeNotation(selector: string): string {
  const trimmed = selector.trim();
  // A chained tail (` >> nth=0`) rides along unchanged — seen live on the
  // very next run after the unchained form was handled: the $-anchored match
  // let `role=link[text="Review"] >> nth=0` through to Playwright verbatim.
  const chain = /\s*>>.*$/.exec(trimmed);
  const head = chain === null ? trimmed : trimmed.slice(0, chain.index);
  const tail = chain === null ? '' : trimmed.slice(chain.index);
  // Either quote style: a smaller model writes `[text='HR']` as readily as
  // `[text="HR"]`, and the single-quoted spelling sailed past every rewrite
  // here — seen live 2026-08-21, a whole catalog of `StaticText[text='…']`,
  // `heading[title='…']` and `textbox[placeholder='…']`, each one a guaranteed
  // miss that cost the full ladder and a healer call on a single-lane server.
  const Q = `(?:"([^"]+)"|'([^']+)')`;
  const pick = (m: RegExpExecArray, i: number): string => m[i] ?? m[i + 1] ?? '';
  const rewritten = ((): string | null => {
    const staticText = new RegExp(`^StaticText\\s*\\[text=${Q}\\]$`).exec(head);
    if (staticText !== null) return `text="${pick(staticText, 1)}"`;
    const linkUrl = new RegExp(`^role=link\\s*\\[url(\\*?)=${Q}\\]$`).exec(head);
    if (linkUrl !== null) return `a[href${linkUrl[1]}="${pick(linkUrl, 2)}"]`;
    const textAttr = new RegExp(`^(role=[a-z]+)\\s*\\[text=${Q}\\]$`).exec(head);
    if (textAttr !== null) return `${textAttr[1]}[name="${pick(textAttr, 2)}"]`;
    // `placeholder` is not an accessible name and not a role-engine attribute
    // (`qualifyBareRole` rightly declines it); the CSS form is what resolves.
    const placeholder = new RegExp(`^(?:role=)?(textbox|searchbox|combobox)\\s*\\[placeholder=${Q}\\]$`).exec(head);
    if (placeholder !== null) return `input[placeholder="${pick(placeholder, 2)}"]`;
    // `aria-label` IS the accessible name; `title` is the name of anything
    // with no other — both are the tree's `name`, written under the DOM's
    // attribute instead of the engine's.
    const labelAttr = new RegExp(`^(?:role=)?([a-z]+)\\s*\\[(?:aria-label|title)=${Q}\\]$`).exec(head);
    if (labelAttr !== null) return `role=${labelAttr[1]}[name="${pick(labelAttr, 2)}"]`;
    return null;
  })();
  return rewritten === null ? selector : rewritten + tail;
}

/**
 * Why `toFlowStep` returned null for this step, in words the model can act
 * on. Kept beside `toFlowStep` and derived from the same fields, so the two
 * cannot disagree about what was missing.
 */
/**
 * Why a backend step was dropped when the run's backend toggle is off.
 *
 * Its own constant because three places must say the same thing: the drop
 * detail the model is re-asked with, the step note a reader sees
 * (`backendHint`), and the tests that pin them together.
 */
export const BACKEND_OFF_REASON =
  'this run does not test the backend (the backend toggle is off) — prove the claim through the ' +
  'page instead, and the step will be marked as one a backend check could prove more directly';

/**
 * An empty `expectValue` is the claim that a field was CLEARED (2026-09-04,
 * HIR-EC-001: "เมื่อเปลี่ยน Province ระบบเคลียร์ District / Sub-District /
 * Postal Code เดิม"). The engine compares `inputValue` to `""`, which fails on
 * any textbox that still holds something, so the pass can fail. A button
 * holds no value: the engine falls back to the trigger's own text — its
 * placeholder — and the step would be red against a correctly cleared
 * dropdown. That one shape is dropped with this reason, which names the
 * legal ones.
 */
export const EMPTY_VALUE_ON_BUTTON_REASON =
  'an empty expectValue asserts a field is EMPTY, and a button holds no value — for a dropdown the tree ' +
  'lists as a button, assert the text its trigger shows (expectText with the tree\'s own wording) or ' +
  'expectHidden of the choice that was cleared';

/** A selector whose head names the button role, in the engine or the CSS attribute form. */
function buttonSelector(selector: string): boolean {
  const head = selector.trim().split('>>')[0] ?? '';
  return /^role=button\b/i.test(head.trim()) || /\[role="button"\]/i.test(head) || /^button\b/i.test(head.trim());
}

export function dropReasonFor(
  raw: z.infer<typeof AuthoredStepSchema>,
  allowDb: boolean,
  policy: MutationPolicy = DEFAULT_MUTATION_POLICY,
): string {
  const noSelector = raw.selector === '' || raw.selector.trimStart().startsWith('/*');
  if (!(AUTHOR_ACTIONS as readonly string[]).includes(raw.action)) {
    return `"${raw.action}" is not an action this harness has — use one of: ${AUTHOR_ACTIONS.join(', ')}`;
  }
  if (/^(dbSnapshot|expectDb)/.test(raw.action) && !allowDb) {
    return 'a database check needs an indexed schema, and none was given — assert on the page instead';
  }
  if (
    raw.action === 'request' &&
    !(REQUEST_VERBS_BY_POLICY[policy] as readonly string[]).includes(raw.name.trim().split(/\s+/)[0]?.toUpperCase() ?? '')
  ) {
    return `the request's verb is not allowed under the ${policy} policy`;
  }
  if (raw.action === 'goto' && raw.url === '') return 'goto needs a url';
  if (raw.action === 'workflow' && raw.value === '' && raw.intent === '') return 'workflow needs a goal in "value"';
  if (raw.action === 'signIn' && personaLabelOf(raw) === '') {
    return 'signIn needs the persona LABEL in "name" (HR_ADMIN_ACCOUNT, MANAGER_ACCOUNT, … — exactly as the PERSONAS section lists it)';
  }
  if (raw.action === 'expectAnyVisible' && splitSelectorList(raw.value).length < 2) {
    return 'expectAnyVisible needs two or more selectors in "value", ";"-separated — one per acceptable outcome the Expected line names (a single outcome is an expectVisible)';
  }
  if (raw.action === 'upload' && !noSelector && !isFixtureSpec(raw.value)) {
    return 'upload needs a fixture spec in "value" — kind:name[@template][!mutation], e.g. pdf:medical-certificate, csv:benefit-plans@template!blank=Country (kinds: csv, pdf, xlsx, txt)';
  }
  if (noSelector && !/^(goto|workflow|setLocalStorage|clearStorage|signOut|signIn|back|forward|expectUrl|snapshot|expectScrollable|dbSnapshot|expectDb|request|expectStatus|expectJson|expectCalls|setClock|press)/.test(raw.action)) {
    return raw.selector.trimStart().startsWith('/*')
      ? 'the selector is a comment, not a selector — name a control from the tree'
      : 'the step names no selector — copy the control from the tree';
  }
  if (/^(fill|type|selectOption|expectText|expectCount|expectAttribute|saveCount|saveText)$/.test(raw.action) && raw.value === '') {
    return /^save/.test(raw.action)
      ? `${raw.action} needs the VARIABLE NAME in "value" (e.g. value: "rows-before"; a later expect step compares {{rows-before}})`
      : `${raw.action} needs a value`;
  }
  if (raw.action === 'expectValue' && raw.value === '' && buttonSelector(raw.selector)) {
    return EMPTY_VALUE_ON_BUTTON_REASON;
  }
  return 'the step could not be narrowed to a runnable form (a field it needs is missing or malformed)';
}

/** The marker a mechanically rewritten step carries at the END of its intent, so the head (the script/Expected citation) stays readable by every lint. */
export const GENERATED_STEP_MARKER = '[generated:';

/** `intent` with the `[generated: …]` marker appended — the head is never touched. */
export function markGenerated(intent: string | undefined, how: string): string {
  const head = (intent ?? '').trim();
  const mark = `${GENERATED_STEP_MARKER} ${how.replace(/\s+/g, ' ').trim()}]`;
  return head === '' ? mark : `${head} ${mark}`;
}

/** The `name="…"` a role selector's head carries, or null. */
function selectorNameOf(selector: string): string | null {
  const head = (selector.split('>>')[0] ?? '').trim();
  const m = /\[name=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/i.exec(head);
  return (m?.[1] ?? m?.[2] ?? null)?.replace(/\\(.)/g, '$1') ?? null;
}

/** Letters and digits only, lowercased — how two spellings of one field name are compared. */
const squash = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * The nearest runnable form of a step the harness would otherwise DROP
 * (2026-09-04, multirole HIR-EC-001: two `expectValue ""` on dropdown buttons
 * were dropped, the drop was refused, and the row never ran). A dropped step
 * is a claim the model made and nobody performs; where the evidence the
 * author was given supplies the missing piece, the rewrite is made here, at
 * $0, before any lint sees the flow, and the step is marked `[generated: …]`
 * so the report shows what was substituted. Structural on purpose — every
 * rule reads a step SHAPE and an evidence line, never a field name:
 *
 * - `expectValue ""` on a button (a dropdown the tree lists as a button holds
 *   no value): `expectText` of the trigger's own wording as a captured tree
 *   names it — the cleared state the claim describes. No tree line, no rewrite.
 * - `expectText` / `expectCount` / `expectAttribute` with no value: the value
 *   the intent's own `Field = value` pair states (digits, for a count); with
 *   none, `expectVisible` of the same control — a thinner claim, said so.
 * - `type` / `selectOption` with no value: the Test data pair whose
 *   key is the control's name; the provenance is `test-data`. No pair, no rewrite.
 * - `expectAnyVisible` with a single alternative: `expectVisible` of it.
 *
 * Anything else — no selector, an action the harness lacks, a backend step
 * with the backend off, a label-less `signIn` — has nothing to rewrite FROM
 * and is dropped exactly as before. Returns the rewritten wire step and the
 * one-clause `how` for the marker and the notes.
 */
export function repairAuthoredStep(
  raw: z.infer<typeof AuthoredStepSchema>,
  reason: string,
  evidence: { trees?: string | undefined; testData?: readonly TestDataPair[] | undefined } = {},
): { step: z.infer<typeof AuthoredStepSchema>; how: string; valueSource?: StepValueSource | undefined } | null {
  const noSelector = raw.selector.trim() === '' || raw.selector.trimStart().startsWith('/*');
  const lines = (evidence.trees ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const because = `the authored ${raw.action} could not run: ${reason}`;

  if (raw.action === 'expectValue' && raw.value === '' && !noSelector && buttonSelector(raw.selector)) {
    const wanted = selectorNameOf(raw.selector);
    if (wanted === null) return null;
    const needle = squash(wanted);
    const line = lines.map((l) => /^button\s+"((?:[^"\\]|\\.)*)"/i.exec(l)?.[1]).find((n) => n !== undefined && squash(n).includes(needle));
    if (line === undefined) return null;
    return {
      step: { ...raw, action: 'expectText', value: line },
      how: `asserts the trigger's own wording ${JSON.stringify(line)} from the tree — the cleared state — because ${because}`,
    };
  }

  if (/^(expectText|expectCount|expectAttribute)$/.test(raw.action) && raw.value === '' && !noSelector) {
    // The intent's own "Field = value" pair, structural: the last "=" with a
    // right-hand side, cut at the next clause.
    const pair = /=\s*([^=;\[\]]+?)\s*$/.exec(raw.intent.replace(/\s*\[generated:.*$/s, ''));
    const stated = pair?.[1]?.trim() ?? '';
    if (stated !== '' && (raw.action !== 'expectCount' || /^\d+$/.test(stated))) {
      return { step: { ...raw, value: stated }, how: `value ${JSON.stringify(stated)} taken from the intent's own "= ${stated}" pair, because ${because}` };
    }
    if (raw.action === 'expectAttribute') return null;
    return {
      step: { ...raw, action: 'expectVisible', value: '' },
      how: `narrowed to the control's presence — a thinner claim than the ${raw.action} written — because ${because}`,
    };
  }

  // `fill ""` is a legitimate step (clear the field) and is never dropped; a
  // `type` or `selectOption` with nothing to type or choose is.
  if (/^(type|selectOption)$/.test(raw.action) && raw.value === '' && !noSelector) {
    const wanted = selectorNameOf(raw.selector);
    if (wanted === null) return null;
    const needle = squash(wanted);
    const pair = (evidence.testData ?? []).find((p) => {
      const key = squash(p.key);
      return key !== '' && needle !== '' && (key === needle || key.includes(needle) || needle.includes(key));
    });
    if (pair === undefined || pair.value.trim() === '' || unconfirmedValue(pair.value)) return null;
    const detail = `${pair.key} = ${pair.value}`;
    return {
      step: { ...raw, value: pair.value },
      how: `value from the Test data pair ${JSON.stringify(detail)}, because ${because}`,
      valueSource: { kind: 'test-data', detail },
    };
  }

  if (raw.action === 'expectAnyVisible') {
    const one = splitSelectorList(raw.value);
    if (one.length === 1) {
      return { step: { ...raw, action: 'expectVisible', selector: one[0]!, value: '' }, how: `one alternative is an expectVisible, because ${because}` };
    }
  }
  return null;
}

/**
 * A saved-variable reference as `expectCount`/`expectText` may carry it:
 * `{{rows}}`, and since CG-07 the delta form `{{rows+1}}` / `{{rows - 1}}` the
 * variable store computes from the saved reading. Group 1 is the NAME —
 * what a save must have written for the reference to resolve.
 */
export const VARIABLE_REF = /^\{\{\s*([\w.-]+?)\s*(?:[+-]\s*\d+)?\s*\}\}$/;

/**
 * The persona label a `signIn` step names — `name` first (where the field
 * description puts it), `value` as the fallback a smaller model reaches for,
 * the sheet's own `<HRBP_ACCOUNT>` token form accepted with its brackets
 * stripped. Empty when the step names nothing.
 */
function personaLabelOf(raw: { name: string; value: string }): string {
  const candidate = (raw.name.trim() || raw.value.trim()).replace(/^<\s*|\s*>$/g, '').trim();
  return candidate;
}

/** `value` of an expectAnyVisible: the `;`-separated selectors, the expectCalls convention. */
function splitSelectorList(value: string): string[] {
  return value
    .split(/[;\n]/)
    .map((part) => part.trim())
    .filter((part) => part !== '' && !part.startsWith('/*'));
}

/**
 * A declared wait (EH-07): digits in `timeoutMs`, capped at
 * `MAX_STEP_TIMEOUT_MS`, absent for anything else. A model that writes "5
 * minutes" or "300s" has declared no wait — the field description says
 * digits, and inventing a conversion here would hand the engine a number the
 * author never wrote.
 */
function timeoutOf(raw: { timeoutMs?: string | undefined }): number | undefined {
  const digits = (raw.timeoutMs ?? '').trim();
  if (!/^\d{1,7}$/.test(digits)) return undefined;
  const ms = Number(digits);
  if (ms <= 0) return undefined;
  return Math.min(ms, MAX_STEP_TIMEOUT_MS);
}

function toFlowStep(
  raw: z.infer<typeof AuthoredStepSchema>,
  allowDb: boolean,
  policy: MutationPolicy = DEFAULT_MUTATION_POLICY,
): FlowStep | null {
  const intent = raw.intent === '' ? undefined : raw.intent;
  // Spread onto the six waitable steps only; `undefined` is never written.
  const timeoutMs = timeoutOf(raw);
  const wait = timeoutMs === undefined ? {} : { timeoutMs };
  // A CSS comment is not a selector, and a model that cannot find a control
  // sometimes "declines" by emitting one — `/* selector for X not found */` —
  // which then reaches Playwright as a parse error and burns the whole
  // reconstruction budget on a step that could never run (seen live,
  // DB_08_01). A step whose selector is commentary has no selector.
  const needsSelector = raw.selector === '' || raw.selector.trimStart().startsWith('/*');
  // Chrome's accessible names carry CSS `text-transform`, Playwright's matcher
  // does not — relax case on the way out so an authored flow resolves. See
  // `src/engine/selector.ts`. The U+2011 non-breaking hyphen is normalized to
  // ASCII first: models typeset ids like RULE‑FUEL‑002 with it (run 4's
  // DB_08_01, live), no DOM renders ids that way, and a selector quoting the
  // fancy glyph can never match the ASCII row it means.
  // A time-of-day greeting is never the fact a step proves — the page chooses
  // it by the clock, and the flow's own `setClock` moves the clock — so a
  // selector quoting one is written against the name after it instead
  // (`withoutGreeting`; ec10, 2026-09-02: six false failures on one line).
  const selector = needsSelector
    ? ''
    : withLabelForNonAriaRole(withStableGreeting(withRelaxedRoleName(withQualifiedRole(fromTreeNotation(raw.selector.replace(/‑/g, '-'))))));

  switch (raw.action) {
    case 'goto':
      return raw.url === '' ? null : { action: 'goto', url: raw.url };
    case 'click':
      return needsSelector ? null : { action: 'click', selector, intent };
    case 'clickIfVisible':
      return needsSelector
        ? null
        : {
            action: 'when',
            visible: selector,
            then: [{ action: 'click', selector, intent }],
            intent: intent ?? `click ${selector} if it is shown`,
          };
    case 'waitFor':
      return needsSelector ? null : { action: 'waitFor', selector, intent, ...wait };
    case 'fill':
      return needsSelector
        ? null
        : { action: 'fill', selector, value: raw.value, intent };
    case 'selectOption':
      return needsSelector || raw.value === ''
        ? null
        : { action: 'selectOption', selector, value: raw.value, intent };
    case 'check':
      return needsSelector ? null : { action: 'check', selector, intent };
    case 'uncheck':
      return needsSelector ? null : { action: 'uncheck', selector, intent };
    case 'type':
      return needsSelector || raw.value === ''
        ? null
        : { action: 'type', selector, value: raw.value, intent };
    case 'press':
      return raw.key === ''
        ? null
        : {
            action: 'press',
            key: raw.key,
            selector: selector === '' ? undefined : selector,
            intent,
          };
    case 'workflow':
      return raw.value === '' ? null : { action: 'workflow', goal: raw.value };
    case 'setLocalStorage':
      return raw.key === '' ? null : { action: 'setLocalStorage', key: raw.key, value: raw.value };
    case 'clearStorage':
      return { action: 'clearStorage' };
    case 'signOut':
      return { action: 'signOut', intent };
    case 'signIn': {
      // The LABEL, never the credentials: `RunFlowOptions.personas` resolves
      // it at run time, so a flow file carries no password (CG-05, EH-10).
      const as = personaLabelOf(raw);
      if (as === '') return null;
      return { action: 'signIn', as, ...(raw.url === '' ? {} : { url: raw.url }), intent };
    }
    case 'upload': {
      // `files` carries the SPEC; the run writes the file
      // (`src/data/fixtures.ts` `writeFixture`) and hands the engine the path.
      // A value that is not a spec is not a file the harness can make.
      if (needsSelector || !isFixtureSpec(raw.value)) return null;
      return { action: 'upload', selector, files: [raw.value.trim()], intent };
    }
    case 'back':
      return { action: 'back', intent };
    case 'forward':
      return { action: 'forward', intent };
    case 'scrollTo':
      return needsSelector ? null : { action: 'scrollTo', selector, intent };
    case 'expectScrollable':
      // A page-level check needs no selector, so an empty one is valid here
      // rather than a reason to drop the step.
      return { action: 'expectScrollable', selector: selector === '' ? undefined : selector, intent };
    case 'expectText':
      return needsSelector || raw.value === ''
        ? null
        : { action: 'expectText', selector, value: raw.value, intent, ...wait };
    case 'expectVisible':
      return needsSelector ? null : { action: 'expectVisible', selector, intent, ...wait };
    case 'expectHidden': {
      if (needsSelector) return null;
      // The prompt's own quoting rule, applied mechanically where ignoring it
      // is guaranteed-false: an UNQUOTED single word in the text engine is a
      // case-insensitive substring match, so `expectHidden text=extended`
      // fires on the page's legitimate "Extended" label and files a leak
      // defect about correct copy (glm-4.5-flash, live, three of seven codes
      // in one flow — the snake_case four passed, the plain-word three could
      // only fail). Quoting narrows to an exact text node, which is what a
      // raw-code leak looks like. Words with spaces or a snake_case shape are
      // left exactly as written.
      const bareWord = /^text=([\p{L}\p{N}]+)$/u.exec(selector);
      return {
        action: 'expectHidden',
        selector: bareWord !== null ? `text="${bareWord[1]}"` : selector,
        intent,
        ...wait,
      };
    }
    case 'expectEnabled':
      return needsSelector ? null : { action: 'expectEnabled', selector, intent };
    case 'expectDisabled':
      return needsSelector ? null : { action: 'expectDisabled', selector, intent };
    case 'expectFocused':
      return needsSelector ? null : { action: 'expectFocused', selector, intent };
    case 'expectAnyVisible': {
      // Two or more, each through the same rewrites a single selector gets —
      // one alternative written in tree notation would otherwise resolve
      // nothing and silently narrow the claim to the other branch.
      const selectors = splitSelectorList(raw.value).map((one) =>
        withLabelForNonAriaRole(withStableGreeting(withRelaxedRoleName(withQualifiedRole(fromTreeNotation(one.replace(/‑/g, '-')))))),
      );
      if (selectors.length < 2) return null;
      return { action: 'expectAnyVisible', selectors, intent, ...wait };
    }
    case 'expectFieldError':
      return needsSelector
        ? null
        : { action: 'expectFieldError', selector, ...(raw.value.trim() === '' ? {} : { value: raw.value.trim() }), intent };
    case 'expectCount': {
      // Digits, or a `{{variable}}` a saveCount/saveText step recorded — the
      // compare half of a reconciliation claim — including the delta form
      // `{{rows-before+1}}` / `{{rows-before - 1}}` the variable store
      // computes (CG-07). Anything else is unusable rather than something to
      // guess at.
      if (VARIABLE_REF.test(raw.value.trim())) {
        return needsSelector ? null : { action: 'expectCount', selector, count: raw.value.trim(), intent, ...wait };
      }
      // Digits only: `Number('')` is 0, and an expectCount the model left
      // EMPTY used to narrow to "expect zero" — a claim it never made, which
      // passes on any empty list (found 2026-09-04 while making the empty
      // value repairable; `dropReasonFor` had always said it needs a value).
      const count = /^\d+$/.test(raw.value.trim()) ? Number(raw.value.trim()) : Number.NaN;
      return needsSelector || !Number.isInteger(count) || count < 0
        ? null
        : { action: 'expectCount', selector, count, intent, ...wait };
    }
    case 'saveCount':
      // `value` names the variable the reading lands in.
      return needsSelector || raw.value.trim() === ''
        ? null
        : { action: 'saveCount', selector, as: raw.value.trim(), intent };
    case 'saveText':
      return needsSelector || raw.value.trim() === ''
        ? null
        : { action: 'saveText', selector, as: raw.value.trim(), intent };
    case 'expectUrl':
      return raw.value === '' ? null : { action: 'expectUrl', value: raw.value, intent };
    case 'expectValue':
      // An empty value is the cleared-field claim (see
      // `EMPTY_VALUE_ON_BUTTON_REASON`); only a button cannot carry it.
      return needsSelector || (raw.value === '' && buttonSelector(selector))
        ? null
        : { action: 'expectValue', selector, value: raw.value, intent };
    case 'expectAttribute':
      return needsSelector || raw.name === ''
        ? null
        : {
            action: 'expectAttribute',
            selector,
            name: raw.name,
            value: raw.value,
            intent,
          };
    case 'expectCalls': {
      if (raw.value === '') return null;
      const calls: ExpectedCall[] = [];
      const never: ExpectedCall[] = [];
      for (const entry of raw.value.split(/[;\n]/)) {
        const line = entry.trim();
        if (line === '') continue;
        const parsed = parseExpectedCallEntry(line);
        // One unparseable entry drops the whole step: a sequence assertion
        // missing one of its calls silently would check a different claim.
        if (parsed === null) return null;
        (parsed.never ? never : calls).push(parsed.call);
      }
      if (calls.length === 0 && never.length === 0) return null;
      return {
        action: 'expectCalls',
        ...(calls.length > 0 ? { calls } : {}),
        ...(never.length > 0 ? { never } : {}),
        intent,
      };
    }
    case 'dbSnapshot': {
      if (!allowDb || raw.name === '') return null;
      const tables = raw.name.split(',').map((t) => t.trim()).filter((t) => t !== '');
      if (tables.length === 0) return null;
      return { action: 'dbSnapshot', tables, as: raw.key === '' ? undefined : raw.key, intent };
    }
    case 'expectDbRow': {
      if (!allowDb || raw.name === '' || raw.key === '') return null;
      const where = parseDbConditions(raw.key);
      if (where === null || Object.keys(where).length === 0) return null;
      const values = raw.value === '' ? undefined : parseDbConditions(raw.value);
      if (values === null) return null;
      return {
        action: 'expectDbRow',
        table: raw.name.trim(),
        where,
        ...(values !== undefined && Object.keys(values).length > 0 ? { values } : {}),
        intent,
      };
    }
    case 'expectDbDelta': {
      if (!allowDb || raw.name === '') return null;
      const delta = Number(raw.value);
      if (!Number.isInteger(delta)) return null;
      return {
        action: 'expectDbDelta',
        table: raw.name.trim(),
        delta,
        since: raw.key === '' ? undefined : raw.key,
        intent,
      };
    }
    case 'expectDbUnchanged': {
      if (!allowDb || raw.name === '') return null;
      const tables = raw.name.split(',').map((t) => t.trim()).filter((t) => t !== '');
      if (tables.length === 0) return null;
      return {
        action: 'expectDbUnchanged',
        tables,
        since: raw.key === '' ? undefined : raw.key,
        intent,
      };
    }
    case 'expectDbCount': {
      // Narrows to the runner's expectDbRow: exact count, optional where. A
      // {{variable}} count survives as a string and interpolates at run time
      // — the API-vs-database cross-check.
      if (!allowDb || raw.name === '' || raw.value === '') return null;
      const where = raw.key === '' ? {} : parseDbConditions(raw.key);
      if (where === null) return null;
      const value = raw.value.trim();
      const isVariable = value.includes('{{');
      const numeric = Number(value);
      if (!isVariable && (!Number.isInteger(numeric) || numeric < 0)) return null;
      return {
        action: 'expectDbRow',
        table: raw.name.trim(),
        where,
        count: isVariable ? value : numeric,
        intent,
      };
    }
    case 'request': {
      const match = /^([A-Za-z]+)\s+(\S+)$/.exec(raw.name.trim());
      if (!match?.[1] || !match[2]) return null;
      const method = match[1].toUpperCase();
      // The policy filter is the guarantee; DELETE is in no tier's list.
      if (!REQUEST_VERBS_BY_POLICY[policy].includes(method)) return null;
      let save: Record<string, string> | undefined;
      if (raw.key !== '') {
        const parsed = parseDbConditions(raw.key);
        if (parsed === null) return null;
        save = {};
        for (const [name, path] of Object.entries(parsed)) {
          // A save that is not a JSON path would silently save nothing and
          // fail three steps later as an unknown variable — unusable, not
          // guessable, same rule as everywhere else in this switch.
          if (typeof path !== 'string' || !path.startsWith('$')) return null;
          save[name] = path;
        }
      }
      // A body that parses as JSON travels as the object (and is sent with a
      // JSON content type); anything else travels verbatim.
      let body: unknown;
      if (raw.value !== '') {
        try {
          body = JSON.parse(raw.value);
        } catch {
          body = raw.value;
        }
      }
      return {
        action: 'request',
        method,
        url: match[2],
        ...(body !== undefined ? { body } : {}),
        ...(save !== undefined && Object.keys(save).length > 0 ? { save } : {}),
        intent,
      };
    }
    case 'expectStatus': {
      const status = Number(raw.value.trim());
      return Number.isInteger(status) && status >= 100 && status <= 599
        ? { action: 'expectStatus', status, intent }
        : null;
    }
    case 'expectJson':
      return raw.key.startsWith('$')
        ? {
            action: 'expectJson',
            path: raw.key,
            ...(raw.value === '' ? {} : { value: raw.value }),
            intent,
          }
        : null;
    case 'setClock':
      return raw.value === '' || Number.isNaN(new Date(raw.value).getTime())
        ? null
        : { action: 'setClock', time: raw.value, intent };
    case 'expectModal':
      return { action: 'expectModal', ...(raw.name === '' ? {} : { name: raw.name }), intent, ...wait };
    case 'closeModal':
      return { action: 'closeModal', ...(selector === '' ? {} : { button: selector }), intent };
    default:
      return null;
  }
}

export interface AuthoredFlow {
  flow: Flow;
  /**
   * The body, partitioned into cases that can each be run on their own. Never
   * empty: a body the model did not divide is one case. Concatenating them gives
   * back `flow.steps` exactly, so a caller that only wants the whole flow can
   * keep using it and see no change.
   */
  cases: AuthoredCase[];
  rationale: string;
  /** Hand-verification the model itself flagged. Empty string when none. */
  notes: string;
  /**
   * True when a live page's AX tree backed the selectors. False means every
   * selector is a placeholder — useful as a starting point, not as a test.
   */
  grounded: boolean;
  sourceUrl: string | undefined;
  model: string;
  authoredAt: string;
  /** Steps the model produced that could not be narrowed into a valid step. */
  droppedSteps: number;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  latencyMs: number;
  /** What the authoring review did, when one ran — see `flow-review.ts`. */
  review?: ReviewRecord | undefined;
  /**
   * The case's Expected lines are ALL `[RECORD ONLY]` (CG-09): the flow is
   * the script plus saveText/snapshot observations and asserts nothing,
   * because the sheet has no oracle — its honest verdict is `review` with the
   * captures, never a pass and never a block. The catalog path stamps this
   * onto the flow's provenance (`authoredBy.recordOnly`) so `runCases` maps
   * the vacuous shape to `review` instead of blocking it.
   */
  recordOnly?: boolean | undefined;
}

/**
 * Whether a refusal is about a claim that is FALSE or one that is merely THIN.
 *
 * The distinction decides what happens when the attempt budget runs out, and
 * it is the whole of `#authorWithRetries`' contract. A `fatal` refusal —
 * no assertion at all, credentials filled on the wrong page, a URL derived
 * from a label, a count of a role the page never exposes — describes a flow
 * that would report something untrue, and emitting it is strictly worse than
 * emitting nothing. A `weak` refusal describes a flow that proves less than
 * it should; refusing that one on the last attempt costs the person the whole
 * flow, which is the outcome "feedback must never make the result worse" (see
 * `vacuousFormAssertion`) exists to forbid. Measured: a hard refusal of a
 * thin-but-runnable flow drew a re-ask that came back with a single step and
 * no assertion, so the person paid for the model's second answer and got
 * nothing.
 *
 * `fatal` is the default precisely so every throw site that predates this
 * keeps its present meaning; a lint opts INTO leniency, it never gets it by
 * omission.
 */
export type AuthoringErrorSeverity = 'fatal' | 'weak';

export class AuthoringError extends Error {
  readonly severity: AuthoringErrorSeverity;
  /**
   * The short form recorded on `AuthoredFlow.notes` when a `weak` refusal is
   * accepted rather than thrown. The message itself is written at the model
   * ("do this instead"); this is written at the person reading the report
   * ("here is what this flow does not prove"). Defaults to the message.
   */
  readonly note: string;
  /**
   * Every complaint this refusal carries, one per lint, unwrapped.
   *
   * `message` composes them for a person; this is what goes back to the model,
   * because `buildUserPrompt` renders `feedback` as a bulleted list and one
   * bullet per problem reads far better than one bullet containing three.
   * Defaults to `[message]`, so a single-lint refusal is byte-for-byte what it
   * always was.
   */
  readonly messages: readonly string[];

  constructor(
    message: string,
    options: {
      severity?: AuthoringErrorSeverity | undefined;
      note?: string | undefined;
      messages?: readonly string[] | undefined;
    } = {},
  ) {
    super(message);
    this.name = 'AuthoringError';
    this.severity = options.severity ?? 'fatal';
    this.note = options.note ?? message;
    this.messages = options.messages ?? [message];
  }
}

/** One lint's complaint about the flow just authored. */
export interface Violation {
  message: string;
  severity: AuthoringErrorSeverity;
  note: string;
  /**
   * The structural fallback for a FATAL complaint, applied only once the
   * re-ask budget is spent or the model has answered the same refusal twice
   * (`settleViolations`): rewrite or annotate the offending step in place —
   * never invent — and return the note the flow carries instead of the
   * refusal, or null when the evidence does not allow a rewrite (the refusal
   * then stands). A lint without one refuses to the end, as it always did.
   */
  settle?: (() => string | null) | undefined;
}

/**
 * Apply every fatal complaint's `settle` (2026-09-04, multirole HIR-EC-001):
 * the row used to be blocked whole when one claim could not be authored in a
 * form the lints accept, and the person got no run at all. Now, at the end of
 * the budget, each fatal complaint that KNOWS a grounded rewrite performs it
 * — an ungrounded assertion is annotated and left for the run to settle, a
 * closed set gets its count from the tree, a script step nobody performs is
 * named as not covered — and the flow is handed over with those notes. A
 * complaint with no rewrite, or whose rewrite finds no evidence, is returned
 * as `unsettled`, and one unsettled fatal complaint keeps the whole refusal:
 * a FALSE claim is still refused; only the claims that can be made honest
 * are. Weak complaints contribute their notes as they always did.
 */
export function settleViolations(violations: readonly Violation[]): { notes: string[]; unsettled: Violation[] } {
  const notes: string[] = [];
  const unsettled: Violation[] = [];
  for (const violation of violations) {
    if (violation.severity === 'weak') {
      // A thin claim's own grounded rewrite, when it has one; its note otherwise.
      notes.push(violation.settle?.() ?? violation.note);
      continue;
    }
    const note = violation.settle?.() ?? null;
    if (note === null) unsettled.push(violation);
    else notes.push(note);
  }
  return { notes, unsettled };
}

/**
 * How many complaints one re-ask carries.
 *
 * The validation chain used to stop at the first lint that fired, so a model
 * with three problems needed three attempts merely to *learn about* three
 * problems — and each re-ask was free to trip a lint it had never been told
 * about. Measured on one prompt: a `--scope e2e` run was refused by three
 * DIFFERENT lints across its three attempts and produced no flow at all.
 * With 16 fatal lints against `AUTHOR_ATTEMPTS`, first-only reporting is a
 * denial of service on authoring rather than a quality gate.
 *
 * The cap exists for the opposite failure: ten complaints at once would crowd
 * the accessibility tree out of the prompt, and the tree is the only thing
 * that can actually ground the fix. Over the cap the count is disclosed, never
 * silently dropped — the same rule truncation follows everywhere else here.
 */
export const MAX_REPORTED_VIOLATIONS = 5;

/**
 * Several complaints as one refusal.
 *
 * A single violation composes to exactly the message that lint has always
 * raised — no wrapper, no renumbering — so the common case reads and tests
 * identically to before this existed.
 *
 * **Severity is computed across ALL violations, including any the cap left
 * out**: one fatal complaint makes the whole refusal fatal, and a flow that
 * says something untrue must never become returnable because two thin
 * complaints joined it. Only an all-weak refusal stays weak.
 */
export function composeRefusal(violations: readonly Violation[]): AuthoringError {
  const first = violations[0];
  if (first === undefined) throw new Error('composeRefusal called with no violations');
  const fatal = violations.some((violation) => violation.severity === 'fatal');
  const severity: AuthoringErrorSeverity = fatal ? 'fatal' : 'weak';

  if (violations.length === 1) {
    return new AuthoringError(first.message, { severity, note: first.note });
  }

  const shown = violations.slice(0, MAX_REPORTED_VIOLATIONS);
  const omitted = violations.length - shown.length;
  const header =
    `${violations.length} problems with the authored flow — fix all of them, not just the ` +
    `first${omitted > 0 ? `. The first ${shown.length}` : ''}:`;
  const body = shown.map((violation, index) => `  (${index + 1}) ${violation.message}`);
  const tail =
    omitted > 0
      ? [
          `  (${omitted} further problem(s) not listed — fix these and the rest are reported next.)`,
        ]
      : [];

  return new AuthoringError([header, ...body, ...tail].join('\n'), {
    severity,
    note: violations.map((violation) => violation.note).join('; '),
    messages: shown.map((violation) => violation.message),
  });
}

/** Where a refusal's wrapped problem text continues, under its `(n)` label. */
const REFUSAL_LINE_WIDTH = 100;

/**
 * The refusal as a person reads it in the live log: the headline, the flow's
 * name once, then one numbered problem each — wrapped at `REFUSAL_LINE_WIDTH`
 * with a hanging indent, and with every `the authored flow "<name>"` the lints
 * write for the model's benefit shortened to `the flow`. Each message used to
 * be one line of several hundred characters, four of them quoting the same
 * sixty-character name; nothing a scanning reader could use.
 *
 * What the MODEL is told (`error.messages`, the feedback of the re-ask) is
 * untouched — this is the log's rendering, not the refusal.
 */
export function formatRefusalLines(error: AuthoringError, flowName: string): string[] {
  const problems = error.messages.length > 1 ? error.messages : [error.message];
  const headline =
    error.messages.length > 1 ? (error.message.split('\n')[0] ?? '') : `1 problem with the authored flow:`;
  const lines = [`refused: ${headline}`];
  const name = flowName.trim();
  const quoted = `the authored flow ${JSON.stringify(name)}`;
  if (name !== '' && problems.some((p) => p.includes(quoted))) lines.push(`  flow: ${JSON.stringify(name)}`);
  problems.forEach((problem, index) => {
    const label = `  (${index + 1}) `;
    const hang = ' '.repeat(label.length);
    const text = (name === '' ? problem : problem.split(quoted).join('the flow')).replace(/\s+/g, ' ').trim();
    lines.push(...wrapText(`${label}${text}`, REFUSAL_LINE_WIDTH, hang));
  });
  return lines;
}

export interface FlowAuthorOptions {
  model: FlowAuthorModel;
  /**
   * The model for attempts after the first, when a run wants a faster one
   * there: the first ask writes the whole flow and earns the strong model;
   * a re-ask fixes a named mistake in (usually) one case. Absent means the
   * same model throughout — byte-for-byte what it always was.
   */
  retryModel?: FlowAuthorModel | undefined;
  /**
   * Total authoring attempts including the first (`AUTHOR_ATTEMPTS` when
   * absent). Selectable per run — 1 is "one ask, no re-ask budget": cheaper
   * and faster, at the price of losing the informed retry that the refusal
   * feedback exists for.
   */
  attempts?: number | undefined;
  maxAxNodes?: number | undefined;
  /** Open the page's menus and disclosures before authoring. Default false. */
  probe?: boolean | undefined;
  maxProbes?: number | undefined;
  policy?: MutationPolicy | undefined;
  /**
   * Declared database tables, when a schema is indexed. Presence is the
   * permission to author DB checks — see `AuthorRequest.tables`.
   */
  tables?: readonly TableInventoryEntry[] | undefined;
  /** A saved repository's prompt section — see `AuthorRequest.projectContext`. */
  projectContext?: string | undefined;
  /** The account to sign in as — see `AuthorRequest.credentials`. */
  credentials?: { email: string; password: string } | undefined;
  /**
   * Every persona the run holds credentials for, by label — see
   * `AuthorRequest.personas`. With this set the author writes `signIn` steps
   * by label and the lints refuse a login typed by hand; the same map must
   * reach `RunFlowOptions.personas` for the steps to resolve at run time.
   */
  personas?: Readonly<Record<string, { email: string; password: string }>> | undefined;
  /** A further page's tree — see `AuthorRequest.journeyTree`. */
  journeyTree?: string | undefined;
  /** How far the test must reach — see `TestScope`. Absent means `unit`. */
  scope?: TestScope | undefined;
  /**
   * Route patterns the selected repository declares. The third grounding
   * source for `expectUrl`, beside the tree's `url=` attributes and the flow's
   * own gotos — see `ungroundedUrlExpectation`.
   */
  declaredRoutes?: readonly string[] | undefined;
  /**
   * `METHOD /path` for every endpoint the selected repository declares — from
   * an OpenAPI document or, since 2026-08-25, from the file-convention
   * router's own exported handlers. The grounding source for an authored
   * `request`'s METHOD, which nothing could check before — see
   * `unindexedRequestMethod`.
   */
  declaredOperations?: readonly string[] | undefined;
  /**
   * Whether this run tests the BACKEND at all.
   *
   * Default `true` — the behaviour every run had before this existed. Set
   * false and the author may write no `request`, `expectStatus`, `expectJson`,
   * `expectHeader`, `expectCalls` or `expectDb*` step: a claim that would have
   * been settled against HTTP or the database is settled through the PAGE
   * instead, and the step says so (`backendHint`), so a reader knows the
   * claim has a stronger proof available and this run did not take it.
   *
   * The toggle exists because "prove it against the database" and "prove it
   * on screen" need different things from the person running it — a reachable
   * database, a spec whose endpoints are indexed — and a run that has neither
   * should produce honest visual proof with a note, not a wall of blocked
   * cases.
   */
  backend?: boolean | undefined;
  /**
   * A second look at the accepted flow against the codebase and documents
   * before it is handed back — the level above the lints. Absent means the
   * flow is exactly what the author wrote. See `flow-review.ts`.
   */
  reviewer?: FlowReviewer | undefined;
  /**
   * Resolve the values a sheet leaves as tokens (`<NON_EXISTING_EMPLOYEE_ID>`)
   * or descriptions before the lints see them — from the case's own text, the
   * documents and repository, the database (read-only), or, flagged, from the
   * generator itself. See `value-resolution.ts`. Absent = off: a token is
   * refused by `typesPlaceholderToken` as before.
   */
  valueResolution?:
    | {
        model: ValueResolverModel | null;
        db?: (() => Promise<import('../db/client.js').DbClient | null>) | undefined;
        documents?: readonly import('../catalog/extract.js').ExtractedDocument[] | undefined;
      }
    | undefined;
  masterData?: {
    lookups: readonly import('../context/master-data.js').MasterDataLookup[];
    fetch: () => Promise<import('../context/master-data.js').FetchJson | null>;
    appUrl?: string | undefined;
  } | undefined;
  /** Called at each authoring lifecycle event — for live progress output. */
  onLog?: ((line: string) => void) | undefined;
}

export class FlowAuthor {
  readonly model: FlowAuthorModel;
  readonly #retryModel: FlowAuthorModel | undefined;

  readonly #maxAxNodes: number;
  readonly #policy: MutationPolicy;
  readonly #onLog: ((line: string) => void) | undefined;
  readonly #probe: boolean;
  readonly #maxProbes: number | undefined;
  readonly #tables: readonly TableInventoryEntry[] | undefined;
  readonly #projectContext: string | undefined;
  readonly #credentials: { email: string; password: string } | undefined;
  readonly #personas: Readonly<Record<string, { email: string; password: string }>> | undefined;
  readonly #journeyTree: string | undefined;
  readonly #scope: TestScope | undefined;
  /** Route patterns the selected repository declares — grounding for expectUrl. */
  readonly #declaredRoutes: readonly string[];
  readonly #declaredOperations: readonly string[];
  readonly #backend: boolean;
  readonly #reviewer: FlowReviewer | undefined;
  readonly #valueResolution: FlowAuthorOptions['valueResolution'];
  readonly #masterData: FlowAuthorOptions['masterData'];
  readonly #attempts: number;
  /**
   * Refusals this AUTHOR has already seen, across every row it has written —
   * shape → { exemplar, count }. One author instance writes a whole catalog,
   * so this is suite-scoped by construction. See `SUITE_REFUSAL_MEMORY`.
   */
  readonly #refusals = new Map<string, { exemplar: string; count: number }>();

  constructor(options: FlowAuthorOptions) {
    this.model = options.model;
    this.#retryModel = options.retryModel;
    // Per-run option first, then the Machinery dial, then the constant.
    const dial = Number((process.env['WOWLIDATOR_AUTHOR_ATTEMPTS'] ?? '').trim());
    const fallback = Number.isInteger(dial) && dial >= 1 && dial <= 5 ? dial : AUTHOR_ATTEMPTS;
    this.#attempts =
      options.attempts !== undefined && Number.isFinite(options.attempts)
        ? Math.max(1, Math.floor(options.attempts))
        : fallback;
    this.#probe = options.probe ?? false;
    this.#maxProbes = options.maxProbes;
    this.#maxAxNodes = options.maxAxNodes ?? DEFAULT_AUTHOR_MAX_NODES;
    this.#policy = options.policy ?? DEFAULT_MUTATION_POLICY;
    this.#tables = options.tables;
    this.#projectContext = options.projectContext;
    this.#credentials = options.credentials;
    this.#personas = options.personas;
    this.#journeyTree = options.journeyTree;
    this.#scope = options.scope;
    this.#declaredRoutes = options.declaredRoutes ?? [];
    this.#declaredOperations = options.declaredOperations ?? [];
    this.#backend = options.backend ?? true;
    this.#reviewer = options.reviewer;
    this.#valueResolution = options.valueResolution;
    this.#masterData = options.masterData;
    this.#onLog = options.onLog;
  }

  /** Remember a refusal by its shape, keeping the first message as the exemplar. */
  #rememberRefusals(messages: readonly string[]): void {
    for (const message of messages) {
      const shape = refusalShape(message);
      if (shape === '') continue;
      const held = this.#refusals.get(shape);
      if (held === undefined) this.#refusals.set(shape, { exemplar: message, count: 1 });
      else held.count += 1;
    }
  }

  /**
   * The mistakes this suite keeps making, most frequent first, bounded.
   *
   * Only shapes seen more than once travel: a lint that fired on exactly one
   * row is that row's problem, and pre-loading it onto unrelated rows is how a
   * memory turns into a bias. The second occurrence is the evidence that it is
   * a pattern rather than an accident.
   */
  #recalledRefusals(): string[] {
    return [...this.#refusals.values()]
      .filter((held) => held.count > 1)
      .sort((a, b) => b.count - a.count)
      .slice(0, SUITE_REFUSAL_MEMORY)
      .map((held) => held.exemplar);
  }

  /**
   * Turn a request into a flow.
   *
   * Pass `page` (already navigated) to ground the selectors in what is really
   * on screen. Without it the flow is shape-correct but its selectors are
   * guesses, and `grounded` says so.
   */
  /**
   * For every "skipped step N: <why>" the flow carries, the field the reason
   * says was missing and the value the repo/db sources can supply for it.
   * Only when the reason speaks of a missing value/id; a step skipped for any
   * other reason (needs another module, destructive) is left alone.
   */
  async #valuesForSkippedSteps(
    steps: readonly FlowStep[],
    caseText: string,
    promptText: string,
    projectContext: string | undefined,
  ): Promise<{ step: number; field: string; value: string; source: string }[]> {
    if (this.#valueResolution === undefined) return [];
    const out: { step: number; field: string; value: string; source: string }[] = [];
    const seen = new Set<number>();
    for (const step of steps) {
      const intent = (step as { intent?: unknown }).intent;
      if (typeof intent !== 'string') continue;
      for (const m of intent.matchAll(/skip(?:ped)?\s+step\s+(\d{1,2})\s*(?:\(([^)]*)\))?\s*[:—-]?\s*([^.;]*)/gi)) {
        const n = Number(m[1]);
        if (seen.has(n)) continue;
        const reason = `${m[2] ?? ''} ${m[3] ?? ''}`;
        if (!/\b(no|without|missing|lack|unknown|not (?:yet )?exist|ไม่มี|ไม่ทราบ)\b/i.test(reason) || !/\b(id|value|employee|code|number|record)\b/i.test(reason)) continue;
        const field = fieldNamesIn(reason)[0] ?? fieldNamesIn(intent)[0];
        if (field === undefined) continue;
        seen.add(n);
        const need: ValueNeed = { section: 'steps', index: -1, field, token: null, nonExisting: false, format: formatStatedFor(field, caseText) };
        const ctx: ValueResolutionContext = {
          caseText,
          promptText,
          model: this.#valueResolution.model,
          ...(this.#valueResolution.db === undefined ? {} : { db: this.#valueResolution.db }),
          ...(this.#valueResolution.documents === undefined ? {} : { documents: this.#valueResolution.documents }),
          ...(projectContext === undefined ? {} : { projectContext }),
          onLog: (line) => this.#onLog?.(line),
        };
        let answer = fromTestData(need, caseText);
        answer ??= await fromRepo(need, ctx).catch(() => null);
        answer ??= await fromDb(need, ctx).catch(() => null);
        if (answer !== null) {
          this.#onLog?.(`  step ${n} was skipped for want of ${field}; ${answer.source.kind} has ${answer.value} — asking again`);
          out.push({ step: n, field, value: answer.value, source: `${answer.source.kind}: ${answer.source.detail}` });
        }
      }
    }
    return out;
  }

  async author(
    prompt: string,
    page?: Page,
    /**
     * Per-call evidence a caller captured for THIS prompt. A catalog authors
     * one row per call against one open page, and each row's journey ends on
     * its own page — so the destination tree cannot be a property of the
     * author; it is a property of the call.
     */
    extra: {
      journeyTree?: string | undefined;
      /**
       * A repository-context slice ranked against THIS row's own words,
       * overriding the author-wide `projectContext` for this call. Same
       * reasoning as `journeyTree`: a catalog authors one row per call, and
       * the routes that matter are the row's, not the whole project's.
       */
      projectContext?: string | undefined;
      /**
       * Evidence to author AGAINST from the first ask (S6): the pre-run risk
       * judge's concrete reasons ("the search box starts disabled", "no
       * Start-date filter exists") from a prior attempt of this same row.
       * The judge already knew the answer; it used to only shorten retries.
       */
      priorFeedback?: readonly string[] | undefined;
      /**
       * This row was already refused once for asserting text the captured
       * trees do not render. A second strict pass would refuse it again for
       * the same reason — the page it needs was never captured — so the
       * tree-grounding lint is `weak` for this call: the flow is handed over
       * with the note, and the RUN proves or dead-ends the wording against
       * the real page. Set by the catalog's resume for refused rows only.
       */
      lenientGrounding?: boolean | undefined;
      /**
       * The case's own words, separated from the retrieved background. What
       * decides whether this is a claim about WORDING — see
       * `wordingClaimAssertsDataValue`.
       */
      caseText?: string | undefined;
      /**
       * The row's Test data already split one pair per line by the parser
       * (`testDataPairs` in `catalog/test-case-table.ts`, CG-02), handed to
       * the value resolver so it never re-splits a packed line itself. Absent,
       * the pairs are read back out of the described case's own `Test data:`
       * block, which the parser rendered one per line for exactly this.
       */
      testDataPairs?: readonly TestDataPair[] | undefined;
      /** The row's case id — a typed value equal to it is a key the run makes unique (CG-13). */
      caseId?: string | undefined;
      /** The catalog run's key, the source of that uniqueness suffix. */
      runKey?: string | undefined;
      /**
       * What "today" is for the relative-date source (CG-06). Decided once per
       * run by the caller so a resume computes the same dates; the wall clock
       * when absent.
       */
      now?: Date | undefined;
      /** This row's personas, overriding the author-wide map — see `AuthorRequest.personas`. */
      personas?: Readonly<Record<string, { email: string; password: string }>> | undefined;
    } = {},
  ): Promise<AuthoredFlow> {
    const trimmed = prompt.trim();
    if (trimmed === '') throw new AuthoringError('prompt is empty — describe the test you want');
    const personas = extra.personas ?? this.#personas;
    // A case whose Expected lines are all `[RECORD ONLY]` has no oracle: the
    // no-assertion and vacuity refusals below stand down for it, and the flow
    // is handed over as observations marked for a person's review (CG-09).
    const observeOnly = extra.caseText !== undefined && recordOnlyCase(extra.caseText);
    // The journey capture ranked against THIS row's request. It is per-row
    // evidence already (each case captures its own destination), so unlike the
    // start tree there is no shared prompt prefix to preserve — and a dense
    // destination page otherwise bills every row for controls its claim never
    // mentions. The label line is always kept (which page this is IS the
    // evidence), the cut is disclosed inside the tree text, and under the cap
    // nothing changes. The narrowed text is also what the grounding lints
    // read, so the model and the lints see one tree, never two.
    const rawJourneyTree = extra.journeyTree ?? this.#journeyTree;
    const journeyTree =
      rawJourneyTree === undefined
        ? undefined
        : focusTreeText(rawJourneyTree, trimmed, journeyTreeMaxLines(), 1, STRUCTURAL_EVIDENCE_LINE).text;

    const startedMs = Date.now();
    const url = page?.url();
    if (page) this.#onLog?.(`reading ${url}…`);
    const axTree = page ? await captureAxTree(page, this.#maxAxNodes) : undefined;
    // What the grounding lints may treat as evidence: EVERY tree the model was
    // given, not only the start page's. A journey tree carries the destination
    // page's `url=` attributes and roles, and a lint that ignored it refused —
    // three times running, live — an expectUrl the queue's own Review link
    // grounded, on the row the capture had been added to help.
    const evidenceTree =
      axTree === undefined && journeyTree === undefined
        ? undefined
        : [axTree ?? '', journeyTree ?? ''].filter((t) => t !== '').join('\n');

    // Opt-in: it clicks the page's disclosures, which costs a second or two and
    // is a mutation of on-screen state even though it never submits anything.
    let interactions: string | undefined;
    if (page && this.#probe) {
      this.#onLog?.('opening menus and disclosures to see what they reveal…');
      const report = await probeInteractions(page, { maxProbes: this.#maxProbes });
      for (const warning of report.warnings) this.#onLog?.(`probe: ${warning}`);
      const formatted = formatProbeReport(report);
      if (formatted) {
        interactions = formatted;
        this.#onLog?.(`found ${report.probes.length} disclosure(s) with hidden controls`);
      }
    }

    // Author → repair → validate → re-ask, in cost order, like the ladder:
    // a $0 mechanical fix first, one *informed* re-ask second (the healer's
    // rule — the value of a retry is entirely in knowing what was refused),
    // and only then the loud refusal, which `runCases` scores as blocked
    // rather than failed.
    // Seeded with the risk judge's prior reasons when the caller has them
    // (S6): the first ask then already authors AGAINST "the search box starts
    // disabled" instead of discovering it in a dead-ended run.
    const feedback: string[] = [...(extra.priorFeedback ?? [])];
    // Read once, before the first attempt: what this suite has already been
    // refused for. A row authored while nothing has been refused yet sends
    // nothing, which is byte-for-byte the prompt it always had.
    const recalled = this.#recalledRefusals();
    if (recalled.length > 0) {
      this.#onLog?.(
        `carrying ${recalled.length} rule(s) this suite has already been refused for into the first attempt`,
      );
    }
    let result!: Awaited<ReturnType<FlowAuthorModel['author']>>;
    // Every attempt that was refused ONLY for being thin, kept in case the
    // budget runs out with nothing better. See `AuthoringErrorSeverity`: the
    // alternative to handing one of these over is handing over nothing, and
    // nothing is the worse answer whenever the refusal was about weakness
    // rather than falsehood.
    let weak: { result: typeof result; note: string } | null = null;
    let accepted = false;
    let lastRefusal: AuthoringError | null = null;
    // The fatal refusal shapes of the previous attempt — see the guard in
    // the catch below. Null when the previous attempt was not refused fatally.
    let previousShapes: Set<string> | null = null;
    // The cases of the last refused attempt, when it had several: the re-ask
    // then rewrites only what the refusal names and the rest is kept as is.
    let priorCases: AuthoredCase[] | undefined;
    const authoringStartedMs = Date.now();
    let acceptedOnAttempt = 0;
    for (let attempt = 1; attempt <= this.#attempts; attempt += 1) {
      const retry = attempt > 1;
      const model = retry && this.#retryModel !== undefined ? this.#retryModel : this.model;
      // One marker per attempt, the repair loop's shape, so a reader finds
      // where a re-ask began without reading the refusal above it twice.
      this.#onLog?.(`\n— authoring attempt ${attempt}/${this.#attempts} —`);
      this.#onLog?.(
        !retry
          ? `asking the generator role to write the flow…`
          : `asking again with the refusal as feedback (attempt ${attempt}/${this.#attempts}` +
              (model === this.model ? '' : `, on the retry model`) +
              (priorCases === undefined ? '' : `, rewriting only the refused case(s) of ${priorCases.length}`) +
              ')…',
      );
      // The repository section is the first attempt's grounding for the
      // whole flow; a re-ask fixes a named mistake and pays for it in
      // latency. Dropped on retries unless the run says to keep it.
      const keepContext = (process.env['WOWLIDATOR_AUTHOR_RETRY_CONTEXT'] ?? '').trim() === 'keep';
      const projectContext = retry && !keepContext ? undefined : (extra.projectContext ?? this.#projectContext);
      result = await model.author({
        prompt: trimmed,
        url,
        axTree,
        interactions,
        policy: this.#policy,
        ...(this.#tables?.length ? { tables: this.#tables } : {}),
        ...(this.#backend ? {} : { backend: false }),
        ...(projectContext ? { projectContext } : {}),
        ...(priorCases === undefined ? {} : { priorCases }),
        ...(extra.caseText === undefined ? {} : { singleCase: true }),
        ...(this.#credentials ? { credentials: this.#credentials } : {}),
        // Per call first (a catalog row names its own personas), the author-wide
        // map otherwise. Labels and emails only reach the prompt.
        ...(personas === undefined ? {} : { personas }),
        ...(journeyTree ? { journeyTree } : {}),
        ...(this.#scope ? { scope: this.#scope } : {}),
        ...(feedback.length > 0 ? { feedback } : {}),
        // What earlier rows of this suite were refused for. Sent on every
        // attempt: the rules do not stop applying once this row has its own
        // refusal to fix.
        ...(recalled.length > 0 ? { commonRefusals: recalled } : {}),
      });
      if (priorCases !== undefined) {
        const merged = mergePriorCases(result, priorCases);
        if (merged.kept > 0) {
          this.#onLog?.(
            `kept ${merged.kept} case(s) from the previous attempt verbatim; the model rewrote ${merged.rewritten}`,
          );
        }
        priorCases = undefined;
      }
      // The safety net for the prompt's rule: a row the model still split is
      // folded back into one case, in the model's order. Sub-cases were
      // written to each start from setup, so the fold logs what it did — a
      // step that then fails on page state is the model's split showing.
      if (extra.caseText !== undefined && result.cases !== undefined && result.cases.length > 1) {
        this.#onLog?.(
          `the model split this row into ${result.cases.length} case(s) — folded back into one; a row is one case`,
        );
        result.steps = result.cases.flatMap((one) => one.steps);
        result.cases = [{ name: result.name, steps: result.steps }];
      }
      const caseCount = result.cases?.length ?? 1;
      this.#onLog?.(
        `got ${result.steps.length} step(s)` +
          (caseCount > 1 ? ` in ${caseCount} discrete case(s)` : '') +
          (result.droppedSteps > 0 ? `, ${result.droppedSteps} dropped` : ''),
      );
      for (const drop of result.dropped ?? []) {
        this.#onLog?.(`  dropped  ${drop.action}${drop.intent ? ` "${drop.intent.slice(0, 60)}"` : ''} — ${drop.reason}`);
      }
      // A step rewritten instead of dropped is disclosed the same way, and on
      // the flow's notes: the report reads what was substituted for what.
      if ((result.substituted?.length ?? 0) > 0) {
        for (const sub of result.substituted ?? []) {
          this.#onLog?.(`  substituted  ${sub.action}${sub.intent ? ` "${sub.intent.slice(0, 60)}"` : ''} — ${sub.how}`);
        }
        const note =
          `${result.substituted!.length} step(s) rewritten by the harness (marked [generated: …] in their intent): ` +
          result.substituted!.map((sub) => `${sub.action}${sub.intent ? ` "${sub.intent.slice(0, 50)}"` : ''} → ${sub.how}`).join('; ');
        result.notes = result.notes === '' ? note : `${result.notes}; ${note}`;
      }

      // $0 repair before any judgement: when the flow itself names its
      // sign-in page, a persona switch that forgot to navigate back to it is
      // a mechanical omission with exactly one fix, and the system applying
      // it (disclosed, never silent) beats refusing the case or re-asking a
      // model to type a `goto` we already know.
      const signInUrl = findSignInUrl([...(result.setup ?? []), ...result.steps]);
      if (signInUrl !== null) {
        const setup = result.setup ?? [];
        const repaired = groundCredentialFills(setup, result.steps, signInUrl);
        if (repaired.grounded > 0) {
          result.steps = repaired.steps;
          if (result.cases?.length) {
            result.cases = result.cases.map((one) => ({
              ...one,
              steps: groundCredentialFills(setup, one.steps, signInUrl).steps,
            }));
          }
          this.#onLog?.(
            `inserted ${repaired.grounded} sign-in navigation(s) before stranded credential fill(s) — ` +
              'the model switched identity without returning to the sign-in page',
          );
          result.notes =
            `${result.notes}${result.notes ? ' ' : ''}wowlidator inserted ${repaired.grounded} ` +
            `goto(s) to ${signInUrl} before credential fills that had no sign-in page to run against.`;
        }
      }

      // $0 repair, the same move for the VALUE: a sign-in block for the
      // supplied account that types a different password can only be an
      // invention (be100: 19 of 107 flows, each a whole red run). Mutates the
      // step objects in place, so the case lists see it too.
      if (this.#credentials) {
        const corrected = groundCredentialValues(
          [...(result.setup ?? []), ...result.steps],
          this.#credentials,
        );
        if (corrected > 0) {
          this.#onLog?.(
            `replaced ${corrected} invented credential value(s) with the supplied account's — ` +
              'the model typed a password of its own for the sign-in it was given',
          );
          result.notes =
            `${result.notes}${result.notes ? ' ' : ''}wowlidator replaced ${corrected} ` +
            'credential value(s) the model invented with the supplied sign-in password.';
        }
      }

      // $0 repair, the same move for a PERSONA the run holds (CG-05, EH-10): a
      // sign-in the model typed for a known account becomes one `signIn` by
      // label — the email names the label, so the fix is a lookup, and the
      // password the model typed (invented or not) leaves the flow file.
      if (personas !== undefined && Object.keys(personas).length > 0) {
        const setupFix = groundPersonaSignIns(result.setup ?? [], personas);
        const bodyFix = groundPersonaSignIns(result.steps, personas);
        const replaced = setupFix.replaced + bodyFix.replaced;
        if (replaced > 0) {
          result.setup = setupFix.steps;
          result.steps = bodyFix.steps;
          if (result.cases?.length) {
            result.cases = result.cases.map((one) => ({ ...one, steps: groundPersonaSignIns(one.steps, personas).steps }));
          }
          this.#onLog?.(
            `replaced ${replaced} typed sign-in block(s) with signIn by persona label — the run holds ` +
              'those credentials, and a flow file must never carry a password',
          );
          result.notes =
            `${result.notes}${result.notes ? ' ' : ''}wowlidator replaced ${replaced} typed sign-in ` +
            'block(s) with signIn steps naming the persona label.';
        }
      }

      // A flow that switches personas is an end-to-end test whatever scope
      // was asked for (`Flow.scope` is stamped where the flow is assembled),
      // and every switch must travel the application's own sign-out path —
      // the prompt asks for a signOut step there; this is the guarantee.
      // After `groundCredentialFills`, so a stranded block has its goto by
      // the time this looks for where the signOut belongs.
      {
        const personas = switchesPersona(result.setup ?? [], result.steps);
        if (personas.length > 1) {
          const fixed = groundPersonaSwitches(result.setup ?? [], result.steps);
          let insertedTotal = fixed.inserted;
          if (fixed.inserted > 0) result.steps = fixed.steps;
          if (result.cases?.length) {
            result.cases = result.cases.map((one) => {
              const perCase = groundPersonaSwitches(result.setup ?? [], one.steps);
              if (perCase.inserted === 0) return one;
              insertedTotal += perCase.inserted;
              return { ...one, steps: perCase.steps };
            });
          }
          this.#onLog?.(
            `the flow switches persona (${personas.join(' → ')}) — an end-to-end journey; marked so`,
          );
          if (insertedTotal > 0) {
            this.#onLog?.(
              `inserted ${insertedTotal} signOut step(s) before persona switches — a switch must ` +
                "travel the application's own sign-out path, not fill a form the app hides from " +
                'signed-in users',
            );
            result.notes =
              `${result.notes}${result.notes ? ' ' : ''}wowlidator inserted ${insertedTotal} ` +
              'signOut step(s) before persona switches, so each re-login starts from the ' +
              "application's own signed-out state.";
          }
        }
      }

      // Same move for a consent accept the model placed after the first
      // post-login navigation or assertion — the assertion would run against
      // the gate and the accept would strand the run on the app's home page
      // (PL_02_09, docs/consent-gate-recovery-spec.md F3).
      {
        const early = settleConsentEarly(result.steps);
        let movedTotal = early.moved ? 1 : 0;
        if (early.moved) result.steps = early.steps;
        if (result.cases?.length) {
          result.cases = result.cases.map((one) => {
            const fixed = settleConsentEarly(one.steps);
            if (fixed.moved) movedTotal += 1;
            return fixed.moved ? { ...one, steps: fixed.steps } : one;
          });
        }
        if (movedTotal > 0) {
          this.#onLog?.(
            'moved a consent accept to immediately after the sign-in — it was placed after steps ' +
              'that would have run against the consent gate',
          );
          result.notes =
            `${result.notes}${result.notes ? ' ' : ''}wowlidator moved a consent-accept step to ` +
            'immediately after the sign-in block, so the flow\'s own goto re-navigates after the gate is cleared.';
        }
      }

      // **Values before lints** (2026-09-02). A token the sheet left in place
      // of a value is resolved here — test data, documents/repository, the
      // database, or a flagged stand-in — so `typesPlaceholderToken` below is
      // the backstop for what nothing could answer, not the first word. Never
      // fatal: a stage that throws leaves the steps as authored.
      const skippedStepComplaints: Violation[] = [];
      const pairs = extra.testDataPairs ?? testDataPairsOfCaseText(extra.caseText ?? trimmed);
      if ((this.#valueResolution !== undefined || this.#masterData !== undefined) && result.steps.length > 0) {
        try {
          // The parser's pairs when the caller has them, else the described
          // case's own one-per-line block (CG-02) — either way the resolver
          // never re-splits a packed `Position = 40106337 Job Code = MKB12.12`.
          if (this.#valueResolution !== undefined) {
            const ctx: ValueResolutionContext = {
              caseText: extra.caseText ?? trimmed,
              promptText: trimmed,
              model: this.#valueResolution.model,
              ...(this.#valueResolution.db === undefined ? {} : { db: this.#valueResolution.db }),
              ...(this.#valueResolution.documents === undefined ? {} : { documents: this.#valueResolution.documents }),
              ...((extra.projectContext ?? this.#projectContext) === undefined ? {} : { projectContext: extra.projectContext ?? this.#projectContext }),
              ...(pairs.length > 0 ? { testDataPairs: pairs } : {}),
              ...(extra.caseId === undefined ? {} : { caseId: extra.caseId }),
              ...(extra.runKey === undefined ? {} : { runKey: extra.runKey }),
              ...(extra.now === undefined ? {} : { now: extra.now }),
              onLog: (line) => this.#onLog?.(line),
            };
            const outcome = await resolveValues(result.setup ?? [], result.steps, ctx);
            if (outcome.resolved.length > 0) {
              result.setup = outcome.setup;
              result.steps = outcome.steps;
              const flagged = outcome.resolved.filter((r) => r.source.kind === 'generated');
              const note =
                `${outcome.resolved.length} value(s) resolved before the lints` +
                (flagged.length > 0 ? `; ${flagged.length} GENERATED by the author: ${flagged.map((r) => `${r.need.field}=${r.value}`).join(', ')}` : '');
              result.notes = result.notes === '' ? note : `${result.notes}; ${note}`;
            }
          }
          if (this.#masterData !== undefined) {
            const outcome = await expandMasterDataCodes(result.setup ?? [], result.steps, {
              lookups: this.#masterData.lookups,
              fetch: this.#masterData.fetch,
              appUrl: this.#masterData.appUrl,
              ...(pairs.length > 0 ? { testDataPairs: pairs } : {}),
              onLog: (line) => this.#onLog?.(line),
            });
            if (outcome.expanded.length > 0) {
              result.setup = outcome.setup;
              result.steps = outcome.steps;
              const note = `${outcome.expanded.length} value(s) expanded from master data before the lints`;
              result.notes = result.notes === '' ? note : `${result.notes}; ${note}`;
            }
          }
          {
            const offered = settleOfferedChoices(result.steps);
            if (offered.settled.length > 0) {
              result.steps = offered.steps;
              const note =
                `${offered.settled.length} cell(s) that instruct rather than name a value take the control's ` +
                `first offered option (marked [generated: …]): ${offered.settled.join(', ')}`;
              result.notes = result.notes === '' ? note : `${result.notes}; ${note}`;
              this.#onLog?.(`  ${note}`);
            }
          }
        } catch (error) {
          this.#onLog?.(`value resolution did not run: ${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}`);
        }

        // **A step skipped for want of a value is not skipped if a source has
        // the value.** The skip marker exists for steps that truly cannot be
        // performed; measured on ec10_2x HIR-EC-012 it became the escape hatch:
        // "skipped step 4 (Verify a real Replaced Employee ID): no valid id
        // exists to key in here" — while the database beside the app held
        // hundreds. Then steps 6 and 7 were skipped BECAUSE step 4 was, and
        // the case's claim went untested. So each skipped step's reason is
        // read for the field it lacks, the repo and db sources are asked, and
        // a value they supply goes back to the model as a refusal it must act
        // on — fatal on the first attempts, accepted with a note on the last.
        // Collected here, filed once `refuse` exists below: this block runs
        // before the lint scope that defines it.
        try {
          const supplied = await this.#valuesForSkippedSteps(result.steps, extra.caseText ?? trimmed, trimmed, extra.projectContext);
          for (const found of supplied) {
            skippedStepComplaints.push({
              message:
                `the authored flow "${result.name}" skips step ${found.step} for want of a value, but a source ` +
                `has one: ${found.field} = ${found.value} (${found.source}). Author step ${found.step} with that ` +
                'value, and the steps that were skipped only because it was missing.',
              severity: 'weak',
              note: `step ${found.step} skipped although ${found.field} = ${found.value} was available from ${found.source}`,
            });
          }
        } catch (error) {
          this.#onLog?.(`skipped-step lookup did not run: ${error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)}`);
        }
      }

      try {
        // Every lint runs and every complaint is collected before anything is
        // thrown. Stopping at the first one cost a whole attempt per problem
        // — see `MAX_REPORTED_VIOLATIONS` for the measurement.
        const violations: Violation[] = [];
        const refuse = (
          message: string,
          options: {
            severity?: AuthoringErrorSeverity | undefined;
            note?: string | undefined;
            settle?: (() => string | null) | undefined;
          } = {},
        ): void => {
          violations.push({
            message,
            severity: options.severity ?? 'fatal',
            note: options.note ?? message,
            ...(options.settle === undefined ? {} : { settle: options.settle }),
          });
        };
        violations.push(...skippedStepComplaints);

        // Same bar the generator holds itself to: a flow that asserts nothing
        // passes whether or not the feature works. Refusing is the point —
        // the alternative is handing back a green test that proves nothing.
        if (result.steps.length === 0) {
          throw new AuthoringError(
            'the model produced no usable steps. Try a more specific request, ' +
              'or ground it with --url so it can see the real controls.',
          );
        }
        // A record-only case is the one shape a flow with no assertion is
        // right to be (CG-09): the sheet asks for values to be READ, not
        // checked, so the observations ARE the answer, and a manufactured
        // assertion would be a claim about a value nobody knows.
        const observed = observeOnly ? observationSteps(result.steps).length : 0;
        if (observeOnly && observed > 0 && claimsNothing(result.steps)) {
          const note = `record-only case — the sheet has no oracle; ${observed} observation(s) saved for a person's review`;
          result.notes = result.notes === '' ? note : `${result.notes}; ${note}`;
          this.#onLog?.(note);
        } else if (!hasAssertion(result.steps)) {
          refuse(
            `the authored flow "${result.name}" contains no assertion, so it would pass ` +
              'without proving anything. Restate the request in terms of what should be ' +
              'TRUE afterwards (e.g. "...and the row count shows 8").',
          );
        } else {
          // **A flow whose only assertions are the sign-in proof and a URL is
          // refused as if it asserted nothing** — measured on be100, that
          // exact shape was 20 of 22 `pass**` cases, each green about a row
          // whose Expected Output it never touched. Fatal: on the last
          // attempt the case is blocked (and re-authored on a resume), never
          // handed over as a test that passes whatever the application does.
          const vacuous = vacuousClaim([...(result.setup ?? []), ...result.steps]);
          if (vacuous !== null) {
            refuse(
              `the authored flow "${result.name}" proves nothing about its claim: ${vacuous}. ` +
                'Assert at least one line of the Expected output in the page\'s own terms — ' +
                'the options a dropdown lists, the exact error message, the count the page ' +
                'shows — after the step that reaches it. If that page is in no tree you were ' +
                'given, reach it with a precisely-goaled workflow step and assert what it then ' +
                'shows; if the assertion is impossible, say so in notes rather than omitting it.',
            );
          }
        }
        // Steps the model wrote that could not run ride along as a weak
        // complaint: alone they are a note; beside a refusal they are the
        // reason the refusal exists, and the re-ask must know what to fix.
        if ((result.dropped?.length ?? 0) > 0) {
          const list = (result.dropped ?? [])
            .slice(0, 6)
            .map((d) => `${d.action}${d.intent ? ` ("${d.intent.slice(0, 50)}")` : ''}: ${d.reason}`)
            .join('; ');
          refuse(
            `${result.dropped!.length} step(s) you wrote were dropped before they could run — ${list}. ` +
              'Rewrite each in a form the harness accepts.',
            { severity: 'weak', note: `${result.dropped!.length} step(s) dropped on narrowing: ${list}` },
          );
        }

        // A prompt instruction is a request; this filter is the guarantee.
        // Reaching it means the mechanical repair could not apply — the flow
        // never named a sign-in page to return to.
        const strandedAt = strandedCredentialFill([...(result.setup ?? []), ...result.steps]);
        if (strandedAt !== null) {
          refuse(
            `the authored flow "${result.name}" fills a credential field without first ` +
              `navigating to a sign-in page (step ${strandedAt}). A login form only exists ` +
              'on the sign-in page — add a goto to it before the fill (and before every ' +
              'persona switch), or the fill runs against whatever page came before.',
          );
        }

        const dbGap = dbClaimWithoutDbCheck(
          trimmed,
          [...(result.setup ?? []), ...result.steps],
          (this.#tables?.length ?? 0) > 0,
        );
        if (dbGap === 'unused') {
          refuse(
            `the authored flow "${result.name}" is for a claim that compares something to the ` +
              'database, the declared tables were provided, and yet no expectDbRow / ' +
              'expectDbCount / expectDbDelta step exists anywhere in it. Assert the comparison ' +
              'against the database itself (save the number with a request, compare with ' +
              'expectDbCount) — a case that only checks the value exists passes whether or not ' +
              'the numbers agree.',
          );
        }
        if (dbGap === 'no-schema') {
          // Aimed at the person, not the model: no re-ask can conjure an
          // inventory, so the informed retry would burn a call to be refused
          // for the same reason. Refusing is the honest outcome — the case is
          // reported blocked rather than passing on a UI proxy for a database
          // claim nobody checked.
          refuse(
            `the authored flow "${result.name}" is for a claim that compares something to the ` +
              'database, but no database schema is indexed — so no DB check can be written and ' +
              'any that were emitted have been dropped. This case cannot be proven as stated. ' +
              'Index the application\'s schema and select it for the run:\n' +
              '  wowlidator context add <app repo> --db-schema <schema.sql>\n' +
              '  …then pass --repo <slug> to this run.\n' +
              'Check the selected repository is the application under test — a repo with no ' +
              'table nodes silently removes every database claim from the suite.',
          );
        }

        // **Before the wording lint**, which otherwise catches an undefined
        // placeholder incidentally and blames it on a data row — the
        // misdiagnosis that made three PL_02 rows rename the placeholder
        // instead of removing it. A placeholder is diagnosed as a placeholder.
        const unsaved = undefinedVariableRef([...(result.setup ?? []), ...result.steps]);
        if (unsaved !== null) {
          refuse(
            `the authored flow "${result.name}" reads {{${unsaved.name}}} (step ${unsaved.index}), ` +
              'but nothing in the flow ever saves that variable — the step asserts an unresolvable ' +
              'placeholder and fails on every run. ' +
              (unsaved.available.length > 0
                ? `Saved in this flow: ${unsaved.available.map((n) => `{{${n}}}`).join(', ')}. `
                : 'This flow saves no variables at all. ') +
              'Either save the reading first (saveText/saveCount with the VARIABLE NAME in "value", ' +
              'or a request step\'s save map) and compare against it, or drop the placeholder and ' +
              'assert the literal value quoted from the test case, its Note, the documents or the ' +
              'repository. Never invent a value.',
          );
        }

        const wordingOnData = wordingClaimAssertsDataValue(
          trimmed,
          [...(result.setup ?? []), ...result.steps],
          evidenceTree ?? '',
          extra.projectContext ?? this.#projectContext,
          extra.caseText,
        );
        if (wordingOnData !== null) {
          refuse(
            `the authored flow "${result.name}" is for a claim about the page's WORDING, yet ` +
              `step ${wordingOnData.index} asserts "${wordingOnData.value}" — a value the test case ` +
              'never states and that the page shows only as a data row, if at all. A row is data, ' +
              'not spec: it can be deleted or renamed by another case and the assertion fails against ' +
              'a correctly worded page. Assert the labels the spec owns — the heading, breadcrumb, ' +
              "column headers, button and filter labels — quoting each from the test case's words or " +
              'from a heading/label node of the tree.',
          );
        }

        // The case's own script, carried out — see `skipsAuthoredScript`. Only
        // the BODY counts: a sign-in's fills are preparation, never the case.
        const skipped =
          extra.caseText === undefined ? null : skipsAuthoredScript(extra.caseText, result.steps);
        if (skipped !== null) {
          refuse(
            `the authored flow "${result.name}" never performs the ${skipped.tier} its case scripts: the ` +
              `case's Steps say ${JSON.stringify(skipped.demanded)}, and the flow's body has nothing that ` +
              `performs it — what counts is ${describeScriptDemand(skipped.tier)} — it opens the page ` +
              'and asserts that things exist. A case is about what the system does AFTER its steps are ' +
              "carried out, so a page that merely exists proves nothing either way. Carry out the case's numbered " +
              "steps in order, with the Test data's own values, then assert the Expected output on the " +
              'result. If a step truly cannot be performed here, say so in the step intent rather than ' +
              'dropping it.',
            {
              // The last word: the unperformed script lines of that tier are
              // performed from the tree, or handed to an agent leg in the
              // sheet's own words — never left silently unperformed.
              settle: () =>
                settleScriptDemand(
                  result,
                  extra.caseText ?? trimmed,
                  skipped.tier,
                  [evidenceTree, interactions].filter((t): t is string => typeof t === 'string').join('\n'),
                  extra.testDataPairs ?? testDataPairsOfCaseText(extra.caseText ?? trimmed),
                ),
            },
          );
        }

        const readOnlyFill = fillsReadOnlyNode([...(result.setup ?? []), ...result.steps], evidenceTree);
        if (readOnlyFill !== null) {
          const input = readOnlyFill.input;
          refuse(
            `the authored flow "${result.name}" fills textbox ${JSON.stringify(readOnlyFill.name)} (step ` +
              `${readOnlyFill.index}), which the tree marks READONLY — that is the picker's display, not its ` +
              'input, and a fill there waits out its timeout and enters nothing. ' +
              (input !== null
                ? `The input is the same field under another role — the tree names it ${input.role} ` +
                  `${JSON.stringify(input.name)}: write \`role=${input.role}[name=${JSON.stringify(input.name)} i]\`, ` +
                  'and give a date input its value as YYYY-MM-DD.'
                : "The input is the textbox named by the field's LABEL" +
                  (readOnlyFill.writable.length > 0
                    ? ` — the tree offers: ${readOnlyFill.writable.map((w) => JSON.stringify(w)).join(', ')}`
                    : '') +
                  '. Fill that one, and give a date input its value as YYYY-MM-DD.'),
            input === null
              ? {}
              : {
                  // The tree holds the answer, so the last word performs it
                  // rather than losing the flow over a selector.
                  settle: () => {
                    const all = [...(result.setup ?? []), ...result.steps];
                    const step = all[readOnlyFill.index];
                    if (step === undefined || !('selector' in step)) return null;
                    const rewritten = entryStepFor(input, (step as { value?: string }).value ?? '', '');
                    if (rewritten === null || !('selector' in rewritten)) return null;
                    (step as { selector: string }).selector = (rewritten as { selector: string }).selector;
                    (step as { intent?: string }).intent = markGenerated(
                      (step as { intent?: string }).intent,
                      `repointed to ${input.role} ${JSON.stringify(input.name)} — the textbox of that name is the picker's read-only display`,
                    );
                    return `step ${readOnlyFill.index} repointed to the field's real input, ${input.role} ${JSON.stringify(input.name)}`;
                  },
                },
          );
        }

        const token = typesPlaceholderToken([...(result.setup ?? []), ...result.steps]);
        if (token !== null) {
          refuse(
            `the authored flow "${result.name}" ${token.action}s the literal token ${JSON.stringify(token.token)} ` +
              `(step ${token.index}) — that is the sheet's PLACEHOLDER for a value the tester supplies, not the ` +
              'value. Resolve it: from the Test data when it names the real value, from the run\'s own ' +
              'credentials for an account, and for a NON_EXISTING / INVALID token from the format the case ' +
              'states — a well-formed value of exactly that format (its digit count, its leading digit) that no record can carry. ' +
              'Typing the token tests the API\'s handling of angle brackets, which is not the case.',
          );
        }

        // The whole script, through its last step — see `unperformedScriptSteps`.
        const unperformed =
          extra.caseText === undefined ? null : unperformedScriptSteps(extra.caseText, result.steps);
        if (unperformed !== null) {
          refuse(
            `the authored flow "${result.name}" performs the case's script only through step ` +
              `${unperformed.performedThrough} of ${unperformed.total} — it never reaches: ` +
              unperformed.missing.map((m) => `${m.n}. ${m.text}`).join(' · ') +
              ". The case's claim lives in its LAST steps (Submit, then the profile check); a flow that " +
              'stops early has verified a form and proved nothing about the outcome. Author every numbered ' +
              'step, citing it in the intent ("Step 5: …"); a step that truly cannot be performed here gets a ' +
              'step whose intent says "skipped step N: <why>", so the gap is visible.',
            {
              // The last word: the covered steps run, and the uncovered script
              // steps are named as NOT COVERED on the flow — a partial script
              // proved is more than no run, and the note keeps it honest.
              settle: () =>
                `not covered: script step(s) ${unperformed.missing.map((m) => `${m.n} (${m.text.slice(0, 60)})`).join(', ')} — ` +
                `no authored step performs them; the flow performs the script through step ${unperformed.performedThrough} of ${unperformed.total}`,
            },
          );
        }

        const openQuestion = assertsOpenQuestion([...(result.setup ?? []), ...result.steps], extra.caseText);
        if (openQuestion !== null) {
          refuse(
            `the authored flow "${result.name}" asserts ${JSON.stringify(openQuestion.value)} ` +
              `(step ${openQuestion.index}), but ${openQuestion.marker} is the test case's marker for an ` +
              'OPEN QUESTION — a value nobody has answered yet, which the case asks the tester to READ ' +
              'off the run and send to BA/SA. It is not text the application renders, so the assertion ' +
              'can only fail. Assert what the case does state, and leave the open question to the run: ' +
              'take the surrounding fact (the field exists, the notice appears) rather than the id.',
            {
              // The last word: the step is removed, named as not covered —
              // unless it is the only assertion, when the refusal stands.
              settle: () => {
                const all = [...(result.setup ?? []), ...result.steps];
                const step = all[openQuestion.index];
                if (step === undefined) return null;
                const rest = result.steps.filter((s) => s !== step);
                if (!hasAssertion(rest)) return null;
                removeStep(result, step);
                return `not covered: the step asserting ${JSON.stringify(openQuestion.value)} was removed — ${openQuestion.marker} names an open question, not a value the page renders`;
              },
            },
          );
        }

        // An unconfirmed Test data value (`= ? รอตาราง…`, an instruction to
        // decide before executing) is never typed, never handed to the agent
        // and never asserted — the sheet has no value, and a value the model
        // chose for it is an invention wearing the sheet's field name
        // (ec09 HIR-EC-009, 2026-09-03).
        const dataPairs = extra.testDataPairs ?? testDataPairsOfCaseText(extra.caseText ?? trimmed);
        const unconfirmedUse = usesUnconfirmedValue(result.setup ?? [], result.steps, dataPairs);
        if (unconfirmedUse !== null) {
          refuse(
            `the authored flow "${result.name}" ${unconfirmedUse.how} (${unconfirmedUse.section} step ${unconfirmedUse.index}), but ` +
              `the case's Test data says ${JSON.stringify(`${unconfirmedUse.key} = ${unconfirmedUse.value}`)} — an UNCONFIRMED value: ` +
              'nobody has decided it yet, so there is nothing to type, choose or assert for that field. Drop it from the ' +
              'fill, the workflow goal or the assertion; write the scripted step for it as a step whose intent says ' +
              `"skipped step N: unconfirmed test data — ${unconfirmedUse.key}", and carry on with the fields that have values.`,
          );
        }
        const unconfirmedAll = dataPairs.filter((pair) => unconfirmedValue(pair.value));
        if (unconfirmedAll.length > 0) {
          const note =
            `unconfirmed test data, never typed or asserted: ${unconfirmedAll.map((pair) => `${pair.key} = ${pair.value}`).join('; ')}`;
          if (!result.notes.includes('unconfirmed test data')) result.notes = result.notes === '' ? note : `${result.notes}; ${note}`;
        }

        const wrongMethod = unindexedRequestMethod(
          [...(result.setup ?? []), ...result.steps],
          this.#declaredOperations,
        );
        if (wrongMethod !== null) {
          refuse(
            `the authored flow "${result.name}" calls ${wrongMethod.method} ${wrongMethod.path}, but the ` +
              `application declares that path only as ${wrongMethod.declared.join(', ')}. A handler with no ` +
              `${wrongMethod.method} answers 405 Method Not Allowed — a refusal of the request, never a finding ` +
              'about the application. Use one of the declared methods, or read the value from the page or the ' +
              'database instead of inventing a read endpoint.',
          );
        }

        const foreignHost = foreignAuthoredHost(
          [...(result.setup ?? []), ...result.steps],
          url,
        );
        if (foreignHost !== null) {
          refuse(foreignHostRefusal(result.name, foreignHost));
        }

        const invented = ungroundedGoto(
          [...(result.setup ?? []), ...result.steps],
          this.#declaredRoutes,
          url,
        );
        if (invented !== null) {
          refuse(
            `the authored flow "${result.name}" navigates to "${invented.url}" (step ${invented.index}), ` +
              'but the application\'s own codebase declares no route for that path — the page does not ' +
              'exist, and every step after the navigation would be run against a 404. ' +
              (invented.near.length === 0
                ? 'Take the destination from a link in the tree, or reach it by clicking as a user would.'
                : `The nearest routes it does declare: ${invented.near.join(', ')}. Use one of those, ` +
                  'or reach the page by clicking as a user would.'),
          );
        }

        const loginProof = loginProofAssertsLoginPage([...(result.setup ?? []), ...result.steps]);
        if (loginProof !== null) {
          refuse(
            `the authored flow "${result.name}" tries to prove the login took effect by ` +
              `expecting the URL to contain a sign-in path (step ${loginProof}) — an assertion ` +
              'that holds precisely when the login did NOT happen. Expect a non-login path, or ' +
              'expectVisible something only a signed-in page shows.',
          );
        }

        // **$0 mechanical repair before the lint**, the `groundCredentialFills`
        // move: the vacuous login proof (`expectUrl "/en/"` after a sign-in
        // from /en/login) was refused on nearly every row of every measured
        // run, and every refusal cost a full authoring call to learn what a
        // string replacement knows. The submit control the flow itself just
        // clicked is the honest witness: still on the page, the sign-in did
        // not take (a native GET resubmit leaves the form standing); gone, it
        // did — on the landing page and on a consent gate alike, and the goto
        // plus who-is-signed-in assertion that follow settle the rest.
        const grounded = groundLoginProof(
          result.setup ?? [],
          result.steps,
          `${evidenceTree ?? ''}\n${trimmed}`,
        );
        if (grounded !== null) {
          this.#onLog?.(`login proof grounded: ${grounded}`);
          result.notes = result.notes === '' ? grounded : `${result.notes}; ${grounded}`;
        }

        // A check generated out of the scope of the test is re-judged for
        // necessity before it can cost anything: an assertion that a
        // credential the flow itself typed is DISPLAYED came from the input
        // side of the test, not from the claim and not from the page, and it
        // fails on every run against a working application (PL_02_02: 42s of
        // ladder, patience, healer and reconstruction to disprove a string
        // the tree never contained, then a high defect). When the claim's own
        // assertions carry the proof, the echo is unnecessary and dropped —
        // the `groundCredentialFills` move, $0, disclosed, never silent. Only
        // when the echo is ALL the proof there is does it earn the informed
        // re-ask.
        {
          const typed = typedCredentialValues(result.setup ?? [], result.steps);
          const setupEchoes = credentialEchoAssertions(result.setup ?? [], typed, evidenceTree ?? '');
          const bodyEchoes = credentialEchoAssertions(result.steps, typed, evidenceTree ?? '');
          if (setupEchoes.length + bodyEchoes.length > 0) {
            const bodyKept = result.steps.filter((_, i) => !bodyEchoes.includes(i));
            if (bodyEchoes.length > 0 && !hasAssertion(bodyKept)) {
              refuse(
                `the authored flow "${result.name}" proves itself only by expecting a ` +
                  'credential the flow itself typed to be displayed on the page. A credential ' +
                  'is input, not expected output — an application signs in with an email but ' +
                  'renders a display name, role label or user id in its chrome, so this ' +
                  'assertion fails on every run against a working application. Assert what the ' +
                  'claim asks for, quoting text a tree actually shows.',
              );
            } else {
              const droppedDescs = [
                ...setupEchoes.map((i) => (result.setup ?? [])[i]),
                ...bodyEchoes.map((i) => result.steps[i]),
              ].map((s) => `${s!.action} ${(s as { selector: string }).selector}`);
              result.setup = (result.setup ?? []).filter((_, i) => !setupEchoes.includes(i));
              result.steps = bodyKept;
              if (result.cases?.length) {
                result.cases = result.cases.map((one) => {
                  const echoes = credentialEchoAssertions(one.steps, typed, evidenceTree ?? '');
                  if (echoes.length === 0) return one;
                  const kept = one.steps.filter((_, i) => !echoes.includes(i));
                  // A case whose only proof is the echo keeps it — the
                  // body-level refusal above is where that shape is judged.
                  return hasAssertion(kept) ? { ...one, steps: kept } : one;
                });
              }
              const droppedNote =
                `wowlidator dropped ${droppedDescs.length} out-of-scope check(s) asserting a ` +
                `credential the flow itself typed (${droppedDescs.join('; ')}) — a credential ` +
                'is input, not expected output; the page renders a name, role or id, never the ' +
                "sign-in email, and the claim's own assertions carry the proof.";
              this.#onLog?.(droppedNote);
              result.notes = result.notes === '' ? droppedNote : `${result.notes}; ${droppedNote}`;
            }
          }
        }

        const weakProof = loginProofCannotFail([...(result.setup ?? []), ...result.steps]);
        if (weakProof !== null) {
          refuse(
            `the authored flow "${result.name}" proves the login by expecting the URL to ` +
              `contain "${weakProof.expected}" (step ${weakProof.index}) — but it signed in from ` +
              `"${weakProof.loginUrl}", which already contains that. expectUrl asserts CONTAINS, ` +
              'so this assertion holds just as well when the sign-in was rejected and the page ' +
              'never moved. Expect a path the login page does not contain (the landing route ' +
              'itself), or expectVisible something only a signed-in page shows.',
          );
        }

        const unsynchronized = unsynchronizedLoginSubmit([...(result.setup ?? []), ...result.steps]);
        if (unsynchronized !== null) {
          refuse(
            `the authored flow "${result.name}" clicks a sign-in submit (step ${unsynchronized}) ` +
              'and navigates away on the very next step, with nothing checking the login took ' +
              'effect. A click can land before the application hydrates — the form then submits ' +
              'natively and no session exists. Between the submit click and the next goto, add ' +
              'an expectUrl of a non-login path or an expectVisible of something only a ' +
              'signed-in page shows.',
          );
        }

        const inventedUrl = ungroundedUrlExpectation(result.steps, evidenceTree, this.#declaredRoutes);
        if (inventedUrl !== null) {
          refuse(
            `the authored flow "${result.name}" expects the URL to contain ` +
              `"${inventedUrl.expected}" (step ${inventedUrl.index}), but that fragment ` +
              "appears in none of the tree's url= attributes and in no goto of the flow — " +
              'it reads like a path derived from a label. Take the expected URL from the ' +
              'url= of the control being clicked, or assert visible content of the ' +
              'destination instead.',
          );
        }

        // Weak, not false — so it earns the re-ask and then gets out of the way.
        // The one WEAK refusal in this file: it describes a claim that is thin,
        // not one that is false. It is thrown like every other lint — the
        // re-ask is where the value is — and the attempt loop is what decides
        // that a flow refused only for this is still worth handing over when
        // the budget runs out. That decision used to live here as an
        // `attempt < AUTHOR_ATTEMPTS` special case; it belongs to the loop,
        // which is the only place that can see every attempt.
        const unsettled = unsettledWorkflowClaim(result.steps);
        if (unsettled !== null) {
          refuse(
            `the authored flow "${result.name}" hands step ${unsettled} to the navigation agent ` +
              'and then checks nothing the agent did. The agent reports its own success and that ' +
              'report is not evidence — an expectUrl afterwards only says which page is open, ' +
              'not that the thing happened. After the workflow step, assert what the page now ' +
              'shows: the record in the list identified by a value the flow itself typed, a ' +
              'count that moved, or the status the application renders for it.',
            {
              severity: 'weak',
              note:
                `step ${unsettled} is handed to the navigation agent and nothing checks what it ` +
                'did — the agent reports its own success, and that report is not evidence. Add ' +
                'an assertion after it about what the page then shows.',
            },
          );
        }

        const pinnedCount = countPinnedName([...(result.setup ?? []), ...result.steps]);
        if (pinnedCount !== null) {
          refuse(
            `the authored flow "${result.name}" pins a live count inside an accessible name — ` +
              `"${pinnedCount.name}" (step ${pinnedCount.index}). That number counts whatever ` +
              'the application holds right now, including rows a previous run or a seed left ' +
              'behind, so the selector resolves on one state of the data and drifts on every ' +
              'other. Match the stable part of the control instead (for a tab, "role=tab >> ' +
              'text=Status"), and prove the record exists by asserting a value THIS flow typed.',
          );
        }

        const volatileCount = volatileCountAssertion(
          [...(result.setup ?? []), ...result.steps],
          trimmed,
        );
        if (volatileCount !== null) {
          refuse(
            `the authored flow "${result.name}" asserts the bare number ` +
              `"${volatileCount.value}" (step ${volatileCount.index}), which the request never ` +
              'states — so it was read off the page, and it counts the data as it stands this ' +
              'minute. Every run that creates or deletes a row moves it, and the assertion rots ' +
              'into a false defect. Anchor the claim to the labeled thing instead (the tile\'s ' +
              'label, a row identified by a value THIS flow typed); when the count itself is ' +
              'the claim and tables are declared, prove it with expectDbCount. A number the ' +
              'request itself states may be asserted exactly.',
          );
        }

        const interrupted = interruptedCredentialSubmit([...(result.setup ?? []), ...result.steps]);
        if (interrupted !== null) {
          refuse(
            `the authored flow "${result.name}" puts step ${interrupted.index} between the ` +
              `credential fields and the submit click at step ${interrupted.click}. Nothing may ` +
              'come between them: the engine recovers a sign-in that landed before the page ' +
              'hydrated by replaying the fill block and the click together, and it only ' +
              'recognises that shape when they are adjacent. Interposed, the click submits the ' +
              'form natively, no session is created, and every later step runs against the ' +
              'sign-in page. Put the assertion AFTER the click.',
          );
        }

        const repeatedSubmit = duplicateCredentialSubmit([
          ...(result.setup ?? []),
          ...result.steps,
        ]);
        if (repeatedSubmit !== null) {
          refuse(
            `the authored flow "${result.name}" clicks the sign-in submit ` +
              `"${repeatedSubmit.selector}" twice (steps ${repeatedSubmit.first} and ` +
              `${repeatedSubmit.repeat}) with nothing re-typed in between. Do not write a retry: ` +
              'the engine already replays a submit that landed before the page hydrated, so by ' +
              'the time the second click runs the login has succeeded and the control is gone — ' +
              'the step fails and reads as a defect in the application. Click the submit once, ' +
              'then assert the login took effect.',
          );
        }

        const unpinnedDate = unpinnedDateEntry(result.setup ?? [], result.steps);
        if (unpinnedDate !== null) {
          refuse(
            `the authored flow "${result.name}" types the date "${unpinnedDate.value}" (step ` +
              `${unpinnedDate.index}) with no clock pinned. Applications gate date fields on a ` +
              'window computed from today — a payroll period, a cut-off, a booking horizon — so ' +
              'this flow passes now and fails on the day the window moves past the date, ' +
              'blaming the field. Add setClock in setup, before the first goto, and choose a ' +
              'date consistent with it.',
          );
        }

        // Only when the person asked for a journey. A single-page flow is not
        // a thinner end-to-end test, it is a different test, and handing one
        // back would answer a question nobody asked — that stays `fatal`. A
        // journey handed to the agent is `weak`: the flow travels, and it
        // proves less than it could. It was fatal once, and measured on a real
        // catalog the refusal fired three times running on a row whose
        // captured journey page was the WRONG page (the ranker's guess), so
        // the model was right to reach for the agent and the row was lost.
        // The workflow step now records the page before and after the agent
        // acted; the note says what to tighten.
        if (this.#scope === 'e2e') {
          const confined = notEndToEnd(result.setup ?? [], result.steps, url);
          if (confined !== null) {
            refuse(
              confined === 'agent-journey'
                ? `the authored flow "${result.name}" was asked for an end-to-end test and ` +
                  'handed the journey to the navigation agent instead of writing it. Write the ' +
                  'steps: navigate to the page the test is about, act on its controls, and ' +
                  'assert on the page that results — the trees you were given include that ' +
                  'page. Keep workflow for a leg no captured tree covers.'
                : `the authored flow "${result.name}" was asked for an end-to-end test but never ` +
                  'leaves the page it starts on. An end-to-end test reaches the page the way a ' +
                  'user reaches it, acts, and verifies on the page that results — navigate, ' +
                  'then assert there.',
              confined === 'agent-journey'
                ? {
                    severity: 'weak',
                    note:
                      'the journey is driven by the navigation agent rather than written as ' +
                      'steps — the workflow step records what the page showed before and ' +
                      'after, and the agent\'s turns are on the report; write the leg as ' +
                      'steps once its page has been captured',
                  }
                : {},
            );
          }
        }

        const codeEvidence = extra.projectContext ?? this.#projectContext;
        const unrendered = ungroundedTextExpectation(result.steps, evidenceTree, codeEvidence, trimmed);
        if (unrendered !== null) {
          refuse(
            `the authored flow "${result.name}" asserts the text ${JSON.stringify(unrendered.text)} ` +
              `(step ${unrendered.index}), but no element in the page's accessibility tree renders it — ` +
              'that is the requirement document\'s wording, and the step will dead-end on every run. ' +
              (unrendered.nearest.length > 0
                ? `The page renders: ${unrendered.nearest.map((n) => JSON.stringify(n)).join(', ')} — quote one of those, with its role from the tree, `
                : 'Quote a name the tree actually shows, with its role, ') +
              'and never the sheet\'s phrasing of it.',
            extra.lenientGrounding
              ? {
                  severity: 'weak',
                  note:
                    `step ${unrendered.index} asserts ${JSON.stringify(unrendered.text)}, which no captured tree renders — ` +
                    'accepted on a resume after a strict refusal so the run can prove or dead-end it against the real page',
                }
              : {
                  // The last word: the assertion stays, marked as ungrounded,
                  // and the RUN proves or dead-ends it — what `lenientGrounding`
                  // does on a resume, one resume earlier.
                  settle: () => {
                    const step = result.steps[unrendered.index];
                    if (step === undefined) return null;
                    annotateStep(
                      step,
                      `text ${JSON.stringify(unrendered.text)} is in no captured tree` +
                        (unrendered.nearest.length > 0 ? `; the page renders ${unrendered.nearest.map((n) => JSON.stringify(n)).join(', ')}` : '') +
                        '; the run settles it',
                    );
                    return `step ${unrendered.index} asserts ${JSON.stringify(unrendered.text)}, which no captured tree renders — handed over marked [generated: …] for the run to prove or dead-end`;
                  },
                },
          );
        }

        // The exclusivity claim is judged ONCE, by `unprovedExclusivity`
        // below (2026-09-04, HIR-EC-001): a second detector here read "only"
        // inside "Read-only" and demanded a count of a set the page does not
        // have — a refusal no flow could satisfy, re-asked three times.

        // Personas (CG-05, EH-10, OA-15): with the run holding the accounts,
        // a login typed by hand is an invention, a label the run lacks is a
        // guaranteed failure at the step, and a goal naming two people is a
        // leg no one session can perform. All fatal — each is a flow that
        // would report something untrue about the sign-in.
        if (personas !== undefined && Object.keys(personas).length > 0) {
          const typed = handTypedPersonaSignIn([...(result.setup ?? []), ...result.steps], personas);
          if (typed !== null) {
            refuse(
              `the authored flow "${result.name}" types a sign-in by hand (step ${typed.index}, value ` +
                `${JSON.stringify(typed.value)}) although the run holds the personas' credentials. Never fill an ` +
                'email or a password and never goto the sign-in page: write ONE signIn step with the persona LABEL ' +
                `in "name" — one of ${Object.keys(personas).join(', ')} — and the harness signs in with the ` +
                'credentials it holds.',
            );
          }
          const unknown = signInAsUnknownPersona([...(result.setup ?? []), ...result.steps], personas);
          if (unknown !== null) {
            refuse(
              `the authored flow "${result.name}" signs in as ${JSON.stringify(unknown.as)} (step ${unknown.index}), ` +
                `a persona the run holds no credentials for. The labels available are: ${unknown.available.join(', ')} — ` +
                'use one of them exactly; when the case needs an account none of them is, say so in "notes" and in ' +
                "the first affected step's intent instead of inventing one.",
            );
          }
        }
        const twoPeople = multiPersonaWorkflow(result.steps);
        if (twoPeople !== null) {
          refuse(
            `the authored flow "${result.name}" hands a workflow step (step ${twoPeople.index}) a goal that names ` +
              `${twoPeople.personas.map((p) => JSON.stringify(p)).join(' and ')} — the agent drives one person's browser at a time. ` +
              'Author it as two legs in the same case: the first persona\'s steps, then a signIn step naming the ' +
              'second label, then that persona\'s own steps (and its assertion); a later signIn naming the first ' +
              'persona returns to their browser with the session kept. Never one goal for both.',
          );
        }

        const delta = unmeasuredDeltaClaim(result.steps, extra.caseText ?? trimmed);
        if (delta !== null) {
          refuse(
            `the case's Expected output claims a number MOVES by a stated amount (${JSON.stringify(delta)}), and the ` +
              'authored flow never measures it. Author it as: saveText (or saveCount) of the very box the line names ' +
              'BEFORE the action into a variable — the NAME in the step\'s "value" (e.g. before_total_plans) — then, after ' +
              'the action, expectText/expectCount on the same box carrying {{before_total_plans+1}} (or -1); the ' +
              'harness computes the arithmetic from the saved reading. The sheet\'s illustrative number is never the value.',
          );
        }

        const recordAsserted = assertsRecordOnlyLine(result.steps, extra.caseText ?? trimmed);
        if (recordAsserted !== null) {
          refuse(
            `the authored flow "${result.name}" asserts Expected line ${recordAsserted.line} (step ${recordAsserted.index}), ` +
              'but that line is marked [RECORD ONLY] — the sheet asks for the value to be READ off the run and sent to ' +
              `BA/SA, not checked. Replace the assertion with saveText into record_${recordAsserted.line.replace(/\./g, '_')} ` +
              '(of the region, when it is a state), cite the line in the intent, and assert only the lines that state a value.',
            {
              severity: 'weak',
              note: `Expected line ${recordAsserted.line} is record-only and was asserted at step ${recordAsserted.index}`,
            },
          );
        }

        const hedged = hedgedAlternatives(result.steps, extra.caseText ?? trimmed);
        if (hedged !== null) {
          refuse(
            `the authored flow "${result.name}" uses expectAnyVisible (step ${hedged}) although the case's Expected output ` +
              'names ONE outcome — no "หรือ", no "or", no กรณี…/กรณี…. Either/or is for a line that accepts alternatives; ' +
              'on a single stated outcome it is a hedge that passes on the defect. Assert the one outcome the line states ' +
              'with expectVisible / expectText.',
            { severity: 'weak', note: `step ${hedged} hedges a single stated outcome with expectAnyVisible` },
          );
        }

        const pageWideError = fieldErrorAssertedPageWide(result.steps, extra.caseText ?? trimmed);
        if (pageWideError !== null) {
          refuse(
            `the case says the error belongs to a FIELD (${JSON.stringify(pageWideError)}), and the authored flow "${result.name}" ` +
              'has no expectFieldError. A page-wide expectText of the message passes when it sits under the wrong field. ' +
              'Write expectFieldError with the field\'s control as the tree names it in "selector" and the quoted message ' +
              'in "value" (or empty for "any error here"); one per field for "ทุกช่อง" / "ว่างทีละช่อง".',
            { severity: 'weak', note: `field-scoped error claim (${pageWideError}) asserted page-wide, no expectFieldError` },
          );
        }

        const unbudgeted = unbudgetedStatusWait(result.steps, extra.caseText ?? trimmed);
        if (unbudgeted !== null) {
          refuse(
            `the case waits for the application to finish something (${JSON.stringify(unbudgeted)}), and no check in the ` +
              `authored flow "${result.name}" declares a wait. Put "timeoutMs" (digits, up to ${MAX_STEP_TIMEOUT_MS}) on the ` +
              'expectText / expectVisible / expectHidden / expectCount / waitFor / expectModal that checks it — as long as the job ' +
              'really takes — or the check gives up in seconds and reports a working batch as a defect.',
            { severity: 'weak', note: `wait-until claim (${unbudgeted}) with no timeoutMs on any check` },
          );
        }

        // Setup as well as the body: a flow's opening `goto` belongs in setup,
        // and judging the body alone said "never navigates there" of a flow
        // whose first step is exactly that navigation.
        const route = ignoresMenuPath([...(result.setup ?? []), ...result.steps], extra.caseText ?? trimmed);
        if (route !== null) {
          refuse(
            route.kind === 'destination'
              ? `the case names its page outright — Destination: ${route.wanted} — and the authored flow "${result.name}" never ` +
                'navigates there. After the sign-in, goto that URL (then click the tab the case names) before the first body step.'
              : `the case gives the route to its page — Menu path: ${route.wanted} — and the authored flow "${result.name}" ` +
                'neither clicks a crumb of it, navigates, nor hands the leg to a workflow. Reach the page the way the sheet says: ' +
                'click each crumb in order as the tree names it (a collapsed group by its header first).',
            { severity: 'weak', note: `the sheet's ${route.kind === 'destination' ? 'Destination' : 'Menu path'} (${route.wanted}) is not followed` },
          );
        }

        const forbiddenOption = unassertedForbiddenOption(result.steps, extra.caseText ?? trimmed);
        if (forbiddenOption !== null) {
          refuse(
            `the case says the ${forbiddenOption.field} list must NOT offer ${JSON.stringify(forbiddenOption.name)}, and the ` +
              `authored flow "${result.name}" never asserts its absence. With the list open once, add expectHidden ` +
              `role=option[name="${forbiddenOption.name}" i] (never re-click the trigger between checks).`,
            { severity: 'weak', note: `forbidden option ${forbiddenOption.name} of ${forbiddenOption.field} has no expectHidden` },
          );
        }

        const unreconciled = unreconciledMatchClaim(result.steps, trimmed);
        if (unreconciled !== null) {
          refuse(
            `the case's Expected output makes a RECONCILIATION claim (${JSON.stringify(unreconciled)}), and the authored ` +
              'flow never compares the two readings — it only asserts that things exist, which passes whether or not they ' +
              'agree (ten such bugs shipped green in the EN-2 audit). Author it as: saveCount (or saveText) of one surface ' +
              'into a variable — the variable NAME goes in the step\'s "value" field (e.g. value: "rows-before") — ' +
              'then expectCount/expectText on the other surface carrying {{that-variable}}; for a ' +
              '"no change" claim, save before the action and compare the same reading after it.',
          );
        }

        const fixture = ungroundedFixtureAssertion(result.steps, fixtureFacts(trimmed));
        if (fixture !== null) {
          refuse(
            `the authored flow "${result.name}" ${fixture.action}s on ${JSON.stringify(fixture.fact)} (step ${fixture.index}) as if it ` +
              'already existed in the application — but that value is the case\'s TEST DATA: something the tester types ' +
              'or creates, not a fact about the app. Nothing earlier in this flow creates it. Either author the creation ' +
              '(the fill/insert steps that put it there) before asserting on it, or assert the SHAPE of the result ' +
              '(a row exists, a count is a number) without naming the fixture value.',
          );
        }

        const wrongRole = ungroundedSelectorRole(result.steps, evidenceTree);
        if (wrongRole !== null) {
          refuse(
            wrongRole.disabled
              ? `the authored flow "${result.name}" ${result.steps[wrongRole.index]?.action ?? 'acts on'}s ${JSON.stringify(wrongRole.name)} (step ${wrongRole.index}), ` +
                `but the tree shows it DISABLED at rest: ${wrongRole.nearest[0]}. Something else must enable it first ` +
                '(a filter chosen, a mode entered) — do that step before this one, or assert its disabled state instead.'
              : `the authored flow "${result.name}" names role "${wrongRole.role}"${wrongRole.name === null ? '' : ` for ${JSON.stringify(wrongRole.name)}`} ` +
                `(step ${wrongRole.index}), but no element of that role is anywhere in the page's accessibility tree — the step will resolve ` +
                'nothing on every run. ' +
                (wrongRole.nearest.length > 0
                  ? `The page exposes it as: ${wrongRole.nearest.map((l) => `\`${l}\``).join(', ')} — use that role and name verbatim.`
                  : 'Take the role and name from a line of the tree, never from what such a control usually is.'),
            {
              // The last word: the tree's own role for the same name, or nothing.
              settle: () => {
                const step = result.steps[wrongRole.index];
                return step === undefined ? null : settleSelectorRole(step, wrongRole);
              },
            },
          );
        }

        const phantom = ungroundedCountRole(result.steps, evidenceTree);
        if (phantom !== null) {
          refuse(
            `the authored flow "${result.name}" counts role "${phantom.role}" (step ` +
              `${phantom.index}), but no element with that role appears anywhere in the ` +
              "page's accessibility tree — the count will resolve zero elements on every " +
              'run. Count a role the tree actually lists (look at what the group ' +
              'container holds — e.g. buttons inside a radiogroup), or assert the ' +
              "items' visible text instead.",
          );
        }

        const uncovered = unassertedExpectedItems(result.steps, trimmed);
        if (uncovered.length > 0) {
          refuse(
            `the authored flow "${result.name}" asserts nothing for Expected line(s) ${uncovered.join(', ')} — ` +
              'every numbered line of the Expected output gets its own assertion, in the page terms that line ' +
              'names (the element it speaks of), with the line\'s number cited in the step\'s intent. A backend ' +
              'check may corroborate a line but never replaces the on-screen reading the line asks for. Values ' +
              'come verbatim from the case, its Note, the documents or the repository — never invented.',
            {
              // Weak, the `unsettledWorkflowClaim` rule: an uncovered line is
              // a THIN claim, not a false one — it earns the re-ask, and a
              // flow still uncovered when the budget runs out is handed over
              // with the note rather than leaving the row flowless.
              severity: 'weak',
              note: `Expected line(s) ${uncovered.join(', ')} have no assertion — the flow proves less than the sheet asks`,
            },
          );
        }

        // "Only" means only (2026-09-02, ec10_3x HIR-EC-029): the sheet said
        // "แสดงเฉพาะ New Hire / Replacement / Migration", the flow proved the
        // three visible and three named codes hidden, and went green over a
        // list nothing had counted. An exclusive set is proved by its count;
        // fatal, because a flow without it reports a pass the sheet forbids.
        const exclusive = unprovedExclusivity(result.steps, extra.caseText ?? trimmed);
        if (exclusive !== null) {
          const size = exclusive.claim.count === null ? 'the items the line enumerates' : String(exclusive.claim.count);
          refuse(
            `the authored flow "${result.name}" — ${describeUnprovedExclusivity(exclusive)}. ` +
              `"${exclusive.claim.marker}" is a claim about the WHOLE set: after the step that opens or shows the ` +
              'list, add expectCount on the ITEM role the opened list exposes in the tree or the probe report ' +
              `(role=option, role=menuitem, the buttons inside the listbox …) with value ${size}, and cite the ` +
              'Expected line in its intent. Keep the expectVisible of each listed item and the expectHidden of ' +
              'each named absentee — they are necessary, not sufficient. Never drop the count: a list of thirty ' +
              'entries passes every presence and hidden check.',
            {
              note: describeUnprovedExclusivity(exclusive),
              // The last word: the count from the tree, when every member is
              // in it under one role; otherwise the refusal stands.
              settle: () =>
                exclusive.reason === 'no-count'
                  ? settleExclusivity(result, exclusive.claim, extra.caseText ?? trimmed, [evidenceTree, interactions].filter((t): t is string => typeof t === 'string').join('\n'))
                  : null,
            },
          );
        }

        const delegated = workflowOverDeclaredControls(result.steps, codeEvidence);
        if (delegated !== null) {
          refuse(
            `the authored flow "${result.name}" hands a workflow step (step ${delegated.index}) a goal ` +
              `that names ${delegated.declared.map((d) => JSON.stringify(d)).join(', ')} — controls the ` +
              'repository itself declares (WHAT THE REPOSITORY DECLARES). Write those interactions as ' +
              'explicit deterministic steps grounded in the declared strings — click ' +
              `role=button[name=${JSON.stringify(delegated.declared[0] ?? '')} i], expectText quoting the ` +
              'declared value — they run in milliseconds at $0, and the healer repairs one that drifts. ' +
              'Keep a workflow step ONLY for the part of the journey neither a tree nor the repository ' +
              'declares, and word its goal without the declared controls.',
            {
              // Weak, like `unassertedExpectedItems` above: delegating a leg to
              // a workflow step is a THIN flow, not a false one. Hard-refusing
              // it is unwinnable whenever the destination page was never
              // captured — the author cannot write deterministic steps for a
              // tree it has not seen, so it re-delegates, is refused again, and
              // the row dies flowless. Measured on PL_07: 5 of 10 rows were
              // lost to exactly this. It earns the re-ask; a flow still
              // delegating when the budget runs out is handed over with the
              // note, so the row is proved less well rather than not at all.
              severity: 'weak',
              note:
                `step ${delegated.index} delegates ${delegated.declared
                  .map((d) => JSON.stringify(d))
                  .join(', ')} to a workflow goal — declared controls the flow could have driven directly`,
              // On acceptance: the goal's own `Field = value` pairs that a
              // captured tree names are split out as deterministic steps.
              settle: () => {
                const step = result.steps[delegated.index];
                return step === undefined
                  ? null
                  : settleWorkflowGoal(result, step, [evidenceTree, interactions].filter((t): t is string => typeof t === 'string').join('\n'));
              },
            },
          );
        }

        const internals = inventedControlInternals([...(result.setup ?? []), ...result.steps]);
        if (internals !== null) {
          refuse(
            `the authored flow "${result.name}" targets ${JSON.stringify(internals.selector)} ` +
              `(step ${internals.index}) — a selector written against the control's DOM internals ` +
              `(${internals.fragment}). No accessibility tree shows <select>, <option> or :checked; ` +
              'the tree speaks roles, so that selector is invented and dead-ends on any custom widget. ' +
              'Name the control by its role and visible label from a tree it appears in ' +
              '(role=combobox[name="…" i]) — selectOption drives a native select and a custom ' +
              'combobox alike through it, and expectText on the combobox reads its visible value. ' +
              'When NO tree shows the control, write that leg as a workflow goal in user terms ' +
              'instead ("the category filter shows All by default and offers exactly the listed ' +
              'categories"), judged on evidence. A default written "All" or "No filter" is a state ' +
              "the user can see — the control's visible value, an unfiltered listing — never an " +
              'option:checked internal.',
          );
        }
        // Order is source order, so two runs of one broken flow produce the
        // same feedback — the reason `temperature: 0` exists, applied to the
        // refusal rather than the generation.
        //
        // **A flow refused ONLY for thinness is accepted at once, with the
        // note.** The re-ask used to run for `weak` violations too, and it
        // bought nothing measurable: the model was told its workflow leg was
        // unchecked, came back with the same leg (it could not see the page
        // the leg ends on), and the weak result was accepted anyway once the
        // budget was spent — two model calls and a minute later. The workflow
        // step now records the page before and after the agent acted (URL,
        // headings, the requests the page made), so the leg is auditable
        // from the report without a re-ask. Fatal violations still refuse:
        // a flow that says something UNTRUE is worse than none.
        if (violations.length > 0) {
          if (violations.some((v) => v.severity === 'fatal')) {
            const refusal = composeRefusal(violations);
            // **The last word is a rewrite, not a refusal, wherever the
            // evidence allows one** (2026-09-04, multirole HIR-EC-001). Once
            // the budget is spent — or the model has answered the same fatal
            // shapes twice, which is the same thing one attempt earlier —
            // every fatal complaint that carries a grounded `settle` performs
            // it, and the flow goes out with the covered steps as written and
            // each uncovered claim named in `notes` and marked `[generated: …]`
            // on the step it touched. One complaint that cannot be settled
            // keeps the refusal whole: a false claim is never handed over.
            const shapes = fatalShapesOf(refusal);
            const lastWord =
              attempt >= this.#attempts ||
              (shapes !== null && previousShapes !== null && sameShapes(shapes, previousShapes));
            if (lastWord) {
              const settled = settleViolations(violations);
              if (settled.unsettled.length === 0) {
                const note = settled.notes.join('; ');
                result.notes = result.notes === '' ? note : `${result.notes}; ${note}`;
                this.#onLog?.(
                  `settled ${violations.filter((v) => v.severity === 'fatal').length} refusal(s) by rewriting instead of refusing: ${note}`,
                );
                accepted = true;
                acceptedOnAttempt = attempt;
                break;
              }
              this.#onLog?.(
                `${settled.unsettled.length} refusal(s) have no grounded rewrite — refusing: ` +
                  settled.unsettled.map((v) => refusalShape(v.message).slice(0, 80)).join(' · '),
              );
            }
            throw refusal;
          }
          const note = settleViolations(violations).notes.join('; ');
          result.notes = result.notes === '' ? note : `${result.notes}; ${note}`;
          this.#onLog?.(`weak claim, accepted with a note: ${note}`);
        }
        accepted = true;
        acceptedOnAttempt = attempt;
        break;
      } catch (error) {
        // Anything that is not a judgement about the flow — a provider fault,
        // a bug in here — is nobody's second chance and propagates at once.
        if (!(error instanceof AuthoringError)) throw error;
        lastRefusal = error;
        if (error.severity === 'weak' && betterThan(result, weak?.result)) {
          weak = { result, note: error.note };
        }
        // **The same fatal refusal twice is not re-asked** (2026-09-04,
        // HIR-EC-001): the model was told, in full, what was wrong, and came
        // back refused by exactly the same shapes. That is either a rule the
        // model cannot follow or a lint that misreads the case — two lints
        // did on that row, and the loop spent every attempt (and every resume)
        // on them. The outcome is the refusal the budget would have reached
        // anyway, one attempt earlier, and the message says which it is so a
        // reader looks at the lint and not at the model. Weak refusals are
        // untouched: they are meant to be re-asked, then accepted.
        const shapes = fatalShapesOf(error);
        if (shapes !== null && previousShapes !== null && sameShapes(shapes, previousShapes)) {
          const repeated = new AuthoringError(
            `refused identically on ${attempt} attempts — a rule the model cannot satisfy or a lint that misreads ` +
              `the case; review the lint before re-authoring. ${error.message}`,
            { severity: 'fatal', note: error.note, messages: error.messages },
          );
          this.#onLog?.(`refused identically on ${attempt} attempts — not asking again`);
          lastRefusal = repeated;
          break;
        }
        previousShapes = shapes;
        // One bullet per problem, not one bullet holding three:
        // `buildUserPrompt` renders each entry on its own line, and a model
        // fixes a list far more reliably than a paragraph.
        feedback.push(...error.messages);
        // Several cases and a refusal: the next ask rewrites only the refused
        // ones. One case (or none) has nothing to keep.
        priorCases =
          result.cases !== undefined && result.cases.length > 1
            ? result.cases.map((one) => ({ name: one.name, steps: [...one.steps] }))
            : undefined;
        // Suite-scoped, so the NEXT row's first attempt already knows — see
        // `SUITE_REFUSAL_MEMORY`. Recorded before the re-ask, so a row that
        // breaks the same rule twice counts it twice.
        this.#rememberRefusals(error.messages);
        // Every problem, not the headline: "3 problems with the authored flow"
        // tells a reader nothing about which rules the model keeps breaking,
        // and that list is the whole diagnostic value of a refusal.
        for (const line of formatRefusalLines(error, result.name)) this.#onLog?.(line);
      }
    }

    if (!accepted) {
      // Budget spent. A flow refused only for thinness is still a flow; one
      // refused for saying something untrue is not, and the loud refusal is
      // what `runCases` scores as blocked rather than failed.
      if (weak === null) throw lastRefusal ?? new AuthoringError('authoring produced no flow');
      result = weak.result;
      result.notes = result.notes === '' ? weak.note : `${result.notes}; ${weak.note}`;
      this.#onLog?.(`weak claim: ${weak.note}`);
    }
    // **The acceptance reads the WHOLE journey tree, not the cut the model got.**
    // `JOURNEY_TREE_MAX_LINES` exists for the PROMPT's token budget, and it is
    // tight: measured live (HIR-EC-001, 2026-09-07) the hire form's two pages
    // are 743 nodes and the model was shown 80 — Event Reason, Hire Date,
    // Position and every Employment control fell outside the cut, so the
    // deterministic lift below could ground almost none of the fields the goal
    // named, and the review answered `unsure` four times over a tree that
    // holds the answer.
    //
    // Narrowing the acceptance's copy buys nothing: it spends no tokens, and
    // it never refuses anything — it turns a `Field = value` pair the MODEL
    // already wrote into an entry step against a real tree line, or leaves it
    // in the leg. The "model and lints see one tree" rule above is about
    // refusals, where judging on evidence the model never saw is unfair; this
    // is the opposite direction.
    const acceptedEvidence = [axTree, rawJourneyTree, interactions]
      .filter((text): text is string => typeof text === 'string' && text !== '')
      .join('\n');
    const acceptedNotes = settleAcceptedFlowInputs(
      result,
      sectionOf(extra.caseText ?? trimmed, 'expected') ?? '',
      acceptedEvidence,
      extra.caseId ?? 'case',
      extra.testDataPairs ?? testDataPairsOfCaseText(extra.caseText ?? trimmed),
    );
    if (acceptedNotes.length > 0) {
      const note = acceptedNotes.join('; ');
      result.notes = result.notes === '' ? note : `${result.notes}; ${note}`;
    }
    this.#onLog?.(
      `  authored   ${result.steps.length} step(s)` +
        (acceptedOnAttempt > 0 ? ` on attempt ${acceptedOnAttempt}/${this.#attempts}` : ` (weak, budget spent)`) +
        ` in ${formatElapsed(Date.now() - authoringStartedMs)}`,
    );

    // The review, after every lint has had its say: the lints refuse shapes a
    // string check can name, the review asks what the codebase and the
    // documents say about the steps that have no evidence behind them. It
    // repoints, never re-claims — see `applyReview`.
    let review: ReviewRecord | undefined;
    if (this.#reviewer !== undefined) {
      const outcome = await this.#reviewer.review(
        result.setup,
        result.steps,
        {
          url,
          axTree,
          journeyTree,
          interactions,
          // **The row's own slice, not the author-wide one.** The reviewer
          // judges by the evidence the AUTHOR saw, and for a catalog row that
          // is `extra.projectContext` — the repository ranked against this
          // row's words. Handing it the project-wide section instead made the
          // reviewer poorer than the author it was checking, and it is the
          // input `settleableFindings` reads to decide whether a finding is
          // answerable at all.
          projectContext: extra.projectContext ?? this.#projectContext,
          declaredRoutes: this.#declaredRoutes,
          prompt: trimmed,
        },
        result.cases,
      );
      result.setup = outcome.setup;
      result.steps = outcome.steps;
      if (outcome.record !== null) {
        review = outcome.record;
        const summary =
          `authoring review: ${review.replaced} step(s) repointed, ${review.inserted} inserted, ` +
          `${review.unsure} still ungrounded`;
        result.notes = result.notes === '' ? summary : `${result.notes}; ${summary}`;
      }
    }

    const consentPolicy = consentPolicyForCase(extra.caseText ?? trimmed, [
      ...result.setup,
      ...result.steps,
    ]);
    const flow: Flow = {
      name: result.name,
      ...(consentPolicy === undefined ? {} : { consentPolicy }),
      ...(baseUrlOf(url) === undefined ? {} : { baseUrl: baseUrlOf(url) }),
      // A persona-switching flow is an end-to-end journey by construction —
      // the mark travels IN the flow file, like `polarity`, so a re-run or a
      // repair keeps it.
      ...(switchesPersona(result.setup, result.steps).length > 1 ? { scope: 'e2e' as const } : {}),
      ...(result.setup.length > 0 ? { setup: result.setup } : {}),
      steps: result.steps,
      ...(result.teardown.length > 0 ? { teardown: result.teardown } : {}),
    };

    return {
      flow,
      // A model (or a stub) that named no cases still produced one: the body.
      cases:
        result.cases !== undefined && result.cases.length > 0
          ? result.cases
          : [{ name: result.name, steps: result.steps }],
      rationale: result.rationale,
      notes: result.notes,
      grounded: axTree !== undefined,
      sourceUrl: url,
      model: this.model.id,
      authoredAt: new Date().toISOString(),
      droppedSteps: result.droppedSteps,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: Date.now() - startedMs,
      ...(review === undefined ? {} : { review }),
      // Observations only, by the sheet's own request — see `recordOnly`.
      ...(observeOnly && claimsNothing(result.steps) ? { recordOnly: true } : {}),
    };
  }
}

/** A URL that reads as a sign-in surface. */
/**
 * Exported because the journey capture needs exactly this rule: a capture that
 * bounced to a sign-in page must be discarded, not handed to the model under
 * the destination's name. Two spellings of "is this a login URL" would drift.
 */
export const LOGIN_URL_PATTERN =
  // "login"/"sign-in" anywhere; "auth"/"sso" only where a sign-in surface
  // actually lives — as a word in the HOST (auth.corp.com, sso.company.com),
  // as the FIRST path segment after an optional locale (/auth/callback,
  // /en/sso, /oauth2/authorize), or as a query flag (?sso=1). A bare
  // substring match read /admin/config/sso — a payroll app's Social
  // Security Office page — as a sign-in URL (2026-09-03, PY-1 TC_SSO_001_001):
  // the journey capture dropped the row's own destination, ranked its way to
  // the wrong page, and the author wrote against a form the case never opens.
  /login|sign-?in|signin|(?:^|\/\/)[^/]*\b(?:auth|sso)\b[^/]*(?:\/|$)|(?:^|\/\/[^/]+)\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:auth|oauth2?|authn|authorize|authenticat(?:e|ion)|sso)(?:\/|$|\?|#)|[?&](?:sso|auth)=/i;

/**
 * A fill (or key-by-key `type`) that reads as a credential: it names a
 * password outright, or it is the nameless-textbox positional idiom the
 * sign-in guidance itself teaches (`role=textbox >> nth=N` — the password
 * field with no accessible name).
 */
function isCredentialFill(step: FlowStep): boolean {
  if (step.action !== 'fill' && step.action !== 'type') return false;
  const intent = 'intent' in step ? (step.intent ?? '') : '';
  if (/password/i.test(step.selector) || /password/i.test(intent)) return true;
  return /^role=textbox\s*>>\s*nth=\d+$/.test(step.selector.trim());
}

/**
 * The index of the first credential fill that no sign-in-page navigation
 * precedes, or null when every one is properly grounded.
 *
 * The walk mirrors execution order (pass `[...setup, ...steps]`): each `goto`
 * updates where the flow is, and a credential fill demands that the most
 * recent `goto` — if there has been one at all — looked like a sign-in page.
 * A flow that starts on the page it was given may legitimately begin with
 * credentials (the page may *be* the login screen); one that navigated to
 * `/workflows/…` and then fills a password is the PB-02-01 shape, and every
 * such fill runs against a page with no login form on it.
 */
/**
 * A credential submit the flow never checks took effect.
 *
 * The live failure: fill email, fill password, click Sign in, goto the page
 * under test — and the click landed before the app hydrated, so the form
 * submitted natively, no session exists, and the whole body runs against the
 * login page. The missing step is cheap and deterministic to demand: between
 * the submit click and the next `goto` there must be something that would
 * CATCH a login that did not take — an expect* or a waitFor. Returns the
 * 0-based index (into the given list) of the offending click, or null.
 *
 * Narrow on purpose: only a click that follows a password-shaped fill and is
 * immediately followed by a `goto` is flagged — any assertion or wait between
 * the two satisfies the rule, and flows that do not log in never match.
 */
/**
 * A database claim authored without a single database check, while the table
 * inventory was RIGHT THERE. The live failure (run 4's DB_01_01, authored by
 * a weaker model): "counts match the database exactly" became an assertion
 * that `$.counts` merely exists, with an intent confessing the numbers were
 * "verified outside this flow" — a green case about a comparison that never
 * happened. Deterministic trigger: the request's claim text compares
 * something to the database, tables were declared, and no expectDb* step
 * exists anywhere in the flow.
 */
export function dbClaimWithoutDbCheck(
  prompt: string,
  steps: readonly FlowStep[],
  tablesDeclared: boolean,
): false | 'unused' | 'no-schema' {
  const claimsDbComparison =
    /\b(match|equal|same as|identical)\w*\b[^.]*\b(sql|database|db)\b/i.test(prompt) ||
    /\b(sql|database|db)\b[^.]*\b(match|equal|same as|identical)\w*\b/i.test(prompt);
  if (!claimsDbComparison) return false;
  const hasDbStep = steps.some(
    (step) => step.action.startsWith('expectDb') || step.action === 'dbSnapshot',
  );
  if (hasDbStep) return false;
  // The two gaps are different problems for different people, and the second
  // used to disarm this lint entirely — `if (!tablesDeclared) return false`,
  // which is exactly backwards: with no inventory `toFlowStep` DROPS every DB
  // step the model emits, so the claim degrades to a UI or API proxy silently
  // and completely. Measured live (DB_01_01): a catalog run grounded in the
  // WRONG saved repo — one holding 0 table nodes — authored "GET
  // /api/db/health reports live counts that match the database exactly" as two
  // assertions on `$.ok` and `$.db`, read no count at all, and reported a
  // green pass. A claim the harness structurally cannot check must be refused
  // so `runCases` scores it blocked; blocked is not failed, and neither is it
  // a pass.
  return tablesDeclared ? 'unused' : 'no-schema';
}

/**
 * A "login took effect" assertion that can only prove it did NOT: expecting
 * the URL to contain the sign-in page's own path right after submitting
 * credentials. Live shape (run 4's DB_02_01): intent said "redirected away",
 * the assertion said `expectUrl /en/login` — which held precisely because
 * the login never happened, and the case sailed on green against the login
 * screen. Returns the offending step's index or null.
 */
/**
 * A post-login `expectUrl` that the login page itself satisfies.
 *
 * `loginProofAssertsLoginPage` catches the literal version — expecting
 * "/login" after signing in. This is the version that actually shipped:
 * `expectUrl "/en"` after a sign-in on `/en/login`. It reads like "we landed
 * somewhere else"; `expectUrl` asserts *contains*, and "/en/login" contains
 * "/en", so it holds precisely as well when the login failed.
 *
 * Measured: an authored flow with an invented password scored **12/12 passed**
 * — the sign-in was rejected, the engine's hydration replay dutifully retried
 * it, this assertion passed on the login page, and the agent then completed
 * the journey on a session a previous run had left in localStorage. A green
 * run of a test that proved nothing is the single worst thing this system can
 * produce, and it is a substring check away from being impossible.
 *
 * The login URL is taken from the flow's own most recent goto before the
 * credential submit — no guessing about what a sign-in page looks like.
 */
export function loginProofCannotFail(
  steps: readonly FlowStep[],
): { index: number; expected: string; loginUrl: string } | null {
  let lastGoto: string | null = null;
  let sawCredentialFill = false;
  let submittedFrom: string | null = null;
  for (const [index, step] of steps.entries()) {
    if (step.action === 'goto') {
      lastGoto = step.url;
      sawCredentialFill = false;
      submittedFrom = null;
      continue;
    }
    if (step.action === 'fill' || step.action === 'type') {
      if (isCredentialFill(step)) sawCredentialFill = true;
      continue;
    }
    if (step.action === 'click' && sawCredentialFill) {
      submittedFrom = lastGoto;
      sawCredentialFill = false;
      continue;
    }
    if (step.action === 'expectUrl' && submittedFrom !== null) {
      const expected = step.value.trim();
      // Empty is somebody else's problem; a fragment the login URL contains is
      // this one's.
      if (expected !== '' && submittedFrom.includes(expected)) {
        return { index, expected, loginUrl: submittedFrom };
      }
      submittedFrom = null;
    }
  }
  return null;
}

/**
 * Replace a login proof that cannot fail with one that can, in place.
 *
 * The shape `loginProofCannotFail` refuses: credentials filled, a submit
 * clicked, then `expectUrl` of a fragment the sign-in URL already contains.
 * The replacement is `expectHidden` of the very control that was clicked —
 * the flow's own selector, so nothing is invented — because a submit that did
 * not take leaves the form standing and one that did removes it. Both arrays
 * are edited in place (setup and body are one sequence for this purpose, and
 * the vacuous step usually sits in setup). Returns the disclosure line, or
 * null when nothing was changed.
 */
export function groundLoginProof(
  setup: FlowStep[],
  steps: FlowStep[],
  /**
   * Everything the model was shown — the trees and the request. A login proof
   * that quotes text found in none of it (`expectVisible text="HRIS ADMIN"`,
   * live, from a sheet that said "HR Admin" and a shell that renders
   * "ผู้ดูแลระบบ HR") is a guess dressed as a check, and it cost that run ~100
   * seconds of ladder, patience and reconstruction before the real claims.
   */
  evidence = '',
): string | null {
  let lastGoto: string | null = null;
  let sawCredentialFill = false;
  let submittedFrom: string | null = null;
  let submitSelector: string | null = null;
  const haystack = evidence.toLowerCase();
  const replaceWith = (list: FlowStep[], i: number, why: string): string => {
    list[i] = {
      action: 'expectHidden',
      selector: submitSelector as string,
      intent: `the sign-in took: the submit control "${submitSelector}" is no longer on the page`,
    };
    return `${why} and was replaced with expectHidden of the submit control the flow clicked`;
  };
  const sections: FlowStep[][] = [setup, steps];
  for (const list of sections) {
    for (let i = 0; i < list.length; i += 1) {
      const step = list[i]!;
      if (step.action === 'goto') {
        lastGoto = step.url;
        sawCredentialFill = false;
        submittedFrom = null;
        continue;
      }
      if (step.action === 'fill' || step.action === 'type') {
        if (isCredentialFill(step)) sawCredentialFill = true;
        continue;
      }
      if (step.action === 'click' && sawCredentialFill) {
        submittedFrom = lastGoto;
        submitSelector = step.selector;
        sawCredentialFill = false;
        continue;
      }
      // The consent gate sits between the submit and its proof; it is not the
      // proof and does not end the search for one.
      if (step.action === 'when') continue;
      if (submittedFrom === null || submitSelector === null) continue;
      if (step.action === 'expectUrl') {
        const expected = step.value.trim();
        if (expected !== '' && submittedFrom.includes(expected)) {
          return replaceWith(list, i, `the login proof "expectUrl ${expected}" could not fail (the sign-in URL contains it)`);
        }
        submittedFrom = null;
        continue;
      }
      if (step.action === 'expectVisible' || step.action === 'expectText') {
        const quoted = [
          ...(step.selector.match(/text="([^"]+)"/)?.[1] ? [step.selector.match(/text="([^"]+)"/)![1] as string] : []),
          ...(step.selector.startsWith('text=') && !step.selector.startsWith('text="') ? [step.selector.slice(5)] : []),
          ...(step.action === 'expectText' && step.value !== '' ? [step.value] : []),
        ];
        const ungrounded = quoted.find((q) => haystack !== '' && !haystack.includes(q.toLowerCase()));
        if (ungrounded !== undefined) {
          return replaceWith(
            list,
            i,
            `the login proof quotes "${ungrounded}", which appears in no tree given and not in the request`,
          );
        }
        submittedFrom = null;
        continue;
      }
      // Any other assertion after the submit is the proof; leave it.
      if (step.action.startsWith('expect')) submittedFrom = null;
    }
  }
  return null;
}

/**
 * The values this flow typed as credentials — every `fill`/`type` value that
 * is password-shaped (`isCredentialFill`) or sits on a sign-in page (the most
 * recent `goto` matches `LOGIN_URL_PATTERN`). Walked in execution order,
 * setup first, because that is the order the page saw them.
 *
 * These are the flow's INPUT. An assertion that one of them is displayed
 * claims the application echoes a credential back — see
 * `credentialEchoAssertions`.
 */
export function typedCredentialValues(
  setup: readonly FlowStep[],
  steps: readonly FlowStep[],
): string[] {
  const typed: string[] = [];
  let lastGoto: string | null = null;
  for (const step of [...setup, ...steps]) {
    if (step.action === 'goto') {
      lastGoto = step.url;
      continue;
    }
    if (step.action !== 'fill' && step.action !== 'type') continue;
    const value = step.value.trim().toLowerCase();
    if (value === '') continue;
    const onSignIn = lastGoto !== null && LOGIN_URL_PATTERN.test(lastGoto);
    if (onSignIn || isCredentialFill(step)) typed.push(value);
  }
  return typed;
}

/**
 * Presence assertions that echo a credential the flow itself typed — the
 * PL_02_02 shape: `expectVisible text="admin@cnext.test"` under the intent
 * "assert authenticated user email is displayed in chrome", against an
 * application whose identity plate renders a display name, a role label and
 * a user id, and never the sign-in email. The value came from the INPUT side
 * of the test (the credential the flow filled), not from anything the page
 * was seen to render, so the check is out of the claim's scope by
 * construction: unresolvable on every run, it dead-ends the ladder, spends a
 * healer call to be told the string is nowhere in the tree, and files a high
 * defect against a working application.
 *
 * The request text can never rescue such an assertion — the credentials are
 * ALWAYS in the request (the persona lines put them there), which is exactly
 * where the model found the value. The EVIDENCE can: a value that appears in
 * a tree the model was given is something the page really renders, and
 * asserting it is grounded (a truncated tree may fail to rescue a value a
 * deeper page shows — the cost of that miss is one auxiliary check dropped
 * with a note, and the informed re-ask covers the refusal path).
 *
 * `expectHidden` is deliberately not matched: asserting a credential is NOT
 * displayed is a legitimate check (a password must never render), and it is
 * also the canonical login proof's own action.
 *
 * Returns the indexes into `list`, for the caller to drop (when the proof
 * stands without them) or refuse over (when they are all the proof there is)
 * — that decision needs `hasAssertion` over the surviving body, which only
 * the caller can see.
 */
export function credentialEchoAssertions(
  list: readonly FlowStep[],
  typedCredentials: readonly string[],
  evidence = '',
): number[] {
  if (typedCredentials.length === 0) return [];
  const haystack = evidence.toLowerCase();
  const indexes: number[] = [];
  for (const [index, step] of list.entries()) {
    if (
      step.action !== 'expectVisible' &&
      step.action !== 'expectText' &&
      step.action !== 'waitFor'
    ) {
      continue;
    }
    const selector = step.selector.toLowerCase();
    const value = step.action === 'expectText' ? step.value.toLowerCase() : '';
    const echoed = typedCredentials.find(
      (typed) => selector.includes(typed) || (value !== '' && value.includes(typed)),
    );
    if (echoed === undefined) continue;
    // The page was seen to render it — grounded, in scope, keep it.
    if (haystack !== '' && haystack.includes(echoed)) continue;
    indexes.push(index);
  }
  return indexes;
}

/**
 * The sheet's marker for something NOBODY KNOWS YET: `OQ-HIR-78`, `CF-SIT-19`,
 * and the `= ?` that introduces them ("ข้อความ Notice ที่แน่นอน = ? OQ-HIR-140").
 * The convention is explicit in the rows that carry it — *run it, record what
 * the system shows, send it to BA/SA to confirm* — so the id is the NAME of an
 * unanswered question, never a value the page renders.
 *
 * Live (ec10 HIR-EC-009, 2026-09-02): the flow asserted
 * `expectVisible text=OQ-HIR-78` against the New Hire form. It can only fail,
 * and it fails as though the application were missing something.
 */
const OPEN_QUESTION = AUTHORING.openQuestion;

/**
 * The open-question marker a text carries, or null. Two readings, either is
 * enough: an id with one of the configured prefixes (`OQ-`, `CF-` by default —
 * `value-rules.ts`), or — needing no prefix list at all — an id the CASE
 * itself writes after its `= ?` (`openQuestionIdsIn`), which is the sheet's
 * structural way of saying "nobody knows yet".
 */
function openQuestionIn(text: string, caseText: string | undefined): string | null {
  const marker = OPEN_QUESTION.exec(text);
  if (marker !== null) return marker[0];
  if (caseText === undefined) return null;
  for (const id of openQuestionIdsIn(caseText)) {
    if (new RegExp(`(?<![A-Za-z0-9-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9-])`).test(text)) return id;
  }
  return null;
}

/**
 * A step asserting an open-question marker, or `null`.
 *
 * Deliberately narrow: only the id shape, and only where the flow ASSERTS it.
 * A `fill` whose value happens to carry one is the tester's own data, and an
 * intent that mentions the question is a note to a reader, not a claim.
 */
export function assertsOpenQuestion(
  steps: readonly FlowStep[],
  caseText?: string,
): { index: number; value: string; marker: string } | null {
  for (const [index, step] of steps.entries()) {
    const text = assertedText(step);
    if (text === null) continue;
    const marker = openQuestionIn(text, caseText);
    if (marker !== null) return { index, value: text, marker };
  }
  return null;
}

/**
 * What the Steps column asks of the tester, in three tiers, each with the
 * ACTION KINDS that perform it (2026-09-04, PRB-EC-001 / ML_01_04, multirole):
 *
 * - TYPING (`กรอก`, `คีย์`, fill, key in …) — performed by `INPUT_ACTIONS`: a
 *   fill / fillRetry / type / setValue / upload, and also a selectOption /
 *   check — a cascade that is chosen is data entered too (HIR-EC-001).
 * - CHOOSING (`เลือก`, `ติ๊ก`, select, choose, tick …) — performed by
 *   `INPUT_ACTIONS`, or by a `click` whose selector's role is a CHOICE role
 *   (`CHOICE_ROLES`: radio, option, checkbox …), or by a `click` that a later
 *   body step follows — a choice made by clicking is the ordinary shape, and
 *   the step after it is what the choice was for. The old rule put `เลือก`
 *   in the typing tier and refused `click role=radio[name="Pass probation
 *   (normal)"]` while its own message said a click counts.
 * - ACTING (`กด`, `ยอมรับ`, `ประกาศ`, click, accept, publish, sign in …) —
 *   performed by any `ACTION_STEPS` entry: a click, a press, a workflow leg.
 *
 * The words are data (`value-rules.ts`, `authoring.script`); the tiers and
 * what satisfies each are the structure. Deliberately about DOING, not about
 * navigation: "ไปที่ EC > …" names the page (`withoutRouteLabels`), and a
 * read-only case (a menu is visible, a column list is complete) asks for
 * nothing and is never touched.
 */
const SCRIPT_DEMANDS = AUTHORING.script;

/** Body steps that engage the page at all — an action of any kind, or a leg the agent drives. */
const ACTION_STEPS: ReadonlySet<string> = new Set([
  'click',
  'clickIfVisible',
  'fill',
  'fillRetry',
  'type',
  'selectOption',
  'check',
  'uncheck',
  'press',
  'hover',
  'setValue',
  'workflow',
  'upload',
  'closeModal',
]);

/** Body steps that actually put something into the page. */
const INPUT_ACTIONS: ReadonlySet<string> = new Set([
  'fill',
  'fillRetry',
  'type',
  'selectOption',
  'check',
  'uncheck',
  'setValue',
  // An attached file is data entered (CG-19): "กดแนบเอกสาร (Attach)" is
  // performed by an upload, not by a click that opens a chooser nobody fills.
  'upload',
]);

/** The roles a click CHOOSES by — read from the selector the tree gave the step. */
const CHOICE_ROLES: ReadonlySet<string> = new Set([
  'radio',
  'option',
  'checkbox',
  'switch',
  'menuitemradio',
  'menuitemcheckbox',
  'tab',
  'treeitem',
]);

/** The role a `role=…` selector names, lower-cased, or null for any other selector shape. */
function selectorRole(selector: string): string | null {
  const m = /(?:^|>>\s*)role=([a-z]+)/i.exec(selector.trim());
  return m === null ? null : m[1]!.toLowerCase();
}

/** A body `click` that chooses: on a choice role, or with a later body step to be the choice's purpose. */
function clickChooses(steps: readonly FlowStep[], index: number): boolean {
  const step = steps[index]!;
  if (step.action !== 'click') return false;
  const role = selectorRole((step as { selector?: string }).selector ?? '');
  if (role !== null && CHOICE_ROLES.has(role)) return true;
  return index < steps.length - 1;
}

/**
 * The authored flow never performs what its case scripts.
 *
 * Live (ec10 HIR-EC-001, 2026-09-02): the sheet's eight numbered steps key an
 * identity, walk the Province → District → Sub-District cascade, fill position
 * and compensation, press Submit and then verify the created profile. The
 * authored flow signed in, opened the form, and asserted that an "Employee ID"
 * label and the words "Auto-generated by system" were on screen — fifteen
 * steps, two fills, both of them the login. It proved the form exists. It
 * never ran the case, so nothing it asserts can be evidence for or against the
 * claim, and the Expected output it answered was not the sheet's.
 *
 * The rule is narrow on purpose. It fires only when the script asks for a
 * tier (`SCRIPT_DEMANDS`) and the flow's BODY performs nothing of that tier —
 * setup is excluded, so a sign-in's own fills never satisfy it and never trip
 * it. Tiers are judged in order — typing, then choosing, then acting — and the
 * refusal names the tier and the actions that would have satisfied it
 * (`describeScriptDemand`), exactly the ones this code accepts.
 */
/**
 * A route is not an instruction. "ไปที่เมนู EC > New Hire (Manual Key-in)"
 * names the page to open, and the word Key-in inside it is the page's NAME —
 * yet the typing tier read it as "key in" and refused HIR-EC-029
 * (2026-09-03), a negative enumeration case whose steps are navigate and
 * verify and whose correct flow types nothing. Route lines (a route word from
 * `authoring.script.routeLine`, or a `>` breadcrumb) and parenthesised labels
 * are cut before the demand words are looked for; a real "กรอก"/"Key-in ..."
 * step on a line of its own is untouched.
 */
function withoutRouteLabels(script: string): string {
  return script
    .split('\n')
    .filter((line) => !SCRIPT_DEMANDS.routeLine.test(line) && !/\S\s*>\s*\S/.test(line))
    .map((line) => line.replace(/\([^)]*\)/g, ' '))
    .join('\n');
}

export type ScriptDemandTier = 'typing' | 'choosing' | 'acting';

/**
 * The first demand word of a tier in the script that is used as a VERB, or
 * null. A demand word that is the head of a `Field = value` pair — the token
 * right before the `=` — is the field's NAME, not an instruction: multirole
 * ML_01_04's "5. เลือก Leave type = Sick Leave" was read as "type" (typing
 * tier) and refused a flow that chose everything through agent legs. The
 * pair grammar is the sheet's own (CG-02), so the rule is structural: the
 * match is followed by `=` / `:`, whatever the word.
 */
export function scriptDemand(tier: RegExp, script: string): string | null {
  const every = new RegExp(tier.source, tier.flags.includes('g') ? tier.flags : `${tier.flags}g`);
  for (const m of script.matchAll(every)) {
    const after = script.slice(m.index + m[0].length);
    if (/^\s*[=:：]/.test(after)) continue;
    return m[0].trim();
  }
  return null;
}

/** What performs each tier — the sentence the refusal prints, kept beside the code that judges it. */
export function describeScriptDemand(tier: ScriptDemandTier): string {
  switch (tier) {
    case 'typing':
      return 'a fill, fillRetry, type, setValue, upload, selectOption, check or uncheck in the body, or a workflow leg whose goal performs it';
    case 'choosing':
      return (
        'a selectOption, check, uncheck, setValue or fill in the body, a workflow leg whose goal performs it, or a click whose selector role is a ' +
        `choice (${[...CHOICE_ROLES].join(', ')}), or a click that another body step follows`
      );
    case 'acting':
      return 'a click, press, selectOption, fill, upload, hover, closeModal or workflow leg in the body';
  }
}

export function skipsAuthoredScript(
  caseText: string,
  bodySteps: readonly FlowStep[],
): { demanded: string; tier: ScriptDemandTier; performed: number } | null {
  // The parser's cut (CG-15): the block used to run on into `Note (from the
  // sheet):` and `Test data:`, so a Note saying "กด Submit" counted as script.
  const script = withoutRouteLabels(sectionOf(caseText, 'steps') ?? '');
  if (script.trim() === '') return null;
  // An agent leg performs a script step too (2026-09-04, multirole ML_01_04):
  // the prompt allows a `workflow` leg exactly where no tree declares the
  // control, and whether its claim is then settled is `unsettledWorkflowClaim`
  // / `unassertedExpectedItems`' question, not this lint's.
  const demandedTyping = scriptDemand(SCRIPT_DEMANDS.typing, script);
  if (demandedTyping !== null) {
    const performed = bodySteps.filter((step) => INPUT_ACTIONS.has(step.action) || step.action === 'workflow').length;
    if (performed === 0) return { demanded: demandedTyping, tier: 'typing', performed };
  }
  const demandedChoice = scriptDemand(SCRIPT_DEMANDS.choosing, script);
  if (demandedChoice !== null) {
    const performed = bodySteps.filter(
      (step, i) => INPUT_ACTIONS.has(step.action) || step.action === 'workflow' || clickChooses(bodySteps, i),
    ).length;
    if (performed === 0) return { demanded: demandedChoice, tier: 'choosing', performed };
  }
  // No typing or choosing asked for, but the script still asks the tester to
  // ACT: a body of nothing but assertions has not performed it either.
  const demandedAction = SCRIPT_DEMANDS.acting.exec(script);
  if (demandedAction !== null) {
    const performed = bodySteps.filter((step) => ACTION_STEPS.has(step.action)).length;
    if (performed === 0) return { demanded: demandedAction[0].trim(), tier: 'acting', performed };
  }
  return null;
}

/**
 * A `fill`/`type` aimed at a textbox the tree marks `readonly`, when the tree
 * shows no writable textbox of that name — the read-only display of a date
 * picker, taken for the input (ec10 HIR-EC-001, 2026-09-02: four
 * `textbox "Select date" readonly` lines, the real inputs listed beside them as
 * `textbox "Hire Date"` and `textbox "Date of Birth"`). Returns the step and
 * the writable textboxes the tree does offer, so the refusal can name them.
 */
export function fillsReadOnlyNode(
  steps: readonly FlowStep[],
  axTree: string | undefined,
): { index: number; name: string; writable: string[]; input: { role: string; name: string } | null } | null {
  if (!axTree) return null;
  const lines = axTree.split('\n').map((l) => l.trim()).filter(Boolean);
  const readOnly = new Set<string>();
  const writable: string[] = [];
  for (const line of lines) {
    const m = /^textbox\s+"((?:[^"\\]|\\.)*)"(.*)$/.exec(line);
    if (m === null) continue;
    const name = m[1]!.toLowerCase();
    if (/\breadonly\b/.test(m[2]!)) readOnly.add(name);
    else writable.push(m[1]!);
  }
  if (readOnly.size === 0) return null;
  const writableNames = new Set(writable.map((w) => w.toLowerCase()));
  for (const [index, step] of steps.entries()) {
    if (step.action !== 'fill' && step.action !== 'fillRetry' && step.action !== 'type') continue;
    const m = /^role=textbox\[name=(?:"([^"]+)"|'([^']+)')(?:\s+i)?\]/.exec(step.selector.trim());
    const name = (m?.[1] ?? m?.[2] ?? '').toLowerCase();
    if (name === '' || !readOnly.has(name) || writableNames.has(name)) continue;
    const asked = m?.[1] ?? m?.[2] ?? '';
    // **The field's REAL input, by the same name under another role.**
    // Live (HIR-EC-001, run 15): the hire form renders `textbox "Hire Date"
    // readonly` — the picker's display — beside `Date "Hire Date"`, which is
    // the input. The remedy was a list of the first six writable textboxes on
    // the page, none of them this field's: it told the model to fill
    // "Username" for a Hire Date, three runs running. A node of the same name
    // that something can be entered into is the answer, and the tree has it.
    const input = sameNamedInput(lines, asked);
    return {
      index,
      name: asked,
      writable: [...new Set(writable)].slice(0, 6),
      input,
    };
  }
  return null;
}

/** A non-readonly node of this name, under whatever role the tree gives it, that an entry step can drive. */
function sameNamedInput(lines: readonly string[], field: string): { role: string; name: string } | null {
  const needle = squash(field);
  if (needle === '') return null;
  for (const line of lines) {
    const m = /^([a-z-]+)\s+"((?:[^"\\]|\\.)*)"(.*)$/i.exec(line);
    if (m === null) continue;
    const role = (m[1] ?? '').toLowerCase();
    const name = (m[2] ?? '').replace(/\\(.)/g, '$1').trim();
    if (role === 'textbox' || squash(name) !== needle) continue;
    if (/\b(readonly|disabled)\b/.test(m[3] ?? '')) continue;
    const control = { role, name };
    if (entryStepFor(control, 'x', '') !== null) return control;
  }
  return null;
}

/**
 * A value that is still the sheet's angle-bracket TOKEN — `<NON_EXISTING_EMPLOYEE_ID>`,
 * `<HR_ADMIN_ACCOUNT>` — typed as if it were data.
 *
 * Live (ec10_2 HIR-EC-012, 2026-09-02): the flow filled Replaced Employee ID
 * with the literal `<NON_EXISTING_EMPLOYEE_ID>`; the page URL-encoded it into
 * `check-replaced-employee/%3CNON_EXIS…`, the API rejected malformed input,
 * and the step "proved" a rejection the case never asked about. A token names
 * something the tester supplies; it is never itself the input.
 */
// `PLACEHOLDER_TOKEN` lives in value-resolution.ts, which resolves what this lint would refuse.

export function typesPlaceholderToken(
  steps: readonly FlowStep[],
): { index: number; token: string; action: string } | null {
  for (const [index, step] of steps.entries()) {
    if (step.action !== 'fill' && step.action !== 'fillRetry' && step.action !== 'type' && step.action !== 'selectOption') continue;
    const value = (step as { value?: unknown }).value;
    if (typeof value !== 'string') continue;
    const m = PLACEHOLDER_TOKEN.exec(value);
    if (m !== null) return { index, token: m[0], action: step.action };
  }
  return null;
}

/**
 * A step that uses a Test data pair nobody has confirmed (`unconfirmedValue`:
 * `= ? รอตารางโครงการ DVT`, an OQ- id, TBD, `ต้องระบุ … ก่อน Execute`), or
 * null.
 *
 * Live (ec09 HIR-EC-009, 2026-09-03): the sheet's `University Type = ต้องระบุ
 * เป็น DVT Partnered University หรือ Other University ก่อน Execute` is an
 * instruction to decide before executing; the model decided for it and
 * wrote `University Type = DVT Partnered University` into a workflow goal,
 * and three `= ?` fields were dropped without a word — then the app refused
 * Submit for the required `Course of Time` nobody had a value for. Three
 * shapes are caught: an input step (fill / fillRetry / type / paste /
 * selectOption) whose value IS the marker, an input step aimed at a field
 * whose pair is unconfirmed (exact label, see `unconfirmedFieldIn`), and a
 * workflow goal naming such a field as a `X = Y` / `set X to Y` pair
 * (`goalOutcomes`, the agent's own parse — a goal that merely mentions the
 * word is left alone, since "Type" is a word). Assertions on the marker
 * text are `assertsOpenQuestion`'s and `ungroundedTextExpectation`'s.
 */
export function usesUnconfirmedValue(
  setup: readonly FlowStep[],
  steps: readonly FlowStep[],
  pairs: readonly TestDataPair[],
): { section: 'setup' | 'steps'; index: number; key: string; value: string; how: string } | null {
  const unconfirmed = pairs.filter((pair) => unconfirmedValue(pair.value));
  if (unconfirmed.length === 0) return null;
  const scan = (section: 'setup' | 'steps', list: readonly FlowStep[]) => {
    for (const [index, step] of list.entries()) {
      const value = (step as { value?: unknown }).value;
      const text = typeof value === 'string' ? value : '';
      if (step.action === 'fill' || step.action === 'fillRetry' || step.action === 'type' || step.action === 'selectOption') {
        if (text.trim() !== '' && unconfirmedValue(text)) {
          const pair = unconfirmed.find((p) => p.value === text.trim()) ?? unconfirmed[0]!;
          return { section, index, key: pair.key, value: pair.value, how: `${step.action}s the unconfirmed marker ${JSON.stringify(text)}` };
        }
        const pair = unconfirmedFieldIn(fieldLabelOf(step), pairs);
        if (pair !== null) {
          return { section, index, key: pair.key, value: pair.value, how: `${step.action}s ${JSON.stringify(text)} into ${JSON.stringify(fieldLabelOf(step))}` };
        }
      }
      if (step.action === 'workflow') {
        const goal = (step as { goal?: unknown }).goal;
        if (typeof goal !== 'string') continue;
        for (const outcome of goalOutcomes(goal)) {
          const pair = unconfirmedFieldIn(outcome.control, pairs);
          if (pair !== null) {
            return { section, index, key: pair.key, value: pair.value, how: `hands the agent a goal that sets ${JSON.stringify(`${outcome.control} = ${outcome.value}`)}` };
          }
        }
      }
    }
    return null;
  };
  return scan('setup', setup) ?? scan('steps', steps);
}

/**
 * The numbered steps of the case's script the flow never reaches.
 *
 * The procedure asks the author to cite the script step in each intent
 * ("Step 3: กด Verify"), and it does. That makes coverage checkable without
 * understanding Thai prose: parse the script's `N.` lines, collect the numbers
 * the intents cite, and any numbered step beyond the highest cited one — that
 * no intent marks "skipped step N: why" — was silently dropped. Live (ec10_2
 * HIR-EC-012): the flow cited steps 2 and 3 of a 7-step script and stopped;
 * the valid-replacement check, the identity data, Submit and the profile check
 * — the case's actual claim — were never authored, and the run reported on a
 * form it had only half filled.
 *
 * Returns null when the flow cites no step at all (nothing to reason from) or
 * when the script has no numbered steps.
 */
export function unperformedScriptSteps(
  caseText: string,
  steps: readonly FlowStep[],
): { performedThrough: number; total: number; missing: { n: number; text: string }[] } | null {
  const script = sectionOf(caseText, 'steps') ?? '';
  const numbered: { n: number; text: string }[] = [];
  for (const line of script.split('\n')) {
    const m = /^\s*(\d{1,2})[.)]\s*(.+)$/.exec(line);
    if (m !== null) numbered.push({ n: Number(m[1]), text: m[2]!.trim().slice(0, 80) });
  }
  if (numbered.length < 2) return null;
  const cited = new Set<number>();
  const skipped = new Set<number>();
  // Three carriers of a citation (2026-09-04, PRB-EC-001): an intent's
  // "Step 5: …" (the step word is data — `authoring.script.stepWords`), a
  // `workflow` step's GOAL — the same carrier rule `unassertedExpectedItems`
  // applies, since an agent leg's goal is where its script step is named —
  // and the sheet's own sub-numbering at the head of an intent or goal
  // ("5.4 กด Approve" performs step 5). `skipped step N: <why>` still marks a
  // skip, and only the skip word makes it one.
  // A sub-number that is an EXPECTED line's id ("1.1 dropdown shows 3") cites
  // the Expected block, not the script — the Expected ids are read out and
  // excluded, so the two numberings cannot be confused.
  const expectedIds = new Set(expectedItemsIn(caseText));
  const scriptNumbers = new Set(numbered.map((x) => x.n));
  for (const step of steps) {
    const intent = (step as { intent?: unknown }).intent;
    const goal = step.action === 'workflow' ? (step as { goal?: unknown }).goal : undefined;
    for (const text of [intent, goal]) {
      if (typeof text !== 'string') continue;
      for (const m of text.matchAll(AUTHORING.script.citation)) {
        const n = Number(m[2]);
        if (m[1] !== undefined) skipped.add(n);
        else cited.add(n);
      }
      const sub = /^\s*((\d{1,2})\.\d+)(?:[.\s:)-]|$)/.exec(text);
      if (sub !== null && !expectedIds.has(sub[1]!) && scriptNumbers.has(Number(sub[2]))) cited.add(Number(sub[2]));
    }
  }
  if (cited.size === 0) return null;
  const performedThrough = Math.max(...cited);
  const total = Math.max(...numbered.map((x) => x.n));
  const missing = numbered.filter((x) => x.n > performedThrough && !skipped.has(x.n) && !cited.has(x.n));
  if (missing.length === 0) return null;
  return { performedThrough, total, missing };
}

/** A claim about how the page is worded, in either of the sheet's languages. */
const WORDING_CLAIM = AUTHORING.wordingClaim;
/** Tree roles whose text is DATA — a row's value, an option — never the page's own wording. */
const DATA_ROLES = /^(cell|gridcell|rowheader|row|option|listitem|treeitem|menuitem)\b/i;

/**
 * The literal text an `expectVisible` / `expectText` asserts, when it asserts
 * one: a `text=` selector, or the name of a `role=…[name="…"]` selector — an
 * accessible name is text the page renders as much as a `text=` literal is —
 * with a trailing `>> nth=N` chain stripped first (2026-09-04, HIR-EC-001:
 * an open-question id asserted through a role name slipped past).
 */
function assertedText(step: FlowStep): string | null {
  if (step.action === 'expectText') return step.value.trim() || null;
  if (step.action !== 'expectVisible') return null;
  const head = step.selector.trim().replace(/\s*>>\s*nth=\d+\s*$/i, '').trim();
  const m = /^text=(?:"([^"]+)"|'([^']+)'|([^>]+))$/.exec(head);
  if (m) return (m[1] ?? m[2] ?? m[3] ?? '').trim() || null;
  const named = /^role=[a-z]+\s*\[name=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*i?\s*\]$/i.exec(head);
  if (named) return (named[1] ?? named[2] ?? '').replace(/\\(.)/g, '$1').trim() || null;
  return null;
}

/**
 * The part of a case whose words decide whether it CLAIMS something about
 * wording: its Expected output, or the whole case when it has none.
 *
 * Narrowing from the prompt to the case (2026-09-02) was the first half of
 * this; run 14 showed the second. HIR-EC-001 is a data-entry case with
 * nineteen Expected lines and not one of them mentions wording — but its Test
 * data carries the aside *"ถ้าไม่แนบแล้วกด Next ให้บันทึกข้อความที่ระบบแสดง"*
 * ("if you skip the attachment and press Next, record the message the system
 * shows"), and `ข้อความ` in it classified the whole row as a wording claim.
 * The lint then refused the flow's Employee-ID assertion as "a value the case
 * never states" — while `unassertedExpectedItems` refused the next attempt for
 * dropping it. Two lints, opposite demands, and the row could not be written
 * on any of three attempts.
 *
 * What a case CLAIMS is its Expected output. Test data is input material and a
 * Note is an aside; both routinely describe what a tester should observe, and
 * neither makes the case about spelling. A genuine wording claim says so where
 * the claim lives — PL_02_02's driver, `ข้อความสะกดถูกต้องตรงตาม Spec`, is an
 * Expected line.
 */
function wordingHaystack(caseText: string | undefined): string | undefined {
  if (caseText === undefined) return undefined;
  const expected = sectionOf(caseText, 'expected');
  return expected !== null && expected.trim() !== '' ? expected : caseText;
}

/**
 * A wording claim asserted on a data row instead of on the page's own labels.
 *
 * Live (be100 PL_02_02, 2026-08-25): the claim "ข้อความสะกดถูกต้องตรงตาม Spec"
 * was authored as `expectVisible text=Medical Reimbursement` — a plan NAME
 * the sheet never mentions, chosen as a stand-in for "the catalog's text is
 * right". Forty-five minutes earlier a sibling delete case had removed that
 * plan; the assertion then dead-ended on every run against a correctly
 * worded page. The runs before, authored against `text="Benefit Plans"` and
 * `text="Benefits Admin"`, proved. A wording claim may quote the test case's
 * own words, or a label the tree shows outside a data role (heading,
 * columnheader, button, link, breadcrumb); a value found only in a cell is a
 * row, and a row is not spec. Returns the first offending step, or null.
 */
export function wordingClaimAssertsDataValue(
  prompt: string,
  steps: readonly FlowStep[],
  evidenceTree: string,
  codeContext?: string,
  /**
   * The CASE's own words, when the caller can separate them from the prompt.
   *
   * **What decides "is this a wording claim" must be the case, never the
   * background.** The prompt a catalog row is authored from carries the
   * retrieved requirement documents as well as the row, and `WORDING_CLAIM`
   * matches the Thai `ข้อความ` — "message" — which any Thai specification
   * contains many times over. Measured on ec10 (2026-09-02): of ten rows only
   * three say `ข้อความ` themselves, yet every row was classified a wording
   * claim from the background alone, and this lint then refused each one for
   * asserting a value the retrieved documents happened not to quote — a new
   * hire's own keyed name, a duplicate-notice, a success message. Four rows
   * were lost that way and none of them was about wording at all.
   *
   * Absent (a hand-authored flow, `wow go`) the prompt stands in, exactly as
   * before.
   */
  caseText?: string | undefined,
): { index: number; value: string } | null {
  if (!WORDING_CLAIM.test(wordingHaystack(caseText) ?? prompt)) return null;
  // No tree, no opinion. Ungrounded authoring has nothing to tell a label
  // from a row with, and a lint that refuses on absent evidence refuses
  // every honest wording flow too (caught by the echo-pipeline test, whose
  // breadcrumb assertions are exactly right).
  if (evidenceTree.trim() === '') return null;
  const fold = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();
  const claim = fold(prompt);
  const labelLines = evidenceTree
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !DATA_ROLES.test(line))
    .map(fold);
  // A string the repository declares (a message catalog's value, a
  // component's words) is a label the spec owns — the code-grounded rail
  // invites asserting it, same as ungroundedTextExpectation accepts it.
  labelLines.push(...declaredControlStrings(codeContext).map(fold));
  for (const [index, step] of steps.entries()) {
    const text = assertedText(step);
    if (text === null) continue;
    const needle = fold(text);
    if (needle.length < 3 || claim.includes(needle)) continue;
    // A REGEX asserts a form, not a row. `/\b2[0-9]{7}\b/` is HIR-EC-001's
    // Expected line 14.1 — "an 8-digit Employee ID whose first digit is 2" —
    // written as the only thing that can check it, and there is no page to
    // quote it from: a pattern is never "a value the case never states" when
    // the case states the pattern in words. Refusing it left the row with no
    // way to assert 14.1 at all.
    if (/^\/.*\/[a-z]*$/i.test(text.trim())) continue;
    if (labelLines.some((line) => line.includes(needle))) continue;
    return { index, value: text };
  }
  return null;
}

/**
 * An authored `request` whose METHOD the indexed endpoints do not declare.
 *
 * Live (be100 PL_03_03, 2026-08-25): the flow called `GET /api/benefit-plans`
 * and the application answered `405 Method Not Allowed`, because that handler
 * exports POST, PUT and DELETE and no GET. Two `high` defects were filed
 * against an app behaving exactly as written. The model had not invented the
 * endpoint — the prompt tells it to take endpoints from the repository and
 * the PATH was real — it invented the *method*, the half of an endpoint the
 * index did not hold: the file-convention router emitted `route` nodes built
 * from the file path alone, and `operation` nodes came only from an OpenAPI
 * document nobody had supplied.
 *
 * With operations indexed the check is exact. It fires ONLY when the path is
 * declared and the method is not — an endpoint outside the index says
 * nothing (a proxy, a service on another host, an unindexed repo), and
 * silence must not become a refusal. Returns the offending step with the
 * methods that path does answer, or null.
 */
export function unindexedRequestMethod(
  steps: readonly FlowStep[],
  declaredOperations: readonly string[],
): { index: number; method: string; path: string; declared: string[] } | null {
  if (declaredOperations.length === 0) return null;
  const byPath = new Map<string, Set<string>>();
  for (const operation of declaredOperations) {
    const [method, path] = operation.trim().split(/\s+/, 2);
    if (method === undefined || path === undefined) continue;
    const key = path.toLowerCase();
    const set = byPath.get(key) ?? new Set<string>();
    set.add(method.toUpperCase());
    byPath.set(key, set);
  }
  for (const [index, step] of steps.entries()) {
    if (step.action !== 'request') continue;
    const method = (step.method ?? 'GET').toUpperCase();
    // The path alone: an absolute URL's origin and any query string are not
    // part of what the index declares.
    let path: string;
    try {
      path = new URL(step.url, 'http://x.test').pathname;
    } catch {
      continue;
    }
    const declared = byPath.get(path.toLowerCase());
    // Not indexed at all — no opinion. Only a path the repo DOES declare can
    // contradict a method.
    if (declared === undefined || declared.has(method)) continue;
    // HEAD is served by a GET handler in every framework this indexes.
    if (method === 'HEAD' && declared.has('GET')) continue;
    return { index, method, path, declared: [...declared].sort() };
  }
  return null;
}

/**
 * A `goto` to a path the application's own codebase declares no route for.
 *
 * The prompt already says never to invent an endpoint; this says the same of
 * a PAGE, and can finally check it. Live (be100 PL_02_03, 2026-08-25): a flow
 * navigated to a URL that answered 404, every step after it failed against
 * the error page, and the run filed those failures against the application.
 * The path was invented — a plausible-looking route derived from a label —
 * and the repository has held the real list of routes all along.
 *
 * Only fires when routes are indexed AND the path looks like an application
 * page: an absolute URL to another origin is somebody else's business, and a
 * path with no declared route in a repo that declares none says nothing. The
 * nearest declared routes ride along in the refusal, because "that page does
 * not exist" is far less useful than "you meant this one".
 */
export function ungroundedGoto(
  steps: readonly FlowStep[],
  declaredRoutes: readonly string[] = [],
  deploymentUrl?: string | undefined,
): { index: number; url: string; near: string[] } | null {
  if (declaredRoutes.length === 0) return null;
  for (const [index, step] of steps.entries()) {
    if (step.action !== 'goto') continue;
    const url = authoredStepUrl(step);
    if (url === null) continue;
    // Another origin is not this application's routing table's business.
    if (/^https?:\/\//i.test(url) && deploymentUrl !== undefined) {
      try {
        if (new URL(url).origin !== new URL(deploymentUrl).origin) continue;
      } catch {
        continue;
      }
    }
    const path = pathnameOf(url) ?? (url.startsWith('/') ? url : null);
    if (path === null) continue;
    if (routeIsDeclared(path, declaredRoutes, deploymentUrl) !== false) continue;
    return { index, url, near: nearestRoutes(path, declaredRoutes).map((one) => one.pattern) };
  }
  return null;
}

function authoredStepUrl(step: FlowStep): string | null {
  const url = (step as { url?: unknown }).url;
  return typeof url === 'string' && url !== '' ? url : null;
}

export function foreignAuthoredHost(
  steps: readonly FlowStep[],
  deploymentUrl: string | undefined,
): { index: number; action: string; url: string; actualHost: string; expectedHost: string } | null {
  if (deploymentUrl === undefined) return null;
  let expectedHost: string;
  try {
    expectedHost = new URL(deploymentUrl).host;
  } catch {
    return null;
  }
  for (const [index, step] of steps.entries()) {
    const url = authoredStepUrl(step);
    if (url === null || url.includes('{{')) continue;
    try {
      const actualHost = new URL(url).host;
      if (actualHost !== expectedHost) {
        return { index, action: step.action, url, actualHost, expectedHost };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function foreignHostRefusal(
  flowName: string,
  foreign: { action: string; url: string; actualHost: string; expectedHost: string },
): string {
  return (
    `the authored flow "${flowName}" has a ${foreign.action} URL ${JSON.stringify(foreign.url)} on host ` +
    `"${foreign.actualHost}", but this run's deployment host is "${foreign.expectedHost}". ` +
    `The run's own host "${foreign.expectedHost}" is the only one this catalog may reach. ` +
    `Use "${foreign.expectedHost}" for this URL, or make it relative to the deployment URL.`
  );
}

export function loginProofAssertsLoginPage(steps: readonly FlowStep[]): number | null {
  let sawCredentialFill = false;
  let sawSubmitClick = false;
  for (const [index, step] of steps.entries()) {
    if (step.action === 'fill' || step.action === 'type') {
      const text = `${(step as { selector?: string }).selector ?? ''} ${(step as { intent?: string }).intent ?? ''}`;
      if (/password|passwd|pwd/i.test(text)) sawCredentialFill = true;
      continue;
    }
    if (step.action === 'click' && sawCredentialFill) {
      sawSubmitClick = true;
      continue;
    }
    if (step.action === 'expectUrl' && sawSubmitClick) {
      if (/(^|\/)(login|signin|sign-in|auth|sso)(\/|$)/i.test(step.value)) return index;
      // A post-submit expectUrl of a non-login path is exactly right — done.
      sawCredentialFill = false;
      sawSubmitClick = false;
      continue;
    }
    if (step.action === 'goto') {
      sawCredentialFill = false;
      sawSubmitClick = false;
    }
  }
  return null;
}

export function unsynchronizedLoginSubmit(steps: readonly FlowStep[]): number | null {
  let sawCredentialFill = false;
  for (const [index, step] of steps.entries()) {
    if (step.action === 'fill' || step.action === 'type') {
      const text = `${(step as { selector?: string }).selector ?? ''} ${(step as { intent?: string }).intent ?? ''}`;
      if (/password|passwd|pwd/i.test(text)) sawCredentialFill = true;
      continue;
    }
    if (step.action === 'click' && sawCredentialFill) {
      const next = steps[index + 1];
      if (next !== undefined && next.action === 'goto') return index;
      sawCredentialFill = false;
      continue;
    }
    // Any non-fill step between the credential fill and a later click means
    // that click is no longer "the submit of this credential block".
    if (step.action !== 'click') sawCredentialFill = false;
  }
  return null;
}

/**
 * Assertions that read what actually happened, as opposed to where we ended up.
 *
 * `expectUrl` is deliberately absent. A URL says which page is open; it says
 * nothing about whether the thing the step was for took place, and after a
 * `workflow` step that is the entire question.
 */
const OUTCOME_ASSERTIONS = new Set([
  'expectText',
  'expectVisible',
  'expectHidden',
  'expectValue',
  'expectCount',
  'expectAttribute',
  'expectEnabled',
  'expectDisabled',
  'expectCalls',
  'expectStatus',
  'expectJson',
  'expectDbRow',
  'expectDbDelta',
  'expectDbCount',
  'expectDbUnchanged',
]);

/**
 * A `workflow` step whose outcome nothing checks.
 *
 * The agent reports its own success, and that report is not evidence: the
 * prompt has always said to settle an agent-driven leg with something
 * independent. This is the guarantee behind the sentence. It exists because
 * removing a *wrong* independent check is not an improvement — measured on one
 * prompt, teaching the author not to claim a database it has no evidence for
 * correctly deleted an unfounded `expectDbDelta` and left the flow ending on
 * `expectUrl "/en"`, which passes whether or not the request was ever
 * submitted. A weaker claim that cannot fail is the failure mode this whole
 * file exists to prevent.
 *
 * `expectUrl` does not count, on purpose. Navigation is not an outcome.
 */
/**
 * Which of two weakly-refused attempts to keep.
 *
 * Assertions are the point of a test — the rule the whole file is built on —
 * so the attempt that proves the most wins, and an earlier attempt wins a tie.
 * Earliest-on-a-tie matters: it makes the choice deterministic for the same
 * reason `temperature: 0` does, and a later attempt that was told exactly what
 * was wrong and changed nothing has given no evidence it is the better answer.
 */
function betterThan(
  candidate: { steps: readonly FlowStep[] },
  incumbent: { steps: readonly FlowStep[] } | undefined,
): boolean {
  if (incumbent === undefined) return true;
  return assertionCount(candidate.steps) > assertionCount(incumbent.steps);
}

function assertionCount(steps: readonly FlowStep[]): number {
  return steps.filter((step) => hasAssertion([step])).length;
}

export function unsettledWorkflowClaim(steps: readonly FlowStep[]): number | null {
  for (const [index, step] of steps.entries()) {
    if (step.action !== 'workflow') continue;
    const settled = steps
      .slice(index + 1)
      .some((later) => OUTCOME_ASSERTIONS.has(later.action));
    if (!settled) return index;
  }
  return null;
}

/** Why an `e2e` flow is not end to end. Each is a distinct thing to fix. */
export type NotEndToEndReason = 'one-page' | 'agent-journey';

/** The path of a url or a path-ish string, for comparing pages rather than urls. */
function pathOf(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  try {
    return new URL(trimmed).pathname;
  } catch {
    // A relative `goto` — already a path. Drop query and hash so "?tab=2" is
    // not mistaken for travel to another page.
    return (trimmed.split(/[?#]/)[0] ?? trimmed) || trimmed;
  }
}

/**
 * An `e2e` flow that never leaves the page it started on.
 *
 * The scope is a promise to the person who chose it, and the only way to keep
 * a promise like that is to check it. Measured this session: asked for the
 * overtime journey, authoring produced a flow whose entire body was one
 * `workflow` step and an `expectUrl` — nine runs out of nine before the
 * journey capture existed. Both shapes below are that degradation, and both
 * are indistinguishable from a working test until someone reads the flow.
 *
 * Conservative on purpose, because a false refusal costs a flow:
 * - pages are compared by PATH, so a second `goto` to the same page (the
 *   clearStorage-then-reload idiom) is not travel;
 * - a `workflow` step CAN navigate, so a flow containing one is not confined
 *   merely for containing it — only a flow whose journey IS that one step;
 * - the bar is "more than the page it started on", never a page count.
 */
export function notEndToEnd(
  setup: readonly FlowStep[],
  steps: readonly FlowStep[],
  startUrl: string | undefined,
): NotEndToEndReason | null {
  const all = [...setup, ...steps];
  const pages = new Set<string>();
  if (startUrl !== undefined) pages.add(pathOf(startUrl));
  for (const step of all) {
    if (step.action === 'goto') pages.add(pathOf(step.url));
    // An expectUrl is a claim about where the flow now is, so it is evidence
    // of travel exactly as a goto is — and it is the evidence a flow that
    // navigates by CLICKING leaves behind.
    if (step.action === 'expectUrl') {
      const claimed = pathOf(step.value);
      if (claimed !== '' && ![...pages].some((page) => page.includes(claimed))) {
        pages.add(claimed);
      }
    }
    // A click on a LINK is a navigation by construction — a link is a GET to
    // somewhere else, which is precisely what this lint asks the flow to do.
    // Needed since the canonical login proof became expectHidden of the
    // submit control: a flow that then travels by clicking sidebar links can
    // honestly carry no expectUrl at all, and was refused three times running
    // as "never leaves the page it starts on" while clicking its way across
    // four pages (run 10, live).
    if (step.action === 'click' && /^role=link\b/i.test(step.selector)) return null;
  }
  if (pages.size > 1) return null;

  // One page. Was the journey handed to the agent, or simply never written?
  // Different fixes, so different reasons.
  return steps.some((step) => step.action === 'workflow') ? 'agent-journey' : 'one-page';
}

/** A trailing "(3)" in an accessible name: a live count, not an identity. */
const COUNT_SUFFIX = /\(\s*\d+\s*\)\s*$/;

/**
 * A selector that pins a count inside an accessible name.
 *
 * The live case: a "Status (1)" tab. The count is every row the store holds,
 * including whatever a previous run, a seed or another tester left behind — so
 * the selector resolves on exactly one state of the data and drifts the moment
 * anything else exists. It is worse than a plain wrong selector because it
 * *works* the first time and then heals: the run goes green having paid a
 * model call to discover the number changed, which is a repair that will be
 * needed again on the next run and every run after it.
 *
 * Names that merely contain a number ("OT Day 1", "Step 2 of 4") are left
 * alone — the trailing parenthesised form is the count idiom specifically.
 */
export function countPinnedName(
  steps: readonly FlowStep[],
): { index: number; name: string } | null {
  for (const [index, step] of steps.entries()) {
    for (const selector of selectorsOf(step)) {
      const named = /\[name\s*=\s*"([^"]*)"/.exec(selector);
      const name = named?.[1];
      if (name !== undefined && COUNT_SUFFIX.test(name)) return { index, name };
    }
  }
  return null;
}

/** A whole value that is nothing but a number — the shape a count tile renders. */
const BARE_NUMBER = /^\d{1,4}(?:,\d{3})*(?:\.\d+)?$/;

/**
 * An assertion whose entire claim is a bare number the request never stated.
 *
 * `countPinnedName`'s disease, in text-assertion form. The model reads the
 * page's count tiles at authoring time and pins what they showed —
 * `expectVisible text="75"` — but that number counts the data as it stands
 * that minute, and on an application whose writes persist, every later run
 * that creates or deletes a row makes the assertion false forever. Measured
 * (be100, 2026-08-25): an entire scenario of count checks dead-ended on
 * exactly this after the app's storage became a shared database, and repair
 * could not rescue them — an assertion always keeps its claim, and the claim
 * itself had rotted.
 *
 * A number the REQUEST states is exempt: the sheet's word is the claim
 * (the EXPECTED VALUES rule), and refusing it would untest the case.
 * `expectCount` is exempt too — it counts elements the flow selects, not
 * text the data renders.
 */
export function volatileCountAssertion(
  steps: readonly FlowStep[],
  requestText: string,
): { index: number; value: string } | null {
  for (const [index, step] of steps.entries()) {
    if (!step.action.startsWith('expect') || step.action === 'expectCount') continue;
    const candidates: string[] = [];
    const selector = (step as { selector?: string }).selector ?? '';
    const quoted = /text\s*=\s*"([^"]*)"/.exec(selector);
    if (quoted?.[1] !== undefined) candidates.push(quoted[1]);
    const bare = /text\s*=\s*([^\s">]+)\s*$/.exec(selector);
    if (bare?.[1] !== undefined) candidates.push(bare[1]);
    const value = (step as { value?: string }).value;
    if (typeof value === 'string' && value !== '') candidates.push(value);
    for (const candidate of candidates) {
      if (BARE_NUMBER.test(candidate) && !requestText.includes(candidate)) {
        return { index, value: candidate };
      }
    }
  }
  return null;
}

/**
 * A step wedged between the credential fills and the submit click.
 *
 * Not a style preference — measured. The engine's hydration replay
 * (`nativeFormResubmitDetected`) recovers a sign-in that landed before the
 * application hydrated, and it recognises the shape it repairs as *an adjacent
 * credential fill block followed by the click*. One assertion in between and
 * the replay does not fire: the click degrades to the form's native GET
 * submit, no session is created, and every later step runs against the
 * sign-in page. Proven by inserting a single expectValue into a flow that
 * passed 31/31 and watching the login stop working entirely.
 *
 * Only fires when a click really does follow before the next navigation —
 * otherwise the interposed step is not standing between anything.
 */
export function interruptedCredentialSubmit(
  steps: readonly FlowStep[],
): { index: number; click: number } | null {
  let inBlock = false;
  let sawPassword = false;
  for (const [index, step] of steps.entries()) {
    if (step.action === 'fill' || step.action === 'type') {
      inBlock = true;
      if (isCredentialFill(step)) sawPassword = true;
      continue;
    }
    if (!inBlock) continue;
    if (step.action === 'click') {
      inBlock = false;
      sawPassword = false;
      continue;
    }
    if (sawPassword) {
      for (let j = index + 1; j < steps.length; j += 1) {
        const later = steps[j];
        if (later === undefined || later.action === 'goto') break;
        if (later.action === 'click') return { index, click: j };
      }
    }
    inBlock = false;
    sawPassword = false;
  }
  return null;
}

/**
 * A sign-in submit clicked a second time, with nothing re-typed in between.
 *
 * The live shape (DB_02_01): `fill email · fill password · click "Sign in" ·
 * expectUrl · click "Sign in" · expectUrl`. The model wrote a defensive retry
 * — reasonable-looking, and a guaranteed false failure. The engine already
 * replays a submit that landed before the page hydrated
 * (`nativeFormResubmitDetected`), so by the time the second click runs the
 * login has succeeded and the "Sign in" button is gone: the step fails, and it
 * is filed as a `high` defect against an application that did exactly the
 * right thing.
 *
 * Note this is a repeated CLICK, not a repeated fill block. A second block
 * that re-types the credentials is a different shape and is left alone — it is
 * what a genuine second attempt looks like, and the engine's own replay emits
 * precisely that.
 *
 * Deliberately narrow, so it can only fire on the unambiguous case:
 * - the same submit selector, verbatim. A different control ("Sign in with
 *   Microsoft") is a different path and may be the point of the test.
 * - reset by any `goto` — going back to the sign-in page is how a legitimate
 *   persona switch is spelled, and the flow that does it means it.
 * - reset by any `fill`/`type` — that is a genuine retry with new input, not a
 *   bare re-click.
 * Anything else in between (an assertion, a wait) passes through, because the
 * live case has an `expectUrl` sitting right there.
 */
export function duplicateCredentialSubmit(
  steps: readonly FlowStep[],
): { first: number; repeat: number; selector: string } | null {
  let sawCredentialFill = false;
  let submit: { index: number; selector: string } | null = null;

  for (const [index, step] of steps.entries()) {
    if (step.action === 'goto') {
      sawCredentialFill = false;
      submit = null;
      continue;
    }
    if (step.action === 'fill' || step.action === 'type') {
      if (isCredentialFill(step)) sawCredentialFill = true;
      submit = null;
      continue;
    }
    if (step.action !== 'click') continue;
    if (submit !== null && submit.selector === step.selector) {
      return { first: submit.index, repeat: index, selector: step.selector };
    }
    if (sawCredentialFill) {
      submit = { index, selector: step.selector };
      // **The credential window ends at the submit.** `sawCredentialFill` used
      // to be cleared only by a `goto`, so after sign-in it stayed true for the
      // rest of the flow and every later click was a candidate sign-in submit.
      // Any two clicks on one selector with no other click between them were
      // then reported as a login retry — which is the ordinary shape of a
      // wording case: open a popup, read it, close it, open it again. PL_02_03
      // and PL_02_04 were both lost to it, told by the refusal that their
      // "Create Plan" button was a sign-in form, and re-asked until the attempt
      // budget ran out. One submit is all this lint was ever about.
      sawCredentialFill = false;
    }
  }
  return null;
}

/** A literal calendar date, the only kind a period gate can be checked against. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date typed into the application with no clock pinned.
 *
 * A date field is almost never free: applications gate them on a period —
 * a payroll window, a cut-off, a booking horizon — computed from *today*. So
 * a flow that types a fixed date passes this week and fails on the day the
 * window moves, with a report that blames the field. Measured live: an
 * overtime form rejects any date outside the current 21st-to-20th payroll
 * period, computed from the real system date.
 *
 * `setClock` in setup is what makes the answer the same every run, and it is
 * the reason the action exists.
 */
export function unpinnedDateEntry(
  setup: readonly FlowStep[],
  steps: readonly FlowStep[],
): { index: number; value: string } | null {
  if (setup.some((step) => step.action === 'setClock')) return null;
  for (const [index, step] of steps.entries()) {
    if (step.action !== 'fill' && step.action !== 'type') continue;
    // A date the resolver computed from the run's own day (`Today`, `Hire
    // Date + 119 Day` → `relative-date`) is pinned by construction: it moves
    // WITH the window, which is the whole reason the source exists (CG-06).
    // Without this exemption every converted flow was refused for the very
    // thing the conversion fixed.
    if (step.valueSource?.kind === 'relative-date') continue;
    const value = String((step as { value?: unknown }).value ?? '').trim();
    if (ISO_DATE.test(value)) return { index, value };
  }
  return null;
}

export function strandedCredentialFill(steps: readonly FlowStep[]): number | null {
  let lastGoto: string | null = null;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    if (step.action === 'goto') {
      lastGoto = step.url;
      continue;
    }
    if (isCredentialFill(step) && lastGoto !== null && !LOGIN_URL_PATTERN.test(lastGoto)) {
      return i;
    }
  }
  return null;
}

/**
 * An authored `expectCount` that counts a role the page never exposes.
 *
 * The habit this catches: the model reads a `radiogroup` in the tree and
 * *infers* `role=radio` children — but the app renders the options as
 * `<button aria-pressed>` toggles, so `expectCount role=radio, 4` resolves
 * zero elements at any timeout, on every run, forever (PB-02-01, live). The
 * tree's lines each start with the node's role token, so "does this role
 * exist on the page" is a deterministic string check — and a refusal here
 * feeds the ordinary re-ask loop with the reason.
 *
 * Declines to judge a truncated tree: past the node budget, absence of
 * evidence is not evidence of absence — the same rule the tree's own
 * truncation notice states.
 */
/**
 * A presence assertion whose quoted text appears in NO node of the tree the
 * author was given — the sheet's wording asserted where the page renders
 * something else.
 *
 * Measured 2026-08-28, the same case authored by two models and both flows
 * run today with no model in the loop: a gemini-authored PL_02_01 asserted
 * `role=heading[name="Benefit Plan Catalog…"]` (the tree's rendering) and
 * passed; a claude-authored one asserted `text="Benefit Plans"`, `role=link
 * [name="Benefit Plans" i]`, `role=heading[name="Benefit Plans" i]` — the
 * REQUIREMENT's words — and dead-ended three times on a page that had the
 * heading all along. The LANGUAGE rule ("quote the accessibility tree's own
 * rendering, never the requirement document's wording") is a request in the
 * prompt; this is the guarantee, provider-independent: a model that obeys
 * never meets it, one that does not pays one informed re-ask that names the
 * nearest real renderings instead of a dead-ended run.
 *
 * Grounding is a case-insensitive CONTIGUOUS match against node names with
 * `url="…"` attributes stripped — word-wise matching would ground "Benefit
 * Plans" on a link's `/benefits/plans` URL, exactly the phantom this exists
 * to catch. Only `text=` and `role=…[name=…]` selectors are judged (the
 * first `>>` segment). Exempt after a `workflow` step (the page it ends on
 * was never captured) and on a truncated tree, the same two rules as
 * `ungroundedUrlExpectation`.
 */
/**
 * Every string the repository-context section declares the application
 * renders: the quoted spans of `renders the … strings [locale, file]: key:
 * "value" · …` lines and of a component's `says: "word" · "word"` detail.
 * One extractor for every consumer, so "declared by the code" cannot mean two
 * different things in two lints.
 */
export function declaredControlStrings(codeContext: string | undefined): string[] {
  if (!codeContext) return [];
  const found: string[] = [];
  for (const m of codeContext.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const value = (m[1] ?? '').replace(/\\(.)/g, '$1').trim();
    // A one-character span or a bare number is punctuation, not a label.
    if (value.length >= 2 && !/^[\d\s.,%]+$/.test(value)) found.push(value);
  }
  return found;
}

/**
 * A `workflow` step whose goal names a control the repository itself declares.
 *
 * The cost this removes: an agent leg pays model calls per turn for a journey
 * whose controls the codebase already names — PL_07 spent 108 calls hunting a
 * row behind a "Make Correction" control that `messages/en.json` declares
 * verbatim, and the deterministic form (click the declared string, expect the
 * declared dialog title) runs in milliseconds at $0 with the healer and the
 * agent-assist rung as the error backstop. The refusal steers, it does not
 * ban: the goal may keep the part NEITHER a tree nor the repository declares.
 *
 * Matching is deliberately narrow — only declared strings of 3+ characters,
 * whole-word, case-insensitive, appearing in the goal's own text — so a goal
 * about genuinely undeclared territory never trips it.
 */
/** A `/…/flags` literal — an assertion about a value's FORM, which no accessible name can render. */
const REGEX_LITERAL = /^\/.*\/[a-z]*$/i;

/**
 * The run of adjacent Capitalised words (single spaces between) that covers
 * `[at, at+length)` of `text`, lower-cased, or null when the span itself is
 * not capitalised. "choose Leave Type = Sick" at "Type" → "leave type".
 */
function capitalisedRunAround(text: string, at: number, length: number): string | null {
  const isCap = (word: string): boolean => /^\p{Lu}/u.test(word);
  const words: { start: number; end: number; word: string }[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)) words.push({ start: m.index, end: m.index + m[0].length, word: m[0] });
  const first = words.findIndex((w) => w.start === at);
  if (first === -1 || !isCap(words[first]!.word)) return null;
  let lo = first;
  let hi = first;
  while (lo > 0 && isCap(words[lo - 1]!.word) && text.slice(words[lo - 1]!.end, words[lo]!.start) === ' ') lo -= 1;
  while (hi < words.length - 1 && isCap(words[hi + 1]!.word) && text.slice(words[hi]!.end, words[hi + 1]!.start) === ' ') hi += 1;
  const run = text.slice(words[lo]!.start, words[hi]!.end).toLowerCase();
  return run.length >= length ? run : null;
}

export function workflowOverDeclaredControls(
  steps: readonly FlowStep[],
  codeContext: string | undefined,
): { index: number; goal: string; declared: string[] } | null {
  const declared = declaredControlStrings(codeContext).filter((v) => v.length >= 3);
  if (declared.length === 0) return null;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    if (step.action !== 'workflow') continue;
    const goal = step.goal.toLowerCase();
    const named = [
      ...new Set(
        declared.filter((v) => {
          const needle = v.toLowerCase();
          // Every occurrence: the first may sit inside a longer name and a
          // later one stand alone.
          for (let at = goal.indexOf(needle); at !== -1; at = goal.indexOf(needle, at + 1)) {
            const before = at === 0 ? ' ' : goal[at - 1]!;
            const after = at + needle.length >= goal.length ? ' ' : goal[at + needle.length]!;
            if (/[\p{L}\p{N}]/u.test(before) || /[\p{L}\p{N}]/u.test(after)) continue;
            // A declared word inside a longer CAPITALISED name in the goal
            // ("Type" in "Leave Type", "Leave" in "Sick Leave") names that
            // longer thing, not this control (2026-09-04, multirole
            // ML_01_04: "Type" and "Leave" from a message catalog matched
            // every leave-request goal). When the longer name is declared
            // too, IT is the control named, and it matches on its own turn.
            // Read from the goal's own casing; a lower-case goal keeps the
            // plain match.
            const compound = capitalisedRunAround(step.goal, at, needle.length);
            if (compound === null || compound === needle) return true;
          }
          return false;
        }),
      ),
    ];
    if (named.length > 0) return { index: i, goal: step.goal, declared: named.slice(0, 5) };
  }
  return null;
}

export function ungroundedTextExpectation(
  steps: readonly FlowStep[],
  axTree: string | undefined,
  /**
   * The repository-context section the author was given, when any. Its quoted
   * strings — a component's rendered words, a message catalog's values — are
   * evidence the same way a tree's names are: the code declares the page
   * renders them. Without this, every code-grounded assertion the prompt now
   * invites would be refused by the very lint meant to protect it.
   */
  codeContext?: string | undefined,
  /**
   * The case's own text. Wording the SHEET itself asserts is exempt: the
   * sheet's words ARE the claim, and refusing to author them rewrote real
   * wording bugs into assertions about whatever the page renders — which
   * then passed (EN-2 audit: the largest neutered-claim cluster). Let the
   * verbatim claim run; an exact-match miss over text the page holds
   * becomes a near-miss needs-review, which is the right verdict.
   */
  prompt?: string | undefined,
): { index: number; text: string; nearest: string[] } | null {
  if (!axTree || axTree.includes('TREE TRUNCATED')) return null;
  const names: string[] = [];
  for (const line of axTree.split('\n')) {
    const m = /^\s*[A-Za-z]+\s+"((?:[^"\\]|\\.)*)"/.exec(line);
    if (m && m[1] !== undefined && m[1] !== '') names.push(m[1]);
  }
  if (names.length === 0) return null;
  names.push(...declaredControlStrings(codeContext));
  const hay = names.map((n) => n.toLowerCase());
  const tokens = (s: string): Set<string> =>
    new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1));
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    // The page after an agent leg was never captured — nothing to ground on.
    if (step.action === 'workflow') return null;
    if (step.action !== 'expectVisible' && step.action !== 'expectText' && step.action !== 'expectAnyVisible') continue;
    // Every alternative of an either/or step is a presence claim of its own
    // (CG-08): a branch quoting the sheet's wording is a branch that can
    // never be the one shown, and the step then narrows to the other.
    for (const one of selectorsOf(step)) {
      const head = (one.split('>>')[0] ?? '').trim();
      const named =
        /^role=[a-z]+\s*\[name=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/i.exec(head) ??
        /^text=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(.+))$/s.exec(head);
      const text = (named?.[1] ?? named?.[2] ?? named?.[3] ?? '').replace(/\\(.)/g, '$1').trim();
      if (text === '') continue;
      // **A REGEX asserts a form, and no page renders one.** Live (run 16):
      // Expected 14.1 is "an 8-digit Employee ID whose first digit is 2", the
      // flow wrote it as a pattern, and this lint refused it for quoting "the
      // requirement document's wording" — while `unassertedExpectedItems`
      // refuses the flow that then drops it. The same exemption
      // `wordingClaimAssertsDataValue` already carries, for the same reason:
      // a pattern is checkable and unquotable at once.
      if (REGEX_LITERAL.test(text)) continue;
      const needle = text.toLowerCase();
      // The sheet's own words ARE the claim — exempt, run it, and an exact-miss
      // over text the page holds becomes a near-miss needs-review (the right
      // verdict for a wording dispute), instead of this lint rewriting the
      // claim into whatever the page renders, which then passes vacuously.
      if (prompt !== undefined && prompt.toLowerCase().includes(needle)) continue;
      if (hay.some((n) => n.includes(needle))) continue;
      // The nearest real renderings: most shared words, ties in tree order.
      const want = tokens(text);
      const nearest = names
        .map((n, at) => ({ n, at, hits: [...tokens(n)].filter((t) => want.has(t)).length }))
        .filter((c) => c.hits > 0)
        .sort((a, b) => b.hits - a.hits || a.at - b.at)
        .slice(0, 3)
        .map((c) => c.n);
      return { index: i, text, nearest: [...new Set(nearest)] };
    }
  }
  return null;
}

/**
 * Does an earlier step of this flow do the thing the disabled control's own
 * hint asks for?
 *
 * The tree describes the page AT REST, and a cascade is disabled at rest by
 * design. Live (HIR-EC-001 run 16): `button "District" value="— Select
 * Province first —" disabled`, and the flow picks Province at step 26 before
 * touching District at step 27 — exactly what Expected line 6.1 claims the
 * page does. Refusing it demanded the flow prove the cascade by not using it.
 *
 * The evidence is the control's own words: the hint names the field that
 * enables it, and an earlier step naming that field is the enabling. Nothing
 * is assumed about WHICH control enables what — only that the page said so
 * and the flow did it, in that order.
 */
function enabledByAnEarlierStep(line: string, earlier: readonly FlowStep[]): boolean {
  const hint = /\bvalue="((?:[^"\\]|\\.)*)"/.exec(line)?.[1];
  if (hint === undefined) return false;
  // The capitalised runs of the hint are the fields it names: "— Select
  // Province first —" names Province.
  // A run and its trailing tails: "Select Province" names Province, and the
  // hint's leading verb is instruction, not the field. Same tail rule as
  // `treeControlForPairKey`, and for the same reason — the prose sits in
  // front of the name, never behind it.
  const fields: string[] = [];
  for (const match of hint.matchAll(/\p{Lu}[\p{L}\p{N}]*(?:\s+\p{Lu}[\p{L}\p{N}]*)*/gu)) {
    const words = match[0].split(/\s+/);
    for (let take = words.length; take >= 1; take -= 1) {
      const tail = squash(words.slice(-take).join(' '));
      if (tail.length > 2) fields.push(tail);
    }
  }
  if (fields.length === 0) return false;
  const before = squash(JSON.stringify(earlier.map((step) => ('selector' in step ? step.selector : ''))));
  return fields.some((field) => before.includes(field));
}

/**
 * A selector whose ROLE the tree never exposes, on ANY action — the
 * generalisation of `ungroundedCountRole` (S4 of the 2026-08-28 agent-flaw
 * audit). Sixteen dead-ends on one page: the author wrote `role=combobox`,
 * `role=textbox`, native `select` for filters the tree exposes as
 * `button "Type:"`, `searchbox "Search benefit name"` — the roles a filter
 * USUALLY has, not the ones this page has. The refusal names the tree's own
 * line for the same name, so the re-ask can copy it.
 *
 * Second half, same line of the tree: a control marked `disabled` at rest
 * (the tree prints the token) may not be filled or clicked as the first
 * thing done to it — the repo's own test says the search box "starts
 * disabled until a filter is chosen", and six flows filled it first.
 *
 * Only `role=…` / `[role="…"]` / a bare `select` are judged; CSS and text
 * selectors say nothing the tree could contradict. A truncated tree
 * declines, and `expectHidden`/`expectCount 0` are exempt — asserting an
 * absence of a role the page lacks is the honest claim, not a phantom.
 */
export function ungroundedSelectorRole(
  steps: readonly FlowStep[],
  axTree: string | undefined,
): { index: number; role: string; name: string | null; nearest: string[]; disabled: boolean } | null {
  if (!axTree || axTree.includes('TREE TRUNCATED')) return null;
  const lines = axTree.split('\n').map((l) => l.trim()).filter(Boolean);
  const roles = new Set(lines.map((l) => (/^([a-z]+)\b/i.exec(l)?.[1] ?? '').toLowerCase()).filter(Boolean));
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    if (step.action === 'workflow') return null; // the page after a leg was never captured
    if (step.action === 'expectHidden' || (step.action === 'expectCount' && (step as { count?: number }).count === 0)) continue;
    // An either/or step carries several selectors; each alternative is judged
    // as a selector of its own (CG-08) — a phantom role in one branch is a
    // branch that can never be the one shown.
    for (const one of selectorsOf(step)) {
    const head = (one.split('>>')[0] ?? '').trim();
    // Three spellings, resolved to one (role, name) pair: the role engine
    // with an optional name, the CSS attribute form anywhere in the head
    // (`main [role="combobox"]`), and a native `select` element.
    let role: string;
    let name: string | null = null;
    const engine = /^role=([a-z]+)(?:\s*\[name=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'))?/i.exec(head);
    const attr = /\[role="([a-z]+)"\]/i.exec(head);
    const native = /(?:^|\s)select\b/i.test(head);
    if (engine) {
      role = (engine[1] ?? '').toLowerCase();
      name = (engine[2] ?? engine[3] ?? null)?.replace(/\\(.)/g, '$1') ?? null;
    } else if (attr) {
      role = (attr[1] ?? '').toLowerCase();
    } else if (native) {
      role = 'select';
    } else {
      continue;
    }
    const needle = name?.toLowerCase().replace(/\s*:$/, '') ?? null;
    // The role exists on the page: fine unless it is disabled and this step acts on it first.
    if (roles.has(role) || (role === 'select' && roles.has('combobox'))) {
      if (needle !== null && (step.action === 'fill' || step.action === 'click' || step.action === 'type' || step.action === 'selectOption')) {
        const line = lines.find((l) => new RegExp(`^${role}\\s+"[^"]*${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"]*"`, 'i').test(l));
        if (line !== undefined && /\bdisabled\b/.test(line) && !enabledByAnEarlierStep(line, steps.slice(0, i))) {
          return { index: i, role, name, nearest: [line], disabled: true };
        }
      }
      continue;
    }
    // The role does not exist: name the lines that carry the same name under another role.
    const nearest = needle === null
      ? []
      : lines.filter((l) => l.toLowerCase().includes(needle)).slice(0, 3);
    return { index: i, role, name, nearest, disabled: false };
    }
  }
  return null;
}

/**
 * The identifier-shaped values a case's Test Data / Expected columns carry —
 * plan ids, codes, record names — that a human tester was expected to CREATE
 * or READ, never facts already true of the application (S3 of the
 * 2026-08-28 audit). Thirteen be100 cases asserted `PL_07_01_02_03_04_05_06`,
 * `BP-DENTAL-01`, `TH_MED_005`, "Mock Country (TH)", `43 rows` as
 * pre-existing; the database holds none of them, and every one was filed as
 * the application failing.
 */
/**
 * An exclusivity or exact-count claim the flow never bounds.
 *
 * Live (ec10_3x HIR-EC-029, 2026-09-02): the Expected output reads "dropdown
 * แสดง 3 ค่า : Event Reason บนหน้า Key-in แสดงเฉพาะ New Hire / Replacement /
 * Migration". The page offered a dozen reasons — DATA MIGRATION, HIREDM,
 * H_NEWHIRE, H_RPLMENT, MT_EMP_INFO … — which is the defect the case exists
 * to catch. The flow asserted `expectVisible "New Hire"`, `"Replacement"`,
 * `"Migration"`: three presences that pass on a dropdown of a hundred. The case
 * only went red at all because one presence tripped on wording, so the report
 * blamed a label and never mentioned the extra options.
 *
 * The claim is a COUNT ("3 ค่า") or an "only" ("เฉพาะ"); proving it needs an
 * `expectCount` (or an `expectHidden` of every value the case says must not
 * appear, when it lists them — but the count is what closes the set). Returns
 * the claim phrase when the flow has neither.
 *
 * Since 2026-09-04 (HIR-EC-001) this is a view over `exclusivity.ts`'s
 * `unprovedExclusivity` — ONE detector for the prompt, the lint and the suite
 * runner. Its own regex had no word boundary and read "only" inside
 * "Read-only" ("Time Management Status และ O.T. Flag เป็น Read-only และ HR
 * ไม่สามารถแก้ไขเองได้"), refusing every attempt for a count of a set the page
 * does not have. Kept as an export so callers and tests keep their shape:
 * `claim` is the Expected line, `wanted` the size the line enumerates.
 */
export function unboundedExclusivityClaim(
  steps: readonly FlowStep[],
  caseText: string,
): { claim: string; wanted: number | null } | null {
  const found = unprovedExclusivity(steps, caseText);
  return found === null ? null : { claim: found.claim.line.slice(0, 140), wanted: found.claim.count };
}

// Structural fallbacks (`Violation.settle`) ---------------------------------------
//
// Each rewrites the flow IN PLACE — the step objects are shared between
// `result.steps` and `result.cases`, so a mutation is seen by both, and an
// insertion or removal is applied to both lists — and returns the note the
// flow carries, or null when the evidence does not allow the rewrite.

/** The flow shape the fallbacks edit: the body and the cases that partition it. */
export interface SettleableFlow {
  steps: FlowStep[];
  cases?: AuthoredCase[] | undefined;
}

/** Append the `[generated: …]` marker to a step's intent, in place. */
export function annotateStep(step: FlowStep, how: string): void {
  (step as { intent?: string | undefined }).intent = markGenerated((step as { intent?: string }).intent, how);
}

/** Remove one step from the body and from whichever case holds it. */
export function removeStep(flow: SettleableFlow, step: FlowStep): void {
  flow.steps = flow.steps.filter((s) => s !== step);
  for (const one of flow.cases ?? []) one.steps = one.steps.filter((s) => s !== step);
}

/**
 * Splice a step before an anchor, in the body and in the case holding the
 * anchor. A folded single case SHARES the body's array (`result.cases =
 * [{ steps: result.steps }]`), and is spliced once, not twice.
 */
export function insertStepBefore(flow: SettleableFlow, anchor: FlowStep, step: FlowStep): void {
  const at = flow.steps.indexOf(anchor);
  if (at >= 0) flow.steps.splice(at, 0, step);
  for (const one of flow.cases ?? []) {
    if (one.steps === flow.steps) continue;
    const i = one.steps.indexOf(anchor);
    if (i >= 0) one.steps.splice(i, 0, step);
  }
}

/**
 * The count that closes an exclusive set, from the tree (2026-09-04, the
 * fallback for `unprovedExclusivity`). The members the Expected line
 * enumerates (`optionSetsIn`, the parser's grammar) are looked up in the
 * evidence — every captured tree and the probe report — as `<role> "<member>"`
 * lines; when EVERY member is found under ONE role, that role is the item
 * role the opened list exposes, and an `expectCount` of it equal to the
 * sheet's size is inserted before the first body assertion that names a
 * member (the point where the model had the list open). A member the
 * evidence does not show, or members under two roles, is no evidence for a
 * count, and null keeps the refusal: a count of a role the page never
 * exposes is exactly the phantom `ungroundedCountRole` refuses.
 */
export function settleExclusivity(
  flow: SettleableFlow,
  claim: { line: string; marker: string; count: number | null },
  caseText: string,
  evidence: string | undefined,
): string | null {
  const expected = sectionOf(caseText, 'expected') ?? '';
  const sets = optionSetsIn(expected.replace(/\[RECORD ONLY\]\s*/g, ''));
  const wanted = claim.line.trim();
  const set = sets.find((one) => one.line.trim() === wanted || wanted.includes(one.line.trim()) || one.line.includes(wanted)) ?? sets.find((one) => one.exact);
  if (set === undefined || set.members.length < 2) return null;
  const lines = (evidence ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const roles = new Set<string>();
  for (const member of set.members) {
    const needle = member.trim().toLowerCase();
    const line = lines.find((l) => {
      const m = /^([a-z]+)\s+"((?:[^"\\]|\\.)*)"/i.exec(l);
      return m !== null && (m[2] ?? '').replace(/\\(.)/g, '$1').trim().toLowerCase() === needle;
    });
    if (line === undefined) return null;
    roles.add((/^([a-z]+)/i.exec(line)?.[1] ?? '').toLowerCase());
  }
  if (roles.size !== 1) return null;
  const role = [...roles][0]!;
  const members = set.members.map((m) => m.trim().toLowerCase());
  const anchor = flow.steps.find(
    (step) =>
      /^expect/.test(step.action) &&
      selectorsOf(step).some((sel) => members.some((m) => sel.toLowerCase().includes(m))),
  );
  if (anchor === undefined) return null;
  const count = claim.count ?? set.members.length;
  const step: FlowStep = {
    action: 'expectCount',
    selector: withQualifiedRole(`role=${role}`),
    count,
    intent: markGenerated(
      claim.line.slice(0, 100),
      `counts the closed set — ${count} ${role}(s), each member named in the captured tree or probe report; the sheet says "${claim.marker}" and presence alone cannot fail on an extra item`,
    ),
  };
  insertStepBefore(flow, anchor, step);
  return `closed set ${JSON.stringify(claim.line.slice(0, 80))}: expectCount role=${role} = ${count} inserted by the harness (marked [generated: …])`;
}

/**
 * Repoint a selector's ROLE to the one a tree line shows for the same name
 * (the fallback for `ungroundedSelectorRole`): only the engine form
 * `role=x[name="…"]`, only when the nearest line's name equals the step's
 * name, and only from the tree's own line — the tree outranks the model.
 */
export function settleSelectorRole(
  step: FlowStep,
  found: { role: string; name: string | null; nearest: readonly string[]; disabled: boolean },
): string | null {
  if (found.disabled || found.name === null) return null;
  const line = found.nearest[0];
  if (line === undefined) return null;
  const m = /^([a-z]+)\s+"((?:[^"\\]|\\.)*)"/i.exec(line.trim());
  if (m === null) return null;
  const treeRole = (m[1] ?? '').toLowerCase();
  const treeName = (m[2] ?? '').replace(/\\(.)/g, '$1').trim().toLowerCase().replace(/\s*:$/, '');
  if (treeRole === '' || treeName !== found.name.trim().toLowerCase().replace(/\s*:$/, '')) return null;
  const selector = (step as { selector?: string }).selector;
  if (typeof selector !== 'string' || !new RegExp(`^role=${found.role}\\b`, 'i').test(selector.trim())) return null;
  const repointed = selector.trim().replace(new RegExp(`^role=${found.role}\\b`, 'i'), `role=${treeRole}`);
  (step as { selector: string }).selector = repointed;
  annotateStep(step, `role ${JSON.stringify(found.role)} repointed to ${JSON.stringify(treeRole)}, the role the tree shows for ${JSON.stringify(found.name)}`);
  return `role=${found.role} for ${JSON.stringify(found.name)} repointed to role=${treeRole} from the tree's own line (marked [generated: …])`;
}

/** `Field = value` pairs written on one line of prose — the sheet's own pair grammar (CG-02), read structurally. */
function pairsOnLine(line: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const m of line.matchAll(/([\p{L}\p{N}][^=\n:：]*?)\s*[=：]\s*([^=\n]+?)(?=\s+[\p{L}\p{N}][^=\n]*?\s*[=：]\s|\s*$)/gu)) {
    const key = (m[1] ?? '').trim().split(/\s+/).slice(-4).join(' ');
    const value = valueHeadOf((m[2] ?? '').trim());
    if (key !== '' && value !== '') out.push({ key, value });
  }
  return out;
}

/**
 * The fields an Expected line gives a VALUE, as against the fields it merely
 * mentions.
 *
 * The distinction decides who may supply a value. `10.1 Employee Group = A -
 * Permanent` asserts a value: nothing the harness picks may stand under it.
 * `6.2 ระบบกรอง Sub-District ตาม District ที่เลือก` asserts a BEHAVIOUR — that
 * the list filters — and says nothing about which sub-district; the harness
 * choosing one cannot make that claim true or false. Live (HIR-EC-001,
 * 2026-09-07): the sheet's own cell for Sub-District is the instruction
 * "เลือกแขวงที่อยู่ใน District ที่เลือก", so no value exists on either side, and
 * treating the prose mention as an assertion left the field permanently
 * unfillable — the listbox was typed with the instruction and answered
 * "ไม่พบผลลัพธ์".
 */
/**
 * The ITEMS of a block the sheet wrote as one run of text.
 *
 * An Expected block and a workflow goal both reach the author as a single
 * line whose items are joined by `; ` — the claim renderer joins them that
 * way, and the model writes a goal the same way. Read line by line, HIR-EC-001
 * yields field names like `"ตามค่าที่กรอก; 3.2 event reason"` and
 * `"Sep 2027; Company"`, so the Expected-named gate matched nothing and not
 * one of the forty fields in run 12's two big legs was lifted out as a
 * deterministic step: 37 steps, 0 `fill`, 0 `selectOption`, 1% of the page's
 * controls exercised.
 *
 * A `;` ends an item exactly as a newline does — `valueHeadOf` already cuts a
 * value at one, so no value has ever spanned one — and the leading item
 * number goes with the split, per item rather than per line.
 */
function blockItems(block: string): string[] {
  return block
    .split('\n')
    .flatMap((line) => line.split(/;\s*/))
    .map((item) => item.replace(/^\s*\d+(?:\.\d+)*[.)]?\s*/, '').trim())
    .filter((item) => item !== '');
}

export function expectedValuedFields(expected: string): Set<string> {
  const names = new Set<string>();
  for (const line of blockItems(expected)) {
    for (const pair of pairsOnLine(line)) names.add(pair.key.toLowerCase().replace(/\s+/g, ' ').trim());
  }
  return names;
}

export function expectedNamedFields(expected: string): Set<string> {
  const names = new Set<string>();
  for (const line of blockItems(expected)) {
    const pairs = pairsOnLine(line);
    for (const pair of pairs) names.add(pair.key.toLowerCase().replace(/\s+/g, ' ').trim());
    if (pairs.length > 0) continue;
    for (const mention of line.matchAll(/(?:^|[^\p{L}\p{N}])((?:\p{Lu}[\p{L}\p{N}]*)(?:\s+\p{Lu}[\p{L}\p{N}]*){0,3})/gu)) {
      const name = (mention[1] ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (name !== '') names.add(name);
    }
  }
  return names;
}

/**
 * The value at the head of prose after `=`: up to a clause mark (`,` `;`
 * `.` `(`), and — read from casing, never a word list — up to the first
 * lower-case Latin word after the first token ("Sick Leave and pick today"
 * → "Sick Leave"; "31 นาที" and a Thai value run to the clause mark).
 */
function valueHeadOf(text: string): string {
  const clause = text.split(/[,;(]|\.\s|\s[—–-]\s/)[0] ?? '';
  const tokens = clause.trim().split(/\s+/);
  const kept: string[] = [];
  for (const [i, token] of tokens.entries()) {
    if (i > 0 && /^\p{Ll}/u.test(token)) break;
    kept.push(token);
  }
  return kept.join(' ').trim();
}

/**
 * The line `journeyTreeSection` writes at the head of each wizard page it
 * carried the form to, and `advancedControlIn` reads back. A field of a later
 * page cannot be entered until the flow has clicked the same control, so the
 * marker is what makes the ORDER computable — the tree alone says only that
 * the control exists.
 */
export const ADVANCED_MARKER = 'WIZARD ADVANCED BEFORE READING — click first:';

/** The selector that carries the wizard forward, from the evidence the capture wrote, or null. */
export function advancedControlIn(evidence: string): string | null {
  for (const line of evidence.split('\n')) {
    const at = line.indexOf(ADVANCED_MARKER);
    if (at === -1) continue;
    const selector = line.slice(at + ADVANCED_MARKER.length).trim();
    if (selector !== '') return selector;
  }
  return null;
}

/**
 * The evidence before the first wizard advance, and everything after it.
 *
 * A two-page capture names a control on either page, and which page it is on
 * decides where its entry step may go. Splitting on the marker is exact: the
 * capture writes it at the head of each page it advanced to.
 */
function evidencePages(evidence: string | undefined): { first: string; later: string } {
  const parts = (evidence ?? '').split(ADVANCED_MARKER);
  return { first: parts[0] ?? '', later: parts.slice(1).join('\n') };
}

/**
 * The tree line naming a field, as `{ role, name }`, or null — every captured
 * tree and the probe report.
 *
 * **A field is matched by its whole name, never by a fragment of it**
 * (2026-09-07). The rule was two-way substring containment returning the
 * FIRST line that touched, and measured against the live hire form it is a
 * machine for typing the sheet's data into the wrong field:
 *
 *     Date of Birth  → textbox "Region of Birth"     (…of Birth)
 *     Job Code       → combobox "Postal code"        (…code)
 *     Account Number → spinbutton "Number of Children" (Number…)
 *     Hire Date      → textbox "Select date"         (the read-only shell)
 *     Event Reason   → button "EN"                   (needle contains "en")
 *
 * Every one of those is a step that runs, goes green, and proves nothing —
 * strictly worse than the slow agent leg it would replace, because a slow leg
 * fails where a reader can see it. So: an EXACT name, or a tree name that
 * BEGINS with the field (`First Name` → `First Name (EN)`, the rendered
 * suffix), and nothing else. `needle.includes(have)` is gone: a field name
 * that happens to contain a short tree name is not evidence of anything.
 *
 * Among candidates an enterable role wins, because it is the enterable
 * control the caller is looking for and a `StaticText` of the same name is
 * the label beside it.
 */
function treeControlNamed(field: string, evidence: string | undefined): { role: string; name: string } | null {
  const needle = squash(field);
  if (needle === '') return null;
  const exact: { role: string; name: string }[] = [];
  const anchored: { role: string; name: string }[] = [];
  for (const raw of (evidence ?? '').split('\n')) {
    const m = /^\s*([a-z]+)\s+"((?:[^"\\]|\\.)*)"/i.exec(raw);
    if (m === null) continue;
    const name = (m[2] ?? '').replace(/\\(.)/g, '$1').trim();
    const have = squash(name);
    if (have === '') continue;
    // A control the tree marks disabled is derived, not keyed — the hire
    // wizard's `textbox "Job Code" disabled` is filled BY the Position pick,
    // and the Expected output says so ("ระบบดึงข้อมูลจาก Position ได้แก่ …
    // Job Code"). Typing into it is a claim about the wrong half.
    if (/(?:^|\s)disabled(?:\s|$)/.test(raw.slice(m.index + m[0].length))) continue;
    const control = { role: (m[1] ?? '').toLowerCase(), name };
    if (have === needle) exact.push(control);
    else if (have.startsWith(needle)) anchored.push(control);
  }
  for (const pool of [exact, anchored]) {
    const enterable = pool.find((one) => entryStepFor(one, 'x', '') !== null);
    if (enterable !== undefined) return enterable;
    const first = pool[0];
    if (first !== undefined) return first;
  }
  return null;
}

/**
 * The control a `Field = value` pair means, hunting past the prose the sheet
 * wrapped the field in.
 *
 * A goal reads `Step 3 ถึง Step 7: กรอกข้อมูล … ตามค่าที่ระบุ ได้แก่ Event Reason
 * = New Hire`, so the pair's key is four words of Thai instruction with the
 * field at the end. Shortening from the tail recovers it — but ONLY on an
 * exact tree name, never on the anchored-prefix rule: a fragment allowed to
 * match a prefix is how `Event Reason` became `button "EN"`. `Account
 * Number` shortened to `Number` finds no line named exactly `Number`, so it
 * stays in the leg, which is the honest answer.
 */
/**
 * Does this set of Expected field names name the field a goal's pair keys?
 *
 * The two sides are written by different hands: the Expected block says
 * `Event Reason`, and the goal wraps the same field in the sheet's own
 * instruction — `ตามค่าที่ระบุ ได้แก่ Event Reason`. So a trailing run of the
 * key counts, not only the whole key: leading words are dropped, because the
 * prose is in front of the field and never behind it.
 *
 * This is a LOOSE gate on purpose, and it is safe only because it decides
 * nothing on its own — a pair it lets through is still dropped unless the
 * tree names its control exactly (`treeControlForPairKey`). Widening the gate
 * without that exactness is how the sheet's data ends up in the wrong field.
 */
function namesField(names: ReadonlySet<string>, key: string): boolean {
  const words = key.toLowerCase().replace(/\s+/g, ' ').trim().split(/\s+/).filter((w) => w !== '');
  for (let take = words.length; take >= 1; take -= 1) {
    if (names.has(words.slice(-take).join(' '))) return true;
  }
  return false;
}

function treeControlForPairKey(
  key: string,
  evidence: string | undefined,
): { role: string; name: string; later: boolean } | null {
  const pages = evidencePages(evidence);
  // The first page wins wherever both name the field: it is reachable
  // without a click, and a wizard repeats a heading far more often than it
  // repeats a control.
  for (const [page, later] of [[pages.first, false], [pages.later, true]] as const) {
    if (page.trim() === '') continue;
    const whole = treeControlNamed(key, page);
    if (whole !== null) return { ...whole, later };
    const words = key.trim().split(/\s+/);
    for (let take = words.length - 1; take >= 1; take -= 1) {
      const needle = squash(words.slice(-take).join(' '));
      if (needle === '') continue;
      for (const raw of page.split('\n')) {
        const m = /^\s*([a-z]+)\s+"((?:[^"\\]|\\.)*)"/i.exec(raw);
        if (m === null) continue;
        const name = (m[2] ?? '').replace(/\\(.)/g, '$1').trim();
        if (squash(name) !== needle) continue;
        const control = { role: (m[1] ?? '').toLowerCase(), name };
        if (entryStepFor(control, 'x', '') !== null) return { ...control, later };
      }
    }
  }
  return null;
}

/** The deterministic step that enters `value` into a control of `role`, by the role the tree shows — or null for a role nothing enters. */
function entryStepFor(control: { role: string; name: string }, value: string, intent: string): FlowStep | null {
  const selector = `role=${control.role}[name=${JSON.stringify(control.name)} i]`;
  switch (control.role) {
    case 'textbox':
    case 'searchbox':
    case 'spinbutton':
      return { action: 'fill', selector, value, intent };
    // A native date/time input the tree names by its own role. It is filled
    // like any other field once the selector stops asking for an ARIA role
    // that does not exist — `withLabelForNonAriaRole` rewrites it to the
    // label engine, and measured on the live form that is 15 ms against the
    // 297,771 ms the `role=date` spelling burned before it gave up.
    case 'date':
    case 'time':
    case 'inputtime':
    case 'datetime':
    case 'datetime-local':
    case 'month':
    case 'week':
    case 'color':
      return { action: 'fill', selector: withLabelForNonAriaRole(selector), value, intent };
    case 'button':
    case 'combobox':
    case 'listbox':
      return { action: 'selectOption', selector, value, intent };
    case 'checkbox':
    case 'switch':
      return { action: 'check', selector, intent };
    case 'radio':
    case 'option':
    case 'tab':
    case 'menuitem':
    case 'menuitemradio':
    case 'menuitemcheckbox':
      return { action: 'click', selector, intent };
    default:
      return null;
  }
}

/** The script step numbers a flow's intents and goals cite (the same carriers `unperformedScriptSteps` reads). */
function citedScriptSteps(steps: readonly FlowStep[]): Set<number> {
  const cited = new Set<number>();
  for (const step of steps) {
    for (const text of [(step as { intent?: unknown }).intent, step.action === 'workflow' ? step.goal : undefined]) {
      if (typeof text !== 'string') continue;
      for (const m of text.matchAll(AUTHORING.script.citation)) if (m[1] === undefined) cited.add(Number(m[2]));
    }
  }
  return cited;
}

/** Where a script step's inserted steps belong: before the first body step citing a LATER script step, else before the first assertion, else the end. */
function insertionAnchorFor(flow: SettleableFlow, scriptStep: number): FlowStep | null {
  const later = flow.steps.find((step) => [...citedScriptSteps([step])].some((n) => n > scriptStep));
  if (later !== undefined) return later;
  return flow.steps.find((step) => /^(expect|save)/.test(step.action)) ?? null;
}

function appendOrInsert(flow: SettleableFlow, anchor: FlowStep | null, step: FlowStep): void {
  if (anchor !== null) {
    insertStepBefore(flow, anchor, step);
    return;
  }
  flow.steps.push(step);
  const last = flow.cases?.[flow.cases.length - 1];
  if (last !== undefined && last.steps !== flow.steps) last.steps.push(step);
}

/**
 * Perform the script steps of a demanded tier that the flow left unperformed
 * (the fallback for `skipsAuthoredScript`, 2026-09-04). For each numbered
 * script line carrying a demand verb of the tier and not cited by any body
 * step: every `Field = value` pair on the line (or the Test data pair whose
 * key the line names) whose field a captured tree names becomes the entry
 * step the tree's role dictates — fill for a textbox, selectOption for a
 * button/combobox, check for a checkbox, click for a radio/option — in
 * script order, cited `Step N:` and marked `[generated: …]`. A line the
 * evidence cannot ground at all becomes a `workflow` leg whose goal is the
 * sheet's own line, marked the same way: the agent performs it, and the
 * flow's own later assertions settle it. Returns the note, or null when the
 * script carries no line of the tier (nothing to perform).
 */
export function settleScriptDemand(
  flow: SettleableFlow,
  caseText: string,
  tier: ScriptDemandTier,
  evidence: string | undefined,
  testData: readonly TestDataPair[] = [],
): string | null {
  const script = withoutRouteLabels(sectionOf(caseText, 'steps') ?? '');
  const verb = tier === 'typing' ? SCRIPT_DEMANDS.typing : tier === 'choosing' ? SCRIPT_DEMANDS.choosing : SCRIPT_DEMANDS.acting;
  const cited = citedScriptSteps(flow.steps);
  const performed: string[] = [];
  const delegated: string[] = [];
  let current = 0;
  for (const raw of script.split('\n')) {
    const numbered = /^\s*(\d{1,2})[.)]\s*(.*)$/.exec(raw);
    if (numbered !== null) current = Number(numbered[1]);
    const text = (numbered?.[2] ?? raw).replace(/^\s*[-•*]\s*/, '').trim();
    if (text === '' || scriptDemand(verb, text) === null || cited.has(current)) continue;
    const label = current > 0 ? `Step ${current}: ${text}` : text;
    const pairs = pairsOnLine(text);
    const fromData = pairs.length > 0 ? pairs : testData.filter((p) => squash(p.key) !== '' && squash(text).includes(squash(p.key))).map((p) => ({ key: p.key, value: p.value }));
    const anchor = insertionAnchorFor(flow, current);
    let grounded = 0;
    for (const pair of fromData) {
      if (unconfirmedValue(pair.value)) continue;
      const control = treeControlForPairKey(pair.key, evidence);
      if (control === null) continue;
      const step = entryStepFor(control, pair.value, markGenerated(label, `performs the script's "${scriptDemand(verb, text)}" on ${control.role} ${JSON.stringify(control.name)} from the tree with the sheet's value ${JSON.stringify(pair.value)}`));
      if (step === null) continue;
      appendOrInsert(flow, anchor, step);
      grounded += 1;
    }
    if (grounded > 0) {
      performed.push(`${current > 0 ? `step ${current}` : text.slice(0, 40)} (${grounded} control(s) from the tree)`);
      continue;
    }
    appendOrInsert(flow, anchor, {
      action: 'workflow',
      goal: label,
      intent: markGenerated(label, 'no captured tree names its control — an agent leg performs the sheet\'s own line; the later assertions settle it'),
    } as FlowStep);
    delegated.push(current > 0 ? `step ${current}` : text.slice(0, 40));
  }
  if (performed.length === 0 && delegated.length === 0) return null;
  return (
    `script ${tier} the flow left unperformed was inserted by the harness (marked [generated: …]): ` +
    [performed.length > 0 ? `${performed.join(', ')} as deterministic steps` : '', delegated.length > 0 ? `${delegated.join(', ')} as agent leg(s) in the sheet's words` : '']
      .filter(Boolean)
      .join('; ')
  );
}

/**
 * Split a workflow goal's `Field = value` pairs into deterministic entry
 * steps where a captured tree names the field (the fallback for
 * `workflowOverDeclaredControls`): each grounded pair becomes the entry step
 * the tree's role dictates, inserted before the leg, and the leg keeps its
 * goal (annotated) — the agent finds the field already set. Nothing
 * grounded, null: the weak note stands.
 */
export function settleWorkflowGoal(flow: SettleableFlow, step: FlowStep, evidence: string | undefined): string | null {
  return settleWorkflowPairs(flow, step, evidence, () => true);
}

function settleWorkflowPairs(
  flow: SettleableFlow,
  step: FlowStep,
  evidence: string | undefined,
  include: (field: string) => boolean,
  laterPage?: string[],
): string | null {
  if (step.action !== 'workflow') return null;
  const done: string[] = [];
  for (const pair of blockItems(step.goal).flatMap((item) => pairsOnLine(item))) {
    if (!include(pair.key)) continue;
    // "เลือกจากรายการ" — choose from the list — is the sheet telling the tester
    // what to do, not the value to enter. Lifting it out of the leg would type
    // the instruction into the control and hunt for an option by that name,
    // which is the very failure `placeholderChoice` exists to name; the
    // required-choice path below answers those with the first offered option.
    if (placeholderChoice(pair.value)) continue;
    const control = treeControlForPairKey(pair.key, evidence);
    if (control === null) continue;
    const entry = entryStepFor(control, pair.value, markGenerated(`${pair.key} = ${pair.value}`, `split out of the workflow goal: ${control.role} ${JSON.stringify(control.name)} is in the tree`));
    if (entry === null) continue;
    if (flow.steps.some((candidate) => JSON.stringify(candidate) === JSON.stringify(entry))) continue;
    insertStepBefore(flow, step, entry);
    if (control.later && 'selector' in entry) laterPage?.push((entry as { selector: string }).selector);
    done.push(`${control.role} ${JSON.stringify(control.name)} = ${JSON.stringify(pair.value)}`);
  }
  if (done.length === 0) return null;
  annotateStep(step, `${done.length} control(s) the tree names were split out before this leg: ${done.join(', ')}`);
  return `workflow goal ${JSON.stringify(step.goal.slice(0, 60))}: ${done.join(', ')} performed deterministically before the leg (marked [generated: …])`;
}

/**
 * The line `journeyTreeSection` writes when the capture expanded the form,
 * and `expandedControlIn` reads back. A tree read expanded is evidence for a
 * page the FLOW has not reached until it clicks the same control — live
 * (HIR-EC-001, 2026-09-07) the expanded capture turned thirteen fields into
 * deterministic steps and every one of them targeted a control still inside
 * a closed section, because nothing had told the flow to open them.
 */
export const EXPANDED_MARKER = 'FORM EXPANDED BEFORE READING — click first:';

/** The selector the capture clicked to expand the form, from the evidence it wrote, or null. */
export function expandedControlIn(evidence: string): string | null {
  for (const line of evidence.split('\n')) {
    const at = line.indexOf(EXPANDED_MARKER);
    if (at === -1) continue;
    const selector = line.slice(at + EXPANDED_MARKER.length).trim();
    if (selector !== '') return selector;
  }
  return null;
}

/**
 * Requiredness belongs to the SECTION, and the attachment control belongs to
 * the section its own label names.
 *
 * The previous rule asked one line to carry both facts — a `required` token
 * (or a `*`) AND an attachment word in its own name — and measured against
 * the live hire form (2026-09-07, 288 nodes with the sections expanded) no
 * line in the whole tree does. Requiredness sits on the section
 * (`heading "Personal Information*"`, `region "Personal Identity*"`); the
 * attachment control is `button "Upload"`, named neither required nor after
 * its field. So the rule could not fire, HIR-EC-001 minted no fixture, and
 * run 12's leg died on *"the page only exposes an Upload control, and no
 * file path or selectable file is available"*.
 *
 * What the tree DOES render is the join between the two:
 *
 *     heading "Personal Information*"          ← the section, required
 *     …
 *     StaticText "Personal Information (Attachment)"   ← the label, naming its section
 *     button "Upload"                          ← the control the label points at
 *
 * so the section is matched by NAME, not by counting lines: the label's
 * parenthetical is the attachment word, its head is the section, and the
 * control is the first interactive node under it. The flat tree
 * (`formatAxNode` emits no indentation — there is no "inside" to read) makes
 * a positional scan the only alternative, and a name join is the stronger of
 * the two wherever the page offers it.
 *
 * The control's name is not unique — this form renders `button "Upload"`
 * three times, one per section — so the position among same-named nodes rides
 * along as `nth` and the selector carries it. Attaching to the first Upload
 * would put the file in National ID's dropzone and call it Personal
 * Information's.
 *
 * The own-line rule is kept as the fallback for a page that marks its
 * controls properly: a tree that renders no `X (Attachment)` label at all is
 * read exactly as before.
 */
export function requiredAttachmentControls(
  evidence: string,
): { role: string; name: string; nth?: number; section?: string; later?: boolean }[] {
  // Each wizard page is its own document at run time: when the browser is on
  // page 2, `role=button[name="Upload" i]` matches page 2's dropzones and
  // nothing else, so an ordinal counted across the whole evidence would
  // address the wrong one. Read page by page, and the ordinal is the one the
  // run will see.
  const pages = (evidence ?? '').split(ADVANCED_MARKER);
  return pages.flatMap((page, at) =>
    attachmentsOnPage(page).map((control) => (at === 0 ? control : { ...control, later: true })),
  );
}

function attachmentsOnPage(evidence: string): { role: string; name: string; nth?: number; section?: string }[] {
  type Node = { role: string; name: string; required: boolean };
  const nodes: Node[] = [];
  for (const raw of evidence.split('\n')) {
    const match = /^\s*([a-z]+)\s+"((?:[^"\\]|\\.)*)"/i.exec(raw);
    if (match === null) continue;
    const name = (match[2] ?? '').replace(/\\(.)/g, '$1').trim();
    // The token the renderer appends, not a word inside the name: a control
    // called "Required documents" is not thereby required.
    const rest = raw.slice(match.index + match[0].length);
    nodes.push({
      role: (match[1] ?? '').toLowerCase(),
      name,
      required: /(?:^|\s)required(?:\s|$)/.test(rest),
    });
  }

  /** The 0-based position among same-role, same-name nodes, or undefined when it is the only one. */
  const positionOf = (at: number): number | undefined => {
    const node = nodes[at];
    if (node === undefined) return undefined;
    const same = nodes.filter((one) => one.role === node.role && one.name === node.name);
    if (same.length < 2) return undefined;
    return nodes.slice(0, at).filter((one) => one.role === node.role && one.name === node.name).length;
  };

  // Every section this tree marks required, by name. Three spellings, all
  // seen live: the asterisk glued to the name, the asterisk as its own node
  // after the name, and the tree's own `required` token.
  const requiredSections = new Set<string>();
  nodes.forEach((node, at) => {
    const next = nodes[at + 1];
    const asterisked = node.name.endsWith('*');
    const followed = node.name !== '' && next?.name === '*';
    if (!asterisked && !followed && !node.required) return;
    const section = node.name.replace(/\*+$/, '').trim().toLowerCase();
    if (section !== '') requiredSections.add(section);
  });

  const controls: { role: string; name: string; nth?: number; section?: string }[] = [];
  const seen = new Set<string>();
  const take = (at: number, section?: string): void => {
    const node = nodes[at];
    if (node === undefined) return;
    const nth = positionOf(at);
    const key = `${node.role}|${node.name}|${nth ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    controls.push({
      role: node.role,
      name: node.name,
      ...(nth === undefined ? {} : { nth }),
      ...(section === undefined ? {} : { section }),
    });
  };

  nodes.forEach((node, at) => {
    // `Personal Information (Attachment)` — the head names the section, the
    // parenthetical is what makes it an attachment label.
    const label = /^(.+?)\s*\(([^()]+)\)\s*$/.exec(node.name);
    if (label === null || !AUTHORING.attachment.test(label[2] ?? '')) return;
    const section = (label[1] ?? '').trim();
    if (!requiredSections.has(section.toLowerCase())) return;
    // The control the label points at: the next interactive node, within
    // reach. A label is followed by its control, never by a paragraph of them.
    for (let ahead = at + 1; ahead <= at + ATTACHMENT_CONTROL_REACH && ahead < nodes.length; ahead += 1) {
      const candidate = nodes[ahead];
      if (candidate === undefined || candidate.name === '') continue;
      if (candidate.role === 'statictext') continue;
      take(ahead, section);
      return;
    }
  });
  if (controls.length > 0) return controls;

  // No page-drawn labels at all: read requiredness off the control's own line,
  // exactly as before.
  nodes.forEach((node, at) => {
    if (!node.required && !node.name.includes('*')) return;
    if (!AUTHORING.attachment.test(node.name)) return;
    take(at);
  });
  return controls;
}

/** How far past its label an attachment control may sit before the label stops meaning it. */
const ATTACHMENT_CONTROL_REACH = 3;

function requiredChoiceControls(evidence: string): { role: string; name: string }[] {
  const controls: { role: string; name: string }[] = [];
  for (const raw of evidence.split('\n')) {
    const match = /^\s*([a-z]+)\s+"((?:[^"\\]|\\.)*)"/i.exec(raw);
    if (match === null) continue;
    const name = (match[2] ?? '').replace(/\\(.)/g, '$1').trim();
    const rest = raw.slice(match.index + match[0].length);
    if (!/(?:^|\s)required(?:\s|$)/.test(rest)) continue;
    const control = { role: (match[1] ?? '').toLowerCase(), name };
    if (entryStepFor(control, ANY_OFFERED, '')?.action === 'selectOption') controls.push(control);
  }
  return controls;
}

/**
 * Is the sheet's "value" for a choice an INSTRUCTION rather than a value?
 *
 * The named phrases (`offeredChoiceWords`) catch the common spellings, but a
 * sheet writes as many as it has fields. Live (HIR-EC-001, 2026-09-07) the
 * Sub-District cell reads `เลือกแขวงที่อยู่ใน District ที่เลือก` — "choose the
 * sub-district inside the District you picked" — and the agent, taking it at
 * face value, hunted for an option by that name among the twelve the control
 * offered and stopped the leg.
 *
 * So the second test is grammatical, not lexical: a cell that OPENS with a
 * choosing verb is telling the tester what to do, and a dropdown option does
 * not begin with "choose". The verbs are the ones the script tier already
 * lists (`script.choosing`), so the vocabulary stays in one place.
 */
function placeholderChoice(value: string): boolean {
  const text = value.trim();
  if (text === '') return false;
  if (AUTHORING.offeredChoice.test(text)) return true;
  return DEFAULT_AUTHORING_RULES.script.choosing.some((verb) => text.toLowerCase().startsWith(verb.toLowerCase()));
}

/**
 * A cell that says "choose from the list" is an instruction to the tester, not
 * a value — so the step it becomes must ask the control for its own first
 * option, never hunt for one named after the instruction.
 *
 * The required-choice path below already inserts `ANY_OFFERED` for a control
 * the flow has no step for, and `settleWorkflowPairs` already refuses to lift
 * one out of a leg. Neither reaches the case that actually happens: the model
 * authored the step ITSELF, carrying the instruction as the value. Live
 * (HIR-EC-001 run `7af7be5d`, 2026-09-08) Pay Group, Bank, Payment Method and
 * Pay Component each opened their list, were told to find an option called
 * "เลือกจากรายการ", and failed with the whole list enumerated in the error —
 * four steps, seven minutes, and a defect against the application for a
 * sentence the sheet had written to the tester.
 *
 * `ANY_OFFERED` is the harness's own answer to exactly this, and the step is
 * flagged `generated` so no report reads the choice as the sheet's.
 */
export function settleOfferedChoices(steps: readonly FlowStep[]): { steps: FlowStep[]; settled: string[] } {
  const settled: string[] = [];
  const next = steps.map((step) => {
    if (step.action !== 'selectOption') return step;
    const value = (step as { value?: unknown }).value;
    if (typeof value !== 'string' || value === ANY_OFFERED || !placeholderChoice(value)) return step;
    const field = fieldLabelOf(step);
    const detail = `the sheet says ${JSON.stringify(value.trim())} — an instruction, not a value; took the first option the control offered`;
    settled.push(`${field}: ${JSON.stringify(value.trim())}`);
    return {
      ...step,
      value: ANY_OFFERED,
      valueSource: { kind: 'generated' as const, detail },
      intent: markGenerated((step as { intent?: string | undefined }).intent, `${detail} for ${JSON.stringify(field)}`),
    } as FlowStep;
  });
  return { steps: next, settled };
}

function pairForControl(controlName: string, pairs: readonly TestDataPair[]): TestDataPair | undefined {
  const control = squash(controlName.replace(/\*/g, ' '));
  return pairs.find((pair) => {
    const field = squash(pair.key);
    return field !== '' && (field === control || control.includes(field) || field.includes(control));
  });
}

function attachmentText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function attachmentControlMentioned(text: string, controlName: string): boolean {
  const haystack = attachmentText(text);
  const withoutRequired = controlName.replace(/\*/g, ' ');
  const fullName = attachmentText(withoutRequired);
  const sectionName = attachmentText(withoutRequired.split('(')[0] ?? '');
  const significant = attachmentText(withoutRequired.replace(AUTHORING.attachment, ' '));
  return [fullName, sectionName, significant].some((name) => name !== '' && haystack.includes(name));
}

export function settleAcceptedFlowInputs(
  flow: SettleableFlow,
  expected: string,
  evidence: string,
  caseId: string,
  testData: readonly TestDataPair[] = [],
): string[] {
  const notes: string[] = [];
  // **The click that opened the form the tree was read from.** Every entry
  // step below was written from an EXPANDED page; on a page nobody expanded,
  // each one targets a control inside a closed section. Live (HIR-EC-001,
  // 2026-09-07): thirteen deterministic fields, and the first of them —
  // `button "Select Salutation"` — could not resolve after five attempts and
  // 145 s, because the section holding it was shut. Inserted before the first
  // step that touches a control, never when the flow already clicks it.
  const expandSelector = expandedControlIn(evidence);
  if (expandSelector !== null) {
    const touches = (step: FlowStep): boolean =>
      'selector' in step && typeof (step as { selector?: unknown }).selector === 'string' && (step as { selector: string }).selector !== '';
    const already = flow.steps.some((step) => step.action === 'click' && (step as { selector?: string }).selector === expandSelector);
    const first = flow.steps.find(touches);
    if (!already && first !== undefined) {
      insertStepBefore(flow, first, {
        action: 'click',
        selector: expandSelector,
        intent: markGenerated(undefined, `the journey tree was read with the form expanded by ${expandSelector}; the flow opens it the same way before the first field`),
      });
      notes.push(`the form is expanded by ${expandSelector} before the first field, because the tree these steps were written from was read that way (marked [generated: …])`);
    }
  }
  const named = expectedNamedFields(expected);
  const laterPage: string[] = [];
  for (const step of [...flow.steps]) {
    const note = settleWorkflowPairs(flow, step, evidence, (field) => namesField(named, field), laterPage);
    if (note !== null) notes.push(note);
  }
  for (const control of requiredAttachmentControls(evidence)) {
    // What a reader — and the Expected output — calls this dropzone is the
    // section it belongs to, never the word on its button: three sections of
    // the live hire form share one `button "Upload"`.
    const called = control.section ?? control.name;
    if (attachmentControlMentioned(expected, called)) continue;
    const workflowSteps = flow.steps.filter((step) => step.action === 'workflow');
    const matchingAnchor = workflowSteps.find(
      (step) => step.action === 'workflow' && attachmentControlMentioned(step.goal, called),
    );
    const anchor = matchingAnchor ?? workflowSteps[workflowSteps.length - 1];
    if (anchor === undefined) continue;
    const usedLateFallback = matchingAnchor === undefined;
    const fixture = `pdf:${caseId}-attachment`;
    if (!isFixtureSpec(fixture)) continue;
    // The position is part of the address whenever the name is shared — the
    // first Upload is another section's, and attaching there would file the
    // document under the wrong field and call the step green.
    const selector =
      `role=${control.role}[name=${JSON.stringify(control.name)} i]` +
      (control.nth === undefined ? '' : ` >> nth=${control.nth}`);
    if (flow.steps.some((step) => step.action === 'upload' && step.selector === selector)) continue;
    insertStepBefore(flow, anchor, {
      action: 'upload',
      selector,
      files: [fixture],
      intent: markGenerated(undefined, `the sheet named no file for ${JSON.stringify(called)}; the harness minted one as ${fixture}`),
    });
    if (control.later === true) laterPage.push(selector);
    notes.push(
      `required attachment ${JSON.stringify(called)} was minted by the harness because the Expected output named no file` +
        (usedLateFallback ? '; inserted before the last workflow leg because no workflow goal named its control or section' : '') +
        ' (marked [generated: …])',
    );
  }
  // **The click that carries the wizard to the page those fields are on.**
  // A step written from page 2's tree resolves nothing on page 1, and the flow
  // reaches page 2 only by clicking the control the capture clicked. Same
  // shape as the expand-all click above, and for the same reason: the tree is
  // evidence for a page the flow has not arrived at yet.
  const advanceSelector = advancedControlIn(evidence ?? '');
  if (advanceSelector !== null && laterPage.length > 0) {
    const already = flow.steps.some(
      (one) => one.action === 'click' && (one as { selector?: string }).selector === advanceSelector,
    );
    const first = flow.steps.find(
      (one) => 'selector' in one && laterPage.includes((one as { selector: string }).selector),
    );
    if (!already && first !== undefined) {
      insertStepBefore(flow, first, {
        action: 'click',
        selector: advanceSelector,
        intent: markGenerated(undefined, `carries the wizard to the page holding ${laterPage.length} field(s) below; the capture read them there`),
      });
      notes.push(
        `the wizard is advanced with ${JSON.stringify(advanceSelector)} before the ${laterPage.length} field(s) ` +
          'the capture read on the page behind it (marked [generated: …])',
      );
    }
  }
  const workflowSteps = flow.steps.filter((step) => step.action === 'workflow');
  const goalPairs = workflowSteps.flatMap((step) => pairsOnLine(step.goal).map((pair) => ({ phase: null, ...pair })));
  // Only a field the Expected output gives a VALUE is out of bounds — see
  // `expectedValuedFields`. A field it merely mentions is a behaviour claim,
  // and the behaviour is what the assertions after this leg check.
  const valued = expectedValuedFields(expected);
  for (const control of requiredChoiceControls(evidence)) {
    const field = squash(control.name.replace(/\*/g, ' '));
    // **The rule the whole change rests on, read the cautious way.** A value
    // the harness chose must never be able to satisfy a field the Expected
    // output asserts, so the match is containment in EITHER direction rather
    // than equality: an Expected line naming "Employee Group" also protects
    // the control the tree calls "Employee Group Code". Erring here costs
    // nothing — the case simply behaves as it did before this rule existed —
    // while erring the other way puts our own value under someone's claim.
    if ([...valued].some((name) => {
      const asked = squash(name);
      return asked !== '' && (asked === field || field.includes(asked) || asked.includes(field));
    })) continue;
    const pair = pairForControl(control.name, [...goalPairs, ...testData]);
    if (pair === undefined || !placeholderChoice(pair.value)) continue;
    const matchingAnchor = workflowSteps.find((step) => squash(step.goal).includes(field));
    const anchor = matchingAnchor ?? workflowSteps[workflowSteps.length - 1];
    if (anchor === undefined) continue;
    const selector = `role=${control.role}[name=${JSON.stringify(control.name)} i]`;
    if (flow.steps.some((step) => step.action === 'selectOption' && step.selector === selector)) continue;
    const detail = `the sheet named no value; took the first option the control offered`;
    insertStepBefore(flow, anchor, {
      action: 'selectOption',
      selector,
      value: ANY_OFFERED,
      valueSource: { kind: 'generated', detail },
      intent: markGenerated(undefined, `${detail} for ${JSON.stringify(control.name)}`),
    });
    notes.push(
      `required choice ${JSON.stringify(control.name)} takes the first option the control offers because the Expected output names no value` +
        (matchingAnchor === undefined ? '; inserted before the last workflow leg because no workflow goal named its control or section' : '') +
        ' (marked [generated: …])',
    );
  }
  return notes;
}

/**
 * A reconciliation claim the flow never actually compares (EN-2 audit — the
 * largest missed-bug cluster). The Expected output says two readings agree
 * ("tile matches the table", "เท่ากับ", "ตรงกับ") or that a reading does not
 * move ("no change", "ไม่เปลี่ยน", "เท่าเดิม"); proving that requires a
 * saved reading (`saveCount`/`saveText` → `{{var}}`) compared on the other
 * side — mere presence assertions pass whether or not the readings agree.
 * Returns the matched claim phrase, or null when the flow carries at least
 * one save whose variable a later expect actually uses.
 */
export function unreconciledMatchClaim(
  steps: readonly FlowStep[],
  prompt: string,
): string | null {
  // The words are data (`value-rules.ts`, `authoring.matchClaim`); the shape
  // — an agree-word within a clause of a reading, or an unchanged-word within
  // a clause of a quantity, either order — is the structure.
  const m = AUTHORING.matchClaim.exec(prompt);
  if (!m) return null;
  const saved = new Set<string>();
  for (const step of steps) {
    if (step.action === 'saveCount' || step.action === 'saveText') saved.add((step as { as: string }).as);
  }
  const compared = steps.some((step) => {
    if (!step.action.startsWith('expect')) return false;
    const text = JSON.stringify(step);
    // `{{rows}}` or the delta form `{{rows+1}}` — both compare the reading.
    return [...saved].some((name) => new RegExp(`\\{\\{\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:[+-]\\s*\\d+)?\\s*\\}\\}`).test(text));
  });
  // A dbSnapshot + expectDbDelta/Unchanged pair is the DB spelling of the
  // same comparison and satisfies the claim too.
  const dbCompared =
    steps.some((s) => s.action === 'dbSnapshot') &&
    steps.some((s) => s.action === 'expectDbDelta' || s.action === 'expectDbUnchanged');
  return compared || dbCompared ? null : m[0].trim().slice(0, 120);
}

/**
 * A `{{name}}` the flow never saves.
 *
 * The flow language resolves `{{name}}` from the runtime variable store, filled
 * by `saveCount`/`saveText` (`as`) and by a `request` step's `save` map. A
 * reference to a name nothing ever saved is broken on every run, and until this
 * lint existed nothing checked it — of 29 refusal rules, none looked at a
 * variable reference.
 *
 * It went unnoticed because the failure was silent twice over. `PLACEHOLDER` in
 * `api/variables.ts` did not accept hyphens, so `{{menu-label}}` matched
 * nothing, `replace` returned the string untouched, and the unknown-name guard
 * — which lives inside the replace callback — never ran. The flow then asserted
 * the literal text `{{menu-label}}` against the page. Both halves are fixed now
 * (the pattern takes hyphens, and `interpolate` throws on a brace pair it could
 * not read), but a run-time throw is still late: the row has been authored,
 * queued and started before anyone learns the name was never saved.
 *
 * The value of catching it HERE is the message. Measured on PL_02, an
 * undefined placeholder was caught only incidentally by the wording lint, whose
 * text blames "a value the test case never states … shown only as a data row" —
 * advice for a different mistake. The model, told nothing about the
 * placeholder, renamed it and resubmitted: PL_02_01 went `{{menu-label}}` →
 * `{{menu-name}}`, PL_02_06 `{{delete-label}}` → `{{delete-word}}`, PL_02_04
 * `{{correction-label}}` → `{{plans-term}}`. Three rows died renaming a
 * placeholder because the refusal never mentioned it.
 *
 * Fatal, not weak: a flow asserting an unsaved variable proves nothing, and
 * unlike the delegation rule it is always fixable from the message alone —
 * either save the reading or assert a literal.
 *
 * Returns the first offender, with the names that ARE available so the re-ask
 * can name them.
 */
export function undefinedVariableRef(
  steps: readonly FlowStep[],
): { index: number; name: string; available: string[] } | null {
  const saved = new Set<string>();
  for (const step of steps) {
    if (step.action === 'saveCount' || step.action === 'saveText') {
      saved.add((step as { as: string }).as);
    }
    const save = (step as { save?: Record<string, string> | undefined }).save;
    if (save) for (const name of Object.keys(save)) saved.add(name);
  }
  for (const [index, step] of steps.entries()) {
    // A save's own `as` names the variable being CREATED, never one read, and
    // travels in the same object — exclude it or every save reports itself.
    const { as: _as, save: _save, ...read } = step as Record<string, unknown>;
    // Laxer than PLACEHOLDER on purpose: a brace pair the resolver cannot read
    // is exactly as broken as a name nothing saved, and is the shape this lint
    // was written for.
    for (const m of JSON.stringify(read).matchAll(/\{\{([^}]*)\}\}/g)) {
      // `{{before+1}}` reads `before` — the arithmetic is the store's (CG-07),
      // and the name is what a save must have written.
      const name = (m[1] ?? '').trim().replace(/\s*[+-]\s*\d+\s*$/, '').trim();
      if (name !== '' && saved.has(name)) continue;
      return { index, name, available: [...saved] };
    }
  }
  return null;
}

export function fixtureFacts(caseText: string): string[] {
  const block = /(?:Test data|TEST DATA|ข้อมูลทดสอบ)\s*:?\s*([\s\S]{0,1200}?)(?=\n\s*(?:Expected|Steps|Note|Menu|Persona|Preconditions)\b|$)/i.exec(caseText)?.[1] ?? '';
  // A case id is never a fixture (2026-09-03, HIR-EC-029): the case's own
  // ids (HIR-EC-029, E2E-29) sit in the text, and "ข้อมูลทดสอบเดียวกับ E2E-01
  // ทุกค่า" — same test data as E2E-01 — is a cross-reference to ANOTHER
  // case, not a value the tester types. Both were returned as facts, and the
  // fixture lint refused a flow for naming them. Ids of the catalog's own
  // shape, and any id that follows a same-as word, are left out; a Plan ID
  // that happens to be the case id (PL_06_21) is still typed as written by
  // the rule at the author's prompt, and still a fact here.
  const referenced = new Set<string>();
  for (const m of caseText.matchAll(
    /(?:เดียวกับ|เหมือน(?:กับ)?|ตาม|อ้างอิง|same as|as in|refer(?:s|ring)? to|per|from case|of case)\s+([A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+)/gi,
  )) {
    if (m[1]) referenced.add(m[1]);
  }
  for (const m of caseText.matchAll(/(?:Test Case ID|Scenario ID|Case|Scenario|เคส)\s*:?\s*([A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+)/gi)) {
    if (m[1]) referenced.add(m[1]);
  }
  // The case's OWN id heads the described row (`HIR-EC-029: …`), and a
  // sibling case shares its skeleton — the id with its digits blanked
  // (`HIR-EC-#`, `E2E-#`). That is the structural reading of "an id of the
  // catalog's own shape" (2026-09-04): it was a literal list of one
  // workbook's prefixes (EC / BE / TM / PY), which named that workbook and no
  // other. The skeleton is learned from the row, so any catalog's convention
  // works, and the ids the row cites as cases (`เคส E2E-29`, `same as
  // E2E-01`) contribute their skeletons too.
  const own = /^\s*([A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+)\s*:/.exec(caseText)?.[1];
  if (own !== undefined) referenced.add(own);
  const skeleton = (id: string): string => id.replace(/\d+/g, '#');
  const caseSkeletons = new Set([...referenced].map(skeleton));
  const openQuestions = openQuestionIdsIn(caseText);
  const ids = new Set<string>();
  for (const m of `${block}\n${caseText}`.matchAll(/\b([A-Z][A-Z0-9]*(?:[_-][A-Za-z0-9]+){1,}|[A-Z]{2,}[-_]\d{2,})\b/g)) {
    if (!m[1] || !/\d/.test(m[1])) continue;
    if (referenced.has(m[1]) || caseSkeletons.has(skeleton(m[1]))) continue;
    // An open-question id (`OQ-HIR-13`, `CF-SIT-19`, or whatever id the row
    // writes after its `= ?`) is the NAME of a question the sheet asks the
    // tester to answer, never a value anyone types or the application holds —
    // `assertsOpenQuestion` owns the shape (HIR-EC-001, 2026-09-04: "ดู
    // CF-SIT-19" in a skip note was refused as a fixture).
    if (OPEN_QUESTION.test(m[1]) || openQuestions.has(m[1])) continue;
    ids.add(m[1]);
  }
  return [...ids];
}

/**
 * A fixture value asserted to PRE-EXIST — as a DB where-clause, a row the
 * flow clicks, an exact count — with nothing earlier in the flow creating it.
 * A fixture may be TYPED (fill, selectOption) freely; it may be asserted
 * only after a step in this flow typed it into a create/insert form, or
 * after a `dbSnapshot`… no: after the flow itself performed the creation
 * (a fill of the value followed by a click). Returns the first offender.
 */
export function ungroundedFixtureAssertion(
  steps: readonly FlowStep[],
  facts: readonly string[],
): { index: number; fact: string; action: string } | null {
  if (facts.length === 0) return null;
  const typedSoFar = new Set<string>();
  // Has the BODY entered anything yet? Afterwards a value read off a form
  // control is the application's answer to what was entered — the sheet's
  // "ค่าที่ระบบดึงจาก Department" (HIR-EC-001: Branch = T153_1733 after
  // selecting the Department) — and the run settles it; only a value looked
  // up before anything was entered is presumed to pre-exist.
  let enteredSoFar = false;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    // The claim, never the note: an intent is written for a reader ("skipped
    // step 4: … ดู CF-SIT-19"), and a name in it asserts nothing.
    const { intent: _intent, ...claim } = step as FlowStep & { intent?: unknown };
    const text = JSON.stringify(claim);
    if (step.action === 'fill' || step.action === 'type' || step.action === 'selectOption') {
      for (const f of facts) if (text.includes(f)) typedSoFar.add(f);
      enteredSoFar = true;
      continue;
    }
    if (step.action === 'workflow') {
      // An agent leg that names the fact as something to type/create counts as creation.
      for (const f of facts) if (text.includes(f) && /\b(create|insert|fill|type|enter|add|save)\b/i.test((step as { goal?: string }).goal ?? '')) typedSoFar.add(f);
      continue;
    }
    const asserts =
      step.action === 'expectDbRow' ||
      step.action === 'expectDbDelta' ||
      step.action === 'expectCount' ||
      step.action === 'expectText' ||
      step.action === 'expectValue' ||
      step.action === 'expectVisible' ||
      step.action === 'click';
    if (!asserts) continue;
    // A field's content after data entry is a derived value, not a lookup:
    // `expectText`/`expectValue` anchored on a control that holds a value.
    // A `text=` presence (a row in a list) and every DB/count/click shape
    // stay judged — those are the be100 shapes this lint was written for.
    const derived =
      enteredSoFar &&
      (step.action === 'expectText' || step.action === 'expectValue') &&
      /^role=(?:textbox|combobox|spinbutton|button|searchbox)\b/i.test(step.selector.trim());
    if (derived) continue;
    for (const f of facts) {
      if (!text.includes(f) || typedSoFar.has(f)) continue;
      // A click on a row scoped by the fact, or a DB check keyed on it.
      const scoped =
        step.action === 'click'
          ? new RegExp(`(has-text|name=|text=)[^>]*${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text)
          : true;
      if (scoped) return { index: i, fact: f, action: step.action };
    }
  }
  return null;
}

export function ungroundedCountRole(
  steps: readonly FlowStep[],
  axTree: string | undefined,
): { index: number; role: string } | null {
  if (!axTree || axTree.includes('TREE TRUNCATED')) return null;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    if (step.action !== 'expectCount') continue;
    const selector = step.selector.trim();
    // Both spellings models actually emit: the role engine (`role=radio`) and
    // the CSS attribute form (`[role="radio"]`) — the same phantom either way.
    const match = /^role=([a-z]+)/i.exec(selector) ?? /^\[role="([a-z]+)"\]$/i.exec(selector);
    if (!match) continue;
    const role = match[1]!.toLowerCase();
    if (!new RegExp(`^${role}\\b`, 'im').test(axTree)) return { index: i, role };
  }
  return null;
}

/**
 * The numbered items of a case's Expected output, from the authoring prompt.
 *
 * The catalog convention is decimal-numbered expectations ("6.1 จำนวนเพิ่มขึ้น
 * +1 ใน Total Plans"); this reads them out of the prompt's own
 * "Expected output:" block so the coverage lint below can ask, mechanically,
 * whether each got an assertion. Prompts without such a block (the `go` path,
 * free-text requests) yield nothing and the lint stays silent.
 */
export function expectedItemsIn(prompt: string): string[] {
  // The parser's own cut (CG-15): every heading `describeCase` writes ends
  // the block, including the ones this used to run into — `Note (from the
  // sheet):`, `Option set for …:`, `Rounds (N):`.
  const block = sectionOf(prompt, 'expected');
  if (block === null) return [];
  const items: string[] = [];
  for (const line of block.split('\n')) {
    // A record-only line is owed an observation, not an assertion (CG-09) —
    // the coverage lint must not demand one, and `assertsRecordOnlyLine`
    // refuses one.
    if (RECORD_ONLY_MARK.test(line)) continue;
    // An id is at the line's HEAD — after optional whitespace and a bullet —
    // never mid-line (2026-09-04, PRB-EC-001 / ML_01_04: "Requested hours :
    // 0.52 hrs" was read as Expected item 0.52 and demanded an assertion).
    // A decimal id (`6.1 +1 in Total Plans`), or a bare `3.` — many sheets
    // number their Expected lines `1.` `2.` `3.`, which a decimal-only read
    // left uncounted.
    const decimal = /^\s*[-•*]?\s*(\d+\.\d+)(?=\s)/.exec(line);
    if (decimal !== null) items.push(decimal[1]!);
    const bare = /^\s*[-•*]?\s*(\d+)\.(?!\d)\s*\S/.exec(line);
    if (bare !== null) items.push(bare[1]!);
  }
  return [...new Set(items)];
}

/** The parser's prefix on an Expected line that is observed, never asserted. */
const RECORD_ONLY_MARK = /\[RECORD ONLY\]/;

/**
 * The `[RECORD ONLY]` Expected lines of a described case: their ids (when
 * numbered) and their text, for the lints that must treat them as
 * observations (CG-09).
 */
export function recordOnlyLines(caseText: string): { no: string | null; text: string }[] {
  const block = sectionOf(caseText, 'expected');
  if (block === null) return [];
  const out: { no: string | null; text: string }[] = [];
  for (const raw of block.split('\n')) {
    if (!RECORD_ONLY_MARK.test(raw)) continue;
    const line = raw.replace(RECORD_ONLY_MARK, '').trim().replace(/^[-•*]\s*/, '');
    const numbered = /^(\d+(?:\.\d+)*)[.)]?\s+(.*)$/.exec(line);
    out.push({ no: numbered?.[1] ?? null, text: (numbered?.[2] ?? line).trim() });
  }
  return out;
}

/**
 * Every Expected line of the case is record-only — the row has no oracle the
 * browser can contradict (CG-09; HIR-EC-060/085/092/094/095 on the sheet).
 * The parser's `expectedLines` decides what is record-only; this only asks
 * whether anything else is left.
 */
export function recordOnlyCase(caseText: string): boolean {
  const block = sectionOf(caseText, 'expected');
  if (block === null || block.trim() === '') return false;
  const lines = expectedLines(block.replace(/\[RECORD ONLY\]\s*/g, ''));
  return lines.length > 0 && lines.every((line) => line.observeOnly);
}

/**
 * A body that asserts nothing beyond a visual baseline: `snapshot` records a
 * region (an observation, CG-09) even though the runner files it among the
 * assertions, so a record-only case authored as snapshots still claims
 * nothing about the sheet's Expected output.
 */
function claimsNothing(steps: readonly FlowStep[]): boolean {
  return !hasAssertion(steps.filter((step) => step.action !== 'snapshot'));
}

/**
 * An assertion whose only cited Expected line is `[RECORD ONLY]` — the sheet
 * asked for the value to be READ ("ยังไม่มีคำตอบ ให้รันจริงแล้วบันทึกค่าที่ระบบ
 * แสดง", "= ? OQ-HIR-91"), and an expect* against a value nobody knows can
 * only fail, as though the application were wrong (CG-09; 179 rows carry
 * such a line). `assertsOpenQuestion` catches the id typed into the
 * assertion; this catches the assertion that cites the line and asserts
 * something else. Returns the step and the line, or null.
 */
export function assertsRecordOnlyLine(
  steps: readonly FlowStep[],
  caseText: string,
): { index: number; line: string } | null {
  const recordIds = new Set(recordOnlyLines(caseText).map((l) => l.no).filter((n): n is string => n !== null));
  if (recordIds.size === 0) return null;
  const assertable = new Set(expectedItemsIn(caseText));
  for (const [index, step] of steps.entries()) {
    if (!step.action.startsWith('expect')) continue;
    const intent = (step as { intent?: unknown }).intent;
    if (typeof intent !== 'string') continue;
    const cited = [...intent.matchAll(/(?:^|[^\d.])(\d+(?:\.\d+)?)(?![\d.])/g)].map((m) => m[1]!);
    const recordCited = cited.filter((id) => recordIds.has(id));
    if (recordCited.length === 0) continue;
    if (cited.some((id) => assertable.has(id))) continue;
    return { index, line: recordCited[0]! };
  }
  return null;
}

/**
 * Numbered Expected lines no assertion claims to cover.
 *
 * The hallucination this catches ran live (be100 PL_03_07): the sheet's
 * expected output was "6.1 +1 in Total Plans; 6.2 +1 in Reimbursement by
 * Employee and HR" and the authored flow proved a DB delta and a visible row
 * name — real checks, but of a different claim; the counter boxes the sheet
 * names were never read, and the intents cited "6.1/6.2" over checks that do
 * not touch them. Mechanical half of the rule the prompt states: every
 * numbered line's id must appear in at least one ASSERTION step's intent —
 * intents on clicks and fills do not count as coverage. What the assertion
 * actually reads is the model's honesty under the prompt rule; which lines
 * have no assertion at all is checkable for $0, and is checked here.
 */
export function unassertedExpectedItems(
  steps: readonly FlowStep[],
  prompt: string,
): string[] {
  const items = expectedItemsIn(prompt);
  if (items.length === 0) return [];
  // An assertion step is always a carrier. A workflow goal carries an item
  // ONLY when a later step asserts something — the authoring rule that an
  // agent leg's claim must be settled by evidence independent of the agent,
  // enforced here (EN-2 audit: behavioral Expected lines "covered" solely by
  // a workflow goal's mention shipped unproved, and their bugs with them).
  const carriers = steps
    .filter((step, i) => {
      if (step.action.startsWith('expect')) return true;
      if (step.action === 'workflow' && step.goal !== '') {
        return steps.some((later, j) => j > i && later.action.startsWith('expect'));
      }
      return false;
    })
    .map((step) => `${(step as { intent?: string }).intent ?? ''} ${(step as { goal?: string }).goal ?? ''}`)
    .join('\n');
  return items.filter((id) => !carriers.includes(id));
}

/**
 * A selector written against a control's DOM implementation instead of its
 * role.
 *
 * The habit this catches: a dropdown whose page the author never saw (it was
 * in no tree) written as `main select:has(option:text-is("Medical"))`, with
 * its default read via `option:checked` — thirty-one steps of one be100 case
 * (PL_04_04, live) pinned to a native `<select>` on a page whose filter is a
 * custom combobox, every one a guaranteed dead-end. No accessibility tree
 * ever shows `<select>`, `<option>` or `:checked` — the tree speaks roles —
 * so an internals selector is by construction invented, grounded or not, and
 * the case's own words ("Default: All" means the state the user sees, not a
 * DOM attribute) cannot rescue it.
 *
 * `role=option[name="…"]` stays legal — that is the tree's own notation for a
 * listbox entry — and quoted strings are stripped first so `text="Select all"`
 * never trips the element check.
 */
export function inventedControlInternals(
  steps: readonly FlowStep[],
): { index: number; selector: string; fragment: string } | null {
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    for (const selector of selectorsOf(step)) {
      if (selector === '') continue;
      const unquoted = selector.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
      if (/:checked\b/.test(unquoted)) return { index: i, selector, fragment: ':checked' };
      const element = /(^|[^\w=-])(select|option)(?=$|[^\w-])/.exec(unquoted);
      if (element !== null) return { index: i, selector, fragment: `<${element[2]}>` };
    }
  }
  return null;
}

/**
 * An `expectUrl` whose expected fragment appears in no evidence the author
 * had: not in any `url="…"` the tree carries, and not in any `goto` of the
 * flow itself.
 *
 * The habit this catches: the model derives a path from a control's LABEL —
 * a card reading "Time & Attendance" asserted `expectUrl "time-attendance"`
 * while the card routes to `/en/overtime` (live), filing a high defect
 * against an app that navigated correctly. The tree's `url=` attribute is
 * where a link actually points; the label is marketing.
 *
 * Deliberately exempt when a `workflow` step precedes the expectation in the
 * same list: the agent's journey ends on pages the authoring tree has never
 * seen, so grounding is impossible in principle there — and the agent
 * verifies its goal against the live page at run time anyway. Declines to
 * judge a truncated tree, same rule as `ungroundedCountRole`.
 */
export function ungroundedUrlExpectation(
  steps: readonly FlowStep[],
  axTree: string | undefined,
  /**
   * Route patterns the indexed repository declares — the THIRD grounding
   * source, beside the tree's `url=` attributes and the flow's own gotos.
   *
   * Without it this lint refuses a path the application demonstrably has.
   * Measured: an `--scope e2e` run was refused for expecting "/en/time" —
   * a route the repo declares as `/:locale/time`, reached by clicking a hub
   * tile rather than by a goto, so neither of the other two sources could see
   * it. Three attempts, three different lints, no flow at all. A false refusal
   * costs the whole authoring call, so a lint that can consult more evidence
   * must consult it. `docs/repo-context-memory-spec.md` R4 asked for exactly
   * this and it was never wired.
   */
  declaredRoutes: readonly string[] = [],
): { index: number; expected: string } | null {
  if (!axTree || axTree.includes('TREE TRUNCATED')) return null;
  const gotoUrls = steps
    .filter((step) => step.action === 'goto')
    .map((step) => (step as { url: string }).url);
  let afterWorkflow = false;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    if (step.action === 'workflow') {
      afterWorkflow = true;
      continue;
    }
    if (step.action !== 'expectUrl' || afterWorkflow) continue;
    const expected = (step as { value: string }).value;
    if (expected === '') continue;
    const grounded =
      axTree.includes(expected) ||
      gotoUrls.some((url) => url.includes(expected)) ||
      // A concrete path against a declared pattern ("/en/time" vs
      // "/:locale/time"), or a bare fragment appearing in one ("overtime").
      declaredRoutes.some(
        (pattern) => matchesRoutePattern(expected, pattern) || pattern.includes(expected),
      );
    if (!grounded) return { index: i, expected };
  }
  return null;
}

/** The sign-in URL this flow itself names, when it names one. */
function findSignInUrl(steps: readonly FlowStep[]): string | null {
  for (const step of steps) {
    if (step.action === 'goto' && LOGIN_URL_PATTERN.test(step.url)) return step.url;
  }
  return null;
}

/**
 * Repair stranded credential fills deterministically: splice the flow's own
 * sign-in `goto` back in front of each stranded login block.
 *
 * The refusal in `strandedCredentialFill` tells a human "add a goto to the
 * sign-in page before the fill" — and when the flow already names that page
 * (its first sign-in did), the system knows the exact fix it is asking a
 * human to type. Applying it is the same move `qualifyBareRole` makes for
 * selectors: a mechanical, unambiguous rewrite at narrowing time, disclosed
 * on the result rather than silent, and strictly better than either refusing
 * the case or running three fills against a page with no login form on it.
 *
 * The `goto` lands before the whole credential *block* — the contiguous run
 * of fills the stranded one belongs to — because a login block starts with
 * the email field, not the password field the detector flags. With no
 * sign-in URL to learn from, nothing is touched and the refusal stands: an
 * invented URL would be a guess, and this repo does not guess.
 */
/** The accessible name a click-shaped selector asks for, when readable. */
function clickTargetName(selector: string): string | null {
  const m = /\[name=(?:"([^"]+)"|'([^']+)')/.exec(selector) ?? /^text="([^"]+)"$/.exec(selector.trim());
  return (m?.[1] ?? m?.[2] ?? null) as string | null;
}

/** Is this step an accept of the consent gate — bare click, or the authored `when { visible }` form? */
function isConsentAccept(step: FlowStep): boolean {
  if (step.action === 'click') {
    const name = clickTargetName(step.selector);
    return name !== null && CONSENT_ACCEPT_NAME.test(name);
  }
  if (step.action === 'when' && step.visible !== undefined) {
    const first = step.then[0];
    if (first === undefined || first.action !== 'click') return false;
    const name = clickTargetName(first.selector);
    return name !== null && CONSENT_ACCEPT_NAME.test(name);
  }
  return false;
}

function isConsentDecline(step: FlowStep): boolean {
  if (step.action !== 'click') return false;
  const name = clickTargetName(step.selector);
  return name !== null && /^(decline|reject|do not accept|ไม่ยอมรับ|ปฏิเสธ)$/i.test(name);
}

export function consentPolicyForCase(
  caseText: string,
  steps: readonly FlowStep[],
): ConsentPolicy | undefined {
  if (steps.some(isConsentAccept)) return undefined;
  if (steps.some(isConsentDecline)) return 'preserve';
  return /\bCONSENT_REQUIRED\b/i.test(caseText) ? 'preserve' : undefined;
}

/**
 * F3 of docs/consent-gate-recovery-spec.md: a consent-accept step the model
 * placed AFTER the first post-login navigation or assertion is spliced to
 * immediately after the login block. PL_02_09's shape, live: the breadcrumb
 * assertion ran against the gate and failed, the accept then landed the run
 * on the app's home page with no re-navigation, and everything after
 * dead-ended. Moved early, the accept fires where the gate actually shows
 * (right after sign-in) and the flow's own `goto` — which now runs AFTER it —
 * is the re-navigation. A bare `click` is converted to the `when { visible }`
 * form on the way, because the gate shows once per context and a bare click
 * fails every run after the first. Mechanical, disclosed, never a re-ask —
 * the `groundCredentialFills` move.
 */
export function settleConsentEarly(steps: readonly FlowStep[]): { steps: FlowStep[]; moved: boolean } {
  // The login block: the last credential fill, then the first click after it.
  let lastCredential = -1;
  for (const [index, step] of steps.entries()) {
    if (isCredentialFill(step)) lastCredential = index;
  }
  if (lastCredential === -1) return { steps: [...steps], moved: false };
  let submit = -1;
  for (let i = lastCredential + 1; i < steps.length; i += 1) {
    if (steps[i]!.action === 'click') {
      submit = i;
      break;
    }
  }
  if (submit === -1) return { steps: [...steps], moved: false };

  // The anchor: right after the submit and its login proof (the contiguous
  // expectHidden/expectUrl steps the prompt asks for).
  let anchor = submit + 1;
  while (
    anchor < steps.length &&
    (steps[anchor]!.action === 'expectHidden' || steps[anchor]!.action === 'expectUrl')
  ) {
    anchor += 1;
  }

  const acceptAt = steps.findIndex((step, index) => index >= anchor && isConsentAccept(step));
  if (acceptAt === -1 || acceptAt === anchor) return { steps: [...steps], moved: false };
  // Only a misplacement is repaired: something between the anchor and the
  // accept must be a navigation or an assertion that would otherwise run
  // against the gate.
  const between = steps.slice(anchor, acceptAt);
  if (!between.some((step) => step.action === 'goto' || step.action.startsWith('expect'))) {
    return { steps: [...steps], moved: false };
  }

  const accept = steps[acceptAt]!;
  const conditional: FlowStep =
    accept.action === 'click'
      ? {
          action: 'when',
          visible: accept.selector,
          then: [accept],
          ...(accept.intent === undefined ? {} : { intent: accept.intent }),
        }
      : accept;
  const out = [...steps];
  out.splice(acceptAt, 1);
  out.splice(anchor, 0, conditional);
  return { steps: out, moved: true };
}

export function groundCredentialFills(
  prefix: readonly FlowStep[],
  steps: readonly FlowStep[],
  signInUrl: string,
): { steps: FlowStep[]; grounded: number } {
  let lastGoto: string | null = null;
  for (const step of prefix) {
    if (step.action === 'goto') lastGoto = step.url;
  }

  const out: FlowStep[] = [];
  let grounded = 0;
  for (const step of steps) {
    if (step.action === 'goto') {
      lastGoto = step.url;
      out.push(step);
      continue;
    }
    if (isCredentialFill(step) && lastGoto !== null && !LOGIN_URL_PATTERN.test(lastGoto)) {
      let insertAt = out.length;
      // Walk back over the contiguous run of field entries (`fill` or `type`)
      // so the goto lands before the whole credential block, not mid-form.
      while (
        insertAt > 0 &&
        (out[insertAt - 1]!.action === 'fill' || out[insertAt - 1]!.action === 'type')
      ) {
        insertAt -= 1;
      }
      // `goto` carries no intent field; the insertion is disclosed on the
      // authored result's notes instead.
      out.splice(insertAt, 0, { action: 'goto', url: signInUrl });
      lastGoto = signInUrl;
      grounded += 1;
    }
    out.push(step);
  }
  return { steps: out, grounded };
}

/**
 * Force the supplied account's password onto the fills that sign in AS that
 * account.
 *
 * Measured on be100 (2026-08-23, 107 flows): 88 typed the `--as` password
 * exactly; 19 invented one (`Password123!`, `AdminPass123!`, `password`, …) —
 * and every one of those spent its whole run against the sign-in page, failed
 * the login proof, and filed defects about an application that was fine. The
 * prompt states the precedence ("use these characters exactly"); this is the
 * guarantee — the `groundCredentialFills` move: a string replacement should
 * never cost an authoring call, let alone a whole red run.
 *
 * Narrow on purpose, two gates both required:
 * - the segment (fills since the last `goto`) types the supplied email, so a
 *   three-persona catalog keeps its other personas untouched; and
 * - the segment's tail carries an `expectHidden` login proof — the flow MEANS
 *   this sign-in to succeed. A negative test that deliberately types a wrong
 *   password asserts an error message instead, and is left exactly as written.
 *
 * Steps are mutated in place (the `applyReview` precedent) so a case list
 * holding the same objects sees the correction without a second pass.
 */
export function groundCredentialValues(
  steps: readonly FlowStep[],
  credentials: { email: string; password: string },
): number {
  let corrected = 0;
  let segmentStart = 0;
  const segments: [number, number][] = [];
  for (const [index, step] of steps.entries()) {
    if (step.action === 'goto') {
      segments.push([segmentStart, index]);
      segmentStart = index + 1;
    }
  }
  segments.push([segmentStart, steps.length]);

  for (const [from, to] of segments) {
    const segment = steps.slice(from, to);
    const typesEmail = segment.some(
      (s) =>
        (s.action === 'fill' || s.action === 'type') &&
        s.value.trim().toLowerCase() === credentials.email.toLowerCase(),
    );
    if (!typesEmail) continue;
    const meansToSucceed = segment.some((s) => s.action === 'expectHidden');
    if (!meansToSucceed) continue;
    for (const step of segment) {
      if (step.action !== 'fill' && step.action !== 'type') continue;
      if (!isCredentialFill(step)) continue;
      if (step.value === credentials.password) continue;
      // The email field can itself read as a credential fill (an intent
      // mentioning "password credentials"); never overwrite the identity.
      if (step.value.trim().toLowerCase() === credentials.email.toLowerCase()) continue;
      (step as { value: string }).value = credentials.password;
      corrected += 1;
    }
  }
  return corrected;
}

/**
 * The distinct identities this flow signs in as, in order of first use.
 *
 * Segmented by `goto`: the fills between two navigations belong to one form,
 * so a two-step sign-in (identity → Next → password) stays one segment even
 * though a click sits between its fills. A segment is a credential segment
 * when its navigation looked like a sign-in page (`LOGIN_URL_PATTERN`) or any
 * of its fills is credential-shaped (`isCredentialFill`); its identity is the
 * first email-shaped value it types, else its first typed value. More than
 * one distinct identity means the flow SWITCHES PERSONA — an end-to-end fact
 * about the flow whatever scope the request asked for, and the trigger for
 * `groundPersonaSwitches`.
 */
export function switchesPersona(
  setup: readonly FlowStep[],
  steps: readonly FlowStep[],
): string[] {
  const identities: string[] = [];
  let lastGoto: string | null = null;
  let fills: { value: string; credential: boolean }[] = [];
  const flush = (): void => {
    if (fills.length === 0) return;
    const onSignIn = lastGoto !== null && LOGIN_URL_PATTERN.test(lastGoto);
    if (onSignIn || fills.some((f) => f.credential)) {
      const identity = (fills.find((f) => f.value.includes('@')) ?? fills[0])!.value.toLowerCase();
      if (identities[identities.length - 1] !== identity) identities.push(identity);
    }
    fills = [];
  };
  for (const step of [...setup, ...steps]) {
    if (step.action === 'goto') {
      flush();
      lastGoto = step.url;
      continue;
    }
    // A `signIn` by label IS an identity (CG-05): a flow that signs in as
    // MANAGER_ACCOUNT and then HRBP_ACCOUNT switches persona exactly as one
    // that typed two emails, and is marked e2e for the same reason.
    if (step.action === 'signIn') {
      flush();
      const identity = step.as.trim().toLowerCase();
      if (identity !== '' && identities[identities.length - 1] !== identity) identities.push(identity);
      continue;
    }
    if ((step.action === 'fill' || step.action === 'type') && step.value.trim() !== '') {
      fills.push({ value: step.value.trim(), credential: isCredentialFill(step) });
    }
  }
  flush();
  return [...new Set(identities)];
}

/**
 * Put the application's own sign-out in front of every persona switch.
 *
 * The prompt asks for it; this is the guarantee, the `groundCredentialFills`
 * move: a credential segment whose identity differs from the one before it,
 * with no `signOut` between them, gets `{ action: 'signOut' }` spliced in
 * before the `goto` that opens its sign-in — so the switch travels the
 * application's own sign-out path (the thing an end-to-end test is for)
 * instead of filling a login form the app hides from signed-in users, or
 * faking the switch with a storage wipe a cookie-backed session survives.
 * Runs after `groundCredentialFills`, so a stranded block has its `goto` by
 * the time this looks for one. Disclosed on notes, never silent.
 */
export function groundPersonaSwitches(
  prefix: readonly FlowStep[],
  steps: readonly FlowStep[],
): { steps: FlowStep[]; inserted: number } {
  const prefixIdentities = switchesPersona(prefix, []);
  let previousIdentity: string | null = prefixIdentities[prefixIdentities.length - 1] ?? null;
  let lastGoto: string | null = null;
  // `pendingSignOut`: a signOut stands between the previous credential
  // segment's fills and the upcoming one — the switch is already grounded.
  let pendingSignOut = false;
  for (const step of prefix) {
    if (step.action === 'goto') lastGoto = step.url;
    if (step.action === 'signOut') pendingSignOut = true;
    if ((step.action === 'fill' || step.action === 'type') && isCredentialFill(step)) {
      pendingSignOut = false;
    }
  }

  const out: FlowStep[] = [];
  let inserted = 0;
  let segmentStart = 0;
  let segmentGotoAt: number | null = null;
  let fills: { value: string; credential: boolean }[] = [];
  // A signOut arriving AFTER the current segment's fills belongs to the NEXT
  // switch, not this one — the flush below must not consume it.
  let signOutAfterFills = false;
  const flush = (): void => {
    if (fills.length > 0) {
      const onSignIn = lastGoto !== null && LOGIN_URL_PATTERN.test(lastGoto);
      if (onSignIn || fills.some((f) => f.credential)) {
        const identity = (fills.find((f) => f.value.includes('@')) ?? fills[0])!.value.toLowerCase();
        if (previousIdentity !== null && identity !== previousIdentity && !pendingSignOut) {
          out.splice(segmentGotoAt ?? segmentStart, 0, {
            action: 'signOut',
            intent: "end the previous persona's session through the application before signing in as the next",
          });
          inserted += 1;
        }
        previousIdentity = identity;
        pendingSignOut = signOutAfterFills;
      } else {
        pendingSignOut = pendingSignOut || signOutAfterFills;
      }
      fills = [];
    }
    signOutAfterFills = false;
  };
  for (const step of steps) {
    if (step.action === 'goto') {
      flush();
      lastGoto = step.url;
      out.push(step);
      segmentGotoAt = out.length - 1;
      segmentStart = out.length;
      continue;
    }
    if (step.action === 'signOut') {
      if (fills.length > 0) signOutAfterFills = true;
      else pendingSignOut = true;
    }
    if ((step.action === 'fill' || step.action === 'type') && step.value.trim() !== '') {
      fills.push({ value: step.value.trim(), credential: isCredentialFill(step) });
    }
    out.push(step);
  }
  flush();
  return { steps: out, inserted };
}

/**
 * An authored flow, as one runnable flow per discrete case.
 *
 * `setup` and `teardown` are shared rather than divided up: setup is what a case
 * needs in order to start from a known place, so it runs again before each one —
 * which is exactly what stops case 4 inheriting the wreckage of case 3. That
 * repetition is the price of a case that can fail without ending the run, and it
 * is the right price: the alternative is not knowing about cases 4 to 6 at all.
 *
 * A single case keeps the flow's own name, because renaming it would start a new
 * line in the run history and lose everything that flow had proved before.
 */
export function caseFlows(authored: AuthoredFlow): { name: string; flow: Flow }[] {
  return authored.cases.map((one) => ({
    name: one.name,
    flow: {
      ...authored.flow,
      name: authored.cases.length === 1 ? authored.flow.name : `${authored.flow.name} — ${one.name}`,
      steps: one.steps,
    },
  }));
}

/**
 * The origin plus the deployment's base path — the segments in front of the
 * locale (`https://h/humi/th/login` → `https://h/humi`). The origin alone
 * was wrong for a base-pathed app (humi, 2026-09-05): every authored request
 * step resolved `/api/consent-api/status` against it, hit the gateway's
 * HTML 404 instead of the application's `/humi/api/...`, and six cases
 * failed on a path the page itself calls successfully. A URL with no locale
 * segment keeps the origin, as before.
 */
export function baseUrlOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter((p) => p !== '');
    const LOCALE = /^[a-z]{2}(-[A-Za-z]{2})?$/;
    const localeAt = parts.findIndex((part) => LOCALE.test(part));
    const base = localeAt > 0 ? `/${parts.slice(0, localeAt).join('/')}` : '';
    return `${parsed.origin}${base}`;
  } catch {
    return undefined;
  }
}

// --- wave 2 (2026-09-03): the sheet's own shapes, authored honestly ---------

/**
 * Every selector a step carries — the one `selector`, or an either/or step's
 * `selectors` (CG-08). The grounding lints read this so an alternative is
 * judged exactly as a single selector would be.
 */
export function selectorsOf(step: FlowStep): string[] {
  const one = (step as { selector?: unknown }).selector;
  const many = (step as { selectors?: unknown }).selectors;
  const out: string[] = [];
  if (typeof one === 'string') out.push(one);
  if (Array.isArray(many)) for (const s of many) if (typeof s === 'string') out.push(s);
  return out;
}

/**
 * The Test data pairs as `describeCase` rendered them — one `[phase] Key =
 * value` per line under `Test data:` (CG-02). The parser already unpacked
 * `Position = 40106337 Job Code = MKB12.12` and applied every
 * `ดราฟต์เดิมระบุ` correction; this reads the result back, never re-splits,
 * and is the resolver's source when the caller has no row to hand.
 */
export function testDataPairsOfCaseText(caseText: string): TestDataPair[] {
  const block = sectionOf(caseText, 'test data');
  if (block === null) return [];
  const pairs: TestDataPair[] = [];
  for (const raw of block.split('\n')) {
    // A correction line is kept verbatim as prose by the parser; its `=` is
    // not a pair.
    if (/ดราฟต์เดิมระบุ/u.test(raw)) continue;
    const m = /^\s*(?:\[([^\]]+)\]\s*)?([^=\n]+?)\s=\s(.+?)\s*$/.exec(raw);
    if (m === null) continue;
    pairs.push({ phase: m[1]?.trim() ?? null, key: m[2]!.trim(), value: m[3]!.trim() });
  }
  return pairs;
}

/**
 * An Expected block that offers alternatives — "ระบบประมวลผลสำเร็จหรือแสดง
 * error ตามเงื่อนไข ไม่ crash" (TC_PY_* negatives, 44 rows), "กรณีสร้างสำเร็จ
 * … / กรณีปฏิเสธ …" (HIR-EC), "A หรือ B", "success or an error". The only
 * shape `expectAnyVisible` is for.
 */
const ALTERNATIVE_CLAIM = /หรือ|\bor\b|\beither\b|กรณี[^\n]{0,120}กรณี/iu;

/**
 * An `expectAnyVisible` in a flow whose case names ONE outcome (CG-08). The
 * step exists for either/or lines; used elsewhere it is a hedge — "the page
 * shows the success message OR anything at all" — and a hedge passes on the
 * defect. Returns the step's index, or null.
 */
export function hedgedAlternatives(steps: readonly FlowStep[], caseText: string): number | null {
  const block = sectionOf(caseText, 'expected') ?? caseText;
  if (ALTERNATIVE_CLAIM.test(block)) return null;
  const at = steps.findIndex((step) => step.action === 'expectAnyVisible');
  return at === -1 ? null : at;
}

/**
 * A delta claim: a number the case says moves by a stated amount —
 * "จำนวนเพิ่มขึ้น +1 ใน Total Plans" (PL_03_*), "จำนวนรายการค้างลดลง 1 รายการ"
 * (PRB-EC), "Pending 1D → 2D" (TM quota). The count word and the movement
 * word within one clause, either order; a bare `-N` glued to a digit or a
 * word (a date, a range "1-15") is not a delta.
 */
const DELTA_CLAIM =
  /(?:จำนวน|รายการ|count|total|number|balance|pending|used|remaining|quota|plans?|rows?|items?|records?)[^.\n]{0,60}(?:เพิ่มขึ้น|ลดลง|\+\s?\d+|(?<![\w\-/])[-−]\s?\d+(?!\s?[\d/-])|increases?|decreases?|goes (?:up|down))|(?:เพิ่มขึ้น|ลดลง|\+\s?\d+|increases?|decreases?)[^.\n]{0,60}(?:จำนวน|รายการ|count|total|number|balance|pending|used|remaining|plans?|rows?|items?|records?)/iu;

/**
 * A delta claim the flow never measures (CG-07). "+1 in Total Plans" is
 * proved by reading the box before, acting, and comparing `{{before+1}}`
 * after; a presence check of the box, or the sheet's illustrative "76",
 * passes whether or not it moved — PL_03_07 shipped exactly that green.
 * Satisfied by a saved reading a later expect compares (delta form or plain),
 * or by the DB spelling (`dbSnapshot` + `expectDbDelta`). Returns the claim
 * phrase, or null.
 */
export function unmeasuredDeltaClaim(steps: readonly FlowStep[], caseText: string): string | null {
  const block = sectionOf(caseText, 'expected');
  if (block === null) return null;
  const m = DELTA_CLAIM.exec(block.replace(/\[RECORD ONLY\][^\n]*/g, ''));
  if (m === null) return null;
  const saved = new Set<string>();
  for (const step of steps) {
    if (step.action === 'saveCount' || step.action === 'saveText') saved.add(step.as);
  }
  const compared = steps.some((step) => {
    if (!step.action.startsWith('expect')) return false;
    const text = JSON.stringify(step);
    return [...saved].some((name) =>
      new RegExp(`\\{\\{\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:[+-]\\s*\\d+)?\\s*\\}\\}`).test(text),
    );
  });
  const dbCompared = steps.some((s) => s.action === 'dbSnapshot') && steps.some((s) => s.action === 'expectDbDelta');
  return compared || dbCompared ? null : m[0].trim().slice(0, 120);
}

/**
 * "ระบบแสดง Error message "…" ด้านล่าง Field X" (PL_06_*, RU_05_*), "error
 * ใต้ช่องนั้นทันทีเมื่อกด Save" (TC_SSO_*, TC_TAX_*), "ระบบแสดงข้อความที่ช่อง
 * Personal Grade" (HIR-EC-049): the message belongs to a FIELD.
 */
const FIELD_ERROR_CLAIM =
  /(?:error|ข้อความ(?:เตือน)?|message|validation)[^\n]{0,80}(?:ด้านล่าง(?:สุด)?(?:ของ)?\s*(?:field|ช่อง)|ใต้\s*(?:ช่อง|field)|under(?:neath)?\s+(?:the\s+)?field|below\s+(?:the\s+)?field|ที่ช่อง|แต่ละ\s*field\s*แสดงแยกกัน|per\s+field)/iu;

/**
 * A field-scoped error claim proved page-wide (EH-12): the case says the
 * message sits under a named field and the flow has no `expectFieldError` —
 * an `expectText` of the message passes when it sits under the WRONG field,
 * which is what those cases exist to catch. Returns the claim line, or null.
 */
export function fieldErrorAssertedPageWide(steps: readonly FlowStep[], caseText: string): string | null {
  const block = sectionOf(caseText, 'expected');
  if (block === null) return null;
  const m = FIELD_ERROR_CLAIM.exec(block);
  if (m === null) return null;
  if (steps.some((step) => step.action === 'expectFieldError')) return null;
  return m[0].trim().slice(0, 120);
}

/**
 * A claim that is settled only after the application has WORKED for a
 * while: "สถานะเปลี่ยนเป็น Complete" after Run Payroll (TC_PY_REC_*), import
 * progress "100%" / "Status = Completed" (PL_10_24), a toast that "หายไป
 * อัตโนมัติ 5-6 วินาที" (RU_05_02), "ระบบ direct ไปหน้า My Request" (ML_01_*).
 */
const WAIT_UNTIL_CLAIM =
  /สถานะเปลี่ยนเป็น|เปลี่ยนสถานะเป็น|status\s+(?:changes|becomes|turns)\s+to|status\s*=\s*(?:completed|complete|success|done|finished)|100\s?%|ประมวลผลสำเร็จ|(?:ป็อปอัพ|popup|pop-up|toast|warning)[^\n]{0,30}(?:ปิดลง|หายไป)|หายไป(?:อัตโนมัติ|เอง)|auto-?dismiss|disappears?\s+(?:automatically|after|by itself)|direct\s*ไปหน้า|redirect(?:s|ed)?\s+to/iu;

/**
 * A wait-until claim with no declared wait (EH-07): every check runs at the
 * fast ladder's few seconds, so a payroll run of minutes can never be awaited
 * and the step dead-ends with an unrelated heal. The author declares the
 * wait on the check (`timeoutMs`); this is the guarantee. Returns the claim
 * phrase when no waitable step carries one, else null.
 */
export function unbudgetedStatusWait(steps: readonly FlowStep[], caseText: string): string | null {
  const block = sectionOf(caseText, 'expected') ?? '';
  const m = WAIT_UNTIL_CLAIM.exec(block);
  if (m === null) return null;
  const declared = steps.some((step) => typeof (step as { timeoutMs?: unknown }).timeoutMs === 'number');
  return declared ? null : m[0].trim().slice(0, 100);
}

type PersonaMap = Readonly<Record<string, { email: string; password: string }>>;

/** The label whose email a typed value is, case-insensitively, or null. */
function personaOfEmail(value: string, personas: PersonaMap): string | null {
  const wanted = value.trim().toLowerCase();
  if (wanted === '' || !wanted.includes('@')) return null;
  for (const [label, account] of Object.entries(personas)) {
    if (account.email.trim().toLowerCase() === wanted) return label;
  }
  return null;
}

/** Steps that belong to a typed sign-in block, from its first fill to its proof. */
const LOGIN_BLOCK_STEPS: ReadonlySet<string> = new Set(['fill', 'type', 'click', 'press', 'expectHidden', 'expectUrl', 'waitFor', 'when']);

/**
 * Replace every sign-in the model typed for a KNOWN persona with one
 * `signIn` by label (CG-05, EH-10) — the `groundCredentialFills` move: the
 * fix is unambiguous (the email names the label), so the system applies it,
 * disclosed, rather than paying a re-ask to be told what a lookup knows.
 *
 * A block is the run from a sign-in `goto` (or the first fill of a
 * segment) through the contiguous fills, the Next/Sign in clicks and the
 * login proof (`expectHidden`/`expectUrl`), inside one `goto`-delimited
 * segment; a consent `when` inside it is kept after the signIn, because the
 * gate may still show. The password fill is dropped with the block — the
 * engine types the secret it holds. A block whose email matches no persona
 * is left alone for `handTypedPersonaSignIn` to refuse.
 */
export function groundPersonaSignIns(
  steps: readonly FlowStep[],
  personas: PersonaMap,
): { steps: FlowStep[]; replaced: number } {
  if (Object.keys(personas).length === 0) return { steps: [...steps], replaced: 0 };
  const out: FlowStep[] = [];
  let replaced = 0;
  let i = 0;
  while (i < steps.length) {
    const step = steps[i]!;
    // The block starts at a sign-in goto, or at a fill (the page was the login screen).
    const startsBlock =
      (step.action === 'goto' && LOGIN_URL_PATTERN.test(step.url)) || step.action === 'fill' || step.action === 'type';
    if (!startsBlock) {
      out.push(step);
      i += 1;
      continue;
    }
    let end = step.action === 'goto' ? i + 1 : i;
    while (end < steps.length && LOGIN_BLOCK_STEPS.has(steps[end]!.action)) end += 1;
    const block = steps.slice(i, end);
    const emailFill = block.find(
      (s) => (s.action === 'fill' || s.action === 'type') && personaOfEmail(s.value, personas) !== null,
    );
    const label = emailFill === undefined ? null : personaOfEmail((emailFill as { value: string }).value, personas);
    // The block must be a sign-in that MEANS TO SUCCEED: a persona's email
    // typed, a credential fill or a sign-in goto around it, and the canonical
    // login proof (`expectHidden` of the submit) at its tail — the
    // `groundCredentialValues` gate. A business form that happens to take the
    // manager's email is not a login, and a negative sign-in case (a wrong
    // password, an error asserted) is left exactly as written.
    const isSignIn =
      label !== null &&
      (step.action === 'goto' || block.some((s) => (s.action === 'fill' || s.action === 'type') && isCredentialFill(s))) &&
      block.some((s) => s.action === 'expectHidden');
    if (!isSignIn) {
      out.push(step);
      i += 1;
      continue;
    }
    const url = step.action === 'goto' ? step.url : undefined;
    out.push({
      action: 'signIn',
      as: label,
      ...(url === undefined ? {} : { url }),
      intent: `sign in as ${label} — the harness holds the credentials (was a typed sign-in block of ${block.length} step(s))`,
    });
    // A consent accept inside the block still belongs right after the sign-in.
    for (const kept of block) if (kept.action === 'when' && isConsentAccept(kept)) out.push(kept);
    replaced += 1;
    i = end;
  }
  return { steps: out, replaced };
}

/**
 * A sign-in still typed by hand while the run holds personas (CG-05): a
 * credential fill (`isCredentialFill`), or a fill on a sign-in page, that
 * `groundPersonaSignIns` could not map to a label — the model invented an
 * account, or typed a persona's email with a password of its own. Returns
 * the step's index and the value, or null.
 */
export function handTypedPersonaSignIn(
  steps: readonly FlowStep[],
  personas: PersonaMap,
): { index: number; value: string } | null {
  if (Object.keys(personas).length === 0) return null;
  // Segments between gotos, the `switchesPersona` cut: a segment that types
  // a credential AND carries the login proof means to sign in; one that
  // asserts an error instead is a negative sign-in case and is the author's.
  let from = 0;
  const segments: [number, number][] = [];
  for (const [index, step] of steps.entries()) {
    if (step.action === 'goto') {
      segments.push([from, index]);
      from = index + 1;
    }
  }
  segments.push([from, steps.length]);
  let lastGoto: string | null = null;
  for (const [start, end] of segments) {
    const before = start === 0 ? null : steps[start - 1];
    if (before !== undefined && before !== null && before.action === 'goto') lastGoto = before.url;
    const onSignIn = lastGoto !== null && LOGIN_URL_PATTERN.test(lastGoto);
    const segment = steps.slice(start, end);
    if (!segment.some((s) => s.action === 'expectHidden')) continue;
    for (const [offset, step] of segment.entries()) {
      if (step.action !== 'fill' && step.action !== 'type') continue;
      if (onSignIn || isCredentialFill(step)) return { index: start + offset, value: step.value };
    }
  }
  return null;
}

/**
 * A `signIn` naming a label the run does not hold (CG-05) — `<EMPLOYEE_2>`
 * invented for CNS-EC-028's second employee, a role word the CLI never
 * mapped. The run would fail at the step with "persona X has no
 * credentials"; refusing here names the labels that exist. A literal email
 * equal to a held persona's is accepted (the engine resolves it). Returns
 * the step, its label and the labels available, or null.
 */
export function signInAsUnknownPersona(
  steps: readonly FlowStep[],
  personas: PersonaMap,
): { index: number; as: string; available: string[] } | null {
  const labels = Object.keys(personas);
  if (labels.length === 0) return null;
  const known = new Set(labels.map((l) => l.toLowerCase()));
  const emails = new Set(labels.map((l) => personas[l]!.email.toLowerCase()));
  for (const [index, step] of steps.entries()) {
    if (step.action !== 'signIn') continue;
    const as = step.as.trim().toLowerCase();
    if (known.has(as) || emails.has(as)) continue;
    return { index, as: step.as, available: labels };
  }
  return null;
}

/**
 * A workflow goal that names two people (OA-15, author half): "submit as the
 * employee, then the manager approves". One session cannot be both, so the
 * agent either stalls on the sign-in page or is refused a finish; the
 * authored form is two legs with a `signIn` between them. The reading is the
 * agent guard's own (`multiPersonaGoal`), so the author refuses exactly what
 * the agent would. Returns the step and the personas named, or null.
 */
export function multiPersonaWorkflow(
  steps: readonly FlowStep[],
): { index: number; personas: string[] } | null {
  for (const [index, step] of steps.entries()) {
    if (step.action !== 'workflow') continue;
    const personas = multiPersonaGoal(step.goal);
    if (personas !== null) return { index, personas };
  }
  return null;
}

/**
 * The sheet's route to the page, ignored (CG-11). A row with `Destination:
 * <url> (tab "X")` (every PY row) must goto that URL; a row with `Menu path:
 * A > B > C` (1,218 rows) must click a crumb, goto a page, or hand the leg
 * to a workflow that names one — a flow that reaches the page some other
 * way, or never reaches it, tests a page the sheet did not name. Returns
 * what the sheet asked for, or null when the flow honours it or the sheet
 * gives no route.
 */
export function ignoresMenuPath(
  steps: readonly FlowStep[],
  caseText: string,
): { kind: 'destination' | 'menu'; wanted: string } | null {
  const destination = /^\s*Destination:\s*(https?:\/\/\S+)/im.exec(caseText)?.[1];
  const text = JSON.stringify(steps).toLowerCase();
  if (destination !== undefined) {
    let path: string;
    try {
      path = new URL(destination).pathname.replace(/\/+$/, '');
    } catch {
      path = destination;
    }
    const reached = steps.some(
      (step) =>
        (step.action === 'goto' && (step.url.includes(path) || destination.includes(step.url))) ||
        (step.action === 'workflow' && step.goal.toLowerCase().includes(path.toLowerCase())) ||
        // **A Destination that IS the sign-in page is reached by signing in.**
        // Live (HIR-EC-001, runs 13–15): the sheet's Destination is the login
        // URL, the flow's setup goes there and signs in, and the remedy told
        // the model to `goto` the login page AFTER the sign-in — back to the
        // form it had just left. A `signIn` is a navigation to the sign-in
        // page and through it.
        (step.action === 'signIn' && LOGIN_URL_PATTERN.test(destination)),
    );
    return reached ? null : { kind: 'destination', wanted: destination };
  }
  const menu = /^\s*Menu path:\s*(.+)$/im.exec(caseText)?.[1];
  if (menu === undefined) return null;
  const crumbs = menu
    .split(/\s*>\s*/)
    .map((c) => c.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase())
    .filter((c) => c.length >= 2);
  if (crumbs.length === 0) return null;
  const named = crumbs.some((crumb) => text.includes(crumb.replace(/"/g, '\\"')));
  if (named) return null;
  // A flow that navigates by URL or hands the journey to the agent has a
  // route of its own; only a flow that does neither has ignored the sheet's.
  const travels = steps.some((step) => step.action === 'goto' || step.action === 'workflow');
  return travels ? null : { kind: 'menu', wanted: menu.trim() };
}

/**
 * An option set's forbidden names the flow never asserts absent (CG-14):
 * "ไม่มี RE_REHIRE_GE1 และไม่มี RE_REHIRE_LT1" (HIR-EC-027) is a claim about
 * two names NOT being offered, and only an `expectHidden` of each can fail
 * when one appears. Returns the first unasserted name, or null.
 */
export function unassertedForbiddenOption(
  steps: readonly FlowStep[],
  caseText: string,
): { field: string; name: string } | null {
  const block = sectionOf(caseText, 'expected');
  if (block === null) return null;
  const hidden = steps
    .filter((step) => step.action === 'expectHidden')
    .map((step) => JSON.stringify(step).toLowerCase());
  for (const set of optionSetsIn(block.replace(/\[RECORD ONLY\]\s*/g, ''))) {
    for (const name of set.forbidden) {
      if (hidden.some((line) => line.includes(name.toLowerCase()))) continue;
      return { field: set.field, name };
    }
  }
  return null;
}
