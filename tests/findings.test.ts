/**
 * Findings (`src/reporter/findings.ts`, `src/reporter/findings-export.ts`).
 *
 * Entirely unit-tier: every bundle here is built BY HAND, never by the runner,
 * and the workbook is read back through `catalog/extract.ts`'s independent
 * reader — a writer tested only against its own reader proves nothing.
 *
 * What is proved: the signature is a pure function of typed fields (two cases
 * that differ only in their prose still cluster; the source never reads the
 * prose), each kind clusters on exactly its own fields, a case with no
 * signature is listed rather than dropped, statuses are shown as sealed, the
 * severity rule is stated and applied, and a credential the engine recorded
 * on a step never reaches the export.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentRecord, BlockedOutcome, ProofBundle, ProofStep } from '../src/engine/proof-bundle.js';
import type { RequestRecord } from '../src/api/api-client.js';
import { extractWorkbookSheets } from '../src/catalog/extract.js';
import type { CatalogReportCase, CatalogReportInput } from '../src/reporter/catalog-report.js';
import {
  FINDINGS_OWNER_RULE,
  SEVERITY_RULE,
  blockedChains,
  buildFindings,
  buildFindingsSummary,
  dependencyOf,
  findingsHeadline,
  ownerOf,
  pathnameOf,
  signatureOf,
  statusCounts,
  suggestedSeverity,
} from '../src/reporter/findings.js';
import {
  FINDINGS_COLUMNS,
  buildFindingsWorkbook,
  findingsExportNames,
  renderFindingsMarkdown,
  reproductionLine,
} from '../src/reporter/findings-export.js';

/* ---------------------------------------------------------------- fixtures */

function step(over: Partial<ProofStep>): ProofStep {
  return {
    index: 0, action: 'goto', intent: undefined, selector: null, resolvedSelector: null,
    resolution: null, status: 'passed', startedAt: '2026-09-05T04:00:00.000Z', durationMs: 350,
    url: 'http://app.test/en/plans',
    ...over,
  } as ProofStep;
}

function bundle(steps: ProofStep[], over: Partial<ProofBundle> = {}): ProofBundle {
  const failed = steps.filter((s) => s.status !== 'passed').length;
  return {
    runId: 'r1', name: 'X_01_01 case', status: failed === 0 ? 'passed' : 'failed',
    startedAt: '2026-09-05T04:00:00.000Z', finishedAt: '2026-09-05T04:01:00.000Z',
    durationMs: 60_000, cdpUrl: null, cachePath: null, healerModel: null,
    summary: { totalSteps: steps.length, passed: steps.length - failed, failed } as ProofBundle['summary'],
    defects: [], steps,
    ...over,
  } as ProofBundle;
}

function kase(id: string, over: Partial<CatalogReportCase>): CatalogReportCase {
  return {
    id, name: `${id} ${id.toLowerCase()}`, scenario: id.split('_').slice(0, 2).join('_'), verdict: 'failed',
    status: 'failed', reason: null, bundle: null, history: [],
    ...over,
  };
}

function request(method: string, url: string, status: number | null): RequestRecord {
  return { method, url, status, statusText: status === 500 ? 'Internal Server Error' : '', durationMs: 120 };
}

/** request → failed expectStatus, the shape an API case leaves. `error` and `summary` vary on purpose. */
function apiCase(id: string, method: string, url: string, status: number, prose: string, over: Partial<CatalogReportCase> = {}): CatalogReportCase {
  const steps = [
    step({ index: 0, action: 'request', url: null, request: request(method, url, status) }),
    step({
      index: 1, action: 'expectStatus', url: null, status: 'failed',
      detail: { expected: [201], actual: `${status} ${status === 500 ? 'Internal Server Error' : ''}`.trim() },
      error: prose,
    }),
  ];
  return kase(id, { bundle: bundle(steps, { summary: { totalSteps: 2, passed: 1, failed: 1, note: prose } as unknown as ProofBundle['summary'] }), ...over });
}

function agentRecord(extra: Record<string, unknown>): AgentRecord {
  return {
    goal: 'choose a department', model: 'm', success: false, summary: 'could not pick', actions: [], turns: 3, maxSteps: null, latencyMs: 900,
    ...extra,
  } as unknown as AgentRecord;
}

