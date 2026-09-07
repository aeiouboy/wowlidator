/**
 * Contract tests for prompt-driven flow authoring.
 *
 * All offline: `FlowAuthorModel` is one method, so the interesting behaviour —
 * refusing an assertion-free flow, narrowing the flat schema, reporting what was
 * dropped — is testable without a key or a browser.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { zodSchema } from 'ai';

import {
  AUTHOR_ATTEMPTS,
  AuthoredFlowSchema,
  AuthoringError,
  FlowAuthor,
  LlmFlowAuthorModel,
  caseFlows,
  groundCredentialFills,
  groundCredentialValues,
  strandedCredentialFill,
  MAX_REPORTED_VIOLATIONS,
  composeRefusal,
  type Violation,
  countPinnedName,
  volatileCountAssertion,
  duplicateCredentialSubmit,
  notEndToEnd,
  loginProofCannotFail,
  unsettledWorkflowClaim,
  interruptedCredentialSubmit,
  declaredControlStrings,
  expectedItemsIn,
  unassertedExpectedItems,
  unreconciledMatchClaim,
  inventedControlInternals,
  workflowOverDeclaredControls,
  ungroundedCountRole,
  ungroundedTextExpectation,
  ungroundedSelectorRole,
  fixtureFacts,
  ungroundedFixtureAssertion,
  unpinnedDateEntry,
  ungroundedUrlExpectation,
  unsynchronizedLoginSubmit,
  dbClaimWithoutDbCheck,
  BACKEND_OFF_REASON,
  buildUserPrompt,
  refusalShape,
  SUITE_REFUSAL_MEMORY,
  loginProofAssertsLoginPage,
  ungroundedGoto,
  foreignAuthoredHost,
  foreignHostRefusal,
  unindexedRequestMethod,
  assertsOpenQuestion,
  skipsAuthoredScript,
  describeScriptDemand,
  unperformedScriptSteps,
  unboundedExclusivityClaim,
  wordingClaimAssertsDataValue,
  settleViolations,
  settleExclusivity,
  settleSelectorRole,
  settleScriptDemand,
  settleWorkflowGoal,
  expectedNamedFields,
  requiredAttachmentControls,
  settleAcceptedFlowInputs,
  scriptDemand,
  GENERATED_STEP_MARKER,
  type AuthorRequest,
  type AuthorResult,
  type FlowAuthorModel,
  groundLoginProof,
  fromTreeNotation,
  typedCredentialValues,
  credentialEchoAssertions,
  switchesPersona,
  groundPersonaSwitches,
  baseUrlOf,
  EXPANDED_MARKER,
  expandedControlIn,
  expectedValuedFields,
  advancedControlIn,
  ADVANCED_MARKER,
  JOURNEY_TREE_MAX_LINES,
  journeyTreeMaxLines,
  STRUCTURAL_EVIDENCE_LINE,
  fillsReadOnlyNode,
  ignoresMenuPath,
} from '../src/generator/flow-author.js';
import { isFixtureSpec } from '../src/data/fixtures.js';
import { focusTreeText } from '../src/context/retriever.js';
import { compileAuthoringRules, openQuestionIdsIn, withOverride, DEFAULT_VALUE_RULES } from '../src/generator/value-rules.js';
import { exclusivityClaimIn, unprovedExclusivity } from '../src/generator/exclusivity.js';
import {
  controlNamedIn,
  fillRouteIds,
  journeyCaptureNote,
  journeyTreeSection,
  literalDestinations,
  shouldSignInForCapture,
} from '../src/cli/commands/authoring.js';
import { vacuousFlow } from '../src/generator/vacuous.js';
import type { FlowStep } from '../src/engine/runner.js';
import { ANY_OFFERED } from '../src/engine/listbox.js';
import { jsonModel } from './helpers.js';

/** A stub that returns whatever the test hands it, and records the request. */
function stubModel(result: Partial<AuthorResult>): FlowAuthorModel & { seen?: AuthorRequest } {
  const model: FlowAuthorModel & { seen?: AuthorRequest } = {
    id: 'stub:author',
    async author(request) {
      model.seen = request;
      return {
        name: 'stub flow',
        rationale: 'because',
        setup: [],
        steps: [],
        teardown: [],
        notes: '',
        droppedSteps: 0,
        ...result,
      };
    },
  };
  return model;
}

describe('FlowAuthor', () => {
  it('preserves consent when the catalog oracle requires the consent blocker', async () => {
    // Given: a catalog case whose machine-readable oracle is CONSENT_REQUIRED.
    const author = new FlowAuthor({
      model: stubModel({
        name: 'CNS-EC-029',
        setup: [{ action: 'signIn', as: 'EMPLOYEE_ACCOUNT', url: '/login' }],
        steps: [
          { action: 'request', method: 'GET', url: '/consent/status' },
          { action: 'expectJson', path: '$.data.status', value: 'CONSENT_REQUIRED' },
        ],
      }),
    });

    // When: the catalog row is authored into a runnable flow.
    const authored = await author.author('CNS-EC-029', undefined, {
      caseText: 'Expected: CONSENT_REQUIRED',
    });

    // Then: runtime gate handling is explicit rather than inferred from step prose.
    assert.equal(authored.flow.consentPolicy, 'preserve');
  });

  it('preserves consent when the authored script rejects the consent document', async () => {
    // Given: the script needs the consent gate so it can exercise rejection itself.
    const author = new FlowAuthor({
      model: stubModel({
        name: 'CNS-EC-002',
        setup: [{ action: 'signIn', as: 'EMPLOYEE_ACCOUNT', url: '/login' }],
        steps: [
          { action: 'click', selector: 'role=button[name="ปฏิเสธ" i]' },
          { action: 'expectModal', name: 'ยืนยันการปฏิเสธ' },
        ],
      }),
    });

    // When: the row is authored without a CONSENT_REQUIRED oracle.
    const authored = await author.author('CNS-EC-002', undefined, {
      caseText: 'Steps: กดปุ่มปฏิเสธ Expected: ระบบแสดงกล่องยืนยัน',
    });

    // Then: automatic gate acceptance is disabled for the run.
    assert.equal(authored.flow.consentPolicy, 'preserve');
  });

  it('builds a flow from a prompt', async () => {
    const author = new FlowAuthor({
      model: stubModel({
        name: 'pagination is disabled on a single page',
        setup: [{ action: 'goto', url: '/rules' }],
        steps: [
          { action: 'expectDisabled', selector: 'role=button[name="Next"]', intent: 'next button' },
        ],
        teardown: [{ action: 'clearStorage' }],
      }),
    });

    const authored = await author.author('check pagination is disabled with one page');

    assert.equal(authored.flow.name, 'pagination is disabled on a single page');
    assert.equal(authored.flow.setup?.length, 1);
    assert.equal(authored.flow.steps.length, 1);
    assert.equal(authored.flow.teardown?.length, 1);
    assert.equal(authored.grounded, false, 'no page was supplied');
  });

  it('forwards a saved repository’s prompt section to the model', async () => {
    // The `--repo` path: cmdCatalog/cmdAuthor hand the repo's route-centred
    // section in as `projectContext`, and it must reach the model as its own
    // request field — buildUserPrompt labels it apart from the tree there.
    const model = stubModel({
      steps: [
        { action: 'expectVisible', selector: 'role=heading[name="Plans"]', intent: 'the page shows' },
      ],
    });
    const author = new FlowAuthor({
      model,
      projectContext: 'route /admin/benefits/plans renders PlansPage',
    });
    await author.author('check the plans page lists the catalog');
    assert.equal(model.seen?.projectContext, 'route /admin/benefits/plans renders PlansPage');
  });

  it('omits empty setup and teardown rather than emitting empty arrays', async () => {
    const author = new FlowAuthor({
      model: stubModel({
        steps: [{ action: 'expectVisible', selector: 'role=table', intent: 'the table' }],
      }),
    });

    const authored = await author.author('check the table renders');

    assert.equal(authored.flow.setup, undefined);
    assert.equal(authored.flow.teardown, undefined);
  });

  it('refuses a flow with no assertion instead of returning a test that proves nothing', async () => {
    const author = new FlowAuthor({
      model: stubModel({
        name: 'click around',
        steps: [
          { action: 'goto', url: '/' },
          { action: 'click', selector: 'role=button[name="Next"]' },
        ],
      }),
    });

    await assert.rejects(
      () => author.author('click the next button'),
      (error: unknown) =>
        error instanceof AuthoringError && /no assertion/.test((error as Error).message),
    );
  });

  it('refuses when no usable steps survived', async () => {
    const author = new FlowAuthor({ model: stubModel({ steps: [] }) });

    await assert.rejects(
      () => author.author('do something vague'),
      (error: unknown) =>
        error instanceof AuthoringError && /no usable steps/.test((error as Error).message),
    );
  });

  it('rejects an empty prompt without spending a call', async () => {
    const model = stubModel({});
    const author = new FlowAuthor({ model });

    await assert.rejects(() => author.author('   '), AuthoringError);
    assert.equal(model.seen, undefined, 'the model must not be called');
  });

  it('passes the policy through to the model', async () => {
    const model = stubModel({
      steps: [{ action: 'expectVisible', selector: 'role=alert', intent: 'validation error' }],
    });
    const author = new FlowAuthor({ model, policy: 'read-only' });

    await author.author('check the table renders');

    assert.equal(model.seen?.policy, 'read-only');
  });

  it('defaults to the mutations policy — the suite acts like a human tester out of the box', async () => {
    const model = stubModel({
      steps: [{ action: 'expectVisible', selector: 'role=alert', intent: 'validation error' }],
    });

    await new FlowAuthor({ model }).author('submit the form empty and check validation');

    assert.equal(model.seen?.policy, 'mutations');
  });

  it('repairs a stranded persona switch mechanically instead of refusing the case', async () => {
    // The PB-02-01 authoring failure: the model switches identity mid-flow
    // without navigating back to the sign-in page it itself used at step 0.
    // The system knows the exact fix the refusal would ask a human to type,
    // so it applies it — disclosed on notes — and no model call is repaid.
    const model = stubModel({
      name: 'persona switch',
      steps: [
        { action: 'goto', url: '/en/login' },
        { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'manager@x' },
        { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw' },
        { action: 'click', selector: 'role=button[name="Sign in" i]' },
        { action: 'goto', url: '/en/workflows/probation' },
        { action: 'expectCount', selector: 'role=radio', count: 4, intent: 'four outcome cards' },
        { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'hradmin@x' },
        { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw' },
        { action: 'click', selector: 'role=button[name="Sign in" i]' },
        { action: 'expectVisible', selector: 'text=Probation Exemption', intent: 'exemption surface' },
      ],
    });
    let calls = 0;
    const inner = model.author.bind(model);
    model.author = async (request) => {
      calls += 1;
      return inner(request);
    };
    const author = new FlowAuthor({ model });

    const authored = await author.author('verify outcome cards and the exemption surface');

    assert.equal(calls, 1, 'a mechanical omission must not cost a second model call');
    // Two mechanical repairs compose: the goto to the sign-in page the flow
    // itself named, and — because the identities differ — a signOut in front
    // of it, so the switch travels the application's own sign-out path.
    assert.equal(authored.flow.steps[6]?.action, 'signOut');
    assert.deepEqual(authored.flow.steps[7], { action: 'goto', url: '/en/login' });
    assert.match(authored.notes, /inserted 1 goto/);
    assert.match(authored.notes, /signOut step\(s\) before persona switches/);
    assert.equal(strandedCredentialFill(authored.flow.steps), null);
  });

  it('re-asks once with the refusal as feedback before giving up', async () => {
    // No sign-in URL anywhere in the flow, so the mechanical repair cannot
    // apply — the next cheapest move is one informed re-ask, the healer's
    // own "the value is entirely in the second ask" rule.
    const bad: Partial<AuthorResult> = {
      steps: [
        { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw', intent: 'the password field' },
        { action: 'expectVisible', selector: 'text=Dashboard', intent: 'landed' },
      ],
    };
    const good: Partial<AuthorResult> = {
      steps: [
        { action: 'goto', url: '/en/login' },
        { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw', intent: 'the password field' },
        { action: 'expectVisible', selector: 'text=Dashboard', intent: 'landed' },
      ],
    };
    const requests: AuthorRequest[] = [];
    const model: FlowAuthorModel = {
      id: 'stub:author',
      async author(request) {
        requests.push(request);
        const result = requests.length === 1 ? bad : good;
        return {
          name: 'retry flow', rationale: '', setup: [{ action: 'goto', url: '/en/home' }],
          steps: [], teardown: [], notes: '', droppedSteps: 0, ...result,
        };
      },
    };

    const authored = await new FlowAuthor({ model }).author('sign in and check the dashboard');

    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.feedback, undefined, 'the first ask carries no feedback');
    assert.match(requests[1]?.feedback?.[0] ?? '', /credential field without first navigating/);
    assert.equal(authored.flow.steps.length, 3);
  });

  it(`refuses for real after ${AUTHOR_ATTEMPTS} attempts that ignore the feedback`, async () => {
    let calls = 0;
    const model: FlowAuthorModel = {
      id: 'stub:author',
      async author() {
        calls += 1;
        return {
          name: 'stubborn', rationale: '', setup: [{ action: 'goto', url: '/en/home' }],
          steps: [
            { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw', intent: 'the password field' },
            { action: 'expectVisible', selector: 'text=x', intent: 'x' },
          ],
          teardown: [], notes: '', droppedSteps: 0,
        };
      },
    };

    await assert.rejects(
      () => new FlowAuthor({ model }).author('sign in somehow'),
      (error: unknown) => error instanceof AuthoringError && /credential field/.test((error as Error).message),
    );
    // Since 2026-09-04 a fatal refusal repeated identically is not re-asked:
    // the second answer proved the feedback changes nothing.
    assert.equal(calls, 2, 'the same refusal twice ends the budget early, and the refusal is loud');
  });

  it('stops after two identical fatal refusals and says so, without counting the repeat as suite memory (HIR-EC-001, 2026-09-04)', async () => {
    // multirole.csv HIR-EC-001: three opus calls (~$0.95, 264 s each) were
    // spent on two lints no flow could satisfy. A model answering the same
    // flow every time, through the real narrowing.
    const payload = {
      name: 'HIR-EC-001 New Hire Key-in success',
      rationale: '',
      setup: [{ action: 'goto', case: null, selector: '', value: '', url: '/en/home', key: '', name: '', timeoutMs: '', intent: '' }],
      steps: [
        { action: 'fill', case: null, selector: 'role=textbox >> nth=1', value: 'pw', url: '', key: '', name: '', timeoutMs: '', intent: 'the password field' },
        { action: 'expectVisible', case: null, selector: 'text=x', value: '', url: '', key: '', name: '', timeoutMs: '', intent: 'x' },
      ],
      teardown: [],
      notes: '',
    };
    const mock = jsonModel('mock-author', payload, { inputTokens: 10, outputTokens: 10 });
    const inner = new LlmFlowAuthorModel({ model: mock, id: 'mock:author' });
    const seen: AuthorRequest[] = [];
    const model: FlowAuthorModel = {
      id: inner.id,
      author: (request) => {
        seen.push(request);
        return inner.author(request);
      },
    };
    const log: string[] = [];
    const author = new FlowAuthor({ model, onLog: (line) => log.push(line) });
    await assert.rejects(
      () => author.author('sign in somehow'),
      (error: unknown) =>
        error instanceof AuthoringError &&
        error.severity === 'fatal' &&
        /^refused identically on 2 attempts — a rule the model cannot satisfy or a lint that misreads the case; review the lint/.test(error.message) &&
        /credential field/.test(error.message),
    );
    assert.equal(mock.doGenerateCalls.length, 2, 'the third call is never made');
    assert.match(seen[1]?.feedback?.[0] ?? '', /credential field/, 'the second ask did carry the feedback');
    assert.ok(log.some((line) => /refused identically on 2 attempts/.test(line)));
    // The repeat is not a second sighting: the shape travels to other rows
    // only once a DIFFERENT answer broke the same rule.
    await assert.rejects(() => author.author('another row of the same suite'));
    assert.equal(seen[2]?.commonRefusals, undefined, 'seen once, not twice — the next row starts clean');
  });
});

describe('baseUrlOf keeps the deployment path in front of the locale', () => {
  it('origin plus base path, or the origin alone', () => {
    assert.equal(baseUrlOf('https://h.example/app/th/login'), 'https://h.example/app');
    assert.equal(baseUrlOf('https://h.example/a/b/en-GB/login'), 'https://h.example/a/b');
    assert.equal(baseUrlOf('https://h.example/th/login'), 'https://h.example', 'a locale first means no base path');
    assert.equal(baseUrlOf('https://h.example/login'), 'https://h.example', 'no locale: nothing to anchor a base path on');
    assert.equal(baseUrlOf('https://h.example/'), 'https://h.example');
    assert.equal(baseUrlOf(undefined), undefined);
    assert.equal(baseUrlOf('not a url'), undefined);
  });
});

describe('strandedCredentialFill', () => {
  const signIn: FlowStep[] = [
    { action: 'goto', url: '/en/login' },
    { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'a@b.c' },
    { action: 'fill', selector: 'role=textbox >> nth=1', value: 'hunter2', intent: 'the password field' },
    { action: 'click', selector: 'role=button[name="Sign in" i]' },
  ];

  it('accepts a login block grounded on a sign-in page, and a flow that starts on one', () => {
    assert.equal(strandedCredentialFill(signIn), null);
    // No goto at all: the page the author was given may BE the login screen.
    assert.equal(strandedCredentialFill(signIn.slice(1)), null);
  });

  it('refuses the PB-02-01 shape: credentials filled after navigating somewhere else', () => {
    const steps: FlowStep[] = [
      ...signIn,
      { action: 'goto', url: '/en/workflows/probation/PB-001' },
      { action: 'expectVisible', selector: 'text=Outcome', value: '' } as FlowStep,
      // The persona switch with no navigation — every fill below runs
      // against a page with no login form on it.
      { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'hr@b.c' },
      { action: 'fill', selector: 'role=textbox >> nth=1', value: 'hunter2' },
    ];
    assert.equal(strandedCredentialFill(steps), 7);
  });

  it('does not mistake an ordinary form field for a credential', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: '/en/profile' },
      { action: 'fill', selector: 'role=textbox[name="Display name" i]', value: 'Alice' },
      { action: 'fill', selector: '#bio', value: 'hello' },
    ];
    assert.equal(strandedCredentialFill(steps), null);
  });
});

describe('ungroundedCountRole', () => {
  const TREE = [
    'radiogroup',
    'button "Pass probation (normal)"',
    'button "Extend"',
    'heading "ผลการประเมิน"',
  ].join('\n');

  it('flags a count of a role the tree never lists, in both selector spellings', () => {
    // PB-02-01: the model saw a radiogroup and inferred radio children; the
    // app renders aria-pressed buttons, so the count resolves zero forever.
    const roleForm: FlowStep[] = [{ action: 'expectCount', selector: 'role=radio', count: 4 }];
    const cssForm: FlowStep[] = [{ action: 'expectCount', selector: '[role="radio"]', count: 4 }];
    assert.deepEqual(ungroundedCountRole(roleForm, TREE), { index: 0, role: 'radio' });
    assert.deepEqual(ungroundedCountRole(cssForm, TREE), { index: 0, role: 'radio' });
  });

  it('accepts a count of a role the tree actually lists', () => {
    const steps: FlowStep[] = [{ action: 'expectCount', selector: 'role=button', count: 2 }];
    assert.equal(ungroundedCountRole(steps, TREE), null);
  });

  it('declines to judge a truncated tree — absence of evidence is not evidence of absence', () => {
    const steps: FlowStep[] = [{ action: 'expectCount', selector: 'role=radio', count: 4 }];
    const truncated = `${TREE}\n[TREE TRUNCATED: showing 4 of 90 nodes...]`;
    assert.equal(ungroundedCountRole(steps, truncated), null);
    assert.equal(ungroundedCountRole(steps, undefined), null, 'ungrounded authoring has no tree to check');
  });

  it('ignores counts that are not role-shaped', () => {
    const steps: FlowStep[] = [{ action: 'expectCount', selector: '.card', count: 3 }];
    assert.equal(ungroundedCountRole(steps, TREE), null);
  });
});

describe('code-grounded authoring — the repository as evidence', () => {
  const CODE = [
    'Project context for /:locale/admin/benefits/plans (src/app/[locale]/admin/benefits/plans/page.tsx):',
    '  renders BenefitPlansScreen (src/…/BenefitPlansScreen.tsx) — says: "breadcrumb" · "Clear filters"',
    '  BenefitPlansScreen renders the admin_benefits_plans strings [en, messages/en.json]: title: "Benefit Plan Catalog" · createPlan: "Create Plan" · makeCorrection: "Make Correction" · rows: "5"',
  ].join('\n');

  it('declaredControlStrings collects the quoted spans and drops bare numbers', () => {
    const strings = declaredControlStrings(CODE);
    assert.ok(strings.includes('Create Plan'), strings.join('|'));
    assert.ok(strings.includes('Make Correction'));
    assert.ok(strings.includes('breadcrumb'));
    assert.ok(!strings.includes('5'), 'a bare number is not a label');
    assert.deepEqual(declaredControlStrings(undefined), []);
  });

  it('ungroundedTextExpectation accepts text the code declares, tree or not', () => {
    const TREE = 'main\n  heading "Something else"';
    const steps: FlowStep[] = [
      { action: 'expectText', selector: 'text="Benefit Plan Catalog"', value: 'Benefit Plan Catalog' },
    ];
    assert.notEqual(ungroundedTextExpectation(steps, TREE), null, 'refused without code evidence');
    assert.equal(ungroundedTextExpectation(steps, TREE, CODE), null, 'the code declares the string');
  });

  it('workflowOverDeclaredControls flags a goal naming a declared control', () => {
    // PL_07: 108 model calls hunting a journey whose control the code names.
    const steps: FlowStep[] = [
      { action: 'goto', url: '/en/admin/benefits/plans' },
      {
        action: 'workflow',
        goal: "locate the row for plan X and click Make Correction, then end on the correction dialog",
      },
    ];
    const hit = workflowOverDeclaredControls(steps, CODE);
    assert.equal(hit?.index, 1);
    assert.ok(hit?.declared.includes('Make Correction'), hit?.declared.join('|'));
  });

  it('leaves a goal about genuinely undeclared territory alone', () => {
    const steps: FlowStep[] = [
      { action: 'workflow', goal: 'export the quarterly reconciliation and end on /exports' },
    ];
    assert.equal(workflowOverDeclaredControls(steps, CODE), null);
    assert.equal(workflowOverDeclaredControls(steps, undefined), null, 'no code, no opinion');
  });

  it('matches whole words only — "plan" inside "planning" is not the control', () => {
    const code = 'renders the x strings [en, m.json]: a: "Plan"';
    const steps: FlowStep[] = [{ action: 'workflow', goal: 'open the planning workspace' }];
    assert.equal(workflowOverDeclaredControls(steps, code), null);
  });
});

describe('expected-output coverage', () => {
  const PROMPT = [
    'PL_03_07: Create Plan count check',
    'Steps:',
    '  1. open the menu',
    'Expected output:',
    '  6.1 +1 in Total Plans',
    '  6.2 +1 in Reimbursement by Employee and HR',
    'Note (from the sheet):',
    '  Before: Total plans: 75',
  ].join('\n');

  it('reads the numbered items out of the Expected block only', () => {
    assert.deepEqual(expectedItemsIn(PROMPT), ['6.1', '6.2']);
    assert.deepEqual(expectedItemsIn('free-text request, no block'), []);
  });

  it('flags lines no assertion cites — PL_03_07: DB checks are not the counter boxes', () => {
    const steps: FlowStep[] = [
      { action: 'click', selector: 'role=button[name="Create Plan" i]', intent: '6.1/6.2 — press it' },
      { action: 'expectVisible', selector: 'text="row"', intent: '6.1 — the counter moved' },
    ];
    // the click's intent citing 6.2 is not coverage; only assertions carry it
    assert.deepEqual(unassertedExpectedItems(steps, PROMPT), ['6.2']);
  });

  it('a workflow goal carries an item only when a later step asserts something', () => {
    const settled: FlowStep[] = [
      { action: 'workflow', goal: '6.2 — read the Reimbursement box and verify it moved' },
      { action: 'expectText', selector: 'text="Total plans"', value: '76', intent: '6.1 — the box' },
    ];
    assert.deepEqual(unassertedExpectedItems(settled, PROMPT), []);
    // EN-2 audit: an Expected line "covered" solely by a goal's mention shipped
    // unproved — the agent's claim must be settled by independent evidence.
    const unsettled: FlowStep[] = [
      { action: 'expectText', selector: 'text="Total plans"', value: '76', intent: '6.1 — the box' },
      { action: 'workflow', goal: '6.2 — read the Reimbursement box and verify it moved' },
    ];
    assert.deepEqual(unassertedExpectedItems(unsettled, PROMPT), ['6.2']);
  });

  describe('unreconciledMatchClaim', () => {
    const MATCH_PROMPT = 'Expected output: the Total Plans tile matches the table row count exactly.';
    const NO_CHANGE_PROMPT = 'Expected output: จำนวน Total Plans ไม่เปลี่ยนแปลง after pressing Cancel.';
    const presenceOnly: FlowStep[] = [
      { action: 'expectVisible', selector: 'text="Total plans"', intent: 'the tile is there' },
      { action: 'expectVisible', selector: 'role=table', intent: 'the table is there' },
    ];

    it('refuses a match claim proved only by presence — EN-2: ten such bugs shipped green', () => {
      const hit = unreconciledMatchClaim(presenceOnly, MATCH_PROMPT);
      assert.ok(hit !== null && /matches/.test(hit));
    });

    it('refuses a no-change claim in Thai with nothing saved', () => {
      assert.ok(unreconciledMatchClaim(presenceOnly, NO_CHANGE_PROMPT) !== null);
    });

    it('is satisfied by a saved reading a later expect actually compares', () => {
      const steps: FlowStep[] = [
        { action: 'saveCount', selector: 'role=row', as: 'rows', intent: 'read the table' },
        { action: 'expectText', selector: 'text="Total plans"', value: '{{rows}}', intent: 'tile equals table' },
      ];
      assert.equal(unreconciledMatchClaim(steps, MATCH_PROMPT), null);
    });

    it('a save whose variable nothing compares does not satisfy', () => {
      const steps: FlowStep[] = [
        { action: 'saveCount', selector: 'role=row', as: 'rows', intent: 'read the table' },
        { action: 'expectVisible', selector: 'text="Total plans"', intent: 'tile is there' },
      ];
      assert.ok(unreconciledMatchClaim(steps, MATCH_PROMPT) !== null);
    });

    it('a dbSnapshot + expectDbUnchanged pair is the DB spelling of the comparison', () => {
      const steps: FlowStep[] = [
        { action: 'dbSnapshot', table: 'benefit_plan', as: 'before' } as unknown as FlowStep,
        { action: 'expectDbUnchanged', snapshot: 'before' } as unknown as FlowStep,
      ];
      assert.equal(unreconciledMatchClaim(steps, NO_CHANGE_PROMPT), null);
    });

    it('says nothing about a case with no reconciliation wording', () => {
      assert.equal(unreconciledMatchClaim(presenceOnly, 'Expected output: the page shows the catalog.'), null);
    });
  });
});

describe('inventedControlInternals', () => {
  const click = (selector: string): FlowStep => ({ action: 'click', selector });

  it('flags a native-select fantasy in both spellings — the element and :checked', () => {
    // PL_04_04: thirty-one steps pinned to `main select:has(option:text-is("Medical"))`
    // on a page whose filter is a custom combobox — every one a guaranteed dead-end.
    const sel = 'main select:has(option:text-is("Medical"))';
    assert.deepEqual(inventedControlInternals([click(sel)]), {
      index: 0,
      selector: sel,
      fragment: '<select>',
    });
    assert.equal(
      inventedControlInternals([
        { action: 'expectText', selector: 'main select >> option:checked', value: 'All' },
      ])?.fragment,
      ':checked',
    );
  });

  it("leaves the tree's own notation, quoted text and lookalike tokens alone", () => {
    for (const ok of [
      'role=option[name="Medical"]',
      'role=combobox[name="Benefit Category" i]',
      'text="Select all"',
      '#option-list',
      '.select2-container',
      '[data-select="x"]',
      'input[placeholder="Select a date"]',
      'role=button[name="Search" i]',
    ]) {
      assert.equal(inventedControlInternals([click(ok)]), null, ok);
    }
  });

  it('reports the first offending step of many', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: '/en/admin/plans' },
      click('role=combobox[name="Category" i]'),
      click('select#category'),
    ];
    assert.equal(inventedControlInternals(steps)?.index, 2);
  });
});

