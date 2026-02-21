import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

export interface BrowserOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
  recordVideo?: boolean;
  artifactDir?: string;
}

const DEFAULT_VIEWPORT = { width: 1024, height: 768 };

export async function launchBrowser(options: BrowserOptions = {}): Promise<Page> {
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;

  browser = await chromium.launch({
    headless: options.headless ?? false,
    args: [
      '--disable-web-security',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });

  const contextOptions: Parameters<Browser['newContext']>[0] = {
    viewport,
    deviceScaleFactor: 1,
    bypassCSP: true,
  };

  if (options.recordVideo && options.artifactDir) {
    contextOptions.recordVideo = { dir: options.artifactDir, size: viewport };
  }

  context = await browser.newContext(contextOptions);
  page = await context.newPage();

  return page;
}

export function getPage(): Page {
  if (!page) throw new Error('Browser not launched. Call launchBrowser() first.');
  return page;
}

export function getViewport(): { width: number; height: number } {
  if (!page) return DEFAULT_VIEWPORT;
  const size = page.viewportSize();
  return size ?? DEFAULT_VIEWPORT;
}

export async function closeBrowser(): Promise<void> {
  if (context) {
    await context.close().catch(() => {});
    context = null;
  }
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
  page = null;
}