function agentCase(id: string, extra: Record<string, unknown> | null, url = 'http://app.test/en/hiring/new?x=1'): CatalogReportCase {
  const record = extra === null ? agentRecord({}) : agentRecord(extra);
  return kase(id, {
    status: 'error',
    bundle: bundle([step({ index: 0 }), step({ index: 1, action: 'workflow', status: 'error', url, agent: record })]),
  });
}

const input = (cases: CatalogReportCase[]): CatalogReportInput => ({ title: 'cases.xlsx', runKey: 'cases-xlsx@2026-09-05T04:00:00.000Z', generatedAt: null, cases });

/* ------------------------------------------------------------ signatures */

describe('api findings', () => {
  it('two failed expectStatus after requests to the same METHOD+path with the same status are ONE finding', () => {
    const findings = buildFindings([
      apiCase('BE_01_01', 'POST', 'http://api.test/v1/plans?draft=1', 500, 'expected status 201, got 500 Internal Server Error'),
      apiCase('BE_01_02', 'post', 'http://api.test/v1/plans', 500, 'สถานะที่คาดหวัง 201 แต่ได้ 500'),
    ]);
    assert.equal(findings.length, 1);
    const [f] = findings;
    assert.equal(f!.kind, 'api');
    assert.equal(f!.key, 'api:POST /v1/plans → 500');
    assert.deepEqual(f!.cases.map((c) => c.id), ['BE_01_01', 'BE_01_02']);
    assert.equal(f!.where, '/v1/plans');
    assert.equal(f!.asked, 'status 201');
    assert.equal(f!.offered, '500 Internal Server Error');
    assert.ok(f!.evidence.some((e) => e.label === 'request' && e.value === 'POST http://api.test/v1/plans?draft=1'));
  });

  it('two different paths are two findings; the same path with a different status is another', () => {
    const findings = buildFindings([
      apiCase('BE_01_01', 'POST', 'http://api.test/v1/plans', 500, 'a'),
      apiCase('BE_01_02', 'POST', 'http://api.test/v1/positions', 500, 'a'),
      apiCase('BE_01_03', 'POST', 'http://api.test/v1/plans', 403, 'a'),
    ]);
    assert.deepEqual(findings.map((f) => f.key).sort(), ['api:POST /v1/plans → 403', 'api:POST /v1/plans → 500', 'api:POST /v1/positions → 500']);
  });

  it('reads the LATEST request before the assertion, skipping superseded attempts, and a request with no response says so', () => {
    const c = kase('BE_02_01', {
      bundle: bundle([
        step({ index: 0, action: 'request', url: null, request: request('GET', 'http://api.test/v1/a', 200) }),
        step({ index: 1, action: 'request', url: null, request: request('DELETE', 'http://api.test/v1/a/9', 500), superseded: true } as Partial<ProofStep>),
        step({ index: 1, action: 'request', url: null, request: request('DELETE', 'http://api.test/v1/a/9', null) }),
        step({ index: 2, action: 'expectJson', url: null, status: 'failed', detail: { path: 'ok', expected: 'true', actual: '(path did not resolve)' } }),
      ]),
    });
    const sig = signatureOf(c);
    assert.equal(sig?.key, 'api:DELETE /v1/a/9 → no response');
    assert.equal(sig?.asked, 'ok = true');
  });
});

