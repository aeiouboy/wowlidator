/**
 * Action authority (Phase B of docs/research/commerce-agents-patterns.md):
 * the typed `blocked` outcome, the provenance ledger, the host's mutation
 * policy, and how a held action travels through the record, the proof, the
 * report and the exit code.
 *
 * Two tiers, the usual split. The gate, the ledger and the manifest parser
 * are pure and run always. Whether the LOOP actually withholds the click —
 * the browser title never changing, the action count staying at zero — is a
 * fact about a real page under a scripted model, and is CDP-gated like the
 * other loop suites.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IRREVERSIBLE_CATEGORIES,
  MUTATION_CATEGORIES,
  MutationPolicyError,
  TargetProvenance,
  controlNameFromAriaSnapshot,
  gateMutation,
  mutationCategoryFor,
  mutationCategoryOf,
  mutationPolicyFromEnv,
  mutationTargets,
  parseMutationPolicy,
  type MutationPolicy,
  type MutationRequest,
} from '../src/orchestrator/mutation-policy.js';
import {
  MutationBlockedError,
  WorkflowAgent,
  type AgentDecision,
  type AgentObservation,
} from '../src/orchestrator/workflow-agent.js';
import { EXIT, classifyError, exitCodeFor, harnessOnly, neverRan, suiteExit } from '../src/cli/exit.js';
import { runFlow, withPage, type Flow } from '../src/engine/runner.js';
import type { ActionOutcome, AgentAction, BlockedOutcome, ProofBundle, ProofStep } from '../src/engine/proof-bundle.js';
import { renderReport } from '../src/reporter/html-reporter.js';
import { renderCatalogReport } from '../src/reporter/catalog-report.js';
import type { AxNode } from '../src/healer/jit-healer.js';

const node = (role: string, name: string, value = ''): AxNode => ({
  role, name, value, description: '', disabled: false, checked: false, url: '',
});

/** The be100 table the PL_03_18 incident happened on: two rows, two Delete buttons. */
const ROWS: AxNode[] = [
  node('heading', 'Plans'),
  node('row', 'TH_MED_001 Delete'),
  node('cell', 'TH_MED_001'),
  node('button', 'Delete'),
  node('row', 'PL_03_18 Delete'),
  node('cell', 'PL_03_18'),
  node('button', 'Delete'),
];

const click = (selector: string) => ({ action: 'click', selector, value: '', url: '' });

function ledgerShowing(nodes: readonly AxNode[], url = 'http://x.test/en/rows'): TargetProvenance {
  const ledger = new TargetProvenance();
  ledger.observe(nodes, url);
  return ledger;
}

// --- classification ----------------------------------------------------------

describe('mutationCategoryOf — which clicks a policy governs', () => {
  it('uses the observed accessible name before the model selector', () => {
    assert.equal(mutationCategoryFor(click('role=button[name="Next"]'), 'Submit order'), 'submit');
    assert.equal(mutationCategoryFor(click('role=button[name="Submit"]'), 'Next'), 'submit');
    assert.equal(mutationCategoryFor(click('role=button[name="Next"]'), 'Next'), null);
  });
  it('reads the category off the control the click lands on, in English and Thai', () => {
    assert.equal(mutationCategoryOf(click('role=row[name="PL_03_18" i] >> role=button[name="Delete" i]')), 'delete');
    assert.equal(mutationCategoryOf(click('role=button[name="ปิดใช้งาน"]')), 'delete');
    assert.equal(mutationCategoryOf(click('role=button[name="Approve" i]')), 'approve');
    assert.equal(mutationCategoryOf(click('role=button[name="อนุมัติ"]')), 'approve');
    assert.equal(mutationCategoryOf(click('role=button[name="Submit"]')), 'submit');
    assert.equal(mutationCategoryOf(click('role=dialog >> role=button[name="Confirm"]')), 'submit');
    assert.equal(mutationCategoryOf({ action: 'press', selector: 'role=button[name="Delete"]', value: 'Enter', url: '' }), 'delete');
  });

  it('leaves every ordinary action alone', () => {
    assert.equal(mutationCategoryOf(click('role=button[name="Edit" i]')), null);
    assert.equal(mutationCategoryOf(click('role=link[name="Continue"]')), null);
    assert.equal(mutationCategoryOf({ action: 'fill', selector: 'role=textbox[name="Delete reason"]', value: 'x', url: '' }), null);
    assert.equal(mutationCategoryOf({ action: 'press', selector: '', value: 'Enter', url: '' }), null, 'a bare key names no target');
    assert.equal(mutationCategoryOf({ action: 'goto', selector: '', value: '', url: 'http://x.test/' }), null);
    assert.equal(mutationCategoryOf(click('input[type="submit"]')), null, 'a CSS selector names nothing to read');
  });

  it('reads the actual accessible name captured from a CSS-selected control', () => {
    assert.equal(controlNameFromAriaSnapshot('- button "Delete"'), 'Delete');
    assert.equal(controlNameFromAriaSnapshot('- button "Edit"'), 'Edit');
    assert.equal(controlNameFromAriaSnapshot('- textbox "Delete reason"'), 'Delete reason');
    assert.equal(controlNameFromAriaSnapshot(''), null);
  });

  it('agrees with the record types about which categories exist', () => {
    assert.deepEqual([...MUTATION_CATEGORIES], ['submit', 'delete', 'approve']);
    assert.deepEqual([...IRREVERSIBLE_CATEGORIES].sort(), ['approve', 'delete']);
  });
});

