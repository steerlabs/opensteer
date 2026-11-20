import { refused } from "@opensteer/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computerReplLimits as limits } from "../computer-use/computer-repl/messages.js";
import {
  BrowserReplService,
  type BrowserUseCall,
  type BrowserUseEvent,
  type BrowserUsePort,
} from "./browser-repl-service.js";

const root = { tabId: "tab-root", targetId: "target-root", sessionId: "cdp-root" };
const other = { tabId: "tab-other", targetId: "target-other", sessionId: "cdp-other" };
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=";

const services: BrowserReplService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

function setup(
  overrides: Partial<BrowserUsePort> = {},
  clock?: ConstructorParameters<typeof BrowserReplService>[0]["clock"],
) {
  const subscribers = new Set<(event: BrowserUseEvent) => void>();
  const port = {
    listPages: vi.fn(async () => [
      { tabId: root.tabId, url: "https://example.test/", title: "Root", profile: "Personal" },
    ]),
    openPage: vi.fn(async (tabId: string) => {
      if (tabId !== root.tabId)
        throw refused("forbidden", "Profile access ended.", "Ask the owner.");
      return root;
    }),
    newPage: vi.fn(async () => other),
    command: vi.fn(async () => ({})),
    subscribe: vi.fn((_target, listener: (event: BrowserUseEvent) => void) => {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    }),
    ...overrides,
  } satisfies BrowserUsePort;
  const service = new BrowserReplService({ port, ...(clock ? { clock } : {}) });
  services.push(service);
  return {
    service,
    port,
    subscribers,
    emit: (event: BrowserUseEvent) => {
      for (const subscriber of subscribers) subscriber(event);
    },
    run: (code: string, signal?: AbortSignal) => service.execute("context", code, signal),
  };
}

const bind = 'globalThis.page = await openPage("tab-root");';
const text = (value: unknown) => ({ type: "text", text: JSON.stringify(value) });

