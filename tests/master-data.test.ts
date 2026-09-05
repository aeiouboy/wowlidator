/**
 * Master-data grounding (`src/context/master-data.ts`): the declaration is
 * parsed at the file seam, `groundCodes` is pure and read against hand-written
 * rows, and the fetcher pages through an injected transport without ever
 * throwing. Every fixture here is hand-written — a reader tested only against
 * its own writer proves nothing. No browser, no model.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import type { ApiTransport } from '../src/api/api-client.js';
import { parseTestCaseTable, testDataPairs } from '../src/catalog/test-case-table.js';
import {
  LookupFetcher,
  MAX_LOOKUP_PAGES,
  bindTemplate,
  describeGroundingFinding,
  fetchJsonThrough,
  groundCodes,
  groundPlan,
  labelAt,
  parseMasterDataDeclaration,
  planLookups,
  readMasterDataDeclaration,
  readPath,
  renderGroundingReport,
  summarizeGrounding,
  templateTokens,
  type MasterDataLookup,
} from '../src/context/master-data.js';

const FIXTURES = resolve(import.meta.dirname, 'fixtures');

/** The positions lookup as the fixture declares it, for the pure tests. */
const POSITIONS: MasterDataLookup = {
  field: ['Position', 'Position Code'],
  url: '/api/positions?company={Company}&page={page}',
  rows: 'data.rows',
  next: 'data.hasNextPage',
  code: 'positionCode',
  label: 'name.en',
  facts: ['vacant', 'headcount'],
  consumable: 'vacant',
  uiPageSize: 4,
};

/** Three pages of two rows, as the master would hand them back in page-1 order. */
const PAGES = [
  {
    data: {
      rows: [
        { positionCode: 'P-001', name: { en: 'Analyst', th: 'นักวิเคราะห์' }, vacant: true, headcount: 1 },
        { positionCode: 'P-002', name: { en: 'Clerk', th: 'เสมียน' }, vacant: false, headcount: 2 },
      ],
      hasNextPage: true,
    },
  },
  {
    data: {
      rows: [
        { positionCode: 'P-003', name: { en: 'Driver', th: 'พนักงานขับรถ' }, vacant: true, headcount: 1 },
        { positionCode: 'P-004', name: { en: 'Engineer', th: 'วิศวกร' }, vacant: true, headcount: 3 },
      ],
      hasNextPage: true,
    },
  },
  {
    data: {
      rows: [
        { positionCode: 'P-005', name: { en: 'Foreman', th: 'หัวหน้างาน' }, vacant: true, headcount: 1 },
        { positionCode: 'P-006', name: { en: 'Guard', th: 'ยาม' }, vacant: false, headcount: 1 },
      ],
      hasNextPage: false,
    },
  },
];
const ALL_ROWS = PAGES.flatMap((page) => page.data.rows);

describe('master data — the declaration', () => {
  it('parses the hand-written fixture declaration', async () => {
    const lookups = await readMasterDataDeclaration(join(FIXTURES, 'master-data.lookups.json'));
    assert.equal(lookups.length, 2);
    assert.deepEqual(lookups[0]!.field, ['Position', 'Position Code']);
    assert.equal(lookups[0]!.uiPageSize, 4);
    assert.equal(lookups[1]!.next, undefined);
  });

  it('rejects a lookup with no code path, naming the path', () => {
    const parsed = parseMasterDataDeclaration([
      { field: ['Position'], url: '/x?page={page}', rows: 'rows', label: 'name' },
    ]);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.reason, /^lookups\[0\]\.code: /);
  });

  it('names a nested path and refuses an empty declaration', () => {
    const nested = parseMasterDataDeclaration([{ ...POSITIONS, field: [] }]);
    assert.equal(nested.ok, false);
    if (!nested.ok) assert.match(nested.reason, /^lookups\[0\]\.field: /);
    assert.equal(parseMasterDataDeclaration([]).ok, false);
    assert.equal(parseMasterDataDeclaration({ lookups: [] }).ok, false);
  });

  it('reads a file that is not JSON as a thrown error naming the file', async () => {
    await assert.rejects(
      readMasterDataDeclaration(join(FIXTURES, 'master-data-cases.csv')),
      /master-data-cases\.csv is not JSON/,
    );
  });
});