describe('mutationTargets — what provenance must vouch for', () => {
  const goal = 'delete the plan PL_03_18';
  it('is the row the selector scopes to, never the verb', () => {
    assert.deepEqual(mutationTargets(click('role=row[name="PL_03_18" i] >> role=button[name="Delete" i]'), goal), ['PL_03_18']);
    assert.deepEqual(mutationTargets(click('text=PL_03_18 >> xpath=.. >> role=button[name="Delete" i]'), goal), ['PL_03_18']);
    // The goal's own spelling rides along when the selector carries it, so
    // provenance is asked about the row the sheet named, not only the words
    // the model chose to scope by.
    assert.deepEqual(
      mutationTargets(click('role=row[name="Medical Reimbursement" i] >> role=button[name="Delete" i]'), 'delete the plan "Medical Reimbursement (ICU)"'),
      ['Medical Reimbursement', 'Medical Reimbursement (ICU)'],
    );
  });
  it('does not mistake the destructive control label for a target scope', () => {
    assert.deepEqual(mutationTargets(click('role=button[name="Delete" i] >> nth=0'), 'delete the first draft'), []);
  });
});

// --- the ledger --------------------------------------------------------------

describe('TargetProvenance — fed by observation, and only observation', () => {
  it('knows what it has seen, and what it sees now', () => {
    const ledger = new TargetProvenance();
    assert.equal(ledger.observedThisSession('PL_03_18'), false);
    assert.equal(ledger.inLatestSnapshot('PL_03_18'), false, 'nothing captured yet');
    ledger.observe(ROWS, 'http://x.test/en/rows');
    assert.equal(ledger.observedThisSession('PL_03_18'), true);
    assert.equal(ledger.inLatestSnapshot('pl_03_18'), true, 'case does not matter');
    ledger.observe([node('heading', 'Plans'), node('cell', 'TH_MED_001')], 'http://x.test/en/rows?page=2');
    assert.equal(ledger.observedThisSession('PL_03_18'), true, 'still seen this session');
    assert.equal(ledger.inLatestSnapshot('PL_03_18'), false, 'but gone from the latest snapshot');
    const facts = ledger.facts(['PL_03_18', 'TH_MED_001']);
    assert.deepEqual(facts.observedThisSession, ['PL_03_18', 'TH_MED_001']);
    assert.deepEqual(facts.inLatestSnapshot, ['TH_MED_001']);
    assert.equal(facts.latestSnapshotUrl, 'http://x.test/en/rows?page=2');
    assert.ok(facts.latestSnapshotAt);
  });

  it('forgets everything on reset', () => {
    const ledger = ledgerShowing(ROWS);
    ledger.reset();
    assert.equal(ledger.observedThisSession('PL_03_18'), false);
    assert.equal(ledger.facts(['PL_03_18']).latestSnapshotAt, null);
  });
});

