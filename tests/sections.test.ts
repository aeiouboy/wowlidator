/**
 * Data sections (`src/cli/sections.ts`) — entirely unit-tier: every rule is a
 * pure function over flows and pairs, pinned here exactly as the spec's §2.2
 * table states them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Flow, FlowStep } from '../src/engine/runner.js';
import {
  GLOBAL_SECTION,
  sectionAliaser,
  caseScheduleMeta,
  compatibleCases,
  expandSections,
  fkPairsFromGraph,
  isGloballyExclusive,
  routeSectionOf,
  sectionsEnabled,
  windowsInterfere,
  type CaseScheduleMeta,
} from '../src/cli/sections.js';

function flow(steps: FlowStep[]): Flow {
  return { name: 'f', baseUrl: 'http://localhost:3000', steps };
}

describe('the switch', () => {
  it('is on unless WOWLIDATOR_SECTIONS=off', () => {
    assert.equal(sectionsEnabled({}), true);
    assert.equal(sectionsEnabled({ WOWLIDATOR_SECTIONS: 'off' }), false);
  });
});

describe('section derivation', () => {
  it('tables come from DB steps, routes from gotos, and login pages count for nothing', () => {
    const meta = caseScheduleMeta(
      flow([
        { action: 'goto', url: 'http://localhost:3000/en/login' },
        { action: 'goto', url: 'http://localhost:3000/en/admin/benefits/plans' },
        { action: 'expectDbRow', table: 'benefit_management.benefit_plan', where: { id: 'x' } } as FlowStep,
      ]),
    );
    assert.ok(meta.sections.includes('table:benefit_management.benefit_plan'), meta.sections.join('|'));
    assert.ok(meta.sections.includes('route:admin/benefits'));
    assert.ok(!meta.sections.some((s) => s.includes('login')));
  });

  it('a dashboard route is the global section', () => {
    assert.equal(routeSectionOf('http://x/en/dashboard'), GLOBAL_SECTION);
    assert.equal(routeSectionOf('http://x/th/admin/benefits/plans'), 'route:admin/benefits');
  });

  it('a base path in front of the locale is not a place either', () => {
    // An app served under one path segment: every page used to share one
    // section (`route:app/th`), the sign-in page included — so every writer
    // in a parallel suite queued behind every other.
    assert.equal(routeSectionOf('http://x/app/th/admin/hire'), 'route:admin/hire');
    assert.equal(routeSectionOf('http://x/app/en-GB/admin/hire?step=2'), 'route:admin/hire');
    assert.equal(routeSectionOf('http://x/app/th/login'), null, 'sign-in is preparation, not a section');
    assert.equal(routeSectionOf('http://x/app/th/home'), GLOBAL_SECTION);
    assert.notEqual(routeSectionOf('http://x/app/th/admin/hire'), routeSectionOf('http://x/app/th/consent'));
    // No locale at all: the first two segments are the place, as before.
    assert.equal(routeSectionOf('http://x/admin/benefits/plans'), 'route:admin/benefits');
  });

  it('deletes are read from request verbs and workflow goals', () => {
    assert.equal(
      caseScheduleMeta(flow([{ action: 'request', method: 'DELETE', url: '/api/plans/1' } as FlowStep])).deletes,
      true,
    );
    assert.equal(
      caseScheduleMeta(flow([{ action: 'workflow', goal: 'delete the QA plan and end on /plans' }])).deletes,
      true,
    );
  });
});

describe('FK expansion — a section is a join family, not a table', () => {
  const graph = {
    edges: [
      { from: 'table:a.plan', to: 'table:a.enrollment', kind: 'references' },
      { from: 'table:a.enrollment', to: 'table:a.person', kind: 'references' },
      { from: 'route:x', to: 'table:a.plan', kind: 'uses' },
    ],
  };

  it('two tables joined by FK land in one component, named stably', () => {
    const pairs = fkPairsFromGraph(graph);
    assert.deepEqual(pairs, [
      ['a.plan', 'a.enrollment'],
      ['a.enrollment', 'a.person'],
    ]);
    const one = expandSections(['table:a.person'], pairs);
    const other = expandSections(['table:a.plan'], pairs);
    assert.deepEqual(one, other, 'every member of the family derives the same key');
  });

  it('routes and unknown tables pass through untouched', () => {
    const pairs = fkPairsFromGraph(graph);
    assert.deepEqual(expandSections(['route:admin/benefits', 'table:other.thing'], pairs), [
      'route:admin/benefits',
      'table:other.thing',
    ]);
  });
});

describe('the pairing rules — §2.2 verbatim', () => {
  const meta = (writes: boolean, sections: string[], deletes = false): CaseScheduleMeta => ({
    writes,
    sections,
    deletes,
  });

  it('reader ∥ reader always', () => {
    assert.equal(compatibleCases(meta(false, ['table:a']), meta(false, ['table:a'])), true);
  });

  it('a writer needs disjoint sections against anyone', () => {
    assert.equal(compatibleCases(meta(true, ['table:a']), meta(false, ['table:a'])), false);
    assert.equal(compatibleCases(meta(true, ['table:a']), meta(false, ['table:b'])), true);
    assert.equal(compatibleCases(meta(true, ['table:a']), meta(true, ['table:b'])), true);
    assert.equal(compatibleCases(meta(true, ['table:a']), meta(true, ['table:a'])), false);
  });

  it('unknown sections, deletes, and the global section are exclusive', () => {
    assert.equal(isGloballyExclusive(meta(true, [])), true, 'prose-only writer stays alone');
    assert.equal(isGloballyExclusive(meta(true, ['table:a'], true)), true, 'a delete is always alone');
    assert.equal(isGloballyExclusive(meta(true, [GLOBAL_SECTION, 'table:a'])), true);
    assert.equal(isGloballyExclusive(meta(false, [])), false, 'a reader is never exclusive');
    assert.equal(compatibleCases(meta(true, []), meta(false, ['table:b'])), false);
  });
});

describe('the interference window', () => {
  const at = (meta: CaseScheduleMeta, startedMs: number, endedMs: number) => ({ meta, startedMs, endedMs });
  const writer = (sections: string[]): CaseScheduleMeta => ({ writes: true, sections, deletes: false });
  const reader = (sections: string[]): CaseScheduleMeta => ({ writes: false, sections, deletes: false });

  it('an overlapping writer of an intersecting section interferes; a disjoint or later one does not', () => {
    const mine = at(reader(['table:a']), 100, 200);
    assert.equal(windowsInterfere(mine, at(writer(['table:a']), 150, 300)), true);
    assert.equal(windowsInterfere(mine, at(writer(['table:b']), 150, 300)), false);
    assert.equal(windowsInterfere(mine, at(writer(['table:a']), 250, 300)), false, 'no window overlap');
    assert.equal(windowsInterfere(mine, at(reader(['table:a']), 150, 300)), false, 'a reader never interferes');
  });

  it('unknown sections cannot be excluded — the safe direction', () => {
    const mine = at(reader([]), 100, 200);
    assert.equal(windowsInterfere(mine, at(writer(['table:a']), 150, 300)), true);
  });
});

describe('route↔table aliasing — one case carrying both keys proves they are one section', () => {
  it('after the witness case, a route-only writer and a table-only writer stop co-running', () => {
    const aliases = sectionAliaser();
    const routeOnly: CaseScheduleMeta = { writes: true, sections: ['route:admin/benefits'], deletes: false };
    const tableOnly: CaseScheduleMeta = { writes: true, sections: ['table:benefit_management.benefit_plan'], deletes: false };
    const canon = (m: CaseScheduleMeta): CaseScheduleMeta => ({ ...m, sections: aliases.canon(m.sections) });
    // Before any witness the keys look disjoint — the gap job-2 exposed.
    assert.equal(compatibleCases(canon(routeOnly), canon(tableOnly)), true);
    // The witness: one case carries BOTH keys.
    aliases.note({ writes: true, sections: ['route:admin/benefits', 'table:benefit_management.benefit_plan'], deletes: false });
    assert.equal(compatibleCases(canon(routeOnly), canon(tableOnly)), false, 'aliased into one section');
    // Aliasing only narrows: unrelated sections stay untouched.
    assert.deepEqual(aliases.canon(['route:orders/pending']), ['route:orders/pending']);
  });
});

describe('Thai delete talk (CG-16)', () => {
  it('ลบ / นำออก in a workflow goal mark the case as deleting, outside any ASCII word boundary', () => {
    assert.equal(caseScheduleMeta(flow([{ action: 'workflow', goal: 'ลบ Plan PL_06_21 แล้วตรวจสอบว่าหายไป' }])).deletes, true);
    assert.equal(caseScheduleMeta(flow([{ action: 'workflow', goal: 'นำออกจากรายการ' }])).deletes, true);
    assert.equal(caseScheduleMeta(flow([{ action: 'workflow', goal: 'เปิดหน้า Benefit Plans แล้วอ่านค่า' }])).deletes, false);
  });
});
