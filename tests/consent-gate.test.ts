/**
 * Consent-gate recovery — docs/consent-gate-recovery-spec.md, all four fixes.
 *
 * The fixture is a miniature of the application that forced the spec
 * (BE_Test2.csv, 2026-08-20 11:52): a CLIENT-SIDE consent gate keyed on
 * localStorage that renders IN PLACE on whatever URL was asked for — the URL
 * never says "consent" — and whose accept bounces to the app's home landing,
 * abandoning the deep link. Browser-tier where the claim is about a real
 * page (F1, F2, F4), pure where it is not (F3). Same CDP gate as the
 * sibling suites.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { runFlow, withPage, type Flow, type FlowStep } from '../src/engine/runner.js';
import { acceptConsentGate } from '../src/engine/consent-gate.js';
import { settleConsentEarly } from '../src/generator/flow-author.js';
import { WorkflowAgent, type AgentDecision, type AgentObservation } from '../src/orchestrator/workflow-agent.js';

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

/**
 * A page that renders the gate CLIENT-SIDE when the context has not accepted
 * yet — URL unchanged, consent heading showing — and the real content after.
 * `sticky` renders the gate every time, whatever was accepted: the gate that
 * will not stay cleared.
 */
const GATED = (content: string, sticky = false): string =>
  `<!doctype html><html><head><title>fixture</title></head><body><div id="root"></div>
<script>
  var ok = ${sticky ? 'false' : "localStorage.getItem('gate-ok') === '1'"};
  if (ok) {
    document.getElementById('root').innerHTML = ${JSON.stringify(content)};
  } else {
    document.getElementById('root').innerHTML =
      '<h1>Consent to the Collection of Personal Data</h1>' +
      '<button id="accept">Accept and continue</button>';
    document.getElementById('accept').addEventListener('click', function () {
      localStorage.setItem('gate-ok', '1');
      location.href = '/home';
    });
  }
</script></body></html>`;

const PLAIN = (body: string): string =>
  `<!doctype html><html><head><title>fixture</title></head><body>${body}</body></html>`;