describe('master data — JSON paths', () => {
  it('reads dotted, indexed and empty paths', () => {
    const value = { data: { rows: [{ code: 'A' }, { code: 'B' }] }, flag: false };
    assert.deepEqual(readPath(value, ''), value);
    assert.equal(readPath(value, 'data.rows[1].code'), 'B');
    assert.equal(readPath(value, 'flag'), false);
    assert.equal(readPath(value, 'data.missing.deeper'), undefined);
    assert.equal(readPath(null, 'a'), undefined);
  });

  it('yields the label for a locale key, and a first string for a locale object', () => {
    const row = { name: { en: 'A', th: 'ก' } };
    assert.equal(labelAt(row, 'name.en'), 'A');
    assert.equal(labelAt(row, 'name.th'), 'ก');
    assert.equal(labelAt(row, 'name'), 'A');
    assert.equal(labelAt(row, 'nowhere'), undefined);
  });
});

describe('master data — groundCodes', () => {
  it('marks found and not found, indexes in page-1 order, reads facts and reachability', () => {
    const grounded = groundCodes(POSITIONS, ALL_ROWS, ['P-001', 'P-005', 'P-404']);
    assert.deepEqual(
      grounded.map((g) => [g.code, g.found, g.index, g.reachable]),
      [
        ['P-001', true, 0, true],
        ['P-005', true, 4, false],
        ['P-404', false, undefined, undefined],
      ],
    );
    assert.equal(grounded[0]!.label, 'Analyst');
    assert.deepEqual(grounded[0]!.facts, { vacant: true, headcount: 1 });
    assert.equal(grounded[0]!.consumable, true);
    assert.equal(grounded[2]!.label, undefined);
    assert.equal(grounded[2]!.facts, undefined);
  });

  it('counts sharedBy from a wanted list with duplicates, one result per distinct code', () => {
    const grounded = groundCodes(POSITIONS, ALL_ROWS, ['P-001', ' P-002', 'P-001', 'P-001 ', 'P-002']);
    assert.deepEqual(
      grounded.map((g) => [g.code, g.sharedBy]),
      [
        ['P-001', 3],
        ['P-002', 2],
      ],
    );
  });

  it('leaves reachable undefined when the lookup declares no uiPageSize', () => {
    const { uiPageSize: _omitted, ...noPicker } = POSITIONS;
    const [grounded] = groundCodes(noPicker, ALL_ROWS, ['P-006']);
    assert.equal(grounded!.found, true);
    assert.equal(grounded!.index, 5);
    assert.equal(grounded!.reachable, undefined);
  });

  it('reads a label through a locale object when the declared path stops at it', () => {
    const [grounded] = groundCodes({ ...POSITIONS, label: 'name' }, ALL_ROWS, ['P-002']);
    assert.equal(grounded!.label, 'Clerk');
    const [thai] = groundCodes({ ...POSITIONS, label: 'name.th' }, ALL_ROWS, ['P-002']);
    assert.equal(thai!.label, 'เสมียน');
  });

  it('accepts a numeric code column', () => {
    const rows = [{ positionCode: 40106337, name: { en: 'Numeric' } }];
    const [grounded] = groundCodes(POSITIONS, rows, ['40106337']);
    assert.equal(grounded!.found, true);
  });
});

