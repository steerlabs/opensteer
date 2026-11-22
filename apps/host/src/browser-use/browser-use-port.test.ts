import { createId, refused } from "@opensteer/core";
import { browserHostMethods, createBrowserSessionId } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import type { BrowserService } from "../browser/browser-service.js";
import type { BrowserUseCall, BrowserUsePort } from "./browser-repl-service.js";
import { createBrowserUsePort, type BrowserUseTabAccess } from "./browser-use-port.js";

function setup() {
  const tabId = createId("tab");
  const threadId = createId("thread");
  const authority = { ownerId: createId("user"), agentBindingId: `run:${createId("run")}` };
  const binding = {
    tabId,
    sessionId: createBrowserSessionId(),
    backend: "cdp" as const,
    reloaded: false,
  };
  const row = { tabId, url: "https://example.com/", title: "Example", profile: "Work" };
  const tabs = {
    async *pages() {
      yield row;
    },
    bind: vi.fn<BrowserUseTabAccess["bind"]>(async () => ({ binding, threadId })),
    open: vi.fn<BrowserUseTabAccess["open"]>(async () => ({ binding, threadId })),
  };
  type Attach = BrowserService["attachCdpForAgent"];
  type Relay = Awaited<ReturnType<Attach>>;
  let emit: Parameters<Attach>[1];
  let end: Parameters<Attach>[2];
  const dispatch = vi.fn<Relay["dispatch"]>(async ({ method }) => ({
    result: Promise.resolve(
      method === browserHostMethods.resumeTab
        ? { targetId: "target" }
        : method === "Target.attachToTarget"
          ? { sessionId: "cdp-session" }
          : { value: true },
    ),
  }));
  const close = vi.fn(() => end?.());
  const browser = {
    attachCdpForAgent: vi.fn<Attach>(async (_authority, listener, closed) => {
      emit = listener;
      end = closed;
      return { session: {} as Relay["session"], close, dispatch, request: vi.fn() };
    }),
  };
  const port = createBrowserUsePort({ authority, tabs, browser });
  const controller = new AbortController();
  const call: BrowserUseCall = {
    contextKey: "test",
    signal: controller.signal,
    deadline: Date.now() + 100_000,
    maxBytes: 4096,
    maxDepth: 10,
    maxEntries: 100,
  };
  return {
    authority,
    browser,
    tabs,
    dispatch,
    close,
    call,
    controller,
    binding,
    threadId,
    row,
    port,
    emit: (event: Parameters<typeof emit>[0]) => emit(event),
  };
}

