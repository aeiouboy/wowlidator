/**
 * The session bootstrap — a flow that assumes a signed-in user, run against a
 * browser that has no session.
 *
 * Browser-tier, CDP-gated like its siblings: "the harness signed in and the
 * flow then ran on the page it asked for" is a fact about a real page, and
 * the live failure this guards (BE_Test2.csv, 2026-08-19 16:53 — ten cases,
 * every one dead on the login screen) was invisible to every pure assertion.
 * The fixture is a miniature of that application: a TWO-STEP login (email +
 * Next, then password), a session cookie, and a protected page that bounces
 * to /login without it.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { runFlow, type Flow } from '../src/engine/runner.js';

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

const PAGE = (body: string): string =>
  `<!doctype html><html><head><title>fixture</title></head><body>${body}</body></html>`;

describe('the session bootstrap (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;

  before(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const cookie = req.headers.cookie ?? '';
      const signedIn = cookie.includes('session=ok');

      if (url.pathname === '/login/delayed') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          PAGE(
            '<div id="form"></div><script>setTimeout(() => {' +
              'document.getElementById("form").innerHTML = ' +
              "'<form method=\"post\" action=\"/login\"><input type=\"email\" name=\"email\">" +
              '<input type="password" name="password"><button type="submit">Sign in</button></form>\'' +
              '}, 1200)</script>',
          ),
        );
        return;
      }

      if (url.pathname === '/login') {
        if (req.method === 'POST') {
          let raw = '';
          req.on('data', (chunk) => (raw += chunk));
          req.on('end', () => {
            const params = new URLSearchParams(raw);
            if (params.get('password') === 'pw2026') {
              res.writeHead(302, { 'set-cookie': 'session=ok; Path=/', location: '/app' });
            } else {
              res.writeHead(302, { location: '/login' });
            }
            res.end();
          });
          return;
        }
        // Two screens, like the live application: identity + Next first,
        // password only after.
        if (url.searchParams.get('step') === '2') {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(
            PAGE(
              '<form method="post" action="/login">' +
                '<input type="password" name="password">' +
                '<button type="submit">Sign in</button></form>',
            ),
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          PAGE(
            '<form method="get" action="/login"><input type="hidden" name="step" value="2">' +
              '<input type="email" name="email">' +
              '<button type="submit">Next</button></form>',
          ),
        );
        return;
      }

      if (url.pathname === '/app') {
        if (!signedIn) {
          res.writeHead(302, { location: '/login' });
          res.end();
          return;
        }
        // The identity menu, like the live application: sign-out lives
        // BEHIND an ARIA-marked disclosure, invisible until it opens.
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          PAGE(
            '<h1>Benefit Plans</h1>' +
              '<button aria-haspopup="menu" aria-expanded="false" ' +
              'onclick="document.getElementById(\'m\').style.display=\'block\'">Account</button>' +
              '<div id="m" role="menu" style="display:none">' +
              '<a role="menuitem" href="/logout">Sign out</a></div>',
          ),
        );
        return;
      }

      if (url.pathname === '/logout') {
        res.writeHead(302, { 'set-cookie': 'session=; Path=/; Max-Age=0', location: '/login' });
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
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

  it('waits for a client-rendered sign-in form before deciding it is absent', async () => {
    // Given: the sign-in route paints its credential fields after client hydration.
    const flow: Flow = {
      name: 'delayed sign-in form',
      steps: [{ action: 'signIn', as: 'HR_ADMIN_ACCOUNT', url: `${origin}/login/delayed` }],
    };

    // When: the runner signs in immediately after navigation.
    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      video: 'off',
      isolate: true,
      screenshots: 'off',
      healer: null,
      personas: { HR_ADMIN_ACCOUNT: { email: 'admin@b.test', password: 'pw2026' } },
    });

    // Then: it waits for hydration and submits the real form.
    assert.equal(bundle.status, 'passed', bundle.error ?? '');
    assert.equal(bundle.steps[0]?.status, 'passed');
  });

  /** BE_Test2's shape: assume the session, never sign in. */
  const assumesSession = (): Flow =>
    ({
      name: 'assumes a session',
      steps: [
        { action: 'goto', url: `${origin}/app` },
        { action: 'expectVisible', selector: 'role=heading[name="Benefit Plans" i]' },
      ],
    }) as Flow;

  it('establishes the session with --as and the flow then runs where it asked to', async () => {
    const bundle = await runFlow(assumesSession(), {
      cdpUrl: CDP_URL,
      video: 'off',
      isolate: true,
      screenshots: 'off',
      healer: null,
      credentials: { email: 'a@b.test', password: 'pw2026' },
    });

    assert.equal(bundle.status, 'passed', bundle.error ?? '');
    const nav = bundle.steps.find((s) => s.action === 'goto');
    assert.equal(nav?.detail?.['sessionEstablished'], 'a@b.test', 'the step says who signed in');
    assert.ok(
      bundle.notes?.some((n) => /session bootstrap/.test(n)),
      'the run notes the decision',
    );
    // Green, and still a finding: the flow depends on a precondition it does
    // not establish.
    assert.ok(
      bundle.defects.some((d) => /assumes a signed-in user/.test(d.title)),
      'a low finding asks for the sign-in to be authored',
    );
  });

  it('without credentials the honest fatal stands, and it names --as', async () => {
    const bundle = await runFlow(assumesSession(), {
      cdpUrl: CDP_URL,
      video: 'off',
      isolate: true,
      screenshots: 'off',
      healer: null,
    });

    assert.notEqual(bundle.status, 'passed');
    assert.match(bundle.error ?? '', /--as <email>:<password>/);
  });

  it('never races a flow that signs in itself', async () => {
    // The flow's own sign-in must be the one that runs — the bootstrap staying
    // out is what keeps a persona test testing its persona.
    const flow: Flow = {
      name: 'signs in itself',
      steps: [
        { action: 'goto', url: `${origin}/login` },
        { action: 'fill', selector: 'input[type="email"]', value: 'me@b.test' },
        { action: 'click', selector: 'role=button[name="Next" i]' },
        { action: 'fill', selector: 'input[type="password"]', value: 'pw2026' },
        { action: 'click', selector: 'role=button[name="Sign in" i]' },
        { action: 'expectVisible', selector: 'role=heading[name="Benefit Plans" i]' },
      ],
    } as Flow;
    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      video: 'off',
      isolate: true,
      screenshots: 'off',
      healer: null,
      credentials: { email: 'other@b.test', password: 'pw2026' },
    });

    assert.equal(bundle.status, 'passed', bundle.error ?? '');
    const nav = bundle.steps.find((s) => s.action === 'goto');
    assert.equal(nav?.detail?.['sessionEstablished'], undefined, 'the bootstrap stayed out');
  });

  it("signOut travels the application's own sign-out control, and the switch re-logs-in", async () => {
    // The persona switch as authored: sign in as A, work, signOut (the
    // engine opens the ARIA-marked identity menu and clicks the app's own
    // Sign out), then the sign-in page again as B. The goto after signOut
    // is also the session guard's new exemption at work: the run is on the
    // sign-in page because a signOut deliberately put it there.
    const signInAs = (email: string): Flow['steps'] => [
      { action: 'goto', url: `${origin}/login` },
      { action: 'fill', selector: 'input[type="email"]', value: email },
      { action: 'click', selector: 'role=button[name="Next" i]' },
      { action: 'fill', selector: 'input[type="password"]', value: 'pw2026' },
      { action: 'click', selector: 'role=button[name="Sign in" i]' },
      { action: 'expectVisible', selector: 'role=heading[name="Benefit Plans" i]' },
    ];
    const flow: Flow = {
      name: 'switches persona through the real sign-out',
      steps: [
        ...signInAs('a@b.test'),
        { action: 'goto', url: `${origin}/app` },
        { action: 'signOut' },
        ...signInAs('b@b.test'),
      ],
    } as Flow;
    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      video: 'off',
      isolate: true,
      screenshots: 'off',
      healer: null,
    });

    assert.equal(bundle.status, 'passed', bundle.error ?? '');
    const signOut = bundle.steps.find((s) => s.action === 'signOut');
    assert.ok(signOut, 'the signOut step ran');
    assert.match(
      String(signOut?.detail?.['via'] ?? ''),
      /menuitem "Sign out" behind/,
      'the app\'s own control was clicked, behind the identity menu',
    );
    assert.match(String(signOut?.detail?.['urlAfter'] ?? ''), /\/login/);
  });
});

