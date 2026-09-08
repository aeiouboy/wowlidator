/**
 * Modal / dialog / popup detection and interaction — deterministic, no model
 * call. This is execution-plane code, not control-plane: it costs nothing
 * and runs on every step, so it has to be cheap and it has to be honest
 * about what it can and can't see.
 *
 * Detection is ARIA-based only: `role="dialog"`, `role="alertdialog"`, or a
 * native `<dialog open>`. A fixed-position `<div>` with no dialog role is
 * not detected — the same "understate, never overstate" choice
 * `ax-coverage.ts` makes for CSS selectors, applied here to a much richer
 * signal. Every mainstream component library (Radix, MUI, Headless UI,
 * Bootstrap 5) exposes this correctly; a hand-rolled non-ARIA popup is a
 * known, disclosed gap rather than something silently guessed at.
 */

import type { Locator, Page } from 'playwright';

import { includeHidden } from './reveal.js';

const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"], dialog[open]';

/**
 * Dismiss affordances that only CLOSE — "Cancel" on a confirm, "ปิด" on a
 * notice. Safe for the automatic rung: the worst a neutral click does is put
 * the page back where it was. Thai added 2026-09-03 (EH-02): humi's consent,
 * probation and TM dialogs say ปิด/ยกเลิก/ย้อนกลับ, so a genuinely blocking
 * Thai dialog was never cleared.
 */
export const NEUTRAL_DISMISS_NAME_PATTERN =
  /^(close|dismiss|cancel|no,? thanks|maybe later|not now|later|skip|ปิด|ยกเลิก|ย้อนกลับ|ไม่ใช่ตอนนี้|ข้าม|ไว้ทีหลัง)$/i;

/**
 * Affordances that CONFIRM something — "OK" on a delete, "Continue" on a
 * wizard, "ตกลง" on anything. The automatic rung used to click these too and
 * confirmed whatever the dialog asked (the engine CLAUDE.md records the
 * ladder closing a deliberately-opened "Edit rule" dialog; BE's Create Plan
 * popup discards the whole form on "Cancel", and "OK" on a delete confirm
 * DELETES). Under `policy: 'automatic'` these are clicked only on a
 * consent/cookie notice, where accepting is the neutral act.
 */
export const AFFIRMATIVE_DISMISS_NAME_PATTERN =
  /^(ok|okay|got it|accept|accept all|accept cookies|allow all|i agree|agree|i understand|continue|ตกลง|รับทราบ|ยอมรับ|ยอมรับทั้งหมด|เข้าใจแล้ว|ดำเนินการต่อ)$/i;

/** Either family — what an explicit `closeModal` without a `button` searches. */
export const DISMISS_NAME_PATTERN = new RegExp(
  `${NEUTRAL_DISMISS_NAME_PATTERN.source}|${AFFIRMATIVE_DISMISS_NAME_PATTERN.source}`,
  'i',
);

/** A dialog whose acceptance is the neutral act: cookies, PDPA, terms. */
export const CONSENT_DIALOG_PATTERN = /cookie|consent|pdpa|privacy|terms|ความยินยอม|คุกกี้|นโยบายความเป็นส่วนตัว|ข้อกำหนด/i;

const DISMISS_SYMBOL_PATTERN = /^[×✕✖⨯]$/;

/**
 * The previous step's actions after which an open dialog is the flow's OWN
 * context — an edit modal the next step is about to fill — and must not be
 * dismissed automatically. Was `click`/`press` only; a `fill`/`selectOption`
 * INSIDE the modal followed by a miss (an option list still loading) then
 * dismissed the modal the flow had just opened (EH-02: ~220 modal-form cases
 * across BE PL_06..09/RU_05..08, consent CNS-EC-002/015/032, TM cancel-request).
 */
export const DIALOG_CONTEXT_ACTIONS: ReadonlySet<string> = new Set([
  'click', 'press', 'fill', 'type', 'selectOption', 'check', 'uncheck', 'paste',
  'expectModal', 'closeModal', 'upload',
]);

