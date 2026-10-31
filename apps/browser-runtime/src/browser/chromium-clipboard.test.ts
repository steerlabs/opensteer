import type { BrowserPage } from "@opensteer/browser-runtime-core";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findChromium } from "./browser-test-lifecycle.js";
import { ChromiumClipboard } from "./chromium-clipboard.js";

it("does no clipboard work until first use and joins initialization on close", async () => {
  const ready = Promise.withResolvers<ChromiumClipboard>();
  const create = vi.spyOn(ChromiumClipboard, "create").mockReturnValue(ready.promise);
  const scope = { close: vi.fn(async () => null) };
  const owner = { open: vi.fn(async () => scope), close: vi.fn(async () => {}) };
  try {
    const clipboard = ChromiumClipboard.lazy({} as Browser);
    expect(create).not.toHaveBeenCalled();
    const opening = clipboard.open({} as BrowserPage, null);
    const closing = clipboard.close();
    expect(create).toHaveBeenCalledOnce();
    expect(owner.close).not.toHaveBeenCalled();
    ready.resolve(owner as unknown as ChromiumClipboard);
    await expect(opening).rejects.toThrow(/closed/);
    await closing;
    expect(owner.close).toHaveBeenCalledOnce();
    await expect(clipboard.open({} as BrowserPage, null)).rejects.toThrow(/closed/);
  } finally {
    create.mockRestore();
  }
});

it("clears an installed clipboard when opening the scope fails and permits the next scope", async () => {
  const page = {} as BrowserPage;
  const writes: unknown[] = [];
  let oversized = true;
  const context = {
    route: vi.fn(async () => {}),
    newPage: async () => ({
      goto: async () => {},
      evaluate: async (_source: unknown, data: unknown) => {
        // Reads and fingerprints carry the bound; writes carry their items.
        if (typeof data === "number" || (typeof data === "object" && data && "maximum" in data))
          return oversized ? null : [];
        writes.push(data);
        return undefined;
      },
    }),
    close: vi.fn(async () => {}),
  };
  const clipboard = await ChromiumClipboard.create({
    newContext: async () => context,
  } as unknown as Browser);
  try {
    await expect(
      clipboard.open(page, [{ type: "text/plain", bytes: Buffer.from("person data") }]),
    ).rejects.toThrow("Clipboard data exceeds its bound.");
    expect(writes).toEqual([
      [],
      [{ type: "text/plain", data: Buffer.from("person data").toString("base64") }],
      [],
    ]);
    oversized = false;
    const scope = await clipboard.open(page, null);
    await expect(scope.close()).resolves.toBeNull();
    expect(writes.at(-1)).toEqual([]);
  } finally {
    await clipboard.close();
  }
});

describe.skipIf(process.platform === "win32")("ChromiumClipboard in headless Chromium", () => {
  // The largest answer each private-page evaluation brought back to Node.
  const answers: number[] = [];
  let browser: Browser;
  let clipboard: ChromiumClipboard;
  let person: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: findChromium(), headless: true });
    const measured = new Proxy(browser, {
      get(target, property, receiver) {
        if (property !== "newContext") return Reflect.get(target, property, receiver);
        return async (...options: Parameters<Browser["newContext"]>) => {
          const context = await target.newContext(...options);
          const newPage = context.newPage.bind(context);
          context.newPage = async () => {
            const page = await newPage();
            const evaluate = page.evaluate.bind(page);
            page.evaluate = (async (...argumentList: Parameters<Page["evaluate"]>) => {
              const answer: unknown = await evaluate(...argumentList);
              answers.push(JSON.stringify(answer ?? null).length);
              return answer;
            }) as Page["evaluate"];
            return page;
          };
          return context;
        };
      },
    });
    clipboard = await ChromiumClipboard.create(measured);
    const context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
    });
    await context.route("**/*", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Person</title>" }),
    );
    person = await context.newPage();
    await person.goto("http://person.localhost/");
  });

  afterAll(async () => {
    await clipboard?.close();
    await browser?.close();
  });

  it("closes a scope its page left alone without reading the payload back", async () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024, "opensteer ");
    answers.length = 0;
    const scope = await clipboard.open({} as BrowserPage, [{ type: "text/plain", bytes }]);
    await expect(scope.close()).resolves.toBeNull();
    expect(Math.max(...answers)).toBeLessThan(4096);
  });

  it("returns a page's own write even at the same type and size", async () => {
    const scope = await clipboard.open({} as BrowserPage, [
      { type: "text/plain", bytes: Buffer.from("before") },
    ]);
    await person.evaluate(() => navigator.clipboard.writeText("after!"));
    const written = await scope.close();
    expect(written?.map((item) => [item.type, Buffer.from(item.bytes).toString("utf8")])).toEqual([
      ["text/plain", "after!"],
    ]);
  });

  it("installs exactly the bytes it was given", async () => {
    const text = "plain ünïcödé 日本語 🙂🧪\u0000end";
    const scope = await clipboard.open({} as BrowserPage, [
      { type: "text/plain", bytes: Buffer.from(text) },
    ]);
    try {
      await expect(person.evaluate(() => navigator.clipboard.readText())).resolves.toBe(text);
    } finally {
      await scope.close();
    }
    const empty = await clipboard.open({} as BrowserPage, [
      { type: "text/plain", bytes: Buffer.alloc(0) },
    ]);
    try {
      await expect(person.evaluate(() => navigator.clipboard.readText())).resolves.toBe("");
    } finally {
      await empty.close();
    }
  });
});