// --- The persona `signIn` step (EH-10, 2026-09-03) -------------------------

describe('the signIn step: personas, sign-out first, the vault keyed by account (CDP)', { skip: skipBrowser }, () => {
  let server: Server;
  let origin: string;

  before(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const cookie = req.headers.cookie ?? '';
      const who = /(?:^|;\s*)session=([^;]+)/.exec(cookie)?.[1] ?? null;

      if (url.pathname === '/login') {
        if (req.method === 'POST') {
          let raw = '';
          req.on('data', (chunk) => (raw += chunk));
          req.on('end', () => {
            const params = new URLSearchParams(raw);
            const email = params.get('email') ?? '';
            if (params.get('password') === 'pw2026' && email !== '') {
              res.writeHead(302, { 'set-cookie': `session=${encodeURIComponent(email)}; Path=/`, location: '/app' });
            } else {
              res.writeHead(302, { location: '/login' });
            }
            res.end();
          });
          return;
        }
        if (url.searchParams.get('step') === '2') {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(
            PAGE(
              '<form method="post" action="/login">' +
                `<input type="hidden" name="email" value="${url.searchParams.get('email') ?? ''}">` +
                '<input type="password" name="password">' +
                '<button type="submit">Sign in</button></form>',
            ),
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          PAGE(
            '<form method="get" action="/login"><input type="hidden" name="step" value="2">' +
              '<input type="email" name="email">' +
              '<button type="submit">Next</button></form>',
          ),
        );
        return;
      }

      if (url.pathname === '/app') {
        if (who === null) {
          res.writeHead(302, { location: '/login' });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          PAGE(
            `<h1>Benefit Plans</h1><p id="who">Signed in as ${decodeURIComponent(who)}</p>` +
              '<button aria-haspopup="menu" aria-expanded="false" ' +
              'onclick="document.getElementById(\'m\').style.display=\'block\'">Account</button>' +
              '<div id="m" role="menu" style="display:none">' +
              '<a role="menuitem" href="/logout">Sign out</a></div>',
          ),
        );
        return;
      }

      if (url.pathname === '/logout') {
        res.writeHead(302, { 'set-cookie': 'session=; Path=/; Max-Age=0', location: '/login' });
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
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

  const personas = {
    HR_ADMIN_ACCOUNT: { email: 'admin@b.test', password: 'pw2026' },
    MANAGER_ACCOUNT: { email: 'manager@b.test', password: 'pw2026' },
  };

  it('signs in as one persona, hands off to another through the app\'s own sign-out, and banks the account it ended as', async () => {
    const { SessionVault } = await import('../src/engine/session-vault.js');
    const vault = new SessionVault();
    const flow: Flow = {
      name: 'employee submits, manager approves',
      steps: [
        { action: 'signIn', as: '<HR_ADMIN_ACCOUNT>', url: `${origin}/login` },
        { action: 'goto', url: `${origin}/app` },
        { action: 'expectText', selector: '#who', value: 'Signed in as admin@b.test' },
        { action: 'signIn', as: 'manager', intent: 'the manager approves the request' },
        { action: 'expectText', selector: '#who', value: 'Signed in as manager@b.test' },
      ],
    };
    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      video: 'off',
      isolate: true,
      screenshots: 'off',
      healer: null,
      personas,
      sessionVault: vault,
    });

    assert.equal(bundle.status, 'passed', bundle.error ?? '');
    const [first, , , second] = bundle.steps;
    assert.equal(first?.detail?.['signedInAs'], 'admin@b.test');
    assert.equal(first?.detail?.['persona'], 'HR_ADMIN_ACCOUNT');
    assert.equal(second?.detail?.['signedInAs'], 'manager@b.test');
    assert.match(String(second?.detail?.['signedOutVia'] ?? ''), /menuitem "Sign out" behind/, 'the live session ended through the app');
    assert.match(String(second?.detail?.['signInUrl'] ?? ''), /\/login/, 'the sign-in page the flow named is reused');
    assert.ok(!JSON.stringify(bundle).includes('pw2026'), 'no persona password reaches the record');
    // The vault holds the account the run ENDED as, and only that one.
    assert.ok(vault.get(origin, 'manager@b.test'), 'banked under the manager');
    assert.equal(vault.get(origin, 'admin@b.test'), null, 'the admin session was signed out of, never banked');
  });

  it('with a browser per persona, a hand-off keeps both sessions and a return is a switch, not a login', async () => {
    // One Chrome per persona (2026-09-03). The test points the second
    // persona's "browser" at the same Chrome — a context of its own there is
    // the same isolation a second process gives, and what the assertions are
    // about: the admin's jar survives the manager's leg, the manager's leg
    // signs nobody out, and the admin's return needs no form.
    const { SessionVault } = await import('../src/engine/session-vault.js');
    const vault = new SessionVault();
    const flow: Flow = {
      name: 'employee submits, manager approves, employee checks',
      steps: [
        { action: 'signIn', as: '<HR_ADMIN_ACCOUNT>', url: `${origin}/login` },
        { action: 'goto', url: `${origin}/app` },
        { action: 'expectText', selector: '#who', value: 'Signed in as admin@b.test' },
        { action: 'signIn', as: 'manager' },
        { action: 'goto', url: `${origin}/app` },
        { action: 'expectText', selector: '#who', value: 'Signed in as manager@b.test' },
        { action: 'signIn', as: 'HR_ADMIN_ACCOUNT' },
        { action: 'expectText', selector: '#who', value: 'Signed in as admin@b.test' },
      ],
    };
    const bundle = await runFlow(flow, {
      cdpUrl: CDP_URL,
      video: 'off',
      isolate: true,
      screenshots: 'off',
      healer: null,
      personas,
      personaBrowsers: [CDP_URL],
      sessionVault: vault,
    });

    assert.equal(bundle.status, 'passed', bundle.error ?? '');
    const [first, , , second, , , back, last] = bundle.steps;
    assert.equal(first?.detail?.['persona'], 'HR_ADMIN_ACCOUNT');
    assert.equal(first?.persona, 'HR_ADMIN_ACCOUNT', 'the first signIn binds the primary session');
    assert.equal(second?.detail?.['openedBrowser'], CDP_URL, 'the manager got a browser of their own');
    assert.equal(second?.detail?.['signedOutVia'], undefined, 'nobody was signed out');
    assert.equal(second?.persona, 'MANAGER_ACCOUNT');
    assert.equal(back?.detail?.['keptSession'], true, 'the admin returns to a live session');
    assert.equal(back?.detail?.['signInUrl'], undefined, 'no login form on the way back');
    assert.equal(last?.persona, 'HR_ADMIN_ACCOUNT');
    assert.ok(!JSON.stringify(bundle).includes('pw2026'), 'no persona password reaches the record');
    // Both accounts banked, each under its own email.
    assert.ok(vault.get(origin, 'manager@b.test'), 'banked under the manager');
    assert.ok(vault.get(origin, 'admin@b.test'), 'banked under the admin — the session was never ended');
  });

  it('a persona browser that answers nothing blocks the case as a harness error, not an app defect', async () => {
    const bundle = await runFlow(
      {
        name: 'dead persona browser',
        steps: [
          { action: 'signIn', as: 'HR_ADMIN_ACCOUNT', url: `${origin}/login` },
          { action: 'signIn', as: 'MANAGER_ACCOUNT' },
        ],
      },
      {
        cdpUrl: CDP_URL,
        video: 'off',
        isolate: true,
        screenshots: 'off',
        healer: null,
        personas,
        personaBrowsers: ['http://127.0.0.1:9'],
      },
    );
    assert.equal(bundle.status, 'error');
    assert.match(bundle.steps[1]?.error ?? '', /could not attach to the browser at http:\/\/127\.0\.0\.1:9/);
    assert.equal(bundle.defects.length, 0, 'the machine, not the application');
  });

  // --- HIR-EC-009 (2026-09-04): a `signIn` is allowed to stand on the
  // sign-in page ------------------------------------------------------------

  it('a goto bounced to login followed by a signIn signs in rather than dying session-lost', async () => {
    // ec09's exact setup shape: `goto <app page>` then `signIn`. The flow
    // signs in itself, so it starts with an empty jar and the goto bounces
    // to /login — and the guard that runs before every step used to kill the
    // run on the ONE step for which standing on a sign-in page is right.
    const bundle = await runFlow(
      {
        name: 'goto first, sign in second',
        setup: [
          { action: 'goto', url: `${origin}/app` },
          { action: 'signIn', as: '<HR_ADMIN_ACCOUNT>', url: `${origin}/login` },
        ],
        steps: [
          { action: 'goto', url: `${origin}/app` },
          { action: 'expectText', selector: '#who', value: 'Signed in as admin@b.test' },
        ],
      },
      { cdpUrl: CDP_URL, video: 'off', isolate: true, screenshots: 'off', healer: null, personas },
    );

    assert.equal(bundle.status, 'passed', bundle.error ?? '');
    const signIn = bundle.steps.find((s) => s.action === 'signIn');
    assert.equal(signIn?.status, 'passed', 'the signIn ran instead of being pre-empted');
    assert.equal(signIn?.detail?.['signedInAs'], 'admin@b.test');
    assert.match(String(signIn?.detail?.['urlBefore'] ?? ''), /\/login/, 'it began ON the sign-in page');
    assert.equal(
      bundle.defects.filter((d) => /lost its session|never took effect/.test(d.title)).length,
      0,
      'no session defect is filed about a flow that was about to sign in',
    );
  });

  it('the exemption is the signIn step only: an ordinary step after the same bounce still stops', async () => {
    // The negative half. Identical setup minus the signIn: the guard must
    // fire exactly as it does today, and the run must not proceed to assert
    // against login furniture.
    const bundle = await runFlow(
      {
        name: 'goto first, no sign-in',
        setup: [{ action: 'goto', url: `${origin}/app` }],
        steps: [{ action: 'expectVisible', selector: 'role=heading[name="Benefit Plans" i]' }],
      },
      { cdpUrl: CDP_URL, video: 'off', isolate: true, screenshots: 'off', healer: null, personas },
    );

    assert.notEqual(bundle.status, 'passed');
    assert.match(bundle.error ?? '', /the run is on the sign-in page/);
    assert.equal(
      bundle.steps.find((s) => s.action === 'expectVisible'),
      undefined,
      'the assertion never ran against the login screen',
    );
    assert.ok(
      bundle.defects.some((d) => /lost its session/.test(d.title)),
      'the session-lost finding is filed exactly as before',
    );
  });

  it('an unknown persona is a harness error naming the labels available', async () => {
    const bundle = await runFlow(
      { name: 'unknown persona', steps: [{ action: 'signIn', as: 'HRBP_ACCOUNT', url: `${origin}/login` }] },
      { cdpUrl: CDP_URL, video: 'off', isolate: true, screenshots: 'off', healer: null, personas },
    );
    assert.equal(bundle.status, 'error');
    assert.match(bundle.steps[0]?.error ?? '', /no persona by that label/);
    assert.match(bundle.steps[0]?.error ?? '', /"HR_ADMIN_ACCOUNT", "MANAGER_ACCOUNT"/);
  });
});
