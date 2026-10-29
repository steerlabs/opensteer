import { EventEmitter } from "node:events";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserServer,
  type CDPSession,
  type Page,
} from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { validClaims } from "@opensteer/browser-runtime-core/test-support";
import { TestChromiumLauncher } from "./browser-test-lifecycle.js";
import { PlaywrightChromiumLauncher } from "./playwright-launcher.js";

const request = {
  initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
  partitionKey: `session:${validClaims().sessionId}` as const,
  sessionId: validClaims().sessionId,
  snapshot: { cookies: [], origins: [] },
};
const options = { chromiumSandbox: false, executablePath: process.execPath, headless: true };

vi.mock("./chromium-clipboard.js", () => ({
  ChromiumClipboard: {
    create: async () => ({
      machineClipboardShared: false,
      open: async () => ({ close: async () => null }),
      close: async () => {},
    }),
  },
}));

function fixture() {
  const cdp = Object.assign(new EventEmitter(), {
    send: vi.fn(async (method: string) =>
      method === "Target.getBrowserContexts" ? { browserContextIds: ["owned"] } : {},
    ),
    detach: vi.fn(() => new Promise<void>(() => {})),
  });
  const page = new EventEmitter() as unknown as Page;
  const context = Object.assign(new EventEmitter(), {
    addInitScript: vi.fn(async () => {}),
    pages: () => [page],
    newPage: vi.fn(async () => page),
    newCDPSession: vi.fn(async () => cdp as unknown as CDPSession),
  });
  const browser = {
    newContext: vi.fn(async () => context as unknown as BrowserContext),
    newBrowserCDPSession: vi.fn(async () => cdp as unknown as CDPSession),
  } as unknown as Browser;
  const kill = vi.fn(async () => {});
  const server = { kill, wsEndpoint: () => "ws://127.0.0.1/fake" } as unknown as BrowserServer;
  vi.spyOn(chromium, "launchServer").mockResolvedValue(server);
  vi.spyOn(chromium, "connect").mockResolvedValue(browser);
  return { cdp, browser, context, kill, server };
}

it("disposes only its own direct CDP subscriptions before remote detach settles", async () => {
  const fake = fixture();
  const launched = await new PlaywrightChromiumLauncher(options).launch(request);
  try {
    const raw = await launched.context.pages()[0]!.cdp();
    const listener = vi.fn();
    const external = vi.fn();
    fake.cdp.on("Page.loadEventFired", external);
    raw.on("Page.loadEventFired", listener);
    raw.on("Page.loadEventFired", listener);
    fake.cdp.emit("Page.loadEventFired", {});
    expect(listener).toHaveBeenCalledOnce();
    raw.off("Page.loadEventFired", external);
    await raw.close();
    fake.cdp.emit("Page.loadEventFired", {});
    expect(listener).toHaveBeenCalledOnce();
    expect(external).toHaveBeenCalledTimes(2);
    expect(fake.cdp.listeners("Page.loadEventFired")).toEqual([external]);
    expect(() => raw.on("Page.loadEventFired", listener)).toThrow(/closed/);
    expect(() => raw.on("Page.javascriptDialogOpening", listener)).toThrow(/closed/);
    expect(() => raw.onEvent(() => {})).toThrow(/closed/);
  } finally {
    await launched.close();
  }
});

describe.each(["acquisition", "connect", "context", "init-script", "page", "cdp"])(
  "timeout during %s",
  (stage) => {
    let fake: ReturnType<typeof fixture>;
    let release: () => void;
    let pending: Promise<unknown>;
    it.fails("aborts setup through the test signal", { timeout: 250 }, async () => {
      fake = fixture();
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (stage === "acquisition")
        vi.mocked(chromium.launchServer).mockImplementation(async () => {
          await gate;
          return fake.server;
        });
      if (stage === "connect")
        vi.mocked(chromium.connect).mockImplementation(async () => {
          await gate;
          return fake.browser;
        });
      if (stage === "context")
        vi.mocked(fake.browser.newContext).mockImplementation(async () => {
          await gate;
          return fake.context as unknown as BrowserContext;
        });
      if (stage === "init-script")
        fake.context.addInitScript.mockImplementation(async () => {
          await gate;
        });
      if (stage === "page") {
        fake.context.pages = () => [];
        fake.context.newPage.mockImplementation(async () => {
          await gate;
          return new EventEmitter() as unknown as Page;
        });
      }
      if (stage === "cdp")
        fake.cdp.send.mockImplementation(async () => {
          await gate;
          return { browserContextIds: ["owned"] };
        });
      pending = new TestChromiumLauncher(options).launch(request);
      void pending.catch(() => undefined);
      await pending;
    });
    it("kills the acquired server before the next test releases setup", async () => {
      try {
        expect(fake.kill).toHaveBeenCalledTimes(stage === "acquisition" ? 0 : 1);
      } finally {
        release();
        await expect(pending).rejects.toThrow();
      }
      expect(fake.kill).toHaveBeenCalledOnce();
    });
  },
);