describe('ungroundedUrlExpectation', () => {
  const TREE = 'link "OT Request" url="http://localhost:3000/en/overtime"\nlink "Leave" url="http://localhost:3000/en/leave"';

  it('refuses a URL derived from a label — the live time-attendance shape', () => {
    // The card is LABELLED "Time & Attendance" but ROUTES to /en/overtime;
    // asserting the label's slug filed a high defect against an app that
    // navigated correctly.
    const steps: FlowStep[] = [
      { action: 'goto', url: '/en/home' },
      { action: 'click', selector: 'role=link[name="OT Request" i]' },
      { action: 'expectUrl', value: 'time-attendance' },
    ];
    assert.deepEqual(ungroundedUrlExpectation(steps, TREE), { index: 2, expected: 'time-attendance' });
  });

  it('accepts a URL grounded in the tree, or in the flow’s own gotos', () => {
    const viaTree: FlowStep[] = [
      { action: 'click', selector: 'role=link[name="OT Request" i]' },
      { action: 'expectUrl', value: 'overtime' },
    ];
    const viaGoto: FlowStep[] = [
      { action: 'goto', url: '/en/custom-page' },
      { action: 'expectUrl', value: 'custom-page' },
    ];
    assert.equal(ungroundedUrlExpectation(viaTree, TREE), null);
    assert.equal(ungroundedUrlExpectation(viaGoto, TREE), null);
  });

  it('exempts expectations after a workflow step — the agent’s journey ends off-tree', () => {
    const steps: FlowStep[] = [
      { action: 'workflow', goal: 'reach the OT page via the sidebar' },
      { action: 'expectUrl', value: 'anything-at-all' },
    ];
    assert.equal(ungroundedUrlExpectation(steps, TREE), null);
  });

  it('declines to judge a truncated or absent tree', () => {
    const steps: FlowStep[] = [{ action: 'expectUrl', value: 'nowhere' }];
    assert.equal(ungroundedUrlExpectation(steps, `${TREE}\n[TREE TRUNCATED: ...]`), null);
    assert.equal(ungroundedUrlExpectation(steps, undefined), null);
  });
});

describe('groundCredentialFills', () => {
  it('splices the flow’s own sign-in goto in front of each stranded login block', () => {
    // The PB-02-01 authoring shape: the flow names its sign-in page once,
    // then switches persona twice with no navigation. The mechanical repair
    // is the exact fix the refusal message asks a human to type.
    const steps: FlowStep[] = [
      { action: 'goto', url: '/en/login' },
      { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'manager@x' },
      { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw' },
      { action: 'click', selector: 'role=button[name="Sign in" i]' },
      { action: 'goto', url: '/en/workflows/probation/PB-001' },
      { action: 'expectCount', selector: 'role=radio', count: 4 },
      // Persona switch, no navigation — the block starts at the email fill.
      { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'hr@x' },
      { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw' },
      { action: 'click', selector: 'role=button[name="Sign in" i]' },
    ];

    const repaired = groundCredentialFills([], steps, '/en/login');
    assert.equal(repaired.grounded, 1);
    // The goto lands before the whole credential block (the email fill), not
    // just before the password fill the detector flags.
    assert.deepEqual(repaired.steps[6], { action: 'goto', url: '/en/login' });
    assert.equal(repaired.steps.length, steps.length + 1);
    // And the repaired flow passes the lint that refused the original.
    assert.equal(strandedCredentialFill(repaired.steps), null);
  });

  it('touches nothing when every credential fill is already grounded', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: '/en/login' },
      { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw' },
    ];
    const repaired = groundCredentialFills([], steps, '/en/login');
    assert.equal(repaired.grounded, 0);
    assert.deepEqual(repaired.steps, steps);
  });

  it('reads the prefix (setup) to know where the flow already is', () => {
    const setup: FlowStep[] = [{ action: 'goto', url: '/en/workflows' }];
    const steps: FlowStep[] = [
      { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw' },
    ];
    const repaired = groundCredentialFills(setup, steps, '/en/login');
    assert.equal(repaired.grounded, 1);
    assert.deepEqual(repaired.steps[0], { action: 'goto', url: '/en/login' });
  });
});

describe('groundCredentialValues', () => {
  const AS = { email: 'admin@cnext.test', password: 'admin2026' };
  const login = (password: string): FlowStep[] => [
    { action: 'goto', url: '/en/login' },
    { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'admin@cnext.test' },
    { action: 'click', selector: 'role=button[name="Next" i]' },
    { action: 'fill', selector: 'input[type="password"]', value: password, intent: 'Fill password field' },
    { action: 'click', selector: 'role=button[name="Sign in" i]' },
    { action: 'expectHidden', selector: 'role=button[name="Sign in" i]' },
  ];

  it('replaces an invented password with the supplied one', () => {
    // The be100 shape (19 of 107 flows, live): the model was handed the
    // account and typed `AdminPass123!` anyway — a whole red run per flow.
    const steps = login('AdminPass123!');
    assert.equal(groundCredentialValues(steps, AS), 1);
    assert.equal((steps[3] as { value: string }).value, 'admin2026');
  });

  it('touches nothing when the flow already types the supplied password', () => {
    const steps = login('admin2026');
    assert.equal(groundCredentialValues(steps, AS), 0);
  });

  it('leaves another persona’s sign-in alone', () => {
    // A single --as must not overwrite a multi-persona catalog.
    const steps: FlowStep[] = [
      { action: 'goto', url: '/en/login' },
      { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'hrbp@cnext.test' },
      { action: 'fill', selector: 'input[type="password"]', value: 'hrbp2026' },
      { action: 'click', selector: 'role=button[name="Sign in" i]' },
      { action: 'expectHidden', selector: 'role=button[name="Sign in" i]' },
    ];
    assert.equal(groundCredentialValues(steps, AS), 0);
    assert.equal((steps[2] as { value: string }).value, 'hrbp2026');
  });

  it('leaves a deliberate wrong-password test alone', () => {
    // A negative login test asserts an error message, not the login proof —
    // no expectHidden in the segment means the flow never claims success.
    const steps: FlowStep[] = [
      { action: 'goto', url: '/en/login' },
      { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'admin@cnext.test' },
      { action: 'fill', selector: 'input[type="password"]', value: 'wrong-on-purpose' },
      { action: 'click', selector: 'role=button[name="Sign in" i]' },
      { action: 'expectText', selector: 'body', value: 'Invalid credentials' },
    ];
    assert.equal(groundCredentialValues(steps, AS), 0);
    assert.equal((steps[2] as { value: string }).value, 'wrong-on-purpose');
  });

  it('never overwrites the email fill itself, however its intent reads', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: '/en/login' },
      { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'admin@cnext.test', intent: 'Fill password credentials email' },
      { action: 'fill', selector: 'input[type="password"]', value: 'guess' },
      { action: 'expectHidden', selector: 'role=button[name="Sign in" i]' },
    ];
    assert.equal(groundCredentialValues(steps, AS), 1);
    assert.equal((steps[1] as { value: string }).value, 'admin@cnext.test');
    assert.equal((steps[2] as { value: string }).value, 'admin2026');
  });
});

describe('LlmFlowAuthorModel', () => {
  const payload = {
    name: 'search returns results',
    rationale: 'proves the search filters the table',
    setup: [
      { action: 'goto', selector: '', value: '', url: '/rules', key: '', name: '', intent: 'open the page' },
    ],
    steps: [
      {
        action: 'fill',
        selector: 'role=textbox[name="Search"]',
        value: 'leave',
        url: '',
        key: '',
        name: '',
        intent: 'the search box',
      },
      {
        action: 'press',
        selector: 'role=textbox[name="Search"]',
        value: '',
        url: '',
        key: 'Enter',
        name: '',
        intent: 'submit the search',
      },
      {
        action: 'expectCount',
        selector: 'role=row',
        value: '3',
        url: '',
        key: '',
        name: '',
        intent: 'matching rows',
      },
      {
        action: 'expectAttribute',
        selector: 'role=textbox[name="Search"]',
        value: 'false',
        url: '',
        key: '',
        name: 'aria-invalid',
        intent: 'not flagged invalid',
      },
      // Malformed on purpose: a click with no selector cannot be run.
      { action: 'click', selector: '', value: '', url: '', key: '', name: '', intent: 'nothing' },
      // Malformed on purpose: expectCount needs a numeric value.
      {
        action: 'expectCount',
        selector: 'role=row',
        value: 'several',
        url: '',
        key: '',
        name: '',
        intent: 'rows',
      },
    ],
    teardown: [],
    notes: 'assumed the search submits on Enter',
  };

  it('narrows the flat schema into real steps and counts what it dropped', async () => {
    const model = new LlmFlowAuthorModel({
      model: jsonModel('mock-author', payload, { inputTokens: 900, outputTokens: 210 }),
      id: 'mock:author',
    });

    const result = await model.author({ prompt: 'search for leave', policy: 'read-only' });

    assert.equal(result.name, 'search returns results');
    assert.equal(result.setup.length, 1);
    assert.equal(result.steps.length, 4, 'two malformed steps must be dropped');
    assert.equal(result.droppedSteps, 2);
    assert.equal(result.notes, 'assumed the search submits on Enter');
    assert.equal(result.inputTokens, 900);
    assert.equal(result.outputTokens, 210);

    // expectCount must arrive as a number, not the schema's string.
    const count = result.steps.find((s) => s.action === 'expectCount');
    assert.deepEqual(count, {
      action: 'expectCount',
      selector: 'role=row',
      count: 3,
      intent: 'matching rows',
    });

    // press carries its key, and keeps the optional selector.
    const press = result.steps.find((s) => s.action === 'press');
    assert.equal(press?.action === 'press' && press.key, 'Enter');

    // expectAttribute needs all three of selector, name, value.
    const attr = result.steps.find((s) => s.action === 'expectAttribute');
    assert.equal(attr?.action === 'expectAttribute' && attr.name, 'aria-invalid');
  });

  it('is usable end to end through FlowAuthor', async () => {
    const author = new FlowAuthor({
      model: new LlmFlowAuthorModel({
        model: jsonModel('mock-author', payload, { inputTokens: 900, outputTokens: 210 }),
        id: 'mock:author',
      }),
    });

    const authored = await author.author('search for leave and check the rows');

    assert.equal(authored.flow.steps.length, 4);
    assert.equal(authored.droppedSteps, 2);
    assert.equal(authored.model, 'mock:author');
    assert.match(authored.notes, /Enter/);
  });

  it('leaves a body the model did not divide as exactly one case', async () => {
    // The payload above labels nothing, which is also what a model that ignores
    // the field produces. That must cost the isolation between cases and nothing
    // else — not the authoring call, and not the flow.
    const model = new LlmFlowAuthorModel({
      model: jsonModel('mock-author', payload, { inputTokens: 0, outputTokens: 0 }),
      id: 'mock:author',
    });

    const result = await model.author({ prompt: 'search for leave' });

    assert.equal(result.cases?.length, 1);
    assert.equal(result.cases?.[0]?.name, 'search returns results', 'takes the flow’s own name');
    assert.deepEqual(result.cases?.[0]?.steps, result.steps);
  });
});

/**
 * A strict structured-output provider (Groq's `openai/gpt-oss-*`, OpenAI's own)
 * validates the schema before it asks the model, and rejects any object whose
 * `required` omits a key of `properties`. That failure is invisible to every
 * other test here — the stubs never build a wire schema — and it takes down the
 * whole authoring call rather than degrading, so it is pinned directly.
 */
describe('the wire schema', () => {
  /** Every object in the schema, including the ones nested inside arrays. */
  const objectsIn = (node: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] => {
    if (node === null || typeof node !== 'object') return found;
    const schema = node as Record<string, unknown>;
    if (schema['type'] === 'object' && schema['properties']) found.push(schema);
    for (const value of Object.values(schema)) {
      if (Array.isArray(value)) value.forEach((entry) => objectsIn(entry, found));
      else objectsIn(value, found);
    }
    return found;
  };

  it('lists every property in required, so a strict provider accepts it', () => {
    const emitted = (zodSchema(AuthoredFlowSchema) as { jsonSchema: unknown }).jsonSchema;
    const objects = objectsIn(emitted);
    assert.ok(objects.length >= 2, 'expected the flow and its step objects');

    for (const schema of objects) {
      const properties = Object.keys(schema['properties'] as Record<string, unknown>);
      const required = (schema['required'] as string[] | undefined) ?? [];
      const missing = properties.filter((key) => !required.includes(key));
      assert.deepEqual(
        missing,
        [],
        `every property must be in required — .optional()/.default() produce exactly this gap`,
      );
    }
  });

  it('still reads a step that omits case, so a lenient provider degrades', () => {
    // The other half of the same decision: required on the wire, tolerated on
    // the way in. A plain `.nullable()` would pass the test above and fail here.
    const parsed = AuthoredFlowSchema.safeParse({
      name: 'catalog',
      rationale: 'r',
      setup: [],
      steps: [{ action: 'expectVisible', selector: 'role=table', value: '', url: '', key: '', name: '', intent: 'the table' }],
      teardown: [],
      notes: '',
    });

    assert.ok(parsed.success, 'a step with no case at all must parse');
    assert.equal(parsed.data?.steps[0]?.case, null, 'and read as no case, not as a name');
  });
});

/**
 * Splitting a body into cases is what lets one failure be noted instead of
 * fatal: each case is run on its own, so the ones after a failure still get
 * answered. Everything here is a property of the split itself.
 */
describe('discrete cases', () => {
  const step = (
    action: string,
    caseName: string,
    intent: string,
  ): Record<string, string> => ({
    action,
    case: caseName,
    selector: action === 'goto' ? '' : 'role=table',
    value: '',
    url: action === 'goto' ? '/rules' : '',
    key: '',
    name: '',
    intent,
  });

  const authorOf = async (steps: Record<string, string>[]) =>
    new LlmFlowAuthorModel({
      model: jsonModel('mock-author', {
        name: 'catalog',
        rationale: 'r',
        setup: [step('goto', '', 'open the page')],
        steps,
        teardown: [],
        notes: '',
      }, { inputTokens: 0, outputTokens: 0 }),
      id: 'mock:author',
    }).author({ prompt: 'prove the catalog' });

  it('groups consecutive steps sharing a name, in the order they were written', async () => {
    const result = await authorOf([
      step('click', 'filtering', 'open the filter'),
      step('expectVisible', 'filtering', 'the filtered table'),
      step('click', 'export', 'press export'),
      step('expectVisible', 'export', 'the download appears'),
    ]);

    assert.deepEqual(result.cases?.map((one) => one.name), ['filtering', 'export']);
    assert.deepEqual(result.cases?.map((one) => one.steps.length), [2, 2]);
    // Nothing is dropped or duplicated by grouping.
    assert.deepEqual(result.cases?.flatMap((one) => one.steps), result.steps);
  });

  it('folds a case that asserts nothing into the one it prepares', async () => {
    // A run of steps with no assertion is not a case — run on its own it would
    // pass whether or not the feature works. It is preparation for what follows.
    const result = await authorOf([
      step('click', 'sign in', 'press continue'),
      step('click', 'filtering', 'open the filter'),
      step('expectVisible', 'filtering', 'the filtered table'),
    ]);

    assert.deepEqual(result.cases?.map((one) => one.name), ['filtering']);
    assert.equal(result.cases?.[0]?.steps.length, 3);
    const first = result.cases?.[0]?.steps[0];
    assert.equal(first?.action === 'click' ? first.intent : undefined, 'press continue');
  });

  it('folds a trailing case that asserts nothing back into the previous one', async () => {
    const result = await authorOf([
      step('expectVisible', 'filtering', 'the filtered table'),
      step('click', 'tidy up', 'close the panel'),
    ]);

    assert.deepEqual(result.cases?.map((one) => one.name), ['filtering']);
    assert.equal(result.cases?.[0]?.steps.length, 2);
  });

  it('keeps two runs of the same name apart instead of re-ordering the body', async () => {
    // Gathering them would move steps past ones they depend on. They are two
    // cases; the report has to be able to tell them apart.
    const result = await authorOf([
      step('expectVisible', 'rows', 'rows before'),
      step('expectVisible', 'export', 'the download appears'),
      step('expectVisible', 'rows', 'rows after'),
    ]);

    assert.deepEqual(result.cases?.map((one) => one.name), ['rows', 'export', 'rows (2)']);
  });

  it('gives every case the shared setup and teardown, so none depends on another', async () => {
    const authored = await new FlowAuthor({
      model: {
        id: 'stub',
        author: async () => ({
          name: 'catalog',
          rationale: 'r',
          setup: [{ action: 'goto', url: '/rules' }],
          steps: [
            { action: 'expectVisible', selector: 'role=table', intent: 'the table' },
            { action: 'expectVisible', selector: 'role=alert', intent: 'the banner' },
          ],
          cases: [
            { name: 'the table', steps: [{ action: 'expectVisible', selector: 'role=table', intent: 'the table' }] },
            { name: 'the banner', steps: [{ action: 'expectVisible', selector: 'role=alert', intent: 'the banner' }] },
          ],
          teardown: [{ action: 'clearStorage' }],
          notes: '',
          droppedSteps: 0,
        }),
      },
    }).author('prove the catalog');

    const flows = caseFlows(authored);

    assert.deepEqual(flows.map((one) => one.name), ['the table', 'the banner']);
    // Setup runs again before each: that is what makes case 2 independent of
    // whatever case 1 left behind.
    for (const { flow } of flows) {
      assert.deepEqual(flow.setup, [{ action: 'goto', url: '/rules' }]);
      assert.deepEqual(flow.teardown, [{ action: 'clearStorage' }]);
      assert.equal(flow.steps.length, 1);
    }
    assert.deepEqual(flows.map((one) => one.flow.name), ['catalog — the table', 'catalog — the banner']);
  });

  it('leaves an undivided flow’s name alone, so its history is not split in two', async () => {
    const authored = await new FlowAuthor({
      model: {
        id: 'stub',
        author: async () => ({
          name: 'catalog',
          rationale: 'r',
          setup: [],
          steps: [{ action: 'expectVisible', selector: 'role=table', intent: 'the table' }],
          teardown: [],
          notes: '',
          droppedSteps: 0,
        }),
      },
    }).author('prove the catalog');

    const flows = caseFlows(authored);

    assert.equal(flows.length, 1);
    assert.equal(flows[0]?.flow.name, 'catalog');
  });

  it('hands a body that asserts nothing at all back whole, for FlowAuthor to refuse', async () => {
    // Inventing a case here would turn "this proves nothing" into a green run.
    const steps = [step('click', 'a', 'press one'), step('click', 'b', 'press two')];
    const result = await authorOf(steps);

    assert.equal(result.cases?.length, 1);
    assert.equal(result.cases?.[0]?.steps.length, 2);

    await assert.rejects(
      () =>
        new FlowAuthor({
          model: { id: 'stub', author: async () => result },
        }).author('prove the catalog'),
      (error: unknown) => error instanceof AuthoringError && /no assertion/.test((error as Error).message),
    );
  });
});

// --- the post-submit synchronization lint -----------------------------------

describe('unsynchronizedLoginSubmit', () => {
  const fillPassword: FlowStep = {
    action: 'fill',
    selector: 'role=textbox >> nth=1',
    value: 'admin2026',
    intent: 'Fill admin password',
  };
  const click: FlowStep = { action: 'click', selector: 'role=button[name="Sign in" i]' };
  const goto: FlowStep = { action: 'goto', url: '/en/admin/benefits/plans' };

  it('flags a credential submit followed immediately by a goto', () => {
    // The live failure shape: the click can land before hydration, the form
    // submits natively, and nothing between click and goto would notice.
    const at = unsynchronizedLoginSubmit([
      { action: 'goto', url: '/en/login' },
      { action: 'fill', selector: 'input[type=email]', value: 'admin@cnext.test', intent: 'email' },
      fillPassword,
      click,
      goto,
    ]);
    assert.equal(at, 3, 'the click is the offender, by index');
  });

  it('is satisfied by any check between the click and the goto', () => {
    for (const guard of [
      { action: 'expectUrl', value: '/en/admin' } as FlowStep,
      { action: 'expectVisible', selector: 'role=button[name="Sign out"]' } as FlowStep,
      { action: 'waitFor', selector: 'role=navigation' } as FlowStep,
    ]) {
      assert.equal(
        unsynchronizedLoginSubmit([fillPassword, click, guard, goto]),
        null,
        `${guard.action} between click and goto must satisfy the rule`,
      );
    }
  });

  it('never fires without a credential-shaped fill', () => {
    const search: FlowStep = { action: 'fill', selector: 'role=searchbox', value: 'leave', intent: 'search' };
    assert.equal(unsynchronizedLoginSubmit([search, click, goto]), null);
  });

  it('a non-click step between the fill and a later click ends the block', () => {
    const wait: FlowStep = { action: 'waitFor', selector: 'role=main' };
    assert.equal(unsynchronizedLoginSubmit([fillPassword, wait, click, goto]), null);
  });

  it('feeds the informed re-ask through FlowAuthor', async () => {
    // Two-shot model: the first answer navigates straight off the submit, the
    // second (which must have been told why) adds the check. Same seam as the
    // healer's `rejected` — the value of a retry is in the ask that knows.
    const asked: AuthorRequest[] = [];
    const bad: Partial<AuthorResult> = {
      setup: [],
      steps: [
        { action: 'goto', url: '/en/login' },
        { action: 'fill', selector: 'input[type=email]', value: 'a@b.c', intent: 'email' },
        { action: 'fill', selector: 'input[type=password]', value: 's3cret', intent: 'password' },
        { action: 'click', selector: 'role=button[name="Sign in" i]' },
        { action: 'goto', url: '/en/plans' },
        { action: 'expectVisible', selector: 'role=table', intent: 'the table' },
      ],
    };
    const good: Partial<AuthorResult> = {
      steps: [
        { action: 'goto', url: '/en/login' },
        { action: 'fill', selector: 'input[type=email]', value: 'a@b.c', intent: 'email' },
        { action: 'fill', selector: 'input[type=password]', value: 's3cret', intent: 'password' },
        { action: 'click', selector: 'role=button[name="Sign in" i]' },
        { action: 'expectUrl', value: '/en/home', intent: 'the login took' },
        { action: 'goto', url: '/en/plans' },
        { action: 'expectVisible', selector: 'role=table', intent: 'the table' },
      ],
    };
    const model: FlowAuthorModel = {
      id: 'stub:two-shot',
      async author(request) {
        asked.push(request);
        return {
          name: 'login then plans',
          rationale: '',
          setup: [],
          teardown: [],
          notes: '',
          droppedSteps: 0,
          steps: [],
          ...(asked.length === 1 ? bad : good),
        } as AuthorResult;
      },
    };

    const authored = await new FlowAuthor({ model }).author('check the plans page as admin');

    assert.equal(asked.length, 2, 'one informed re-ask');
    assert.match(
      asked[1]?.feedback?.join(' ') ?? '',
      /sign-in submit|hydrat/i,
      'the second ask carries the refusal',
    );
    assert.equal(authored.flow.steps.some((s) => s.action === 'expectUrl'), true);
  });
});

// --- the deliberate-HTTP family and friends, authored flat -------------------

describe('authoring request / expectStatus / expectJson / expectDbCount / setClock / modals', () => {
  const flat = (over: Record<string, string>) => ({
    action: '',
    selector: '',
    value: '',
    url: '',
    key: '',
    name: '',
    intent: 'step',
    ...over,
  });

  const authorWith = async (
    steps: Record<string, string>[],
    options: { policy?: 'read-only' | 'forms' | 'mutations'; tables?: boolean } = {},
  ) => {
    const model = new LlmFlowAuthorModel({
      model: jsonModel(
        'mock-author',
        {
          name: 'backend claims',
          rationale: '',
          setup: [],
          steps,
          teardown: [],
          notes: '',
        },
        { inputTokens: 0, outputTokens: 0 },
      ),
      id: 'mock:author',
    });
    return model.author({
      prompt: 'prove the backend claims',
      policy: options.policy ?? 'mutations',
      ...(options.tables === false
        ? {}
        : { tables: [{ name: 'benefit_management.benefit_plan', summary: 'id, status' }] }),
    });
  };

  it('narrows a request with saves, and parses a JSON body into the object', async () => {
    const result = await authorWith([
      flat({ action: 'request', name: 'POST /api/db/seed', key: 'n = $.plans.updated' }),
      flat({ action: 'request', name: 'POST /api/echo', value: '{"a":1}' }),
    ]);
    assert.equal(result.droppedSteps, 0);
    const [seed, echo] = result.steps;
    assert.deepEqual(seed, {
      action: 'request',
      method: 'POST',
      url: '/api/db/seed',
      save: { n: '$.plans.updated' },
      intent: 'step',
    });
    assert.equal(echo?.action === 'request' && (echo.body as { a: number }).a, 1);
  });

  it('DELETE is dropped at every policy tier, and writes need more than read-only', async () => {
    for (const policy of ['read-only', 'forms', 'mutations'] as const) {
      const result = await authorWith(
        [flat({ action: 'request', name: 'DELETE /api/x' })],
        { policy },
      );
      assert.equal(result.steps.length, 0, `DELETE must be dropped under ${policy}`);
    }
    const readOnly = await authorWith(
      [
        flat({ action: 'request', name: 'POST /api/db/seed' }),
        flat({ action: 'request', name: 'GET /api/db/health' }),
      ],
      { policy: 'read-only' },
    );
    assert.equal(readOnly.steps.length, 1, 'only the GET survives read-only');
    assert.equal(readOnly.steps[0]?.action === 'request' && readOnly.steps[0].method, 'GET');
  });

  it('a save that is not a JSON path drops the step rather than saving nothing', async () => {
    const result = await authorWith([
      flat({ action: 'request', name: 'GET /api/db/health', key: 'n = counts.persons' }),
    ]);
    assert.equal(result.steps.length, 0);
    assert.equal(result.droppedSteps, 1);
  });

  it('narrows expectStatus and expectJson, and refuses what it cannot use', async () => {
    const result = await authorWith([
      flat({ action: 'expectStatus', value: '200' }),
      flat({ action: 'expectStatus', value: 'ok' }),
      flat({ action: 'expectJson', key: '$.counts.persons', value: '98' }),
      flat({ action: 'expectJson', key: '$.ok' }),
      flat({ action: 'expectJson', key: 'counts.persons', value: '98' }),
    ]);
    assert.deepEqual(result.steps, [
      { action: 'expectStatus', status: 200, intent: 'step' },
      { action: 'expectJson', path: '$.counts.persons', value: '98', intent: 'step' },
      { action: 'expectJson', path: '$.ok', intent: 'step' },
    ]);
    assert.equal(result.droppedSteps, 2);
  });

  it('expectDbCount narrows to an exact-count expectDbRow, variables surviving as strings', async () => {
    const result = await authorWith([
      flat({ action: 'expectDbCount', name: 'benefit_management.benefit_plan', value: '36' }),
      flat({ action: 'expectDbCount', name: 'benefit_management.benefit_plan', value: '{{n}}' }),
      flat({ action: 'expectDbCount', name: 'benefit_management.benefit_plan', value: 'lots' }),
    ]);
    assert.deepEqual(result.steps, [
      { action: 'expectDbRow', table: 'benefit_management.benefit_plan', where: {}, count: 36, intent: 'step' },
      { action: 'expectDbRow', table: 'benefit_management.benefit_plan', where: {}, count: '{{n}}', intent: 'step' },
    ]);
    assert.equal(result.droppedSteps, 1);
  });

  it('expectDbCount obeys the same structural DB permission as every DB step', async () => {
    const result = await authorWith(
      [flat({ action: 'expectDbCount', name: 'benefit_plan', value: '36' })],
      { tables: false },
    );
    assert.equal(result.steps.length, 0, 'no inventory, no DB step — filter, not sentence');
  });

  it('narrows setClock and refuses a time the clock cannot be pinned to', async () => {
    const result = await authorWith([
      flat({ action: 'setClock', value: '2026-08-01' }),
      flat({ action: 'setClock', value: 'the day before the demo' }),
    ]);
    assert.deepEqual(result.steps, [{ action: 'setClock', time: '2026-08-01', intent: 'step' }]);
    assert.equal(result.droppedSteps, 1);
  });

  it('narrows expectModal and closeModal', async () => {
    const result = await authorWith([
      flat({ action: 'expectModal', name: 'Edit rule' }),
      flat({ action: 'expectModal' }),
      flat({ action: 'closeModal', selector: 'role=button[name="Close"]' }),
    ]);
    assert.deepEqual(result.steps, [
      { action: 'expectModal', name: 'Edit rule', intent: 'step' },
      { action: 'expectModal', intent: 'step' },
      // The button selector rides the same accessible-name case relaxation as
      // every other selector written from a tree name.
      { action: 'closeModal', button: 'role=button[name="Close" i]', intent: 'step' },
    ]);
  });
});

