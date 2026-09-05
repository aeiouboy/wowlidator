/**
 * The machinery gates — every on/off that shapes how a suite runs, editable
 * from the panel's Machinery card (asked for 2026-08-28).
 *
 * One mechanism, the `persistUsageCap` pattern: a change writes the env line
 * to `.env` (a setting that evaporates on restart is not a setting) AND sets
 * `process.env`, so the very next job the panel spawns inherits it — jobs get
 * `{ ...process.env, ...overlays }`. A run already in flight keeps the gates
 * it started with; the card says so.
 *
 * The allowlist IS the security boundary: the endpoint edits these vars and
 * no others, so the panel cannot be talked into writing arbitrary env.
 */

import { ClaudeSettingsError, upsertEnv } from './claude-settings.js';

export interface GateSpec {
  /** The env var, verbatim — also the wire id. */
  env: string;
  label: string;
  help: string;
  /** What an ABSENT var means — every gate here defaults on except none. */
  defaultOn: boolean;
  /** The value that turns it on when a person flips it back. `''` = remove the line. */
  onValue: string;
}

/** Every gate the Machinery card offers, in the order shown. */
export const GATES: readonly GateSpec[] = [
  {
    env: 'WOWLIDATOR_SCENARIO_GATE',
    label: 'Scenario gate',
    help:
      'Authoring holds to the scenario the runner is in — rows of scenario N+1 wait until N has finished running. ' +
      'Off, every row authors as fast as the pool allows, which feeds more cases to the parallel lanes sooner.',
    defaultOn: true,
    onValue: 'on',
  },
  {
    env: 'WOWLIDATOR_SECTIONS',
    label: 'Data sections',
    help:
      'Writers share the parallel pool when their data sections are disjoint. Off restores the binary rule: ' +
      'any case that writes anything runs with nothing else in flight.',
    defaultOn: true,
    onValue: 'on',
  },
  {
    env: 'WOWLIDATOR_GOVERNOR',
    label: 'Queue governor',
    help:
      'Watches the parallel lanes: diagnoses blockages, shrinks the pool under timeout load. On = the deterministic rules governor ($0, no model). ' +
      'Setting the env var to "model" by hand restores the LLM governor, which can additionally seed a starved fixture. Off, the scheduler runs alone.',
    defaultOn: true,
    onValue: 'rules',
  },
  {
    env: 'WOWLIDATOR_RISK',
    label: 'Pre-run risk judge',
    help: 'Judges each authored case for dead-end/expected-fail risk; above the threshold it runs once with no rerun paths.',
    defaultOn: true,
    onValue: 'on',
  },
  {
    env: 'WOWLIDATOR_DIAGNOSE',
    label: 'System-error diagnosis',
    help: 'A run that ends as a system error gets one healer-role call naming which layer broke, with the fix when one exists.',
    defaultOn: true,
    onValue: 'on',
  },
  {
    env: 'WOWLIDATOR_AUTO_PROVE',
    label: 'Auto-review judge',
    help: 'Rules on proved-? wording mismatches at the confidence bar; off leaves every one for a human.',
    defaultOn: true,
    onValue: 'on',
  },
];

/** A numeric machinery setting — same persistence contract as a gate. */
export interface DialSpec {
  env: string;
  label: string;
  help: string;
  min: number;
  max: number;
  defaultValue: number;
}

export const DIALS: readonly DialSpec[] = [
  {
    env: 'WOWLIDATOR_AUTHOR_CONCURRENCY',
    label: 'Rows authored at a time',
    help:
      'How many catalog rows are written side by side — each is one generator call in flight. ' +
      'More keeps the parallel lanes fed; all calls share the one Claude session window. ' +
      'An explicit --author-concurrency on a run still wins, and a one-call-at-a-time provider stays at 1.',
    min: 1,
    max: 12,
    defaultValue: 3,
  },
  {
    env: 'WOWLIDATOR_AUTHOR_ATTEMPTS',
    label: 'Authoring attempts per row',
    help:
      'Total asks per row including the first — a refused flow is re-asked with the refusal as feedback. ' +
      '1 = one ask, no re-ask budget: cheapest and fastest, at the price of handing over weaker flows. ' +
      'Also selectable per run on the catalog form.',
    min: 1,
    max: 5,
    defaultValue: 3,
  },
];

export interface DialView extends DialSpec {
  value: number;
  raw: string;
}

export function describeDials(env: NodeJS.ProcessEnv = process.env): DialView[] {
  return DIALS.map((spec) => {
    const raw = env[spec.env] ?? '';
    const n = Number(raw.trim());
    const value = Number.isInteger(n) && n >= spec.min && n <= spec.max ? n : spec.defaultValue;
    return { ...spec, value, raw };
  });
}

export async function persistDial(
  envVar: string,
  value: unknown,
  envPath = '.env',
  env: NodeJS.ProcessEnv = process.env,
): Promise<DialView> {
  const spec = DIALS.find((d) => d.env === envVar);
  if (spec === undefined) throw new ClaudeSettingsError(`"${envVar}" is not a machinery dial this panel edits`);
  const n = Number(String(value ?? '').trim());
  if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
    throw new ClaudeSettingsError(`"${spec.label}" must be a whole number from ${spec.min} to ${spec.max}`);
  }
  await upsertEnv([[spec.env, String(n)]], envPath);
  env[spec.env] = String(n);
  return { ...spec, value: n, raw: String(n) };
}

