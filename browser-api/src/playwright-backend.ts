import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import type { BrowserApiConfig } from './config.js';
import type {
  ActionRequest,
  ActionResult,
  DomElement,
  DomQuery,
  DomSnapshot,
  EvalRequest,
  QueryMatch,
  QueryRequest,
  QueryResponse,
} from './contracts.js';
import type { BrowserBackend, BrowserSessionHandle } from './browser-backend.js';
import { AppError } from './errors.js';
import { runSandboxedScript, type SandboxDocument } from './sandbox.js';
import { UrlPolicy } from './url-policy.js';

interface SessionPage {
  context: BrowserContext;
  page: Page;
  tabId: number;
}

const visibleAttributeNames = [
  'id', 'name', 'role', 'type', 'class', 'href', 'placeholder', 'aria-label', 'aria-expanded',
  'aria-checked', 'aria-selected', 'aria-disabled', 'title', 'alt', 'data-testid',
];

function safeText(value: string | null | undefined, max = 2_000): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function redactUrl(value: string | null | undefined): string {
  if (!value) return 'about:blank';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'about:blank';
    url.username = '';
    url.password = '';
    url.hash = '';
    url.search = '';
    return url.href.slice(0, 2_000);
  } catch {
    return 'about:blank';
  }
}

function safeUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return redactUrl(url.href);
  } catch {
    return undefined;
  }
}

function mapPlaywrightError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error && /Timeout/i.test(error.name)) {
    return new AppError(504, 'BROWSER_TIMEOUT', 'The browser action exceeded its timeout.');
  }
  if (error instanceof Error && /Target page|closed|browser has been closed/i.test(error.message)) {
    return new AppError(409, 'PAGE_UNAVAILABLE', 'The browser page is no longer available.');
  }
  return new AppError(500, 'BROWSER_ACTION_FAILED', 'The browser action could not be completed.');
}

export class PlaywrightBackend implements BrowserBackend {
  private browser: Browser | undefined;
  private nextTabId = 1;
  private readonly sessions = new Map<string, SessionPage>();
  private readonly policy: UrlPolicy;

  constructor(private readonly config: BrowserApiConfig) {
    this.policy = new UrlPolicy({
      allowPrivateNetworks: config.allowPrivateNetworks,
      allowedHosts: config.allowedHosts,
    });
  }

  async launch(): Promise<void> {
    if (this.browser) return;
    try {
      this.browser = await chromium.launch({
        headless: this.config.headless,
        chromiumSandbox: this.config.chromiumSandbox,
        ...(this.config.browserExecutablePath ? { executablePath: this.config.browserExecutablePath } : {}),
        args: [
          '--disable-extensions',
          '--disable-quic',
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-sync',
          '--disable-default-apps',
          '--no-first-run',
          '--metrics-recording-only',
        ],
      });
    } catch (error) {
      throw new AppError(500, 'BROWSER_LAUNCH_FAILED', error instanceof Error ? error.message : 'Could not launch Chromium.');
    }
  }

  async createSession(sessionId: string): Promise<BrowserSessionHandle> {
    await this.launch();
    if (!this.browser) throw new AppError(503, 'BROWSER_UNAVAILABLE', 'The browser is not available.');
    const context = await this.browser.newContext({
      acceptDownloads: false,
      serviceWorkers: 'block',
      permissions: [],
      javaScriptEnabled: true,
      viewport: { width: 1280, height: 800 },
    });
    context.setDefaultTimeout(this.config.actionTimeoutMs);
    context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
    await context.routeWebSocket('**/*', async (socket) => {
      await socket.close({ code: 1008, reason: 'WebSocket access is disabled by the browser API.' });
    });
    await context.route('**/*', async (route: Route) => {
      try {
        await this.policy.assertRequest(route.request().url());
        await route.continue();
      } catch {
        await route.abort('blockedbyclient').catch(() => undefined);
      }
    });

    let primaryPage: Page | undefined;
    let creatingPrimaryPage = true;
    context.on('page', (newPage) => {
      if (creatingPrimaryPage) {
        primaryPage = newPage;
        return;
      }
      if (newPage !== primaryPage) void newPage.close().catch(() => undefined);
    });
    const page = await context.newPage();
    primaryPage = page;
    creatingPrimaryPage = false;
    const tabId = this.nextTabId++;
    page.setDefaultTimeout(this.config.actionTimeoutMs);
    page.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
    page.on('dialog', (dialog) => {
      void dialog.dismiss().catch(() => undefined);
    });
    page.on('download', (download) => {
      void download.cancel().catch(() => undefined);
    });
    page.on('filechooser', (chooser) => {
      void chooser.setFiles([]).catch(() => undefined);
    });
    page.on('popup', (popup) => {
      void popup.close().catch(() => undefined);
    });
    context.on('close', () => {
      if (this.sessions.get(sessionId)?.context === context) this.sessions.delete(sessionId);
    });
    this.sessions.set(sessionId, { context, page, tabId });
    return { sessionId, tabId };
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (session) await session.context.close().catch(() => undefined);
  }

