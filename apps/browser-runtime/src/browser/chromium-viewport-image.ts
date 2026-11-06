import type { Browser, BrowserContext, Page } from "playwright-core";

/** A private page, in a context agents cannot discover, that lends a screenshot Chromium's codecs. */
export class ChromiumViewportImage {
  readonly #browser: Browser;
  #closed = false;
  #pending: Promise<{ context: BrowserContext; page: Page }> | undefined;

  constructor(browser: Browser) {
    this.#browser = browser;
  }

  async #create() {
    const context = await this.#browser.newContext();
    try {
      return { context, page: await context.newPage() };
    } catch (error) {
      await context.close();
      throw error;
    }
  }

  async run(script: string): Promise<string> {
    if (this.#closed) throw new Error("The screenshot helper is closed.");
    const { page } = await (this.#pending ??= this.#create());
    return page.evaluate<string>(script);
  }

  async close(): Promise<void> {
    this.#closed = true;
    const helper = await this.#pending?.catch(() => undefined);
    await helper?.context.close();
  }
}
