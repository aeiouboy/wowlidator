/**
 * Choosing from a hand-rolled listbox the way a person does.
 *
 * humi's selects are `button[aria-haspopup=listbox][aria-expanded]` triggers
 * over a `ul[role=listbox] > li[role=option][aria-disabled]` list — sometimes
 * portaled to `<body>`, sometimes with a search `<input>` above the list
 * ("Type to search..." / "Search..." / "ค้นหา...") that filters up to 813
 * options, sometimes a checkbox row per option for a multi-select, and for
 * a dependent pair (Province → District → Sub-district) the child list
 * fills only after a fetch. `#selectCustom` in `runner.ts` clicked the
 * trigger and one option page-wide with nothing else — no typing, no wait
 * for the fetch, no multi, and on a miss an error that was not a content
 * miss, so the ladder paid a healer that cannot open a list and an agent
 * look before failing (EH-01, ~450 rows: every EC hire's ~20 coded lookups,
 * PY-Config Company→Branch, BE Company multi-select, TM leave type,
 * probation result).
 *
 * The procedure, deterministic and $0:
 *
 * 1. open the list unless `aria-expanded="true"` (a second click closes it);
 * 2. wait for the list to HOLD something — ≥ 1 option, ≥ 1 checkbox row, or
 *    an empty row ("No options" / "ไม่พบข้อมูล") — up to `timeout`, because
 *    a dependent list still fetching is the common case;
 * 3. when a search box sits inside or beside the open list, type the stable
 *    head of the value (its CODE half — "A" of "A - Permanent", "40106337"
 *    of "40106337 (Job Title)" — else the whole value); if that leaves the
 *    list empty, clear and type the LABEL half; if still empty, clear so
 *    the whole list is back;
 * 4. match an option by WHOLE name, then whole word, for the whole value,
 *    then its code half, then its label half — never plain substring ("Male"
 *    is inside "Female"); a disabled match is a state verdict;
 * 5. multi-select: split on `,` / `;` / ` + `, tick each row's checkbox,
 *    Escape;
 * 6. read the trigger back and require it to show what was picked — a click
 *    that landed nowhere is a failure with evidence, not a green step.
 *
 * On a miss the list is closed and the error keeps the `no option named …
 * appeared` wording the runner's state-contradiction rung is keyed on.
 * Runner wiring is the runner's half.
 */
import type { Locator, Page } from 'playwright';

import { codeAndLabelOf, foldedMatch, type FoldedMatch } from './normalise.js';
import { optionNamePatterns } from './selector.js';

export interface SelectFromListboxOptions {
  /** Budget for opening, for the list to fill, and for the pick. Default 2 000 ms. */
  timeout?: number | undefined;
  /** How long the list is given to react to a keystroke. Default 250 ms. */
  settleMs?: number | undefined;
  /** Type into a search box when one is offered. Default true. */
  typeToFilter?: boolean | undefined;
  /**
   * `require` (default): the trigger must show the picked value afterwards
   * or the pick throws. `record`: read it, report it, never throw on it —
   * for a trigger whose text is its label, not its value.
   */
  readBack?: 'require' | 'record' | undefined;
}

export interface ListboxSelection {
  /** The option names actually clicked / ticked, in order. */
  picked: string[];
  via: 'option' | 'checkbox';
  /** What was typed into the search box, when one was used. */
  typed?: string | undefined;
  /**
   * Which candidate found the option: the whole value, its code half, its
   * label half — or `prefix`, the one option in the list that starts with
   * the value when nothing matched whole ("Thai" → "Thailand - Thailand").
   */
  matchedBy: 'whole' | 'code' | 'label' | 'prefix';
  /** What the trigger showed afterwards, and whether that holds the pick. */
  readBack: string | null;
  confirmed: boolean;
  /** How long the list took to hold anything after opening. */
  waitedMs: number;
}

/**
 * The one option name that begins with `value` (case-folded, whitespace
 * collapsed, a code-half `X - ` prefix on the option tolerated), or null when
 * none or several do. Pure; the pick rung's last resort before a miss.
 */
