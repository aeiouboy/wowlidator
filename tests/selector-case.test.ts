/**
 * Accessible-name case handling (`src/engine/selector.ts`).
 *
 * The bug this file pins down: wowlidator reads accessible names through Chrome
 * (`Accessibility.getFullAXTree`) but resolves selectors through Playwright's
 * `role=` engine. Chrome applies CSS `text-transform` when computing a name;
 * Playwright does not. Every selector wowlidator wrote for a text-transformed
 * control was therefore unresolvable *by construction* — and the healer could
 * not repair it, because it reads the same tree and proposes the same name.
 *
 * Both tiers, for the usual reasons: the rewrite itself is a pure function and
 * runs always; proving the two accessible-name implementations actually
 * disagree needs a real browser.
 *
 *   npm test                                 # unit + browser (if Chrome is up)
 *   WOWLIDATOR_CDP_URL=http://localhost:9222 npm test
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import {
  fromAxNotation,
  isRoleSelector,
  normaliseAgentSelector,
  qualifyBareRole,
  relaxRoleName,
  stripGreeting,
  withRelaxedRoleName,
  withStableGreeting,
  withoutGreeting,
  withLabelForNonAriaRole,
} from '../src/engine/selector.js';
import { parseRoleSelector } from '../src/coverage/ax-coverage.js';
import { toFlowStep } from '../src/generator/test-generator.js';
import { runFlow, type Flow } from '../src/engine/runner.js';

const CDP_URL = process.env['WOWLIDATOR_CDP_URL'] ?? 'http://localhost:9222';

/**
 * The real-world shape of the bug, reduced: the button's DOM text is sentence
 * case and CSS uppercases it, so Chrome names it "DUE SOON 1 15–29 days" and
 * Playwright names it "Due soon 1 15–29 days".
 */
const TRANSFORM_FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8"><title>text-transform fixture</title>
    <style>.tab { text-transform: uppercase; }</style>
  </head>
  <body>
    <h1 id="greeting">Good morning, ผู้ดูแลระบบ</h1>
    <button type="button" class="tab" id="due-soon">Due soon 1 15–29 days</button>
    <button type="button" id="plain">Search</button>
    <p id="status">idle</p>
    <script>
      document.getElementById('due-soon').addEventListener('click', () => {
        document.getElementById('status').textContent = 'filtered';
      });
    </script>
  </body>