describe('url, control, hold and agent findings', () => {
  it('a failed expectUrl clusters by expected → actual pathname', () => {
    const urlCase = (id: string, actual: string): CatalogReportCase =>
      kase(id, {
        bundle: bundle([
          step({ index: 0 }),
          step({ index: 1, action: 'expectUrl', status: 'failed', url: actual, detail: { expected: '/dashboard', actual } }),
        ]),
      });
    const findings = buildFindings([
      urlCase('UI_01_01', 'http://app.test/en/login?next=%2Fdashboard'),
      urlCase('UI_01_02', 'http://app.test/en/login'),
      urlCase('UI_01_03', 'http://app.test/en/forbidden'),
    ]);
    assert.equal(findings.length, 2);
    const login = findings.find((f) => f.key === 'url:/dashboard → /en/login');
    assert.ok(login);
    assert.equal(login.kind, 'url');
    assert.deepEqual(login.cases.map((c) => c.id), ['UI_01_01', 'UI_01_02']);
    assert.equal(login.asked, '/dashboard');
    assert.equal(login.where, '/en/login');
  });

  it('a dead-end or unresolved selector clusters by selector @ pathname', () => {
    const dead = (id: string, status: ProofStep['status'], selector: string): CatalogReportCase =>
      kase(id, {
        status: status === 'dead-end' ? 'dead-end' : 'failed',
        bundle: bundle([step({ index: 0 }), step({ index: 1, action: 'click', status, selector, url: 'http://app.test/en/plans?page=2' })]),
      });
    const findings = buildFindings([
      dead('UI_02_01', 'dead-end', 'role=button[name="Create" i]'),
      dead('UI_02_02', 'failed', 'role=button[name="Create" i]'),
      dead('UI_02_03', 'dead-end', 'role=button[name="Delete" i]'),
    ]);
    assert.equal(findings.length, 2);
    const create = findings.find((f) => f.key === 'control:role=button[name="Create" i] @ /en/plans');
    assert.ok(create);
    assert.equal(create.kind, 'control');
    assert.deepEqual(create.cases.map((c) => c.id), ['UI_02_01', 'UI_02_02']);
    // Statuses as sealed: a dead-end is a dead-end, a failed is failed.
    assert.deepEqual(statusCounts(create.cases), [{ status: 'dead-end', count: 1 }, { status: 'failed', count: 1 }]);
  });

  it('ProofStep.blocked clusters by reason/rule, ahead of every other reading of the step', () => {
    const held: BlockedOutcome = {
      kind: 'blocked', reason: 'approval', rule: 'approval-missing', message: 'irreversible action, no host approval',
      category: 'delete', target: 'row 42', policySource: null,
    };
    const hold = (id: string, over: Partial<BlockedOutcome>): CatalogReportCase =>
      kase(id, {
        verdict: 'blocked', status: 'error',
        bundle: bundle([step({ index: 0, action: 'workflow', status: 'error', blocked: { ...held, ...over }, agent: agentRecord({ endedBy: 'blocked' }) })]),
      });
    const findings = buildFindings([hold('UI_03_01', {}), hold('UI_03_02', { target: 'row 43' }), hold('UI_03_03', { reason: 'provenance', rule: 'target-never-observed' })]);
    assert.deepEqual(findings.map((f) => f.key), ['hold:approval/approval-missing', 'hold:provenance/target-never-observed']);
    assert.equal(findings[0]!.kind, 'hold');
    assert.deepEqual(findings[0]!.cases.map((c) => c.status), ['error', 'error']);
    assert.equal(suggestedSeverity(findings[0]!), 'low', 'a hold is harness-only — no verdict about the application');
  });

  it('two workflow failures with the same agent.endedBy and listbox.trigger cluster; a different trigger does not', () => {
    const dept = { endedBy: 'stall', actions: [{ index: 0, action: 'click', ok: true, listbox: { trigger: 'Department', value: 'Sales', shownCount: 12, shownHead: ['Sales', 'Ops'] } }] };
    const findings = buildFindings([
      agentCase('HR_01_01', dept),
      agentCase('HR_01_02', { ...dept, actions: [{ index: 0, action: 'click', ok: true, listbox: { trigger: 'Department', value: 'HR', shownCount: 12 } }] }),
      agentCase('HR_01_03', { endedBy: 'stall', actions: [{ index: 0, action: 'click', ok: true, listbox: { trigger: 'Position' } }] }),
    ]);
    assert.deepEqual(findings.map((f) => f.key), ['agent:stall:Department @ /en/hiring/new', 'agent:stall:Position @ /en/hiring/new']);
    assert.deepEqual(findings[0]!.cases.map((c) => c.id), ['HR_01_01', 'HR_01_02']);
    assert.equal(findings[0]!.kind, 'agent');
    assert.ok(findings[0]!.evidence.some((e) => e.label === 'first options' && e.value === 'Sales, Ops'));
  });

  it('a workflow failure WITHOUT the optional agent fields still yields the coarse agent:workflow @ <path> key', () => {
    const findings = buildFindings([agentCase('HR_02_01', null), agentCase('HR_02_02', null)]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.key, 'agent:workflow @ /en/hiring/new');
    assert.equal(findings[0]!.cases.length, 2);
  });

  it('prefers the agent record\'s urlAfter to the step url when it is there', () => {
    const sig = signatureOf(agentCase('HR_03_01', { endedBy: 'no-progress', urlAfter: 'http://app.test/en/hiring/42/edit' }));
    assert.equal(sig?.key, 'agent:no-progress @ /en/hiring/42/edit');
  });
});

