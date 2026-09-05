/**
 * A stopped suite never re-authors a row it already authored (2026-09-05).
 *
 * The ledger remembers each authored flow's path the moment its case is
 * queued; a resume splits the rows still to run into the flows it REUSES —
 * read back through the zod seam — and the rows it must AUTHOR. Pure
 * selection first, then the reader against hand-written files: a flow that
 * is missing or malformed falls back to authoring with the file named in
 * the log, never a crash. Unit tier: temp files only, no browser, no model.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AUTHORING_REFUSAL_CAP,
  LEDGER_VERSION,
  newLedger,
  readLedger,
  recordAuthored,
  recordOutcome,
  resumeAuthored,
  reusableAuthored,
  type SuiteLedger,
} from '../src/cli/suite-progress.js';

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wow-resume-authored-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const rows = (...ids: string[]): { caseId: string }[] => ids.map((caseId) => ({ caseId }));

/** A ledger as a stopped pass leaves it, hand-built rather than replayed from a run. */
function stoppedLedger(): SuiteLedger {
  const ledger = newLedger('t', ['R_1', 'R_2', 'R_3', 'R_4', 'R_5', 'R_6']);
  // R_1: authored, queued, never ran — the case this exists for.
  recordAuthored(ledger, 'R_1 first', { flowPath: join(dir, 'r1.flow.json'), scenarioId: 'R', authoredAt: '2026-09-05T08:05:00.000Z' });
  // R_2: authored and PASSED — a verdict; not remaining.
  recordAuthored(ledger, 'R_2 second', { flowPath: join(dir, 'r2.flow.json') });
  recordOutcome(ledger, { name: 'R_2 second', verdict: 'passed', bundle: null });
  // R_3: authoring refused it once — a resume authors it leniently, never replays.
  recordOutcome(
    ledger,
    { name: 'R_3', verdict: 'blocked', bundle: null, reason: 'authoring refused (attempt 1): ungrounded' },
    { authoringRefused: 1 },
  );
  // R_4: authored, ran, judged vacuous — re-authored, never replayed.
  recordAuthored(ledger, 'R_4 fourth', { flowPath: join(dir, 'r4.flow.json') });
  recordOutcome(
    ledger,
    { name: 'R_4 fourth', verdict: 'blocked', bundle: null, reason: 'vacuous flow' },
    { flowPath: join(dir, 'r4.flow.json'), vacuous: true },
  );
  // R_5: never authored at all (the stop came first).
  // R_6: authored, ran, blocked by its dependency — the flow itself is fine.
  recordAuthored(ledger, 'R_6 sixth', { flowPath: join(dir, 'r6.flow.json') });
  recordOutcome(
    ledger,
    { name: 'R_6 sixth', verdict: 'blocked', bundle: null, reason: 'depends on R_2, which failed' },
    { flowPath: join(dir, 'r6.flow.json') },
  );
  return ledger;
}

describe('reusableAuthored — the pure split', () => {
  it('reuses a remaining row with an authored entry; refers refusals, vacuous flows and unauthored rows to authoring; settles verdicts', () => {
    const ledger = stoppedLedger();
    const split = reusableAuthored(ledger, rows('R_1', 'R_2', 'R_3', 'R_4', 'R_5', 'R_6'));
    assert.deepEqual(split.reuse.map((r) => r.row.caseId), ['R_1', 'R_6']);
    assert.equal(split.reuse[0]?.entry.flowPath, join(dir, 'r1.flow.json'));
    assert.equal(split.reuse[0]?.entry.authoredAt, '2026-09-05T08:05:00.000Z');
    assert.deepEqual(split.author.map((r) => r.caseId), ['R_3', 'R_4', 'R_5']);
    assert.deepEqual(split.settled.map((r) => r.caseId), ['R_2']);
  });

  it('a row refused up to the cap is settled, not authored again; a ledger without the map authors everything', () => {
    const ledger = newLedger('t', ['A', 'B']);
    recordOutcome(
      ledger,
      { name: 'A', verdict: 'blocked', bundle: null, reason: 'authoring refused (attempt 2): x' },
      { authoringRefused: AUTHORING_REFUSAL_CAP },
    );
    const split = reusableAuthored(ledger, rows('A', 'B'));
    assert.deepEqual(split.settled.map((r) => r.caseId), ['A']);
    assert.deepEqual(split.author.map((r) => r.caseId), ['B']);
    assert.deepEqual(split.reuse, []);
  });

  it("keeps the rows' own order and ignores authored entries for rows not offered", () => {
    const ledger = stoppedLedger();
    const split = reusableAuthored(ledger, rows('R_6', 'R_5', 'R_1'));
    assert.deepEqual(split.reuse.map((r) => r.row.caseId), ['R_6', 'R_1']);
    assert.deepEqual(split.author.map((r) => r.caseId), ['R_5']);
  });
});