describe('master data — binding', () => {
  it('binds {Company} and {page}, spacing and case ignored, URL-encoded', () => {
    const bound = bindTemplate('/api/positions?company={Company}&page={page}', { 'company ': 'A B' }, 2);
    assert.deepEqual(bound, { ok: true, url: '/api/positions?company=A%20B&page=2' });
  });

  it('names the tokens a row cannot bind', () => {
    const bound = bindTemplate('/x/{Company}/{Region}?page={page}', {}, 1);
    assert.deepEqual(bound, { ok: false, missing: ['Company', 'Region'] });
    assert.deepEqual(templateTokens('/x/{Company}/{Region}?page={page}&c={company}'), ['Company', 'Region']);
  });
});

describe('master data — the fetcher', () => {
  /** A stub that answers from the fixture pages by URL and counts every call. */
  function stubFetch(): { fetchJson: (url: string) => Promise<unknown>; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      fetchJson: async (url) => {
        calls.push(url);
        const parsed = new URL(url, 'http://fixture.test');
        if (parsed.pathname === '/api/positions' && parsed.searchParams.get('company') === 'ACME') {
          const page = Number(parsed.searchParams.get('page'));
          const body = PAGES[page - 1];
          if (body === undefined) throw new Error('HTTP 404 Not Found');
          return body;
        }
        if (parsed.pathname === '/api/positions' && parsed.searchParams.get('company') === 'ZETA') {
          return { data: { rows: [{ positionCode: 'P-001', name: { en: 'Zeta analyst' }, vacant: false }], hasNextPage: false } };
        }
        if (parsed.pathname === '/api/broken') return 'not an object';
        throw new Error('HTTP 500 Internal Server Error');
      },
    };
  }

  it('pages until next is false, binding {Company} and {page} from the row', async () => {
    const stub = stubFetch();
    const fetched = await new LookupFetcher(stub.fetchJson).fetch(POSITIONS, { Company: 'ACME' }, 'http://fixture.test');
    assert.equal(fetched.status, 'ok');
    if (fetched.status === 'ok') {
      assert.equal(fetched.pages, 3);
      assert.equal(fetched.rows.length, 6);
    }
    assert.deepEqual(stub.calls, [
      'http://fixture.test/api/positions?company=ACME&page=1',
      'http://fixture.test/api/positions?company=ACME&page=2',
      'http://fixture.test/api/positions?company=ACME&page=3',
    ]);
  });

  it('caches per bound URL within one fetcher — a second asker costs no call', async () => {
    const stub = stubFetch();
    const fetcher = new LookupFetcher(stub.fetchJson);
    await fetcher.fetch(POSITIONS, { Company: 'ACME' }, 'http://fixture.test');
    await fetcher.fetch(POSITIONS, { company: 'ACME' }, 'http://fixture.test');
    await fetcher.fetch(POSITIONS, { Company: 'ZETA' }, 'http://fixture.test');
    assert.equal(stub.calls.length, 4, 'three ACME pages once, one ZETA page');
    assert.equal(fetcher.urls.length, 4);
  });

  it('stops after one page when the lookup declares no next path', async () => {
    const stub = stubFetch();
    const { next: _omitted, ...onePage } = POSITIONS;
    const fetched = await new LookupFetcher(stub.fetchJson).fetch(onePage, { Company: 'ACME' }, 'http://fixture.test');
    assert.equal(fetched.status, 'ok');
    if (fetched.status === 'ok') assert.equal(fetched.rows.length, 2);
    assert.equal(stub.calls.length, 1);
  });

  it('turns a thrown answer into unknown with the reason, never a throw', async () => {
    const stub = stubFetch();
    const fetched = await new LookupFetcher(stub.fetchJson).fetch(
      { ...POSITIONS, url: '/api/nowhere?page={page}' },
      {},
      'http://fixture.test',
    );
    assert.equal(fetched.status, 'unknown');
    if (fetched.status === 'unknown') assert.match(fetched.reason, /HTTP 500/);
  });

  it('turns an answer without the row array into unknown naming the path', async () => {
    const stub = stubFetch();
    const fetched = await new LookupFetcher(stub.fetchJson).fetch({ ...POSITIONS, url: '/api/broken' }, {}, 'http://fixture.test');
    assert.equal(fetched.status, 'unknown');
    if (fetched.status === 'unknown') assert.match(fetched.reason, /'data\.rows' is not an array/);
  });

  it('reports an unbound token as unknown rather than fetching a guess', async () => {
    const stub = stubFetch();
    const fetched = await new LookupFetcher(stub.fetchJson).fetch(POSITIONS, {}, 'http://fixture.test');
    assert.equal(fetched.status, 'unknown');
    if (fetched.status === 'unknown') assert.match(fetched.reason, /unbound token\(s\): Company/);
    assert.equal(stub.calls.length, 0);
  });

  it('ends a next that never turns false at the page cap, as unknown', async () => {
    let calls = 0;
    const fetcher = new LookupFetcher(async () => {
      calls += 1;
      return { data: { rows: [{ positionCode: `P-${calls}` }], hasNextPage: true } };
    });
    const fetched = await fetcher.fetch(POSITIONS, { Company: 'X' }, 'http://fixture.test');
    assert.equal(fetched.status, 'unknown');
    assert.equal(calls, MAX_LOOKUP_PAGES);
  });

  it('fetchJsonThrough rejects a non-2xx and a non-JSON body so the fetcher can say unknown', async () => {
    const answers: Record<string, { status: number; body: string }> = {
      '/ok': { status: 200, body: '{"data":{"rows":[],"hasNextPage":false}}' },
      '/html': { status: 200, body: '<!doctype html><title>sign in</title>' },
      '/gone': { status: 404, body: '{"error":"gone"}' },
    };
    const transport: ApiTransport = {
      id: 'stub',
      send: async (spec) => {
        const answer = answers[new URL(spec.url).pathname] ?? { status: 500, body: '' };
        return { status: answer.status, statusText: '', headers: {}, body: answer.body, durationMs: 0, sizeBytes: 0 };
      },
    };
    const fetchJson = fetchJsonThrough(transport);
    assert.deepEqual(await fetchJson('http://fixture.test/ok'), { data: { rows: [], hasNextPage: false } });
    await assert.rejects(fetchJson('http://fixture.test/html'), /not JSON/);
    await assert.rejects(fetchJson('http://fixture.test/gone'), /HTTP 404/);
  });
});