describe('consent-gate recovery (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;

  before(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (path === '/app/target') res.end(GATED('<h1>Target content</h1><button>Create Plan</button>'));
      else if (path === '/app/sticky') res.end(GATED('<h1>Never shown</h1>', true));
      else if (path === '/app/late') {
        res.end(PLAIN('<h1>Loading</h1><script>setTimeout(function(){location.href="/consent";},50);</script>'));
      }
      else if (path === '/login') {
        res.end(PLAIN(
          '<form id="login"><input type="email"><input type="password"><button type="submit">Sign in</button></form>' +
          '<script>document.getElementById("login").addEventListener("submit",function(event){event.preventDefault();location.href="/consent";});</script>',
        ));
      } else if (path === '/consent') {
        res.end(PLAIN(
          '<h1>Consent to the Collection of Personal Data</h1>' +
          '<button onclick="localStorage.setItem(\'gate-ok\',\'1\');location.href=\'/home\'">Accept and continue</button>',
        ));
      } else if (path === '/consent/scroll') {
        res.end(PLAIN(
          '<h1>Consent to the Collection of Personal Data</h1>' +
          '<div id="document" style="height:80px;overflow:auto"><div style="height:400px">Policy</div></div>' +
          '<button id="accept" disabled>Accept and continue</button>' +
          '<script>' +
          'var documentBox=document.getElementById("document");var accept=document.getElementById("accept");' +
          'documentBox.addEventListener("scroll",function(){if(documentBox.scrollTop+documentBox.clientHeight>=documentBox.scrollHeight-1)accept.disabled=false;});' +
          'accept.addEventListener("click",function(){location.href="/home";});' +
          '</script>',
        ));
      }
      else if (path === '/home') res.end(PLAIN('<h1>Home landing</h1>'));
      else if (path === '/other') res.end(PLAIN('<h1>Somewhere else</h1>'));
      else res.end(PLAIN('<h1>Start</h1>'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const runOptions = {
    cdpUrl: CDP_URL,
    video: 'off' as const,
    isolate: true,
    screenshots: 'off' as const,
    healer: null,
  };

  it('F1: a goto through the in-place gate lands on the page it asked for', async () => {
    const flow: Flow = {
      name: 'through the gate',
      steps: [
        { action: 'goto', url: `${origin}/app/target` },
        { action: 'expectVisible', selector: 'role=heading[name="Target content" i]' },
      ],
    };
    const bundle = await runFlow(flow, runOptions);
    assert.equal(bundle.status, 'passed', bundle.error ?? '');
    const nav = bundle.steps.find((s) => s.action === 'goto');
    assert.equal(nav?.detail?.['consentAccepted'], true, 'the step says the gate was accepted');
    assert.ok(bundle.notes?.some((n) => /consent gate/.test(n)), 'the run notes the decision');
    const finding = bundle.defects.find((d) => /consent gate/i.test(d.title));
    assert.equal(finding?.severity, 'low');
    assert.equal(finding?.category, 'usability');
  });

  it('preserves an in-place consent gate when the flow needs to prove the blocker', async () => {
    // Given: a protected page whose consent gate normally gets cleared automatically.
    const flow: Flow = {
      name: 'prove the consent blocker',
      consentPolicy: 'preserve',
      steps: [
        // When: the flow navigates to the protected page.
        { action: 'goto', url: `${origin}/app/target` },
        // Then: the gate remains the observable subject of the test.
        { action: 'expectVisible', selector: 'role=heading[name="Consent to the Collection of Personal Data" i]' },
      ],
    };

    const bundle = await runFlow(flow, runOptions);

    assert.equal(bundle.status, 'passed', bundle.error ?? '');
    const nav = bundle.steps.find((step) => step.action === 'goto');
    assert.equal(nav?.detail?.['consentPreserved'], true);
    assert.equal(nav?.detail?.['consentAccepted'], undefined);
  });

  it('preserves a consent gate that appears after navigation settles', async () => {
    // Given: a protected route whose client guard redirects to consent after DOM content loads.
    const flow: Flow = {
      name: 'prove a late consent redirect',
      consentPolicy: 'preserve',
      steps: [
        { action: 'goto', url: `${origin}/app/late` },
        { action: 'expectUrl', value: '/consent' },
      ],
    };

    // When: the runner observes the late redirect window.
    const bundle = await runFlow(flow, runOptions);

    // Then: it leaves the consent page visible for the test oracle.
    const nav = bundle.steps.find((step) => step.action === 'goto');
    assert.equal(bundle.status, 'passed', bundle.error ?? '');
    assert.equal(nav?.url, `${origin}/consent`);
    assert.equal(nav?.detail?.['consentPreserved'], true);
    assert.equal(nav?.detail?.['consentAccepted'], undefined);
  });

  it('preserves the consent landing after a persona signs in', async () => {
    // Given: a flow that authenticates a persona to observe the consent landing itself.
    const flow: Flow = {
      name: 'sign in and observe consent',
      consentPolicy: 'preserve',
      setup: [{ action: 'signIn', as: 'EMPLOYEE_ACCOUNT', url: `${origin}/login` }],
      steps: [
        // When: sign-in redirects the authenticated browser to consent.
        // Then: the consent URL remains visible instead of being accepted automatically.
        { action: 'expectUrl', value: '/consent' },
      ],
    };

    const bundle = await runFlow(flow, {
      ...runOptions,
      personas: {
        EMPLOYEE_ACCOUNT: { email: 'employee@example.test', password: 'secret' },
      },
    });

    assert.equal(bundle.status, 'passed', bundle.error ?? '');
    const signIn = bundle.steps.find((step) => step.action === 'signIn');
    assert.equal(signIn?.detail?.['consentPreserved'], true);
    assert.equal(signIn?.detail?.['urlAfter'], `${origin}/consent`);
  });

  it('accepts consent after reading a document that gates the accept control', async () => {
    // Given: a consent page whose accept control stays disabled until its document reaches the end.
    const observed = await withPage(CDP_URL, async (page) => {
      page.setDefaultTimeout(1_000);
      await page.goto(`${origin}/consent/scroll`, { waitUntil: 'domcontentloaded' });

      // When: deterministic consent handling runs.
      const accepted = await acceptConsentGate(page);

      // Then: the control was enabled through document scrolling and the gate was accepted.
      return { accepted, url: page.url() };
    });

    assert.deepEqual(observed, { accepted: true, url: `${origin}/home` });
  });

  it("F1: a goto that asks for the consent page itself keeps its subject", async () => {
    const flow: Flow = {
      name: 'tests the gate',
      steps: [
        { action: 'goto', url: `${origin}/consent` },
        { action: 'expectVisible', selector: 'role=heading[name="Consent to the Collection of Personal Data" i]' },
      ],
    };
    const bundle = await runFlow(flow, runOptions);
    assert.equal(bundle.status, 'passed', bundle.error ?? '');
    const nav = bundle.steps.find((s) => s.action === 'goto');
    assert.equal(nav?.detail?.['consentAccepted'], undefined, 'no recovery on the gate itself');
  });

  it('F1: the recovery runs at most once per goto — a gate that re-renders fails honestly', async () => {
    const flow: Flow = {
      name: 'sticky gate',
      steps: [
        { action: 'goto', url: `${origin}/app/sticky` },
        { action: 'expectVisible', selector: 'role=heading[name="Never shown" i]' },
      ],
    };
    const bundle = await runFlow(flow, { ...runOptions, stepRepair: null });
    assert.notEqual(bundle.status, 'passed', 'the gate that will not stay cleared is a real failure');
    const nav = bundle.steps.find((s) => s.action === 'goto');
    assert.equal(nav?.detail?.['consentAccepted'], true, 'it was accepted once');
    assert.equal(nav?.status, 'passed', 'and the goto itself did not loop or die');
  });

  /** A model that answers from a script, recording what it was asked. */
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

  it("F2: an interstitial in front of the step's page is cleared and returned from, spending no turn", async () => {
    // The gate renders IN PLACE on /app/target and its accept bounces to
    // /home. The loop's own rung clears it before the first turn and comes
    // back; the model never sees the gate, and never spends a turn on it.
    // (Until 2026-08-25 the preflight's accept was URL-gated, so on an
    // in-place gate it silently did nothing and the MODEL had to click —
    // this test then asserted the return after the model's click.)
    const { model, seen } = scripted([
      { action: 'click', selector: 'role=button[name="Accept and continue" i]' },
      { action: 'finish', reasoning: 'the Create Plan button is on screen' },
    ]);
    const agent = new WorkflowAgent({ model, maxSteps: 4 });
    const result = await withPage(CDP_URL, async (page) => {
      await page.goto(`${origin}/app/target`, { waitUntil: 'domcontentloaded' });
      return agent.run(page, 'open the Create Plan popup');
    });
    assert.equal(result.success, true, result.summary);
    const gate = result.actions[0];
    assert.ok(gate?.ok && /consent gate/.test(gate.reasoning), 'the loop accepted the gate, before any turn');
    // The accept bounced to /home; the LOOP brought the observation back.
    assert.equal(seen[0]?.url, `${origin}/app/target`, 'the first turn observes the original page');
    assert.ok(seen.every((o) => !/Accept and continue/.test(o.axTree)), 'the model never saw the gate');
    assert.equal(result.turns, 1, 'neither the accept nor the return is a model turn');
  });

  it('F4: a workflow failure reported from a different page names the displacement', async () => {
    const { model } = scripted([
      { action: 'goto', url: `${origin}/other` },
      { action: 'fail', reasoning: 'the Create Plan button does not exist' },
    ]);
    const flow: Flow = {
      name: 'displaced failure',
      steps: [
        { action: 'goto', url: `${origin}/home` },
        { action: 'workflow', goal: 'click the Create Plan button' },
      ],
    };
    const bundle = await runFlow(flow, {
      ...runOptions,
      agent: new WorkflowAgent({ model, maxSteps: 4 }),
    });
    const step = bundle.steps.find((s) => s.action === 'workflow');
    // A failed workflow classifies as `error` (an agent leg is not an assertion).
    assert.equal(step?.status, 'error');
    assert.match(step?.error ?? '', /the agent ended on .*\/other, not the page this step began on/);
    const defect = bundle.defects.find((d) => /Workflow goal not reached/.test(d.title));
    assert.match(defect?.detail ?? '', /not the page this step began on/);
  });
});

// --- F3: the authoring repair is pure --------------------------------------

describe('settleConsentEarly (F3)', () => {
  const login: FlowStep[] = [
    { action: 'goto', url: 'http://x.test/en/login' },
    { action: 'fill', selector: 'role=textbox[name="Work email" i]', value: 'a@b.test' },
    { action: 'fill', selector: 'input[type="password"]', value: 'pw' },
    { action: 'click', selector: 'role=button[name="Sign in" i]' },
    { action: 'expectHidden', selector: 'role=button[name="Sign in" i]' },
  ];
  const accept: FlowStep = {
    action: 'click',
    selector: 'role=button[name="Accept and continue" i]',
    intent: 'Accept PDPA consent.',
  };

  it("PL_02_09's shape: an accept after the first post-login assertion moves to right after the login block", () => {
    const steps: FlowStep[] = [
      ...login,
      { action: 'goto', url: 'http://x.test/en/admin/benefits/plans' },
      { action: 'expectVisible', selector: 'text="Benefit Plans"' },
      accept,
      { action: 'click', selector: 'text="Benefit Plans"' },
    ];
    const out = settleConsentEarly(steps);
    assert.equal(out.moved, true);
    const moved = out.steps[login.length]!;
    // Converted to the conditional form: the gate shows once per context, and
    // a bare click would fail every run after the first.
    assert.equal(moved.action, 'when');
    assert.equal((moved as { visible?: string }).visible, accept.selector);
    // The flow's own goto now runs AFTER the accept — it IS the re-navigation.
    assert.equal(out.steps[login.length + 1]?.action, 'goto');
  });

  it('an accept already in its place is untouched', () => {
    const steps: FlowStep[] = [
      ...login,
      accept,
      { action: 'goto', url: 'http://x.test/en/admin/benefits/plans' },
      { action: 'expectVisible', selector: 'text="Benefit Plans"' },
    ];
    const out = settleConsentEarly(steps);
    assert.equal(out.moved, false);
    assert.deepEqual(out.steps, steps);
  });

  it('a flow with no login, or no consent accept, is untouched', () => {
    const noLogin: FlowStep[] = [
      { action: 'goto', url: 'http://x.test/page' },
      { action: 'expectVisible', selector: 'text="hello"' },
      accept,
    ];
    assert.equal(settleConsentEarly(noLogin).moved, false);
    assert.equal(settleConsentEarly(login).moved, false);
  });

  it('the authored `when { visible }` form moves as itself, not re-wrapped', () => {
    const conditional: FlowStep = {
      action: 'when',
      visible: 'role=button[name="Accept and continue" i]',
      then: [{ action: 'click', selector: 'role=button[name="Accept and continue" i]' }],
    };
    const steps: FlowStep[] = [
      ...login,
      { action: 'goto', url: 'http://x.test/en/admin/benefits/plans' },
      conditional,
    ];
    const out = settleConsentEarly(steps);
    assert.equal(out.moved, true);
    assert.deepEqual(out.steps[login.length], conditional);
  });
});
