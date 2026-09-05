# Bench: a labelled set of frozen proof bundles

The frozen-artifact half of the QA agent's own benchmark. Each entry pairs a
real proof bundle with a person's ruling on what the case really was, so that
`npm run bench` (`src/bench/run.ts`) can compute a number a change to
authoring, the agent or the verdict logic is judged by:

- **precision** — of the bundles the harness FILED as a defect (effective status
  `failed`, or ≥1 recorded defect), the share a person labelled `real-defect`;
- the **confusion** of `bundle.diagnosis.origin` against the labelled truth;
- **cost per case** from the fields the bundles record (agent turns and tokens,
  cached input tokens, the diagnosis and risk judges' tokens, the page's own
  calls, wall clock).

The seeded-fault half (run the suite against an application with a known,
planted bug and check it is found) needs a live app and is not here.

## `labels.json`

An array, validated by `BenchLabelsSchema` in `src/bench/labels.ts` before any
number is computed — the read-seam rule: a label carries authority, so a typo'd
truth rejects the file rather than shifting precision silently.

```json
{ "bundle": "<path relative to this file>", "truth": "<one of the six>", "note": "<why, optional>" }
```

`truth` is a closed vocabulary — every value is a fact about the case judged by
a person AFTER the run, never by the harness:

| truth | meaning |
|---|---|
| `pass` | the application met the claim and the run said so |
| `real-defect` | the application contradicted the claim; a bug report would be accepted |
| `spec-question` | the page renders the fact under other words or design — BA triage, not a bug |
| `not-deployed` | the feature the case exercises is not on this environment yet |
| `test-data` | the case needed seeded data that was not there |
| `harness` | wowlidator itself broke or gave up — an agent turn budget, a dropped base path, a model that could not be asked; nothing was learned about the application |

## `bundles/`

Copies of real bundles from `.wowlidator/proofs/`, all produced 2026-09-05
against the same staging deployment. Every field the bench or the bundle
schema reads is verbatim; the only things removed are the media — the run's
film (`video`, `videos`) and each step's `screenshot` — which are megabytes of
base64 per bundle, are read by nothing here, and carry no verdict. Nothing else
was redacted: bundles carry no passwords by design (variables are masked by
name before they are written), and the account names and staging URLs they do
carry are the environment's, not a person's.

The seeded mix, chosen so that precision has something to be wrong about:

| bundle | status | labelled | why |
|---|---|---|---|
| `cns-ec-029-passed-64bfef1a` | passed | pass | API read-back after sign-in; nothing filed |
| `cns-ec-012-passed-766dc861` | passed | pass | register walk; risk judge cost but no agent turns |
| `hir-ec-001-error-e1af79a3` | error | harness | agent gave up after its 2-turn budget; `diagnosis.origin = agent` |
| `cns-ec-031-error-15e28bd7` | error | harness | same budget, another case |
| `cns-ec-016-failed-6fc8db47` | failed | harness | 404: authored request dropped the deployment base path (fixed in `6414e6e`) |
| `cns-ec-029-failed-3299844e` | failed | harness | same base-path bug; two defects filed; reports `cachedInputTokens` |
| `prb-ec-062-needs-review-cc891b74` | needs-review | spec-question | wording near-miss, `specQuestion: true`, a model later ruled proved |

With this seed the harness files 5 defects and a person accepts 0 of them, so
the baseline precision is 0% — the honest starting number. A fix to the agent
budget or the base path shows up as those bundles' successors no longer being
filed, and a `real-defect` entry (none exist yet on this deployment) is what
recall will be measured on.

## Adding an entry

1. Copy the bundle from `.wowlidator/proofs/<runId>.json` into `bundles/`,
   dropping `video`, `videos` and each step's `screenshot`. Name it
   `<case>-<status>-<runId prefix>.json`.
2. Append `{ bundle, truth, note }` to `labels.json`. Say in `note` what you
   looked at to rule — the verifier of a future precision change will read it.
3. `WOWLIDATOR_CDP_URL=http://127.0.0.1:1 npx tsx --test tests/bench.test.ts`
   — the test iterates the labels and asserts each bundle still parses through
   the proof-bundle seam.
4. `WOWLIDATOR_BENCH=1 npm run bench` writes `reports/bench/bench-score.json`;
   keep the previous one and pass it as `--baseline` to see the delta.
