/**
 * Contract tests for the repository context engine.
 *
 * Entirely offline and filesystem-only — no model, no browser, no CDP. Every
 * ingester is deterministic static analysis, so these fixtures are small,
 * synthetic mini-projects written to a temp dir per suite.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ContextEngine, matchesRoutePattern, pathnameOf } from '../src/context/context-engine.js';
import { concreteRouteUrl } from '../src/context/route-match.js';
import {
  DEFAULT_CONTEXT_MAX_NODES,
  findRouteForUrl,
  routesForDescription,
  summarize,
  toPromptContext,
} from '../src/context/query.js';
import { HEAL_REPO_HINTS_MAX_LINES, healHintsFrom } from '../src/context/heal-hints.js';
import { detectDbHint } from '../src/context/db-hint.js';
import { ManifestIngester } from '../src/context/ingesters/manifest-ingester.js';
import { ComponentIngester } from '../src/context/ingesters/component-ingester.js';
import { MessageIngester, isMessageFile } from '../src/context/ingesters/message-ingester.js';
import { RouteIngester } from '../src/context/ingesters/route-ingester.js';
import { nearestRoutes, routeIsDeclared } from '../src/context/route-match.js';
import { TestIngester } from '../src/context/ingesters/test-ingester.js';
import type { IngestContext, IngestResult, Ingester, ProjectGraph } from '../src/context/types.js';

async function writeFixture(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
}

/** Every non-ignored file, unsorted-input-safe, mirroring what `ContextEngine`'s own walk would hand an ingester. */
async function ingestContextFor(root: string, files: string[]): Promise<IngestContext> {
  return { rootDir: root, files: [...files].sort() };
}

const NEXT_APP_FIXTURE = {
  'package.json': JSON.stringify({
    name: 'fixture-app',
    version: '1.0.0',
    description: '',
    dependencies: { react: '^18.0.0', next: '^14.0.0' },
  }),
  'README.md': '# Fixture App\n\nA small app for testing.\n',
  'src/components/Button.tsx': `
    import React from 'react';
    export function Button({ children }: { children: React.ReactNode }) {
      return <button>{children}</button>;
    }
  `,
  'src/components/EmployeeCard.tsx': `
    import { Button } from './Button';
    export default function EmployeeCard() {
      return (
        <div>
          <Button>View</Button>
        </div>
      );
    }
  `,
  'app/employees/[id]/page.tsx': `
    import EmployeeCard from '../../../src/components/EmployeeCard';
    export default function EmployeePage() {
      return <EmployeeCard />;
    }
  `,
  'app/(marketing)/about/page.tsx': `
    export default function About() {
      return <div>About</div>;
    }
  `,
  // An i18n catalog (next-intl shape) and a page whose screen binds one of
  // its namespaces — the application's words, indexed and linked.
  'messages/en.json': JSON.stringify({
    plans: { title: 'Benefit Plan Catalog', createPlan: 'Create Plan', intro: 'x'.repeat(200) },
    common: { save: 'Save' },
  }),
  'messages/th.json': JSON.stringify({ plans: { title: 'แคตตาล็อกแผนสวัสดิการ', createPlan: 'สร้างแผน' } }),
  'src/components/PlanHeader.tsx': `
    import { useTranslations } from 'next-intl';
    export function PlanHeader({ isTh }: { isTh: boolean }) {
      const t = useTranslations('plans');
      return (
        <div>
          <h1>{t('title')}</h1>
          <button title={isTh ? 'สร้างแผนสวัสดิการใหม่' : 'Create Benefit Plan'}>Create</button>
          <span>42</span>
        </div>
      );
    }
  `,
  'app/plans/page.tsx': `
    import { PlanHeader } from '../../src/components/PlanHeader';
    export default function PlansPage() {
      return <PlanHeader />;
    }
  `,
  // An App Router page that awaits its data — the shape 21 of the indexed
  // app's 212 pages have, and the one the renders-edge guess used to miss.
  'app/reports/page.tsx': `
    export default async function ReportsPage() {
      const rows = await Promise.resolve([]);
      return <div>{rows.length}</div>;
    }
  `,
  'app/api/employees/route.ts': `
    export function GET() { return new Response('[]'); }
  `,
  // The PL_03_03 shape: a real path that answers writes only. Its GET does
  // not exist, and before methods were indexed nothing could say so.
  'app/api/benefit-plans/route.ts': `
    export const dynamic = 'force-dynamic';
    export async function POST(request: Request) { return new Response('{}'); }
    export async function PUT(request: Request) { return new Response('{}'); }
    export const DELETE = async (request: Request) => new Response('{}');
  `,
  'pages/blog/[slug].tsx': `
    export default function BlogPost() {
      return <article />;
    }
  `,
  'pages/index.tsx': `
    export default function Home() {
      return <main />;
    }
  `,
  'employee.flow.json': JSON.stringify({
    name: 'employee page loads',
    steps: [
      { action: 'goto', url: '/employees/42' },
      { action: 'expectVisible', selector: 'text=View' },
    ],
  }),
  'tests/example.test.ts': `
    import { describe, it } from 'node:test';
    describe('employee page', () => {
      it('renders the card', () => {});
    });
  `,
};