// --- the gate ----------------------------------------------------------------

describe('gateMutation — capability, provenance, approval, in that order', () => {
  const goal = 'delete the plan PL_03_18';
  const scoped = click('role=row[name="PL_03_18" i] >> role=button[name="Delete" i]');
  const gate = (policy: MutationPolicy | null, provenance: TargetProvenance, decision = scoped, approve?: (r: MutationRequest) => boolean) =>
    gateMutation({ decision, goal, url: 'http://x.test/en/rows', policy, provenance, approve });

  it('holds an observed, scoped delete when no host approval or manifest exists', async () => {
    const held = await gate(null, ledgerShowing(ROWS));
    assert.equal(held?.kind, 'blocked');
    assert.equal(held?.reason, 'approval');
    assert.equal(held?.rule, 'approval-missing');
    assert.equal(held?.policySource, null);
  });

  it('holds a CSS-selected destructive control when it has no record scope', async () => {
    const held = await gateMutation({
      decision: click('#delete-button'),
      goal: 'delete the first draft',
      url: 'http://x.test/en/rows',
      policy: { approved: [{ category: 'delete' }] },
      provenance: ledgerShowing(ROWS),
      observedControlName: 'Delete',
    });
    assert.equal(held?.kind, 'blocked');
    assert.equal(held?.reason, 'provenance');
    assert.equal(held?.rule, 'destructive-unscoped');
    assert.equal(held?.target, null);
  });

  it('lets an observed, scoped delete through when the host explicitly approves it without a manifest', async () => {
    let approvals = 0;
    assert.equal(await gate(null, ledgerShowing(ROWS), scoped, () => { approvals += 1; return true; }), null);
    assert.equal(approvals, 1);
  });

  it('holds a delete whose target this session never observed — the goal naming it is not evidence', async () => {
    const held = await gate(null, ledgerShowing([node('heading', 'Plans'), node('cell', 'TH_MED_001')]));
    assert.equal(held?.kind, 'blocked');
    assert.equal(held?.reason, 'provenance');
    assert.equal(held?.rule, 'target-never-observed');
    assert.equal(held?.target, 'PL_03_18');
    assert.equal(held?.category, 'delete');
    assert.equal(held?.policySource, null);
    assert.deepEqual(held?.provenance?.observedThisSession, []);
  });

  it('holds a delete whose target was seen earlier but is not in the latest snapshot', async () => {
    const ledger = ledgerShowing(ROWS);
    ledger.observe([node('heading', 'Plans')], 'http://x.test/en/rows?filter=none');
    const held = await gate(null, ledger);
    assert.equal(held?.rule, 'target-not-in-latest-snapshot');
    assert.equal(held?.reason, 'provenance');
    assert.deepEqual(held?.provenance?.observedThisSession, ['PL_03_18']);
    assert.deepEqual(held?.provenance?.inLatestSnapshot, []);
  });

  it('holds a category the policy denies, before it looks at the page', async () => {
    const held = await gate({ deny: ['delete'], source: 'test' }, new TargetProvenance());
    assert.equal(held?.reason, 'capability');
    assert.equal(held?.rule, 'policy-deny');
    assert.equal(held?.policySource, 'test');
    assert.equal(held?.provenance, undefined, 'no provenance facts — the page was never consulted');
  });

  it('holds a category an allow-list leaves out', async () => {
    const held = await gate({ allow: ['submit'] }, ledgerShowing(ROWS));
    assert.equal(held?.rule, 'policy-allow-list');
    assert.equal(held?.reason, 'capability');
  });

  it('holds an irreversible action a policy allows but pre-approves nothing for', async () => {
    const held = await gate({ allow: ['delete'] }, ledgerShowing(ROWS));
    assert.equal(held?.reason, 'approval');
    assert.equal(held?.rule, 'approval-missing');
    assert.match(held?.message ?? '', /approved/);
  });

  it('lets an approved manifest entry through — by target, or for any target', async () => {
    assert.equal(await gate({ allow: ['delete'], approved: [{ category: 'delete', target: 'PL_03_18' }] }, ledgerShowing(ROWS)), null);
    assert.equal(await gate({ approved: [{ category: 'delete' }] }, ledgerShowing(ROWS)), null);
    const other = await gate({ approved: [{ category: 'delete', target: 'TH_MED_001' }] }, ledgerShowing(ROWS));
    assert.equal(other?.rule, 'approval-missing', 'an approval for another row is not one for this row');
  });

  it('asks the host when the manifest is silent, and records a refusal as one', async () => {
    const asked: MutationRequest[] = [];
    assert.equal(await gate({ allow: ['delete'] }, ledgerShowing(ROWS), scoped, (r) => { asked.push(r); return true; }), null);
    assert.deepEqual(asked[0]?.targets, ['PL_03_18']);
    assert.equal(asked[0]?.category, 'delete');
    const held = await gate({ allow: ['delete'] }, ledgerShowing(ROWS), scoped, () => false);
    assert.equal(held?.rule, 'approval-refused');
    assert.equal(held?.reason, 'approval');
  });

  it('never gates an ordinary action, however strict the policy', async () => {
    const strict: MutationPolicy = { allow: [], deny: ['submit', 'delete', 'approve'] };
    const empty = new TargetProvenance();
    assert.equal(await gate(strict, empty, click('role=button[name="Edit" i]')), null);
    assert.equal(await gate(strict, empty, click('role=link[name="Continue"]')), null);
    assert.equal(await gate(strict, empty, { action: 'fill', selector: 'role=textbox[name="Name"]', value: 'x', url: '' }), null);
  });

  it('gates a submit by capability only — provenance and approval are for the irreversible', async () => {
    assert.equal(await gate(null, new TargetProvenance(), click('role=button[name="Submit"]')), null);
    assert.equal(await gate({ allow: ['submit'] }, new TargetProvenance(), click('role=button[name="Submit"]')), null);
    assert.equal((await gate({ deny: ['submit'] }, new TargetProvenance(), click('role=button[name="Submit"]')))?.rule, 'policy-deny');
  });
});