/**
 * True when the step before this one makes an open dialog the intended context.
 *
 * `lastActionFailed` is load-bearing (HIR-EC-001, run `7af7be5d`, 2026-09-08):
 * a click aimed at an option the page never offered landed on whatever sat
 * behind it and opened a "To-do" panel. The previous action was a `click`, so
 * the panel was read as the flow's own context and left open — and the next
 * fourteen steps each timed out clicking through it. One wrong judgement cost
 * the rest of the case.
 *
 * A step that FAILED opened nothing on purpose, so it cannot make a dialog
 * intended. The other half of EH-02 is untouched: a dialog holding the failing
 * step's own target is still kept, by `selectorInsideDialog` at the call site.
 */
export function dialogIsIntendedContext(
  lastAction: string | null | undefined,
  lastActionFailed = false,
): boolean {
  if (lastActionFailed) return false;
  return lastAction !== null && lastAction !== undefined && DIALOG_CONTEXT_ACTIONS.has(lastAction);
}

/**
 * Does the failing selector name something INSIDE the open dialog? A step
 * aimed at the dialog's own field must never close it, whatever came before.
 * Hidden elements count (the field may be in a collapsed section of the
 * dialog, or not rendered yet); a selector Playwright cannot parse counts
 * as "no". Cheap: one `count()`, no waiting.
 */
export async function selectorInsideDialog(dialog: Locator, selector: string): Promise<boolean> {
  try {
    return (await dialog.locator(includeHidden(selector)).count()) > 0;
  } catch {
    return false;
  }
}

export interface DismissButton {
  locator: Locator;
  /** Accessible text of the button, for reports and error messages. */
  text: string;
}

/** Every currently-visible dialog, most-recently-attached first — usually the topmost/newest one. */
async function visibleDialogs(page: Page): Promise<Locator[]> {
  const candidates = page.locator(DIALOG_SELECTOR);
  const count = await candidates.count().catch(() => 0);
  const visible: Locator[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const candidate = candidates.nth(i);
    if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
  }
  return visible;
}

/**
 * The dialog open right now, with no wait. For the automatic recovery path,
 * called only after a step has already failed — waiting here would just add
 * a second timeout on top of the one that already elapsed.
 */
export async function openDialogNow(page: Page): Promise<Locator | null> {
  const dialogs = await visibleDialogs(page);
  return dialogs[0] ?? null;
}

/**
 * Wait up to `timeoutMs` for a dialog to appear. For `expectModal`/
 * `closeModal`, where the author is asserting one should show up — possibly
 * a moment after the step that triggers it.
 *
 * Polls rather than `locator.first().waitFor()`: a page can have more than
 * one dialog-role container in the DOM at once (several possible modals,
 * only one shown at a time), and `.first()` waits on whichever matches
 * first in *DOM order* — which is not necessarily the one that actually
 * becomes visible.
 */
export async function waitForDialog(page: Page, timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dialog = await openDialogNow(page);
    if (dialog) return dialog;
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(50);
  }
}

/**
 * A human-ish label for a dialog, for reports and error messages.
 * Approximate on purpose — full ARIA accessible-name computation
 * (aria-labelledby resolution, etc.) is more involved than a test-reporting
 * label needs to be.
 */
export async function describeDialog(dialog: Locator): Promise<string> {
  const label = await dialog.getAttribute('aria-label').catch(() => null);
  if (label) return label;
  // Then the heading a person reads as its title — humi's Create Plan modal
  // starts its text with an eyebrow, so the first 80 chars named the wrong
  // thing and `expectModal name:"Confirm delete plan"` could not match.
  const heading = await dialogHeading(dialog);
  if (heading !== null) return heading;
  const text = (await dialog.textContent().catch(() => '')) ?? '';
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed === '' ? 'unnamed dialog' : trimmed.slice(0, 80);
}

/** The first visible heading inside the dialog (`aria-labelledby` first, then h1–h3/`role=heading`), or null. */
export async function dialogHeading(dialog: Locator): Promise<string | null> {
  const labelledBy = await dialog.getAttribute('aria-labelledby').catch(() => null);
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/).filter((s) => s !== '')) {
      const text = await dialog
        .page()
        .locator(`[id="${id.replace(/"/g, '\\"')}"]`)
        .first()
        .innerText({ timeout: 250 })
        .catch(() => '');
      const trimmed = text.replace(/\s+/g, ' ').trim();
      if (trimmed !== '') return trimmed.slice(0, 120);
    }
  }
  const headings = dialog.locator('h1, h2, h3, [role="heading"]');
  const count = await headings.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 4); i++) {
    const candidate = headings.nth(i);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const text = (await candidate.innerText({ timeout: 250 }).catch(() => '')).replace(/\s+/g, ' ').trim();
    if (text !== '') return text.slice(0, 120);
  }
  return null;
}

