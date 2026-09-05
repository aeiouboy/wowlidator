import { errors, type Locator, type Page } from 'playwright';

export const CONSENT_GATE_URL_PATTERN = /(^|\/)(consent|pdpa|terms|agreement)(\/|$|\?)/i;
export const CONSENT_ACCEPT_NAME =
  /^(accept and continue|accept|agree|i agree|ยอมรับและดำเนินการต่อ|ยอมรับ)$/i;
export const CONSENT_HEADING_PATTERN = /consent|pdpa|personal data|ความยินยอม/i;

const CONSENT_ACCEPT_CONTROL =
  'role=button[name=/^(accept and continue|accept|agree|i agree|ยอมรับและดำเนินการต่อ|ยอมรับ)$/i]';

interface BrowserConsentElement {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
  dispatchEvent(event: unknown): void;
}

interface BrowserConsentGlobals {
  document: {
    documentElement: { scrollHeight: number };
    querySelectorAll(selector: string): ArrayLike<BrowserConsentElement>;
  };
  Event: new (type: string, init: { bubbles: boolean }) => unknown;
  getComputedStyle(element: BrowserConsentElement): { overflowY: string };
  scrollTo(x: number, y: number): void;
}

async function firstVisible(tab: Page, selector: string): Promise<Locator | null> {
  const controls = await tab.locator(selector).all();
  for (const control of controls) {
    if (await control.isVisible()) return control;
  }
  return null;
}

async function scrollConsentDocuments(tab: Page, accept: Locator): Promise<void> {
  if (await accept.isEnabled()) return;
  await tab.locator('body').evaluate(() => {
    const browser = globalThis as unknown as BrowserConsentGlobals;
    const scrollables = browser.document.querySelectorAll('*');
    for (let index = 0; index < scrollables.length; index += 1) {
      const element = scrollables[index];
      if (element === undefined) continue;
      const overflow = browser.getComputedStyle(element).overflowY;
      if (!/(auto|scroll)/.test(overflow) || element.scrollHeight <= element.clientHeight + 1) continue;
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new browser.Event('scroll', { bubbles: true }));
    }
    browser.scrollTo(0, browser.document.documentElement.scrollHeight);
  });
  await tab.waitForTimeout(50);
}

async function acceptControl(tab: Page, accept: Locator): Promise<void> {
  await scrollConsentDocuments(tab, accept);
  await accept.click();
  try {
    await tab.waitForLoadState('networkidle', { timeout: 10_000 });
  } catch (error) {
    if (!(error instanceof errors.TimeoutError)) throw error;
  }
  await tab.waitForTimeout(300);
}

export async function acceptConsentGate(tab: Page): Promise<boolean> {
  if (!CONSENT_GATE_URL_PATTERN.test(tab.url())) return false;
  const accept = await firstVisible(tab, CONSENT_ACCEPT_CONTROL);
  if (accept === null) return false;
  await acceptControl(tab, accept);
  return true;
}

export async function consentGateShowing(tab: Page): Promise<Locator | null> {
  const accept = await firstVisible(tab, CONSENT_ACCEPT_CONTROL);
  if (accept === null) return null;
  if (CONSENT_GATE_URL_PATTERN.test(tab.url())) return accept;
  const headings = await tab.locator('h1, h2, h3, [role="heading"]').allInnerTexts();
  return headings.some((heading) => CONSENT_HEADING_PATTERN.test(heading)) ? accept : null;
}

export async function acceptConsentGateAnywhere(tab: Page): Promise<boolean> {
  const accept = await consentGateShowing(tab);
  if (accept === null) return false;
  await acceptControl(tab, accept);
  return true;
}