// --- the uncaptured-page teachings must actually reach the model -------------

describe('the system prompt teaches the uncaptured-page rules', () => {
  it('workflow-for-uncaptured-legs, the disclosure corollaries, and the one-page rule are sent', async () => {
    // DB_04_01/DB_06_01/DB_07_01: the capture only ever sees the login page,
    // so modal fields and row buttons are structurally absent from the tree —
    // these teachings are what let such claims be authored honestly instead
    // of asserted-but-never-performed. A prompt edit that silently fails to
    // reach the wire is a teaching that never happened.
    const mock = jsonModel(
      'mock-author',
      { name: 'x', rationale: '', setup: [], steps: [], teardown: [], notes: '' },
      { inputTokens: 0, outputTokens: 0 },
    );
    const model = new LlmFlowAuthorModel({ model: mock, id: 'mock:author' });
    await model.author({ prompt: 'edit the rule', policy: 'forms', axTree: 'button "Sign in"' });

    // The prompt hard-wraps at the vocabulary column, so phrases span line
    // breaks — normalise the whole recorded call to single spaces before
    // matching, or every assertion is hostage to where a line happens to wrap.
    const sent = JSON.stringify(
      (mock as unknown as { doGenerateCalls: unknown[] }).doGenerateCalls[0],
    )
      .replace(/\\n/g, ' ')
      .replace(/\s+/g, ' ');
    assert.match(sent, /evidence independent of the agent/);
    assert.match(sent, /Use it only for a leg whose controls appear in no tree/);
    assert.match(sent, /Never follow such a disclosure with an assertion/);
    assert.match(sent, /request .{0,3}name.{0,3} is .{0,3}METHOD \/path/);
    assert.match(sent, /The tree describes one page state/);
  });
});

describe('a CSS comment is not a selector', () => {
  it('drops a step whose selector is commentary about a missing control', async () => {
    // The live shape (DB_08_01): the model "declined" by emitting
    // `/* selector for RULE-FUEL-002 row not found */`, which reached
    // Playwright as a parse error, three times, plus the reconstruction
    // budget. A comment has no selector; the step must be dropped and
    // counted, like every other unusable emission.
    const model = new LlmFlowAuthorModel({
      model: jsonModel(
        'mock-author',
        {
          name: 'comments are not selectors',
          rationale: '',
          setup: [],
          steps: [
            {
              action: 'expectHidden',
              selector: '/* selector for RULE-FUEL-002 row not found in accessibility tree */',
              value: '',
              url: '',
              key: '',
              name: '',
              intent: 'cannot be asserted',
            },
            {
              action: 'expectVisible',
              selector: 'role=table',
              value: '',
              url: '',
              key: '',
              name: '',
              intent: 'the manager renders',
            },
          ],
          teardown: [],
          notes: '',
        },
        { inputTokens: 0, outputTokens: 0 },
      ),
      id: 'mock:author',
    });
    const result = await model.author({ prompt: 'check the rule manager' });
    assert.deepEqual(result.steps, [
      { action: 'expectVisible', selector: 'role=table', intent: 'the manager renders' },
    ]);
    assert.equal(result.droppedSteps, 1);
  });
});

describe('the backend toggle', () => {
  /** The flat authored shape, as the model actually returns it. */
  const authored = {
    name: 'PL_03_03 count check',
    rationale: 'the card must agree with the data behind it',
    notes: '',
    setup: [],
    steps: [
      { action: 'request', selector: '', value: '', url: '', key: 'n = $.counts.hr', name: 'GET /api/benefit-plans', intent: 'read the count' },
      { action: 'expectStatus', selector: '', value: '200', url: '', key: '', name: '', intent: 'the endpoint answers' },
      { action: 'expectDbRow', selector: '', value: '', url: '', key: 'benefit_type = REIMBURSEMENT_HR', name: 'benefit_management.benefit_plan', intent: 'the row count' },
      { action: 'expectVisible', selector: 'text=REIMBURSEMENT BY HR', value: '', url: '', key: '', name: '', intent: 'backend could prove this: the count on screen should equal the benefit_plan rows of that type' },
    ],
    teardown: [],
  };
  const tables = [{ name: 'benefit_management.benefit_plan', summary: 'benefit_plan_id, benefit_type, status' }];
  const authorModel = () =>
    new LlmFlowAuthorModel({
      model: jsonModel('mock-author', authored, { inputTokens: 100, outputTokens: 40 }),
      id: 'mock:author',
    });

  it('writes no backend step when the run says backend is off, and says why', async () => {
    // The person turned the backend off; the claim is still proved, on screen.
    const result = await authorModel().author({
      prompt: 'check the Reimbursement by HR count',
      backend: false,
      tables,
    });

    assert.deepEqual(
      result.steps.map((step) => step.action),
      ['expectVisible'],
      'every HTTP and database step is dropped',
    );
    assert.equal(result.droppedSteps, 3);
    // The model is told WHY, in words it can act on next attempt — and all
    // three get the same reason, because they were dropped for one.
    assert.ok(
      (result.dropped ?? []).every((one) => one.reason === BACKEND_OFF_REASON),
      JSON.stringify(result.dropped),
    );
    // The claim still has a proof, so this is not a vacuous flow.
    assert.equal(vacuousFlow({ steps: result.steps, setup: result.setup }), null);
  });

  it('leaves the backend family alone when the toggle is on (the default)', async () => {
    const result = await authorModel().author({
      prompt: 'check the Reimbursement by HR count against the database',
      tables,
    });
    assert.deepEqual(
      result.steps.map((step) => step.action),
      ['request', 'expectStatus', 'expectDbRow', 'expectVisible'],
      'absent means yes — what every caller meant before the toggle existed',
    );
  });

  it('names the backend rule in the prompt only when the toggle is off', () => {
    const off = buildUserPrompt({ prompt: 'a claim', backend: false });
    assert.match(off, /BACKEND TESTING IS OFF/);
    assert.match(off, /backend could prove this: /, 'and how to mark the step it settles visually');
    assert.doesNotMatch(buildUserPrompt({ prompt: 'a claim' }), /BACKEND TESTING IS OFF/);
  });
});

describe('wordingClaimAssertsDataValue', () => {
  const claim = 'PL_02_02 ตรวจสอบความถูกต้องของข้อความในหน้า Benefit Plan Catalog — menu: HR > Benefits Admin > Benefit Plans; expected: 2.1 ข้อความสะกดถูกต้องตรงตาม Spec';
  const tree = [
    'heading "Benefit Plan Catalog"',
    'link "Benefits Admin" url="/en/admin/benefits"',
    'columnheader "Benefit Name"',
    'button "Create Plan"',
    'cell "TH_MED_001"',
    'cell "Medical Reimbursement"',
  ].join('\n');

  it('refuses a wording claim asserted on a row value the sheet never states (PL_02_02)', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: '/en/admin/benefits/plans' },
      { action: 'expectVisible', selector: 'text=Medical Reimbursement' },
    ];
    assert.deepEqual(wordingClaimAssertsDataValue(claim, steps, tree), { index: 1, value: 'Medical Reimbursement' });
    // expectText carries the value in `value`.
    assert.equal(
      wordingClaimAssertsDataValue(claim, [{ action: 'expectText', selector: 'role=table', value: 'Medical Reimbursement' }], tree)?.value,
      'Medical Reimbursement',
    );
  });

  it('accepts labels the sheet names or the tree shows outside a data row', () => {
    const steps: FlowStep[] = [
      { action: 'expectVisible', selector: 'text="Benefit Plans"' },
      { action: 'expectVisible', selector: 'text="Benefits Admin"' },
      { action: 'expectVisible', selector: 'text=Create Plan' },
      { action: 'expectText', selector: 'role=columnheader', value: 'Benefit Name' },
      { action: 'expectVisible', selector: 'role=heading[name="Benefit Plan Catalog" i]' },
    ];
    assert.equal(wordingClaimAssertsDataValue(claim, steps, tree), null);
  });

  it('never fires for a claim that is not about wording', () => {
    const steps: FlowStep[] = [{ action: 'expectVisible', selector: 'text=Medical Reimbursement' }];
    assert.equal(wordingClaimAssertsDataValue('PL_04_03 filter by benefit name shows the matching plan', steps, tree), null);
  });

  it('reads the CASE, not the retrieved background, to decide it is a wording claim', () => {
    // ec10, 2026-09-02: a new-hire creation row whose own words never mention
    // wording, authored from a prompt whose Thai requirement documents say
    // `ข้อความ` many times. Every row of the catalog was classified a wording
    // claim from the background alone, and four were refused for asserting a
    // value the documents happened not to quote.
    const backgroundHeavyPrompt =
      'HIR-EC-008 ตรวจสอบการจ้างพนักงานใหม่แบบ Key-in สำเร็จ\n' +
      'BACKGROUND: ระบบแสดงข้อความแจ้งเตือนเมื่อบันทึกสำเร็จ และตรวจสอบการสะกดของข้อความทุกหน้า';
    const caseOwnWords = 'HIR-EC-008 ตรวจสอบการจ้างพนักงานใหม่แบบ Key-in สำเร็จ';
    const steps: FlowStep[] = [{ action: 'expectVisible', selector: 'text=New Employee Added Successfully' }];
    // The old behaviour, still what a prompt-only caller gets.
    assert.ok(wordingClaimAssertsDataValue(backgroundHeavyPrompt, steps, tree) !== null);
    // With the case's own words the lint stands down — this row is not about wording.
    assert.equal(wordingClaimAssertsDataValue(backgroundHeavyPrompt, steps, tree, undefined, caseOwnWords), null);
  });

  it('still fires when the CASE itself is about wording, background or no background', () => {
    const steps: FlowStep[] = [{ action: 'expectVisible', selector: 'text=Medical Reimbursement' }];
    assert.deepEqual(wordingClaimAssertsDataValue('anything', steps, tree, undefined, claim), {
      index: 0,
      value: 'Medical Reimbursement',
    });
  });
});

describe('assertsOpenQuestion', () => {
  it('refuses an assertion on the sheet\'s open-question id — it is a question, not page text', () => {
    // ec10 HIR-EC-009, live: the sheet says "ตาราง DVT Project Name / Type และ
    // รูปแบบ Course of Time = ? OQ-HIR-78" and the flow asserted the id itself.
    assert.deepEqual(
      assertsOpenQuestion([
        { action: 'goto', url: '/en/admin/hire' },
        { action: 'expectVisible', selector: 'text=OQ-HIR-78' },
      ]),
      { index: 1, value: 'OQ-HIR-78', marker: 'OQ-HIR-78' },
    );
    assert.equal(
      assertsOpenQuestion([{ action: 'expectText', selector: 'role=alert', value: 'see CF-SIT-19 for the rule' }])?.marker,
      'CF-SIT-19',
    );
  });

  it('leaves the tester\'s own data and a reader\'s note alone', () => {
    // A value typed in is data, and an intent naming the question is a note.
    assert.equal(assertsOpenQuestion([{ action: 'fill', selector: 'role=textbox', value: 'OQ-HIR-78' }]), null);
    assert.equal(
      assertsOpenQuestion([
        { action: 'expectVisible', selector: 'role=button[name="Submit" i]', intent: 'records the answer to OQ-HIR-50' },
      ]),
      null,
    );
    assert.equal(assertsOpenQuestion([{ action: 'expectVisible', selector: 'text=Employee Group' }]), null);
  });

  it('reads the id through a role name and past an nth chain (HIR-EC-001, 2026-09-04)', () => {
    // multirole.csv HIR-EC-001: "Policy Profile = CDS ใช้แทน CDS ที่เคยระบุ ดู CF-SIT-19".
    assert.equal(
      assertsOpenQuestion([{ action: 'expectVisible', selector: 'role=cell[name="CF-SIT-19" i]' }])?.marker,
      'CF-SIT-19',
    );
    assert.equal(assertsOpenQuestion([{ action: 'expectVisible', selector: 'text=CF-SIT-19 >> nth=0' }])?.marker, 'CF-SIT-19');
    assert.equal(assertsOpenQuestion([{ action: 'expectVisible', selector: 'role=textbox[name="Policy Profile" i]' }]), null);
  });
});

describe('wordingClaimAssertsDataValue', () => {
  const claim =
    'PL_02_02 ตรวจสอบความถูกต้องของข้อความในหน้า Benefit Plan Catalog — expected: 2.1 ข้อความสะกดถูกต้องตรงตาม Spec';
  const tree = [
    'heading "Benefit Plan Catalog"',
    'link "Benefits Admin" url="/en/admin/benefits"',
    'columnheader "Benefit Name"',
    'button "Create Plan"',
    'cell "TH_MED_001"',
    'cell "Medical Reimbursement"',
  ].join('\n');

  it('refuses a wording claim asserted on a row value (PL_02_02)', () => {
    // The plan name is in the tree — as a CELL. A row is data: a sibling
    // delete case removed TH_MED_001 45 minutes after this was authored, and
    // the case dead-ended against a correctly worded page.
    const steps: FlowStep[] = [
      { action: 'goto', url: '/en/admin/benefits/plans' },
      { action: 'expectVisible', selector: 'text=Medical Reimbursement' },
    ];
    assert.deepEqual(wordingClaimAssertsDataValue(claim, steps, tree), {
      index: 1,
      value: 'Medical Reimbursement',
    });
    assert.equal(
      wordingClaimAssertsDataValue(
        claim,
        [{ action: 'expectText', selector: 'role=table', value: 'Medical Reimbursement' }],
        tree,
      )?.value,
      'Medical Reimbursement',
    );
  });

  it('accepts labels the spec owns — heading, breadcrumb, column, button', () => {
    // The shape the earlier authorings of PL_02_02 used, which proved.
    const steps: FlowStep[] = [
      { action: 'expectVisible', selector: 'text="Benefit Plan Catalog"' },
      { action: 'expectVisible', selector: 'text="Benefits Admin"' },
      { action: 'expectVisible', selector: 'text=Create Plan' },
      { action: 'expectText', selector: 'role=columnheader', value: 'Benefit Name' },
    ];
    assert.equal(wordingClaimAssertsDataValue(claim, steps, tree), null);
  });

  it('says nothing for a non-wording claim, or with no tree to judge against', () => {
    const steps: FlowStep[] = [{ action: 'expectVisible', selector: 'text=Medical Reimbursement' }];
    assert.equal(wordingClaimAssertsDataValue('PL_04_03 filter by benefit name', steps, tree), null);
    // Ungrounded authoring cannot tell a label from a row — silence, never a
    // refusal of every honest wording flow.
    assert.equal(wordingClaimAssertsDataValue(claim, steps, ''), null);
  });
});

describe('ungroundedGoto', () => {
  const routes = ['/:locale/admin/benefits/plans', '/:locale/admin/benefits', '/:locale/login'];

  it('refuses a navigation to a page the codebase does not declare, and names the near miss', () => {
    // be100 PL_02_03: the flow went to a path that answered 404, and every
    // step after it failed against the error page — attributed to the app.
    const found = ungroundedGoto(
      [
        { action: 'goto', url: '/en/login' },
        { action: 'goto', url: '/en/admin/benefits/plans/create' },
      ],
      routes,
    );
    assert.equal(found?.index, 1);
    assert.equal(found?.url, '/en/admin/benefits/plans/create');
    assert.equal(found?.near[0], '/:locale/admin/benefits/plans', 'the refusal carries what they meant');
  });

  it('accepts a declared route, whatever its concrete parameters', () => {
    assert.equal(
      ungroundedGoto([{ action: 'goto', url: 'http://localhost:3000/en/admin/benefits/plans' }], routes, 'http://localhost:3000'),
      null,
    );
    assert.equal(ungroundedGoto([{ action: 'goto', url: '/th/login' }], routes), null, ':locale matches any locale');
  });

  it('accepts a declared route mounted below the supplied deployment base path', () => {
    const startUrl = 'https://sit.example.test/humi/th/login';
    assert.equal(
      ungroundedGoto([{ action: 'goto', url: startUrl }], routes, startUrl),
      null,
    );
  });

  it('keeps no opinion without an index, or about another origin', () => {
    // Silence is the rule everywhere the evidence runs out: a repo that
    // declares nothing cannot contradict anything.
    assert.equal(ungroundedGoto([{ action: 'goto', url: '/en/whatever' }], []), null);
    assert.equal(
      ungroundedGoto([{ action: 'goto', url: 'https://accounts.google.com/signin' }], routes, 'http://localhost:3000'),
      null,
      "another origin is not this application's routing table's business",
    );
  });
});

describe('authored absolute URLs stay on the deployment host', () => {
  const deployment = 'https://suite-int.example.test/en/start';

  it('refuses a goto whose host differs by one character and names both hosts', () => {
    const found = foreignAuthoredHost(
      [{ action: 'goto', url: 'https://suite.int.example.test/en/start' }],
      deployment,
    );
    assert.equal(found?.actualHost, 'suite.int.example.test');
    assert.equal(found?.expectedHost, 'suite-int.example.test');
  });

  it('returns an actionable fatal refusal naming the actual and expected hosts', () => {
    const foreign = foreignAuthoredHost(
      [{ action: 'goto', url: 'https://suite.int.example.test/en/start' }],
      deployment,
    );
    assert.ok(foreign !== null);
    assert.equal(
      foreignHostRefusal('stub flow', foreign),
      'the authored flow "stub flow" has a goto URL "https://suite.int.example.test/en/start" on host ' +
        '"suite.int.example.test", but this run\'s deployment host is "suite-int.example.test". ' +
        'The run\'s own host "suite-int.example.test" is the only one this catalog may reach. ' +
        'Use "suite-int.example.test" for this URL, or make it relative to the deployment URL.',
    );
  });

  it('accepts relative, placeholder, and same-host absolute URLs', () => {
    assert.equal(foreignAuthoredHost([{ action: 'goto', url: '/en/start' }], deployment), null);
    assert.equal(foreignAuthoredHost([{ action: 'signIn', as: 'PERSONA', url: '{{loginUrl}}' }], deployment), null);
    assert.equal(foreignAuthoredHost([{ action: 'goto', url: 'https://suite-int.example.test/en/next' }], deployment), null);
  });

  it('refuses a request to a foreign host through the same rule', () => {
    const found = foreignAuthoredHost(
      [{ action: 'request', method: 'GET', url: 'https://api.example.test/items' }],
      deployment,
    );
    assert.equal(found?.action, 'request');
    assert.equal(found?.actualHost, 'api.example.test');
    assert.equal(found?.expectedHost, 'suite-int.example.test');
  });
});

describe('unindexedRequestMethod', () => {
  // What the repository declares once its file-convention router is read for
  // methods: `/api/benefit-plans` answers writes only.
  const declared = [
    'POST /api/benefit-plans',
    'PUT /api/benefit-plans',
    'DELETE /api/benefit-plans',
    'GET /api/db/health',
  ];

  it('refuses the PL_03_03 shape: GET on a path that declares only writes', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: '/en/admin/benefits/plans' },
      { action: 'request', method: 'GET', url: 'http://localhost:3000/api/benefit-plans' },
    ];
    assert.deepEqual(unindexedRequestMethod(steps, declared), {
      index: 1,
      method: 'GET',
      path: '/api/benefit-plans',
      declared: ['DELETE', 'POST', 'PUT'],
    });
  });

  it('accepts a declared method, and ignores the origin and query string', () => {
    assert.equal(
      unindexedRequestMethod(
        [{ action: 'request', method: 'POST', url: 'http://localhost:3000/api/benefit-plans?dry=1' }],
        declared,
      ),
      null,
    );
    assert.equal(
      unindexedRequestMethod([{ action: 'request', method: 'get', url: '/api/db/health' }], declared),
      null,
      'the method is compared case-insensitively',
    );
    // A GET handler answers HEAD in every framework this indexes.
    assert.equal(
      unindexedRequestMethod([{ action: 'request', method: 'HEAD', url: '/api/db/health' }], declared),
      null,
    );
  });

  it('says nothing about a path the index does not declare, or with no index at all', () => {
    // Silence is the rule: an endpoint outside the index may be a proxy, a
    // service on another host, or an unindexed repo — and a refusal there
    // would block honest tests.
    assert.equal(
      unindexedRequestMethod([{ action: 'request', method: 'GET', url: '/api/not-indexed' }], declared),
      null,
    );
    assert.equal(
      unindexedRequestMethod([{ action: 'request', method: 'GET', url: '/api/benefit-plans' }], []),
      null,
    );
  });
});

describe('run-4 vacuity lints', () => {
  it('dbClaimWithoutDbCheck fires only for a DB-comparison claim with tables and no DB step', () => {
    const steps: FlowStep[] = [
      { action: 'request', method: 'GET', url: '/api/db/health' },
      { action: 'expectJson', path: '$.counts', intent: 'counts exist' },
    ];
    assert.equal(
      dbClaimWithoutDbCheck('counts must match the database exactly', steps, true),
      'unused',
    );
    // With a DB check present the claim is being compared for real.
    assert.equal(
      dbClaimWithoutDbCheck('counts must match the database exactly', [
        ...steps,
        { action: 'expectDbRow', table: 't', where: {}, count: '{{n}}' },
      ], true),
      false,
    );
    // No inventory now REFUSES rather than passing through. The old reasoning
    // here — "the disclosure in cmdCatalog covers that case" — was disproved
    // live: cmdCatalog's warning is a stdout line, and DB_01_01 still reported
    // a green pass for "counts match the database exactly" having read no
    // count at all. A warning that does not change the verdict is not cover.
    assert.equal(
      dbClaimWithoutDbCheck('counts must match the database exactly', steps, false),
      'no-schema',
    );
    // A claim with no DB comparison never fires.
    assert.equal(dbClaimWithoutDbCheck('the table renders its rows', steps, true), false);
  });

  it('loginProofAssertsLoginPage flags a post-submit expectUrl of the sign-in path itself', () => {
    const login: FlowStep[] = [
      { action: 'goto', url: '/en/login' },
      { action: 'fill', selector: 'input[type=email]', value: 'a@b.c', intent: 'email' },
      { action: 'fill', selector: 'input[type=password]', value: 'pw', intent: 'password' },
      { action: 'click', selector: 'role=button[name="Sign in" i]' },
    ];
    assert.equal(
      loginProofAssertsLoginPage([
        ...login,
        { action: 'expectUrl', value: '/en/login', intent: 'redirected away (sic)' },
      ]),
      4,
    );
    assert.equal(
      loginProofAssertsLoginPage([
        ...login,
        { action: 'expectUrl', value: '/en/admin', intent: 'redirected away' },
      ]),
      null,
    );
  });

  it('normalizes the non-breaking hyphen a model typesets into ids', async () => {
    const model = new LlmFlowAuthorModel({
      model: jsonModel(
        'mock-author',
        {
          name: 'hyphens',
          rationale: '',
          setup: [],
          steps: [
            {
              action: 'expectVisible',
              selector: 'text=RULE‑FUEL‑002',
              value: '',
              url: '',
              key: '',
              name: '',
              intent: 'the fuel rule renders',
            },
          ],
          teardown: [],
          notes: '',
        },
        { inputTokens: 0, outputTokens: 0 },
      ),
      id: 'mock:author',
    });
    const result = await model.author({ prompt: 'check the fuel rule' });
    assert.deepEqual(result.steps[0], {
      action: 'expectVisible',
      selector: 'text=RULE-FUEL-002',
      intent: 'the fuel rule renders',
    });
  });
});


/**
 * The three lints written from a hand-authored flow that was run against a
 * real application until it passed. Each refuses a shape that costs a run
 * something real, and each names the measurement in its own doc comment.
 */
describe('countPinnedName', () => {
  it('refuses a live count pinned inside an accessible name', () => {
    const steps: FlowStep[] = [
      { action: 'expectVisible', selector: 'role=tab[name="Status (1)" i]' },
    ];
    assert.deepEqual(countPinnedName(steps), { index: 0, name: 'Status (1)' });
  });

  it('leaves a name that merely contains a number alone', () => {
    // "OT Day 1" and "Step 2 of 4" are identities, not counts. Only the
    // trailing parenthesised form is the count idiom.
    const steps: FlowStep[] = [
      { action: 'fill', selector: 'role=textbox[name="Start date OT day 1" i]', value: '2026-08-18' },
      { action: 'click', selector: 'role=button[name="Step 2 of 4" i]' },
      { action: 'click', selector: 'role=tab >> text=Status' },
    ];
    assert.equal(countPinnedName(steps), null);
  });
});

describe('volatileCountAssertion', () => {
  it('refuses a bare number read off the tree that the request never states', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: '/en/admin/benefits/plans' },
      { action: 'expectVisible', selector: 'text="75"' },
    ];
    assert.deepEqual(
      volatileCountAssertion(steps, 'ตรวจสอบจำนวน Total plans ปัจจุบัน'),
      { index: 1, value: '75' },
    );
  });

  it('a number the request itself states is the claim, and stands', () => {
    // The sheet's word is the claim — refusing it would untest the case.
    const steps: FlowStep[] = [{ action: 'expectText', selector: 'role=status', value: '120' }];
    assert.equal(volatileCountAssertion(steps, 'the days-remaining tile shows 120'), null);
  });

  it('ignores expectCount, labeled text, and non-expect steps', () => {
    const steps: FlowStep[] = [
      { action: 'expectCount', selector: 'role=row', count: 15 } as unknown as FlowStep,
      { action: 'expectVisible', selector: 'text=Total plans' },
      { action: 'fill', selector: 'role=textbox[name="Amount" i]', value: '500' },
      { action: 'expectText', selector: 'role=heading', value: 'Benefit Plan Catalog' },
    ];
    assert.equal(volatileCountAssertion(steps, 'check the catalog'), null);
  });

  it('catches the unquoted selector form too', () => {
    const steps: FlowStep[] = [{ action: 'expectVisible', selector: 'text=68' }];
    assert.deepEqual(volatileCountAssertion(steps, 'reimbursement tile is present'), {
      index: 0,
      value: '68',
    });
  });
});