/**
 * Does the dialog mention `name` — in its label, its heading, or anywhere
 * in its text? Case-insensitive substring, the same reading `expectModal`
 * makes, widened past the first 80 characters so a name that sits below an
 * eyebrow still counts. Returns where it was found, or null.
 */
export async function dialogMentions(
  dialog: Locator,
  name: string,
): Promise<{ via: 'label' | 'heading' | 'text'; text: string } | null> {
  const wanted = name.toLowerCase();
  const label = await dialog.getAttribute('aria-label').catch(() => null);
  if (label && label.toLowerCase().includes(wanted)) return { via: 'label', text: label };
  const heading = await dialogHeading(dialog);
  if (heading !== null && heading.toLowerCase().includes(wanted)) return { via: 'heading', text: heading };
  const text = ((await dialog.innerText({ timeout: 500 }).catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
  if (text.toLowerCase().includes(wanted)) return { via: 'text', text: text.slice(0, 200) };
  return null;
}

/**
 * Find a button inside `dialog` whose accessible name looks like a
 * dismiss/accept affordance. Checked in order: an explicit
 * `aria-label="Close"` control (the single most reliable signal, common on
 * icon-only close buttons with no visible text), then any button whose
 * accessible name matches a common dismiss word.
 *
 * Uses `getByRole('button', { name })`, not raw text content — the
 * accessible-name computation it does correctly follows `aria-label` even
 * when a button's visible content is just an icon, which is exactly the
 * icon-only-close-button case this needs to handle. Symbol glyphs (×, ✕)
 * rarely carry an accessible name at all, so those still need one manual
 * text-content check.
 *
 * When a dialog offers more than one plausible match (e.g. both "Accept" and
 * "Reject" on a cookie banner), this returns the first one found in document
 * order — not necessarily the one a human would choose. That ambiguity is
 * exactly why `closeModal` accepts an explicit `button` override rather than
 * relying on this alone.
 */
export interface FindDismissOptions {
  /**
   * `any` (default, the explicit `closeModal` request): neutral and
   * affirmative names alike — the author asked for the dialog closed.
   * `automatic` (the ladder's unrequested-dialog rung): neutral names only,
   * plus affirmative ones when the dialog reads as a consent/cookie notice —
   * never "OK" on a delete confirm or "Continue" on a wizard.
   */
  policy?: 'any' | 'automatic' | undefined;
}

export async function findDismissButton(
  dialog: Locator,
  options: FindDismissOptions = {},
): Promise<DismissButton | null> {
  const policy = options.policy ?? 'any';
  let pattern: RegExp = DISMISS_NAME_PATTERN;
  if (policy === 'automatic') {
    const text = ((await dialog.innerText({ timeout: 500 }).catch(() => '')) ?? '').slice(0, 2_000);
    pattern = CONSENT_DIALOG_PATTERN.test(text) ? DISMISS_NAME_PATTERN : NEUTRAL_DISMISS_NAME_PATTERN;
  }
  const explicitClose = dialog.getByRole('button', { name: /^(close|ปิด)$/i }).first();
  if (await explicitClose.isVisible().catch(() => false)) {
    const text =
      (await explicitClose.getAttribute('aria-label').catch(() => null)) ??
      (await explicitClose.textContent().catch(() => null)) ??
      'Close';
    return { locator: explicitClose, text: text.trim() || 'Close' };
  }

  const common = dialog.getByRole('button', { name: pattern }).first();
  if (await common.isVisible().catch(() => false)) {
    const text =
      ((await common.textContent().catch(() => '')) ||
        (await common.getAttribute('aria-label').catch(() => '')) ||
        ''
      ).trim();
    return { locator: common, text };
  }

  // Symbol-only glyphs rarely have a computed accessible name, so they need a
  // manual scan rather than a role-name query.
  const buttons = dialog.getByRole('button');
  const count = await buttons.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const candidate = buttons.nth(i);
    const text = ((await candidate.textContent().catch(() => '')) ?? '').trim();
    if (DISMISS_SYMBOL_PATTERN.test(text) && (await candidate.isVisible().catch(() => false))) {
      return { locator: candidate, text };
    }
  }
  return null;
}