// --- the manifest ------------------------------------------------------------

describe('parseMutationPolicy / mutationPolicyFromEnv', () => {
  it('reads a manifest, and names its source', () => {
    const policy = parseMutationPolicy('{"allow":["submit","delete"],"deny":["approve"],"approved":[{"category":"delete","target":"SIT_DUP_DOC"}]}', 'env');
    assert.deepEqual(policy, { allow: ['submit', 'delete'], deny: ['approve'], approved: [{ category: 'delete', target: 'SIT_DUP_DOC' }], source: 'env' });
  });
  it('refuses a manifest it cannot trust rather than dropping the part it could not read', () => {
    assert.throws(() => parseMutationPolicy('{"deny":["drop-table"]}'), MutationPolicyError);
    assert.throws(() => parseMutationPolicy('["delete"]'), MutationPolicyError);
    assert.throws(() => parseMutationPolicy('{not json'), MutationPolicyError);
    assert.throws(() => parseMutationPolicy('{"approved":[{"target":"x"}]}'), MutationPolicyError);
    assert.throws(() => parseMutationPolicy('{"denny":["delete"]}'), MutationPolicyError);
  });
  it('is absent when the variable is unset, and a usage fault when it is unreadable', () => {
    assert.equal(mutationPolicyFromEnv({}), null);
    assert.equal(mutationPolicyFromEnv({ WOWLIDATOR_MUTATION_POLICY: '  ' }), null);
    assert.equal(mutationPolicyFromEnv({ WOWLIDATOR_MUTATION_POLICY: '{"deny":["delete"]}' })?.source, 'env');
    let caught: unknown;
    try { mutationPolicyFromEnv({ WOWLIDATOR_MUTATION_POLICY: 'nope' }); } catch (error) { caught = error; }
    assert.equal(classifyError(caught), EXIT.usage);
  });
});

// --- the record, the proof, the report, the exit code ------------------------

const HELD: BlockedOutcome = {
  kind: 'blocked',
  reason: 'capability',
  rule: 'policy-deny',
  message: 'the run\'s mutation policy denies "delete" — "role=row[name="PL_03_18" i] >> role=button[name="Delete" i]" would delete and was not performed',
  category: 'delete',
  target: 'PL_03_18',
  policySource: 'test',
};

