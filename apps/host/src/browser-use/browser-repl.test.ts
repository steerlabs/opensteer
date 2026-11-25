import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { OpensteerError, createId, refused } from "@opensteer/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationOutcomeUnknown } from "../agent-sessions/agent-session-service.js";
import {
  computerReplLimits as limits,
  FromWorkerSchema,
  type FromWorker,
  type ToWorker,
} from "../computer-use/computer-repl/messages.js";
import { browserReplLimits } from "./browser-repl-messages.js";
import {
  BrowserReplService,
  BrowserUseCdpError,
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
  workerEntry?: URL,
) {
  const subscribers = new Set<(event: BrowserUseEvent) => void>();
  const closures = new Set<() => void>();
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
    command: vi.fn(async () => "{}"),
    subscribe: vi.fn<BrowserUsePort["subscribe"]>((_target, listener, onEnd) => {
      subscribers.add(listener);
      closures.add(onEnd);
      return () => {
        subscribers.delete(listener);
        closures.delete(onEnd);
      };
    }),
    ...overrides,
  } satisfies BrowserUsePort;
  const service = new BrowserReplService({
    port,
    ...(clock ? { clock } : {}),
    ...(workerEntry ? { workerEntry } : {}),
  });
  services.push(service);
  return {
    service,
    port,
    subscribers,
    end: () => {
      for (const close of closures) close();
    },
    emit: ({
      method,
      params,
      sessionId,
    }: {
      method: string;
      params: unknown;
      sessionId?: string;
    }) => {
      for (const subscriber of subscribers)
        subscriber({
          method,
          paramsJson: JSON.stringify(params),
          ...(sessionId === undefined ? {} : { sessionId }),
        });
    },
    run: (code: string, signal?: AbortSignal) => service.execute("context", code, signal),
  };
}

const bind = 'globalThis.page = await openPage("tab-root");';
const text = (value: unknown) => ({ type: "text", text: JSON.stringify(value) });