describe('interruptedCredentialSubmit', () => {
  const fillEmail: FlowStep = { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'a@b.test' };
  const fillPassword: FlowStep = { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw', intent: 'password' };
  const submit: FlowStep = { action: 'click', selector: 'role=button[name="Sign in" i]' };

  it('refuses an assertion wedged between the credentials and the submit', () => {
    // Measured: one expectValue in this gap stopped the hydration replay from
    // firing and the login stopped working entirely.
    const steps: FlowStep[] = [
      fillEmail,
      fillPassword,
      { action: 'expectValue', selector: 'role=textbox >> nth=1', value: 'pw' },
      submit,
    ];
    assert.deepEqual(interruptedCredentialSubmit(steps), { index: 2, click: 3 });
  });

  it('accepts the adjacent form the engine can replay', () => {
    const steps: FlowStep[] = [
      fillEmail,
      fillPassword,
      submit,
      { action: 'expectUrl', value: '/en/home' },
    ];
    assert.equal(interruptedCredentialSubmit(steps), null);
  });

  it('does not fire when no click follows before the next navigation', () => {
    const steps: FlowStep[] = [
      fillEmail,
      fillPassword,
      { action: 'expectVisible', selector: 'role=button[name="Sign in" i]' },
      { action: 'goto', url: '/en/home' },
    ];
    assert.equal(interruptedCredentialSubmit(steps), null);
  });
});

describe('unpinnedDateEntry', () => {
  const typesADate: FlowStep[] = [
    { action: 'fill', selector: '[data-testid="ot-start-date-0"]', value: '2026-08-18' },
  ];

  it('refuses a typed date when no clock is pinned', () => {
    assert.deepEqual(unpinnedDateEntry([], typesADate), { index: 0, value: '2026-08-18' });
  });

  it('accepts it once setup pins the clock', () => {
    const setup: FlowStep[] = [{ action: 'setClock', time: '2026-08-18T09:00:00Z' }];
    assert.equal(unpinnedDateEntry(setup, typesADate), null);
  });

  it('says nothing about a value that is not a date', () => {
    const steps: FlowStep[] = [
      { action: 'fill', selector: 'textarea', value: 'covering the 2026-08 close' },
      { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'a@b.test' },
    ];
    assert.equal(unpinnedDateEntry([], steps), null);
  });
});


describe('unsettledWorkflowClaim', () => {
  const workflow: FlowStep = { action: 'workflow', goal: 'submit the overtime request' };

  it('refuses an agent leg that only an expectUrl follows', () => {
    // Measured: teaching the author not to claim a database it has no evidence
    // for correctly deleted an unfounded expectDbDelta — and left the flow
    // ending on expectUrl "/en", which passes whether or not anything was
    // submitted. Removing a wrong check is not an improvement by itself.
    const steps: FlowStep[] = [workflow, { action: 'expectUrl', value: '/en' }];
    assert.equal(unsettledWorkflowClaim(steps), 0);
  });

  it('accepts one settled by what the page shows', () => {
    const steps: FlowStep[] = [
      workflow,
      { action: 'expectText', selector: 'role=list', value: 'wowlidator evidence run' },
    ];
    assert.equal(unsettledWorkflowClaim(steps), null);
  });

  it('accepts one settled by the database', () => {
    const steps: FlowStep[] = [
      workflow,
      { action: 'expectDbDelta', table: 'ot_request', delta: 1, since: 'before' },
    ];
    assert.equal(unsettledWorkflowClaim(steps), null);
  });

  it('says nothing about a flow with no agent leg', () => {
    assert.equal(unsettledWorkflowClaim([{ action: 'expectUrl', value: '/en' }]), null);
  });
});


describe('loginProofCannotFail', () => {
  const signIn = (proof: string): FlowStep[] => [
    { action: 'goto', url: 'http://localhost:3200/en/login' },
    { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'a@b.test' },
    { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw', intent: 'password' },
    { action: 'click', selector: 'role=button[name="Sign in" i]' },
    { action: 'expectUrl', value: proof },
  ];

  it('refuses a proof the login page itself satisfies', () => {
    // The one that shipped: "/en/login" contains "/en", so this passes exactly
    // as well when the sign-in was rejected. Measured — an authored flow with
    // an invented password reported 12/12 passed on the strength of it.
    assert.deepEqual(loginProofCannotFail(signIn('/en')), {
      index: 4,
      expected: '/en',
      loginUrl: 'http://localhost:3200/en/login',
    });
  });

  it('accepts a path the login page does not contain', () => {
    assert.equal(loginProofCannotFail(signIn('/en/home')), null);
  });

  it('says nothing when the proof is not a URL check at all', () => {
    const steps = [...signIn('/en/home').slice(0, 4), {
      action: 'expectVisible' as const,
      selector: 'role=button[name="Sign out" i]',
    }];
    assert.equal(loginProofCannotFail(steps), null);
  });

  it('says nothing about an expectUrl that follows no sign-in', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/overtime' },
      { action: 'expectUrl', value: '/en' },
    ];
    assert.equal(loginProofCannotFail(steps), null);
  });
});


/**
 * The account an authored flow signs in as.
 *
 * Measured over nine authoring runs: with nothing in the prompt to say
 * otherwise, the model invented a password nine times out of nine. One run
 * died on "Sign-in failed with 'Incorrect password'"; a worse one reported
 * 12/12 passed, having failed the login and finished the journey on a session
 * an earlier run had left behind. So the credentials must reach the wire, as
 * their own block, and their absence must change nothing.
 */
describe('supplied credentials reach the model as their own labelled block', () => {
  function recordingModel() {
    const mock = jsonModel(
      'mock-author',
      { name: 'x', rationale: '', setup: [], steps: [], teardown: [], notes: '' },
      { inputTokens: 0, outputTokens: 0 },
    );
    const call = () =>
      (mock as unknown as { doGenerateCalls: { prompt: { role: string; content: unknown }[] }[] })
        .doGenerateCalls[0] ?? { prompt: [] };
    return {
      mock,
      model: new LlmFlowAuthorModel({ model: mock, id: 'mock:author' }),
      /** The whole call — system prompt included. */
      full: () => JSON.stringify(call()),
      /**
       * Just the user message. The system prompt names the section so the
       * model knows what to do with it, so a whole-call check could never tell
       * "the section was sent" from "the rule that mentions it was sent".
       */
      user: () => JSON.stringify(call().prompt.filter((part) => part.role !== 'system')),
    };
  }

  it('sends them verbatim, apart from the tree, with the never-invent rule', async () => {
    const { model, user, full } = recordingModel();
    await model.author({
      prompt: 'submit an overtime request',
      policy: 'forms',
      axTree: 'button "Sign in"',
      credentials: { email: 'employee@cnext.test', password: 'employee2026' },
    });
    const wire = user().replace(/\\n/g, ' ').replace(/\s+/g, ' ');

    assert.match(wire, /SIGN IN AS/, 'its own labelled section, like the tables and the repo index');
    assert.match(wire, /employee@cnext\.test/);
    assert.match(wire, /employee2026/, 'the password must arrive unaltered or it cannot be used');
    assert.match(wire, /use these characters exactly/i);
    assert.match(
      full().replace(/\\n/g, ' ').replace(/\s+/g, ' '),
      /never a variation and never an invention/i,
      'and the system prompt forbids improving on them',
    );
  });

  it('keeps a password with colons in it whole', async () => {
    // The reason `parseCredentials` splits on the FIRST colon: truncating here
    // would hand the model a password that is wrong in a way nothing catches
    // until the sign-in fails.
    const { model, user } = recordingModel();
    await model.author({
      prompt: 'sign in',
      policy: 'forms',
      credentials: { email: 'a@b.test', password: 'p:a:ss' },
    });
    assert.match(user(), /p:a:ss/);
  });

  it('changes nothing at all when none were supplied', async () => {
    // The `projectGraph` contract: omit it and the prompt is byte-for-byte
    // what it was before this existed.
    const request = { prompt: 'submit an overtime request', policy: 'forms' as const, axTree: 'button "Sign in"' };
    const bare = recordingModel();
    await bare.model.author({ ...request });
    const explicitlyNone = recordingModel();
    await explicitlyNone.model.author({ ...request, credentials: undefined });

    assert.equal(explicitlyNone.user(), bare.user());
    assert.equal(explicitlyNone.full(), bare.full(), 'the system prompt does not move either');
    assert.doesNotMatch(bare.user(), /SIGN IN AS/);
  });

  it('forwards what the FlowAuthor was constructed with', async () => {
    const model = stubModel({
      steps: [{ action: 'expectVisible', selector: 'role=table', intent: 'the table' }],
    });
    const author = new FlowAuthor({
      model,
      credentials: { email: 'employee@cnext.test', password: 'employee2026' },
    });
    await author.author('check the table renders');
    assert.deepEqual(model.seen?.credentials, {
      email: 'employee@cnext.test',
      password: 'employee2026',
    });
  });
});

/**
 * The journey tree — the page the DESCRIPTION is about, not the page the run
 * starts on.
 *
 * It exists because the start page is so often a login screen that the
 * journey's real controls were structurally invisible: 9 of 9 measured
 * authoring runs delegated the middle of the test to a `workflow` step. The
 * risk it introduces is mislabelling, so what these pin is the separation, not
 * the content.
 */
describe('a further page reaches the model as its own labelled section', () => {
  function recordingModel() {
    const mock = jsonModel(
      'mock-author',
      { name: 'x', rationale: '', setup: [], steps: [], teardown: [], notes: '' },
      { inputTokens: 0, outputTokens: 0 },
    );
    const call = () =>
      (mock as unknown as { doGenerateCalls: { prompt: { role: string; content: unknown }[] }[] })
        .doGenerateCalls[0] ?? { prompt: [] };
    return {
      model: new LlmFlowAuthorModel({ model: mock, id: 'mock:author' }),
      user: () => JSON.stringify(call().prompt.filter((part) => part.role !== 'system')),
    };
  }

  const base = {
    prompt: 'log in, then create an overtime request',
    policy: 'forms' as const,
    axTree: 'RootWebArea "Sign in"\nbutton "Sign in"',
  };

  it('keeps it apart from the start page tree, and says which page it is', async () => {
    const { model, user } = recordingModel();
    await model.author({
      ...base,
      journeyTree: 'ANOTHER PAGE IN THIS JOURNEY — the accessibility tree of http://app.test/en/overtime, which the request describes. It is NOT the page this run starts on.\n\nbutton "Submit"',
    });
    const wire = user().replace(/\\n/g, ' ').replace(/\s+/g, ' ');

    assert.match(wire, /Accessibility tree:/, 'the start page keeps its own heading');
    assert.match(wire, /ANOTHER PAGE IN THIS JOURNEY/);
    assert.match(wire, /http:\/\/app\.test\/en\/overtime/, 'the section names the page it read');
    assert.match(wire, /NOT the page this run starts on/);

    // Order is part of the separation: the start page's tree is what the early
    // steps are written against, so it must not be buried under a second one.
    assert.ok(
      wire.indexOf('Accessibility tree:') < wire.indexOf('ANOTHER PAGE IN THIS JOURNEY'),
      'the start page tree comes first',
    );
  });

  it('changes nothing at all when there is no second page', async () => {
    const withNone = recordingModel();
    await withNone.model.author(base);
    const explicitlyNone = recordingModel();
    await explicitlyNone.model.author({ ...base, journeyTree: undefined });

    assert.equal(explicitlyNone.user(), withNone.user());
    assert.doesNotMatch(withNone.user(), /ANOTHER PAGE/);
  });

  it('is forwarded by FlowAuthor from what it was constructed with', async () => {
    const { model, user } = recordingModel();
    const author = new FlowAuthor({
      model,
      journeyTree: 'ANOTHER PAGE IN THIS JOURNEY — tree of http://app.test/en/leave\n\nbutton "Apply"',
    });
    await author.author('submit a leave request').catch(() => undefined);
    assert.match(user(), /app\.test\/en\/leave/);
  });
});

/**
 * What happens when the attempt budget runs out.
 *
 * The lint set grew (count-pinned names, interrupted credential submits,
 * unpinned dates, vacuous login proofs, the CLI's DB-inventory gate) and the
 * measured cost was a prompt ending with NO flow at all — run B3, refused for
 * "contains no assertion" in 1 of 2 attempts, because removing the model's
 * easiest assertion left it nothing and there was one ask left to recover in.
 * These pin the two halves of the fix: more room to recover, and a thin answer
 * kept rather than thrown away.
 */
describe('best-attempt-wins across the authoring budget', () => {
  /** A model that answers differently on each attempt, and counts them. */
  function scripted(answers: Partial<AuthorResult>[]): FlowAuthorModel & { calls: number } {
    const model: FlowAuthorModel & { calls: number } = {
      id: 'scripted:author',
      calls: 0,
      async author() {
        const answer = answers[Math.min(model.calls, answers.length - 1)] ?? {};
        model.calls += 1;
        return {
          name: 'scripted flow',
          rationale: '',
          setup: [],
          steps: [],
          teardown: [],
          notes: '',
          droppedSteps: 0,
          ...answer,
        };
      },
    };
    return model;
  }

  /**
   * Refused as WEAK: an agent leg that nothing but a URL check follows. The
   * heading check in front of it is what keeps the flow a claim at all — a
   * flow whose ONLY assertions are a URL (or the sign-in proof) is the
   * vacuous shape, refused as fatal below, never accepted as thin.
   */
  const thin: Partial<AuthorResult> = {
    steps: [
      { action: 'expectVisible', selector: 'role=heading[name="Overtime"]' },
      { action: 'workflow', goal: 'submit the overtime request' },
      { action: 'expectUrl', value: '/en/overtime' },
    ],
  };

  it('accepts a thin flow at once, with the note, rather than re-asking', async () => {
    // A weak-only refusal used to spend the whole re-ask budget and then take
    // the first answer anyway — measured, the model could not see the page the
    // workflow leg ends on and came back with the same leg every time. Now the
    // workflow step records the page before and after the agent acted, so the
    // thin flow is accepted on the first call and the thinness is on `notes`.
    const model = scripted([thin, { steps: [{ action: 'click', selector: 'role=button' }] }]);
    const authored = await new FlowAuthor({ model }).author('submit an overtime request');

    assert.equal(model.calls, 1, 'a weak-only refusal costs one call, not the budget');
    assert.equal(authored.flow.steps.length, 3, 'the thin answer is kept');
    assert.match(
      authored.notes,
      /nothing checks what it did/,
      'and what it does not prove is recorded, not silently accepted',
    );
  });

  it('still refuses outright when every attempt was false rather than thin', async () => {
    // No assertion anywhere is a claim that cannot fail, and emitting it is
    // worse than emitting nothing — the one thing leniency must never reach.
    const model = scripted([{ steps: [{ action: 'click', selector: 'role=button' }] }]);
    await assert.rejects(
      new FlowAuthor({ model }).author('click the button'),
      (error: unknown) => error instanceof AuthoringError && /no assertion/.test((error as Error).message),
    );
    // The same fatal refusal twice ends the budget early (2026-09-04).
    assert.equal(model.calls, 2);
  });

  it('stops asking the moment an answer passes every lint', async () => {
    const model = scripted([
      { steps: [{ action: 'expectVisible', selector: 'role=heading[name="Overtime"]' }] },
    ]);
    const authored = await new FlowAuthor({ model }).author('check the overtime page');
    assert.equal(model.calls, 1, 'a clean answer costs one call, not the whole budget');
    assert.equal(authored.notes, '');
  });

  it('a weak refusal alongside a fatal one still refuses and re-asks', async () => {
    // Leniency is for thinness only. A flow that is thin AND says something
    // untrue (here: no assertion at all is fatal) goes back to the model with
    // both complaints, and the thin-but-true answer wins the budget.
    const model = scripted([
      { steps: [{ action: 'workflow', goal: 'submit it' }, { action: 'click', selector: 'role=button' }] },
      thin,
    ]);
    const authored = await new FlowAuthor({ model }).author('submit an overtime request');
    assert.equal(model.calls, 2, 'the fatal first answer is re-asked; the thin second is accepted');
    assert.equal(authored.flow.steps.length, 3);
    assert.match(authored.notes, /nothing checks what it did/);
  });

  it("refuses be100's vacuous shape outright: a workflow leg followed only by a URL check", async () => {
    // Measured, 2026-08-21: 20 of 22 `pass**` cases were login + goto +
    // workflow + expectUrl — green about rows whose Expected Output they never
    // touched. That shape is fatal through the whole budget; the case is
    // blocked and re-authored on a resume, never handed over.
    const model = scripted([
      {
        steps: [
          { action: 'workflow', goal: 'open the Type filter' },
          { action: 'expectUrl', value: '/en/admin/benefits/plans' },
        ],
      },
    ]);
    await assert.rejects(
      new FlowAuthor({ model }).author('PL_04_05 the Type filter lists Record and Reimbursement'),
      (error: unknown) => error instanceof AuthoringError && /proves nothing about its claim/.test((error as Error).message),
    );
    // Asked again once with the reason; the identical second refusal ends the
    // budget early (2026-09-04) — the case is blocked either way.
    assert.equal(model.calls, 2, 'asked again with the reason, then not a third time');
  });
});

describe('the system prompt teaches that a captured second page is not absent', () => {
  it('names the ANOTHER PAGE IN THIS JOURNEY section as a source of grounded steps', async () => {
    // 9 of 9 measured authoring runs delegated the middle of the journey to a
    // workflow step, and the last one said why in its own notes: the later
    // pages "are absent from the initial login accessibility tree". Once
    // `--capture-journey` puts one of those pages IN the prompt, the workflow
    // guidance has to stop reading as licence to delegate anyway.
    const mock = jsonModel(
      'mock-author',
      { name: 'x', rationale: '', setup: [], steps: [], teardown: [], notes: '' },
      { inputTokens: 0, outputTokens: 0 },
    );
    const model = new LlmFlowAuthorModel({ model: mock, id: 'mock:author' });
    await model.author({ prompt: 'submit overtime', policy: 'forms', axTree: 'button "Sign in"' });

    const sent = JSON.stringify(
      (mock as unknown as { doGenerateCalls: unknown[] }).doGenerateCalls[0],
    )
      .replace(/\\n/g, ' ')
      .replace(/\s+/g, ' ');
    assert.match(sent, /ANOTHER PAGE IN THIS JOURNEY is present, that page is captured/);
    assert.match(sent, /write grounded steps against it/);
  });
});


/**
 * The journey capture's sign-in: the decision to act, and the account of why
 * it declined to. The DOM half is browser-tier and has no fixture here — what
 * is unit-testable is the predicate that decides whether a login is attempted
 * at all, and the wording a person reads when it gives up. Both are pure, and
 * both are the parts that must not be got wrong: one guards a click on
 * someone's application, the other is the only record that a click happened.
 */
describe('a tree-notation selector is rewritten, not shipped', () => {
  it('turns StaticText[text="…"] into the text engine', async () => {
    // glm-4.5-flash writes the AX tree's own notation as a selector; as CSS it
    // matches a tag named StaticText, i.e. nothing, ever.
    const model = new LlmFlowAuthorModel({
      model: jsonModel('m', {
        name: 'f', rationale: '', notes: '',
        setup: [], teardown: [],
        steps: [
          { action: 'expectText', case: null, selector: 'StaticText[text="20 Jul 2026"]', value: '20 Jul 2026', url: '', key: '', name: '', intent: 'read the hire date' },
        ],
      }, { inputTokens: 0, outputTokens: 0 }),
      id: 'mock:author',
    });
    const result = await model.author({ prompt: 'x', policy: 'forms' });
    assert.deepEqual(result.steps[0], {
      action: 'expectText',
      selector: 'text="20 Jul 2026"',
      value: '20 Jul 2026',
      intent: 'read the hire date',
    });
  });
});

describe('fromTreeNotation', () => {
  it('reads single quotes too, and the DOM-attribute spellings of a name', () => {
    // A 7B model's whole catalog, 2026-08-21: every selector a guaranteed miss.
    assert.equal(fromTreeNotation("StaticText[text='HR']"), 'text="HR"');
    assert.equal(fromTreeNotation("textbox[placeholder='Work email']"), 'input[placeholder="Work email"]');
    assert.equal(fromTreeNotation("role=textbox[placeholder='Work email']"), 'input[placeholder="Work email"]');
    assert.equal(fromTreeNotation("heading[title='Benefit Plan Catalog']"), 'role=heading[name="Benefit Plan Catalog"]');
    assert.equal(fromTreeNotation("role=button[aria-label='Menu']"), 'role=button[name="Menu"]');
    // A real CSS selector is never touched.
    assert.equal(fromTreeNotation("input[placeholder='x']"), "input[placeholder='x']");
    assert.equal(fromTreeNotation('.card[title="x"]'), '.card[title="x"]');
  });
  it('rewrites each tree-notation shape to real selector syntax', () => {
    assert.equal(fromTreeNotation('StaticText[text="20 Jul 2026"]'), 'text="20 Jul 2026"');
    assert.equal(
      fromTreeNotation('role=link[url*="/en/workflows/probation/PB-002"]'),
      'a[href*="/en/workflows/probation/PB-002"]',
    );
    assert.equal(fromTreeNotation('role=cell[text="Somchai Sukjai"]'), 'role=cell[name="Somchai Sukjai"]');
  });

  it('carries a chained tail through the rewrite', () => {
    assert.equal(
      fromTreeNotation('role=link[text="Review"] >> nth=0'),
      'role=link[name="Review"] >> nth=0',
    );
  });

  it('leaves real selectors exactly as written', () => {
    for (const sel of ['role=button[name="Sign in" i]', 'text="extended"', 'a[href*="/x"]', '.card > span']) {
      assert.equal(fromTreeNotation(sel), sel);
    }
  });
});

describe('an absence check on a bare word is quoted, not shipped', () => {
  it('narrows expectHidden text=extended to the exact form', async () => {
    const model = new LlmFlowAuthorModel({
      model: jsonModel('m', {
        name: 'f', rationale: '', notes: '', setup: [], teardown: [],
        steps: [
          { action: 'expectHidden', case: null, selector: 'text=extended', value: '', url: '', key: '', name: '', intent: 'raw code must not leak' },
          { action: 'expectHidden', case: null, selector: 'text=pending_hr', value: '', url: '', key: '', name: '', intent: 'raw code must not leak' },
        ],
      }, { inputTokens: 0, outputTokens: 0 }),
      id: 'mock:author',
    });
    const result = await model.author({ prompt: 'x', policy: 'forms' });
    assert.equal((result.steps[0] as { selector: string }).selector, 'text="extended"');
    // A snake_case token is safe either way and stays as written.
    assert.equal((result.steps[1] as { selector: string }).selector, 'text=pending_hr');
  });
});

describe('notEndToEnd counts a link click as travel', () => {
  it('a flow that navigates by clicking links is end-to-end', () => {
    assert.equal(
      notEndToEnd(
        [],
        [
          { action: 'click', selector: 'role=tab[name="Team" i]' },
          { action: 'click', selector: 'role=link[name="Probation Reviews" i]' },
          { action: 'expectVisible', selector: 'role=heading[name="Probation Reviews" i]' },
        ] as FlowStep[],
        'http://x.test/en/login',
      ),
      null,
    );
  });

  it('a flow that only clicks buttons on its start page still is not', () => {
    assert.equal(
      notEndToEnd(
        [],
        [{ action: 'click', selector: 'role=button[name="Next" i]' }] as FlowStep[],
        'http://x.test/en/login',
      ),
      'one-page',
    );
  });
});

describe('groundLoginProof', () => {
  const login = (proof: FlowStep): FlowStep[] => [
    { action: 'goto', url: 'http://x.test/en/login' },
    { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'a@b.test' },
    { action: 'click', selector: 'role=button[name="Next" i]' },
    { action: 'fill', selector: 'input[type="password"]', value: 'pw' },
    { action: 'click', selector: 'role=button[name="Sign in" i]' },
    proof,
  ];

  it('replaces a proof the sign-in URL already contains with the submit control gone', () => {
    const setup = login({ action: 'expectUrl', value: '/en/' });
    const note = groundLoginProof(setup, []);
    assert.match(note ?? '', /could not fail/);
    assert.deepEqual(setup[5], {
      action: 'expectHidden',
      selector: 'role=button[name="Sign in" i]',
      intent: 'the sign-in took: the submit control "role=button[name="Sign in" i]" is no longer on the page',
    });
    assert.equal(loginProofCannotFail(setup), null, 'and the lint no longer fires');
  });

  it('leaves a proof that can fail alone', () => {
    const setup = login({ action: 'expectUrl', value: '/en/admin/system' });
    assert.equal(groundLoginProof(setup, []), null);
    assert.equal(setup[5]?.action, 'expectUrl');
  });

  // Live: a sheet said "HR Admin", the shell renders "ผู้ดูแลระบบ HR", and
  // the model asserted text="HRIS ADMIN" — in no tree, not in the request.
  it('replaces a text proof that quotes what nothing showed', () => {
    const setup = login({ action: 'expectVisible', selector: 'text="HRIS ADMIN"' });
    const note = groundLoginProof(setup, [], 'button "ผู้ดูแลระบบ HR"\nSign in as the HR Admin');
    assert.match(note ?? '', /appears in no tree/);
    assert.equal(setup[5]?.action, 'expectHidden');
  });

  it('keeps a text proof the tree or the request grounds', () => {
    const setup = login({ action: 'expectVisible', selector: 'text="ผู้ดูแลระบบ HR"' });
    assert.equal(groundLoginProof(setup, [], 'button "ผู้ดูแลระบบ HR"'), null);
    assert.equal(setup[5]?.action, 'expectVisible');
  });

  it('looks past the consent gate for the proof', () => {
    const setup = login({ action: 'when', visible: 'role=button[name="Accept and continue" i]', then: [] } as unknown as FlowStep);
    setup.push({ action: 'expectUrl', value: '/en/' });
    assert.match(groundLoginProof(setup, []) ?? '', /could not fail/);
    assert.equal(setup[6]?.action, 'expectHidden');
  });
});

// PL_02_02, live (2026-08-20): setup asserted `expectVisible
// text="admin@cnext.test"` — the very email the flow had just typed — against
// an identity plate that renders a display name, role label and user id and
// never the email. 42 seconds of ladder, patience, healer ("does not appear
// anywhere in the accessibility tree") and reconstruction to disprove a
// string that was input, not output; then a high defect against a working
// application. A check generated out of the scope of the test is re-judged
// for necessity: dropped when the claim's own assertions carry the proof,
// refused with the informed re-ask when it is all the proof there is.
describe('credential echo assertions', () => {
  const signIn: FlowStep[] = [
    { action: 'goto', url: 'http://x.test/en/login' },
    { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'admin@cnext.test' },
    { action: 'click', selector: 'role=button[name="Next" i]' },
    { action: 'fill', selector: 'input[type="password"]', value: 'admin2026' },
    { action: 'click', selector: 'role=button[name="Sign in" i]' },
    { action: 'expectHidden', selector: 'role=button[name="Sign in" i]' },
    { action: 'goto', url: '/en/admin/benefits/plans' },
  ];

  it('collects the values typed on a sign-in page, email and password alike', () => {
    assert.deepEqual(typedCredentialValues(signIn, []), ['admin@cnext.test', 'admin2026']);
  });

  it('does not treat a business-form fill as a credential', () => {
    const body: FlowStep[] = [
      { action: 'goto', url: 'http://x.test/en/employees' },
      { action: 'fill', selector: 'role=textbox[name="Manager email" i]', value: 'boss@cnext.test' },
    ];
    assert.deepEqual(typedCredentialValues([], body), []);
  });

  it('flags the PL_02_02 shape: expectVisible of the typed email', () => {
    const setup: FlowStep[] = [
      ...signIn,
      { action: 'expectVisible', selector: 'text="admin@cnext.test"' },
    ];
    const typed = typedCredentialValues(setup, []);
    assert.deepEqual(credentialEchoAssertions(setup, typed), [7]);
  });

  it('a tree that really renders the value rescues the assertion', () => {
    const setup: FlowStep[] = [
      ...signIn,
      { action: 'expectVisible', selector: 'text="admin@cnext.test"' },
    ];
    const typed = typedCredentialValues(setup, []);
    const tree = 'StaticText "Signed in as admin@cnext.test"';
    assert.deepEqual(credentialEchoAssertions(setup, typed, tree), []);
  });

  it('never flags expectHidden — a credential NOT displayed is a legitimate claim', () => {
    const steps: FlowStep[] = [{ action: 'expectHidden', selector: 'text="admin2026"' }];
    const typed = typedCredentialValues(signIn, steps);
    assert.deepEqual(credentialEchoAssertions(steps, typed), []);
  });

  it('flags an expectText whose value echoes the credential', () => {
    const steps: FlowStep[] = [
      { action: 'expectText', selector: 'body', value: 'admin@cnext.test' },
    ];
    const typed = typedCredentialValues(signIn, steps);
    assert.deepEqual(credentialEchoAssertions(steps, typed), [0]);
  });

  it('flags nothing when no credential was typed', () => {
    const steps: FlowStep[] = [{ action: 'expectVisible', selector: 'text="admin@cnext.test"' }];
    assert.deepEqual(credentialEchoAssertions(steps, []), []);
  });

  it('the pipeline drops the echo when the claim’s own assertions carry the proof', async () => {
    const author = new FlowAuthor({
      model: stubModel({
        name: 'PL_02_02 Benefit Plan Catalog wording',
        setup: [
          ...signIn,
          { action: 'expectVisible', selector: 'text="admin@cnext.test"', intent: 'user email shown in chrome' },
        ],
        steps: [
          { action: 'expectVisible', selector: 'role=heading[name="Benefit Plans" i]', intent: 'the title' },
          { action: 'expectVisible', selector: 'text="Benefits Admin"', intent: 'the breadcrumb' },
        ],
      }),
    });
    const authored = await author.author('check the Benefit Plan Catalog wording matches the spec');
    assert.equal(authored.flow.setup?.length, signIn.length, 'the echo left setup');
    assert.equal(
      authored.flow.setup?.some((s) => JSON.stringify(s).includes('admin@cnext.test') && s.action.startsWith('expect')),
      false,
    );
    assert.equal(authored.flow.steps.length, 2, 'the claim’s own assertions are untouched');
    assert.match(authored.notes, /out-of-scope check/);
  });

  it('the pipeline refuses when the echo is all the proof there is', async () => {
    const author = new FlowAuthor({
      model: stubModel({
        name: 'who am i',
        setup: [],
        steps: [
          // The sign-in block WITHOUT its expectHidden proof: the echo is the
          // only assertion anywhere, so dropping it would leave a flow that
          // proves nothing — the informed re-ask is the honest outcome.
          ...signIn.filter((s) => s.action !== 'expectHidden'),
          { action: 'expectVisible', selector: 'text="admin@cnext.test"', intent: 'user email shown' },
        ],
      }),
    });
    await assert.rejects(
      () => author.author('check the signed-in user'),
      (error: unknown) =>
        error instanceof AuthoringError && /credential .*input, not expected output/.test((error as Error).message),
    );
  });
});