function agentAction(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    index: 0, action: 'click', selector: 'role=row[name="PL_03_18" i] >> role=button[name="Delete" i]', value: null,
    url: 'http://x.test/en/rows', reasoning: 'delete the row', ok: false, error: HELD.message, durationMs: 3, outcome: HELD, ...overrides,
  };
}

function heldBundle(): ProofBundle {
  const workflow: ProofStep = {
    index: 1, action: 'workflow', selector: null, resolvedSelector: null, resolution: null, status: 'error',
    startedAt: '2026-09-05T09:00:01.000Z', durationMs: 900, url: 'http://x.test/en/rows',
    detail: { goal: 'delete the plan PL_03_18', turns: 1 },
    agent: {
      goal: 'delete the plan PL_03_18', model: 'stub', success: false,
      summary: `agent blocked (capability): ${HELD.message}`, actions: [agentAction()], turns: 1, maxSteps: null, latencyMs: 900, blocked: HELD,
    },
    blocked: HELD,
    error: `workflow blocked (capability, policy-deny): ${HELD.message}`,
  };
  return {
    runId: 'run-held', name: 'PL_03_18', status: 'error',
    startedAt: '2026-09-05T09:00:00.000Z', finishedAt: '2026-09-05T09:00:02.000Z', durationMs: 2_000,
    cdpUrl: 'http://localhost:9222', cachePath: null, healerModel: null,
    summary: {
      totalSteps: 2, passed: 1, failed: 1,
      frontend: { steps: 2, passed: 1, failed: 1, defects: 0 }, backend: { steps: 0, passed: 0, failed: 0, defects: 0 },
      fastPath: 1, caseRetries: 0, cacheHits: 0, jitHeals: 0, dialogsDismissed: 0, agentTakeovers: 1, visualChecks: 0, visualFailures: 0,
      dataRetries: 0, apiRequests: 0, apiFailures: 0, dbChecks: 0, dbFailures: 0, networkCalls: 0, networkFailures: 0, backendBlocked: 0,
      healUnavailable: 0, networkDropped: 0, healLatencyMs: 0, agentLatencyMs: 900, inputTokens: 0, outputTokens: 0, defects: 0,
    },
    steps: [
      { index: 0, action: 'goto', selector: null, resolvedSelector: null, resolution: null, status: 'passed', startedAt: '2026-09-05T09:00:00.000Z', durationMs: 300, url: 'http://x.test/en/rows' },
      workflow,
    ],
    defects: [],
    error: `run completed with 1 error:\n  ERROR: workflow — ${workflow.error}`,
  };
}

describe('a held action is typed on the record, not only worded', () => {
  it('is a discriminated outcome beside the boolean', () => {
    const outcome: ActionOutcome = agentAction().outcome ?? { kind: 'ok' };
    assert.equal(outcome.kind, 'blocked');
    if (outcome.kind === 'blocked') {
      assert.equal(outcome.reason, 'capability');
      assert.equal(outcome.rule, 'policy-deny');
      assert.equal(outcome.target, 'PL_03_18');
    }
    const thrown = new MutationBlockedError(HELD);
    assert.equal(thrown.name, 'MutationBlockedError');
    assert.equal(thrown.blocked, HELD);
  });
});