export function uniquePrefixMatch(options: readonly string[], value: string): string | null {
  const fold = (text: string): string => text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  const wanted = fold(value);
  if (wanted.length < 2) return null;
  const hits = options.filter((option) => {
    const name = fold(option);
    if (name === wanted) return false; // a whole match belongs to the rung above
    if (name.startsWith(wanted)) return true;
    // "TH - Thailand": the label half after a code dash may carry the prefix.
    const dash = name.indexOf(' - ');
    return dash > 0 && name.slice(dash + 3).startsWith(wanted);
  });
  return hits.length === 1 ? hits[0]! : null;
}

/** The list opened but never held the option — closed again; wording is a parsed contract. */
export class ListboxOptionMissingError extends Error {
  override readonly name = 'ListboxOptionMissingError';
  readonly shown: string[];
  /**
   * Was `shown` a list narrowed by a typed search head, or the whole list?
   * The agent loop's enumerated-listbox judge (`listboxCannotOffer`) reads
   * only a whole enumeration as evidence that the control cannot offer a
   * value — a filtered list says nothing about what the filter hid.
   */
  readonly filtered: boolean;
  /**
   * The search head the list's own empty row answered ("No options found")
   * — the application's own statement that nothing matches that text — or
   * null when no search was typed or every head returned options.
   */
  readonly searchedEmpty: string | null;
  /** The trigger's own label when the list opened — the page's name for the control, in its language. */
  readonly trigger: string;
  constructor(
    trigger: string,
    value: string,
    shown: string[],
    detail: string,
    evidence: { filtered?: boolean | undefined; searchedEmpty?: string | null | undefined } = {},
  ) {
    super(
      `opened ${JSON.stringify(trigger)} but no option named ${JSON.stringify(value)} appeared ` +
        `(looked for role=option, menuitem, menuitemradio; ${
          shown.length === 0 ? 'the list held no options' : `${shown.length} shown: ${shown.slice(0, 8).map((s) => JSON.stringify(s)).join(', ')}${shown.length > 8 ? ', …' : ''}`
        })${detail === '' ? '' : `: ${detail}`}`,
    );
    this.shown = shown;
    this.filtered = evidence.filtered ?? false;
    this.searchedEmpty = evidence.searchedEmpty ?? null;
    this.trigger = trigger;
  }
}

/** The option is there and cannot be chosen — a fact about the page, not the selector. */
export class ListboxOptionDisabledError extends Error {
  override readonly name = 'ListboxOptionDisabledError';
  constructor(value: string, name: string) {
    super(`option ${JSON.stringify(name)} for ${JSON.stringify(value)} is disabled — element is not enabled, so it cannot be chosen`);
  }
}

/** The pick landed but the control does not show it. */
export class ListboxReadBackError extends Error {
  override readonly name = 'ListboxReadBackError';
  constructor(value: string, picked: string, shown: string | null) {
    super(
      `picked ${JSON.stringify(picked)} for ${JSON.stringify(value)} but the control now shows ${
        shown === null ? 'nothing readable' : JSON.stringify(shown)
      } — the selection did not take`,
    );
  }
}

const EMPTY_ROW = /^(no (?:options?|results?|data|matches?)(?: found)?|nothing found|not found|ไม่พบ(?:ข้อมูล|รายการ|ผลลัพธ์)?|ไม่มี(?:ข้อมูล|รายการ|ตัวเลือก))$/iu;
const SEARCH_INPUT = 'input[type="text"], input[type="search"], input:not([type]), [role="searchbox"], [role="textbox"], [role="combobox"]';