describe("browser REPL", () => {
  it("rechecks authority before a command on an already bound page", async () => {
    const { service, run, port } = setup();
    await run(bind);
    const recheck = vi.fn(async () => {
      throw new OperationOutcomeUnknown("Access changed.");
    });
    expect(
      await service.execute("context", "await page.close()", undefined, undefined, recheck),
    ).toMatchObject({ isError: true, structuredContent: { error: { code: "outcome-unknown" } } });
    expect(recheck).toHaveBeenCalledOnce();
    expect(port.command).not.toHaveBeenCalled();
  });

  it("rebinds only a witnessed cached page handle and uses the replacement channel", async () => {
    const witnessed = { ...root, pooledWitness: "same-profile-tab-generation-and-document" };
    const replacement = { ...witnessed, targetId: "new-target", sessionId: "new-channel" };
    const rebind = vi.fn<NonNullable<BrowserUsePort["rebind"]>>(async () => replacement);
    const { service, port, end } = setup({ openPage: async () => witnessed, rebind });
    const browserSend = {
      target: {
        runnerId: createId("runner"),
        runtimeId: "pool-runtime",
        instanceId: "pool-instance",
        slotId: "slot",
        term: 1,
        epoch: 2,
      },
      recheck: async () => {},
      submitted: () => {},
      acknowledged: () => {},
    };
    const run = (code: string) =>
      service.execute("context", code, undefined, undefined, undefined, browserSend);
    expect((await run(bind)).isError).not.toBe(true);
    end();
    expect((await run('await page.js("document.title")')).isError).not.toBe(true);
    expect(rebind).toHaveBeenCalledExactlyOnceWith(
      witnessed,
      expect.objectContaining({ browserSend }),
    );
    expect(port.command).toHaveBeenCalledWith(
      replacement,
      "Runtime.evaluate",
      expect.anything(),
      replacement.sessionId,
      expect.anything(),
    );

    end();
    rebind.mockResolvedValue({ ...replacement, pooledWitness: "different-document" });
    expect(await run('await page.js("document.title")')).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "page-ended" } },
    });
    expect(port.command).toHaveBeenCalledOnce();
  });

  it("prints the browser API without touching a page, and closes a bound page", async () => {
    const { run, port } = setup();
    const result = await run("help()");
    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringMatching(/newPage.*close\(\).*waitForNetworkIdle.*getAttribute/su),
      },
    ]);
    expect(port.openPage).not.toHaveBeenCalled();
    expect(port.command).not.toHaveBeenCalled();
    await run(`${bind} await page.close()`);
    expect(port.command).toHaveBeenCalledWith(
      expect.anything(),
      "Target.closeTarget",
      { targetId: root.targetId },
      undefined,
      expect.anything(),
    );
  });

  it("lists, binds and opens pages with a persistent Page API and no ambient authority", async () => {
    const command = vi.fn<BrowserUsePort["command"]>(async (_target, method) =>
      JSON.stringify({ method }),
    );
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
      {
        contextKey: "context",
        signal: expect.any(AbortSignal),
        deadline: expect.any(Number),
        maxBytes: limits.bridgeBytes,
        maxDepth: 31,
        maxEntries: browserReplLimits.jsonEntries,
      },
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
    const blocked = Promise.withResolvers<string>();
    let openDialog: () => void;
    const command = vi.fn<BrowserUsePort["command"]>(async (_target, method, params) => {
      if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
        openDialog();
        return blocked.promise;
      }
      if (method === "Page.handleJavaScriptDialog") blocked.resolve("{}");
      return "{}";
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
        if (method === "Runtime.releaseObjectGroup") return "{}";
        throw refused("forbidden", `${target.tabId} was revoked.`, "Ask the owner.");
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
          code: "forbidden",
          message: expect.stringContaining("tab-root was revoked."),
          next: "Ask the owner.",
          performed: [],
        },
      },
    });
    expect(
      await run('try { await page.cdp("Runtime.evaluate"); } catch (error) { return error.code; }'),
    ).toEqual({
      content: [text("forbidden")],
    });
  });

  it("reports lost browser confirmation even if the script catches it", async () => {
    const { run } = setup({
      command: async () => {
        throw new OpensteerError({
          code: "conflict",
          reason: "outcome-unknown",
          message: "Private backend failure text.",
        });
      },
    });
    expect(
      await run(`${bind}
      try { await page.cdp("Runtime.evaluate"); }
      catch (error) { print(error.code, error.message); }
      return "done";`),
    ).toMatchObject({
      content: expect.arrayContaining([
        {
          type: "text",
          text: "outcome-unknown A browser action did not confirm its outcome. Observe the page before trying again.",
        },
      ]),
      isError: true,
      structuredContent: { error: { code: "outcome-unknown" } },
    });
  });

  it("keeps an effect uncertain when the browser cannot return its reply", async () => {
    let dispatched = false;
    const { run } = setup({
      command: async () => {
        dispatched = true;
        throw new OpensteerError({
          code: "bad_request",
          reason: "browser-reply-limit",
          message: "Browser result exceeds its byte or nesting limit.",
        });
      },
    });
    const result = await run(`${bind} await page.cdp("Runtime.evaluate");`);
    expect(dispatched).toBe(true);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "outcome-unknown" } },
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
    const withheld = Promise.withResolvers<string>();
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
    withheld.resolve("{}");
    expect(await run("return [typeof page, typeof late]")).toEqual({
      content: [text(["undefined", "undefined"])],
    });
  });

  it("reports abandoned reads and effects, retaining reservations until the port completes", async () => {
    const read = Promise.withResolvers<readonly []>();
    const reads: BrowserUseCall[] = [];
    const effects: BrowserUseCall[] = [];
    const effect = Promise.withResolvers<string>();
    const { run, service } = setup({
      listPages: (call) => {
        reads.push(call);
        return read.promise;
      },
      command: (_target, _method, _params, _session, call) => {
        effects.push(call);
        return effect.promise;
      },
    });
    const abandon = "for (let i = 0; i < 32; i++) void pages().catch(() => {}); return 1;";
    expect(await run(abandon)).toMatchObject({
      structuredContent: { error: { code: "operation-pending" } },
    });
    expect(reads).toHaveLength(browserReplLimits.pending);
    expect(reads.every(({ signal }) => signal.aborted)).toBe(true);
    expect(await run("await pages()")).toMatchObject({
      structuredContent: { error: { code: "bridge-limit" } },
    });
    expect(reads).toHaveLength(browserReplLimits.pending);
    service.disposeContext("context");
    expect(await run("await pages()")).toMatchObject({
      structuredContent: { error: { code: "bridge-limit" } },
    });
    expect(reads).toHaveLength(browserReplLimits.pending);
    read.resolve([]);
    expect(await run("return await pages()")).toEqual({ content: [text([])] });
    expect(
      await run(`${bind} void page.cdp("Input.insertText", { text: "one" }); return 1;`),
    ).toMatchObject({
      structuredContent: { error: { code: "outcome-unknown" } },
    });
    expect(effects).toHaveLength(1);
    expect(effects[0]?.signal.aborted).toBe(true);
    expect(await service.execute("different", "return 2")).toEqual({ content: [text(2)] });
    effect.resolve("{}");
    expect(await run('return await page.cdp("Runtime.evaluate")')).toEqual({ content: [text({})] });
  });

  it("reserves part of the unsettled operation budget for other browser bindings", async () => {
    const hold = Promise.withResolvers<readonly []>();
    const listPages = vi.fn<BrowserUsePort["listPages"]>((call) =>
      call.contextKey === "independent" ? Promise.resolve([]) : hold.promise,
    );
    const { service } = setup({ listPages });
    try {
      const abandon = "for (let i = 0; i < 32; i++) void pages().catch(() => {});";
      for (let n = 0; n < 4; n++)
        await service.execute(`context-${n}`, abandon, undefined, "first-binding");
      expect(listPages).toHaveBeenCalledTimes(browserReplLimits.bindingPending);
      expect(
        await service.execute("independent", "return await pages()", undefined, "second-binding"),
      ).toEqual({ content: [text([])] });
    } finally {
      hold.resolve([]);
    }
  });

  it("does not turn a caught lost browser reply into success", async () => {
    const { run } = setup({
      command: async () => {
        throw new OpensteerError({
          code: "conflict",
          reason: "outcome-unknown",
          message: "Browser reply was lost.",
        });
      },
    });
    expect(
      await run(
        `${bind} try { await page.cdp("Runtime.evaluate"); } catch (error) { print(error.code); } return "caught";`,
      ),
    ).toMatchObject({ isError: true, structuredContent: { error: { code: "outcome-unknown" } } });
  });

  it("lets a port acknowledge cancellation without accumulating old reservations", async () => {
    const released = vi.fn();
    const { run } = setup({
      listPages: ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              released();
              resolve([]);
            },
            { once: true },
          );
        }),
    });
    const abandon = "for (let i = 0; i < 32; i++) void pages().catch(() => {}); return 1;";
    for (let i = 0; i < 2; i++)
      expect(await run(abandon)).toMatchObject({
        structuredContent: { error: { code: "operation-pending" } },
      });
    expect(released).toHaveBeenCalledTimes(64);
  });

  it("enforces cumulative bridge request count, byte size, and depth before invoking the port", async () => {
    const count = vi.fn<BrowserUsePort["listPages"]>(async () => []);
    const { run, port } = setup({ listPages: count });
    expect(
      await run(`for (let i = 0; i <= ${browserReplLimits.requests}; i++) await pages()`),
    ).toMatchObject({
      structuredContent: {
        error: { code: "bridge-limit", message: expect.stringContaining("count") },
      },
    });
    expect(count).toHaveBeenCalledTimes(browserReplLimits.requests);
    expect(
      await run(`${bind} const payload = "x".repeat(500_000);
      for (let i = 0; i < 9; i++) await page.cdp("Runtime.evaluate", { payload });`),
    ).toMatchObject({
      structuredContent: {
        error: { code: "bridge-limit", message: expect.stringContaining("byte") },
      },
    });
    expect(port.command).toHaveBeenCalledTimes(8);
    expect(
      await run(`let nested = null;
      for (let i = 0; i < 300; i++) nested = [nested];
      await page.cdp("Runtime.evaluate", { nested });`),
    ).toMatchObject({
      structuredContent: {
        error: { code: "bridge-limit", message: expect.stringContaining("nesting") },
      },
    });
    expect(
      await run('await page.cdp("Runtime.evaluate", { value: "é".repeat(600_000) })'),
    ).toMatchObject({
      structuredContent: {
        error: { code: "bridge-limit", message: expect.stringContaining("byte") },
      },
    });
    expect(port.command).toHaveBeenCalledTimes(8);
  });

  // Each value is built before an await, so the slice that sends the request
  // spends only the guest library's serialization of it. A slow worker's CPU
  // counts four times, as on a machine four times slower than this one.
  it.each([
    ["", undefined],
    [
      " on a slow worker",
      new URL(
        "../computer-use/computer-repl/computer-repl-worker.slow.test-support.ts",
        import.meta.url,
      ),
    ],
  ])(
    "measures a request on the Host, so one inside the byte limit is never refused for CPU%s",
    async (_, workerEntry) => {
      const { run, port } = setup({}, undefined, workerEntry);
      expect(
        await run(`${bind} const payload = "x".repeat(1_000_000); await 0;
      await page.cdp("Runtime.evaluate", { payload }); return "sent";`),
      ).toEqual({ content: [text("sent")] });
      expect(port.command).toHaveBeenCalledOnce();
      expect(JSON.stringify(vi.mocked(port.command).mock.calls[0])).toContain(
        "x".repeat(1_000_000),
      );
      for (const code of [
        // Over the limit in UTF-8 bytes, under it in UTF-16 units: measured exactly.
        `${bind} const value = "é".repeat(600_000); await 0;
      await page.cdp("Runtime.evaluate", { value });`,
        // Over the limit in units on its own (the request's other fields only add
        // to it): refused by its length before the Host copies it.
        `${bind} const value = "x".repeat(${limits.bridgeBytes + 1}); await 0;
      await page.cdp("Runtime.evaluate", { value });`,
      ]) {
        const refused = await run(code);
        expect(refused).toMatchObject({
          structuredContent: {
            error: { code: "bridge-limit", message: expect.stringContaining("byte") },
          },
        });
        expect(JSON.stringify(refused)).not.toContain("slice-limit");
      }
      expect(port.command).toHaveBeenCalledOnce();
    },
  );

  it.each([
    // The guest library captured JSON.stringify before any script ran.
    [
      "a request",
      `JSON.stringify = () => hostile; ${bind} await page.cdp("Runtime.evaluate"); return "sent";`,
      { content: [text("sent")] },
    ],
    ["a returned value", "JSON.stringify = () => hostile; return 1", { content: [text(1)] }],
    [
      "printed text",
      "Array.prototype.join = () => hostile; print('a')",
      {
        structuredContent: {
          error: { code: "output-limit", message: "Browser output exceeded its byte limit." },
        },
      },
    ],
  ])(
    "never runs a replaced JSON.stringify or join's result's toString for %s",
    async (_place, code, expected) => {
      const { run } = setup();
      // Coercing this would run guest code that builds a string until a limit stops it.
      const hostile =
        'const hostile = { toString() { let text = ""; for (;;) text += "x".repeat(1024); } };';
      expect(await run(`${hostile} ${code}`)).toMatchObject(expected);
    },
  );

  it("reserves capture slots and producer credit before dispatch", async () => {
    const held = Promise.withResolvers<string>();
    const captures = vi.fn<BrowserUsePort["command"]>(() => held.promise);
    const { run } = setup({ command: captures });
    try {
      const result = await run(`
        ${bind}
        const first = page.screenshot().catch(() => {});
        const second = page.screenshot().catch(() => {});
        try { await page.screenshot(); } catch (error) { print(error.code); }
      `);
      expect(result).toMatchObject({
        content: expect.arrayContaining([{ type: "text", text: "output-limit" }]),
        structuredContent: { error: { code: "outcome-unknown" } },
      });
      expect(captures).toHaveBeenCalledTimes(2);
      for (const [, method, , , call] of captures.mock.calls) {
        expect(method).toBe("Page.captureScreenshot");
        expect(call).toMatchObject({
          maxBytes: browserReplLimits.screenshotReplyBytes,
          maxImageBytes: browserReplLimits.screenshotBytes,
        });
      }
    } finally {
      held.resolve(JSON.stringify({ data: png }));
    }
  });

  it("keeps a pending capture's image slot reserved against printImage", async () => {
    const held = Promise.withResolvers<string>();
    const entered = Promise.withResolvers<void>();
    const { run } = setup({
      command: () => held.promise,
      listPages: async () => {
        entered.resolve();
        return [];
      },
    });
    try {
      const result = run(`
        ${bind}
        const screenshot = page.screenshot();
        for (let i = 0; i < ${limits.images}; i++) {
          try { await printImage(${JSON.stringify(png)}); }
          catch (error) { print(error.code); }
        }
        await pages();
        await screenshot;
        return "done";
      `);
      await Promise.race([
        entered.promise,
        result.then((reply) => {
          throw new Error(JSON.stringify(reply));
        }),
      ]);
      held.resolve(JSON.stringify({ data: png }));
      const reply = await result;
      expect(reply.isError).toBeUndefined();
      expect(reply.content.filter((block) => block.type === "image")).toHaveLength(limits.images);
      expect(reply.content).toEqual(
        expect.arrayContaining([{ type: "text", text: "output-limit" }, text("done")]),
      );
    } finally {
      held.resolve(JSON.stringify({ data: png }));
    }
  });

  it("passes only the remaining aggregate reply bytes to the producer", async () => {
    const command = vi.fn<BrowserUsePort["command"]>(async (_target, _method, _args, _id, call) =>
      JSON.stringify("x".repeat(call.maxBytes - 2)),
    );
    const { run } = setup({ command });
    const fullReplies = browserReplLimits.replyBytes / limits.bridgeBytes;
    expect(
      await run(`
      ${bind}
      for (let i = 0; i <= ${fullReplies}; i++) await page.cdp("Runtime.evaluate");
    `),
    ).toMatchObject({ structuredContent: { error: { code: "bridge-limit" } } });
    expect(command).toHaveBeenCalledTimes(fullReplies);
    const budgets = command.mock.calls.map(([, , , , call]) => call.maxBytes);
    expect(budgets.slice(0, -1)).toEqual(Array<number>(fullReplies - 1).fill(limits.bridgeBytes));
    expect(budgets.at(-1)).toBeLessThan(limits.bridgeBytes);
    expect(budgets.reduce((total, bytes) => total + bytes, 0)).toBeLessThan(
      browserReplLimits.replyBytes,
    );
  });

  it("preflights port frame budgets and keeps oversized output isolated to its context", async () => {
    const deep = "[".repeat(5000) + "0" + "]".repeat(5000);
    const command = vi.fn<BrowserUsePort["command"]>(async () => deep);
    const { run, service, subscribers, port } = setup({ command });
    expect(await run(`${bind} await page.cdp("Runtime.evaluate")`)).toMatchObject({
      structuredContent: { error: { code: "bridge-limit" } },
    });
    expect(command.mock.calls[0]?.[4]).toMatchObject({
      maxBytes: limits.bridgeBytes,
      maxDepth: 31,
    });
    const budget = vi.mocked(port.subscribe).mock.calls[0]?.[3];
    expect(budget).toMatchObject({ maxBytes: expect.any(Number), maxDepth: 28 });
    for (const receive of subscribers) {
      receive({ method: "oversized", paramsJson: "x".repeat(browserReplLimits.eventBytes + 1) });
      receive({ method: "deep", paramsJson: deep });
      receive({ method: "small", paramsJson: '{"quoted":"[\\\"[[]"}' });
    }
    expect(await run("return page.drainEvents().map(event => event.method)")).toEqual({
      content: [text(["small"])],
    });
    const oversized = run('return "🙂".repeat(160_000)');
    expect(await service.execute("other", "return 9")).toEqual({ content: [text(9)] });
    expect(await oversized).toMatchObject({
      structuredContent: { error: { code: "output-limit" } },
    });
  });

  it("shares concurrent binds and retires each closed target so the next handle can open", async () => {
    const { run, port, end, subscribers } = setup();
    expect(
      await run(`${bind} const pair = await Promise.all([openPage("tab-root"), openPage("tab-root")]);
      return pair.every(handle => handle === page);`),
    ).toEqual({ content: [text(true)] });
    expect(port.openPage).toHaveBeenCalledTimes(1);
    expect(subscribers.size).toBe(1);
    for (let i = 0; i <= browserReplLimits.handles; i++) {
      end();
      expect(subscribers.size).toBe(0);
      expect(
        await run(`const next = await openPage("tab-root");
        let expired;
        try { await page.cdp("Page.enable"); } catch (error) { expired = error.code; }
        const changed = page !== next;
        globalThis.page = next;
        return [expired, changed];`),
      ).toEqual({ content: [text(["page-ended", true])] });
    }
    expect(port.command).not.toHaveBeenCalled();
  });

  it("keeps unexpected errors in Host logs and exposes just explicit CDP error fields", async () => {
    const internal = Object.assign(new Error("private /provider/path"), {
      code: "private-code",
      next: "private-token",
      value: { internal: true },
      performed: ["private"],
    });
    const cdp = Object.assign(new BrowserUseCdpError(-32001, "No such frame"), { data: "private" });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { run } = setup({
        command: async (_target, method) => {
          throw method === "Runtime.evaluate" ? internal : cdp;
        },
      });
      expect(
        await run(`${bind} try { await page.cdp("Runtime.evaluate"); } catch (error) {
        return [error.code, error.message, Object.keys(error)];
      }`),
      ).toEqual({ content: [text(["failed", "Browser operation failed.", ["code"]])] });
      expect(await run('await page.cdp("Runtime.evaluate")')).toMatchObject({
        structuredContent: { error: { code: "failed", message: "Browser operation failed." } },
      });
      expect(log).toHaveBeenCalledWith("browser.repl.port.failed", internal);
      expect(
        await run(
          'try { await page.cdp("Page.enable"); } catch (error) { return [error.code, error.message, error.data]; }',
        ),
      ).toEqual({
        content: [text([-32001, "No such frame", null])],
      });
      expect(await run('await page.cdp("Page.enable")')).toMatchObject({
        structuredContent: {
          error: { code: "cdp-error", cdpCode: -32001, message: "No such frame" },
        },
      });
    } finally {
      log.mockRestore();
    }
  });

  it("removes queued cancellations while all execution slots are occupied", async () => {
    const full = Promise.withResolvers();
    const hold = Promise.withResolvers<readonly []>();
    let inFlight = 0;
    const { service } = setup({
      listPages: (call) => {
        if (++inFlight === limits.executing) full.resolve(undefined);
        if (call.contextKey === "queued") return Promise.resolve([]);
        return hold.promise;
      },
    });
    const active = Array.from({ length: limits.executing }, (_, index) =>
      service.execute(`slot-${index}`, "await pages()"),
    );
    await full.promise;
    const controller = new AbortController();
    const queued = service.execute(
      "queued",
      'throw new Error("cancelled script ran")',
      controller.signal,
    );
    const deleted = vi.spyOn(Map.prototype, "delete");
    try {
      controller.abort();
      expect(deleted.mock.results.some(({ value }) => value === true)).toBe(true);
    } finally {
      deleted.mockRestore();
    }
    expect(await queued).toMatchObject({ structuredContent: { error: { code: "cancelled" } } });
    const replacement = service.execute("queued", "return 42");
    hold.resolve([]);
    await Promise.all(active);
    expect(await replacement).toEqual({ content: [text(42)] });
  });

  it("withholds a late event during settlement and delivers it to the next call", async () => {
    const worker = new Worker(
      new URL("../computer-use/computer-repl/computer-repl-worker.ts", import.meta.url),
      {
        workerData: "browser",
        execArgv: ["--import", "tsx"],
      },
    );
    const messages: FromWorker[] = [];
    const send = (message: ToWorker) => worker.postMessage(message);
    const context = "event";
    const params = { dialogId: "dialog-late", type: "confirm", message: "Too late?" };
    const expected = { method: "Page.javascriptDialogOpening", params, sessionId: root.sessionId };
    const late = JSON.stringify({
      live: ["1"],
      events: [[100, ["1", expected.method, root.sessionId, params]]],
    });
    const listen = (input: unknown) => {
      const message = FromWorkerSchema.parse(input);
      messages.push(message);
      if (message.type === "browser-request" && message.json.includes('"browser.open"'))
        send({
          type: "reply",
          context,
          callId: message.callId,
          id: message.id,
          value: { ...root, handle: "1" },
        });
      if (message.type === "settled" && message.callId === "first")
        send({ type: "events", context, callId: "first", events: late });
    };
    worker.on("message", listen);
    const done = (id: string) =>
      new Promise<void>((resolve, reject) => {
        const listener = (input: unknown) => {
          const message = FromWorkerSchema.parse(input);
          if (message.type !== "done" || message.callId !== id) return;
          worker.off("message", listener);
          if (message.error) reject(new Error(message.error.message));
          else resolve();
        };
        worker.on("message", listener);
      });
    try {
      const first = done("first");
      send({
        type: "execute",
        context,
        callId: "first",
        code: `
        ${bind}
        void page.waitForNetworkIdle().catch(() => {});
        let remaining = 1024;
        const churn = () => { if (--remaining) Promise.resolve().then(churn); };
        churn();
      `,
      });
      await first;
      expect(
        messages.some((message) => message.type === "settled" && message.callId === "first"),
      ).toBe(true);
      expect(
        messages.some((message) => message.type === "events-read" && message.callId === "first"),
      ).toBe(false);
      const next = done("next");
      send({
        type: "execute",
        context,
        callId: "next",
        code: "return page.drainEvents()",
        events: late,
      });
      await next;
      expect(messages).toContainEqual({ ...text([expected]), context, callId: "next" });
    } finally {
      await worker.terminate();
    }
  });

  it("matches a VM creation cancellation to its call and keeps the replacement alive", async () => {
    const worker = new Worker(
      new URL("../computer-use/computer-repl/computer-repl-worker.ts", import.meta.url),
      {
        workerData: "browser",
        execArgv: ["--import", "tsx"],
      },
    );
    const messages: FromWorker[] = [];
    const send = (message: ToWorker) => worker.postMessage(message);
    const context = "replacement";
    try {
      const completed = new Promise<void>((resolve) =>
        worker.on("message", (input: unknown) => {
          const message = FromWorkerSchema.parse(input);
          messages.push(message);
          if (message.type === "done" && message.callId === "new") resolve();
        }),
      );
      await once(worker, "online");
      send({
        type: "execute",
        context,
        callId: "old",
        code: "globalThis.old = true; await sleep(100000)",
      });
      send({ type: "cancel", context, callId: "old" });
      send({ type: "execute", context, callId: "new", code: "return typeof old" });
      send({ type: "cancel", context, callId: "old" });
      await completed;
      expect(
        messages.filter((message) => message.context === context && message.type === "text"),
      ).toEqual([{ ...text("undefined"), context, callId: "new" }]);
    } finally {
      await worker.terminate();
    }
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
        method === "Page.captureScreenshot"
          ? JSON.stringify(await screenshot())
          : JSON.stringify({ oversizedBridge }),
    });
    expect(await run("throw { get message() { while (true) {} } }")).toMatchObject({
      structuredContent: { error: { code: "slice-limit" } },
    });
    expect(await run(String.raw`print("a\0b")`)).toEqual({
      content: [{ type: "text", text: "a\0b" }],
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