describe('a held leg is no verdict — exit code, suite roll-up, report, panel', () => {
  const bundle = heldBundle();

  it('scores blocked, never failed, and exits as the environment family', () => {
    assert.equal(neverRan(bundle), null, 'a step did break — this is not the never-ran shape');
    assert.match(harnessOnly(bundle) ?? '', /^blocked \(capability, policy-deny\) — the harness withheld the action; the application was never asked/);
    assert.equal(exitCodeFor(bundle), EXIT.environment);
    assert.equal(suiteExit([{ name: 'PL_03_18', verdict: 'blocked', bundle, reason: harnessOnly(bundle) ?? undefined }]), EXIT.environment);
    assert.equal(classifyError(new Error(bundle.steps[1]?.error ?? '')), EXIT.environment);
    assert.equal(bundle.defects.length, 0, 'no defect was filed against the application');
  });

  it('shows the typed reason in the HTML report, as a hold and not as a failure', () => {
    const html = renderReport(bundle);
    assert.match(html, /Held by the run's rules — no verdict about the application/);
    assert.match(html, /held · capability/);
    assert.match(html, /policy-deny/);
    assert.match(html, /Workflow agent was held by the run's rules/);
    assert.doesNotMatch(html, /Workflow goal not reached/);
    assert.doesNotMatch(html, /Defects filed/);
  });

  it('shows the hold in the catalog report', () => {
    const html = renderCatalogReport({
      title: 'held', runKey: null, generatedAt: '2026-09-05T09:00:03.000Z',
      cases: [{ id: 'PL_03_18', name: 'PL_03_18', scenario: 'PL_03', verdict: 'blocked', status: 'error', reason: harnessOnly(bundle), bundle, history: [] }],
    });
    assert.match(html, /held · capability/);
    assert.match(html, /no verdict about the application/);
  });
});

// --- the loop, against a real page --------------------------------------------

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

/** A model that answers from a script, and records what it was asked. The last answer repeats. */
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

const SCOPED_DELETE = 'text=PL_03_18 >> xpath=.. >> role=button[name="Delete" i]';

describe('the loop withholds a mutation before the browser is touched (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;

  before(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const rows =
        '<table><tr><td>TH_MED_001</td><td><button onclick="document.title=\'deleted TH_MED_001\'">Delete</button></td></tr>' +
        '<tr id="pl"><td>PL_03_18</td><td><button id="delete-pl" onclick="document.title=\'deleted PL_03_18\'">Delete</button></td></tr></table>';
      res.end(
        path === '/en/rows'
          ? `<title>plans</title><h1>Plans</h1>${rows}`
          : path === '/en/vanish'
            ? // The row is on screen until "Hide" removes it — the shape of a
              // filter, a page change, or a delete already done.
              `<title>plans</title><h1>Plans</h1><button onclick="document.getElementById('pl').remove()">Hide</button>${rows}`
            : path === '/en/done'
              ? '<h1>Done</h1>'
              : '<title>start</title><h1>Start</h1><a href="/en/done">Continue</a>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it('holds a delete scoped to an ID the session never observed: zero clicks, the row the goal named is not the evidence', async () => {
    const { model } = scripted([{ action: 'click', selector: 'text=PL_99_99 >> xpath=.. >> role=button[name="Delete" i]' }]);
    const agent = new WorkflowAgent({ model, maxSteps: 4, mutationPolicy: null });
    const { result, title } = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/rows`, { waitUntil: 'domcontentloaded' });
      const result = await agent.run(page, 'delete the plan PL_99_99');
      return { result, title: await page.title() };
    });
    assert.equal(title, 'plans', 'nothing was deleted');
    assert.equal(result.success, false);
    assert.equal(result.blocked?.reason, 'provenance');
    assert.equal(result.blocked?.rule, 'target-never-observed');
    assert.equal(result.blocked?.target, 'PL_99_99');
    assert.match(result.summary, /^agent blocked \(provenance\)/);
    assert.equal(result.actions.filter((a) => a.ok).length, 0, 'no click landed');
    const held = result.actions.find((a) => a.outcome?.kind === 'blocked');
    assert.ok(held, 'the hold is on the record');
    assert.equal(held.ok, false);
    assert.equal(held.outcome?.kind === 'blocked' ? held.outcome.provenance?.observedThisSession.length : -1, 0);
  });

  it('holds a destructive CSS target whose selector carries no record scope', async () => {
    const { model, seen } = scripted([{ action: 'click', selector: '#delete-pl' }]);
    const agent = new WorkflowAgent({
      model,
      maxSteps: 4,
      mutationPolicy: { allow: ['delete'], approved: [{ category: 'delete' }], source: 'test' },
    });
    const { result, title } = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/rows`, { waitUntil: 'domcontentloaded' });
      const result = await agent.run(page, 'delete the first draft');
      return { result, title: await page.title() };
    });
    assert.equal(title, 'plans', 'the CSS-selected Delete control was not clicked');
    assert.equal(result.blocked?.reason, 'provenance');
    assert.equal(result.blocked?.rule, 'destructive-unscoped');
    assert.equal(result.actions.filter((action) => action.ok).length, 0);
    assert.equal(seen.length, 1, 'the hold is terminal');
  });

  it('ends an unscoped destructive guardrail as blocked instead of later calling the application failed', async () => {
    const { model, seen } = scripted([{ action: 'click', selector: 'role=button[name="Delete" i] >> nth=0' }]);
    const agent = new WorkflowAgent({ model, maxSteps: 6, mutationPolicy: null });
    const { result, title } = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/rows`, { waitUntil: 'domcontentloaded' });
      const result = await agent.run(page, 'delete the plan PL_03_18');
      return { result, title: await page.title() };
    });
    assert.equal(title, 'plans');
    assert.equal(result.blocked?.reason, 'guardrail');
    assert.equal(result.blocked?.rule, 'destructive-unscoped');
    assert.equal(result.actions.filter((action) => action.ok).length, 0);
    assert.equal(seen.length, 2, 'one corrective re-ask, then a terminal hold');
  });

  it('holds a delete whose row was observed and then disappeared from the latest snapshot', async () => {
    const { model } = scripted([
      { action: 'click', selector: 'role=button[name="Hide" i]' },
      { action: 'click', selector: SCOPED_DELETE },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 5, mutationPolicy: null });
    const { result, title } = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/vanish`, { waitUntil: 'domcontentloaded' });
      const result = await agent.run(page, 'delete the plan PL_03_18');
      return { result, title: await page.title() };
    });
    assert.equal(title, 'plans', 'nothing was deleted');
    assert.equal(result.success, false);
    assert.equal(result.blocked?.rule, 'target-not-in-latest-snapshot');
    assert.equal(result.blocked?.reason, 'provenance');
    assert.deepEqual(result.blocked?.provenance?.observedThisSession, ['PL_03_18'], 'the ledger remembers seeing it');
    assert.deepEqual(result.blocked?.provenance?.inLatestSnapshot, []);
    assert.equal(result.actions.filter((a) => a.ok && a.action === 'click').length, 1, 'only the Hide click landed');
  });

  it('lets an observed, scoped delete through under a policy that allows and pre-approves it', async () => {
    const { model } = scripted([{ action: 'click', selector: SCOPED_DELETE }, { action: 'finish', reasoning: 'deleted' }]);
    const agent = new WorkflowAgent({
      model, maxSteps: 3,
      mutationPolicy: { allow: ['delete'], approved: [{ category: 'delete', target: 'PL_03_18' }], source: 'test' },
    });
    const { result, title } = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/rows`, { waitUntil: 'domcontentloaded' });
      const result = await agent.run(page, 'delete the plan PL_03_18');
      return { result, title: await page.title() };
    });
    assert.equal(title, 'deleted PL_03_18');
    assert.equal(result.success, true, result.summary);
    assert.equal(result.blocked, undefined);
    assert.equal(result.actions[0]?.outcome?.kind, 'ok');
  });

  it('holds an observed delete when no manifest and no host approval exist', async () => {
    const { model, seen } = scripted([{ action: 'click', selector: SCOPED_DELETE }]);
    const agent = new WorkflowAgent({ model, maxSteps: 4, mutationPolicy: null });
    const { result, title } = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/rows`, { waitUntil: 'domcontentloaded' });
      const result = await agent.run(page, 'delete the plan PL_03_18');
      return { result, title: await page.title() };
    });
    assert.equal(title, 'plans');
    assert.equal(result.blocked?.reason, 'approval');
    assert.equal(result.blocked?.rule, 'approval-missing');
    assert.equal(result.blocked?.policySource, null);
    assert.equal(result.actions.filter((action) => action.ok).length, 0);
    assert.equal(seen.length, 1, 'the hold is terminal');
  });

  it('holds a delete the policy denies, and one it allows without approval — no mutation either way', async () => {
    for (const [policy, rule] of [
      [{ deny: ['delete'] as const, source: 'test' }, 'policy-deny'],
      [{ allow: ['delete'] as const, source: 'test' }, 'approval-missing'],
    ] as const) {
      const { model, seen } = scripted([{ action: 'click', selector: SCOPED_DELETE }]);
      const agent = new WorkflowAgent({ model, maxSteps: 4, mutationPolicy: policy });
      const { result, title } = await withPage(CDP_URL, async (page) => {
        await page.goto(`${origin}/en/rows`, { waitUntil: 'domcontentloaded' });
        const result = await agent.run(page, 'delete the plan PL_03_18');
        return { result, title: await page.title() };
      });
      assert.equal(title, 'plans', `${rule}: nothing was deleted`);
      assert.equal(result.blocked?.rule, rule);
      assert.equal(result.blocked?.policySource, 'test');
      assert.equal(result.actions.filter((a) => a.ok).length, 0);
      assert.equal(seen.length, 1, `${rule}: a policy hold is terminal — the model is not re-asked to talk its way past it`);
    }
  });

  it('asks the host for an approval the manifest lacks, and proceeds on a yes', async () => {
    const asked: MutationRequest[] = [];
    const { model } = scripted([{ action: 'click', selector: SCOPED_DELETE }, { action: 'finish', reasoning: 'deleted' }]);
    const agent = new WorkflowAgent({ model, maxSteps: 3, mutationPolicy: { allow: ['delete'], source: 'test' } });
    const { result, title } = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/rows`, { waitUntil: 'domcontentloaded' });
      const result = await agent.run(page, 'delete the plan PL_03_18', {
        approveMutation: (request) => { asked.push(request); return true; },
      });
      return { result, title: await page.title() };
    });
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0]?.targets, ['PL_03_18']);
    assert.equal(title, 'deleted PL_03_18');
    assert.equal(result.success, true, result.summary);
  });

  it('leaves an ordinary journey untouched under the strictest policy', async () => {
    const { model } = scripted([{ action: 'click', selector: 'role=link[name="Continue"]' }]);
    const agent = new WorkflowAgent({ model, maxSteps: 3, mutationPolicy: { allow: [], deny: ['submit', 'delete', 'approve'], source: 'test' } });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/en/start`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, `follow Continue and end on ${origin}/en/done`);
    });
    assert.equal(result.success, true, result.summary);
    assert.equal(result.blocked, undefined);
    assert.equal(result.actions[0]?.outcome?.kind, 'ok');
  });

  it('runs a held leg through the runner as an error with no defect, and the report says held (runFlow)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wow-held-'));
    try {
      const { model } = scripted([{ action: 'click', selector: SCOPED_DELETE }]);
      const flow: Flow = {
        name: 'held delete',
        steps: [
          { action: 'goto', url: `${origin}/en/rows` },
          { action: 'workflow', goal: 'delete the plan PL_03_18' },
        ],
      };
      const bundle = await runFlow(flow, {
        cdpUrl: CDP_URL,
        cachePath: join(dir, 'cache.json'),
        healer: null,
        video: 'off',
        agent: new WorkflowAgent({ model, maxSteps: 3, mutationPolicy: null }),
        mutationPolicy: { deny: ['delete'], source: 'runFlow' },
      });
      const step = bundle.steps.find((s) => s.action === 'workflow');
      assert.ok(step);
      assert.equal(step.status, 'error', step.error);
      assert.equal(step.blocked?.reason, 'capability');
      assert.equal(step.blocked?.rule, 'policy-deny');
      assert.equal(step.blocked?.policySource, 'runFlow', 'the run\'s own policy outranks the agent\'s default');
      assert.equal(step.agent?.blocked?.rule, 'policy-deny');
      assert.match(step.error ?? '', /^workflow blocked \(capability, policy-deny\)/);
      assert.equal(bundle.defects.length, 0, 'no defect was filed against the application');
      assert.equal(exitCodeFor(bundle), EXIT.environment);
      assert.match(harnessOnly(bundle) ?? '', /^blocked \(capability, policy-deny\)/);
      const html = renderReport(bundle);
      assert.match(html, /Held by the run's rules/);
      assert.doesNotMatch(html, /Workflow goal not reached/);
      const raw = await readFile(join(dir, 'cache.json'), 'utf8').catch(() => '');
      assert.doesNotMatch(raw, /workflow-replay/, 'a held leg is never remembered as a journey');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