/** A multi-value: `CDS (C001), B2S (C006)` / `A; B` / `A + B`. Never split on a dash. */
export function splitMultiValue(value: string): string[] {
  return value
    .split(/\s*(?:,|;|\s\+\s)\s*/u)
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

/** The ordered candidates for an option name: whole, code half, label half. */
export function optionCandidates(value: string): { text: string; by: 'whole' | 'code' | 'label' }[] {
  const out: { text: string; by: 'whole' | 'code' | 'label' }[] = [{ text: value.trim(), by: 'whole' }];
  const halves = codeAndLabelOf(value);
  if (halves !== null) {
    if (halves.code !== value.trim()) out.push({ text: halves.code, by: 'code' });
    if (halves.label !== value.trim()) out.push({ text: halves.label, by: 'label' });
  }
  return out;
}

async function attr(locator: Locator, name: string, timeout: number): Promise<string | null> {
  return locator
    .first()
    .evaluate((el, n: string) => (el as unknown as { getAttribute(a: string): string | null }).getAttribute(n), name, { timeout })
    .catch(() => null);
}

/** The open list's container: `aria-controls` target, else the last visible listbox/menu on the page. */
async function openList(page: Page, trigger: Locator, timeout: number): Promise<{ list: Locator; container: Locator } | null> {
  const controls = await attr(trigger, 'aria-controls', 250);
  const deadline = Date.now() + timeout;
  for (;;) {
    if (controls) {
      const byId = page.locator(`[id="${controls.replace(/"/g, '\\"')}"]`);
      if (await byId.first().isVisible().catch(() => false)) {
        return { list: byId.first(), container: byId.first().locator('xpath=..') };
      }
    }
    const lists = page.locator('[role="listbox"], [role="menu"], [role="tree"]').filter({ visible: true });
    const count = await lists.count().catch(() => 0);
    if (count > 0) {
      const list = lists.nth(count - 1);
      return { list, container: list.locator('xpath=..') };
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(50);
  }
}

interface ListState {
  options: string[];
  checkboxes: number;
  emptyRow: string | null;
}

/** What the list holds right now: option names, checkbox rows, an empty-state row. One read. */
async function listState(list: Locator, timeout: number): Promise<ListState> {
  const read = await list
    .first()
    .evaluate(
      (el) => {
        const root = el as unknown as {
          querySelectorAll(sel: string): ArrayLike<{
            textContent: string | null;
            getAttribute(a: string): string | null;
            innerText?: string;
          }>;
        };
        const names: string[] = [];
        const options = root.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="treeitem"]');
        for (let i = 0; i < options.length; i++) {
          const o = options[i]!;
          const t = (o.getAttribute('aria-label') ?? o.innerText ?? o.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (t !== '') names.push(t);
        }
        const checkboxes = root.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length;
        let empty: string | null = null;
        if (names.length === 0) {
          const rows = root.querySelectorAll('li, [role="presentation"], p, div, span');
          for (let i = 0; i < rows.length; i++) {
            const t = (rows[i]!.innerText ?? rows[i]!.textContent ?? '').replace(/\s+/g, ' ').trim();
            if (t !== '' && t.length <= 60) { empty = t; break; }
          }
        }
        return { options: names, checkboxes, emptyRow: empty };
      },
      undefined,
      { timeout },
    )
    .catch(() => ({ options: [] as string[], checkboxes: 0, emptyRow: null as string | null }));
  return read;
}

/** Wait until the list holds options, checkbox rows, or an empty-state row. */
async function waitForListToFill(page: Page, list: Locator, timeout: number): Promise<{ state: ListState; waitedMs: number }> {
  const started = Date.now();
  const deadline = started + timeout;
  for (;;) {
    const state = await listState(list, Math.max(250, timeout));
    const filled = state.options.length > 0 || state.checkboxes > 0 || (state.emptyRow !== null && EMPTY_ROW.test(state.emptyRow));
    if (filled || Date.now() >= deadline) return { state, waitedMs: Date.now() - started };
    await page.waitForTimeout(50);
  }
}

/** The search box inside or beside the open list, visible now, or null. */
async function searchBoxOf(container: Locator, list: Locator): Promise<Locator | null> {
  for (const scope of [list, container, container.locator('xpath=..')]) {
    const box = scope.locator(SEARCH_INPUT).filter({ visible: true }).first();
    if (await box.isVisible().catch(() => false)) return box;
  }
  return null;
}

/** The first enabled option matching `name` in scope, with its accessible name; a disabled-only match is reported. */
async function findOption(
  scope: Locator,
  name: RegExp,
): Promise<{ option: Locator; name: string; disabled: boolean } | null> {
  const roles = ['option', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'treeitem'] as const;
  let disabledOnly: { option: Locator; name: string } | null = null;
  for (const role of roles) {
    const matches = scope.getByRole(role, { name, includeHidden: false });
    const count = await matches.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 12); i++) {
      const option = matches.nth(i);
      if (!(await option.isVisible().catch(() => false))) continue;
      const text = ((await option.innerText({ timeout: 250 }).catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
      const aria = await attr(option, 'aria-disabled', 250);
      const disabled = aria === 'true' || !(await option.isEnabled().catch(() => true));
      if (disabled) {
        disabledOnly ??= { option, name: text };
        continue;
      }
      return { option, name: text, disabled: false };
    }
  }
  return disabledOnly === null ? null : { ...disabledOnly, disabled: true };
}

/** What the trigger shows now — its text, value or aria-valuetext. */
async function readTrigger(trigger: Locator, timeout: number): Promise<string | null> {
  try {
    const held = await trigger.first().evaluate(
      (el) => {
        const node = el as unknown as {
          value?: unknown;
          getAttribute(name: string): string | null;
          innerText?: string;
          textContent?: string | null;
        };
        if (typeof node.value === 'string' && node.value !== '') return node.value;
        const aria = node.getAttribute('aria-valuetext');
        if (aria) return aria;
        return (node.innerText ?? node.textContent ?? '').replace(/[▾▼⌄˅]/g, ' ').replace(/\s+/g, ' ').trim();
      },
      undefined,
      { timeout },
    );
    return typeof held === 'string' ? held : null;
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error);
}

/**
 * Pick `value` from the listbox behind `trigger`. See the module comment for
 * the procedure. Throws `ListboxOptionMissingError` (list closed again),
 * `ListboxOptionDisabledError`, or `ListboxReadBackError`; any other error
 * is Playwright's own, from the open click.
 */
export async function selectFromListbox(
  page: Page,
  trigger: Locator,
  value: string,
  options: SelectFromListboxOptions = {},
): Promise<ListboxSelection> {
  const timeout = options.timeout ?? 2_000;
  const settleMs = options.settleMs ?? 250;
  const triggerName = (await readTrigger(trigger, 250)) ?? 'the trigger';

  const expanded = await attr(trigger, 'aria-expanded', 250);
  if (expanded !== 'true') await trigger.first().click({ timeout });

  const opened = await openList(page, trigger, timeout);
  if (opened === null) {
    await page.keyboard.press('Escape').catch(() => undefined);
    throw new ListboxOptionMissingError(triggerName, value, [], `no listbox or menu became visible within ${timeout} ms of opening`);
  }
  const { list, container } = opened;
  const filled = await waitForListToFill(page, list, timeout);
  let state = filled.state;
  const isMulti = state.checkboxes > 0 && splitMultiValue(value).length > 1;
  const parts = isMulti ? splitMultiValue(value) : [value];

  const picked: string[] = [];
  let typed: string | undefined;
  let matchedBy: 'whole' | 'code' | 'label' | 'prefix' = 'whole';
  for (const part of parts) {
    const candidates = optionCandidates(part);
    // 3. Type-to-filter, the stable head first.
    const box = options.typeToFilter === false ? null : await searchBoxOf(container, list);
    // What the miss below may say about the list: whether `state` is the
    // whole list or a typed narrowing of it, and which head the list's own
    // empty row answered. Read by the agent loop's enumerated-listbox judge.
    let filtered = false;
    let searchedEmpty: string | null = null;
    if (box !== null) {
      const heads = [candidates.find((c) => c.by === 'code')?.text ?? candidates[0]!.text];
      const label = candidates.find((c) => c.by === 'label')?.text;
      if (label !== undefined && label !== heads[0]) heads.push(label);
      let found = false;
      for (const head of heads) {
        await box.fill(head, { timeout }).catch(() => undefined);
        await page.waitForTimeout(settleMs);
        state = (await waitForListToFill(page, list, timeout)).state;
        typed = head;
        if (state.options.length > 0 || state.checkboxes > 0) {
          found = true;
          break;
        }
        if (searchedEmpty === null && state.emptyRow !== null && EMPTY_ROW.test(state.emptyRow)) searchedEmpty = head;
      }
      filtered = found;
      if (!found) {
        await box.fill('', { timeout }).catch(() => undefined);
        await page.waitForTimeout(settleMs);
        state = (await waitForListToFill(page, list, timeout)).state;
      }
    }
    // 4. Match: whole name, then whole word — for the whole value, then its halves.
    let hit: { option: Locator; name: string; disabled: boolean } | null = null;
    for (const candidate of candidates) {
      const [exact, contains] = optionNamePatterns(candidate.text);
      hit = (await findOption(container, exact)) ?? (await findOption(page.locator('body'), exact));
      if (hit === null || hit.disabled) {
        const word = (await findOption(container, contains)) ?? (await findOption(page.locator('body'), contains));
        if (word !== null && (!word.disabled || hit === null)) hit = word;
      }
      if (hit !== null && !hit.disabled) {
        matchedBy = candidate.by;
        break;
      }
    }
    // Last resort before a miss: the ONE option that starts with the value.
    // Never a substring ("Male" is not "Female") and never one of several
    // ("New Hire" is not every "New Hire — …"): exactly one option, or
    // nothing. The read-back below records what the control shows, so a
    // wrong guess is visible in the proof rather than silent. Measured live
    // (humi, 2026-09-05): "Thai" against a list whose only match was
    // "Thailand - Thailand" cost the agent a miss, a settle, and a turn.
    if (hit === null || hit.disabled) {
      const unique = uniquePrefixMatch(state.options, part);
      if (unique !== null) {
        const [exact] = optionNamePatterns(unique);
        const byPrefix = (await findOption(container, exact)) ?? (await findOption(page.locator('body'), exact));
        if (byPrefix !== null && !byPrefix.disabled) {
          hit = byPrefix;
          matchedBy = 'prefix';
        }
      }
    }
    if (hit === null) {
      await page.keyboard.press('Escape').catch(() => undefined);
      throw new ListboxOptionMissingError(
        triggerName,
        part,
        state.options,
        state.emptyRow !== null && state.options.length === 0 ? `the list says ${JSON.stringify(state.emptyRow)}` : '',
        { filtered, searchedEmpty },
      );
    }
    if (hit.disabled) {
      await page.keyboard.press('Escape').catch(() => undefined);
      throw new ListboxOptionDisabledError(part, hit.name);
    }
    // 5. Tick or click.
    if (isMulti) {
      // The row's own checkbox, not the row: a click on the row's padding
      // toggles nothing, and `setChecked` is idempotent for a row already on.
      const checkbox = hit.option.locator('input[type="checkbox"], [role="checkbox"]').first();
      if ((await checkbox.count()) > 0) {
        await checkbox.setChecked(true, { timeout });
      } else {
        await hit.option.click({ timeout });
      }
    } else {
      try {
        await hit.option.click({ timeout });
      } catch (error) {
        await page.keyboard.press('Escape').catch(() => undefined);
        throw new ListboxOptionMissingError(triggerName, part, state.options, `the option was found but could not be clicked: ${describe(error)}`);
      }
    }
    picked.push(hit.name);
  }
  if (isMulti) await page.keyboard.press('Escape').catch(() => undefined);

  // 6. Read back.
  await page.waitForTimeout(settleMs);
  const readBack = await readTrigger(trigger, timeout);
  let confirmed = false;
  if (readBack !== null) {
    const outcomes: (FoldedMatch | null)[] = [
      ...parts.map((p) => foldedMatch(p, readBack)),
      ...picked.map((p) => foldedMatch(p, readBack)),
    ];
    confirmed = outcomes.some((o) => o !== null);
  }
  if (!confirmed && !isMulti && (options.readBack ?? 'require') === 'require') {
    throw new ListboxReadBackError(value, picked[0] ?? value, readBack);
  }
  return {
    picked,
    via: isMulti ? 'checkbox' : 'option',
    ...(typed === undefined ? {} : { typed }),
    matchedBy,
    readBack,
    confirmed,
    waitedMs: filled.waitedMs,
  };
}