// A flow that signs in as two different people is an end-to-end journey
// across the application's session machinery, and every switch must travel
// the app's own sign-out path — never fill a login form while signed in
// (the app hides it), never fake the switch with clearStorage (a
// cookie-backed session survives the wipe).
describe('persona switches', () => {
  const loginAs = (email: string, password: string): FlowStep[] => [
    { action: 'goto', url: 'http://x.test/en/login' },
    { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: email },
    { action: 'click', selector: 'role=button[name="Next" i]' },
    { action: 'fill', selector: 'input[type="password"]', value: password },
    { action: 'click', selector: 'role=button[name="Sign in" i]' },
    { action: 'expectHidden', selector: 'role=button[name="Sign in" i]' },
  ];

  it('switchesPersona sees two identities across two sign-in segments', () => {
    const steps = [
      ...loginAs('admin@cnext.test', 'admin2026'),
      { action: 'goto', url: '/en/admin' } as FlowStep,
      ...loginAs('hrbp@cnext.test', 'hrbp2026'),
    ];
    assert.deepEqual(switchesPersona([], steps), ['admin@cnext.test', 'hrbp@cnext.test']);
  });

  it('one persona, even re-signed-in, is not a switch — and a business fill never counts', () => {
    const steps = [
      ...loginAs('admin@cnext.test', 'admin2026'),
      { action: 'goto', url: '/en/employees' } as FlowStep,
      { action: 'fill', selector: 'role=textbox[name="Manager email" i]', value: 'boss@cnext.test' } as FlowStep,
      ...loginAs('admin@cnext.test', 'admin2026'),
    ];
    assert.deepEqual(switchesPersona([], steps), ['admin@cnext.test']);
  });

  it('groundPersonaSwitches puts a signOut in front of the second sign-in goto', () => {
    const steps = [...loginAs('admin@cnext.test', 'a'), ...loginAs('hrbp@cnext.test', 'b')];
    const fixed = groundPersonaSwitches([], steps);
    assert.equal(fixed.inserted, 1);
    const at = fixed.steps.findIndex((s) => s.action === 'signOut');
    assert.equal(at, loginAs('x', 'y').length, 'immediately before the second login goto');
    assert.equal(fixed.steps[at + 1]?.action, 'goto');
  });

  it('a switch that already signs out is left alone', () => {
    const steps = [
      ...loginAs('admin@cnext.test', 'a'),
      { action: 'signOut' } as FlowStep,
      ...loginAs('hrbp@cnext.test', 'b'),
    ];
    assert.equal(groundPersonaSwitches([], steps).inserted, 0);
  });

  it('a setup identity counts as the previous persona for the body', () => {
    const fixed = groundPersonaSwitches(loginAs('admin@cnext.test', 'a'), loginAs('hrbp@cnext.test', 'b'));
    assert.equal(fixed.inserted, 1);
    assert.equal(fixed.steps[0]?.action, 'signOut');
  });

  it('the pipeline marks the flow e2e, inserts the signOut, and says so', async () => {
    const author = new FlowAuthor({
      model: stubModel({
        name: 'admin creates, hrbp approves',
        steps: [
          ...loginAs('admin@cnext.test', 'a'),
          ...loginAs('hrbp@cnext.test', 'b'),
          { action: 'expectVisible', selector: 'role=heading[name="Approvals" i]', intent: 'the queue' },
        ],
      }),
    });
    const authored = await author.author('admin creates a request, then the HRBP approves it');
    assert.equal(authored.flow.scope, 'e2e');
    assert.equal(authored.flow.steps.filter((s) => s.action === 'signOut').length, 1);
    assert.match(authored.notes, /signOut step\(s\) before persona switches/);
  });

  it('a single-persona flow is not marked e2e', async () => {
    const author = new FlowAuthor({
      model: stubModel({
        steps: [
          ...loginAs('admin@cnext.test', 'a'),
          { action: 'expectVisible', selector: 'role=heading[name="Plans" i]', intent: 'the page' },
        ],
      }),
    });
    const authored = await author.author('check the plans page');
    assert.equal(authored.flow.scope, undefined);
  });
});

describe('the journey capture reads where the request says it goes', () => {
  const start = 'http://localhost:3000/en/login';

  it('takes a URL the request names outright, on the run\'s own origin', () => {
    assert.deepEqual(
      literalDestinations(
        '2. Go to the probation screen for employee EMP-0005 (http://localhost:3000/en/admin/employees/EMP-0005/probation).',
        start,
      ),
      ['http://localhost:3000/en/admin/employees/EMP-0005/probation'],
    );
  });

  it('reads a bare path too, and never the sign-in, consent or API paths', () => {
    assert.deepEqual(
      literalDestinations(
        'open /en/workflows/probation; the login is /en/login; consent at /en/consent; seed via /api/db/seed',
        start,
      ),
      ['http://localhost:3000/en/workflows/probation'],
    );
  });

  it('ignores another origin — that page is not this application', () => {
    assert.deepEqual(literalDestinations('see https://docs.example.com/guide/x', start), []);
  });

  it('fills a route id from an id-shaped token in the request, and nothing else', () => {
    assert.equal(
      fillRouteIds('/:locale/admin/employees/:id/probation', 'the probation screen for employee EMP-0005'),
      '/:locale/admin/employees/EMP-0005/probation',
    );
    assert.equal(
      fillRouteIds('/:locale/admin/employees/:id/probation', 'the probation screen for the employee'),
      '/:locale/admin/employees/:id/probation',
      'an ordinary word is never substituted for an id',
    );
  });
});

describe('shouldSignInForCapture', () => {
  const credentials = { email: 'employee@cnext.test', password: 'employee2026' };

  it('signs in when credentials were supplied and the capture landed on a login page', () => {
    assert.equal(
      shouldSignInForCapture({
        landedUrl: 'http://localhost:3200/en/login',
        credentials,
        alreadyTried: false,
      }),
      true,
    );
  });

  it('never invents a login: no credentials, no attempt', () => {
    // --as / WOWLIDATOR_AS is the only source. Borrowing a value from anywhere
    // else would be this tool typing a password nobody handed it.
    assert.equal(
      shouldSignInForCapture({
        landedUrl: 'http://localhost:3200/en/login',
        credentials: undefined,
        alreadyTried: false,
      }),
      false,
    );
  });

  it('never tries twice', () => {
    // One attempt is the whole budget: a retry loop against an unfamiliar
    // login form is how an unattended tool locks an account.
    assert.equal(
      shouldSignInForCapture({
        landedUrl: 'http://localhost:3200/en/login',
        credentials,
        alreadyTried: true,
      }),
      false,
    );
  });

  it('does nothing on a page that is not a sign-in', () => {
    assert.equal(
      shouldSignInForCapture({
        landedUrl: 'http://localhost:3200/en/overtime',
        credentials,
        alreadyTried: false,
      }),
      false,
    );
  });
});

describe('journeyCaptureNote', () => {
  it('names the fix when there is no session', () => {
    const note = journeyCaptureNote({
      kind: 'no-session',
      target: 'http://localhost:3200/en/overtime',
      landed: 'http://localhost:3200/en/login',
    });
    assert.match(note, /--as <email>:<password>/, 'a dead end that does not name its fix is a dead end');
    assert.match(note, /sign-in page under another name/);
  });

  it('says plainly that nothing was clicked when the form could not be read', () => {
    const note = journeyCaptureNote({ kind: 'no-form-field', missing: 'no visible password field' });
    assert.match(note, /nothing was clicked/);
    assert.match(note, /no visible password field/);
  });

  it('reports a refused sign-in as refused, not as a missing page', () => {
    const note = journeyCaptureNote({
      kind: 'sign-in-refused',
      email: 'employee@cnext.test',
      landed: 'http://localhost:3200/en/login',
    });
    assert.match(note, /employee@cnext\.test/);
    assert.match(note, /credentials\s+were refused/);
  });
});


/**
 * `--scope e2e` is a promise, and the only way to keep one is to check it.
 * Both refused shapes below were produced by the live author this session.
 */
describe('notEndToEnd', () => {
  const START = 'http://localhost:3200/en/login';
  const signIn: FlowStep[] = [
    { action: 'goto', url: 'http://localhost:3200/en/login' },
    { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'a@b.test' },
    { action: 'click', selector: 'role=button[name="Sign in" i]' },
  ];

  it('refuses a flow that never leaves the page it starts on', () => {
    const steps: FlowStep[] = [
      { action: 'expectVisible', selector: 'role=heading[name="Sign in" i]' },
    ];
    assert.equal(notEndToEnd(signIn, steps, START), 'one-page');
  });

  it('accepts a flow that navigates to a second page', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/overtime' },
      { action: 'expectVisible', selector: 'role=heading[name="Overtime Requests" i]' },
    ];
    assert.equal(notEndToEnd(signIn, steps, START), null);
  });

  it('accepts travel proved by an expectUrl, which is how a CLICK navigates', () => {
    const steps: FlowStep[] = [
      { action: 'click', selector: 'a:has-text("OT request")' },
      { action: 'expectUrl', value: '/en/overtime' },
      { action: 'expectVisible', selector: 'role=heading[name="Overtime Requests" i]' },
    ];
    assert.equal(notEndToEnd(signIn, steps, START), null);
  });

  it('does not count the clearStorage reload as travel', () => {
    // goto login, clear, goto login again is two gotos to ONE page — the
    // known-state idiom, not a journey.
    const setup: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/login' },
      { action: 'clearStorage' },
      { action: 'goto', url: 'http://localhost:3200/en/login' },
    ];
    const steps: FlowStep[] = [{ action: 'expectVisible', selector: 'role=button[name="Sign in" i]' }];
    assert.equal(notEndToEnd(setup, steps, START), 'one-page');
  });

  it('does not count a query string as another page', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/login?next=%2Fen%2Fhome' },
      { action: 'expectVisible', selector: 'role=button[name="Sign in" i]' },
    ];
    assert.equal(notEndToEnd(signIn, steps, START), 'one-page');
  });

  it('names an agent-handled journey as its own failure', () => {
    // The exact degradation measured 9 times out of 9 before the journey
    // capture existed: the whole middle handed to the agent, settled by a URL.
    const steps: FlowStep[] = [
      { action: 'workflow', goal: 'go to overtime, submit a request, check the status list' },
      { action: 'expectUrl', value: '/en/login' },
    ];
    assert.equal(notEndToEnd(signIn, steps, START), 'agent-journey');
  });

  it('does not refuse a workflow leg inside a flow that really travels', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/overtime' },
      { action: 'workflow', goal: 'open the create dialog and submit it' },
      { action: 'expectText', selector: 'role=list', value: 'evidence run' },
    ];
    assert.equal(notEndToEnd(signIn, steps, START), null);
  });
});


/**
 * The scope reaches the model, and its absence changes nothing.
 *
 * The prompt half is a request; `notEndToEnd` and the forced journey capture
 * are the guarantee. All three are needed: the rules are what let the model
 * get it right on the first attempt instead of the third.
 */
describe('the test scope reaches the model', () => {
  function recordingModel() {
    const mock = jsonModel(
      'mock-author',
      { name: 'x', rationale: '', setup: [], steps: [], teardown: [], notes: '' },
      { inputTokens: 0, outputTokens: 0 },
    );
    const call = () =>
      (mock as unknown as { doGenerateCalls: { prompt: { role: string; content: unknown }[] }[] })
        .doGenerateCalls[0] ?? { prompt: [] };
    return {
      model: new LlmFlowAuthorModel({ model: mock, id: 'mock:author' }),
      full: () => JSON.stringify(call()).replace(/\\n/g, ' ').replace(/\s+/g, ' '),
    };
  }
  const request = { prompt: 'submit an overtime request', policy: 'forms' as const, axTree: 'button "Sign in"' };

  it('tells the model an e2e test must leave the page it starts on', async () => {
    const { model, full } = recordingModel();
    await model.author({ ...request, scope: 'e2e' });
    assert.match(full(), /<scope>END-TO-END/);
    assert.match(full(), /must leave the page it starts on/);
  });

  it('tells the model a unit test stays on one page', async () => {
    const { model, full } = recordingModel();
    await model.author({ ...request, scope: 'unit' });
    assert.match(full(), /<scope>UNIT/);
    assert.match(full(), /prove one thing on one page/);
  });

  it('changes nothing at all when no scope was given', async () => {
    // Every caller predating this feature passes none — the `projectGraph`
    // contract, applied again.
    const bare = recordingModel();
    await bare.model.author({ ...request });
    const explicitlyNone = recordingModel();
    await explicitlyNone.model.author({ ...request, scope: undefined });

    assert.equal(explicitlyNone.full(), bare.full());
    assert.doesNotMatch(bare.full(), /SCOPE:/);
  });
});


describe('expectUrl grounds against the routes the repository declares', () => {
  const TREE = 'RootWebArea "Login" url="http://localhost:3200/en/login"\nbutton "Sign in"';

  it('accepts a concrete path matching a declared route pattern', () => {
    // The false refusal this fixes: an --scope e2e run was refused for
    // expecting "/en/time", a route the repo declares as "/:locale/time",
    // reached by clicking a hub tile rather than by a goto — so neither the
    // tree nor the flow's own gotos could vouch for it. Three attempts, three
    // different lints, no flow at all.
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/login' },
      { action: 'expectUrl', value: '/en/time' },
    ];
    assert.notEqual(ungroundedUrlExpectation(steps, TREE), null, 'ungrounded without the graph');
    assert.equal(ungroundedUrlExpectation(steps, TREE, ['/:locale/time', '/:locale/overtime']), null);
  });

  it('accepts a bare fragment that appears in a declared pattern', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/login' },
      { action: 'expectUrl', value: 'overtime' },
    ];
    assert.equal(ungroundedUrlExpectation(steps, TREE, ['/:locale/overtime']), null);
  });

  it('still refuses a path no source vouches for', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/login' },
      { action: 'expectUrl', value: '/en/time-attendance' },
    ];
    assert.deepEqual(ungroundedUrlExpectation(steps, TREE, ['/:locale/time', '/:locale/overtime']), {
      index: 1,
      expected: '/en/time-attendance',
    });
  });
});


describe('duplicateCredentialSubmit', () => {
  const fillEmail: FlowStep = {
    action: 'fill',
    selector: 'input[type="email"]',
    value: 'admin@cnext.test',
  };
  const fillPassword: FlowStep = {
    action: 'fill',
    selector: 'input[type="password"]',
    value: 'admin2026',
  };
  const submit: FlowStep = { action: 'click', selector: 'role=button[name="Sign in" i]' };

  it('refuses a second submit click with nothing re-typed between', () => {
    // DB_02_01 verbatim: the model wrote a defensive retry. Once the engine's
    // own hydration replay makes the first click work, the second one has no
    // button to press and is filed as a defect against a healthy application.
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/login' },
      fillEmail,
      fillPassword,
      submit,
      { action: 'expectUrl', value: '/admin' },
      submit,
      { action: 'expectUrl', value: '/admin' },
    ];
    assert.deepEqual(duplicateCredentialSubmit(steps), {
      first: 3,
      repeat: 5,
      selector: 'role=button[name="Sign in" i]',
    });
  });

  it('accepts a single submit followed by ordinary steps', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/login' },
      fillEmail,
      fillPassword,
      submit,
      { action: 'expectUrl', value: '/admin' },
      { action: 'goto', url: 'http://localhost:3200/en/admin/benefits/plans' },
      { action: 'expectVisible', selector: 'text=BE-MED-001' },
    ];
    assert.equal(duplicateCredentialSubmit(steps), null);
  });

  it('accepts a persona switch that goes back to the sign-in page first', () => {
    // The documented legitimate shape: never switch user by re-filling the
    // form from another page — go back to the sign-in page. The goto is what
    // says the flow means it.
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/login' },
      fillEmail,
      fillPassword,
      submit,
      { action: 'expectUrl', value: '/admin' },
      { action: 'goto', url: 'http://localhost:3200/en/login' },
      { action: 'fill', selector: 'input[type="email"]', value: 'hrbp@cnext.test' },
      { action: 'fill', selector: 'input[type="password"]', value: 'hrbp2026' },
      submit,
    ];
    assert.equal(duplicateCredentialSubmit(steps), null);
  });

  it('accepts a genuine second attempt that re-types the credentials', () => {
    // What the engine's own replay emits. A re-fill is a real retry with real
    // input; only the bare re-click is the guaranteed-to-fail shape.
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/login' },
      fillEmail,
      fillPassword,
      submit,
      fillEmail,
      fillPassword,
      submit,
    ];
    assert.equal(duplicateCredentialSubmit(steps), null);
  });

  it('leaves a different control alone, even right after the submit', () => {
    // "Sign in with Microsoft" is a different path, and may be the point.
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/login' },
      fillEmail,
      fillPassword,
      submit,
      { action: 'click', selector: 'role=button[name="Sign in with Microsoft" i]' },
    ];
    assert.equal(duplicateCredentialSubmit(steps), null);
  });

  it('says nothing about repeated clicks that follow no credential fill', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: 'http://localhost:3200/en/admin/benefits/rules' },
      { action: 'click', selector: 'role=button[name="Refresh" i]' },
      { action: 'click', selector: 'role=button[name="Refresh" i]' },
    ];
    assert.equal(duplicateCredentialSubmit(steps), null);
  });
});


describe('dbClaimWithoutDbCheck names WHICH gap it found', () => {
  const claim = 'GET /api/db/health reports live counts that match the database exactly';
  const noDbSteps: FlowStep[] = [
    { action: 'request', method: 'GET', url: '/api/db/health' },
    { action: 'expectJson', path: '$.ok', value: 'true' },
  ];

  it('reports "unused" when tables were offered and none was used', () => {
    assert.equal(dbClaimWithoutDbCheck(claim, noDbSteps, true), 'unused');
  });

  it('reports "no-schema" when no inventory existed at all', () => {
    // The regression: this used to return false here and disarm the lint in
    // exactly the case where the loss is total — with no inventory
    // `toFlowStep` drops every DB step, so the claim degrades silently. Live
    // (DB_01_01): a run grounded in the wrong saved repo (0 table nodes)
    // reported a green pass having read no count.
    assert.equal(dbClaimWithoutDbCheck(claim, noDbSteps, false), 'no-schema');
  });

  it('is satisfied by an actual DB step', () => {
    const withDb: FlowStep[] = [
      ...noDbSteps,
      { action: 'expectDbRow', table: 'employee_center.person_information', where: {}, count: 98 },
    ];
    assert.equal(dbClaimWithoutDbCheck(claim, withDb, true), false);
    assert.equal(dbClaimWithoutDbCheck(claim, withDb, false), false);
  });

  it('says nothing about a claim that never mentions the database', () => {
    assert.equal(dbClaimWithoutDbCheck('the plans catalog lists every plan', noDbSteps, false), false);
  });
});

/**
 * Every complaint in one re-ask, not the first one only.
 *
 * The chain used to stop at the first lint that fired. With 16 fatal lints
 * against a 3-attempt budget that is a denial of service, not a quality gate:
 * measured on one prompt, a `--scope e2e` run was refused by three DIFFERENT
 * lints across its three attempts and produced no flow at all. These pin the
 * composition rule and the fact that the model is told everything at once.
 */
describe('composeRefusal', () => {
  const fatal = (message: string): Violation => ({ message, severity: 'fatal', note: message });
  const weak = (message: string, note: string): Violation => ({ message, severity: 'weak', note });

  it('leaves a lone complaint exactly as its lint wrote it', () => {
    // The common case must read and test identically to before this existed:
    // no wrapper, no numbering, no renaming.
    const only = fatal('the authored flow "x" pins a live count inside an accessible name');
    const error = composeRefusal([only]);
    assert.equal(error.message, only.message);
    assert.deepEqual(error.messages, [only.message]);
    assert.equal(error.severity, 'fatal');
  });

  it('names every problem when there is more than one', () => {
    const error = composeRefusal([fatal('problem one'), fatal('problem two'), fatal('problem three')]);
    assert.match(error.message, /3 problems/);
    assert.match(error.message, /fix all of them, not just the first/);
    for (const each of ['problem one', 'problem two', 'problem three']) {
      assert.match(error.message, new RegExp(each), `${each} must survive into the refusal`);
    }
    assert.deepEqual(error.messages, ['problem one', 'problem two', 'problem three']);
  });

  it('is fatal when any one complaint is fatal', () => {
    // A flow that says something untrue must never become returnable because
    // a thin complaint joined it.
    const error = composeRefusal([weak('thin', 'thin note'), fatal('false')]);
    assert.equal(error.severity, 'fatal');
  });

  it('stays weak only when every complaint is weak, and joins what they mean', () => {
    const error = composeRefusal([weak('thin a', 'note a'), weak('thin b', 'note b')]);
    assert.equal(error.severity, 'weak');
    assert.equal(error.note, 'note a; note b');
  });

  it('caps what it shows and says how much it left out', () => {
    const many = Array.from({ length: MAX_REPORTED_VIOLATIONS + 2 }, (_, i) => fatal(`problem ${i}`));
    const error = composeRefusal(many);
    assert.equal(error.messages.length, MAX_REPORTED_VIOLATIONS, 'the tree must still fit in the prompt');
    assert.match(error.message, /2 further problem\(s\) not listed/, 'never a silent drop');
    assert.doesNotMatch(error.message, /problem 6/, 'and what was cut really is cut');
  });

  it('takes severity from complaints the cap left out', () => {
    // Otherwise a fatal problem past the cap would quietly downgrade the whole
    // refusal to something the loop is willing to hand back.
    const many: Violation[] = [
      ...Array.from({ length: MAX_REPORTED_VIOLATIONS }, (_, i) => weak(`thin ${i}`, `note ${i}`)),
      fatal('the one that matters'),
    ];
    assert.equal(composeRefusal(many).severity, 'fatal');
  });
});

describe('one attempt reports every lint the flow trips', () => {
  /** Trips countPinnedName, duplicateCredentialSubmit and unpinnedDateEntry at once. */
  const threeProblems: FlowStep[] = [
    { action: 'fill', selector: 'input[type=password]', value: 'pw', intent: 'password' },
    { action: 'click', selector: 'role=button[name="Sign in" i]' },
    { action: 'expectUrl', value: '/home' },
    { action: 'click', selector: 'role=button[name="Sign in" i]' },
    { action: 'fill', selector: '[data-testid="start-date"]', value: '2026-08-18' },
    { action: 'expectVisible', selector: 'role=tab[name="Status (1)" i]' },
  ];

  function alwaysAnswers(steps: FlowStep[]): FlowAuthorModel & { feedbacks: string[][] } {
    const model: FlowAuthorModel & { feedbacks: string[][] } = {
      id: 'scripted:author',
      feedbacks: [],
      async author(request) {
        model.feedbacks.push([...(request.feedback ?? [])]);
        return {
          name: 'scripted flow',
          rationale: '',
          setup: [],
          steps,
          teardown: [],
          notes: '',
          droppedSteps: 0,
        };
      },
    };
    return model;
  }

  it('refuses once, naming all three, instead of spending an attempt per problem', async () => {
    const model = alwaysAnswers(threeProblems);
    await assert.rejects(
      new FlowAuthor({ model }).author('sign in and check the status tab'),
      (error: unknown) => {
        assert.ok(error instanceof AuthoringError);
        assert.match(error.message, /3 problems/);
        assert.match(error.message, /pins a live count/, 'countPinnedName');
        assert.match(error.message, /clicks the sign-in submit .* twice/s, 'duplicateCredentialSubmit');
        assert.match(error.message, /with no clock pinned/, 'unpinnedDateEntry');
        return true;
      },
    );
  });

  it('hands the model all three as separate bullets on the very next ask', async () => {
    const model = alwaysAnswers(threeProblems);
    await assert.rejects(new FlowAuthor({ model }).author('sign in and check the status tab'));

    assert.deepEqual(model.feedbacks[0], [], 'the first ask is uninformed by definition');
    const second = model.feedbacks[1] ?? [];
    assert.equal(second.length, 3, 'one entry per problem — buildUserPrompt renders each as a bullet');
    assert.ok(second.some((entry) => /pins a live count/.test(entry)));
    assert.ok(second.some((entry) => /twice/.test(entry)));
    assert.ok(second.some((entry) => /no clock pinned/.test(entry)));
  });

  it('reports the same problems in the same order twice', async () => {
    // Same reason `temperature: 0` exists, applied to the refusal rather than
    // the generation: a flow that is broken the same way must be refused the
    // same way, or the re-ask is a different ask each run.
    const once = alwaysAnswers(threeProblems);
    const twice = alwaysAnswers(threeProblems);
    await assert.rejects(new FlowAuthor({ model: once }).author('sign in and check the status tab'));
    await assert.rejects(new FlowAuthor({ model: twice }).author('sign in and check the status tab'));
    assert.deepEqual(once.feedbacks[1], twice.feedbacks[1]);
  });
});

describe('ungroundedTextExpectation', () => {
  // The tree the author saw: the page renders "Benefit Plan Catalog", and the
  // sidebar link's URL carries the word "plans" — the phantom word-wise
  // grounding would fall for.
  const TREE = [
    'RootWebArea "Benefit Plan Catalog" url="http://x.test/en/admin/benefits/plans"',
    'link "Benefits Admin" url="http://x.test/en/admin/benefits"',
    'heading "Benefit Plan Catalog"',
    'button "Make Correction"',
  ].join('\n');
  const step = (action: 'expectVisible' | 'expectText', selector: string) =>
    ({ action, selector }) as never;

  it('refuses the requirement\'s wording and names the tree\'s rendering (PL_02_01, two models, run today)', () => {
    const hit = ungroundedTextExpectation([step('expectVisible', 'text="Benefit Plans" >> nth=0')], TREE);
    assert.equal(hit?.index, 0);
    assert.equal(hit?.text, 'Benefit Plans');
    assert.deepEqual(hit?.nearest.slice(0, 1), ['Benefit Plan Catalog']);
    assert.equal(ungroundedTextExpectation([step('expectVisible', 'role=heading[name="Benefit Plans" i]')], TREE)?.text, 'Benefit Plans');
  });

  it('accepts text the tree renders, in any case, quoted or bare, role or text form', () => {
    assert.equal(ungroundedTextExpectation([step('expectVisible', 'text="Benefit Plan Catalog"')], TREE), null);
    assert.equal(ungroundedTextExpectation([step('expectText', 'text=benefit plan')], TREE), null);
    assert.equal(ungroundedTextExpectation([step('expectVisible', 'role=button[name="make correction" i]')], TREE), null);
  });

  it('never grounds a word on a URL attribute, only on what is rendered', () => {
    // "plans" is in the RootWebArea url, in no rendered name.
    assert.equal(ungroundedTextExpectation([step('expectVisible', 'text="plans"')], TREE)?.text, 'plans');
  });

  it('declines to judge after a workflow leg, on a truncated tree, and CSS/nameless selectors', () => {
    assert.equal(ungroundedTextExpectation([{ action: 'workflow', goal: 'go somewhere' } as never, step('expectVisible', 'text="Elsewhere"')], TREE), null);
    assert.equal(ungroundedTextExpectation([step('expectVisible', 'text="Nowhere"')], `${TREE}\n[TREE TRUNCATED: showing 4 of 9 nodes]`), null);
    assert.equal(ungroundedTextExpectation([step('expectVisible', '#hero'), step('expectVisible', 'role=heading')], TREE), null);
  });
});