describe('context engine', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-context-'));
    await writeFixture(dir, NEXT_APP_FIXTURE);
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('ManifestIngester', () => {
    it('reads package metadata, frameworks, and a README fallback description', async () => {
      const ctx = await ingestContextFor(dir, Object.keys(NEXT_APP_FIXTURE));
      const result = await new ManifestIngester().ingest(ctx);

      assert.equal(result.nodes.length, 1);
      const [node] = result.nodes;
      assert.equal(node?.kind, 'package');
      assert.equal(node?.name, 'fixture-app');
      assert.equal(node?.detail, 'Fixture App');
      assert.equal(node?.meta?.frameworks, 'react,next.js');
      assert.equal(result.warnings.length, 0);
    });

    it('warns rather than throwing when package.json is absent', async () => {
      const ctx: IngestContext = { rootDir: dir, files: ['README.md'] };
      const result = await new ManifestIngester().ingest(ctx);
      assert.equal(result.nodes.length, 0);
      assert.match(result.warnings[0] ?? '', /no package\.json/);
    });
  });

  describe('ComponentIngester', () => {
    it('parses exported components and links uses/renders through real imports', async () => {
      const ctx = await ingestContextFor(dir, Object.keys(NEXT_APP_FIXTURE));
      const result = await new ComponentIngester().ingest(ctx);

      const byName = new Map(result.nodes.map((node) => [node.name, node]));
      assert.ok(byName.has('Button'));
      assert.ok(byName.has('EmployeeCard'));
      assert.ok(byName.has('EmployeePage'));
      assert.equal(byName.get('EmployeeCard')?.meta?.default, 'true');
      assert.equal(byName.get('Button')?.meta?.default, 'false');

      const employeePage = byName.get('EmployeePage');
      const employeeCard = byName.get('EmployeeCard');
      const button = byName.get('Button');
      assert.ok(
        result.edges.some((e) => e.kind === 'uses' && e.from === employeePage?.id && e.to === employeeCard?.id),
      );
      assert.ok(result.edges.some((e) => e.kind === 'uses' && e.from === employeeCard?.id && e.to === button?.id));
    });

    it('does not fabricate edges for external or unresolved imports', async () => {
      const root = await mkdtemp(join(tmpdir(), 'wowlidator-context-ext-'));
      try {
        await writeFixture(root, {
          'src/Widget.tsx': `
            import { Card } from 'some-external-lib';
            import { Helper } from '@/aliased/helper';
            export function Widget() {
              return <Card><Helper /></Card>;
            }
          `,
        });
        const ctx = await ingestContextFor(root, ['src/Widget.tsx']);
        const result = await new ComponentIngester().ingest(ctx);
        assert.equal(result.nodes.length, 1);
        assert.equal(result.edges.length, 0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('nearestRoutes and routeIsDeclared', () => {
    const routes = [
      '/:locale/admin/benefits/plans',
      '/:locale/admin/benefits/records/:planId',
      '/:locale/admin/benefits',
      '/:locale/admin/employees/:id',
      '/:locale/profile/:tab/benefits',
    ];

    it('names the route a near-miss path plainly meant', () => {
      // be100 PL_02_03 (2026-08-25): a flow navigated to a path that answered
      // 404, and every step after it failed against the error page — filed
      // against the application. The real route was in the index all along.
      assert.equal(
        nearestRoutes('/en/admin/benefits/plans/create', routes)[0]?.pattern,
        '/:locale/admin/benefits/plans',
      );
      // A singular/plural slip is the commonest mistake of all.
      assert.equal(
        nearestRoutes('/en/admin/benefits/plan', routes)[0]?.pattern,
        '/:locale/admin/benefits/plans',
      );
    });

    it('says nothing when nothing literal is shared — silence beats a wrong guess', () => {
      // Every route here has a `:param` first segment, so a purely positional
      // match would "resemble" this path three ways. Three suggestions, all
      // noise, and a reader learns to skip the line.
      assert.deepEqual(nearestRoutes('/en/totally/made/up', routes), []);
      assert.deepEqual(nearestRoutes('', routes), []);
    });

    it('answers whether a path is declared, and declines when nothing is indexed', () => {
      assert.equal(routeIsDeclared('/en/admin/benefits/plans', routes), true);
      assert.equal(routeIsDeclared('/en/admin/benefits/plans?tab=1', routes), true, 'a query is not part of the route');
      assert.equal(routeIsDeclared('/en/admin/benefits/nope', routes), false);
      // No index, no opinion — the caller must not read this as "undeclared".
      assert.equal(routeIsDeclared('/en/anything', []), null);
    });

    it('matches a declared route behind the start URL deployment base path', () => {
      const startUrl = 'https://sit.example.test/humi/th/login';
      const deploymentRoutes = [...routes, '/:locale/login'];
      assert.equal(routeIsDeclared('/humi/th/login', deploymentRoutes, startUrl), true);
      assert.equal(routeIsDeclared('/other/th/login', deploymentRoutes, startUrl), false);
    });
  });

  describe('RouteIngester', () => {
    it('converts App Router dynamic segments and drops route groups', async () => {
      const ctx = await ingestContextFor(dir, Object.keys(NEXT_APP_FIXTURE));
      const result = await new RouteIngester().ingest(ctx);
      // Routes only: an api handler now contributes its `operation` nodes to
      // the same file, and this test is about the route path.
      const byFile = new Map(
        result.nodes.filter((node) => node.kind === 'route').map((node) => [node.file, node]),
      );

      assert.equal(byFile.get('app/employees/[id]/page.tsx')?.name, '/employees/:id');
      assert.equal(byFile.get('app/(marketing)/about/page.tsx')?.name, '/about');
      assert.equal(byFile.get('app/api/employees/route.ts')?.meta?.type, 'api');
    });

    it('reads which HTTP methods an api route exports, and emits one operation each', async () => {
      // be100 PL_03_03 (2026-08-25): `/api/benefit-plans` was indexed from its
      // file path alone, the author took the real path and guessed GET, and
      // the app answered 405 — two `high` defects against correct behaviour.
      // The method is half of what an endpoint is.
      const ctx = await ingestContextFor(dir, Object.keys(NEXT_APP_FIXTURE));
      const result = await new RouteIngester().ingest(ctx);

      const plans = result.nodes.find((n) => n.file === 'app/api/benefit-plans/route.ts' && n.kind === 'route');
      assert.equal(plans?.meta?.['methods'], 'POST,PUT,DELETE', 'all three export shapes are read');

      const operations = result.nodes.filter((n) => n.kind === 'operation').map((n) => n.name).sort();
      assert.deepEqual(operations, [
        'DELETE /api/benefit-plans',
        'GET /api/employees',
        'POST /api/benefit-plans',
        'PUT /api/benefit-plans',
      ]);
      // The id and `METHOD /path` name are the OpenAPI ingester's own shape,
      // so every consumer reads one vocabulary whichever source found it.
      const post = result.nodes.find((n) => n.name === 'POST /api/benefit-plans');
      assert.equal(post?.id, 'operation:POST /api/benefit-plans');
      assert.equal(post?.file, 'app/api/benefit-plans/route.ts');
    });

    it('emits no operation for a page, a layout, or a handler it cannot read', async () => {
      const ctx = await ingestContextFor(dir, Object.keys(NEXT_APP_FIXTURE));
      const result = await new RouteIngester().ingest(ctx);
      const fromPages = result.nodes.filter(
        (n) => n.kind === 'operation' && !n.file.startsWith('app/api/'),
      );
      assert.deepEqual(fromPages, [], 'only api handlers declare methods');
      // A file the walk lists but disk does not hold: silence, never a guess —
      // the route node still stands, with no methods claimed.
      const missing = await new RouteIngester().ingest({
        rootDir: dir,
        files: ['app/api/ghost/route.ts'],
      });
      assert.equal(missing.nodes.length, 1);
      assert.equal(missing.nodes[0]?.kind, 'route');
      assert.equal(missing.nodes[0]?.meta?.['methods'], undefined);
    });

    it('handles Pages Router index and dynamic files', async () => {
      const ctx = await ingestContextFor(dir, Object.keys(NEXT_APP_FIXTURE));
      const result = await new RouteIngester().ingest(ctx);
      const byFile = new Map(
        result.nodes.filter((node) => node.kind === 'route').map((node) => [node.file, node]),
      );

      assert.equal(byFile.get('pages/index.tsx')?.name, '/');
      assert.equal(byFile.get('pages/blog/[slug].tsx')?.name, '/blog/:slug');
    });

    it('guesses a renders edge toward the page component', async () => {
      const ctx = await ingestContextFor(dir, Object.keys(NEXT_APP_FIXTURE));
      const result = await new RouteIngester().ingest(ctx);
      const employeeRoute = result.nodes.find((n) => n.file === 'app/employees/[id]/page.tsx');
      assert.ok(
        result.edges.some(
          (e) => e.kind === 'renders' && e.from === employeeRoute?.id && e.to.endsWith('#EmployeePage'),
        ),
      );
    });

    it('guesses the renders edge for an ASYNC default export too (2026-08-28: 23 orphan routes)', async () => {
      // `export default async function ReportsPage` used to fall through to
      // the filename guess ("Page"), dangle, be pruned — and the generator's
      // repository slice for that page walked to nothing.
      const ctx = await ingestContextFor(dir, Object.keys(NEXT_APP_FIXTURE));
      const result = await new RouteIngester().ingest(ctx);
      const reports = result.nodes.find((n) => n.file === 'app/reports/page.tsx');
      assert.ok(reports, 'the async page is a route');
      assert.ok(
        result.edges.some((e) => e.kind === 'renders' && e.from === reports?.id && e.to.endsWith('#ReportsPage')),
        'the edge names the async default export, not the filename',
      );
    });
  });

  describe('TestIngester', () => {
    it('extracts describe/it titles from a generic test file', async () => {
      const ctx = await ingestContextFor(dir, Object.keys(NEXT_APP_FIXTURE));
      const result = await new TestIngester().ingest(ctx);
      const node = result.nodes.find((n) => n.file === 'tests/example.test.ts');
      assert.ok(node);
      assert.equal(node?.meta?.framework, 'node:test');
      assert.match(node?.detail ?? '', /employee page/);
      assert.match(node?.detail ?? '', /renders the card/);
    });

    it('reads urls and assertion status out of a wowlidator flow file', async () => {
      const ctx = await ingestContextFor(dir, Object.keys(NEXT_APP_FIXTURE));
      const result = await new TestIngester().ingest(ctx);
      const node = result.nodes.find((n) => n.file === 'employee.flow.json');
      assert.equal(node?.meta?.hasAssertion, 'true');
      assert.equal(node?.meta?.urls, '/employees/42');
    });
  });

  describe('MessageIngester', () => {
    it('recognises i18n catalogs by convention, and nothing else', () => {
      assert.equal(isMessageFile('messages/en.json'), true);
      assert.equal(isMessageFile('public/locales/th/common.json'), true);
      assert.equal(isMessageFile('src/i18n/en-US.json'), true);
      assert.equal(isMessageFile('package.json'), false);
      assert.equal(isMessageFile('messages/README.json'), false, 'a stem that is not a locale');
      assert.equal(isMessageFile('src/data/en.json'), false, 'not under an i18n directory');
    });

    it('indexes one node per namespace and locale, with the strings as its detail', async () => {
      const ctx = await ingestContextFor(dir, Object.keys(NEXT_APP_FIXTURE));
      const result = await new MessageIngester().ingest(ctx);
      const en = result.nodes.find((n) => n.file === 'messages/en.json' && n.name === 'plans');
      const th = result.nodes.find((n) => n.file === 'messages/th.json' && n.name === 'plans');
      assert.ok(en && th, 'a node per locale');
      assert.equal(en?.kind, 'message');
      assert.equal(en?.meta?.locale, 'en');
      assert.equal(en?.meta?.keys, '3');
      assert.match(en?.detail ?? '', /title: "Benefit Plan Catalog"/);
      // Short labels come first; a paragraph is quoted cut, never whole.
      assert.ok((en?.detail ?? '').indexOf('createPlan') < (en?.detail ?? '').indexOf('intro'));
      assert.doesNotMatch(en?.detail ?? '', /x{150}/);
      assert.ok(result.nodes.some((n) => n.name === 'common'), 'every namespace, bound or not');
    });

    it('links a component to the namespaces its file binds, and the prompt slice prints the words', async () => {
      const engine = new ContextEngine({ rootDir: dir, cacheFile: join(dir, '.wowlidator/context-graph.json') });
      const graph = await engine.build({ force: true });
      const header = graph.nodes.find((n) => n.name === 'PlanHeader');
      const en = graph.nodes.find((n) => n.kind === 'message' && n.file === 'messages/en.json' && n.name === 'plans');
      assert.ok(header && en);
      assert.ok(graph.edges.some((e) => e.kind === 'uses' && e.from === header?.id && e.to === en?.id), 'PlanHeader uses en plans');
      assert.ok(graph.edges.some((e) => e.kind === 'uses' && e.from === header?.id && e.to.endsWith('th.json#plans')), 'and th');
      // The route-centred slice the generator reads now carries the rendering.
      const slice = toPromptContext(graph, { url: 'http://x.test/plans' });
      assert.match(slice, /renders the plans strings \[en, messages\/en\.json\]: .*Benefit Plan Catalog/);
      assert.match(slice, /แคตตาล็อกแผนสวัสดิการ/, 'the other locale too — the bilingual anyOf needs both');
    });

    it('captures the words a component renders from its own source — both branches of a locale ternary', async () => {
      // The modal title a wording case asked about was a hardcoded JSX
      // attribute (`title={isTh ? 'สร้าง…' : 'Create Benefit Plan'}`) in no
      // catalog — invisible to the index until the component carried it.
      const engine = new ContextEngine({ rootDir: dir, cacheFile: join(dir, '.wowlidator/context-graph.json') });
      const graph = await engine.build({ force: true });
      const header = graph.nodes.find((n) => n.name === 'PlanHeader');
      assert.match(header?.detail ?? '', /"Create Benefit Plan"/);
      assert.match(header?.detail ?? '', /"สร้างแผนสวัสดิการใหม่"/);
      assert.match(header?.detail ?? '', /"Create"/, 'JSX text too');
      assert.doesNotMatch(header?.detail ?? '', /"42"/, 'a number is not a word');
      const slice = toPromptContext(graph, { url: 'http://x.test/plans' });
      assert.match(slice, /PlanHeader .*— says: .*"Create Benefit Plan"/);
    });
  });

  describe('ContextEngine', () => {
    it('builds a linked graph: route -> renders -> component -> uses -> component, test -> covers -> route', async () => {
      const engine = new ContextEngine({ rootDir: dir, cacheFile: join(dir, '.wowlidator/context-graph.json') });
      const graph = await engine.build({ force: true });

      const route = graph.nodes.find((n) => n.name === '/employees/:id');
      const page = graph.nodes.find((n) => n.name === 'EmployeePage');
      const card = graph.nodes.find((n) => n.name === 'EmployeeCard');
      const test = graph.nodes.find((n) => n.file === 'employee.flow.json');
      assert.ok(route && page && card && test);

      assert.ok(graph.edges.some((e) => e.kind === 'renders' && e.from === route?.id && e.to === page?.id));
      assert.ok(graph.edges.some((e) => e.kind === 'uses' && e.from === page?.id && e.to === card?.id));
      assert.ok(graph.edges.some((e) => e.kind === 'covers' && e.from === test?.id && e.to === route?.id));
    });

    it('reuses the cached graph when nothing has changed, and rebuilds when it has', async () => {
      const root = await mkdtemp(join(tmpdir(), 'wowlidator-context-cache-'));
      try {
        await writeFixture(root, { 'package.json': JSON.stringify({ name: 'a', version: '1.0.0' }) });
        const cacheFile = join(root, '.wowlidator/context-graph.json');
        const engine = new ContextEngine({ rootDir: root, cacheFile });

        const first = await engine.build();
        const second = await engine.build();
        assert.equal(second.generatedAt, first.generatedAt); // cache hit: no rebuild happened
        assert.equal(second.signature, first.signature);

        // A different byte length, not just different bytes: the signature is size+mtime, not
        // content, so a same-length edit landing in the same mtime tick as the original write
        // would be indistinguishable from no edit at all — this keeps the assertion deterministic
        // rather than racing the filesystem's mtime resolution.
        await writeFixture(root, { 'package.json': JSON.stringify({ name: 'a', version: '2.0.0-longer' }) });
        const third = await engine.build();
        assert.notEqual(third.signature, first.signature);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('force rebuilds even when the signature is unchanged', async () => {
      let calls = 0;
      const counting: Ingester = {
        id: 'counting',
        async ingest(): Promise<IngestResult> {
          calls += 1;
          return { nodes: [], edges: [], warnings: [] };
        },
      };
      const root = await mkdtemp(join(tmpdir(), 'wowlidator-context-force-'));
      try {
        await writeFixture(root, { 'package.json': JSON.stringify({ name: 'a', version: '1.0.0' }) });
        const engine = new ContextEngine({
          rootDir: root,
          cacheFile: join(root, '.wowlidator/context-graph.json'),
          ingesters: [counting],
        });

        await engine.build();
        assert.equal(calls, 1);
        await engine.build(); // unchanged signature -> served from cache, ingester not re-run
        assert.equal(calls, 1);
        await engine.build({ force: true });
        assert.equal(calls, 2);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('drops edges whose endpoints were never indexed, and records why', async () => {
      const danglingIngester: Ingester = {
        id: 'dangling-test',
        async ingest(): Promise<IngestResult> {
          return {
            nodes: [{ id: 'a', kind: 'component', name: 'A', file: 'a.tsx' }],
            edges: [{ from: 'a', to: 'does-not-exist', kind: 'uses' }],
            warnings: [],
          };
        },
      };
      const root = await mkdtemp(join(tmpdir(), 'wowlidator-context-dangling-'));
      try {
        const engine = new ContextEngine({
          rootDir: root,
          cacheFile: join(root, '.wowlidator/context-graph.json'),
          ingesters: [danglingIngester],
        });
        const graph = await engine.build();
        assert.equal(graph.edges.length, 0);
        assert.ok(graph.sources.some((s) => s.warnings.some((w) => /dropped 1 edge/.test(w))));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('keeps the first node on a duplicate id and warns about the loser', async () => {
      const makeIngester = (id: string, name: string): Ingester => ({
        id,
        async ingest(): Promise<IngestResult> {
          return { nodes: [{ id: 'dup', kind: 'component', name, file: 'x.tsx' }], edges: [], warnings: [] };
        },
      });
      const root = await mkdtemp(join(tmpdir(), 'wowlidator-context-dup-'));
      try {
        const engine = new ContextEngine({
          rootDir: root,
          cacheFile: join(root, '.wowlidator/context-graph.json'),
          ingesters: [makeIngester('first', 'First'), makeIngester('second', 'Second')],
        });
        const graph = await engine.build();
        assert.equal(graph.nodes.length, 1);
        assert.equal(graph.nodes[0]?.name, 'First');
        const secondSource = graph.sources.find((s) => s.id === 'second');
        assert.ok(secondSource?.warnings.some((w) => /duplicate node id/.test(w)));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('does not let one crashing ingester block the others', async () => {
      const crashing: Ingester = {
        id: 'crashes',
        ingest(): Promise<IngestResult> {
          throw new Error('boom');
        },
      };
      const root = await mkdtemp(join(tmpdir(), 'wowlidator-context-crash-'));
      try {
        await writeFixture(root, { 'package.json': JSON.stringify({ name: 'a', version: '1.0.0' }) });
        const engine = new ContextEngine({
          rootDir: root,
          cacheFile: join(root, '.wowlidator/context-graph.json'),
          ingesters: [crashing, new ManifestIngester()],
        });
        const graph = await engine.build();
        assert.ok(graph.nodes.some((n) => n.kind === 'package'));
        assert.ok(graph.sources.find((s) => s.id === 'crashes')?.warnings.some((w) => /crashed/.test(w)));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('query helpers', () => {
    let graph: ProjectGraph;

    before(async () => {
      const engine = new ContextEngine({ rootDir: dir, cacheFile: join(dir, '.wowlidator/context-graph.json') });
      graph = await engine.build({ force: true });
    });

    it('matches a dynamic route against a concrete URL', () => {
      const route = findRouteForUrl(graph, 'http://localhost:3000/employees/42');
      assert.equal(route?.name, '/employees/:id');
    });

    it('returns undefined when nothing matches', () => {
      assert.equal(findRouteForUrl(graph, 'http://localhost:3000/nowhere'), undefined);
    });

    it('builds a route-centered prompt slice with the renders/uses/covers chain', () => {
      const text = toPromptContext(graph, { url: 'http://localhost:3000/employees/42' });
      assert.match(text, /Project context for \/employees\/:id/);
      assert.match(text, /renders EmployeePage/);
      assert.match(text, /EmployeePage uses EmployeeCard/);
      assert.match(text, /covered by "employee page loads"/);
    });

    it('returns an empty string when no url is given', () => {
      assert.equal(toPromptContext(graph), '');
    });

    it('finds the routes a described journey is about', () => {
      const routes = routesForDescription(graph, 'open the blog post for a slug');
      assert.ok(
        routes.some((route) => route.name === '/blog/:slug'),
        `the description names the blog route; got ${routes.map((r) => r.name).join(', ')}`,
      );
    });

    it('names no route for a description the repository has nothing to do with', () => {
      assert.deepEqual(routesForDescription(graph, 'reconcile the quarterly warehouse manifest'), []);
      assert.deepEqual(routesForDescription(graph, ''), []);
    });

    it('walks from the described routes as well as the starting page', () => {
      // The journey the describe path actually gets: it STARTS on one page and
      // is ABOUT another. Seeded from the start URL alone this section carried
      // two lines about a login screen while everything the test was about sat
      // unread in the same graph — measured on a real `go` invocation against
      // a 1,874-node index.
      const text = toPromptContext(graph, {
        url: 'http://localhost:3000/employees/42',
        query: 'open an employee, then read the blog post about them',
      });
      assert.match(text, /Project context for \/employees\/:id/, 'the page it starts on');
      assert.match(text, /\/blog\/:slug/, 'and the page the description names');
      assert.match(
        text,
        /not the page you are on/,
        'the two claims are labelled apart, or a flow clicks its way to a page it never opened',
      );
    });

    it('is byte-for-byte the url-only walk when no description is given', () => {
      const url = 'http://localhost:3000/employees/42';
      assert.equal(toPromptContext(graph, { url, query: '' }), toPromptContext(graph, { url }));
    });

    it('still reports a url no route matches, so callers can tell it apart from silence', () => {
      const text = toPromptContext(graph, { url: 'http://localhost:3000/nowhere' });
      assert.match(text, /^Project context: no indexed route matches/);
    });

    // The healer's slice of this graph: bounded, and the no-match sentinel is
    // suppressed — a healer told "nothing matches" learns nothing about the
    // tree in front of it (`heal-hints.ts`).
    it('heal hints trim the graph slice to the hint budget and drop the sentinel', () => {
      const hints = healHintsFrom(graph, [])({
        url: 'http://localhost:3000/employees/42',
        selector: 'role=link[name="Employee" i]',
        intent: 'open the employee page',
      });
      assert.ok(hints.repoHints !== undefined);
      assert.match(hints.repoHints!, /Project context for \/employees\/:id/);
      assert.ok(hints.repoHints!.split('\n').length <= HEAL_REPO_HINTS_MAX_LINES);
      const nowhere = healHintsFrom(graph, [])({
        url: 'http://localhost:3000/nowhere',
        selector: 'role=button[name="Save" i]',
      });
      assert.equal(nowhere.repoHints, undefined);
    });

    it('truncates at the node budget and says so', () => {
      const text = toPromptContext(graph, { url: 'http://localhost:3000/employees/42', maxNodes: 2 });
      assert.match(text, /context truncated at 2 nodes/);
    });

    it('summarizes node counts and surfaces ingester warnings', () => {
      const text = summarize(graph);
      assert.match(text, /nodes\s+\d+ \(/);
      assert.match(text, /edges\s+\d+/);
    });
  });

  describe('turning a route pattern into a page to open', () => {
    // The resolver behind `--capture-journey`. Its refusals are the feature:
    // every parameter it cannot fill from evidence is a segment that would
    // otherwise be invented, and an invented `:id` navigates somewhere
    // meaningless while looking exactly like a real destination.
    const start = 'http://localhost:3200/en/login';

    it('fills :locale from the start url, at the same position', () => {
      assert.deepEqual(concreteRouteUrl('/:locale/overtime', start), {
        ok: true,
        url: 'http://localhost:3200/en/overtime',
      });
    });

    it('preserves a deployment base path before the locale', () => {
      assert.deepEqual(concreteRouteUrl('/:locale/overtime', 'https://sit.example.test/humi/th/login'), {
        ok: true,
        url: 'https://sit.example.test/humi/th/overtime',
      });
    });

    it('accepts a wholly static pattern', () => {
      assert.deepEqual(concreteRouteUrl('/admin/employees', start), {
        ok: true,
        url: 'http://localhost:3200/admin/employees',
      });
    });

    it('refuses a parameter that is not the locale', () => {
      const got = concreteRouteUrl('/:locale/employees/:id', start);
      assert.equal(got.ok, false);
      assert.match(got.ok === false ? got.reason : '', /:id/);
    });

    it('refuses a catch-all', () => {
      const got = concreteRouteUrl('/blog/*slug', start);
      assert.equal(got.ok, false);
      assert.match(got.ok === false ? got.reason : '', /catch-all/);
    });

    it('refuses when the start url has no locale where one is needed', () => {
      // "/login" is not a locale, and filling :locale with it would produce
      // /login/overtime — a URL that grounds nothing and reads like one that does.
      const got = concreteRouteUrl('/:locale/overtime', 'http://localhost:3200/login');
      assert.equal(got.ok, false);
      assert.match(got.ok === false ? got.reason : '', /locale/);
    });

    it('accepts a regional locale and keeps the origin, port and all', () => {
      assert.deepEqual(concreteRouteUrl('/:locale/overtime', 'https://app.test:8443/en-GB/login'), {
        ok: true,
        url: 'https://app.test:8443/en-GB/overtime',
      });
    });

    it('refuses a start url that is not absolute', () => {
      const got = concreteRouteUrl('/:locale/overtime', '/en/login');
      assert.equal(got.ok, false);
      assert.match(got.ok === false ? got.reason : '', /not absolute/);
    });
  });

  describe('route pattern matching', () => {
    it('matches static, dynamic, and catch-all segments', () => {
      assert.equal(matchesRoutePattern('/employees/42', '/employees/:id'), true);
      assert.equal(matchesRoutePattern('/employees', '/employees/:id'), false);
      assert.equal(matchesRoutePattern('/blog/a/b/c', '/blog/*slug'), true);
      assert.equal(matchesRoutePattern('/blog', '/blog/*slug'), false);
    });

    it('extracts a pathname from an absolute url or passes through a bare path', () => {
      assert.equal(pathnameOf('http://localhost:3000/foo?x=1'), '/foo');
      assert.equal(pathnameOf('/bare/path'), '/bare/path');
      assert.equal(pathnameOf('not a url'), undefined);
    });
  });

  it('default max node budget stays in sync with the exported constant', () => {
    assert.equal(DEFAULT_CONTEXT_MAX_NODES, 40);
  });
});

describe('db-hint', () => {
  // What a scan learns about the CONNECTION (engine, host, port — never a
  // password value) from the repo's own files, as a hint for the panel.
  it('reads a dotenv DSN, reporting the password location but never its value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wowlidator-dbhint-'));
    await writeFixture(root, {
      '.env': 'DATABASE_URL="postgres://app:s3cret@localhost:5432/hrcenter"\n',
    });
    const hint = await detectDbHint(root);
    assert.equal(hint?.engine, 'postgres');
    assert.equal(hint?.host, 'localhost');
    assert.equal(hint?.port, 5432);
    assert.equal(hint?.database, 'hrcenter');
    assert.equal(hint?.user, 'app');
    assert.match(hint?.passwordAt ?? '', /\.env: DATABASE_URL/);
    // The one rule that matters: the secret never survives into the hint.
    assert.ok(!JSON.stringify(hint).includes('s3cret'));
    assert.equal(hint?.suggestedUrl, 'postgres://app@localhost:5432/hrcenter');
    await rm(root, { recursive: true, force: true });
  });

  it('reads a compose postgres service, publishing port and password location', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wowlidator-dbhint-'));
    await writeFixture(root, {
      'docker-compose.yml': [
        'services:',
        '  db:',
        '    image: postgres:16',
        '    ports:',
        '      - "15432:5432"',
        '    environment:',
        '      POSTGRES_DB: hrcenter',
        '      POSTGRES_USER: app',
        '      POSTGRES_PASSWORD: s3cret',
        '',
      ].join('\n'),
    });
    const hint = await detectDbHint(root);
    assert.equal(hint?.engine, 'postgres');
    // localhost, not the service name: the hint is for connecting from the
    // machine running wowlidator, which is what a published port means.
    assert.equal(hint?.host, 'localhost');
    assert.equal(hint?.port, 15432);
    assert.equal(hint?.database, 'hrcenter');
    assert.match(hint?.passwordAt ?? '', /docker-compose\.yml: POSTGRES_PASSWORD/);
    assert.ok(!JSON.stringify(hint).includes('s3cret'));
    await rm(root, { recursive: true, force: true });
  });

  it('resolves a Prisma datasource through the repo dotenv files, whatever the var is named', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wowlidator-dbhint-'));
    await writeFixture(root, {
      'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n  url = env("HR_DSN")\n}\n',
      '.env.example': 'HR_DSN=postgres://localhost/hrcenter\n',
    });
    const hint = await detectDbHint(root);
    assert.equal(hint?.engine, 'postgres');
    assert.equal(hint?.database, 'hrcenter');
    assert.equal(hint?.port, 5432); // postgres default when the DSN names none
    assert.equal(hint?.passwordAt, undefined);
    await rm(root, { recursive: true, force: true });
  });

  it('says nothing rather than guessing when the repo declares no database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wowlidator-dbhint-'));
    await writeFixture(root, { '.env': 'API_KEY=abc\n', 'docker-compose.yml': 'services:\n  web:\n    image: nginx\n' });
    assert.equal(await detectDbHint(root), null);
    await rm(root, { recursive: true, force: true });
  });
});