</html>`;

describe('qualifyBareRole', () => {
  // A selector that names a role but omits `role=` is *valid* — Playwright
  // reads the leading token as a CSS tag name — and matches nothing on any
  // page, at any timeout. It is the most damaging thing a model gets wrong
  // when writing selectors because it fails silently and reads as "the control
  // is missing". Found by investigating PB_02_01, whose login could never
  // submit: `textbox >> nth=1` resolved 0 elements where
  // `role=textbox >> nth=1` resolved 1, and all 26 steps ran on the sign-in
  // page as a result.

  it('qualifies a bare role, with and without a chained suffix', () => {
    assert.equal(qualifyBareRole('textbox >> nth=1'), 'role=textbox >> nth=1');
    assert.equal(qualifyBareRole('button'), 'role=button');
    assert.equal(qualifyBareRole('heading[name="Employees"]'), 'role=heading[name="Employees"]');
    assert.equal(
      qualifyBareRole("button[name='Extend until'] >> nth=0"),
      "role=button[name='Extend until'] >> nth=0",
    );
  });

  it('leaves an already-qualified selector alone', () => {
    // `null` rather than the input, so the ladder can skip a second attempt at
    // an identical selector instead of paying the fast-path timeout twice.
    assert.equal(qualifyBareRole('role=button[name="Save"]'), null);
    assert.equal(qualifyBareRole('text="Save"'), null);
    assert.equal(qualifyBareRole('css=button'), null);
    assert.equal(qualifyBareRole('xpath=//button'), null);
    assert.equal(qualifyBareRole('internal:label="Password"'), null);
  });

  it('never rewrites a real CSS selector into a role selector', () => {
    // The dangerous direction: turning a selector that resolves correctly into
    // one that matches something else. Anything structurally CSS is left be.
    assert.equal(qualifyBareRole('.pagination__next'), null);
    assert.equal(qualifyBareRole('#submit'), null);
    assert.equal(qualifyBareRole('form button'), null);
    assert.equal(qualifyBareRole('a > span'), null);
    assert.equal(qualifyBareRole('input:checked'), null);
    assert.equal(qualifyBareRole('[data-testid="x"]'), null);
    // Not an ARIA role, so it was always meant as a tag.
    assert.equal(qualifyBareRole('div'), null);
    assert.equal(qualifyBareRole('input[name="q"]'), null);
  });

  it('declines an attribute the role engine would reject', () => {
    // `role=textbox[placeholder=…]` throws `Unknown attribute "placeholder"`.
    // Qualifying here would swap a silent miss for a thrown step, which is
    // worse: a miss is still repairable by the healer. Seen live in PB_01_01.
    assert.equal(qualifyBareRole("textbox[placeholder='Password']"), null);
    assert.equal(qualifyBareRole('button[title="Save"]'), null);
  });

  it('composes with case relaxation, in that order', () => {
    // Relaxing only recognises `[name=…]` on a role selector, so a bare
    // selector has to be qualified first or the case flag is never added.
    const qualified = qualifyBareRole('button[name="Sign in"]');
    assert.equal(qualified, 'role=button[name="Sign in"]');
    assert.equal(relaxRoleName(qualified!), 'role=button[name="Sign in" i]');
  });
});

describe('relaxRoleName', () => {
  it('adds the case-insensitive flag to a role selector with a name', () => {
    assert.equal(
      relaxRoleName('role=button[name="DUE SOON 1 15–29 days"]'),
      'role=button[name="DUE SOON 1 15–29 days" i]',
    );
    assert.equal(relaxRoleName("role=link[name='Sign in']"), "role=link[name='Sign in' i]");
  });

  it('preserves everything around the name, including nth= disambiguation', () => {
    assert.equal(
      relaxRoleName('role=button[name="Edit"] >> nth=2'),
      'role=button[name="Edit" i] >> nth=2',
    );
  });

  it('does not mangle a name containing replacement-pattern syntax', () => {
    // `String.replace` expands `$&` and `$1` in a string replacement — the
    // reason the implementation passes a function instead.
    assert.equal(relaxRoleName('role=button[name="Total $& $1"]'), 'role=button[name="Total $& $1" i]');
  });

  it('returns null when there is nothing to relax', () => {
    assert.equal(relaxRoleName('.pagination__next'), null, 'CSS selector');
    assert.equal(relaxRoleName('text=Sign in'), null, 'text engine');
    assert.equal(relaxRoleName('[data-testid="submit"]'), null, 'testid');
    assert.equal(relaxRoleName('role=button'), null, 'role with no name');
    assert.equal(relaxRoleName('role=button[name="Save" i]'), null, 'already flagged');
  });

  it('withRelaxedRoleName passes untouched selectors through', () => {
    assert.equal(withRelaxedRoleName('.next'), '.next');
    assert.equal(withRelaxedRoleName('role=button[name="Save"]'), 'role=button[name="Save" i]');
  });

  it('isRoleSelector only claims role-engine selectors', () => {
    assert.equal(isRoleSelector('role=button[name="Save"]'), true);
    assert.equal(isRoleSelector('button[name="Save"]'), false);
  });
});

describe('volatile greetings', () => {
  it('strips a time-of-day greeting and keeps the name — English and Thai', () => {
    assert.equal(stripGreeting('Good afternoon, ผู้ดูแลระบบ'), 'ผู้ดูแลระบบ');
    assert.equal(stripGreeting('Good Morning ผู้ดูแลระบบ'), 'ผู้ดูแลระบบ');
    assert.equal(stripGreeting('good evening: Jane Doe'), 'Jane Doe');
    assert.equal(stripGreeting('สวัสดีตอนบ่าย ผู้ดูแลระบบ'), 'ผู้ดูแลระบบ');
  });

  it('leaves text with no greeting, or nothing but a greeting, alone', () => {
    assert.equal(stripGreeting('Add New Employee'), null);
    assert.equal(stripGreeting('Good morning'), null);
    assert.equal(stripGreeting('Goodwill ledger'), null);
  });

  it('re-writes text and role selectors to assert the name alone', () => {
    // The live case: six ec10 flows asserted the afternoon greeting on a clock
    // pinned to midnight — the page said "Good morning, ผู้ดูแลระบบ".
    assert.equal(withoutGreeting('text=Good afternoon, ผู้ดูแลระบบ'), 'text=ผู้ดูแลระบบ');
    assert.equal(withoutGreeting('text="Good afternoon, ผู้ดูแลระบบ"'), 'text=ผู้ดูแลระบบ');
    assert.equal(withoutGreeting('text=Good afternoon, ผู้ดูแลระบบ >> nth=0'), 'text=ผู้ดูแลระบบ >> nth=0');
    // A quoted role name is an EXACT match in Playwright's role engine, so
    // the name goes in as a regex — it has to match with the greeting around it.
    assert.equal(
      withoutGreeting('role=heading[name="Good afternoon, ผู้ดูแลระบบ" i]'),
      'role=heading[name=/ผู้ดูแลระบบ/i]',
    );
    assert.equal(withoutGreeting("role=heading[name='Good evening, Jane (HR)']"), 'role=heading[name=/Jane \\(HR\\)/i]');
  });

  it('returns null when there is nothing to change, so the ladder pays no extra attempt', () => {
    assert.equal(withoutGreeting('text=Add New Employee'), null);
    assert.equal(withoutGreeting('role=button[name="Sign in" i]'), null);
    assert.equal(withoutGreeting('text=/Good (morning|afternoon)/'), null);
    assert.equal(withoutGreeting('input[type="password"]'), null);
    assert.equal(withStableGreeting('text=Add New Employee'), 'text=Add New Employee');
    assert.equal(withStableGreeting('text=Good afternoon, ผู้ดูแลระบบ'), 'text=ผู้ดูแลระบบ');
  });
});

describe('AX-tree notation from the agent', () => {
  it('turns the tree line the model copied into the role selector it meant', () => {
    // Live, ec10 HIR-EC-003: each of these cost a turn as a CSS miss.
    assert.equal(fromAxNotation('region "Dependents Dependents"'), 'role=region[name="Dependents Dependents" i]');
    assert.equal(fromAxNotation('spinbutton "Day Day"'), 'role=spinbutton[name="Day Day" i]');
    assert.equal(fromAxNotation('heading "National ID / Tax ID"'), 'role=heading[name="National ID / Tax ID" i]');
    assert.equal(fromAxNotation('textbox "Search options" >> nth=1'), 'role=textbox[name="Search options" i] >> nth=1');
    assert.equal(fromAxNotation('"Add Dependent"'), 'text="Add Dependent"');
  });

  it('leaves real selectors and unknown roles alone', () => {
    assert.equal(fromAxNotation('role=button[name="Save" i]'), null);
    assert.equal(fromAxNotation('text=A - Permanent'), null);
    assert.equal(fromAxNotation('div "not a role"'), null);
    assert.equal(fromAxNotation('.card button'), null);
  });

  it('normaliseAgentSelector composes notation, bare role and case', () => {
    assert.equal(normaliseAgentSelector('region "Dependents Dependents"'), 'role=region[name="Dependents Dependents" i]');
    assert.equal(normaliseAgentSelector('button[name="Save"]'), 'role=button[name="Save" i]');
    assert.equal(normaliseAgentSelector('role=button[name="Save" i]'), 'role=button[name="Save" i]');
    assert.equal(normaliseAgentSelector('text=A - Permanent'), 'text=A - Permanent');
  });
});

describe('generated steps carry the flag', () => {
  it('narrows a generated click into a case-insensitive selector', () => {
    const step = toFlowStep({
      action: 'click',
      selector: 'role=button[name="DUE SOON"]',
      value: '',
      url: '',
      intent: 'Click the Due soon filter.',
    });
    assert.deepEqual(step, {
      action: 'click',
      selector: 'role=button[name="DUE SOON" i]',
      intent: 'Click the Due soon filter.',
    });
  });

  it('writes a sign-in proof that quotes a greeting against the name alone', () => {
    const step = toFlowStep({
      action: 'expectVisible',
      selector: 'text=Good afternoon, ผู้ดูแลระบบ',
      value: '',
      url: '',
      intent: 'Assert who is signed in.',
    });
    assert.equal((step as { selector: string }).selector, 'text=ผู้ดูแลระบบ');
    const heading = toFlowStep({
      action: 'expectVisible',
      selector: 'role=heading[name="Good afternoon, ผู้ดูแลระบบ"]',
      value: '',
      url: '',
      intent: '',
    });
    assert.equal((heading as { selector: string }).selector, 'role=heading[name=/ผู้ดูแลระบบ/i]');
  });

  it('leaves selectorless and non-role steps alone', () => {
    assert.deepEqual(toFlowStep({ action: 'goto', selector: '', value: '', url: '/x', intent: '' }), {
      action: 'goto',
      url: '/x',
    });
    const css = toFlowStep({
      action: 'expectVisible',
      selector: '#total',
      value: '',
      url: '',
      intent: '',
    });
    assert.equal((css as { selector: string }).selector, '#total');
  });
});

describe('coverage attribution tolerates the flag', () => {
  it('parses a flagged role selector back into role and name', () => {
    assert.deepEqual(parseRoleSelector('role=button[name="Save" i]'), {
      role: 'button',
      name: 'Save',
    });
    // Without this the generated form lands in `unattributed` and coverage
    // reports zero for every generated suite.
    assert.deepEqual(parseRoleSelector("role=tab[name='Due soon' i]"), {
      role: 'tab',
      name: 'Due soon',
    });
  });
});

async function cdpAvailable(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

const browserReady = await cdpAvailable(CDP_URL);
const skipBrowser = browserReady
  ? false
  : `no CDP endpoint at ${CDP_URL} — start Chrome with --remote-debugging-port=9222 (npm run chrome)`;

describe('case-relaxed resolution (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;
  let dir: string;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(TRANSFORM_FIXTURE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
    dir = await mkdtemp(join(tmpdir(), 'wowlidator-case-'));
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('rescues a Chrome-cased selector for free, with the healer switched off', async () => {
    const flow: Flow = {
      name: 'uppercase filter tab',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        // Exactly what captureAxNodes reports for this button, and exactly what
        // a pre-existing flow written before this fix would contain.
        { action: 'click', selector: 'role=button[name="DUE SOON 1 15–29 DAYS"]' },
        { action: 'expectText', selector: '#status', value: 'filtered' },
      ],
    };
    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'case.json'),
      // No healer: the rung has to be free and deterministic, or it is just a
      // slower way to reach the paid one.
      healer: null,
    });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'case rung should resolve the click');
    const click = bundle.steps.find((s) => s.action === 'click');
    assert.equal(click?.resolution, 'case');
    assert.match(click?.resolvedSelector ?? '', / i\]/);
    assert.equal(bundle.summary.caseRetries, 1);
    assert.equal(bundle.summary.jitHeals, 0);
  });

  it('matches a greeting proof on the name when the page greets a different time of day', async () => {
    // The ec10 shape verbatim: the flow says afternoon, the page says morning.
    const flow: Flow = {
      name: 'greeting proof',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'expectVisible', selector: 'text=Good afternoon, ผู้ดูแลระบบ' },
        { action: 'expectVisible', selector: 'role=heading[name="Good evening, ผู้ดูแลระบบ" i]' },
      ],
    };
    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'greeting.json'),
      healer: null,
    });
    assert.equal(bundle.status, 'passed', bundle.error ?? 'the greeting rung should resolve both proofs');
    const [, text, heading] = bundle.steps;
    assert.equal(text?.resolution, 'narrow');
    assert.equal(text?.resolvedSelector, 'text=ผู้ดูแลระบบ');
    assert.equal(heading?.resolution, 'narrow');
    assert.equal(heading?.resolvedSelector, 'role=heading[name=/ผู้ดูแลระบบ/i]');
    assert.ok((bundle.notes ?? []).some((n) => n.includes('greets by time of day')));
    assert.equal(bundle.summary.jitHeals, 0);
  });

  it('still resolves a correctly-cased selector on the fast path', async () => {
    const flow: Flow = {
      name: 'sentence-case filter tab',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'click', selector: 'role=button[name="Due soon 1 15–29 days" i]' },
        { action: 'expectText', selector: '#status', value: 'filtered' },
      ],
    };
    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'fast.json'),
      healer: null,
    });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'flagged selector should match directly');
    const click = bundle.steps.find((s) => s.action === 'click');
    assert.equal(click?.resolution, 'fast');
    assert.equal(bundle.summary.caseRetries, 0);
  });

  it('credits the control in coverage despite the case difference', async () => {
    const flow: Flow = {
      name: 'coverage attribution',
      baseUrl: origin,
      steps: [
        { action: 'goto', url: '/' },
        { action: 'click', selector: 'role=button[name="Due soon 1 15–29 days" i]' },
        { action: 'expectText', selector: '#status', value: 'filtered' },
      ],
    };
    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      cachePath: join(dir, 'coverage.json'),
      healer: null,
      coverage: true,
    });

    assert.equal(bundle.status, 'passed', bundle.error ?? 'flow should pass');
    const coverage = bundle.coverage;
    assert.ok(coverage, 'coverage should have been measured');
    // Two buttons on the page, one of them exercised. Before the fix the
    // Chrome-cased inventory entry and the Playwright-cased step never met, so
    // this reported 1/3 — a phantom third control, and nothing exercised.
    assert.equal(coverage.total, 2);
    assert.equal(coverage.exercised, 1);
    // The CSS selector stays unattributed — that is the existing
    // understate-never-overstate rule, not fallout from case handling.
    assert.deepEqual(coverage.unattributed, ['#status']);
  });
});

describe('a role the ARIA vocabulary does not hold is addressed by its label (HIR-EC-001, 2026-09-07)', () => {
  it('rewrites a native date input, in both spellings, and keeps the chain', () => {
    assert.equal(withLabelForNonAriaRole('role=date[name="Hire Date" i]'), 'internal:label="Hire Date"i');
    assert.equal(withLabelForNonAriaRole('Date "Hire Date"'), 'internal:label="Hire Date"i');
    assert.equal(withLabelForNonAriaRole('role=date[name="Hire Date" i] >> nth=0'), 'internal:label="Hire Date"i >> nth=0');
  });

  it('rewrites the CSS spelling too — the one a model reaches for once the role has failed it', () => {
    // Live (run 15): `input[type="date"][aria-label="Hire Date"]` and its
    // Date-of-Birth twin burned 74 s, 96 s and 5 s in one run and entered
    // nothing. `[aria-label=…]` matches nothing on that page — the name comes
    // from a `<label for>`, which is exactly what the label engine reads.
    assert.equal(withLabelForNonAriaRole('input[type="date"][aria-label="Hire Date"]'), 'internal:label="Hire Date"i');
    assert.equal(withLabelForNonAriaRole("input[type=date][aria-label='Date of Birth']"), 'internal:label="Date of Birth"i');
    assert.equal(
      withLabelForNonAriaRole('input[type="date"][aria-label="Hire Date"] >> nth=0'),
      'internal:label="Hire Date"i >> nth=0',
    );
  });

  it('leaves a CSS selector alone wherever the attribute is the real handle', () => {
    // Only the native input TYPES, where the label is all there is. On a text
    // input an aria-label is a real attribute and the selector works.
    for (const selector of [
      'input[type="text"][aria-label="Search"]',
      'input[type="password"][aria-label="Password"]',
      'input[type="date"]',
      'div[aria-label="Hire Date"]',
    ]) {
      assert.equal(withLabelForNonAriaRole(selector), selector);
    }
  });

  it('leaves every ARIA role exactly as it was', () => {
    for (const selector of [
      'role=textbox[name="First Name (EN)" i]',
      'role=button[name="Company" i]',
      'role=spinbutton[name="Day Day" i]',
      'text=Hire Date',
      'input[type="date"]',
    ]) {
      assert.equal(withLabelForNonAriaRole(selector), selector);
    }
  });

  it('leaves a non-ARIA role that is not an input alone rather than trading one wrong selector for another', () => {
    assert.equal(withLabelForNonAriaRole('StaticText "10300"'), 'StaticText "10300"');
    assert.equal(withLabelForNonAriaRole('RootWebArea "Add New Employee"'), 'RootWebArea "Add New Employee"');
  });

  it('is part of the agent normaliser', () => {
    assert.equal(normaliseAgentSelector('role=date[name="Date of Birth" i]'), 'internal:label="Date of Birth"i');
  });
});
