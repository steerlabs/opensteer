import {
  BrowserSourceTabAssembly,
  BrowserSourceTabResultSchema,
  browserSourceTabParts,
  type BrowserSourceClientFrame,
  type BrowserSourceTabCommand,
} from "@opensteer/browser-source-wire/frames";
import { expect, it, vi } from "vitest";
import { ChromeTabDebugger } from "./tab-debugger.js";

function listen<T extends (...args: never[]) => void>() {
  let listener: T;
  return {
    addListener(value: T) {
      listener = value;
    },
    emit(...args: Parameters<T>) {
      listener(...args);
    },
  };
}

async function fixture(
  detachReceipts = false,
  journal?: Parameters<ChromeTabDebugger["connect"]>[4],
) {
  const onCreated =
    listen<(details: { sourceTabId: number; tabId: number; url: string }) => void>();
  const onRemoved = listen<(tabId: number) => void>();
  const onUpdated =
    listen<(tabId: number, changes: { url?: string; title?: string }, tab: ChromeTab) => void>();
  const onDetach = listen<(source: ChromeDebuggee, reason: string) => void>();
  const onEvent =
    listen<(source: ChromeDebuggee, method: string, params?: Record<string, unknown>) => void>();
  const attach = vi.fn(async () => {});
  const detach = vi.fn(async () => {});
  const sendCommand = vi.fn(async () => ({ worked: true }));
  const getTargets = vi.fn(async () =>
    [5, 6, 7, 8].map((tabId) => ({ tabId, id: String(tabId), type: "page" })),
  );
  const getTab = vi.fn(async (id: number) => ({
    id,
    title: "Popup",
    url: "https://fixture.test/",
  }));
  const debuggerRelay = new ChromeTabDebugger(
    {
      attach,
      detach,
      sendCommand,
      onDetach,
      onEvent,
      getTargets,
    },
    {
      onRemoved,
      onReplaced: listen<(added: number, removed: number) => void>(),
      onUpdated,
      create: vi.fn(),
      get: getTab,
      getCurrent: vi.fn(),
      query: vi.fn(),
      remove: vi.fn(),
    },
    { onCreatedNavigationTarget: onCreated },
  );
  const sourceId = "home";
  const received: BrowserSourceClientFrame[] = [];
  const assembly = new BrowserSourceTabAssembly();
  const replies = new Map<
    string,
    PromiseWithResolvers<ReturnType<typeof BrowserSourceTabResultSchema.parse>>
  >();
  const link = debuggerRelay.connect(
    sourceId,
    (frame) => {
      received.push(frame);
      if (frame.type === "tab.result") {
        const raw = assembly.read(frame);
        if (raw !== undefined) {
          const reply = BrowserSourceTabResultSchema.parse(raw);
          replies.get(reply.requestId)?.resolve(reply);
          replies.delete(reply.requestId);
        }
      }
      return true;
    },
    () => {},
    detachReceipts,
    journal,
  );
  const send = (command: BrowserSourceTabCommand) => {
    const done = Promise.withResolvers<ReturnType<typeof BrowserSourceTabResultSchema.parse>>();
    replies.set(command.requestId, done);
    for (const frame of browserSourceTabParts(
      "tab.command",
      new TextEncoder().encode(JSON.stringify(command)),
    ))
      link.read(frame);
    return done.promise;
  };
  await debuggerRelay.share(sourceId, { id: 5, title: "Shared", url: "https://fixture.test/" });
  const shareId = debuggerRelay.list(sourceId)[0]!.shareId;
  const attachmentId = crypto.randomUUID();
  const evaluate = (sessionId?: string) =>
    send({
      action: "cdp",
      requestId: crypto.randomUUID(),
      shareId,
      attachmentId,
      method: "Runtime.evaluate",
      ...(sessionId ? { sessionId } : {}),
    });
  return {
    attach,
    detach,
    sendCommand,
    getTargets,
    getTab,
    onCreated,
    onUpdated,
    onRemoved,
    onDetach,
    onEvent,
    debuggerRelay,
    sourceId,
    received,
    shareId,
    attachmentId,
    evaluate,
    send,
  };
}