describe('resumeAuthored — the split with the files read through the seam', () => {
  it('reads a reusable flow, logs one line per reuse and a summary, and lists the rest for authoring', async () => {
    const ledger = stoppedLedger();
    await writeFile(
      join(dir, 'r1.flow.json'),
      JSON.stringify({ name: 'R_1 first', steps: [{ action: 'goto', url: '/x' }], authoredBy: { model: 'm' } }),
      'utf8',
    );
    await writeFile(
      join(dir, 'r6.flow.json'),
      JSON.stringify({ name: 'R_6 sixth', steps: [{ action: 'goto', url: '/y' }, { action: 'expectVisible', selector: 'role=heading' }] }),
      'utf8',
    );
    const lines: string[] = [];
    const split = await resumeAuthored(ledger, rows('R_1', 'R_3', 'R_5', 'R_6'), { log: (line) => lines.push(line) });
    assert.deepEqual(split.reuse.map((r) => r.row.caseId), ['R_1', 'R_6']);
    assert.equal(split.reuse[0]?.flow.steps[0]?.action, 'goto');
    assert.equal(split.reuse[1]?.flow.steps.length, 2);
    assert.deepEqual(split.author.map((r) => r.caseId), ['R_3', 'R_5']);
    assert.ok(
      lines.some((l) => l === `resume: R_1 — flow reused from ${join(dir, 'r1.flow.json')}, authored 2026-09-05T08:05:00.000Z`),
      lines.join('\n'),
    );
    assert.ok(lines.some((l) => l.startsWith(`resume: R_6 — flow reused from ${join(dir, 'r6.flow.json')}`)));
    assert.equal(lines.at(-1), 'resume: 2 flows reused, 2 rows to author');
  });

  it('a missing flow file falls back to authoring, naming the file — never a crash', async () => {
    const ledger = newLedger('t', ['M_1', 'M_2']);
    const gone = join(dir, 'never-written.flow.json');
    recordAuthored(ledger, 'M_1 gone', { flowPath: gone });
    const lines: string[] = [];
    const split = await resumeAuthored(ledger, rows('M_1', 'M_2'), { log: (line) => lines.push(line) });
    assert.deepEqual(split.reuse, []);
    assert.deepEqual(split.author.map((r) => r.caseId), ['M_1', 'M_2']);
    const fell = lines.find((l) => l.startsWith('resume: M_1'));
    assert.ok(fell !== undefined, lines.join('\n'));
    assert.ok(fell.includes(gone), 'the log line names the file');
    assert.match(fell, /cannot be reused \(file is missing\); authoring it again/);
    assert.equal(lines.at(-1), 'resume: 0 flows reused, 2 rows to author');
  });

  it("a flow file that fails the schema falls back the same way, with the schema's first issue", async () => {
    const ledger = newLedger('t', ['S_1', 'S_2']);
    const bad = join(dir, 's1.flow.json');
    const fine = join(dir, 's2.flow.json');
    await writeFile(bad, JSON.stringify({ name: 'S_1', steps: 'nope' }), 'utf8');
    await writeFile(fine, JSON.stringify({ name: 'S_2', steps: [{ action: 'goto', url: '/z' }] }), 'utf8');
    recordAuthored(ledger, 'S_1', { flowPath: bad });
    recordAuthored(ledger, 'S_2', { flowPath: fine });
    const lines: string[] = [];
    const split = await resumeAuthored(ledger, rows('S_1', 'S_2'), { log: (line) => lines.push(line) });
    assert.deepEqual(split.reuse.map((r) => r.row.caseId), ['S_2']);
    assert.deepEqual(split.author.map((r) => r.caseId), ['S_1']);
    const fell = lines.find((l) => l.startsWith('resume: S_1'));
    assert.ok(fell?.includes(bad));
    assert.match(fell ?? '', /not a flow file \(steps: /);
  });

  it('the split holds against a hand-written ledger, not only one this writer produced', async () => {
    const flowPath = join(dir, 'h1.flow.json');
    await writeFile(flowPath, JSON.stringify({ name: 'H_1', steps: [{ action: 'goto', url: '/h' }] }), 'utf8');
    const ledgerPath = join(dir, 'hand.progress.json');
    await writeFile(
      ledgerPath,
      JSON.stringify({
        version: LEDGER_VERSION,
        title: 'hand',
        planned: ['H_1', 'H_2'],
        startedAt: 'x',
        updatedAt: 'x',
        generatedAt: 'x',
        runKey: 'hand@x',
        outcomes: { H_2: { verdict: 'blocked', status: null, reason: 'quota hold', reportPath: null, at: 'x' } },
        authored: { H_1: { flowPath, authoredAt: '2026-09-05T08:00:00.000Z' } },
        ended: { at: 'x', cause: 'stopped by SIGTERM with 2 case(s) still to run', complete: false },
      }),
      'utf8',
    );
    const ledger = await readLedger(ledgerPath);
    assert.ok(ledger);
    const split = await resumeAuthored(ledger, rows('H_1', 'H_2'));
    assert.deepEqual(split.reuse.map((r) => r.row.caseId), ['H_1']);
    assert.deepEqual(split.author.map((r) => r.caseId), ['H_2']);
  });
});