describe("Browser Use port", () => {
  it("passes admitted tab identity to the scoped relay and opens with the requested profile", async () => {
    const { authority, browser, binding, threadId, tabs, port, call, row, dispatch } = setup();
    expect(await port.listPages(call)).toEqual([row]);
    const handle = await port.openPage(binding.tabId, call);
    expect(tabs.bind).toHaveBeenCalledWith(binding.tabId, call.signal);
    expect(browser.attachCdpForAgent).toHaveBeenCalledWith(
      {
        ...authority,
        sessionId: binding.sessionId,
        scriptTabId: binding.tabId,
        scriptThreadId: threadId,
      },
      expect.any(Function),
      expect.any(Function),
    );
    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      { method: browserHostMethods.resumeTab, parameters: { surfaceId: binding.tabId } },
      expect.objectContaining({
        signal: call.signal,
        eventBudget: expect.objectContaining({ maxBytes: expect.any(Number) }),
      }),
    );
    expect(await port.command(handle, "Runtime.evaluate", {}, handle.sessionId, call)).toBe(
      '{"value":true}',
    );
    const input = { url: row.url, profileId: createId("browserProfile") };
    await port.newPage(input, call);
    expect(tabs.open).toHaveBeenCalledWith(input, expect.any(String), call.signal);
  });

  it.each([
    ["not_found", "Tab not found."],
    ["forbidden", "This browser profile is not granted."],
    ["forbidden", "browser is off."],
    ["conflict", "This tab is in use by another task."],
  ] as const)("propagates admission refusal (%s, %s) without attaching", async (code, message) => {
    const { tabs, browser, binding, call, port } = setup();
    const refusal = refused(code, message, "Choose an available page.");
    tabs.bind.mockRejectedValue(refusal);
    await expect(port.openPage(binding.tabId, call)).rejects.toBe(refusal);
    expect(browser.attachCdpForAgent).not.toHaveBeenCalled();
  });

  it("uses fresh relay admission on every command and keeps Host methods privileged", async () => {
    const { dispatch, binding, port, call } = setup();
    const target = await port.openPage(binding.tabId, call);
    await port.command(target, "Runtime.evaluate", {}, target.sessionId, call);
    const revoked = refused("forbidden", "Browser access was turned off.");
    dispatch.mockRejectedValueOnce(revoked);
    await expect(port.command(target, "Runtime.evaluate", {}, target.sessionId, call)).rejects.toBe(
      revoked,
    );
    for (const method of [
      "Opensteer.fillLogin",
      "Opensteer.fillCard",
      browserHostMethods.resumeTab,
    ])
      await expect(port.command(target, method, {}, target.sessionId, call)).rejects.toMatchObject({
        code: "forbidden",
      });
    expect(dispatch).toHaveBeenCalledTimes(4);
  });

  it("routes session credential fills to the same tab-bound admission as other script commands", async () => {
    const { browser, tabs, binding, call, authority, dispatch } = setup();
    const port = createBrowserUsePort({
      authority: { ...authority, agentBindingId: `session:${createId("agentSession")}` },
      browser,
      tabs,
    });
    const target = await port.openPage(binding.tabId, call);
    for (const method of ["Opensteer.fillLogin", "Opensteer.fillCard"]) {
      await port.command(target, method, {}, target.sessionId, call);
      expect(dispatch).toHaveBeenLastCalledWith(
        { method, parameters: {}, sessionId: target.sessionId },
        expect.objectContaining({ signal: call.signal }),
      );
    }
  });

  it("preflights metadata, replies and events, and stops reading a list at the limit", async () => {
    const { authority, browser, tabs, binding, call, port, dispatch, emit } = setup();
    const afterLimit = vi.fn();
    const short = { ...call, maxBytes: 100 };
    const bounded = createBrowserUsePort({
      authority,
      browser,
      tabs: {
        ...tabs,
        async *pages() {
          yield {
            tabId: binding.tabId,
            url: "https://example.com",
            title: "x".repeat(100),
            profile: "Work",
          };
          afterLimit();
        },
      },
    });
    await expect(bounded.listPages(short)).rejects.toMatchObject({ code: "resource_exhausted" });
    expect(afterLimit).not.toHaveBeenCalled();
    dispatch.mockResolvedValueOnce({
      result: Promise.resolve({
        targetId: "t",
        dialog: { id: "d", type: "alert", message: "x".repeat(100) },
      }),
    });
    await expect(port.openPage(binding.tabId, short)).rejects.toMatchObject({
      code: "resource_exhausted",
    });
    const target = await port.openPage(binding.tabId, call);
    const beforeAccess = vi.fn(() => 1);
    dispatch.mockResolvedValueOnce({
      result: Promise.resolve({
        oversized: "x".repeat(100),
        get later() {
          return beforeAccess();
        },
      }),
    });
    await expect(
      port.command(target, "Runtime.evaluate", {}, target.sessionId, short),
    ).rejects.toMatchObject({ code: "resource_exhausted" });
    expect(beforeAccess).not.toHaveBeenCalled();
    const listener = vi.fn<Parameters<BrowserUsePort["subscribe"]>[1]>();
    port.subscribe(target, listener, vi.fn(), short);
    emit({ sequence: 1, method: "Log.entryAdded", parameters: { text: "x".repeat(100) } });
    emit({ sequence: 2, method: "Log.entryAdded", parameters: { text: "bounded" } });
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      method: "Log.entryAdded",
      paramsJson: '{"text":"bounded"}',
    });
  });

  it("forwards abort to the relay and awaits the terminal acknowledgement", async () => {
    const { controller, call, binding, dispatch, port } = setup();
    const target = await port.openPage(binding.tabId, call);
    const pending = Promise.withResolvers<unknown>();
    dispatch.mockResolvedValueOnce({ result: pending.promise });
    const work = port.command(target, "Runtime.evaluate", {}, target.sessionId, call);
    const settled = vi.fn();
    void work.then(settled, settled);
    controller.abort(new Error("Cancellation requested"));
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    pending.reject(call.signal.reason);
    await expect(work).rejects.toBe(call.signal.reason);
    await expect(port.command(target, "Runtime.evaluate", {}, target.sessionId, call)).rejects.toBe(
      call.signal.reason,
    );
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it.each(["Target.targetDestroyed", "Target.detachedFromTarget"])(
    "rejects %s during bind",
    async (method) => {
      const { binding, port, call, emit, dispatch, close } = setup();
      const attach = dispatch.getMockImplementation()!;
      dispatch.mockImplementation(async (...args) => {
        const answer = await attach(...args);
        if (args[0].method === "Target.attachToTarget")
          emit({
            sequence: 1,
            method,
            parameters: { targetId: "target", sessionId: "cdp-session" },
          });
        return answer;
      });
      await expect(port.openPage(binding.tabId, call)).rejects.toMatchObject({ code: "conflict" });
      expect(close).toHaveBeenCalledOnce();
      dispatch.mockImplementation(attach);
      await expect(port.openPage(binding.tabId, call)).resolves.toMatchObject({ closed: false });
    },
  );

  it("retires a detached target and ends its subscription exactly once", async () => {
    const { binding, port, call, emit, close } = setup();
    const target = await port.openPage(binding.tabId, call);
    const event = vi.fn();
    const end = vi.fn();
    const unsubscribe = port.subscribe(target, event, end, call);
    emit({
      sequence: 1,
      method: "Target.detachedFromTarget",
      parameters: { sessionId: target.sessionId },
    });
    emit({
      sequence: 2,
      method: "Page.loadEventFired",
      parameters: {},
      sessionId: target.sessionId,
    });
    unsubscribe();
    expect(end).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalled();
    expect(event).not.toHaveBeenCalled();
    await expect(
      port.command(target, "Runtime.evaluate", {}, target.sessionId, call),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