describe('master data — from a catalog to a report', () => {
  async function fixtureCases(): Promise<{ caseId: string; pairs: { key: string; value: string }[] }[]> {
    const table = parseTestCaseTable(await readFile(join(FIXTURES, 'master-data-cases.csv'), 'utf8'));
    assert.ok(table !== null, 'the fixture is a test-case table');
    return table.map((row) => ({ caseId: row.caseId, pairs: testDataPairs(row.testData) }));
  }

  it('plans one fetch per (lookup, bound tokens) and keeps unbound rows apart', async () => {
    const lookups = await readMasterDataDeclaration(join(FIXTURES, 'master-data.lookups.json'));
    const plans = planLookups(lookups, await fixtureCases());
    assert.deepEqual(
      plans.map((p) => [p.lookup.field[0], p.bindings, p.uses.map((u) => `${u.caseId}:${u.code}`)]),
      [
        ['Position', { Company: 'ACME' }, ['MD_01_01:P-001', 'MD_01_02:P-005', 'MD_01_03:P-001', 'MD_01_04:P-404']],
        ['Position', { Company: 'ZETA' }, ['MD_02_01:P-001']],
        ['Position', {}, ['MD_02_02:P-002']],
        ['Cost Center', {}, ['MD_03_01:CC-9']],
      ],
    );
    assert.deepEqual(plans[2]!.uses[0]!.missing, ['Company']);
  });

  it('grounds a plan, counting rows per code, and summarises what a person must know', async () => {
    const lookups = await readMasterDataDeclaration(join(FIXTURES, 'master-data.lookups.json'));
    const plans = planLookups(lookups, await fixtureCases());
    const fetcher = new LookupFetcher(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/positions' && parsed.searchParams.get('company') === 'ACME') {
        return PAGES[Number(parsed.searchParams.get('page')) - 1];
      }
      if (parsed.pathname === '/api/cost-centers') return [{ code: 'CC-9', title: 'Nine' }];
      throw new Error('HTTP 403 Forbidden');
    });
    const results = [];
    for (const plan of plans) results.push(await groundPlan(plan, fetcher, 'http://fixture.test'));

    const acme = results[0]!;
    assert.equal(acme.status, 'ok');
    assert.deepEqual(
      acme.codes.map((c) => [c.code, c.cases, c.sharedBy, c.found, c.reachable, c.consumable]),
      [
        ['P-001', ['MD_01_01', 'MD_01_03'], 2, true, true, true],
        ['P-005', ['MD_01_02'], 1, true, false, true],
        ['P-404', ['MD_01_04'], 1, false, undefined, undefined],
      ],
    );
    assert.equal(results[1]!.status, 'unknown', 'ZETA answered 403');
    assert.match(results[1]!.reason ?? '', /HTTP 403/);
    assert.equal(results[2]!.status, 'unbound');
    assert.match(results[2]!.reason ?? '', /\{Company\}/);
    assert.equal(results[3]!.status, 'ok');
    assert.equal(results[3]!.codes[0]!.label, 'Nine');
    assert.equal(results[3]!.codes[0]!.reachable, undefined, 'no uiPageSize declared');

    const summary = summarizeGrounding(results);
    assert.equal(summary.codes, 6);
    assert.equal(summary.rows, 7);
    assert.deepEqual(summary.notFound, { codes: 1, rows: 1, first: ['P-404'] });
    assert.deepEqual(summary.unreachable, { codes: 1, rows: 1, first: ['P-005'] });
    assert.deepEqual(summary.contended, { codes: 1, rows: 2, first: ['P-001'] });
    assert.equal(summary.unknownLookups, 2);
    assert.equal(summary.urls.length, 5, 'three ACME pages, the ZETA page that answered 403, the cost-center list');

    const finding = describeGroundingFinding(results);
    assert.match(finding, /^Master data: 6 codes named by 7 rows checked through 4 lookups\./);
    assert.match(finding, /1 code in 1 row is not in the master \(P-404\)/);
    assert.match(finding, /1 code in 1 row exists but sits beyond the rows the UI picker loads, so a person cannot pick it \(P-005\)/);
    assert.match(finding, /1 consumable code is wanted by two or more rows \(2 rows\).*\(P-001\)/);
    assert.match(finding, /2 lookups could not be read/);

    const text = renderGroundingReport(results);
    // Booleans render as yes/no in the table, whether a verdict or a fact.
    assert.match(text, /P-005\s+1\s+yes\s+Foreman\s+yes\s+1\s+no/);
    assert.match(text, /P-404\s+1\s+no\s+-\s+-\s+-\s+-/);
    assert.match(text, /summary: 6 codes \/ 7 rows checked; 1 code\(s\) \/ 1 row\(s\) not found; 1 code\(s\) \/ 1 row\(s\) unreachable; 1 consumable code\(s\) shared by 2\+ rows; 2 lookup\(s\) unread/);
    assert.match(text, /lookups used:\n {2}http:\/\/fixture\.test\/api\/positions\?company=ACME&page=1/);
  });

  it('describes an empty check and a clean one honestly', () => {
    assert.equal(describeGroundingFinding([]), 'Master data: no lookup applied to any row.');
    const clean = describeGroundingFinding([
      { field: ['X'], bindings: {}, status: 'ok', urls: ['http://fixture.test/x'], codes: [{ code: 'A', cases: ['C1'], sharedBy: 1, found: true, reachable: true }] },
    ]);
    assert.match(clean, /Every code was found and reachable\.$/);
  });
});