describe('the remainder', () => {
  it('assigns each typed finding to the application, harness, or catalog owner without replacing member objects', () => {
    const held: BlockedOutcome = {
      kind: 'blocked', reason: 'approval', rule: 'approval-missing', message: 'approval was not observed',
      category: 'submit', target: 'record', policySource: null,
    };
    const cases = [
      kase('OWN_01', { verdict: 'blocked', status: 'error', bundle: bundle([step({ action: 'workflow', status: 'error', blocked: held })]) }),
      agentCase('OWN_02', { endedBy: 'stall' }),
      kase('OWN_03', { verdict: 'blocked', status: null, reason: 'authoring refused: the flow has no application assertion' }),
      kase('OWN_04', { bundle: bundle([step({ action: 'click', status: 'failed', selector: 'role=button[name="Save"]' })]) }),
      apiCase('OWN_05', 'POST', 'http://api.test/v1/items', 500, 'request failed'),
      kase('OWN_06', { bundle: bundle([step({ action: 'expectUrl', status: 'failed', url: 'http://app.test/login', detail: { expected: '/home', actual: '/login' } })]) }),
      kase('OWN_07', { status: 'error', bundle: bundle([step({ action: 'click', status: 'error', selector: 'role=button[name="Cancel"]' })]) }),
    ];
    const findings = buildFindings(cases);
    const members = findings.flatMap((finding) => finding.cases);
    const memberState = members.map((member) => ({ member, status: member.status, verdict: member.verdict }));
    const ownerByCase = new Map(findings.flatMap((finding) => finding.cases.map((member) => [member.id, ownerOf(finding)] as const)));

    assert.equal(ownerByCase.get('OWN_01'), 'harness');
    assert.equal(ownerByCase.get('OWN_02'), 'harness');
    assert.equal(ownerByCase.get('OWN_03'), 'catalog');
    assert.equal(ownerByCase.get('OWN_04'), 'application');
    assert.equal(ownerByCase.get('OWN_05'), 'application');
    assert.equal(ownerByCase.get('OWN_06'), 'application');
    assert.equal(ownerByCase.get('OWN_07'), 'harness');
    for (const { member, status, verdict } of memberState) {
      const produced = findings.flatMap((finding) => finding.cases).find((candidate) => candidate.id === member.id);
      assert.equal(produced, member, `${member.id} keeps the member object built by the projection`);
      assert.equal(member.status, status);
      assert.equal(member.verdict, verdict);
    }
    for (const finding of findings) assert.equal(finding.owner, ownerOf(finding));
  });

  it('builds transitive blocked chains nearest-first, sorts independent chains by size, and preserves the root record', () => {
    const chains = blockedChains([
      kase('A', { verdict: 'failed', status: 'error', reason: 'root failed\nmore detail' }),
      kase('B', { verdict: 'blocked', status: null, reason: 'depends on A which failed' }),
      kase('C', { verdict: 'blocked', status: null, reason: 'depends on B which is blocked' }),
      kase('X', { verdict: 'failed', status: 'failed', reason: 'other root' }),
      kase('Y', { verdict: 'blocked', status: null, reason: 'depends on X which failed' }),
    ]);

    assert.deepEqual(chains, [
      { root: 'A', rootStatus: 'error', rootVerdict: 'failed', rootReason: 'root failed', waiting: ['B', 'C'] },
      { root: 'X', rootStatus: 'failed', rootVerdict: 'failed', rootReason: 'other root', waiting: ['Y'] },
    ]);
  });

  it('emits one finite circular chain and returns none without dependency lines', () => {
    const circular = blockedChains([
      kase('B', { verdict: 'blocked', status: null, reason: 'depends on A' }),
      kase('A', { verdict: 'blocked', status: null, reason: 'depends on B' }),
    ]);
    assert.equal(circular.length, 1);
    assert.equal(circular[0]!.root, 'A');
    assert.deepEqual(circular[0]!.waiting, ['B']);
    assert.match(circular[0]!.rootReason, /circular/i);
    assert.deepEqual(blockedChains([kase('Z', { verdict: 'failed', reason: 'step broke' })]), []);
  });

  it('a case with no signature is listed as unclustered, counted, never dropped', () => {
    const summary = buildFindingsSummary([
      kase('X_01_01', { bundle: bundle([step({ index: 0, status: 'failed' })]) }), // a goto that broke: no selector, no request, no url claim
      kase('X_01_02', { verdict: 'blocked', status: null, reason: 'the run was paused' }),
      apiCase('X_01_03', 'GET', 'http://api.test/v1/x', 500, 'p'),
      kase('X_01_04', { verdict: 'passed', status: 'passed', bundle: bundle([step({})]) }),
      kase('X_01_05', { verdict: 'never-ran', status: null }),
    ]);
    assert.deepEqual(summary.unclustered.map((c) => c.id), ['X_01_01', 'X_01_02']);
    assert.equal(summary.nonPassing, 3, 'passed and never-ran are not non-passing');
    assert.equal(summary.clustered, 1);
    assert.deepEqual(summary.neverRan.map((c) => c.id), ['X_01_05']);
    assert.equal(findingsHeadline(summary), '1 finding account for 1 of 3 non-passing cases · 2 unclustered');
  });

  it('a dependent (`depends on X …`) is listed under X\'s finding, marked, and a chain of dependents follows to the root', () => {
    const summary = buildFindingsSummary([
      apiCase('D_01_01', 'POST', 'http://api.test/v1/plans', 500, 'p'),
      kase('D_01_02', { verdict: 'blocked', status: null, reason: 'depends on D_01_01 which failed (step 1 expectStatus)' }),
      kase('D_01_03', { verdict: 'blocked', status: null, reason: 'depends on D_01_02, which is not in this run' }),
      kase('D_01_04', { verdict: 'blocked', status: null, reason: 'depends on D_09_09 which never ran' }),
    ]);
    assert.equal(summary.findings.length, 1);
    const [f] = summary.findings;
    assert.deepEqual(f!.cases.map((c) => [c.id, c.dependsOn ?? null]), [['D_01_01', null], ['D_01_02', 'D_01_01'], ['D_01_03', 'D_01_02']]);
    assert.deepEqual(summary.unclustered.map((c) => c.id), ['D_01_04'], 'a dependency on a case with no finding stays unclustered');
    assert.equal(summary.clustered, 3);
    assert.equal(suggestedSeverity(f!), 'high', 'blocking a dependency chain is high');
    assert.equal(dependencyOf('depends on A_1, which is queued after it'), 'A_1');
    assert.equal(dependencyOf('step 3 broke'), null);
  });

  it('authoring refusals cluster by their reason, the attempt counter left out', () => {
    const findings = buildFindings([
      kase('A_01_01', { verdict: 'blocked', status: null, reason: 'authoring refused (attempt 1): the Steps column names a control the page does not render anywhere on the route' }),
      kase('A_01_02', { verdict: 'blocked', status: null, reason: 'authoring refused (attempt 2): the Steps column names a control the page does not render anywhere on the route' }),
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.kind, 'authoring');
    assert.equal(findings[0]!.key, 'authoring:the Steps column names a control the page does not render an', 'sixty characters of the reason, the counter gone');
    assert.equal(suggestedSeverity(findings[0]!), 'low');
  });

  it('normalises authored-flow ids, quoted values, step numbers and problem counts before keying', () => {
    const findings = buildFindings([
      kase('A_02_01', { verdict: 'blocked', status: null, reason: 'authoring refused (attempt 1): the authored flow "HIR-EC-050" counts role "option" (step 1)' }),
      kase('A_02_02', { verdict: 'blocked', status: null, reason: 'authoring refused (attempt 2): the authored flow "HIR-EC-056" counts role "option" (step 4)' }),
      kase('A_02_03', { verdict: 'blocked', status: null, reason: 'authoring refused: 3 problems make role "dialog" unreachable at step 9' }),
      kase('A_02_04', { verdict: 'blocked', status: null, reason: 'authoring refused: 8 problems make role "dialog" unreachable at step 2' }),
      kase('A_02_05', { verdict: 'blocked', status: null, reason: 'authoring refused: the flow has no application assertion' }),
    ]);

    assert.equal(findings.length, 3);
    assert.equal(findings.find((finding) => finding.cases.some((member) => member.id === 'A_02_01'))?.cases.length, 2);
    assert.equal(findings.find((finding) => finding.cases.some((member) => member.id === 'A_02_03'))?.cases.length, 2);
    assert.equal(findings.find((finding) => finding.cases.some((member) => member.id === 'A_02_05'))?.cases.length, 1);
  });

  it('severity follows the stated rule: three cases high, one or two medium, all-harness low', () => {
    const three = buildFindings(['S_1', 'S_2', 'S_3'].map((id) => apiCase(id, 'GET', 'http://api.test/v1/s', 500, 'p')));
    assert.equal(suggestedSeverity(three[0]!), 'high');
    const two = buildFindings(['S_1', 'S_2'].map((id) => apiCase(id, 'GET', 'http://api.test/v1/s', 500, 'p')));
    assert.equal(suggestedSeverity(two[0]!), 'medium');
    const errors = buildFindings(['S_1', 'S_2', 'S_3'].map((id) => apiCase(id, 'GET', 'http://api.test/v1/s', 500, 'p', { status: 'error' })));
    assert.equal(suggestedSeverity(errors[0]!), 'low', 'every member a system error: harness-only');
    assert.match(SEVERITY_RULE, /HIGH when a finding covers 3 or more cases or blocks a dependency chain/);
  });

  it('findings are ordered by how many cases they account for, then by key', () => {
    const findings = buildFindings([
      apiCase('O_1', 'GET', 'http://api.test/v1/b', 500, 'p'),
      apiCase('O_2', 'GET', 'http://api.test/v1/a', 500, 'p'),
      apiCase('O_3', 'GET', 'http://api.test/v1/a', 500, 'p'),
      apiCase('O_4', 'GET', 'http://api.test/v1/c', 500, 'p'),
    ]);
    assert.deepEqual(findings.map((f) => f.key), ['api:GET /v1/a → 500', 'api:GET /v1/b → 500', 'api:GET /v1/c → 500']);
  });

  it('pathnameOf keeps a bare path and drops a query', () => {
    assert.equal(pathnameOf('http://h/a/b?x=1#f'), '/a/b');
    assert.equal(pathnameOf('/a/b?x=1'), '/a/b');
    assert.equal(pathnameOf(null), '');
  });
});

/* -------------------------------------------------- never the free text */

describe('the signature never reads prose', () => {
  it('two cases whose ONLY difference is their summary/error text still cluster', () => {
    const a = apiCase('P_01', 'POST', 'http://api.test/v1/plans', 500, 'expected status 201, got 500 Internal Server Error');
    const b = apiCase('P_02', 'POST', 'http://api.test/v1/plans', 500, 'สถานะที่คาดหวัง 201 แต่ระบบตอบ 500');
    (b.bundle as ProofBundle & { notes: string[] }).notes = ['a note in another wording'];
    assert.equal(signatureOf(a)!.key, signatureOf(b)!.key);
    assert.equal(buildFindings([a, b]).length, 1);
  });

  it('the source of findings.ts and findings-export.ts reads no summary, error or reasoning field, and imports no model', () => {
    for (const file of ['findings.ts', 'findings-export.ts']) {
      const source = readFileSync(join(import.meta.dirname, '..', 'src', 'reporter', file), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      for (const field of ['summary', 'error', 'reasoning']) {
        assert.doesNotMatch(code, new RegExp(`\\.${field}\\b`), `${file} must not read .${field}`);
        assert.doesNotMatch(code, new RegExp(`\\[['"]${field}['"]\\]`), `${file} must not read ['${field}']`);
      }
      assert.doesNotMatch(code, /from '\.\.\/providers\//, `${file} imports nothing from the model layer`);
      assert.doesNotMatch(code, /from '\.\.\/generator\//, `${file} imports nothing from the generator`);
      assert.doesNotMatch(code, /from 'ai'|from '@ai-sdk/, `${file} imports no SDK`);
      assert.doesNotMatch(code, /\bfetch\s*\(/, `${file} makes no request`);
    }
  });
});

/* ------------------------------------------------------------- the export */

describe('the markdown and the workbook', () => {
  const secretCases = (): CatalogReportCase[] => [
    kase('E_01_01', {
      bundle: bundle([
        step({ index: 0, action: 'signIn', intent: 'sign in as the HR admin', detail: { as: 'hr.admin@corp.test:hunter2', password: 'hunter2', personaLabel: 'HR_ADMIN' } }),
        step({ index: 1, action: 'fill', intent: 'type the password', selector: 'role=textbox[name="Password"]', resolution: 'fast', detail: { value: 'hunter2' } }),
        step({ index: 2, action: 'fill', intent: 'type the plan name', selector: 'role=textbox[name="Plan name"]', resolution: 'fast', detail: { value: 'Gold 2026' } }),
        step({ index: 3, action: 'expectUrl', status: 'failed', url: 'http://app.test/en/login', detail: { expected: '/plans', actual: 'http://app.test/en/login' } }),
      ]),
    }),
    kase('E_01_02', {
      bundle: bundle([step({ index: 0 }), step({ index: 1, action: 'expectUrl', status: 'failed', url: 'http://app.test/en/login', detail: { expected: '/plans', actual: 'http://app.test/en/login?x=1' } })]),
    }),
    kase('E_01_03', { status: 'error', bundle: bundle([step({ index: 0, status: 'error' })]) }),
    kase('E_01_04', { verdict: 'never-ran', status: null }),
  ];

  it('the markdown states the severity rule, the headline, every title and case id, the statuses as sealed and the steps to reproduce', () => {
    const cases = secretCases();
    const findings = buildFindings(cases);
    const md = renderFindingsMarkdown(findings, input(cases));
    assert.ok(md.includes(SEVERITY_RULE), 'the rule is stated at the top');
    assert.ok(md.includes(FINDINGS_OWNER_RULE), 'the owner rule is stated at the top');
    assert.ok(md.includes('**1 finding account for 2 of 3 non-passing cases · 1 unclustered** · never ran: 1'));
    assert.ok(md.includes(`### 1. ${findings[0]!.title}`));
    for (const id of ['E_01_01', 'E_01_02', 'E_01_03', 'E_01_04']) assert.ok(md.includes(id), id);
    assert.ok(md.includes('- status as sealed: failed: 2'));
    assert.ok(md.includes('E_01_03 (error)'), 'an error is shown as error, under unclustered');
    assert.ok(md.includes('Steps to reproduce (from E_01_01):'));
    assert.ok(md.includes('1. signIn — sign in as the HR admin · persona an account named by its credentials (withheld from the report)'), 'a label that is an address is withheld');
    assert.ok(md.includes('3. fill — type the plan name · role=textbox[name="Plan name"] [value="Gold 2026"]'), 'test data is kept');
    assert.ok(md.includes('4. expectUrl'));
  });

  it('puts blocked chains before three ordered owner sections, renders empty sections, and caps waiting ids at twelve', () => {
    const root = apiCase('ROOT', 'POST', 'http://api.test/v1/items', 500, 'request failed', { status: 'error', reason: 'service returned 500' });
    const dependents = Array.from({ length: 20 }, (_, index) =>
      kase(`WAIT_${String(index + 1).padStart(2, '0')}`, { verdict: 'blocked', status: null, reason: `depends on ${index === 0 ? 'ROOT' : `WAIT_${String(index).padStart(2, '0')}`}` }),
    );
    const cases = [root, ...dependents];
    const md = renderFindingsMarkdown(buildFindings(cases), input(cases));
    const application = md.indexOf('## For the application team (1 finding, 21 cases)');
    const harness = md.indexOf('## For the test harness (0 findings, 0 cases)');
    const catalog = md.indexOf('## For the test catalog (0 findings, 0 cases)');

    assert.ok(md.indexOf('## Blocked chains') < application);
    assert.ok(application < harness && harness < catalog);
    assert.match(md, /\*\*ROOT\*\* \(error\) — 20 case\(s\) wait on it:/);
    assert.match(md, /WAIT_12, … and 8 more · reason: service returned 500/);
    assert.match(md.slice(harness, catalog), /\nnone\n/);
    assert.match(md.slice(catalog), /\nnone\n/);
  });

  it('a credential recorded on a step never reaches the markdown or the sheet', () => {
    const cases = secretCases();
    const md = renderFindingsMarkdown(buildFindings(cases), input(cases));
    assert.ok(!md.includes('hunter2'), 'the password');
    assert.ok(!md.includes('hr.admin@corp.test'), 'the account');
    assert.ok(md.includes('(withheld — a secret-taking control)'), 'and the withholding is said, not silent');
    const sheet = extractWorkbookSheets(buildFindingsWorkbook(input(cases)));
    const text = JSON.stringify(sheet);
    assert.ok(!text.includes('hunter2'));
    assert.ok(!text.includes('hr.admin@corp.test'));
  });

  it('the workbook reads back through the independent xlsx reader with the rule, the columns and one row per finding', () => {
    const cases = secretCases().map((c) =>
      c.id === 'E_01_01' ? { ...c, scenarioId: 'E2E-55' } : c.id === 'E_01_03' ? { ...c, scenarioId: 'E2E-57' } : c,
    );
    const markdown = renderFindingsMarkdown(buildFindings(cases), input(cases));
    const sheets = extractWorkbookSheets(buildFindingsWorkbook(input(cases)));
    assert.equal(sheets.length, 1);
    const [sheet] = sheets;
    assert.equal(sheet!.name, 'Findings');
    assert.ok(sheet!.rows[0]![0]!.includes(SEVERITY_RULE), 'row 1: the rule');
    assert.deepEqual(sheet!.rows[1], [...FINDINGS_COLUMNS]);
    const finding = sheet!.rows[2]!;
    assert.match(finding[0]!, /expected the URL to contain "\/plans", landed on \/en\/login\n\[url\] url:\/plans → \/en\/login/);
    assert.equal(finding[1], 'E_01_01 (E2E-55) (failed)\nE_01_02 (failed)');
    assert.ok(markdown.includes('- cases (2): E_01_01 (E2E-55) (failed), E_01_02 (failed)'));
    assert.equal(finding[2], '/en/login');
    assert.equal(finding[3], 'asked: /plans\noffered: http://app.test/en/login');
    assert.ok(finding[4]!.includes('steps to reproduce (E_01_01):'));
    assert.equal(finding[5], 'failed: 2');
    assert.equal(finding[6], 'medium');
    assert.equal(finding[7], 'application');
    assert.match(sheet!.rows[3]![0]!, /^unclustered \(1\)/);
    const unclustered = sheet?.rows[3];
    assert.ok(unclustered);
    assert.equal(unclustered[1], 'E_01_03 (E2E-57) (error)');
    assert.match(sheet!.rows[4]![0]!, /^never ran \(1\)/);
    assert.equal(sheet!.rows[4]![1], 'E_01_04');
  });

  it('keeps every existing workbook column in place and sorts finding rows by owner', () => {
    const cases = [
      kase('CAT', { verdict: 'blocked', status: null, reason: 'authoring refused: the flow has no application assertion' }),
      agentCase('HAR', { endedBy: 'stall' }),
      apiCase('APP', 'GET', 'http://api.test/v1/items', 500, 'request failed'),
    ];
    const sheet = extractWorkbookSheets(buildFindingsWorkbook(input(cases)))[0];

    assert.deepEqual(FINDINGS_COLUMNS, ['Finding', 'Cases', 'Where', 'Asked/Offered', 'Evidence', 'Status as sealed', 'Suggested severity', 'Owner']);
    assert.deepEqual(sheet!.rows.slice(2).map((row) => row[7]), ['application', 'harness', 'catalog']);
  });

  it('a reproduction line carries the intent, the target and short detail values, and never a credential key', () => {
    const line = reproductionLine(
      step({ index: 2, action: 'select', intent: 'choose the tier', selector: 'role=combobox[name="Tier"]', detail: { value: 'Gold', token: 'abc', long: 'x'.repeat(200) } }),
      3,
    );
    assert.equal(line, '3. select — choose the tier · role=combobox[name="Tier"] [value="Gold"]');
  });

  it('names its files beside the report', () => {
    assert.deepEqual(findingsExportNames('/x/reports/run-key.html'), { markdownPath: '/x/reports/run-key-findings.md', xlsxPath: '/x/reports/run-key-findings.xlsx' });
  });
});