describe('ungroundedSelectorRole (S4 — roles read from the tree, every action)', () => {
  const TREE = [
    'button "Benefit Category:"',
    'button "Type:"',
    'searchbox "Search benefit name" disabled',
    'button "Rows per page"',
    'table "Benefit plan catalog"',
  ].join('\n');
  const s = (action: string, selector: string) => ({ action, selector }) as never;

  it('refuses a role the page never exposes and names the tree\'s own line for that name (16 be100 dead-ends)', () => {
    const hit = ungroundedSelectorRole([s('selectOption', 'role=combobox[name="Benefit Category" i]')], TREE);
    assert.equal(hit?.role, 'combobox');
    assert.deepEqual(hit?.nearest, ['button "Benefit Category:"']);
    assert.equal(ungroundedSelectorRole([s('expectValue', 'role=combobox[name="Rows per page" i]')], TREE)?.role, 'combobox');
    assert.equal(ungroundedSelectorRole([s('expectText', 'main [role="combobox"]')], TREE)?.role, 'combobox');
    assert.equal(ungroundedSelectorRole([s('selectOption', 'main select:has(option:text-is("Medical"))')], TREE)?.role, 'select');
  });

  it('refuses a fill/click on a control the tree marks disabled at rest (the search box, 6 flows)', () => {
    const hit = ungroundedSelectorRole([s('fill', 'role=searchbox[name="Search benefit name" i]')], TREE);
    assert.equal(hit?.disabled, true);
    assert.match(hit?.nearest[0] ?? '', /disabled/);
    // Asserting its disabled state is the honest claim and is allowed.
    assert.equal(ungroundedSelectorRole([s('expectDisabled', 'role=searchbox[name="Search benefit name" i]')], TREE), null);
  });

  it('accepts roles the tree has, exempts absence claims, and declines after a workflow leg or on a truncated tree', () => {
    assert.equal(ungroundedSelectorRole([s('click', 'role=button[name="Type:" i]')], TREE), null);
    assert.equal(ungroundedSelectorRole([s('expectHidden', 'role=combobox[name="X"]')], TREE), null);
    assert.equal(ungroundedSelectorRole([{ action: 'workflow', goal: 'open it' } as never, s('click', 'role=combobox')], TREE), null);
    assert.equal(ungroundedSelectorRole([s('click', 'role=combobox')], `${TREE}\n[TREE TRUNCATED: 5 of 80]`), null);
    assert.equal(ungroundedSelectorRole([s('click', '#hero'), s('click', 'text="Save"')], TREE), null, 'CSS/text say nothing the tree contradicts');
  });
});

describe('fixtureFacts / ungroundedFixtureAssertion (S3 — test data is not an application fact)', () => {
  const text = 'Test data: Benefit Plan ID = PL_07_01_02_03_04_05_06, Company C056, plan TH_MED_005\nExpected: 2.1 the row shows Toll';
  it('extracts identifier-shaped fixture values', () => {
    const f = fixtureFacts(text);
    assert.ok(f.includes('PL_07_01_02_03_04_05_06'));
    assert.ok(f.includes('TH_MED_005'));
  });

  it('refuses asserting a fixture pre-exists, and accepts it once the flow itself typed it', () => {
    const facts = fixtureFacts(text);
    const assertFirst = [
      { action: 'goto', url: 'http://x/plans' },
      { action: 'expectDbRow', table: 't', where: { benefit_plan_id: 'PL_07_01_02_03_04_05_06' } },
    ] as never[];
    assert.equal(ungroundedFixtureAssertion(assertFirst, facts)?.fact, 'PL_07_01_02_03_04_05_06');
    const clickRow = [{ action: 'click', selector: 'tr:has-text("TH_MED_005") >> role=button[name="Make Correction"]' }] as never[];
    assert.equal(ungroundedFixtureAssertion(clickRow, facts)?.fact, 'TH_MED_005');
    const created = [
      { action: 'fill', selector: 'role=textbox[name="Plan ID"]', value: 'PL_07_01_02_03_04_05_06' },
      { action: 'click', selector: 'role=button[name="Save"]' },
      { action: 'expectDbRow', table: 't', where: { benefit_plan_id: 'PL_07_01_02_03_04_05_06' } },
    ] as never[];
    assert.equal(ungroundedFixtureAssertion(created, facts), null, 'the flow made it true before asserting it');
    assert.equal(ungroundedFixtureAssertion(assertFirst, []), null, 'no facts, nothing to judge');
  });

  // multirole.csv HIR-EC-001 (2026-09-04), Test data verbatim: the Branch is a
  // value the sheet says the SYSTEM derives from the Department ("ระบบดึงข้อมูล
  // จาก Department ได้แก่ … Store/Branch Location"), and the Policy Profile
  // pair carries a remark citing a confirmation question.
  const hiring =
    'HIR-EC-001: ตรวจสอบการจ้างพนักงานใหม่แบบ Key-in สำเร็จ\nTest data:\n' +
    '  [TD-01] Department = 30042174\n  [TD-01] Branch = T153_1733\n  [TD-01] SSO Location = T153\n' +
    '  [TD-01] Work Schedule = D05H0830\n  Policy Profile = CDS ใช้แทน CDS ที่เคยระบุ ดู CF-SIT-19\n' +
    'Expected output:\n  - ระบบดึงข้อมูลจาก Department ได้แก่ Cost Center / SSO Location / Work Location / Store/Branch Location / Policy Profile / Holiday Calendar / Division\n' +
    '  - Probationary Period End Date = ? CF-HIR-08 OQ-HIR-50';

  it('does not list an open-question id as a fixture — it is the name of a question', () => {
    const facts = fixtureFacts(hiring);
    assert.ok(facts.includes('T153_1733'));
    for (const q of ['CF-SIT-19', 'CF-HIR-08', 'OQ-HIR-50']) assert.ok(!facts.includes(q), `${q} is not a fixture`);
  });

  it('reads the claim, never the intent — a skip note citing a question asserts nothing', () => {
    const facts = fixtureFacts(hiring);
    const skipNote = [
      {
        action: 'expectVisible',
        selector: 'role=textbox[name="Policy Profile" i]',
        intent: 'skipped step 4: unconfirmed test data — Policy Profile = CDS ใช้แทน CDS ที่เคยระบุ ดู CF-SIT-19; Work Schedule D05H0830 left to the derivation',
      },
    ] as never[];
    assert.equal(ungroundedFixtureAssertion(skipNote, facts), null);
  });

  it('accepts a derived field read after data entry, and still refuses a lookup before any entry', () => {
    const facts = fixtureFacts(hiring);
    const derived = [
      { action: 'selectOption', selector: 'role=button[name="Department" i]', value: '30042174', intent: 'Step 4: เลือก Department' },
      { action: 'expectText', selector: 'role=textbox[name="Branch" i]', value: 'T153_1733', intent: 'Step 4: ตรวจสอบค่าที่ระบบดึงจาก Department' },
      { action: 'expectValue', selector: 'role=textbox[name="Work Schedule" i]', value: 'D05H0830', intent: 'Step 4: ค่าที่ระบบดึงจาก Position' },
    ] as never[];
    assert.equal(ungroundedFixtureAssertion(derived, facts), null, 'the application populated the field in answer to the selection');
    const lookup = [
      { action: 'goto', url: '/en/admin/employees' },
      { action: 'expectText', selector: 'role=textbox[name="Branch" i]', value: 'T153_1733' },
    ] as never[];
    assert.equal(ungroundedFixtureAssertion(lookup, facts)?.fact, 'T153_1733', 'nothing was entered, so the value is presumed to pre-exist');
    const listRow = [
      { action: 'selectOption', selector: 'role=button[name="Department" i]', value: '30042174' },
      { action: 'expectVisible', selector: 'text=T153_1733' },
    ] as never[];
    assert.equal(ungroundedFixtureAssertion(listRow, facts)?.fact, 'T153_1733', 'a presence in a list is still a lookup');
  });
});

/**
 * P4 (2026-08-31): the refusal loop teaches one row at a time. Measured on
 * be100-rip, the same two or three lints fired across the whole catalog, each
 * costing a fresh 57 s authoring attempt to re-learn. The feedback text already
 * exists; it just never left the row that earned it.
 */
describe('refusalShape — one lint, not six variants of it', () => {
  it('strips the row\'s particulars so two refusals of one lint collapse', () => {
    const a = 'the authored flow "PL_07_05" expectDbRows on "PL_07_01_02" (step 4) as if it existed';
    const b = 'the authored flow "PL_06_30" expectDbRows on "TH_MED_005" (step 11) as if it existed';
    assert.equal(refusalShape(a), refusalShape(b));
  });

  it('keeps genuinely different lints apart', () => {
    const a = 'the authored flow "PL_07_05" expectDbRows on "X" (step 4) as if it existed';
    const b = 'the authored flow "PL_07_05" hands a workflow step (step 0) a goal that names "Open"';
    assert.notEqual(refusalShape(a), refusalShape(b));
  });

  it('reads only the first line — the rest is the explanation, not the rule', () => {
    assert.equal(refusalShape('rule broken\nbecause of a long tail'), 'rule broken');
    assert.equal(refusalShape(''), '');
  });
});