describe("browser REPL", () => {
  it("lists, binds and opens pages with a persistent Page API and no ambient authority", async () => {
    const command = vi.fn<BrowserUsePort["command"]>(async (_target, method) => ({ method }));
    const { service, run, port, subscribers } = setup({ command });
    const result = await run(`
      print((await pages())[0]);
      ${bind}
      globalThis.popup = await newPage("https://example.test/next", { profileId: "profile1" });
      globalThis.locator = page.getByRole("textbox", { name: "Name" });
      return [page.tabId, popup.tabId, typeof locator.fill,
        typeof process, typeof require, typeof fetch, typeof WebSocket, typeof __computerCall];
    `);
    expect(result.content).toEqual([
      text({ tabId: root.tabId, title: "Root", url: "https://example.test/", profile: "Personal" }),
      text([root.tabId, other.tabId, "function", ...Array<string>(5).fill("undefined")]),
    ]);
    expect(port.newPage).toHaveBeenCalledWith(
      { url: "https://example.test/next", profileId: "profile1" },
      { contextKey: "context", signal: expect.any(AbortSignal), deadline: expect.any(Number) },
    );
    expect(
      await run('await sleep(0); return await page.cdp("Runtime.evaluate", { expression: "1" })'),
    ).toEqual({
      content: [text({ method: "Runtime.evaluate" })],
    });
    expect(command).toHaveBeenCalledWith(
      root,
      "Runtime.evaluate",
      { expression: "1" },
      root.sessionId,
      expect.any(Object),
    );
    expect(
      await service.execute("other-context", "return [typeof page, typeof popup, typeof locator]"),
    ).toEqual({
      content: [text(["undefined", "undefined", "undefined"])],
    });
    service.disposeContext("context");
    expect(subscribers.size).toBe(0);
    expect(await run("return typeof page")).toEqual({ content: [text("undefined")] });
  });

  it("delivers idle CDP events to the same handle for synchronous draining", async () => {
    const { run, emit } = setup();
    expect(await run(bind)).toEqual({ content: [] });
    const event = {
      method: "Log.entryAdded",
      params: { text: "logged" },
      sessionId: root.sessionId,
    };
    emit(event);
    expect(await run("return page.drainEvents()")).toEqual({ content: [text([event])] });
    expect(await run("return page.drainEvents()")).toEqual({ content: [text([])] });
  });

  it("delivers a dialog while its input is still in flight and uses the observed ID", async () => {
    const blocked = Promise.withResolvers<object>();
    let openDialog: () => void;
    const command = vi.fn<BrowserUsePort["command"]>(async (_target, method, params) => {
      if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
        openDialog();
        return blocked.promise;
      }
      if (method === "Page.handleJavaScriptDialog") blocked.resolve({});
      return {};
    });
    const { run, emit } = setup({ command });
    openDialog = () =>
      emit({
        method: "Page.javascriptDialogOpening",
        params: { dialogId: "dialog-1", type: "confirm", message: "Proceed?" },
        sessionId: root.sessionId,
      });
    expect(
      (
        await run(`
      ${bind}
      try { await page.mouse.click(5, 5); }
      catch (error) {
        print(error.dialog);
        await page.respondDialog({ accept: true });
      }
      const [event] = page.drainEvents();
      return event.params.dialogId;
    `)
      ).content,
    ).toEqual([text({ id: "dialog-1", type: "confirm", message: "Proceed?" }), text("dialog-1")]);
    expect(
      command.mock.calls
        .filter(
          ([, method]) =>
            method === "Input.dispatchMouseEvent" || method === "Page.handleJavaScriptDialog",
        )
        .map(([, method, params]) => params?.type ?? method),
    ).toEqual(["mouseMoved", "mousePressed", "mouseReleased", "Page.handleJavaScriptDialog"]);
    expect(command).toHaveBeenCalledWith(
      root,
      "Page.handleJavaScriptDialog",
      {
        accept: true,
        dialogId: "dialog-1",
      },
      root.sessionId,
      expect.any(Object),
    );
  });

  it("keeps structured refusals catchable through CDP and Page operations", async () => {
    const { run } = setup({
      command: async (target, method) => {
        if (method === "Runtime.releaseObjectGroup") return {};
        throw {
          code: "profile-revoked",
          message: `${target.tabId} was revoked.`,
          next: "Ask the owner.",
        };
      },
    });
    expect(
      await run(`
      try { await openPage("foreign"); }
      catch (error) { return [error instanceof Error, error.code, error.message, error.next]; }
    `),
    ).toEqual({
      content: [text([true, "forbidden", "Profile access ended.", "Ask the owner."])],
    });
    expect(await run(`${bind} await page.title()`)).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "profile-revoked",
          message: expect.stringContaining("tab-root was revoked."),
          next: "Ask the owner.",
          performed: [],
        },
      },
    });
    expect(
      await run('try { await page.cdp("Runtime.evaluate"); } catch (error) { return error.code; }'),
    ).toEqual({
      content: [text("profile-revoked")],
    });
  });

  it("uses the shared wall deadline and frees a context even if the port has not replied", async () => {
    const entered = Promise.withResolvers<BrowserUseCall>();
    const withheld = Promise.withResolvers<readonly []>();
    const schedule = vi.fn((_callback: () => void) => () => undefined);
    const { service, run } = setup(
      {
        listPages: (call) => {
          entered.resolve(call);
          return withheld.promise;
        },
      },
      { now: Date.now, schedule },
    );
    const running = run("globalThis.saved = 7; await pages()");
    const { signal } = await entered.promise;
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 100_000);
    expect(await service.execute("other", "return 9")).toEqual({ content: [text(9)] });
    schedule.mock.calls[0]![0]();
    expect(await running).toMatchObject({ structuredContent: { error: { code: "deadline" } } });
    expect(signal.aborted).toBe(true);
    expect(await run("return typeof saved")).toEqual({ content: [text("undefined")] });
    withheld.resolve([]);
  });

  it("cancels a pending command, clears timers and subscriptions, and ignores its late result", async () => {
    const entered = Promise.withResolvers<BrowserUseCall>();
    const withheld = Promise.withResolvers<object>();
    const { run, subscribers } = setup({
      command: (_target, _method, _params, _sessionId, call) => {
        entered.resolve(call);
        return withheld.promise;
      },
    });
    const controller = new AbortController();
    const result = run(
      `
      ${bind}
      setTimeout(() => { throw new Error("stale timer"); }, 100000);
      await page.cdp("Input.insertText", { text: "a" });
      globalThis.late = true;
    `,
      controller.signal,
    );
    const call = await entered.promise;
    controller.abort();
    expect(await result).toMatchObject({
      structuredContent: { error: { code: "outcome-unknown" } },
    });
    expect(call.signal.aborted).toBe(true);
    expect(subscribers.size).toBe(0);
    withheld.resolve({});
    expect(await run("return [typeof page, typeof late]")).toEqual({
      content: [text(["undefined", "undefined"])],
    });
  });

  it("interrupts guest CPU starvation and counts text, decoded image bytes and image count", async () => {
    const oversizedBridge = "x".repeat(limits.bridgeBytes + 1);
    const screenshot = vi
      .fn()
      .mockResolvedValueOnce({ data: png })
      .mockResolvedValue({
        data: Buffer.alloc(limits.imageBytes / 2 + 3).toString("base64"),
      });
    const { run } = setup({
      command: async (_target, method) =>
        method === "Page.captureScreenshot" ? screenshot() : { oversizedBridge },
    });
    expect(await run("throw { get message() { while (true) {} } }")).toMatchObject({
      structuredContent: { error: { code: "slice-limit" } },
    });
    expect(await run("return 'x'.repeat(512 * 1024)")).toMatchObject({
      structuredContent: { error: { code: "output-limit" } },
    });
    expect(await run(`${bind} await page.cdp("Runtime.evaluate")`)).toMatchObject({
      structuredContent: { error: { code: "bridge-limit" } },
    });
    expect(await run("return await page.screenshot()")).toEqual({
      content: [
        {
          type: "image",
          mimeType: "image/png",
          data: png,
          _meta: { "codex/imageDetail": "original" },
        },
        text({ mimeType: "image/png" }),
      ],
    });
    expect(
      await run("await page.captureScreenshot(); await page.captureScreenshot();"),
    ).toMatchObject({
      structuredContent: { error: { code: "output-limit" } },
    });
    const many = await run(`for (let i = 0; i < 9; i++) await printImage(${JSON.stringify(png)});`);
    expect(many.structuredContent?.error.code).toBe("output-limit");
    expect(many.content.filter((block) => block.type === "image")).toHaveLength(limits.images);
  });
});