/**
 * A pick-one-of-N machinery setting — same persistence contract as a gate or
 * a dial, for a value that is an enum rather than a switch or a number.
 *
 * The reason it exists: reasoning effort. A role pointed at a Claude provider
 * (claude-cli / claude-tty / claude-cloud) is launched with `--effort <level>`,
 * resolved from `WOWLIDATOR_<ROLE>_EFFORT` (see `role()` in `config.ts`).
 * `high` on the generator is where authoring earns its thinking; `low`
 * everywhere the call is small and latency-sensitive. Non-Claude providers
 * ignore the value, and an explicit `--effort` on a run still wins — so this
 * is the default a run inherits, said out loud on the panel.
 */
export interface SelectSpec {
  env: string;
  label: string;
  help: string;
  /** The allowed values, in the order the panel offers them. */
  options: readonly string[];
  /** The value an ABSENT var resolves to — the role's own default effort. */
  defaultValue: string;
}

/** Claude's `--effort` ladder, low → high. */
const EFFORT_OPTIONS: readonly string[] = ['low', 'medium', 'high'];

export const SELECTS: readonly SelectSpec[] = [
  {
    env: 'WOWLIDATOR_GENERATOR_EFFORT',
    label: 'Generator effort',
    help:
      'Reasoning effort (--effort) for the generator role on a CLI provider that supports it — authoring is one large call per row and is where high pays off; ' +
      'medium roughly halves the think time, low is fastest and thinnest. Other providers ignore this; an explicit --effort on a run still wins.',
    options: EFFORT_OPTIONS,
    defaultValue: 'high',
  },
  {
    env: 'WOWLIDATOR_HEALER_EFFORT',
    label: 'Healer effort',
    help: 'Reasoning effort for the healer role on a CLI provider that supports it. Repair is small and latency-sensitive — low is the default and usually right.',
    options: EFFORT_OPTIONS,
    defaultValue: 'low',
  },
  {
    env: 'WOWLIDATOR_AGENT_EFFORT',
    label: 'Agent effort',
    help: 'Reasoning effort for the agent role on a CLI provider that supports it. One small structured decision per turn — the loop owns the reasoning, so low is the default.',
    options: EFFORT_OPTIONS,
    defaultValue: 'low',
  },
  {
    env: 'WOWLIDATOR_DATA_EFFORT',
    label: 'Data effort',
    help: 'Reasoning effort for the data role on a CLI provider that supports it — regenerating one rejected field value. Low is the default.',
    options: EFFORT_OPTIONS,
    defaultValue: 'low',
  },
  {
    env: 'WOWLIDATOR_GOVERNOR_EFFORT',
    label: 'Governor effort',
    help: 'Reasoning effort for the queue governor when it runs as a model (WOWLIDATOR_GOVERNOR=model) on a CLI provider that supports it. Low is the default.',
    options: EFFORT_OPTIONS,
    defaultValue: 'low',
  },
];

export interface SelectView extends SelectSpec {
  /** The resolved value: the env value if it is one of `options`, else `defaultValue`. */
  value: string;
  /** The raw value the environment holds, '' when unset. */
  raw: string;
}

export function describeSelects(env: NodeJS.ProcessEnv = process.env): SelectView[] {
  return SELECTS.map((spec) => {
    const raw = (env[spec.env] ?? '').trim();
    const value = spec.options.includes(raw) ? raw : spec.defaultValue;
    return { ...spec, value, raw };
  });
}

/**
 * Set one select: `.env` first, then this process — the next spawned job
 * inherits it. Unknown vars and values outside the option list are refused.
 */
export async function persistSelect(
  envVar: string,
  value: unknown,
  envPath = '.env',
  env: NodeJS.ProcessEnv = process.env,
): Promise<SelectView> {
  const spec = SELECTS.find((s) => s.env === envVar);
  if (spec === undefined) {
    throw new ClaudeSettingsError(`"${envVar}" is not a machinery select this panel edits`);
  }
  const v = String(value ?? '').trim();
  if (!spec.options.includes(v)) {
    throw new ClaudeSettingsError(`"${spec.label}" must be one of ${spec.options.join(', ')}`);
  }
  await upsertEnv([[spec.env, v]], envPath);
  env[spec.env] = v;
  return { ...spec, value: v, raw: v };
}

export interface GateView {
  env: string;
  label: string;
  help: string;
  on: boolean;
  /** The raw value the environment holds, '' when unset. */
  raw: string;
}

function isOn(spec: GateSpec, raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return spec.defaultOn;
  return value !== 'off' && value !== '0' && value !== 'false' && value !== 'no';
}

export function describeGates(env: NodeJS.ProcessEnv = process.env): GateView[] {
  return GATES.map((spec) => ({
    env: spec.env,
    label: spec.label,
    help: spec.help,
    on: isOn(spec, env[spec.env]),
    raw: env[spec.env] ?? '',
  }));
}

/**
 * Flip one gate: `.env` first, then this process — the next spawned job
 * inherits it. Unknown vars are refused by name; the allowlist is the point.
 */
export async function persistGate(
  envVar: string,
  on: boolean,
  envPath = '.env',
  env: NodeJS.ProcessEnv = process.env,
): Promise<GateView> {
  const spec = GATES.find((g) => g.env === envVar);
  if (spec === undefined) {
    throw new ClaudeSettingsError(`"${envVar}" is not a machinery gate this panel edits`);
  }
  const value = on ? spec.onValue : 'off';
  await upsertEnv([[spec.env, value]], envPath);
  env[spec.env] = value;
  return { env: spec.env, label: spec.label, help: spec.help, on, raw: value };
}