it("attaches lazily once and follows only tabs Chrome identifies as opened by the attached tab", async () => {
  const f = await fixture();
  const before = f.debuggerRelay.list(f.sourceId);
  f.onCreated.emit({ tabId: 6, sourceTabId: 5, url: "https://fixture.test/" });
  expect(f.debuggerRelay.list(f.sourceId)).toEqual(before);
  expect(f.attach).not.toHaveBeenCalled();
  await Promise.all([f.evaluate(), f.evaluate()]);
  expect(f.attach).toHaveBeenCalledExactlyOnceWith({ tabId: 5 }, "1.3");
  f.onCreated.emit({ tabId: 7, sourceTabId: 55, url: "https://fixture.test/" });
  f.onCreated.emit({ tabId: 8, sourceTabId: 5, url: "https://fixture.test/" });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(f.received).toContainEqual(
    expect.objectContaining({
      type: "tab.shared",
      openerShareId: f.shareId,
      title: "Popup",
    }),
  );
  expect(f.debuggerRelay.list(f.sourceId).map((tab) => tab.title)).toEqual(["Shared", "Popup"]);
  f.onEvent.emit({ tabId: 5, sessionId: "child" }, "Runtime.executionContextsCleared", {});
  expect(f.received.some((frame) => frame.type === "tab.event")).toBe(true);
  await expect(f.evaluate("child")).resolves.toMatchObject({ ok: true });
  expect(f.sendCommand).toHaveBeenLastCalledWith(
    { tabId: 5, sessionId: "child" },
    "Runtime.evaluate",
    undefined,
  );
});

it("ignores a Chrome navigation event whose source tab is not shared", async () => {
  const f = await fixture();
  await f.evaluate();
  f.attach.mockClear();
  f.sendCommand.mockClear();
  f.getTab.mockClear();
  f.getTargets.mockClear();
  const originalFrames = f.received.slice();
  const originalShares = f.debuggerRelay.list(f.sourceId);
  const url = "https://unrelated.test/";
  f.onCreated.emit({ tabId: 8, sourceTabId: 7, url });
  f.onUpdated.emit(8, { url }, { id: 8, url });
  await Promise.resolve();

  expect(f.attach).not.toHaveBeenCalled();
  expect(f.sendCommand).not.toHaveBeenCalled();
  expect(f.getTab).not.toHaveBeenCalled();
  expect(f.getTargets).not.toHaveBeenCalled();
  expect(f.received).toEqual(originalFrames);
  expect(f.debuggerRelay.list(f.sourceId)).toEqual(originalShares);
});

it.each(["stop", "bar", "close", "disconnect", "Home Stop"] as const)(
  "unshares and detaches Debugger when sharing ends by %s",
  async (ending) => {
    const f = await fixture();
    await f.evaluate();
    if (ending === "stop") f.debuggerRelay.stop(f.sourceId, f.shareId);
    else if (ending === "bar") f.onDetach.emit({ tabId: 5 }, "canceled_by_user");
    else if (ending === "close") f.onRemoved.emit(5);
    else if (ending === "disconnect") f.debuggerRelay.disconnect(f.sourceId);
    else
      await f.send({
        action: "unshare",
        requestId: crypto.randomUUID(),
        shareId: f.shareId,
        attachmentId: f.attachmentId,
      });
    expect(f.debuggerRelay.list(f.sourceId)).toEqual([]);
    await Promise.resolve();
    if (ending === "bar") expect(f.detach).not.toHaveBeenCalled();
    else expect(f.detach).toHaveBeenCalledExactlyOnceWith({ tabId: 5 });
    if (ending !== "disconnect")
      await expect(f.evaluate()).resolves.toMatchObject({
        ok: false,
        error: "This Chrome tab is no longer shared.",
      });
  },
);