  async getCurrentTab(sessionId: string): Promise<BrowserSessionHandle> {
    const session = this.requireSession(sessionId);
    return { sessionId, tabId: session.tabId };
  }

  async assertTab(sessionId: string, tabId: number): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.tabId !== tabId) {
      throw new AppError(403, 'TAB_NOT_ACCESSIBLE', 'Only the session\'s current tab is available to the API.');
    }
    if (session.page.isClosed()) throw new AppError(409, 'PAGE_UNAVAILABLE', 'The current browser page is closed.');
  }

  async performAction(sessionId: string, request: ActionRequest): Promise<ActionResult> {
    await this.assertTab(sessionId, request.tabId);
    const page = this.requireSession(sessionId).page;
    try {
      switch (request.action) {
        case 'navigate': {
          if (!request.url) throw new AppError(400, 'URL_REQUIRED', 'navigate requires a URL.');
          const url = await this.policy.assertNavigable(request.url);
          const response = await page.goto(url.href, { waitUntil: 'domcontentloaded' });
          return { url: redactUrl(page.url()), status: response?.status() ?? null, ok: true };
        }
        case 'click': {
          const locator = this.locator(page, request.selector);
          await locator.click({ timeout: this.config.actionTimeoutMs });
          return { clicked: true, selector: request.selector };
        }
        case 'type': {
          const locator = this.locator(page, request.selector);
          if (request.text === null || request.text === undefined) {
            throw new AppError(400, 'TEXT_REQUIRED', 'type requires text.');
          }
          await locator.fill(request.text, { timeout: this.config.actionTimeoutMs });
          return { typed: true, selector: request.selector, characters: request.text.length };
        }
        case 'scroll': {
          if (request.selector) {
            await this.locator(page, request.selector).scrollIntoViewIfNeeded({ timeout: this.config.actionTimeoutMs });
          } else {
            await page.mouse.wheel(0, 600);
          }
          const position = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
          return { scrolled: true, selector: request.selector ?? null, position };
        }
        case 'extract': {
          const locator = this.locator(page, request.selector);
          const texts = await locator.allTextContents();
          return { selector: request.selector, count: texts.length, texts: texts.slice(0, 200).map((text) => safeText(text)) };
        }
        case 'waitFor': {
          const locator = request.selector
            ? this.locator(page, request.selector)
            : page.getByText(request.text ?? '', { exact: false }).first();
          if (!request.selector && !request.text) {
            throw new AppError(400, 'WAIT_TARGET_REQUIRED', 'waitFor requires a selector or text.');
          }
          await locator.waitFor({ state: 'visible', timeout: this.config.actionTimeoutMs });
          return { waited: true, selector: request.selector ?? null, text: request.text ?? null };
        }
        case 'screenshot': {
          const image = await page.screenshot({ type: 'png', fullPage: false });
          if (image.byteLength > this.config.maxScreenshotBytes) {
            throw new AppError(413, 'SCREENSHOT_TOO_LARGE', 'The screenshot exceeds the configured size limit.');
          }
          return {
            mimeType: 'image/png',
            encoding: 'base64',
            bytes: image.byteLength,
            data: image.toString('base64'),
          };
        }
        case 'evaluate': {
          if (request.text === null || request.text === undefined) {
            throw new AppError(400, 'TEXT_REQUIRED', 'evaluate requires JavaScript in the text field.');
          }
          const value = await this.evaluate(sessionId, {
            code: request.text,
            tabId: request.tabId,
          });
          return { value };
        }
        default: {
          const exhaustive: never = request.action;
          throw new AppError(400, 'UNSUPPORTED_ACTION', `Unsupported action: ${String(exhaustive)}`);
        }
      }
    } catch (error) {
      throw mapPlaywrightError(error);
    }
  }

  async domSnapshot(sessionId: string, query: DomQuery): Promise<DomSnapshot> {
    await this.assertTab(sessionId, query.tabId);
    const page = this.requireSession(sessionId).page;
    const captured = await this.readDom(page);
    return {
      tabId: query.tabId,
      url: captured.url,
      title: captured.title,
      visibleElementCount: captured.elements.length,
      elements: captured.elements.slice(0, this.config.maxDomElements),
      truncated: captured.elements.length > this.config.maxDomElements,
      capturedAt: new Date().toISOString(),
    };
  }

  async query(sessionId: string, request: QueryRequest): Promise<QueryResponse> {
    await this.assertTab(sessionId, request.tabId);
    const page = this.requireSession(sessionId).page;
    const locator = page.locator(request.selector);
    let total: number;
    let elements: DomElement[];
    try {
      total = await locator.count();
      elements = await locator.evaluateAll((nodes: Element[], maxElements: number) => {
        const allowed = ['id', 'name', 'role', 'type', 'class', 'href', 'placeholder', 'aria-label', 'aria-expanded', 'aria-checked', 'aria-selected', 'aria-disabled', 'title', 'alt', 'data-testid'];
        const textOf = (element: Element) => String((element as HTMLElement).innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
        const safeUrl = (value: string) => {
          try {
            const url = new URL(value);
            return url.protocol === 'http:' || url.protocol === 'https:' ? url.href.slice(0, 2000) : undefined;
          } catch { return undefined; }
        };
        return nodes.slice(0, maxElements).map((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
          const attributes: Record<string, string> = {};
          for (const name of allowed) {
            const value = element.getAttribute(name);
            if (value !== null) attributes[name] = name === 'href' ? safeUrl(value) || '[blocked-url]' : String(value).slice(0, 500);
          }
          return {
            tag: element.tagName.toLowerCase(),
            ...(element.id ? { id: element.id } : {}),
            text: textOf(element),
            attributes,
            visible,
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          };
        });
      }, this.config.maxQueryMatches);
    } catch (error) {
      if (error instanceof Error && /invalid selector|unexpected token/i.test(error.message)) {
        throw new AppError(400, 'INVALID_SELECTOR', 'The CSS selector is invalid.');
      }
      throw error;
    }
    const sanitizedElements = elements.map((element) => ({
      ...element,
      attributes: Object.fromEntries(Object.entries(element.attributes).map(([key, value]) => [
        key,
        key === 'href' ? (typeof value === 'string' ? safeUrl(value) : undefined) || '[blocked-url]' : value,
      ])),
    }));
    return {
      tabId: request.tabId,
      selector: request.selector,
      count: total,
      matches: sanitizedElements.map((element, index) => ({
        index,
        tag: element.tag,
        text: element.text,
        attributes: element.attributes,
        visible: element.visible,
        ...(element.rect ? { rect: element.rect } : {}),
      })),
      truncated: total > this.config.maxQueryMatches,
    };
  }

  async evaluate(sessionId: string, request: EvalRequest): Promise<unknown> {
    // Do not pass request.code to page.evaluate(): the live page realm has
    // browser networking, storage, and window objects. Only the redacted,
    // bounded snapshot crosses into the QuickJS evaluator.
    await this.assertTab(sessionId, request.tabId);
    if (Buffer.byteLength(request.code, 'utf8') > this.config.maxEvalCodeBytes) {
      throw new AppError(400, 'EVAL_TOO_LARGE', 'The evaluation script is too large.');
    }
    const page = this.requireSession(sessionId).page;
    const model = await this.readDom(page);
    return runSandboxedScript(request.code, model, this.config.evalTimeoutMs);
  }

  async close(): Promise<void> {
    for (const sessionId of [...this.sessions.keys()]) await this.closeSession(sessionId);
    await this.browser?.close();
    this.browser = undefined;
  }

  private requireSession(sessionId: string): SessionPage {
    const session = this.sessions.get(sessionId);
    if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', 'The browser session does not exist.');
    return session;
  }

  private locator(page: Page, selector: string | null | undefined) {
    if (!selector) throw new AppError(400, 'SELECTOR_REQUIRED', 'This action requires a CSS selector.');
    return page.locator(selector).first();
  }

  private async readDom(page: Page, includeHidden = false): Promise<{ url: string; title: string; bodyText: string; elements: DomElement[] }> {
    const captured = await page.evaluate(({ maxElements, includeHidden }: { maxElements: number; includeHidden: boolean }) => {
      const allowed = ['id', 'name', 'role', 'type', 'class', 'href', 'placeholder', 'aria-label', 'aria-expanded', 'aria-checked', 'aria-selected', 'aria-disabled', 'title', 'alt', 'data-testid'];
      const skipped = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD']);
      const textOf = (element: Element | null) => String((element as HTMLElement | null)?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
      const isVisible = (element: Element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
      };
      const safeUrl = (value: string) => {
        try {
          const url = new URL(value);
          return url.protocol === 'http:' || url.protocol === 'https:' ? url.href.slice(0, 2000) : undefined;
        } catch { return undefined; }
      };
      const elements: DomElement[] = [];
      for (const element of (Array.from(document.querySelectorAll('*')) as Element[]).slice(0, maxElements * 3)) {
        if (skipped.has(element.tagName)) continue;
        const visible = isVisible(element);
        if (!visible && !includeHidden) continue;
        const rect = element.getBoundingClientRect();
        const attributes: Record<string, string> = {};
        for (const name of allowed) {
          const value = element.getAttribute(name);
          if (value === null) continue;
          attributes[name] = name === 'href' ? safeUrl(value) || '[blocked-url]' : String(value).slice(0, 500);
        }
        elements.push({
          tag: element.tagName.toLowerCase(),
          ...(element.id ? { id: element.id } : {}),
          text: textOf(element),
          attributes,
          visible,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        });
        if (elements.length >= maxElements) break;
      }
      return {
        url: location.href,
        title: document.title,
        bodyText: textOf(document.body),
        elements,
      };
    }, { maxElements: this.config.maxDomElements, includeHidden });
    const sanitizedElements = captured.elements.map((element) => ({
      ...element,
      attributes: Object.fromEntries(Object.entries(element.attributes).map(([key, value]) => [
        key,
        key === 'href' ? (typeof value === 'string' ? safeUrl(value) : undefined) || '[blocked-url]' : value,
      ])),
    }));
    return {
      url: redactUrl(captured.url),
      title: safeText(captured.title, 500),
      bodyText: safeText(captured.bodyText, 20_000),
      elements: sanitizedElements,
    };
  }

}