describe('the suite\'s refusal memory', () => {
  /** A model that always writes the same refusable flow (no goto before a credential fill). */
  const stubbornModel = (seen: AuthorRequest[]): FlowAuthorModel => ({
    id: 'stub:author',
    async author(request) {
      seen.push(request);
      return {
        name: 'stubborn',
        rationale: '',
        setup: [{ action: 'goto', url: '/en/home' }],
        steps: [
          { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw', intent: 'the password field' },
          { action: 'expectVisible', selector: 'text=Dashboard', intent: 'landed' },
        ],
        teardown: [],
        notes: '',
        droppedSteps: 0,
      };
    },
  });

  it('says nothing on the first row — an untaught suite sends the prompt it always sent', async () => {
    const seen: AuthorRequest[] = [];
    const author = new FlowAuthor({ model: stubbornModel(seen) });
    await author.author('row one').catch(() => undefined);
    assert.equal(seen[0]?.commonRefusals, undefined, 'nothing has been refused yet');
  });

  it('carries a rule broken by TWO rows into a later row\'s first attempt', async () => {
    const seen: AuthorRequest[] = [];
    const author = new FlowAuthor({ model: stubbornModel(seen) });
    // Since 2026-09-04 a row's identical second refusal is not re-asked and
    // not counted — one row's accident is not the suite's pattern — so the
    // second sighting must come from another row.
    await author.author('row one').catch(() => undefined);
    const afterOne = seen.length;
    await author.author('row two').catch(() => undefined);
    assert.equal(seen[afterOne]?.commonRefusals, undefined, 'seen on one row only is not yet a pattern');
    const afterTwo = seen.length;
    await author.author('row three').catch(() => undefined);
    const rowThreeFirstAsk = seen[afterTwo]!;
    assert.ok(rowThreeFirstAsk.commonRefusals !== undefined, 'row three starts already knowing');
    assert.ok(rowThreeFirstAsk.commonRefusals!.length > 0);
    assert.equal(rowThreeFirstAsk.feedback, undefined, 'and it is NOT dressed up as this row\'s own refusal');
  });

  it('a rule seen once never travels — one row\'s accident is not the suite\'s pattern', async () => {
    const seen: AuthorRequest[] = [];
    let asks = 0;
    const model: FlowAuthorModel = {
      id: 'stub:author',
      async author(request) {
        seen.push(request);
        asks += 1;
        // Refusable on the very first ask only; every later ask is clean.
        const setup: FlowStep[] =
          asks === 1 ? [{ action: 'goto', url: '/en/home' }] : [{ action: 'goto', url: '/en/login' }];
        const steps: FlowStep[] = [
          { action: 'fill', selector: 'role=textbox >> nth=1', value: 'pw', intent: 'the password field' },
          { action: 'expectVisible', selector: 'text=Dashboard', intent: 'landed' },
        ];
        return { name: 'once', rationale: '', setup, steps, teardown: [], notes: '', droppedSteps: 0 };
      },
    };
    const author = new FlowAuthor({ model });
    await author.author('row one').catch(() => undefined);
    const before = seen.length;
    await author.author('row two').catch(() => undefined);
    assert.equal(seen[before]?.commonRefusals, undefined, 'seen once is not yet a pattern');
  });

  it('renders under a heading that does not claim it is about THIS flow', () => {
    const text = buildUserPrompt({
      prompt: 'a row',
      commonRefusals: ['expectDbRows on the case\'s own test data'],
      feedback: ['your goto is missing'],
    } as AuthorRequest);
    const commonAt = text.indexOf('MISTAKES ALREADY REFUSED ON OTHER ROWS');
    const feedbackAt = text.indexOf('Your previous attempt at this flow was REFUSED');
    assert.ok(commonAt > 0, 'the suite-wide block is rendered');
    assert.ok(feedbackAt > commonAt, "this row's own correction is read last");
    assert.match(text, /not about this flow/);
  });

  it('is bounded, so the request itself is never crowded out', () => {
    assert.equal(SUITE_REFUSAL_MEMORY, 6);
  });
});

describe('skipsAuthoredScript', () => {
  // The ec10 HIR-EC-001 shape, verbatim in structure: eight numbered steps that
  // key an identity, walk the address cascade and submit.
  const keyInCase = [
    'HIR-EC-001: ตรวจสอบการจ้างพนักงานใหม่แบบ Key-in สำเร็จ',
    'Menu path:',
    '  EC > Hire & Onboard (New Hire)',
    'Steps:',
    '  1. Login ด้วย <HR_ADMIN_ACCOUNT>',
    '  2. กรอกข้อมูล Identity ตาม Test Data',
    '  - กรอก Salutation, First Name / Last Name, Date of Birth, National ID',
    '  3. กรอกและตรวจสอบ Home Address',
    '  - เลือก Province = กรุงเทพมหานคร และตรวจสอบรายการ District',
    '  7. กด Submit เพื่อสร้างพนักงานใหม่',
    'Expected output:',
    '  - ระบบสร้าง Employee ID เป็นตัวเลข 8 หลัก',
  ].join('\n');

  it('refuses a flow that only inspects the form the case tells it to fill (HIR-EC-001)', () => {
    // Exactly what was authored: open the page, assert labels, never type.
    const body: FlowStep[] = [
      { action: 'goto', url: '/en/admin/hire?step=1' },
      { action: 'expectVisible', selector: 'text="Employee ID"' },
      { action: 'expectVisible', selector: 'text="Auto-generated by system"' },
      { action: 'click', selector: 'role=button[name="ข้อมูลติดต่อ" i]' },
    ];
    const skipped = skipsAuthoredScript(keyInCase, body);
    assert.ok(skipped !== null);
    assert.equal(skipped.performed, 0);
    assert.match(skipped.demanded, /กรอก|เลือก|Submit/);
  });

  it('accepts a flow that performs the entry, however few the fields', () => {
    const body: FlowStep[] = [
      { action: 'goto', url: '/en/admin/hire?step=1' },
      { action: 'fill', selector: 'role=textbox[name="First Name (EN)" i]', value: 'Somchai' },
      { action: 'click', selector: 'role=button[name="Submit" i]' },
      { action: 'expectVisible', selector: 'text=Employee ID' },
    ];
    assert.equal(skipsAuthoredScript(keyInCase, body), null);
    // selectOption / check count too — a cascade is chosen, not typed.
    assert.equal(
      skipsAuthoredScript(keyInCase, [
        { action: 'selectOption', selector: 'role=combobox[name="Province" i]', value: 'กรุงเทพมหานคร' },
      ]),
      null,
    );
  });

  it('refuses a script of actions with no typing answered by assertions alone (CNS-EC-028)', () => {
    const consentCase = [
      'CNS-EC-028: เมื่อมีเวอร์ชันใหม่ ไฟล์แนบที่เปิดอ่านต้องเป็นชุดของเวอร์ชันที่กำลังจะยอมรับ',
      'Steps:',
      '  1. ให้พนักงานคนที่ 1 เข้าสู่ระบบ กดเปิดไฟล์แนบ แล้วจดข้อความในย่อหน้าแรก จากนั้นกดยอมรับ',
      '  2. ผู้ดูแลประกาศเวอร์ชัน 2.0 พร้อมไฟล์แนบชุดที่ 2',
      '  3. ให้พนักงานคนที่ 2 เข้าสู่ระบบ กดเปิดไฟล์แนบ แล้วจดข้อความในย่อหน้าแรก จากนั้นกดยอมรับ',
      'Expected output:',
      '  1.1 ไฟล์แนบที่เปิดคือชุดที่ 1',
    ].join('\n');
    // What was authored: three "the page exists" assertions and not one action.
    const body: FlowStep[] = [
      { action: 'expectVisible', selector: 'text="Consent Form"' },
      { action: 'expectVisible', selector: 'text="รายการ Consent Form"' },
      { action: 'expectVisible', selector: 'text="ประเภท Consent"' },
    ];
    const skipped = skipsAuthoredScript(consentCase, body);
    assert.ok(skipped !== null);
    assert.equal(skipped.performed, 0);
    // A click or an agent leg performs "กด" — either satisfies it.
    assert.equal(skipsAuthoredScript(consentCase, [...body, { action: 'click', selector: 'role=button[name="ยอมรับ" i]' }]), null);
    assert.equal(skipsAuthoredScript(consentCase, [{ action: 'workflow', goal: 'open the attachment and accept' } as never]), null);
  });

  it('never fires for a read-only case, which scripts no input at all', () => {
    const readOnly = [
      'PL_01_01: การมองเห็นและเข้าถึงเมนู Benefit Plans',
      'Steps:',
      '  1. ไปที่ HR > Benefits Admin',
      '  2. ตรวจสอบว่าเมนู Benefit Plans แสดง',
      'Expected output:',
      '  - เมนู Benefit Plans แสดงและกดได้',
    ].join('\n');
    const body: FlowStep[] = [
      { action: 'goto', url: '/en/admin/benefits' },
      { action: 'expectVisible', selector: 'text="Benefit Plans"' },
    ];
    assert.equal(skipsAuthoredScript(readOnly, body), null);
  });

  it('says nothing when the case carries no Steps column, and ignores setup fills by construction', () => {
    assert.equal(skipsAuthoredScript('HIR-EC-001: a case with no script', []), null);
    // Only the BODY is passed in, so a sign-in's own fills can never satisfy
    // the rule — the caller hands `result.steps`, never `result.setup`.
    assert.ok(skipsAuthoredScript(keyInCase, [{ action: 'expectVisible', selector: 'text=x' }]) !== null);
  });
});

describe('unboundedExclusivityClaim', () => {
  // ec10_3x HIR-EC-029: "dropdown แสดง 3 ค่า : Event Reason … แสดงเฉพาะ New Hire / Replacement / Migration".
  const claim = 'HIR-EC-029: ตรวจสอบว่า Event Reason บนหน้า Key-in แสดงเฉพาะ New Hire / Replacement / Migration\nExpected output:\n  - dropdown แสดง 3 ค่า : Event Reason บนหน้า Key-in แสดงเฉพาะ New Hire / Replacement / Migration\n  - ไม่แสดง Event Reason : H_CORENTRY, H_INENTRY, H_TEMPASG';
  const presences: FlowStep[] = [
    { action: 'click', selector: 'role=button[name="Event Reason" i]' },
    { action: 'expectVisible', selector: 'text="New Hire"' },
    { action: 'expectVisible', selector: 'text="Replacement"' },
    { action: 'expectVisible', selector: 'text="Migration"' },
    { action: 'expectHidden', selector: 'text="H_CORENTRY"' },
  ];

  it('refuses three presences standing in for "exactly 3" — they pass on a dropdown of a hundred', () => {
    const r = unboundedExclusivityClaim(presences, claim);
    assert.ok(r !== null);
    assert.equal(r.wanted, 3);
    assert.match(r.claim, /3 ค่า/);
  });

  it('is satisfied by a count, which is what closes the set', () => {
    const bounded: FlowStep[] = [...presences, { action: 'expectCount', selector: 'role=option', count: 3 } as FlowStep];
    assert.equal(unboundedExclusivityClaim(bounded, claim), null);
  });

  it('never fires for a case that makes no exclusivity or count claim', () => {
    assert.equal(unboundedExclusivityClaim(presences, 'HIR-EC-001: the New Hire option is offered in Event Reason'), null);
  });

  it('reads "only" and "เฉพาะ" without a number too', () => {
    const r = unboundedExclusivityClaim(presences, 'Expected: the filter offers only Active and Inactive');
    assert.ok(r !== null);
    // One detector since 2026-09-04: the shared one counts the listing too.
    assert.equal(r.wanted, 2);
  });

  it('never reads "only" inside a hyphen compound — "Read-only" is a mode, not a set (HIR-EC-001, 2026-09-04)', () => {
    // multirole.csv HIR-EC-001, Expected output verbatim. The legacy regex had
    // no word boundary and demanded `expectCount role=option` for a set the
    // page does not have; every attempt was refused for it.
    const readOnly =
      'HIR-EC-001: ตรวจสอบการจ้างพนักงานใหม่แบบ Key-in สำเร็จ\nExpected output:\n' +
      '  - ระบบ Auto-Derive Time Management Status = 01 - Clocking และ O.T. Flag = Yes ตาม Rule Table\n' +
      '  - Time Management Status และ O.T. Flag เป็น Read-only และ HR ไม่สามารถแก้ไขเองได้\n' +
      '  - ระบบดึงข้อมูลจาก Department ได้แก่ Cost Center / SSO Location / Work Location / Store/Branch Location / Policy Profile / Holiday Calendar / Division';
    assert.equal(unboundedExclusivityClaim(presences, readOnly), null);
    assert.equal(unprovedExclusivity(presences, readOnly), null, 'the shared detector agrees');
    // And a line that enumerates after a hyphen compound still does not read the compound as the marker.
    assert.equal(
      exclusivityClaimIn('Expected output:\n  - Time Management Status is read-only for HR / Manager / Employee'),
      null,
    );
  });
});

describe('journey capture reads the tab the row selects, before the opening click (2026-09-04)', () => {
  // The landing state of a page with a tab strip rendered as buttons: the
  // DEFAULT tab's panel is what the tree shows, and its own Add control is
  // the only "Add…" on the page. The row's script selects the THIRD tab
  // first, then presses "Add" / "+".
  const LANDING = [
    { role: 'button', name: 'Account menu' },
    { role: 'button', name: 'Branch Rate' },
    { role: 'button', name: 'Branch Registration' },
    { role: 'button', name: 'Base Amount' },
    { role: 'heading', name: 'Branch Rate' },
    { role: 'button', name: 'Add Rate' },
    { role: 'table', name: 'Rates' },
  ];

  it('controlNamedIn picks the exact name over a prefix sibling, and ignores non-clickable roles', () => {
    assert.equal(controlNamedIn(LANDING, 'Branch Registration')?.name, 'Branch Registration');
    assert.equal(controlNamedIn(LANDING, 'branch  registration')?.selector, 'role=button[name="Branch Registration" i]', 'whitespace-folded, case-insensitive');
    assert.equal(controlNamedIn(LANDING, 'Rates'), null, 'a table is not something the sheet clicks');
    assert.equal(controlNamedIn([{ role: 'button', name: 'Add Rate' }, { role: 'button', name: 'Add' }], 'Add')?.name, 'Add', 'whole name beats an earlier prefix match');
    assert.equal(controlNamedIn(LANDING, ''), null);
    assert.equal(controlNamedIn(LANDING, 'Nothing here'), null);
  });

  it('the prefix fallback is what matched "Add" to the default panel\'s "Add Rate" — so the tab is selected before it runs', () => {
    // Exactly the substitution the live capture made on the wrong panel. It
    // stays a legal match (an "Add" that IS rendered "Add Rate" on the right
    // panel is the common case); what changed is that the capture selects the
    // row's tab first and skips this click when it cannot.
    assert.equal(controlNamedIn(LANDING, 'Add')?.name, 'Add Rate');
  });

  it('journeyTreeSection says the tab was selected and that the flow must click it first', () => {
    const section = journeyTreeSection({
      landed: 'https://app.test/admin/config',
      tree: 'button "Branch Registration"\nbutton "Add Registration"',
      tabWanted: 'Branch Registration',
      tabSelected: { name: 'Branch Registration', selector: 'role=button[name="Branch Registration" i]' },
      opened: { name: 'Add Registration', selector: 'role=button[name="Add Registration" i]', url: 'https://app.test/admin/config', tree: 'dialog "Add Registration"' },
    });
    assert.match(section, /read WITH the tab "Branch Registration" selected \(role=button\[name="Branch Registration" i\]\)/);
    assert.match(section, /write that click first/);
    assert.match(section, /AFTER CLICKING "Add Registration" ON https:\/\/app\.test\/admin\/config \(with the tab "Branch Registration" selected\)/);
    assert.ok(section.indexOf('button "Add Registration"') < section.indexOf('dialog "Add Registration"'), 'landing tree, then the opened tree');
  });

  it('a tab the capture could not select is announced, and an absent control is "not captured", never absent', () => {
    const section = journeyTreeSection({
      landed: 'https://app.test/admin/config',
      tree: 'button "Branch Rate"\nbutton "Add Rate"',
      tabWanted: 'Branch Registration',
      tabSelected: null,
      opened: null,
    });
    assert.match(section, /could NOT select it/);
    assert.match(section, /NOT CAPTURED rather than absent/);
    assert.match(section, /never a control of another panel that merely resembles the name/);
    assert.doesNotMatch(section, /AFTER CLICKING/, 'no opening click is read from the wrong panel');
    // No tab named at all: the section reads as it always did.
    const plain = journeyTreeSection({ landed: 'https://app.test/x', tree: 'button "Go"', tabWanted: null, tabSelected: null, opened: null });
    assert.doesNotMatch(plain, /tab/);
  });
});

// ------------------------------------------------------------- 2026-09-04
// The two lint defects of multirole PRB-EC-001 / ML_01_04, and the vocabulary
// they read through moving into data (`value-rules.ts`).

describe('skipsAuthoredScript — a choice is made by clicking (PRB-EC-001, 2026-09-04)', () => {
  const probation = [
    'PRB-EC-001: ผ่านทดลองงานปกติ',
    'Steps:',
    '  1. Login ด้วย <HR_ADMIN_ACCOUNT>',
    '  2. ไปที่ EC > Probation',
    '  3. เลือก Pass probation (normal)',
    '  4. กด Submit',
    '  5. Login ด้วย <HRBP_ACCOUNT>',
    '  5.1 กด Approve',
    'Expected output:',
    '  1. สถานะเปลี่ยนเป็น Approved',
  ].join('\n');

  it('accepts the PRB body: a click on a radio, Submit, a hand-off, Approve, a workflow leg', () => {
    const body = [
      { action: 'click', selector: 'role=radio[name="Pass probation (normal)" i]', intent: 'Step 3: เลือก Pass probation (normal)' },
      { action: 'click', selector: 'role=button[name="Submit" i]', intent: 'Step 4: กด Submit' },
      { action: 'signIn', name: 'HRBP_ACCOUNT', intent: 'Step 5: Login HRBP' },
      { action: 'click', selector: 'role=button[name="Approve" i]', intent: '5.1 กด Approve' },
      { action: 'workflow', goal: 'approve the probation request' },
    ] as never[];
    assert.equal(skipsAuthoredScript(probation, body), null);
  });

  it('a click on a choice role chooses even as the last step; a click on a button does so only when a step follows it', () => {
    assert.equal(skipsAuthoredScript(probation, [{ action: 'click', selector: 'role=option[name="Pass" i]' }] as never[]), null);
    assert.equal(skipsAuthoredScript(probation, [{ action: 'click', selector: 'role=checkbox[name="Pass" i]' }] as never[]), null);
    const lastClick = skipsAuthoredScript(probation, [{ action: 'click', selector: 'role=button[name="Submit" i]' }] as never[]);
    assert.equal(lastClick?.tier, 'choosing');
    assert.equal(
      skipsAuthoredScript(probation, [
        { action: 'click', selector: 'role=button[name="Pass probation (normal)" i]' },
        { action: 'expectVisible', selector: 'text=Approved' },
      ] as never[]),
      null,
      'a click that a later step follows is a choice made by clicking',
    );
  });

  it('still refuses a body of pure assertions, naming the tier and exactly what the code accepts', () => {
    const refused = skipsAuthoredScript(probation, [
      { action: 'expectVisible', selector: 'text=Approved' },
      { action: 'expectText', selector: 'role=status', value: 'Approved' },
    ] as never[]);
    assert.ok(refused !== null);
    assert.equal(refused.tier, 'choosing');
    assert.equal(refused.demanded, 'เลือก');
    assert.match(describeScriptDemand('choosing'), /radio, option, checkbox/);
    assert.match(describeScriptDemand('choosing'), /a click that another body step follows/);
    assert.match(describeScriptDemand('typing'), /fill, fillRetry, type, setValue, upload, selectOption, check or uncheck/);
    assert.match(describeScriptDemand('acting'), /workflow leg/);
  });

  it('typing is still typing: a script that says กรอก is not performed by clicks alone (HIR-EC-001 kept)', () => {
    const keyIn = 'HIR-EC-001: x\nSteps:\n  1. กรอกข้อมูล Identity\n  2. กด Submit\nExpected output:\n  1. ok';
    const clicksOnly = skipsAuthoredScript(keyIn, [
      { action: 'click', selector: 'role=button[name="Next" i]' },
      { action: 'click', selector: 'role=button[name="Submit" i]' },
    ] as never[]);
    assert.equal(clicksOnly?.tier, 'typing');
    assert.equal(skipsAuthoredScript(keyIn, [{ action: 'fill', selector: 'role=textbox[name="First Name" i]', value: 'A' }] as never[]), null);
  });
});

describe('unperformedScriptSteps — a citation in a goal or in the sheet\'s sub-numbering (PRB-EC-001, 2026-09-04)', () => {
  const script = ['X: y', 'Steps:', '  1. a', '  2. b', '  3. c', '  4. d', '  5. e', 'Expected output:', '  1.1 z'].join('\n');
  const through4 = { action: 'click', selector: 'x', intent: 'Step 4: d' } as never;

  it('a workflow goal citing "Step 5:" performs step 5', () => {
    assert.equal(unperformedScriptSteps(script, [through4, { action: 'workflow', goal: 'Step 5: do e' } as never]), null);
  });

  it('an intent headed by the sheet\'s own sub-number "5.4 …" cites step 5', () => {
    assert.equal(unperformedScriptSteps(script, [through4, { action: 'click', selector: 'y', intent: '5.4 กด Approve' } as never]), null);
  });

  it('an Expected id at the head of an intent is not a script citation', () => {
    // "1.1 z" is the Expected line; citing it says nothing about script step 1.
    const flow = [{ action: 'expectVisible', selector: 'x', intent: '1.1 z is shown' } as never];
    assert.equal(unperformedScriptSteps(script, flow), null, 'no script step cited at all — nothing to reason from');
    const refused = unperformedScriptSteps(script, [{ action: 'click', selector: 'x', intent: 'Step 4: d' } as never, ...flow]);
    assert.deepEqual(refused?.missing.map((m) => m.n), [5]);
  });

  it('a flow citing 1–4 and nothing about 5 is still refused; a skip marker still clears it', () => {
    const refused = unperformedScriptSteps(script, [{ action: 'click', selector: 'x', intent: 'Step 1: a' } as never, through4]);
    assert.equal(refused?.performedThrough, 4);
    assert.deepEqual(refused?.missing.map((m) => m.n), [5]);
    assert.equal(unperformedScriptSteps(script, [through4, { action: 'expectVisible', selector: 'x', intent: 'skipped step 5: no account' } as never]), null);
    assert.equal(unperformedScriptSteps(script, [{ action: 'click', selector: 'x', intent: 'ขั้นตอนที่ 5: e' } as never]), null, 'the Thai step word cites too');
  });
});

describe('expectedItemsIn — an id is at the head of its line (ML_01_04, 2026-09-04)', () => {
  it('does not read "0.52" out of "Requested hours : 0.52 hrs"', () => {
    const text = ['ML_01_04: x', 'Expected output:', '  1. Requested hours : 0.52 hrs', '  - Balance : 7.5 days', '  2.1 the row shows', '  - 2.2 bulleted id', 'Steps:', '  1. x'].join('\n');
    assert.deepEqual(expectedItemsIn(text), ['1', '2.1', '2.2']);
    assert.deepEqual(unassertedExpectedItems([{ action: 'expectText', selector: 'x', value: '0.52', intent: '1. 2.1 2.2' }], text), []);
  });
});

describe('the authoring vocabulary is data (value-rules.ts, 2026-09-04)', () => {
  it('an override replaces a list wholesale and the compiled rules follow it', () => {
    const rules = withOverride({ authoring: { script: { choosing: ['pick'] }, openQuestionPrefixes: ['QQ-'] } });
    assert.deepEqual(rules.authoring.script.choosing, ['pick']);
    assert.deepEqual(rules.authoring.script.typing, DEFAULT_VALUE_RULES.authoring.script.typing, 'an absent list keeps the built-in');
    const compiled = compileAuthoringRules(rules.authoring);
    assert.ok(compiled.script.choosing.test('pick a plan'));
    assert.ok(!compiled.script.choosing.test('เลือก Province'), 'the built-in word is gone — a replacement, not a union');
    assert.ok(compiled.openQuestion.test('see QQ-HIR-12'));
    assert.ok(!compiled.openQuestion.test('see OQ-HIR-12'));
    assert.ok(compiled.sheetNote.notYet.test('ยังทดสอบไม่ได้') && compiled.sheetNote.notYet.test('cannot be tested yet'), 'both languages, untouched');
  });

  it('an open question is any id the case writes after its "?" — no prefix needed', () => {
    assert.deepEqual([...openQuestionIdsIn('Probationary End = ? CF-HIR-08 OQ-HIR-50\nNotice = ? QX-ABC-12')], ['CF-HIR-08', 'OQ-HIR-50', 'QX-ABC-12']);
    assert.equal(assertsOpenQuestion([{ action: 'expectVisible', selector: 'text=QX-ABC-12' }], 'Expected output:\n  - Notice = ? QX-ABC-12')?.marker, 'QX-ABC-12');
    assert.equal(assertsOpenQuestion([{ action: 'expectVisible', selector: 'text=QX-ABC-12' }]), null, 'without the case, an unknown prefix is just an id');
    assert.ok(!fixtureFacts('ZZ-QA-029: t\nTest data: Ref = ? QX-ABC-12, Plan = TH_MED_005').includes('QX-ABC-12'));
  });

  it('a sibling case id is recognised by the skeleton of the case\'s own id, whatever the catalog\'s prefixes', () => {
    const facts = fixtureFacts('ZZ-QA-029: title\nTest data: Plan = TH_MED_005, same as ZZ-QA-001, เคส E2E-29\nExpected: ok ZZ-QA-030');
    assert.deepEqual(facts, ['TH_MED_005']);
  });
});

// ---------------------------------------------------------------- multirole HIR-EC-001 (2026-09-04)

describe('the last word is a rewrite, not a refusal (multirole HIR-EC-001, 2026-09-04)', () => {
  // The sheet row as `describeCase` renders it, cut to the columns the lints
  // read: eight scripted steps, and the Expected lines the 07:10 run was
  // refused over. The authored flow performs steps 1–7 and never reaches 8.
  const caseText = [
    'HIR-EC-001: ตรวจสอบการจ้างพนักงานใหม่แบบ Key-in สำเร็จ กรณีวันเริ่มงานต้นเดือน',
    'Test data:',
    '  Province = กรุงเทพมหานคร',
    'Steps:',
    '  1. Login ด้วย <HR_ADMIN_ACCOUNT>',
    '  2. กรอกข้อมูล Identity ตาม Test Data',
    '  3. กรอกและตรวจสอบ Home Address',
    '  4. กรอกข้อมูล Position & Organization',
    '  5. ตรวจสอบ Time Management Status และ O.T. Flag',
    '  6. กรอก Compensation Information และ Payment Information ให้ครบถ้วน',
    '  7. กด Submit เพื่อสร้างพนักงานใหม่',
    '  8. ตรวจสอบ Employee Profile ใน EC',
    'Expected output:',
    '  EC',
    '  - Employee Status = Active',
    '  - เมื่อเปลี่ยน Province ระบบเคลียร์ District / Sub-District / Postal Code เดิม',
    '  - Time Management Status และ O.T. Flag เป็น Read-only และ HR ไม่สามารถแก้ไขเองได้',
  ].join('\n');
  const throughSeven: FlowStep[] = [
    { action: 'click', selector: 'role=link[name="New Hire" i]', intent: 'Step 1: ไปที่ EC > New Hire' },
    { action: 'fill', selector: 'role=textbox[name="First Name" i]', value: 'สมชาย', intent: 'Step 2: กรอกข้อมูล Identity' },
    { action: 'selectOption', selector: 'role=button[name="Province" i]', value: 'กรุงเทพมหานคร', intent: 'Step 3: เลือก Province' },
    { action: 'expectValue', selector: 'role=textbox[name="Postal Code" i]', value: '', intent: 'Step 3: เมื่อเปลี่ยน Province ระบบเคลียร์ Postal Code เดิม' },
    { action: 'fill', selector: 'role=textbox[name="Position" i]', value: '1', intent: 'Step 4: กรอก Position' },
    { action: 'expectDisabled', selector: 'role=textbox[name="Time Management Status" i]', intent: 'Step 5: Read-only' },
    { action: 'fill', selector: 'role=textbox[name="Salary" i]', value: '1', intent: 'Step 6: กรอก Compensation' },
    { action: 'click', selector: 'role=button[name="Submit" i]', intent: 'Step 7: กด Submit' },
    { action: 'expectVisible', selector: 'text="Employee Status"', intent: 'Expected: Employee Status = Active' },
  ];

  it('settleViolations: weak notes ride along, a fatal complaint with a grounded rewrite is settled, one without keeps the refusal', () => {
    const r = settleViolations([
      { message: 'thin', severity: 'weak', note: 'thin note' },
      { message: 'fatal but settleable', severity: 'fatal', note: 'n', settle: () => 'settled note' },
      { message: 'fatal, no evidence', severity: 'fatal', note: 'n', settle: () => null },
      { message: 'fatal, no fallback', severity: 'fatal', note: 'n' },
    ]);
    assert.deepEqual(r.notes, ['thin note', 'settled note']);
    assert.deepEqual(r.unsettled.map((v) => v.message), ['fatal, no evidence', 'fatal, no fallback']);
  });

  it('on the last attempt the flow that stops at step 7 of 8 is handed over with "not covered: script step(s) 8" instead of blocked', async () => {
    const log: string[] = [];
    const author = new FlowAuthor({ model: stubModel({ name: 'HIR-EC-001 New Hire Key-in success', steps: [...throughSeven] }), attempts: 1, onLog: (l) => log.push(l) });
    const authored = await author.author(caseText, undefined, { caseText });
    assert.match(authored.notes, /not covered: script step\(s\) 8 \(ตรวจสอบ Employee Profile ใน EC\) — no authored step performs them; the flow performs the script through step 7 of 8/);
    assert.equal(authored.flow.steps.length, throughSeven.length, 'the covered steps go out as written');
    assert.ok(log.some((l) => /settled 1 refusal\(s\) by rewriting instead of refusing/.test(l)));
  });

  it('the same fatal refusal answered twice is settled on the second attempt, not re-asked a third time', async () => {
    let calls = 0;
    const model: FlowAuthorModel = {
      id: 'stub:author',
      async author() {
        calls += 1;
        return { name: 'HIR-EC-001', rationale: '', setup: [], steps: [...throughSeven], teardown: [], notes: '', droppedSteps: 0 };
      },
    };
    const author = new FlowAuthor({ model });
    const authored = await author.author(caseText, undefined, { caseText });
    assert.equal(calls, 2, 'one informed re-ask, then the rewrite');
    assert.match(authored.notes, /not covered: script step\(s\) 8/);
  });

  it('a fatal complaint with no grounded rewrite still refuses — a false claim is never handed over', async () => {
    const author = new FlowAuthor({
      model: stubModel({
        steps: [
          ...throughSeven.slice(0, 8),
          { action: 'fill', selector: 'role=textbox[name="Employee ID" i]', value: '<NON_EXISTING_EMPLOYEE_ID>', intent: 'Step 8: ค้นหา' },
          { action: 'expectVisible', selector: 'text="Employee Status"', intent: 'Step 8: Expected: Employee Status = Active' },
        ],
      }),
      attempts: 1,
    });
    await assert.rejects(() => author.author(caseText, undefined, { caseText }), (e: unknown) => e instanceof AuthoringError && e.severity === 'fatal' && /<NON_EXISTING_EMPLOYEE_ID>|token/.test(e.message));
  });

  it('an ungrounded text assertion is handed over marked [generated: …] on the last attempt, with the nearest rendering named', async () => {
    const tree = 'main\n  heading "Benefit Plan Catalog"\n  button "Submit"';
    const author = new FlowAuthor({
      model: stubModel({ steps: [{ action: 'click', selector: 'role=button[name="Submit" i]', intent: 'go' }, { action: 'expectVisible', selector: 'text="Benefit Plans"', intent: 'Expected: the heading' }] }),
      journeyTree: tree,
      attempts: 1,
    });
    const authored = await author.author('the catalog heading is shown');
    const step = authored.flow.steps[1] as FlowStep & { intent: string };
    assert.ok(step.intent.startsWith('Expected: the heading ' + GENERATED_STEP_MARKER), step.intent);
    assert.match(step.intent, /the page renders "Benefit Plan Catalog"/);
    assert.match(authored.notes, /handed over marked \[generated: …\] for the run to prove or dead-end/);
  });

  it('settleSelectorRole repoints a role to the tree\'s own line for the same name, and refuses to guess otherwise', () => {
    const step: FlowStep = { action: 'selectOption', selector: 'role=combobox[name="Event Reason" i]', value: 'New Hire', intent: 'Step 2: เลือก Event Reason' };
    const note = settleSelectorRole(step, { role: 'combobox', name: 'Event Reason', nearest: ['button "Event Reason" haspopup'], disabled: false });
    assert.match(note ?? '', /repointed to role=button/);
    assert.equal((step as { selector: string }).selector, 'role=button[name="Event Reason" i]');
    assert.match((step as { intent: string }).intent, /^Step 2: เลือก Event Reason \[generated: role "combobox" repointed to "button"/);
    const other: FlowStep = { action: 'click', selector: 'role=combobox[name="Event Reason" i]' };
    assert.equal(settleSelectorRole(other, { role: 'combobox', name: 'Event Reason', nearest: ['button "Event Reason Type"'], disabled: false }), null, 'a different name is no evidence');
    assert.equal(settleSelectorRole(other, { role: 'combobox', name: 'Event Reason', nearest: ['textbox "Event Reason"'], disabled: true }), null, 'disabled is a different complaint');
  });

  it('settleExclusivity inserts the count from the tree before the first member presence, and declines when a member is in no tree (HIR-EC-029 shape)', () => {
    const text = 'HIR-EC-029: Event Reason\nExpected output:\n  - dropdown แสดง 3 ค่า : Event Reason บนหน้า Key-in แสดงเฉพาะ New Hire / Replacement / Migration';
    const claim = exclusivityClaimIn(text);
    assert.ok(claim !== null);
    const flow = {
      steps: [
        { action: 'click', selector: 'role=button[name="Event Reason" i]' },
        { action: 'expectVisible', selector: 'text="New Hire"' },
        { action: 'expectVisible', selector: 'text="Replacement"' },
      ] as FlowStep[],
      cases: undefined as undefined,
    };
    const opened = 'listbox\n  option "New Hire"\n  option "Replacement"\n  option "Migration"\n  option "HIREDM"';
    const note = settleExclusivity(flow, claim, text, opened);
    assert.match(note ?? '', /expectCount role=option = 3 inserted/);
    const inserted = flow.steps[1] as FlowStep & { count: number; intent: string; selector: string };
    assert.equal(inserted.action, 'expectCount');
    assert.equal(inserted.count, 3);
    assert.match(inserted.selector, /role=option/);
    assert.ok(inserted.intent.includes(GENERATED_STEP_MARKER));
    assert.equal(unboundedExclusivityClaim(flow.steps, text), null, 'the inserted count settles the lint');
    // No tree lists "Migration": no role is evidence for a count.
    const bare = { steps: [{ action: 'expectVisible', selector: 'text="New Hire"' }] as FlowStep[], cases: undefined as undefined };
    assert.equal(settleExclusivity(bare, claim, text, 'option "New Hire"\noption "Replacement"'), null);
  });
});

// ---------------------------------------------------------------- multirole ML_01_04 (2026-09-04)

describe('a script step is performed, never read as a noun, and the last word performs it (multirole ML_01_04, 2026-09-04)', () => {
  // multirole.csv ML_01_04, the Steps column verbatim, as `describeCase` renders it.
  const caseText = [
    'ML_01_04: ลาป่วย ขั้นต่ำ 30 นาที - Manager approve request',
    'Test data:',
    '  ลา = 31 นาที',
    'Steps:',
    '  1. Login web humi',
    '  2. กดเมนู ME และตรวจสอบ',
    '  3. กดเมนู Time & Attendance',
    '  4. กดเมนู Leave request',
    '  5. เลือก Leave type = Sick Leave',
    '  6. เลือกวันที่ลา',
    '  7. เลือกเป็น Hourly แล้วเลือกเวลาที่ต้องการ',
    '  8. กดปุ่ม Submit',
    '  9. Manager กดปุ่ม approve request leave',
    'Expected output:',
    '  5.1 ระบบแสดง Leave Type',
    '  7.1 ระบบแสดงเลือก Hourly และแสดงเป็น 0h 31m',
  ].join('\n');
  const legs: FlowStep[] = [
    { action: 'click', selector: 'role=tab[name="Me" i]', intent: 'Step 2: กดเมนู ME' },
    { action: 'click', selector: 'role=link[name="Leave request" i]', intent: 'Step 4: กดเมนู Leave request' },
    { action: 'workflow', goal: 'Step 5: On the Leave request form, choose Leave Type = Sick Leave, then Step 6: pick today as the leave date' },
    { action: 'expectVisible', selector: 'text="Sick Leave"', intent: '5.1 ระบบแสดง Leave Type' },
    { action: 'workflow', goal: 'Step 7: choose Hourly and a 31-minute window' },
    { action: 'expectVisible', selector: 'text="0h 31m"', intent: '7.1 แสดงเป็น 0h 31m' },
    { action: 'click', selector: 'role=button[name="Submit" i]', intent: 'Step 8: กดปุ่ม Submit' },
    { action: 'signIn', as: 'MANAGER_ACCOUNT', intent: 'Step 9: Manager เข้าระบบ' },
    { action: 'workflow', goal: 'Step 9: as the manager, approve the pending Sick Leave request' },
    { action: 'expectVisible', selector: 'text="Approved"', intent: '9.4 Status Approved' },
  ];

  it('"type" as the head of a "Leave type = Sick Leave" pair is a field name, not the typing verb', () => {
    assert.equal(scriptDemand(/\btype\b/i, '5. เลือก Leave type = Sick Leave'), null);
    assert.equal(scriptDemand(/\btype\b/i, '5. type the reason\n6. Leave type = Sick'), 'type');
    assert.equal(skipsAuthoredScript(caseText, [])?.tier, 'choosing', 'the sheet asks to CHOOSE, nothing to type');
  });

  it('a workflow leg performs the choosing (and typing) its script asks for; the ML_01_04 body passes', () => {
    assert.equal(skipsAuthoredScript(caseText, legs), null);
    const typed = caseText.replace('5. เลือก Leave type = Sick Leave', '5. กรอก เหตุผล = ป่วย');
    assert.equal(skipsAuthoredScript(typed, [{ action: 'workflow', goal: 'Step 5: กรอก เหตุผล' }, { action: 'expectVisible', selector: 'text=x' }]), null);
    assert.equal(skipsAuthoredScript(typed, [{ action: 'expectVisible', selector: 'text=x' }])?.tier, 'typing');
  });

  it('a declared word inside a longer capitalised name in the goal is not the control named', () => {
    const repo = 'labels: "Type", "Leave", "Leave Type", "Make Correction"';
    const goal = (g: string): FlowStep[] => [{ action: 'workflow', goal: g }];
    assert.deepEqual(workflowOverDeclaredControls(goal('choose Leave Type = Sick Leave'), repo)?.declared, ['Leave Type']);
    assert.equal(workflowOverDeclaredControls(goal('choose Sick Leave'), repo), null, '"Leave" in "Sick Leave" names Sick Leave');
    assert.deepEqual(workflowOverDeclaredControls(goal('click Make Correction'), repo)?.declared, ['Make Correction']);
    assert.deepEqual(workflowOverDeclaredControls(goal('click make correction, then type'), repo)?.declared, ['Type', 'Make Correction'], 'a lower-case goal keeps the plain match');
  });

  it('settleScriptDemand performs an uncited script line from the tree, and hands an ungroundable one to an agent leg in the sheet\'s words', () => {
    const flow = {
      steps: [
        { action: 'click', selector: 'role=link[name="Leave request" i]', intent: 'Step 4: กดเมนู Leave request' },
        { action: 'expectVisible', selector: 'text="Sick Leave"', intent: '5.1 ระบบแสดง Leave Type' },
      ] as FlowStep[],
      cases: [{ name: 'c', steps: [] as FlowStep[] }],
    };
    flow.cases[0]!.steps = flow.steps;
    const tree = 'main\n  button "Leave Type"\n  button "Submit"';
    const note = settleScriptDemand(flow, caseText, 'choosing', tree);
    assert.match(note ?? '', /step 5 \(1 control\(s\) from the tree\) as deterministic steps/);
    assert.match(note ?? '', /step 6, step 7 as agent leg\(s\) in the sheet's words/);
    const chosen = flow.steps[1] as FlowStep & { selector: string; value: string; intent: string };
    assert.equal(chosen.action, 'selectOption');
    assert.equal(chosen.selector, 'role=button[name="Leave Type" i]');
    assert.equal(chosen.value, 'Sick Leave');
    assert.match(chosen.intent, /^Step 5: เลือก Leave type = Sick Leave \[generated: performs the script's "เลือก" on button "Leave Type"/);
    const leg = flow.steps[2] as FlowStep & { goal: string };
    assert.equal(leg.action, 'workflow');
    assert.equal(leg.goal, 'Step 6: เลือกวันที่ลา');
    assert.equal(flow.cases[0]!.steps.length, flow.steps.length, 'the case sees the same insertions');
    assert.equal(skipsAuthoredScript(caseText, flow.steps), null);
  });

  it('settleWorkflowGoal splits the goal\'s "Field = value" pair out when the tree names the field, and annotates the leg', () => {
    const leg: FlowStep = { action: 'workflow', goal: 'On the Leave request form, choose Leave Type = Sick Leave and pick today' };
    const flow = { steps: [leg] as FlowStep[], cases: undefined as undefined };
    assert.equal(settleWorkflowGoal(flow, leg, 'main\n  button "Submit"'), null, 'no tree line, no split');
    const note = settleWorkflowGoal(flow, leg, 'main\n  button "Leave Type"');
    assert.match(note ?? '', /button "Leave Type" = "Sick Leave" performed deterministically before the leg/);
    assert.equal(flow.steps[0]!.action, 'selectOption');
    assert.equal(flow.steps[1], leg);
    assert.match((leg as { intent?: string }).intent ?? '', /\[generated: 1 control\(s\) the tree names were split out/);
  });

  it('expectedNamedFields reads Expected pairs without reading fields found only in Test data', () => {
    const named = expectedNamedFields('3.1 Hire Date = Today');

    assert.deepEqual([...named], ['hire date']);
    assert.equal(named.has('employee name'), false);
  });

  it('acceptance splits only Expected-named grounded workflow pairs before the leg', () => {
    const leg: FlowStep = {
      action: 'workflow',
      goal: 'Hire Date = 01 Sep 2027\nEmployee Name = Test User',
    };
    const flow = { steps: [leg] as FlowStep[], cases: undefined as undefined };

    settleAcceptedFlowInputs(
      flow,
      '3.1 Hire Date = Today ตามค่าที่กรอก',
      'main\n  textbox "Hire Date"\n  textbox "Employee Name"',
      'HIR-EC-001',
    );

    const entry = flow.steps[0] as FlowStep & { selector?: string; value?: string };
    assert.equal(entry.action, 'fill');
    assert.equal(entry.selector, 'role=textbox[name="Hire Date" i]');
    assert.equal(entry.value, '01 Sep 2027');
    assert.equal(flow.steps[1], leg);
    assert.match((leg as { goal: string }).goal, /Employee Name = Test User/);
    assert.match((leg as { intent?: string }).intent ?? '', /1 control\(s\) the tree names were split out/);
  });

  it('acceptance mints an unnamed required attachment but never satisfies an Expected claim with an invented file', () => {
    const evidence = 'main\n  button "Personal Information (Attachment) *"';
    assert.deepEqual(requiredAttachmentControls(evidence), [
      { role: 'button', name: 'Personal Information (Attachment) *' },
    ]);
    const unnamedLeg: FlowStep = { action: 'workflow', goal: 'Complete the Personal Information form' };
    const unnamed = { steps: [unnamedLeg] as FlowStep[], cases: undefined as undefined };

    settleAcceptedFlowInputs(unnamed, '3.1 Employee is created', evidence, 'HIR-EC-001');

    const upload = unnamed.steps[0] as FlowStep & { selector?: string; files?: readonly string[]; intent?: string };
    assert.equal(upload.action, 'upload');
    assert.equal(upload.selector, 'role=button[name="Personal Information (Attachment) *" i]');
    assert.equal(upload.files?.length, 1);
    assert.equal(isFixtureSpec(upload.files?.[0] ?? ''), true);
    assert.match(upload.intent ?? '', /sheet named no file.*harness minted one/i);
    assert.match(upload.intent ?? '', /\[generated:/);

    const claimedLeg: FlowStep = { action: 'workflow', goal: 'Complete the Personal Information form' };
    const claimed = { steps: [claimedLeg] as FlowStep[], cases: undefined as undefined };
    settleAcceptedFlowInputs(claimed, '3.1 Personal Information (Attachment) * is uploaded', evidence, 'HIR-EC-001');
    assert.deepEqual(claimed.steps, [claimedLeg]);
  });

  it('acceptance takes any offered value only for a required unnamed choice whose sheet value is a placeholder', () => {
    const leg: FlowStep = { action: 'workflow', goal: 'Complete the Payroll section\nPay Group = เลือกจากรายการ' };
    const flow = { steps: [leg] as FlowStep[], cases: undefined as undefined };

    const notes = settleAcceptedFlowInputs(
      flow,
      '3.1 Employee is created',
      'main\n  button "Pay Group" required',
      'HIR-EC-001',
    );

    const choice = flow.steps[0] as FlowStep & { selector?: string; value?: string; intent?: string; valueSource?: { kind: string } };
    assert.equal(choice.action, 'selectOption');
    assert.equal(choice.selector, 'role=button[name="Pay Group" i]');
    assert.equal(choice.value, ANY_OFFERED);
    assert.equal(choice.valueSource?.kind, 'generated');
    assert.match(choice.intent ?? '', /\[generated:/);
    assert.match(notes.join('; '), /required choice "Pay Group"/);
  });

  it('acceptance leaves a required choice alone when the sheet gives a real value', () => {
    const leg: FlowStep = { action: 'workflow', goal: 'Complete Payroll' };
    const flow = { steps: [leg] as FlowStep[], cases: undefined as undefined };

    settleAcceptedFlowInputs(flow, '3.1 Employee is created', 'button "Pay Group" required', 'HIR-EC-001', [
      { phase: null, key: 'Pay Group', value: 'Monthly' },
    ]);

    assert.deepEqual(flow.steps, [leg]);
  });

  it('acceptance never invents a choice for a field named by Expected output', () => {
    const leg: FlowStep = { action: 'workflow', goal: 'Complete Payroll' };
    const flow = { steps: [leg] as FlowStep[], cases: undefined as undefined };

    settleAcceptedFlowInputs(flow, '3.1 Pay Group = Monthly', 'button "Pay Group" required', 'HIR-EC-001', [
      { phase: null, key: 'Pay Group', value: 'เลือกจากรายการ' },
    ]);

    assert.deepEqual(flow.steps, [leg]);
  });

  it('acceptance never invents a choice for a control the tree does not mark required', () => {
    const leg: FlowStep = { action: 'workflow', goal: 'Pay Group = เลือกจากรายการ' };
    const flow = { steps: [leg] as FlowStep[], cases: undefined as undefined };

    settleAcceptedFlowInputs(flow, '3.1 Employee is created', 'button "Pay Group"', 'HIR-EC-001');

    assert.deepEqual(flow.steps, [leg]);
  });

  it('reads offered-choice placeholder words from the authoring vocabulary', () => {
    const rules = compileAuthoringRules(withOverride({ authoring: { offeredChoiceWords: ['fixture placeholder'] } }).authoring);
    assert.equal(rules.offeredChoice.test('fixture placeholder'), true);
    assert.equal(rules.offeredChoice.test('เลือกจากรายการ'), false);
  });

  it('places a required attachment before the workflow leg that names its section', () => {
    const first: FlowStep = { action: 'workflow', goal: 'Complete Employment Information' };
    const matching: FlowStep = { action: 'workflow', goal: 'Complete the Personal Information section' };
    const last: FlowStep = { action: 'workflow', goal: 'Review and submit the hire' };
    const flow = { steps: [first, matching, last] as FlowStep[], cases: undefined as undefined };

    settleAcceptedFlowInputs(
      flow,
      '3.1 Employee is created',
      'main\n  button "Personal Information (Attachment) *"',
      'HIR-EC-001',
    );

    assert.equal(flow.steps[0], first);
    assert.equal(flow.steps[1]?.action, 'upload');
    assert.equal(flow.steps[2], matching);
  });

  it('mints only the required attachment that Expected does not name', () => {
    const personal: FlowStep = { action: 'workflow', goal: 'Complete Personal Information' };
    const tax: FlowStep = { action: 'workflow', goal: 'Complete Tax Documents' };
    const flow = { steps: [personal, tax] as FlowStep[], cases: undefined as undefined };
    const evidence = [
      'main',
      '  button "Personal Information (Attachment) *"',
      '  button "Tax Document Upload *"',
    ].join('\n');

    settleAcceptedFlowInputs(
      flow,
      '3.1 Personal Information Attachment is uploaded',
      evidence,
      'HIR-EC-001',
    );

    const uploads = flow.steps.filter((step) => step.action === 'upload');
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0]?.selector, 'role=button[name="Tax Document Upload *" i]');
  });

  it('the pipeline ships the ML_01_04 shape on attempt 1 of 1: the workflow legs perform the script, the weak declared-controls note settles into a split', async () => {
    const log: string[] = [];
    const author = new FlowAuthor({
      model: stubModel({ name: 'ML_01_04 ลาป่วย 31 นาที (Hourly)', steps: legs.map((s) => ({ ...s })) }),
      projectContext: 'labels: "Type", "Leave", "Leave Type"',
      journeyTree: 'ANOTHER PAGE IN THIS JOURNEY — http://app.test/en/timeoff\n\nmain\n  tab "Me"\n  link "Leave request"\n  button "Leave Type"\n  button "Submit"\n  text "Sick Leave"\n  text "0h 31m"\n  text "Approved"',
      attempts: 1,
      onLog: (l) => log.push(l),
    });
    const authored = await author.author(caseText, undefined, { caseText });
    assert.equal(authored.flow.steps.filter((s) => s.action === 'workflow').length, 3);
    assert.match(authored.notes, /button "Leave Type" = "Sick Leave" performed deterministically before the leg/);
    assert.ok(log.some((l) => /weak claim, accepted with a note/.test(l)), 'accepted on the first ask, nothing refused');
  });
});

describe('requiredness is the tree\'s own token, not an asterisk in the name (HIR-EC-001, 2026-09-07)', () => {
  it('finds a required attachment whose name carries no asterisk', () => {
    const tree = [
      'region "Personal Identity*"',
      'heading "Contact*"',
      'button "File attachment area" required',
    ].join('\n');
    assert.deepEqual(requiredAttachmentControls(tree), [{ role: 'button', name: 'File attachment area' }]);
  });

  it('ignores an attachment control the page does not require, and a name that merely says "required"', () => {
    const tree = ['button "File attachment area"', 'textbox "Required documents note" required'].join('\n');
    assert.deepEqual(requiredAttachmentControls(tree), []);
  });

  it('still accepts the asterisked spelling, for a page that puts it on the control', () => {
    assert.deepEqual(requiredAttachmentControls('button "Personal Information (Attachment) *"'), [
      { role: 'button', name: 'Personal Information (Attachment) *' },
    ]);
  });
});

describe('a flow written from an expanded tree opens the form the same way (HIR-EC-001, 2026-09-07)', () => {
  const evidence = [
    `${EXPANDED_MARKER} role=button[name="Expand all" i]`,
    'main',
    '  button "Select Salutation" required',
  ].join('\n');

  it('inserts the click before the first step that touches a control', () => {
    const flow = {
      steps: [
        { action: 'goto', url: 'https://x/hire' },
        { action: 'selectOption', selector: 'role=button[name="Event Reason" i]', value: 'New Hire' },
      ] as FlowStep[],
      cases: undefined as undefined,
    };

    settleAcceptedFlowInputs(flow, '', evidence, 'HIR-EC-001');

    assert.equal(flow.steps.length, 3);
    const inserted = flow.steps[1] as FlowStep & { selector?: string; intent?: string };
    assert.equal(inserted.action, 'click');
    assert.equal(inserted.selector, 'role=button[name="Expand all" i]');
    assert.match(inserted.intent ?? '', /\[generated: the journey tree was read with the form expanded/);
  });

  it('adds nothing when the flow already clicks it, or when the capture expanded nothing', () => {
    const already = {
      steps: [
        { action: 'click', selector: 'role=button[name="Expand all" i]' },
        { action: 'selectOption', selector: 'role=button[name="X" i]', value: 'y' },
      ] as FlowStep[],
      cases: undefined as undefined,
    };
    settleAcceptedFlowInputs(already, '', evidence, 'C');
    assert.equal(already.steps.length, 2);

    const noMarker = { steps: [{ action: 'selectOption', selector: 'role=button[name="X" i]', value: 'y' }] as FlowStep[], cases: undefined as undefined };
    settleAcceptedFlowInputs(noMarker, '', 'main\n  button "X"', 'C');
    assert.equal(noMarker.steps.length, 1);
  });

  it('expandedControlIn reads the selector back, and nothing from a tree without the marker', () => {
    assert.equal(expandedControlIn(evidence), 'role=button[name="Expand all" i]');
    assert.equal(expandedControlIn('main\n  button "Expand all"'), null);
  });
});

describe('a cell that opens with a choosing verb is an instruction, not a value (HIR-EC-001, 2026-09-07)', () => {
  const evidence = ['main', '  button "Sub-District" required', '  button "Zone" required'].join('\n');

  it('takes the first offered option for an instruction the word list does not name', () => {
    const flow = {
      steps: [{ action: 'workflow', goal: 'Step 6: Sub-District = เลือกแขวงที่อยู่ใน District ที่เลือก; Zone = Z01' }] as FlowStep[],
      cases: undefined as undefined,
    };

    settleAcceptedFlowInputs(flow, '', evidence, 'HIR-EC-001');

    const picks = flow.steps.filter((s) => s.action === 'selectOption') as (FlowStep & { selector: string; value: string })[];
    assert.equal(picks.length, 1);
    assert.equal(picks[0]?.selector, 'role=button[name="Sub-District" i]');
    assert.equal(picks[0]?.value, ANY_OFFERED);
  });
});

describe('an Expected line that names a field without a value asserts behaviour, not a value (HIR-EC-001, 2026-09-07)', () => {
  const evidence = ['main', '  button "Sub-District" required', '  button "Employee Group" required'].join('\n');
  const goal = 'Step 6: Sub-District = เลือกแขวงที่อยู่ใน District ที่เลือก; Employee Group = เลือกจากรายการ';
  const expected = '6.2 ระบบกรอง Sub-District ตาม District ที่เลือก\n10.1 Employee Group = A - Permanent';

  it('fills the field the Expected output only mentions, and never the one it gives a value', () => {
    const flow = { steps: [{ action: 'workflow', goal }] as FlowStep[], cases: undefined as undefined };

    settleAcceptedFlowInputs(flow, expected, evidence, 'HIR-EC-001');

    const picks = flow.steps.filter((s) => s.action === 'selectOption') as (FlowStep & { selector: string })[];
    assert.deepEqual(picks.map((p) => p.selector), ['role=button[name="Sub-District" i]']);
  });

  it('expectedValuedFields reads only the pairs', () => {
    const valued = expectedValuedFields(expected);
    assert.deepEqual([...valued], ['employee group']);
    assert.equal(valued.has('sub-district'), false);
    // The prose mention reaches `expectedNamedFields` as the capitalised run
    // its regex can take from `ระบบกรอง Sub-District ตาม …` — enough to have
    // blocked the field before this split existed.
    assert.equal(expectedNamedFields(expected).has('sub'), true);
  });
});

describe('a required attachment is found on the tree the run actually captured', () => {
  // `tests/fixtures/ax-hire-form.txt` is the live SIT hire form as the harness
  // read it (2026-09-07, 288 nodes, sections expanded), one `formatAxNode`
  // line per node. It is here because the two previous versions of this rule
  // were each verified against a tree written by hand for the occasion, each
  // shipped green, and each did nothing on the real page — the repo's own rule
  // that a reader tested only against its own writer proves nothing.
  const tree = readFileSync(fileURLToPath(new URL('./fixtures/ax-hire-form.txt', import.meta.url)), 'utf8');

  it('names the one required dropzone, and the position that tells it from the other two', () => {
    // Three sections render an identical `button "Upload"`; only Personal
    // Information is marked required (`heading "Personal Information*"`), and
    // it is the second. Attaching to the first would file the document under
    // National ID and call the step green.
    assert.deepEqual(requiredAttachmentControls(tree), [
      { role: 'button', name: 'Upload', nth: 1, section: 'Personal Information' },
    ]);
  });

  it('the old rule found nothing here — no line carries both the requiredness and the attachment word', () => {
    const lines = tree.split('\n').filter((line) => /required|\*/.test(line) && /attachment|upload/i.test(line));
    assert.deepEqual(lines, [], 'if this ever holds a line, the fallback below is the rule that should fire');
  });

  it('mints one upload, addressed by position, before the leg whose goal names the section', () => {
    const identity: FlowStep = { action: 'workflow', goal: 'Fill the Identity section' };
    const personal: FlowStep = { action: 'workflow', goal: 'Fill the Personal Information section' };
    const flow = { steps: [identity, personal] as FlowStep[], cases: undefined as undefined };

    settleAcceptedFlowInputs(flow, '3.1 Employee is created with the keyed data', tree, 'HIR-EC-001');

    const upload = flow.steps.find((step) => step.action === 'upload') as
      | (FlowStep & { selector?: string; files?: readonly string[]; intent?: string })
      | undefined;
    assert.ok(upload, 'the sheet names no file, so the harness must supply one');
    assert.equal(upload.selector, 'role=button[name="Upload" i] >> nth=1');
    assert.equal(isFixtureSpec(upload.files?.[0] ?? ''), true);
    assert.match(upload.intent ?? '', /Personal Information/);
    assert.match(upload.intent ?? '', /\[generated:/);
    assert.equal(flow.steps.indexOf(upload) + 1, flow.steps.indexOf(personal), 'inserted immediately before the leg that names its section');
  });

  it('does not mint one the Expected output already claims — that file is the case\'s to name', () => {
    const leg: FlowStep = { action: 'workflow', goal: 'Fill the Personal Information section' };
    const flow = { steps: [leg] as FlowStep[], cases: undefined as undefined };
    settleAcceptedFlowInputs(flow, '3.1 The Personal Information attachment is uploaded', tree, 'HIR-EC-001');
    assert.deepEqual(flow.steps, [leg]);
  });

  it('falls back to the control\'s own line on a page that marks its controls properly', () => {
    const proper = 'main\nbutton "Upload passport" required\nbutton "Save"';
    assert.deepEqual(requiredAttachmentControls(proper), [{ role: 'button', name: 'Upload passport' }]);
  });
});

describe('a field is matched by its whole name, and a block is read item by item (2026-09-07, HIR-EC-001 run 12)', () => {
  const tree = readFileSync(fileURLToPath(new URL('./fixtures/ax-hire-form.txt', import.meta.url)), 'utf8');

  it('never types the sheet\'s data into a field that merely shares a fragment of the name', () => {
    // Every one of these was a live match under the two-way substring rule,
    // and every one of them runs, goes green and proves nothing — strictly
    // worse than the slow agent leg it replaces.
    const goal =
      'Step 3: กรอกข้อมูลตามค่าที่ระบุ ได้แก่ Date of Birth = 01 Jan 1990; Job Code = MKB12.12; ' +
      'Account Number = 1234567890; Employee Group = A - Permanent';
    const leg: FlowStep = { action: 'workflow', goal };
    const flow = { steps: [leg] as FlowStep[], cases: undefined as undefined };
    settleAcceptedFlowInputs(
      flow,
      '1.1 Date of Birth = 01 Jan 1990; 1.2 Job Code = MKB12.12; 1.3 Account Number = 1234567890; 1.4 Employee Group = A - Permanent',
      tree,
      'HIR-EC-001',
    );
    const selectors = flow.steps
      .filter((step) => step.action === 'fill' || step.action === 'selectOption')
      .map((step) => (step as { selector: string }).selector);
    for (const wrong of ['Region of Birth', 'Postal code', 'Number of Children', 'Select date']) {
      assert.equal(selectors.some((one) => one.includes(wrong)), false, `${wrong} is a different field`);
    }
  });

  it('lifts the Expected output\'s own fields out of a goal the sheet wrote as one `;`-joined line', () => {
    // Run 12's flow: 37 steps, three goals of five and six sheet steps each,
    // zero `fill`, zero `selectOption`, 1% of the page's controls exercised —
    // because both the Expected block and the goal arrive as ONE line and the
    // per-line parse produced field names like "Sep 2027; Company".
    const goal = 'Step 3 ถึง Step 7: กรอกข้อมูล Identity ตามค่าที่ระบุ ได้แก่ Event Reason = New Hire; Hire Date = 01 Sep 2027; Company = C001';
    const leg: FlowStep = { action: 'workflow', goal };
    const flow = { steps: [leg] as FlowStep[], cases: undefined as undefined };
    const notes = settleAcceptedFlowInputs(flow, '3.1 Hire Date = Today ตามค่าที่กรอก; 3.2 Event Reason = New Hire; 9.2 Company', tree, 'HIR-EC-001');

    const entries = flow.steps
      .filter((step) => step.action === 'fill' || step.action === 'selectOption')
      .map((step) => `${step.action} ${(step as { selector: string }).selector} = ${(step as { value?: string }).value}`);
    assert.ok(entries.includes('selectOption role=button[name="Event Reason" i] = New Hire'), entries.join(' / '));
    // The native date input, addressed through the label engine: 15 ms on the
    // live form, against 297,771 ms for the `role=date` spelling.
    assert.ok(entries.includes('fill internal:label="Hire Date"i = 01 Sep 2027'), entries.join(' / '));
    assert.ok(entries.includes('selectOption role=button[name="Company" i] = C001'), entries.join(' / '));
    assert.ok((notes ?? []).some((note) => /performed deterministically before the leg/.test(note)));
  });

  it('leaves a pair in the leg when the tree names no control for it — honest, not guessed', () => {
    const leg: FlowStep = { action: 'workflow', goal: 'Step 9: Work Schedule = D05H0800' };
    const flow = { steps: [leg] as FlowStep[], cases: undefined as undefined };
    settleAcceptedFlowInputs(flow, '9.2 Work Schedule = D05H0800', tree, 'HIR-EC-001');
    assert.equal(flow.steps.some((step) => step.action === 'fill' || step.action === 'selectOption'), false);
  });
});

describe('the wizard\'s later pages are captured, and their fields ordered behind the click that reaches them (2026-09-07, HIR-EC-001)', () => {
  // `tests/fixtures/ax-hire-form-2page.txt` is the live capture of BOTH pages
  // of the hire wizard as `journeyTreeSection` composes them — page 1 (288
  // nodes), the `WIZARD ADVANCED` marker naming the control, then page 2 (347
  // nodes) once its own sections were expanded. Probed before it was written:
  // Next on the blank form goes to `?step=2` and submits nothing.
  const twoPage = readFileSync(fileURLToPath(new URL('./fixtures/ax-hire-form-2page.txt', import.meta.url)), 'utf8');
  const goal =
    'Step 8 ถึง Step 13: กรอกข้อมูล Employment ตาม Test data ได้แก่ Position = Studio Traffic Staff & Admin; ' +
    'Employee Group = A; Work Schedule = D05H0800; Job Code = MKB12.12';
  const expected = '9.2 Position; 10.1 Employee Group = A; 9.2 Work Schedule; 9.2 Job Code';

  const settled = (): { steps: FlowStep[] } => {
    const leg: FlowStep = { action: 'workflow', goal };
    const flow = { steps: [leg] as FlowStep[], cases: undefined as undefined };
    settleAcceptedFlowInputs(flow, expected, twoPage, 'HIR-EC-001');
    return flow;
  };

  it('reads the control the second page names, which the first page has not got', () => {
    assert.equal(advancedControlIn(twoPage), 'role=button[name="Next" i]');
    const selectors = settled().steps.filter((s) => s.action === 'selectOption').map((s) => (s as { selector: string }).selector);
    for (const field of ['Position', 'Employee Group', 'Work Schedule']) {
      assert.ok(selectors.includes(`role=button[name="${field}" i]`), `${field}: ${selectors.join(' / ')}`);
    }
  });

  it('puts the click that advances the wizard before every field of the page behind it', () => {
    const steps = settled().steps;
    const advance = steps.findIndex((s) => s.action === 'click' && (s as { selector?: string }).selector === 'role=button[name="Next" i]');
    assert.notEqual(advance, -1, 'the fields below resolve nothing until it is clicked');
    for (const [at, step] of steps.entries()) {
      if (step.action !== 'selectOption') continue;
      assert.ok(at > advance, `${(step as { selector: string }).selector} is on page 2 and must come after the advance`);
    }
  });

  it('never fills a control the tree marks disabled — that value is derived, not keyed', () => {
    const selectors = settled().steps.filter((s) => s.action === 'fill').map((s) => (s as { selector: string }).selector);
    assert.equal(selectors.some((one) => one.includes('Job Code')), false);
  });

  it('counts an attachment\'s position within its own page, because that is the ordinal the run sees', () => {
    // Page 1 renders three `button "Upload"` and page 2 renders its own. When
    // the browser is on page 2 the selector matches page 2's alone, so a
    // whole-evidence ordinal would address the wrong dropzone.
    assert.deepEqual(requiredAttachmentControls(twoPage), [
      { role: 'button', name: 'Upload', nth: 1, section: 'Personal Information' },
      { role: 'button', name: 'Upload', nth: 0, section: 'Job Information', later: true },
    ]);
  });

  it('still refuses every fragment collision, with twice the tree to collide in', () => {
    const collisions: FlowStep = {
      action: 'workflow',
      goal: 'Step 3: Date of Birth = 01 Jan 1990; Job Code = MKB12.12; Account Number = 1234567890; Hire Date = 01 Sep 2027',
    };
    const flow = { steps: [collisions] as FlowStep[], cases: undefined as undefined };
    settleAcceptedFlowInputs(
      flow,
      '1.1 Date of Birth = 01 Jan 1990; 1.2 Job Code = MKB12.12; 1.3 Account Number = 1234567890; 1.4 Hire Date = 01 Sep 2027',
      twoPage,
      'HIR-EC-001',
    );
    const selectors = flow.steps
      .filter((s) => s.action === 'fill' || s.action === 'selectOption')
      .map((s) => (s as { selector: string }).selector);
    for (const wrong of ['Region of Birth', 'Postal code', 'Number of Children', 'Select date', 'Select Position', 'Select Cost Center']) {
      assert.equal(selectors.some((one) => one.includes(wrong)), false, `${wrong}: ${selectors.join(' / ')}`);
    }
    assert.ok(selectors.includes('internal:label="Hire Date"i'), selectors.join(' / '));
  });
});

describe('the acceptance reads the whole tree, because narrowing drops the marker that orders it (2026-09-07)', () => {
  const twoPage = readFileSync(fileURLToPath(new URL('./fixtures/ax-hire-form-2page.txt', import.meta.url)), 'utf8');
  const goal =
    'Step 8: Position = Studio Traffic Staff & Admin; Cost Center = C00132653; Work Schedule = D05H0800';
  const expected = '9.2 Position; 9.1 Cost Center; 9.2 Work Schedule';

  const lift = (evidence: string): FlowStep[] => {
    const leg: FlowStep = { action: 'workflow', goal };
    const flow = { steps: [leg] as FlowStep[], cases: undefined as undefined };
    settleAcceptedFlowInputs(flow, expected, evidence, 'HIR-EC-001');
    return flow.steps;
  };

  it('a marker ranked away turns page 2 into page 1 — the hazard the pin closes', () => {
    // Unpinned and cut hard, `WIZARD ADVANCED` is just another line to rank,
    // and without it every page-2 control reads as a page-1 control. Live,
    // that put Position, Cost Center and six more BEFORE the click that
    // reaches their page, with no click written at all.
    const unpinned = focusTreeText(twoPage, expected, 80, 1).text;
    assert.equal(unpinned.includes(ADVANCED_MARKER), false);
    assert.equal(advancedControlIn(unpinned), null);
    const steps = lift(unpinned);
    assert.ok(steps.some((s) => s.action === 'selectOption'), 'the fields are still lifted…');
    assert.equal(steps.some((s) => s.action === 'click'), false, '…but nothing reaches their page');
  });

  it('the marker survives narrowing at any budget once it is pinned', () => {
    for (const budget of [20, 80, JOURNEY_TREE_MAX_LINES]) {
      const kept = focusTreeText(twoPage, expected, budget, 1, STRUCTURAL_EVIDENCE_LINE).text;
      assert.equal(advancedControlIn(kept), 'role=button[name="Next" i]', `budget ${budget}`);
    }
  });

  it('the budget shows the whole form, and the environment may lower it', () => {
    // 80 of 743 was 11% of the page, and the review said so in its own words.
    assert.equal(focusTreeText(twoPage, expected, journeyTreeMaxLines(), 1, STRUCTURAL_EVIDENCE_LINE).text, twoPage);
    assert.equal(journeyTreeMaxLines({ WOWLIDATOR_JOURNEY_TREE_MAX_LINES: '120' }), 120);
    assert.equal(journeyTreeMaxLines({ WOWLIDATOR_JOURNEY_TREE_MAX_LINES: 'lots' }), JOURNEY_TREE_MAX_LINES);
    assert.equal(journeyTreeMaxLines({}), JOURNEY_TREE_MAX_LINES);
  });

  it('given the whole tree, every page-2 field sits behind the click that reaches it', () => {
    const steps = lift(twoPage);
    const advance = steps.findIndex((s) => s.action === 'click' && (s as { selector?: string }).selector === 'role=button[name="Next" i]');
    assert.notEqual(advance, -1);
    for (const [at, step] of steps.entries()) {
      if (step.action !== 'selectOption') continue;
      assert.ok(at > advance, `${(step as { selector: string }).selector} must come after the advance`);
    }
  });
});

describe('a wording claim is read from what the case CLAIMS, and a pattern is not a data row (2026-09-07, HIR-EC-001)', () => {
  const tree = readFileSync(fileURLToPath(new URL('./fixtures/ax-hire-form-2page.txt', import.meta.url)), 'utf8');
  // Run 14, three attempts, no flow. The row is a data-entry case whose
  // nineteen Expected lines never mention wording — but its Test data carries
  // the aside "ถ้าไม่แนบแล้วกด Next ให้บันทึกข้อความที่ระบบแสดง", and `ข้อความ`
  // in it classified the whole row as a claim about spelling.
  const hirCase = [
    'Test case: HIR-EC-001 New Hire Key-in success',
    'Test data:',
    '- Attachment: (ช่องนี้มีเครื่องหมายบังคับ ถ้าไม่แนบแล้วกด Next ให้บันทึกข้อความที่ระบบแสดง)',
    'Expected output:',
    '14.1 ระบบสร้าง Employee ID เป็นตัวเลข 8 หลัก โดยหลักแรกเป็น 2',
    '14.2 Employee Status = Active',
  ].join('\n');
  const wordingCase = ['Test case: PL_02_02 ตรวจสอบการสะกด', 'Expected output:', '1.1 ข้อความสะกดถูกต้องตรงตาม Spec'].join('\n');
  const pattern: FlowStep[] = [{ action: 'expectText', selector: 'role=textbox[name="Employee ID" i]', value: '/\\b2[0-9]{7}\\b/', intent: '14.1' }];
  const literal: FlowStep[] = [{ action: 'expectVisible', selector: 'text=Medical Reimbursement', intent: '1.1' }];
  const refused = (steps: FlowStep[], text: string): boolean =>
    wordingClaimAssertsDataValue(text, steps, tree, undefined, text) !== null;

  it('an aside in Test data does not make a data-entry case a claim about spelling', () => {
    assert.equal(refused(literal, hirCase), false);
    assert.equal(refused(pattern, hirCase), false);
  });

  it('a regex asserts a FORM, and no page can be quoted for one', () => {
    // Expected 14.1 states the pattern in words; the regex is the only thing
    // that checks it. Refusing it left the row with nothing to assert for
    // 14.1 — which `unassertedExpectedItems` then refused it for. Two lints,
    // opposite demands, three attempts, no flow.
    assert.equal(refused(pattern, wordingCase), false);
  });

  it('still refuses a data value on a case that really is about wording (PL_02_02)', () => {
    assert.equal(refused(literal, wordingCase), true);
  });
});

describe('a refusal names the field\'s real input, and a sign-in reaches the sign-in page (2026-09-07, run 15)', () => {
  const tree = readFileSync(fileURLToPath(new URL('./fixtures/ax-hire-form-2page.txt', import.meta.url)), 'utf8');

  it('points at the same field under another role, not at six unrelated textboxes', () => {
    // The hire form renders `textbox "Hire Date" readonly` — the picker's
    // display — beside `Date "Hire Date"`, the input. The remedy used to list
    // the first six writable textboxes on the page, none of them this
    // field's: it told the model to fill "Username" for a Hire Date.
    const steps: FlowStep[] = [{ action: 'fill', selector: 'role=textbox[name="Hire Date" i]', value: '2027-09-01' }];
    const hit = fillsReadOnlyNode(steps, tree);
    assert.deepEqual(hit?.input, { role: 'date', name: 'Hire Date' });
  });

  it('says nothing when the field has no other input to offer', () => {
    const flat = 'main\ntextbox "Reference" readonly\ntextbox "Notes"';
    const steps: FlowStep[] = [{ action: 'fill', selector: 'role=textbox[name="Reference" i]', value: 'x' }];
    assert.equal(fillsReadOnlyNode(steps, flat)?.input, null);
  });

  it('a Destination that is the sign-in page is reached by signing in, and setup counts', () => {
    const caseText = 'Destination: https://app.example.com/en/login\nSteps:\n1. sign in';
    assert.equal(ignoresMenuPath([{ action: 'signIn', as: 'HR_ADMIN_ACCOUNT' }], caseText), null);
    assert.equal(
      ignoresMenuPath([{ action: 'goto', url: 'https://app.example.com/en/login' }, { action: 'click', selector: 'x' }], caseText),
      null,
      'the opening goto belongs in setup, and setup is passed in with the body',
    );
    assert.deepEqual(ignoresMenuPath([{ action: 'click', selector: 'x' }], caseText), {
      kind: 'destination',
      wanted: 'https://app.example.com/en/login',
    });
  });

  it('a Destination that is NOT the sign-in page still has to be navigated to', () => {
    const caseText = 'Destination: https://app.example.com/en/admin/hire';
    assert.deepEqual(ignoresMenuPath([{ action: 'signIn', as: 'HR_ADMIN_ACCOUNT' }], caseText), {
      kind: 'destination',
      wanted: 'https://app.example.com/en/admin/hire',
    });
  });
});