it("revokes a share before an in-progress debugger detachment is acknowledged", async () => {
  const f = await fixture(true);
  await f.evaluate();
  const detach = Promise.withResolvers<void>();
  f.detach.mockReturnValueOnce(detach.promise);
  const stopped = f.send({
    action: "unshare",
    requestId: crypto.randomUUID(),
    shareId: f.shareId,
    attachmentId: f.attachmentId,
  });
  expect(f.received.at(-1)).toEqual({ type: "tab.unshared", shareId: f.shareId });
  await expect(f.evaluate()).resolves.toMatchObject({ ok: false });
  expect(f.received).not.toContainEqual({ type: "tab.detached", shareId: f.shareId });
  detach.resolve();
  await expect(stopped).resolves.toMatchObject({ ok: true });
  expect(f.received).toContainEqual({ type: "tab.detached", shareId: f.shareId });
});

it("replays a confirmed detach only for the same pairing until the Home acknowledges it", async () => {
  const stored = new Set<string>();
  const journal = {
    pending: [],
    record: async (id: string) => {
      stored.add(id);
    },
    acknowledge: async (id: string) => {
      stored.delete(id);
    },
  };
  const f = await fixture(true, journal);
  await f.evaluate();
  const detach = Promise.withResolvers<void>();
  f.detach.mockReturnValueOnce(detach.promise);
  const stopping = f.send({
    action: "unshare",
    requestId: crypto.randomUUID(),
    shareId: f.shareId,
    attachmentId: f.attachmentId,
  });
  const receipt = { type: "tab.detached", shareId: f.shareId };
  expect(f.received).not.toContainEqual(receipt);
  expect(stored.size).toBe(0);
  detach.resolve();
  await expect(stopping).resolves.toMatchObject({ ok: true });
  expect(stored).toEqual(new Set([f.shareId]));
  expect(f.received).toContainEqual(receipt);

  f.debuggerRelay.disconnect(f.sourceId);
  const other = vi.fn((_frame: BrowserSourceClientFrame) => true);
  const reconnected = vi.fn((_frame: BrowserSourceClientFrame) => true);
  f.debuggerRelay.connect("another-home", other, () => {}, true, journal);
  f.debuggerRelay.connect(f.sourceId, reconnected, () => {}, true, {
    ...journal,
    pending: [...stored],
  });
  expect(other).not.toHaveBeenCalled();
  expect(reconnected).toHaveBeenCalledExactlyOnceWith(receipt);
  await f.debuggerRelay.acknowledgeDetach(f.sourceId, f.shareId);
  expect(stored.size).toBe(0);
  reconnected.mockClear();
  f.debuggerRelay.connect(f.sourceId, reconnected, () => {}, true, journal);
  expect(reconnected).not.toHaveBeenCalled();
});

it("waits for a previously unshared popup to detach before sending the root receipt", async () => {
  const f = await fixture(true);
  await f.evaluate();
  const popupShared = Promise.withResolvers<string>();
  const send = f.received.push.bind(f.received);
  vi.spyOn(f.received, "push").mockImplementation((frame) => {
    if (frame.type === "tab.shared" && frame.openerShareId === f.shareId)
      popupShared.resolve(frame.shareId);
    return send(frame);
  });
  f.onCreated.emit({ tabId: 6, sourceTabId: 5, url: "https://fixture.test/" });
  const popup = await popupShared.promise;
  await f.send({
    action: "cdp",
    requestId: crypto.randomUUID(),
    shareId: popup,
    attachmentId: crypto.randomUUID(),
    method: "Runtime.evaluate",
  });
  const detach = Promise.withResolvers<void>();
  f.detach.mockReturnValueOnce(detach.promise);
  f.debuggerRelay.stop(f.sourceId, popup);
  const rootStopped = f.send({
    action: "unshare",
    requestId: crypto.randomUUID(),
    shareId: f.shareId,
    attachmentId: f.attachmentId,
  });
  await expect(f.evaluate()).resolves.toMatchObject({ ok: false });
  expect(f.received).not.toContainEqual({ type: "tab.detached", shareId: f.shareId });
  detach.resolve();
  await expect(rootStopped).resolves.toMatchObject({ ok: true });
  expect(f.received.filter(({ type }) => type === "tab.detached")).toEqual([
    { type: "tab.detached", shareId: popup },
    { type: "tab.detached", shareId: f.shareId },
  ]);
});
