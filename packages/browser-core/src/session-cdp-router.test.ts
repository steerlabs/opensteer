import { describe, expect, it, vi } from "vitest";
import {
  SessionCdpRouter,
  SessionCdpRouterError,
  type BrowserCdpBackend,
  type CdpChannel,
  type CdpCommand,
  type CdpEvent,
  type CdpParameters,
} from "./session-cdp-router.js";

function frameWorld(
  id: number,
  auxData: Record<string, unknown> = { frameId: "main", isDefault: true, type: "default" },
  name = "",
): Record<string, unknown> {
  return { auxData, id, name, origin: "https://example.test", uniqueId: `unique-${id}` };
}

function isolatedWorld(id: number, name = "isolated"): Record<string, unknown> {
  return frameWorld(id, { frameId: "main", isDefault: false, type: "isolated" }, name);
}

/** A page channel that behaves as a fresh CDP session. */
class FakeChannel implements CdpChannel {
  closed = false;
  readonly commands: { method: string; parameters?: CdpParameters }[] = [];
  /** What Runtime.enable reports, as Chromium does for every live context. */
  contexts: Record<string, unknown>[] = [frameWorld(1)];
  /** Holds Runtime.enable open until it settles. */
  enableGate: Promise<void> | null = null;
  readonly listeners = new Set<(method: string, parameters: CdpParameters) => void>();
  readonly results = new Map<string, unknown>();

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  onEvent(listener: (method: string, parameters: CdpParameters) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send(method: string, parameters?: CdpParameters): Promise<unknown> {
    this.commands.push({ method, ...(parameters ? { parameters } : {}) });
    if (method === "Runtime.enable") {
      await this.enableGate;
      for (const context of this.contexts)
        this.emit("Runtime.executionContextCreated", { context });
    }
    return this.results.get(method) ?? { method };
  }

  emit(method: string, parameters: CdpParameters): void {
    for (const listener of this.listeners) listener(method, parameters);
  }
}

class FakeBackend implements BrowserCdpBackend {
  protectProductWorlds = false;
  dedicatedContext = false;
  /** The newest channel opened on each target. */
  readonly channels = new Map<string, FakeChannel>();
  readonly commands: { method: string; parameters?: CdpParameters }[] = [];
  readonly listeners = new Set<(method: string, parameters: CdpParameters) => void>();
  /** Shapes each channel before the router sees it. */
  prepareChannel: (channel: FakeChannel, targetId: string) => void = () => undefined;
  nextTarget = 1;
  targetInfos: Record<string, unknown>[] = [];

  attach(targetId: string): Promise<CdpChannel> {
    const channel = new FakeChannel();
    this.prepareChannel(channel, targetId);
    this.channels.set(targetId, channel);
    return Promise.resolve(channel);
  }

  onEvent(listener: (method: string, parameters: CdpParameters) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(method: string, parameters?: CdpParameters): Promise<unknown> {
    this.commands.push({ method, ...(parameters ? { parameters } : {}) });
    if (method === "Target.getTargets") return Promise.resolve({ targetInfos: this.targetInfos });
    if (method === "Target.getTargetInfo")
      return Promise.resolve({
        targetInfo: this.targetInfos.find((info) => info.targetId === parameters?.targetId),
      });
    if (method === "Target.createTarget") {
      const targetId = `created-${this.nextTarget++}`;
      this.targetInfos.push({ targetId, type: "page", url: "about:blank" });
      return Promise.resolve({ targetId });
    }
    return Promise.resolve({ ok: true });
  }

  emit(method: string, parameters: CdpParameters): void {
    for (const listener of this.listeners) listener(method, parameters);
  }
}

describe("SessionCdpRouter", () => {
  it("scopes a connected client and its alias to the seed, creations, and their popups", async () => {
    const backend = new FakeBackend();
    backend.dedicatedContext = true;
    backend.targetInfos = ["seed", "person", "sibling"].map((targetId) => ({
      targetId,
      type: "page",
    }));
    const sendToBrowser = backend.send.bind(backend);
    vi.spyOn(backend, "send").mockImplementation(async (method, params) => {
      const result = await sendToBrowser(method, params);
      if (method === "Target.createTarget")
        backend.emit("Target.targetCreated", { targetInfo: backend.targetInfos.at(-1) });
      return result;
    });
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "person", async () => true, "/files/a");
    router.claimTarget("a", "seed");
    router.claimTarget("a", "sibling");
    const client = router.openStandardClient("a", {
      wholeContext: true,
      lineage: { attachmentId: "first", seedTargetId: "seed" },
    });
    const other = router.openStandardClient("a", {
      wholeContext: false,
      lineage: { attachmentId: "second", seedTargetId: "sibling" },
    });
    const events: CdpEvent[] = [];
    client.onEvent((event) => events.push(event));
    const { sessionId } = (await client.send({ method: "Target.attachToBrowserTarget" })) as {
      sessionId: string;
    };
    const discover = { method: "Target.setDiscoverTargets", parameters: { discover: true } };
    await client.send(discover);
    await client.send({ ...discover, sessionId });
    await client.send({
      method: "Target.setAutoAttach",
      parameters: { autoAttach: true, flatten: true },
    });
    await client.send({
      method: "Target.setAutoAttach",
      parameters: { autoAttach: true, flatten: true },
      sessionId,
    });

    const targets = (ids: string[]) => ({
      targetInfos: ids.map((targetId) => expect.objectContaining({ targetId })),
    });
    await expect(client.send({ method: "Target.getTargets" })).resolves.toEqual(targets(["seed"]));
    await expect(client.send({ method: "Target.getTargets", sessionId })).resolves.toEqual(
      targets(["seed"]),
    );
    const { targetId } = (await client.send({
      method: "Target.createTarget",
      parameters: { url: "about:blank" },
      sessionId,
    })) as { targetId: string };
    const siblingPage = (await other.send({
      method: "Target.createTarget",
      parameters: { url: "about:blank" },
    })) as { targetId: string };
    for (const info of [
      { targetId: "popup", type: "page", openerId: targetId },
      { targetId: "person-popup", type: "page", openerId: "person" },
    ]) {
      backend.targetInfos.push(info);
      backend.emit("Target.targetCreated", { targetInfo: info });
    }
    expect(router.claimTarget("a", "popup", targetId)).toBe("first");
    expect(router.claimTarget("a", targetId)).toBe("first");
    expect(router.claimTarget("a", "person-popup", "person")).toBeUndefined();
    await expect(client.send({ method: "Target.getTargets", sessionId })).resolves.toEqual(
      targets(["seed", targetId, "popup"]),
    );
    await expect(other.send({ method: "Target.getTargets" })).resolves.toEqual(
      targets(["sibling", siblingPage.targetId]),
    );

    for (const method of [
      "Target.attachToTarget",
      "Target.getTargetInfo",
      "Target.closeTarget",
      "Target.activateTarget",
    ]) {
      for (const root of [{}, { sessionId }]) {
        const send = (id: string) =>
          client
            .send({ method, parameters: { targetId: id }, ...root })
            .catch((error: unknown) => error);
        const missing = await send("missing");
        expect(missing).toBeInstanceOf(SessionCdpRouterError);
        for (const id of ["person", "person-popup", "sibling", siblingPage.targetId])
          expect(await send(id)).toMatchObject(missing as SessionCdpRouterError);
      }
    }
    await client.send({
      method: "Target.attachToTarget",
      parameters: { targetId: "popup" },
      sessionId,
    });
    await client.send({ method: "Target.attachToTarget", parameters: { targetId: "popup" } });
    const announced = (method: string, root?: string) =>
      events
        .filter((event) => event.method === method && event.sessionId === root)
        .map((event) => event.parameters.targetInfo);
    for (const root of [undefined, sessionId]) {
      expect(announced("Target.targetCreated", root)).toEqual(
        targets(["seed", targetId, "popup"]).targetInfos,
      );
      expect(announced("Target.attachedToTarget", root)).toEqual(
        targets(["seed", targetId, "popup"]).targetInfos,
      );
    }
    await router.close();
  });

  it("gives a browser CDP alias the same confined root in session mode", async () => {
    const backend = new FakeBackend();
    const page = { targetId: "owned", type: "page" };
    const foreign = { targetId: "foreign", type: "page" };
    backend.targetInfos = [page, foreign];
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", page.targetId, async () => true, "/files/a");
    router.registerSession("b", foreign.targetId, async () => true, "/files/b");
    const client = router.openStandardClient("a", { wholeContext: false });
    const sibling = router.openStandardClient("a", { wholeContext: false });
    const { sessionId } = (await client.send({ method: "Target.attachToBrowserTarget" })) as {
      sessionId: string;
    };
    const alias = (method: string, parameters?: CdpParameters) =>
      client.send({ method, sessionId, ...(parameters ? { parameters } : {}) });
    const result = { targetInfos: [{ ...page, browserContextId: "a" }] };
    await expect(alias("Target.getTargets")).resolves.toEqual(result);
    await expect(client.send({ method: "Target.getTargets" })).resolves.toEqual(result);
    const child = (await alias("Target.attachToTarget", {
      targetId: page.targetId,
      flatten: true,
    })) as {
      sessionId: string;
    };
    await expect(client.send({ method: "Target.getTargets", ...child })).resolves.toEqual(result);
    await expect(alias("Target.getTargetInfo")).resolves.toEqual(
      await client.send({ method: "Target.getTargetInfo" }),
    );
    for (const [method, parameters] of [
      ["Target.attachToTarget", { targetId: foreign.targetId, flatten: true }],
      ["Target.getTargetInfo", { targetId: foreign.targetId }],
      ["Target.getTargets", { browserContextId: "b" }],
      ["Browser.close", {}],
      ["Target.createBrowserContext", {}],
      ["Storage.getCookies", {}],
      ["Target.attachToBrowserTarget", {}],
    ] as const) {
      await expect(alias(method, parameters)).rejects.toMatchObject({ code: "forbidden" });
    }
    await expect(sibling.send({ method: "Target.getTargets", sessionId })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      sibling.send({ method: "Target.detachFromTarget", parameters: { sessionId } }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(backend.commands.map(({ method }) => method)).toEqual([
      "Target.getTargets",
      "Target.getTargets",
      "Target.getTargetInfo",
      "Target.getTargets",
    ]);
    await client.send({ method: "Target.detachFromTarget", parameters: { sessionId } });
    await expect(alias("Target.getTargets")).rejects.toMatchObject({ code: "not_found" });
    await expect(client.send({ method: "Target.getTargets" })).resolves.toEqual(result);
    await router.close();
  });

  it("routes whole-context commands and target events on the alias without reusing root channels", async () => {
    const backend = new FakeBackend();
    backend.dedicatedContext = true;
    const page = { targetId: "owned", type: "page" };
    backend.targetInfos = [page];
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", page.targetId, async () => true, "/files/a");
    const client = router.openStandardClient("a", { wholeContext: true });
    const events: CdpEvent[] = [];
    client.onEvent((event) => events.push(event));
    await client.send({
      method: "Target.setAutoAttach",
      parameters: { autoAttach: true, flatten: true, waitForDebuggerOnStart: false },
    });
    const rootPage = events[0]!.parameters.sessionId;
    const physical = backend.channels.get(page.targetId)!;
    const { sessionId } = (await client.send({ method: "Target.attachToBrowserTarget" })) as {
      sessionId: string;
    };
    const alias = (method: string, parameters?: CdpParameters) =>
      client.send({ method, sessionId, ...(parameters ? { parameters } : {}) });
    await expect(alias("Storage.getCookies", { browserContextId: "a" })).resolves.toEqual(
      await client.send({ method: "Storage.getCookies" }),
    );
    expect(backend.commands.slice(-2)).toEqual([
      { method: "Storage.getCookies", parameters: {} },
      { method: "Storage.getCookies" },
    ]);
    await alias("Target.setDiscoverTargets", { discover: true });
    const popup = { targetId: "popup", type: "page", openerId: page.targetId };
    backend.targetInfos.push(popup);
    backend.emit("Target.targetCreated", { targetInfo: popup });
    expect(events.filter(({ method }) => method === "Target.targetCreated")).toEqual([
      expect.objectContaining({
        sessionId,
        parameters: { targetInfo: { ...page, browserContextId: "a" } },
      }),
      expect.objectContaining({
        sessionId,
        parameters: { targetInfo: { ...popup, browserContextId: "a" } },
      }),
    ]);
    const child = (await alias("Target.attachToTarget", {
      targetId: page.targetId,
      flatten: true,
    })) as {
      sessionId: string;
    };
    expect(child.sessionId).not.toBe(rootPage);
    const childPhysical = backend.channels.get(page.targetId)!;
    expect(events).toContainEqual(
      expect.objectContaining({
        method: "Target.attachedToTarget",
        sessionId,
        parameters: expect.objectContaining({ sessionId: child.sessionId }),
      }),
    );
    await alias("Target.sendMessageToTarget", {
      ...child,
      message: JSON.stringify({ id: 42, method: "Network.enable" }),
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        method: "Target.receivedMessageFromTarget",
        sessionId,
        parameters: {
          ...child,
          message: JSON.stringify({ id: 42, result: { method: "Network.enable" } }),
        },
      }),
    );
    await client.send({ method: "Target.detachFromTarget", parameters: { sessionId } });
    expect(events).toContainEqual(
      expect.objectContaining({
        method: "Target.detachedFromTarget",
        sessionId,
        parameters: expect.objectContaining({ sessionId: child.sessionId }),
      }),
    );
    expect(events.at(-1)).toMatchObject({
      method: "Target.detachedFromTarget",
      parameters: { sessionId },
    });
    expect(childPhysical.closed).toBe(true);
    expect(physical.closed).toBe(false);
    await expect(client.send({ method: "Network.enable", ...child })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      client.send({ method: "Network.enable", sessionId: String(rootPage) }),
    ).resolves.toEqual({ method: "Network.enable" });
    await router.close();
  });

  it("scopes browser scripts to their root, descendants and private CDP channels", async () => {
    const backend = new FakeBackend();
    const root = { targetId: "first", type: "page" };
    const other = { targetId: "second", type: "page" };
    const popup = { targetId: "popup", type: "page", openerId: root.targetId };
    const siblingPopup = { targetId: "sibling-popup", type: "page", openerId: other.targetId };
    backend.targetInfos = [root, other, popup, siblingPopup];
    const router = new SessionCdpRouter(backend);
    router.registerSession("session", root.targetId, async () => true, "/files/a");
    router.claimTarget("session", other.targetId);
    const first = vi.fn<(event: CdpEvent) => void>();
    const second = vi.fn<(event: CdpEvent) => void>();
    const budget = { maxBytes: 1024, maxDepth: 8, maxEntries: 64 };
    router.openScriptAttachment("session", "first-script", root.targetId, budget, first);
    router.openScriptAttachment("session", "second-script", other.targetId, budget, second);
    const send = (scriptAttachmentId: string, command: CdpCommand) =>
      router.send("session", { ...command, scriptAttachmentId });
    const attach = (id: string, targetId: string) =>
      send(id, { method: "Target.attachToTarget", parameters: { targetId } });

    const otherChannel = await attach("second-script", other.targetId);
    await expect(attach("first-script", other.targetId)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      send("first-script", {
        method: "Runtime.evaluate",
        ...(otherChannel as { sessionId: string }),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    backend.channels.get(other.targetId)!.emit("Log.entryAdded", { text: "second" });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ method: "Log.entryAdded" }));
    second.mockClear();

    router.claimTarget("session", popup.targetId);
    backend.emit("Target.targetCreated", { targetInfo: popup });
    backend.emit("Target.targetCreated", { targetInfo: siblingPopup });
    router.claimTarget("session", siblingPopup.targetId);
    expect(first).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ parameters: { targetInfo: popup } }),
    );
    expect(second).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ parameters: { targetInfo: siblingPopup } }),
    );
    await expect(send("first-script", { method: "Target.getTargets" })).resolves.toEqual({
      rootTargetId: root.targetId,
      targetInfos: [root, popup],
    });
    await expect(attach("first-script", popup.targetId)).resolves.toHaveProperty("sessionId");
    await expect(attach("first-script", siblingPopup.targetId)).rejects.toMatchObject({
      code: "forbidden",
    });
    await router.closeScriptAttachment("session", "first-script", Promise.resolve());
    await expect(send("first-script", { method: "Target.getTargets" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(send("second-script", { method: "Target.getTargets" })).resolves.toHaveProperty(
      "rootTargetId",
      other.targetId,
    );
    await router.close();
  });

  it("keeps the legacy byte limit without applying script structural limits", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend);
    router.registerSession("session", "root", async () => true, "/files/a");
    const { sessionId } = (await router.send("session", {
      method: "Target.attachToTarget",
      parameters: { targetId: "root" },
    })) as { sessionId: string };
    const page = backend.channels.get("root")!;
    const value = { entries: Array<number>(70_000).fill(0) };
    const event = vi.fn();
    router.onEvent("session", event);
    page.results.set("Runtime.evaluate", value);
    await expect(
      router.send("session", { method: "Runtime.evaluate", sessionId }),
    ).resolves.toEqual(value);
    page.emit("Log.entryAdded", value);
    expect(event).toHaveBeenCalledOnce();
    await router.close();
  });

  it("notifies only the script bound to a released root so it can retire its page handle", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend);
    router.registerSession("session", "root", async () => true, "/files/a");
    router.claimTarget("session", "other");
    const event = vi.fn<(event: CdpEvent) => void>();
    const otherEvent = vi.fn<(event: CdpEvent) => void>();
    const budget = { maxBytes: 1024, maxDepth: 8, maxEntries: 64 };
    router.openScriptAttachment("session", "script", "root", budget, event);
    router.openScriptAttachment("session", "other-script", "other", budget, otherEvent);
    try {
      await router.send("session", {
        method: "Target.attachToTarget",
        parameters: { targetId: "root" },
        scriptAttachmentId: "script",
      });
      router.releaseTarget("session", "root");
      backend.emit("Target.targetDestroyed", { targetId: "root" });
      expect(event).toHaveBeenCalledExactlyOnceWith({
        method: "Target.targetDestroyed",
        parameters: { targetId: "root" },
        sequence: 1,
        scriptAttachmentId: "script",
      });
      expect(otherEvent).not.toHaveBeenCalled();
      await expect(
        router.send("session", {
          method: "Target.closeTarget",
          parameters: { targetId: "root" },
          scriptAttachmentId: "script",
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await router.close();
    }
  });

  it("rejects oversized script replies and drops events before delivering them", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend);
    router.registerSession("session", "root", async () => true, "/files/a");
    const event = vi.fn<(event: CdpEvent) => void>();
    const budget = { maxBytes: 4096, maxDepth: 6, maxEntries: 32 };
    router.openScriptAttachment("session", "script", "root", budget, event);
    const channel = (await router.send("session", {
      method: "Target.attachToTarget",
      parameters: { targetId: "root" },
      scriptAttachmentId: "script",
    })) as { sessionId: string };
    const page = backend.channels.get("root")!;
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
    const wide = { values: Array.from({ length: 32 }, () => 0) };
    for (const result of [deep, wide]) {
      page.results.set("Runtime.evaluate", result);
      await expect(
        router.send("session", {
          method: "Runtime.evaluate",
          sessionId: channel.sessionId,
          scriptAttachmentId: "script",
          replyBudget: budget,
        }),
      ).rejects.toMatchObject({ code: "too_large" });
      page.emit("Log.entryAdded", result);
    }
    expect(event).not.toHaveBeenCalled();
    page.emit("Log.entryAdded", { text: "fits" });
    expect(event).toHaveBeenCalledOnce();
    await router.close();
  });

  it.each(["browser root", "page session"])(
    "carries the script reply budget into a nested command from the %s",
    async (route) => {
      const backend = new FakeBackend();
      const router = new SessionCdpRouter(backend);
      router.registerSession("session", "root", async () => true, "/files/a");
      const child = Promise.withResolvers<string>();
      router.openScriptAttachment(
        "session",
        "script",
        "root",
        { maxBytes: 4096, maxDepth: 32, maxEntries: 200 },
        (event) => {
          if (event.method === "Target.attachedToTarget")
            child.resolve(String(event.parameters.sessionId));
        },
      );
      const parent = (await router.send("session", {
        method: "Target.attachToTarget",
        parameters: { targetId: "root" },
        scriptAttachmentId: "script",
      })) as { sessionId: string };
      const page = backend.channels.get("root")!;
      page.emit("Target.attachedToTarget", {
        targetInfo: { targetId: "frame", type: "iframe" },
        sessionId: "physical-frame",
      });
      const dispatch = vi.spyOn(page, "send").mockImplementation(async (_method, parameters) => {
        const request = JSON.parse(String(parameters?.message)) as { id: number };
        page.emit("Target.receivedMessageFromTarget", {
          sessionId: "physical-frame",
          message: JSON.stringify({ id: request.id, result: { data: "x".repeat(256) } }),
        });
        return {};
      });
      try {
        await expect(
          router.send("session", {
            method: "Target.sendMessageToTarget",
            parameters: {
              sessionId: await child.promise,
              message: JSON.stringify({ id: 1, method: "Runtime.evaluate" }),
            },
            scriptAttachmentId: "script",
            replyBudget: { maxBytes: 128, maxDepth: 10, maxEntries: 100 },
            ...(route === "page session" ? { sessionId: parent.sessionId } : {}),
          }),
        ).rejects.toMatchObject({ code: "too_large" });
        expect(dispatch).toHaveBeenCalledOnce();
      } finally {
        await router.close();
      }
    },
  );

  it("opens a virtual browser root and announces only owned pages before replying", async () => {
    const backend = new FakeBackend();
    const root = { targetId: "root-a", type: "page", browserContextId: "profile" };
    backend.targetInfos = [root, { targetId: "root-b", type: "page", browserContextId: "profile" }];
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "root-a", async () => true, "/files/a");
    router.registerSession("b", "root-b", async () => true, "/files/b");
    const client = router.openStandardClient("a", { wholeContext: false });
    const events: CdpEvent[] = [];
    client.onEvent((event) => events.push(event));
    const enable = {
      method: "Target.setAutoAttach",
      parameters: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
    };

    const enabled = client.send(enable);
    await expect(
      client.send({
        method: "Browser.setDownloadBehavior",
        parameters: { behavior: "allowAndName", downloadPath: "/agent", eventsEnabled: true },
      }),
    ).rejects.toThrow("requires a whole browser context grant");
    await expect(enabled).resolves.toEqual({});
    const attached = events.filter((event) => event.method === "Target.attachedToTarget");
    expect(attached).toEqual([
      {
        method: "Target.attachedToTarget",
        parameters: {
          sessionId: expect.any(String),
          targetInfo: { ...root, browserContextId: "a", attached: true },
          waitingForDebugger: false,
        },
        sequence: expect.any(Number),
      },
    ]);
    const sessionId = attached[0]?.parameters.sessionId;
    await expect(client.send({ method: "Target.getTargetInfo" })).resolves.toMatchObject({
      targetInfo: { type: "browser", targetId: "browser_a" },
    });
    await expect(
      client.send({
        method: "Target.attachToTarget",
        parameters: { targetId: "root-a", flatten: true },
      }),
    ).resolves.toEqual({ sessionId });
    expect([...backend.channels.keys()]).toEqual(["root-a"]);
    expect(backend.commands).toEqual([
      { method: "Target.getTargetInfo", parameters: { targetId: "root-a" } },
    ]);
    expect(events).toEqual(attached);

    await client.send({ method: "Target.detachFromTarget", parameters: { sessionId } });
    expect(events.at(-1)).toMatchObject({
      method: "Target.detachedFromTarget",
      parameters: { sessionId, targetId: "root-a" },
    });
    const explicit = await client.send({
      method: "Target.attachToTarget",
      parameters: { targetId: "root-a", flatten: true },
    });
    expect(events.at(-1)).toMatchObject({
      method: "Target.attachedToTarget",
      parameters: explicit,
    });
    expect(explicit).not.toEqual({ sessionId });
    await router.close();
  });

  it("announces new pages from creation, opener inheritance and ledger claims and retires them", async () => {
    const backend = new FakeBackend();
    backend.targetInfos = [{ targetId: "root-a", type: "page" }];
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "root-a", async () => true, "/files/a");
    const client = router.openStandardClient("a", { wholeContext: false });
    const attached = new Map<string, CdpParameters>();
    const seen = new Map(["popup", "claimed"].map((id) => [id, Promise.withResolvers<void>()]));
    const detached: CdpParameters[] = [];
    client.onEvent((event) => {
      if (event.method === "Target.attachedToTarget") {
        const { targetId } = event.parameters.targetInfo as { targetId: string };
        attached.set(targetId, event.parameters);
        seen.get(targetId)?.resolve();
      }
      if (event.method === "Target.detachedFromTarget") detached.push(event.parameters);
    });
    const enable = {
      method: "Target.setAutoAttach",
      parameters: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
    };
    await client.send(enable);
    await expect(
      client.send({
        method: "Target.createTarget",
        parameters: { url: "about:blank" },
      }),
    ).resolves.toEqual({ targetId: "created-1" });
    expect(attached.has("created-1")).toBe(true);

    const popup = { targetId: "popup", type: "page", openerId: "root-a" };
    const claimed = { targetId: "claimed", type: "page" };
    backend.targetInfos.push(popup, claimed);
    backend.emit("Target.targetCreated", { targetInfo: popup });
    backend.emit("Target.targetCreated", { targetInfo: claimed });
    router.claimTarget("a", "claimed");
    await Promise.all([...seen.values()].map(({ promise }) => promise));
    expect([...attached.keys()].sort()).toEqual(["claimed", "created-1", "popup", "root-a"]);
    for (const parameters of attached.values())
      expect(parameters.targetInfo).toMatchObject({ browserContextId: "a" });

    backend.emit("Target.targetDestroyed", { targetId: "popup" });
    router.releaseTarget("a", "claimed");
    expect(detached).toEqual(
      ["popup", "claimed"].map((targetId) => ({
        targetId,
        sessionId: attached.get(targetId)?.sessionId,
      })),
    );
    expect(backend.channels.get("popup")?.closed).toBe(true);
    const oldId = attached.get("root-a")?.sessionId;
    await client.send({
      method: "Target.setAutoAttach",
      parameters: { autoAttach: false, flatten: true },
    });
    expect(router.listOwnedTargets("a")).toEqual(["root-a", "created-1"]);
    await client.send(enable);
    expect(attached.get("root-a")?.sessionId).not.toBe(oldId);
    await router.close();
  });

  it("replays owned discovery targets without replaying a racing live announcement", async () => {
    const backend = new FakeBackend();
    const root = { targetId: "root-a", type: "page" };
    const popup = { targetId: "popup", type: "page", openerId: "root-a" };
    const directory = Promise.withResolvers<unknown>();
    vi.spyOn(backend, "send").mockReturnValueOnce(directory.promise);
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "root-a", async () => true, "/files/a");
    router.registerSession("b", "root-b", async () => true, "/files/b");
    const client = router.openStandardClient("a", { wholeContext: false });
    const events: CdpEvent[] = [];
    client.onEvent((event) => events.push(event));
    await client.send({
      method: "Target.setDiscoverTargets",
      parameters: { discover: false },
    });
    const replay = client.send({
      method: "Target.setDiscoverTargets",
      parameters: { discover: true },
    });
    backend.emit("Target.targetCreated", { targetInfo: popup });
    backend.emit("Target.targetInfoChanged", { targetInfo: { ...popup, title: "changed" } });
    directory.resolve({ targetInfos: [root, popup, { targetId: "root-b", type: "page" }] });
    await replay;
    expect(events.map(({ method, parameters }) => ({ method, parameters }))).toEqual([
      ...[root, popup].map((targetInfo) => ({
        method: "Target.targetCreated",
        parameters: { targetInfo: { ...targetInfo, browserContextId: "a" } },
      })),
      {
        method: "Target.targetInfoChanged",
        parameters: { targetInfo: { ...popup, title: "changed", browserContextId: "a" } },
      },
    ]);
    await router.close();
  });

  it("keeps legacy discovery, target info, result shape and byte limits separate from standard clients", async () => {
    const backend = new FakeBackend();
    backend.targetInfos = [{ targetId: "root-a", type: "page" }];
    vi.spyOn(backend, "send").mockResolvedValueOnce({
      targetInfos: backend.targetInfos,
      rootSurfaceId: "legacy-surface",
    });
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "root-a", async () => true, "/files/a");
    const legacyEvents: CdpEvent[] = [];
    router.onEvent("a", (event) => legacyEvents.push(event));
    await router.send("a", { method: "Target.setDiscoverTargets", parameters: { discover: true } });
    expect(legacyEvents).toEqual([]);
    await expect(router.send("a", { method: "Target.getTargets" })).resolves.toMatchObject({
      rootSurfaceId: "legacy-surface",
      rootTargetId: "root-a",
    });
    await expect(router.send("a", { method: "Target.getTargetInfo" })).rejects.toMatchObject({
      code: "bad_command",
    });

    const attached = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<CdpChannel>();
    const firstChannel = new FakeChannel();
    const firstClosed = Promise.withResolvers<void>();
    vi.spyOn(firstChannel, "close").mockImplementation(async () => firstClosed.resolve());
    vi.spyOn(backend, "attach").mockImplementationOnce(() => {
      attached.resolve();
      return gate.promise;
    });
    const first = router.openStandardClient("a", { wholeContext: false });
    const enable = {
      method: "Target.setAutoAttach",
      parameters: { autoAttach: true, flatten: true, waitForDebuggerOnStart: true },
    };
    const starting = expect(first.send(enable)).rejects.toThrow("CDP connection closed");
    await attached.promise;
    first.close();
    await starting;
    gate.resolve(firstChannel);
    await firstClosed.promise;

    const second = router.openStandardClient("a", { wholeContext: false });
    const events: CdpEvent[] = [];
    second.onEvent((event) => events.push(event));
    await second.send(enable);
    const secondId = String(events[0]?.parameters.sessionId);
    const secondChannel = backend.channels.get("root-a")!;
    expect(legacyEvents).toEqual([]);
    expect(events.map(({ method }) => method)).toEqual(["Target.attachedToTarget"]);
    const large = { method: "Runtime.evaluate", parameters: { expression: "x".repeat(450_000) } };
    await expect(second.send({ ...large, sessionId: secondId })).resolves.toBeDefined();
    second.close();
    expect(secondChannel.closed).toBe(true);
    expect(second.attachedTargetId(secondId)).toBeNull();
    await expect(router.send("a", large)).rejects.toMatchObject({ code: "too_large" });
    expect(legacyEvents).toEqual([]);
    await router.close();
  });

  it("announces initial pages before a claim that races root auto-attach", async () => {
    const backend = new FakeBackend();
    backend.targetInfos = [
      { targetId: "root-a", type: "page" },
      { targetId: "initial", type: "page" },
      { targetId: "live", type: "page" },
    ];
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "root-a", async () => true, "/files/a");
    router.claimTarget("a", "initial");
    const firstAttach = Promise.withResolvers<CdpChannel>();
    const began = Promise.withResolvers<void>();
    vi.spyOn(backend, "attach").mockImplementationOnce(() => {
      began.resolve();
      return firstAttach.promise;
    });
    const client = router.openStandardClient("a", { wholeContext: false });
    const announced: unknown[] = [];
    const live = Promise.withResolvers<void>();
    client.onEvent((event) => {
      if (event.method !== "Target.attachedToTarget") return;
      const { targetId } = event.parameters.targetInfo as CdpParameters;
      announced.push(targetId);
      if (targetId === "live") live.resolve();
    });
    const enabling = client.send({
      method: "Target.setAutoAttach",
      parameters: { autoAttach: true, flatten: true },
    });
    await began.promise;
    router.claimTarget("a", "live");
    firstAttach.resolve(new FakeChannel());
    await enabling;
    await live.promise;
    expect(announced).toEqual(["root-a", "initial", "live"]);
    await router.close();
  });

  it("retries root auto-attach after a failed page channel", async () => {
    const backend = new FakeBackend();
    backend.targetInfos = [{ targetId: "root", type: "page" }];
    const attach = vi.spyOn(backend, "attach").mockRejectedValueOnce(new Error("attach refused"));
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "root", async () => true, "/files/a");
    const client = router.openStandardClient("a", { wholeContext: false });
    const events: CdpEvent[] = [];
    client.onEvent((event) => events.push(event));
    const command = {
      method: "Target.setAutoAttach",
      parameters: { autoAttach: true, flatten: true },
    };
    await expect(client.send(command)).rejects.toThrow("attach refused");
    expect(events).toEqual([]);
    await expect(client.send(command)).resolves.toEqual({});
    await expect(client.send(command)).resolves.toEqual({});
    expect(attach).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.method)).toEqual(["Target.attachedToTarget"]);
    await router.close();
  });

  it("refuses context-wide and unrecognized commands at the root, on a page and inside nested messages", async () => {
    const backend = new FakeBackend();
    backend.targetInfos = [{ targetId: "root-a", type: "page" }];
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "root-a", async () => true, "/files/a");
    router.registerSession("b", "root-b", async () => true, "/files/b");
    backend.dedicatedContext = true;
    expect(() => router.openStandardClient("a", { wholeContext: true })).toThrow(
      "exclusive saved profile",
    );
    const client = router.openStandardClient("a", { wholeContext: false });
    const attach = (await client.send({
      method: "Target.attachToTarget",
      parameters: { targetId: "root-a", flatten: true },
    })) as { sessionId: string };
    const { sessionId } = attach;
    const channel = backend.channels.get("root-a")!;
    for (const method of [
      "Storage.clearCookies",
      "Browser.resetPermissions",
      "Browser.setDownloadBehavior",
    ]) {
      await expect(client.send({ method })).rejects.toThrow(
        "requires a whole browser context grant",
      );
      await expect(client.send({ method, sessionId })).rejects.toThrow(
        "requires a whole browser context grant",
      );
    }
    await expect(client.send({ method: "Network.clearBrowserCookies", sessionId })).rejects.toThrow(
      "cannot be scoped",
    );
    await expect(client.send({ method: "Storage.clearDataForOrigin", sessionId })).rejects.toThrow(
      "cannot be scoped",
    );
    await expect(client.send({ method: "Browser.getHistograms" })).rejects.toThrow(
      "cannot be scoped",
    );
    await expect(
      client.send({ method: "Target.autoAttachRelated", parameters: { targetId: "root-a" } }),
    ).rejects.toThrow("cannot be scoped");
    await expect(
      client.send({
        method: "Target.sendMessageToTarget",
        parameters: {
          sessionId,
          message: JSON.stringify({ id: 1, method: "Storage.clearCookies" }),
        },
      }),
    ).rejects.toThrow("requires a whole browser context grant");
    expect(channel.commands).toEqual([]);
    expect(backend.commands.map(({ method }) => method)).toEqual(["Target.getTargetInfo"]);

    await router.unregisterSession("b");
    const granted = router.openStandardClient("a", { wholeContext: true });
    await expect(
      granted.send({
        method: "Browser.setDownloadBehavior",
        parameters: { behavior: "allowAndName", eventsEnabled: true, downloadPath: "/client/path" },
      }),
    ).resolves.toEqual({});
    await expect(
      granted.send({
        method: "Browser.setDownloadBehavior",
        parameters: { behavior: "allow", downloadPath: "/client/path" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      granted.send({
        method: "Browser.cancelDownload",
        parameters: { guid: "download-1" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(backend.commands.map(({ method }) => method)).toEqual(["Target.getTargetInfo"]);
    const flushed = Promise.withResolvers<unknown>();
    vi.spyOn(backend, "send").mockReturnValueOnce(flushed.promise);
    const clearing = expect(granted.send({ method: "Storage.clearCookies" })).rejects.toThrow(
      "CDP connection closed",
    );
    granted.close();
    await clearing;
    expect(router.hasExclusiveContextClient).toBe(true);
    flushed.resolve({});
    await granted.settled;
    expect(router.hasExclusiveContextClient).toBe(false);
    await router.close();
  });

  it("refuses Browser.setDownloadBehavior and Browser.cancelDownload with forbidden on non-standard agent sessions", async () => {
    const backend = new FakeBackend();
    backend.targetInfos = [{ targetId: "root-a", type: "page" }];
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "root-a", async () => true, "/files/a");
    const attached = (await router.send("a", {
      method: "Target.attachToTarget",
      parameters: { targetId: "root-a", flatten: true },
    })) as { sessionId: string };
    const channel = backend.channels.get("root-a")!;

    await expect(
      router.send("a", {
        method: "Browser.setDownloadBehavior",
        parameters: { behavior: "allow", downloadPath: "/tmp/agent" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      router.send("a", {
        method: "Browser.setDownloadBehavior",
        parameters: { behavior: "allowAndName", eventsEnabled: true, downloadPath: "/tmp/agent" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      router.send("a", {
        method: "Browser.setDownloadBehavior",
        sessionId: attached.sessionId,
        parameters: { behavior: "allow", downloadPath: "/tmp/agent" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      router.send("a", {
        method: "Browser.cancelDownload",
        parameters: { guid: "download-1" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      router.send("a", {
        method: "Browser.cancelDownload",
        sessionId: attached.sessionId,
        parameters: { guid: "download-1" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(backend.commands).toEqual([]);
    expect(channel.commands).toEqual([]);
    await router.close();
  });

  it("projects target metadata through current ownership and revokes descendants when the parent is released", async () => {
    const backend = new FakeBackend();
    const targetInfo = {
      targetId: "popup",
      type: "page",
      openerId: "root-a",
      openerFrameId: "root-a",
      parentId: "root-a",
      canAccessOpener: true,
    };
    backend.targetInfos = [
      { targetId: "root-a", type: "page" },
      targetInfo,
      { targetId: "worker", type: "worker" },
    ];
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "root-a", async () => true, "/files/a");
    router.registerSession("b", "root-b", async () => true, "/files/b");
    backend.emit("Target.targetCreated", { targetInfo });
    router.claimTarget("a", "popup");
    const { sessionId } = (await router.send("a", {
      method: "Target.attachToTarget",
      parameters: { targetId: "root-a" },
    })) as { sessionId: string };
    const events: CdpEvent[] = [];
    router.onEvent("a", (event) => events.push(event));
    const channel = backend.channels.get("root-a")!;
    const child = {
      sessionId: "physical-worker",
      targetInfo: { type: "worker", targetId: "worker" },
    };
    channel.emit("Target.attachedToTarget", {
      sessionId: "shared",
      targetInfo: { type: "shared_worker", targetId: "shared" },
    });
    expect(router.listOwnedTargets("a")).not.toContain("shared");
    expect(channel.commands.at(-1)).toMatchObject({ method: "Target.detachFromTarget" });
    channel.emit("Target.attachedToTarget", child);
    const childId = String(events.at(-1)?.parameters.sessionId);
    expect(router.listOwnedTargets("a")).toContain("worker");
    router.releaseTarget("a", "root-a");
    router.claimTarget("b", "root-a");
    expect(router.listOwnedTargets("a")).toEqual(["popup"]);
    await expect(
      router.send("a", { method: "Runtime.evaluate", sessionId: childId }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(router.send("a", { method: "Runtime.evaluate", sessionId })).rejects.toMatchObject(
      { code: "not_found" },
    );
    expect(backend.targetInfos.some((info) => info.targetId === "worker")).toBe(true);
    const acquired = (await router.send("b", {
      method: "Target.attachToTarget",
      parameters: { targetId: "root-a" },
    })) as { sessionId: string };
    backend.channels.get("root-a")!.emit("Target.attachedToTarget", child);
    expect(router.listOwnedTargets("b")).toContain("worker");
    expect(router.attachedTargetId("b", acquired.sessionId)).toBe("root-a");

    const clean = { targetId: "popup", type: "page", canAccessOpener: false };
    await expect(
      router.send("a", { method: "Target.getTargetInfo", parameters: { targetId: "popup" } }),
    ).resolves.toEqual({ targetInfo: clean });
    await expect(router.send("a", { method: "Target.getTargets" })).resolves.toMatchObject({
      targetInfos: [clean],
    });
    backend.emit("Target.targetInfoChanged", { targetInfo });
    expect(events.at(-1)?.parameters.targetInfo).toEqual(clean);
    const client = router.openStandardClient("a", { wholeContext: false });
    const replay: CdpEvent[] = [];
    client.onEvent((event) => replay.push(event));
    await client.send({ method: "Target.setDiscoverTargets", parameters: { discover: true } });
    expect(replay[0]?.parameters.targetInfo).toEqual({ ...clean, browserContextId: "a" });
    await router.close();
  });

  it("rejects delayed attach, target info and close under an earlier claim of the same target", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "root-a", async () => true, "/files/a");
    const opening = Promise.withResolvers<CdpChannel>();
    vi.spyOn(backend, "attach").mockReturnValueOnce(opening.promise);
    const info = Promise.withResolvers<unknown>();
    const closing = Promise.withResolvers<unknown>();
    vi.spyOn(backend, "send")
      .mockReturnValueOnce(info.promise)
      .mockReturnValueOnce(closing.promise);
    const attach = expect(
      router.send("a", { method: "Target.attachToTarget", parameters: { targetId: "root-a" } }),
    ).rejects.toThrow("target claim changed");
    const reading = expect(
      router.send("a", { method: "Target.getTargetInfo", parameters: { targetId: "root-a" } }),
    ).rejects.toThrow("target claim changed");
    const close = router.send("a", {
      method: "Target.closeTarget",
      parameters: { targetId: "root-a" },
    });
    router.releaseTarget("a", "root-a");
    router.registerSession("b", "root-b", async () => true, "/files/b");
    expect(() => router.claimTarget("b", "root-a")).toThrow("Previous CDP work still holds");
    expect(router.listOwnedTargets("b")).toEqual(["root-b"]);
    const stale = new FakeChannel();
    opening.resolve(stale);
    info.resolve({ targetInfo: { targetId: "root-a", type: "page" } });
    closing.resolve({ success: true });
    await Promise.all([attach, reading, expect(close).resolves.toEqual({ success: true })]);
    expect(stale.closed).toBe(true);
    expect(router.listOwnedTargets("a")).toEqual([]);
    await router.close();
  });

  it("keeps an adopted page if its automatic attachment fails", async () => {
    const backend = new FakeBackend();
    backend.targetInfos = [{ targetId: "root-a", type: "page" }];
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "root-a", async () => true, "/files/a");
    const adopted = Promise.withResolvers<void>();
    const adoption = Promise.withResolvers<boolean>();
    const client = router.openStandardClient("a", {
      wholeContext: false,
      adoptTarget: async (id) => {
        router.claimTarget("a", id);
        adopted.resolve();
        return adoption.promise;
      },
    });
    await client.send({
      method: "Target.setAutoAttach",
      parameters: { autoAttach: true, flatten: true },
    });
    const attach = vi.spyOn(backend, "attach").mockRejectedValueOnce(new Error("attach failed"));
    const created = expect(
      client.send({ method: "Target.createTarget", parameters: { url: "about:blank" } }),
    ).resolves.toEqual({ targetId: "created-1" });
    await adopted.promise;
    expect(attach).not.toHaveBeenCalled();
    adoption.resolve(true);
    await created;
    expect(backend.commands.some(({ method }) => method === "Target.closeTarget")).toBe(false);
    expect(router.listOwnedTargets("a")).toEqual(["root-a", "created-1"]);
    await router.close();
  });

  it("recovers a page when both adoption and Chromium rollback fail", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "root-a", async () => true, "/files/a");
    const send = backend.send.bind(backend);
    vi.spyOn(backend, "send").mockImplementation((method, params) =>
      method === "Target.closeTarget"
        ? Promise.reject(new Error("Chromium close failed"))
        : send(method, params),
    );
    const recover = vi.fn(async () => {});
    const client = router.openStandardClient("a", {
      wholeContext: false,
      adoptTarget: async () => false,
      recoverUnadoptedTarget: recover,
    });
    await expect(client.send({ method: "Target.createTarget" })).rejects.toThrow(
      "could not be adopted",
    );
    expect(recover).toHaveBeenCalledWith("created-1");
    expect(router.listOwnedTargets("a")).toEqual(["root-a"]);
    await router.close();
  });

  it("rejects unreviewed page methods and frame identifiers that name another Browser Session", async () => {
    const backend = new FakeBackend();
    backend.targetInfos = [
      { targetId: "root-a", type: "page" },
      { targetId: "root-b", type: "page" },
    ];
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "root-a", async () => true, "/files/a");
    router.registerSession("b", "root-b", async () => true, "/files/b");
    const client = router.openStandardClient("a", { wholeContext: false });
    const { sessionId } = (await client.send({
      method: "Target.attachToTarget",
      parameters: { targetId: "root-a", flatten: true },
    })) as { sessionId: string };
    await expect(
      client.send({
        method: "Page.navigate",
        sessionId,
        parameters: { url: "https://example.test", frameId: "root-b" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      client.send({
        method: "Network.loadNetworkResource",
        sessionId,
        parameters: { frameId: "root-b" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(backend.channels.get("root-a")?.commands).toEqual([]);
    await router.close();
  });

  it("limits shared workers to the exclusive client and removes a claim on the last detach", async () => {
    const backend = new FakeBackend();
    backend.dedicatedContext = true;
    backend.targetInfos = [
      { targetId: "root", type: "page" },
      { targetId: "worker", type: "shared_worker" },
    ];
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "root", async () => true, "/files/a");
    const owner = router.openStandardClient("a", { wholeContext: true });
    const observer = router.openStandardClient("a", { wholeContext: false });
    const ownerEvents: CdpEvent[] = [];
    const observerEvents: CdpEvent[] = [];
    const legacyEvents: CdpEvent[] = [];
    owner.onEvent((e) => ownerEvents.push(e));
    observer.onEvent((e) => observerEvents.push(e));
    router.onEvent("a", (e) => legacyEvents.push(e));
    const page = {
      method: "Target.attachToTarget",
      parameters: { targetId: "root", flatten: true },
    };
    await owner.send(page);
    const ownerPage = backend.channels.get("root")!;
    await observer.send(page);
    const observerPage = backend.channels.get("root")!;
    await router.send("a", page);
    const legacyPage = backend.channels.get("root")!;
    const targetInfo = { targetId: "worker", type: "shared_worker" };
    ownerPage.emit("Target.attachedToTarget", { targetInfo, sessionId: "one" });
    observerPage.emit("Target.attachedToTarget", { targetInfo, sessionId: "two" });
    legacyPage.emit("Target.attachedToTarget", { targetInfo, sessionId: "three" });
    expect(ownerEvents.filter((event) => event.sessionId)).toHaveLength(1);
    expect(observerEvents.filter((event) => event.sessionId)).toEqual([]);
    expect(legacyEvents).toEqual([]);
    await expect(
      observer.send({ method: "Target.getTargetInfo", parameters: { targetId: "worker" } }),
    ).rejects.toMatchObject({ code: "forbidden" });
    ownerPage.emit("Target.detachedFromTarget", { sessionId: "one", targetId: "worker" });
    expect(router.listOwnedTargets("a")).toEqual(["root"]);
    await expect(
      owner.send({ method: "Target.getTargetInfo", parameters: { targetId: "worker" } }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await router.close();
  });

  it("keeps the physical parent channel until pending child work is acknowledged", async () => {
    const backend = new FakeBackend();
    backend.dedicatedContext = true;
    backend.targetInfos = [{ targetId: "root", type: "page" }];
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "root", async () => true, "/files/a");
    const client = router.openStandardClient("a", { wholeContext: true });
    const child = Promise.withResolvers<string>();
    client.onEvent((event) => {
      if (event.method === "Target.attachedToTarget" && event.sessionId)
        child.resolve(String(event.parameters.sessionId));
    });
    await client.send({ method: "Target.attachToTarget", parameters: { targetId: "root" } });
    const channel = backend.channels.get("root")!;
    channel.emit("Target.attachedToTarget", {
      targetInfo: { targetId: "worker", type: "worker" },
      sessionId: "physical-worker",
    });
    const { promise: childSession } = child;
    const command = expect(
      client.send({ method: "Runtime.evaluate", sessionId: await childSession }),
    ).rejects.toThrow("CDP connection closed");
    const { id } = JSON.parse(String(channel.commands.at(-1)?.parameters?.message));
    expect(id).toBe(1);
    client.close();
    await command;
    expect(channel.closed).toBe(false);
    expect(router.hasExclusiveContextClient).toBe(true);
    channel.emit("Target.receivedMessageFromTarget", {
      sessionId: "physical-worker",
      message: JSON.stringify({ id, result: {} }),
    });
    await client.settled;
    expect(channel.closed).toBe(true);
    expect(router.hasExclusiveContextClient).toBe(false);
    await router.close();
  });

  it("keeps legacy byte-valid results and events and leaves logical detach silent", async () => {
    const backend = new FakeBackend();
    backend.targetInfos = [{ targetId: "root", type: "page" }];
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "root", async () => true, "/files/a");
    const { sessionId } = (await router.send("a", {
      method: "Target.attachToTarget",
      parameters: { targetId: "root" },
    })) as { sessionId: string };
    const events: CdpEvent[] = [];
    router.onEvent("a", (e) => events.push(e));
    const channel = backend.channels.get("root")!;
    const deep = Array.from({ length: 64 }).reduce<unknown>((child) => ({ child }), 1);
    channel.results.set("Runtime.evaluate", { deep });
    channel.emit("Runtime.bindingCalled", { deep });
    await expect(router.send("a", { method: "Runtime.evaluate", sessionId })).resolves.toEqual({
      deep,
    });
    await expect(
      router.send("a", {
        method: "Page.navigate",
        sessionId,
        parameters: { url: "about:blank" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await router.send("a", { method: "Target.detachFromTarget", parameters: { sessionId } });
    expect(events).toEqual([
      { method: "Runtime.bindingCalled", parameters: { deep }, sequence: 1, sessionId },
    ]);
    await router.close();
  });

  it("bounds legacy retired target records across repeated release and adoption", async () => {
    const router = new SessionCdpRouter(new FakeBackend());
    router.registerSession("a", "root-a", async () => true, "/files/a");
    let first: string | undefined;
    let last: string | undefined;
    for (let index = 0; index <= 256; index++) {
      const { sessionId } = (await router.send("a", {
        method: "Target.attachToTarget",
        parameters: { targetId: "root-a" },
      })) as { sessionId: string };
      router.releaseTarget("a", "root-a");
      router.claimTarget("a", "root-a");
      first ??= sessionId;
      last = sessionId;
    }
    expect(router.attachedTargetId("a", first!)).toBeNull();
    expect(router.attachedTargetId("a", last!)).toBe("root-a");
    await router.close();
  });

  it("discards nested responses after the parent refuses their send", async () => {
    const backend = new FakeBackend();
    backend.protectProductWorlds = true;
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "root-a", async () => true, "/files/a");
    await router.send("a", { method: "Target.attachToTarget", parameters: { targetId: "root-a" } });
    const childSession = Promise.withResolvers<string>();
    router.onEvent("a", (event) => {
      if (event.method === "Target.attachedToTarget")
        childSession.resolve(String(event.parameters.sessionId));
    });
    const channel = backend.channels.get("root-a")!;
    channel.emit("Target.attachedToTarget", {
      sessionId: "worker",
      targetInfo: { targetId: "worker", type: "worker" },
    });
    const sessionId = await childSession.promise;
    const send = vi.spyOn(channel, "send").mockRejectedValueOnce(new Error("parent refused"));
    await expect(router.send("a", { method: "Runtime.compileScript", sessionId })).rejects.toThrow(
      "parent refused",
    );
    const nested = JSON.parse(String(send.mock.calls[0]?.[1]?.message)) as { id: number };
    channel.emit("Target.receivedMessageFromTarget", {
      sessionId: "worker",
      message: JSON.stringify({ id: nested.id, result: { scriptId: "late" } }),
    });
    await expect(
      router.send("a", {
        method: "Runtime.runScript",
        sessionId,
        parameters: { scriptId: "late" },
      }),
    ).rejects.toThrow("cannot reach Opensteer's preload");
    await router.close();
  });

  it("routes both activation commands to session selection without activating the engine", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend);
    const activate = vi.fn(async () => true);
    router.registerSession("session-a", "root-a", activate, "/opensteer-files/session-a");
    const attached = (await router.send("session-a", {
      method: "Target.attachToTarget",
      parameters: { targetId: "root-a" },
    })) as { sessionId: string };

    await expect(
      router.send("session-a", {
        method: "Target.activateTarget",
        parameters: { targetId: "root-a" },
      }),
    ).resolves.toEqual({});
    await expect(
      router.send("session-a", { method: "Page.bringToFront", sessionId: attached.sessionId }),
    ).resolves.toEqual({});
    expect(activate.mock.calls).toEqual([["root-a"], ["root-a"]]);
    expect(backend.commands).toEqual([]);
    expect(backend.channels.get("root-a")?.commands).toEqual([]);
    await router.close();
  });

  it("keeps activation scoped and rejects stale channels and missing surfaces", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend);
    const activate = vi.fn(async () => false);
    const activateOther = vi.fn(async () => true);
    router.registerSession("session-a", "root-a", activate, "/opensteer-files/session-a");
    router.registerSession("session-b", "root-b", activateOther, "/opensteer-files/session-b");
    const attached = (await router.send("session-a", {
      method: "Target.attachToTarget",
      parameters: { targetId: "root-a" },
    })) as { sessionId: string };

    await expect(
      router.send("session-b", { method: "Page.bringToFront", sessionId: attached.sessionId }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      router.send("session-a", {
        method: "Target.activateTarget",
        parameters: { targetId: "root-b" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(activate).not.toHaveBeenCalled();
    expect(activateOther).not.toHaveBeenCalled();
    await expect(
      router.send("session-a", { method: "Page.bringToFront", sessionId: attached.sessionId }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      router.send("session-a", {
        method: "Target.activateTarget",
        parameters: { targetId: "root-a" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    backend.emit("Target.targetDestroyed", { targetId: "root-a" });
    activate.mockClear();
    await expect(
      router.send("session-a", { method: "Page.bringToFront", sessionId: attached.sessionId }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(activate).not.toHaveBeenCalled();
    expect(backend.commands).toEqual([]);
    await router.close();
  });

  it("acknowledges activation only after selection completes and propagates failures", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend);
    const selection = Promise.withResolvers<boolean>();
    const activate = vi.fn(() => selection.promise);
    router.registerSession("session-a", "root-a", activate, "/opensteer-files/session-a");
    let acknowledged = false;
    const command = {
      method: "Target.activateTarget",
      parameters: { targetId: "root-a" },
    };
    const pending = router.send("session-a", command).then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    selection.resolve(true);
    await pending;
    expect(acknowledged).toBe(true);

    activate.mockRejectedValueOnce(new Error("selection closed"));
    await expect(router.send("session-a", command)).rejects.toThrow("selection closed");
    expect(backend.commands).toEqual([]);
    await router.close();
  });

  it("exposes only targets owned by the requesting session", async () => {
    const backend = new FakeBackend();
    backend.targetInfos = [
      { targetId: "root-a", type: "page" },
      { targetId: "root-b", type: "page" },
      { targetId: "unowned", type: "page" },
    ];
    const router = new SessionCdpRouter(backend);
    router.registerSession("session-a", "root-a", async () => true, "/opensteer-files/session-a");
    router.registerSession("session-b", "root-b", async () => true, "/opensteer-files/session-b");

    await expect(router.send("session-a", { method: "Target.getTargets" })).resolves.toEqual({
      rootTargetId: "root-a",
      targetInfos: [{ targetId: "root-a", type: "page" }],
    });
    await expect(
      router.send("session-a", {
        method: "Target.activateTarget",
        parameters: { targetId: "root-b" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("retains a released attachment's target for lifecycle refusal without retaining its channel", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend);
    router.registerSession("session-a", "root-a", async () => true, "/opensteer-files/session-a");
    const { sessionId } = (await router.send("session-a", {
      method: "Target.attachToTarget",
      parameters: { targetId: "root-a" },
    })) as { sessionId: string };
    router.releaseTarget("session-a", "root-a");
    expect(router.attachedTargetId("session-a", sessionId)).toBe("root-a");
    expect(router.attachedTargetId("session-b", sessionId)).toBeNull();
    expect(backend.channels.get("root-a")?.closed).toBe(true);
    await expect(
      router.send("session-a", {
        method: "Runtime.evaluate",
        sessionId,
        parameters: { expression: "true" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await router.send("session-a", {
      method: "Target.detachFromTarget",
      parameters: { sessionId },
    });
    expect(router.attachedTargetId("session-a", sessionId)).toBeNull();
    await router.close();
  });

  it("retains the initial target identity after that page closes", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend);
    router.registerSession("session-a", "root-a", async () => true, "/opensteer-files/session-a");
    backend.emit("Target.targetDestroyed", { targetId: "root-a" });
    const created = (await router.send("session-a", {
      method: "Target.createTarget",
      parameters: { url: "about:blank" },
    })) as { targetId: string };
    await expect(router.send("session-a", { method: "Target.getTargets" })).resolves.toEqual({
      rootTargetId: "root-a",
      targetInfos: [expect.objectContaining({ targetId: created.targetId })],
    });
    await router.close();
  });

  it("claims created targets, popups, and related workers for their parent session", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend);
    router.registerSession("session-a", "root-a", async () => true, "/opensteer-files/session-a");
    const created = (await router.send("session-a", {
      method: "Target.createTarget",
      parameters: { url: "about:blank" },
    })) as { targetId: string };
    backend.emit("Target.targetCreated", {
      targetInfo: { openerId: created.targetId, targetId: "popup-a", type: "page" },
    });
    backend.emit("Target.targetCreated", {
      targetInfo: { parentId: "popup-a", targetId: "worker-a", type: "worker" },
    });
    expect(router.listOwnedTargets("session-a")).toEqual([
      "root-a",
      created.targetId,
      "popup-a",
      "worker-a",
    ]);
  });

  it("maps attached channels to virtual session IDs and streams correlated events", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend);
    router.registerSession("session-a", "root-a", async () => true, "/opensteer-files/session-a");
    const attached = (await router.send("session-a", {
      method: "Target.attachToTarget",
      parameters: { flatten: true, targetId: "root-a" },
    })) as { sessionId: string };
    expect(attached.sessionId).toMatch(/^cdp_/);
    await expect(
      router.send("session-a", {
        method: "Runtime.evaluate",
        parameters: { expression: "document.title" },
        sessionId: attached.sessionId,
      }),
    ).resolves.toEqual({ method: "Runtime.evaluate" });
    const events: import("./session-cdp-router.js").CdpEvent[] = [];
    router.onEvent("session-a", (event) => events.push(event));
    await router.send("session-a", { method: "Runtime.enable", sessionId: attached.sessionId });
    backend.channels
      .get("root-a")
      ?.emit("Runtime.consoleAPICalled", { args: [], executionContextId: 1, type: "log" });
    expect(events).toEqual([
      {
        method: "Runtime.executionContextCreated",
        parameters: { context: frameWorld(1) },
        sequence: 1,
        sessionId: attached.sessionId,
      },
      {
        method: "Runtime.consoleAPICalled",
        parameters: { args: [], executionContextId: 1, type: "log" },
        sequence: 2,
        sessionId: attached.sessionId,
      },
    ]);
  });

  it("does not expose browser-process destructive commands", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend);
    router.registerSession("session-a", "root-a", async () => true, "/opensteer-files/session-a");
    await expect(router.send("session-a", { method: "Browser.close" })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(backend.commands).toEqual([]);
  });

  it("keeps Browser Runtime files outside the session-scoped CDP capability", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend);
    router.registerSession("session-a", "root-a", async () => true, "/opensteer-files/session-a");
    const attached = (await router.send("session-a", {
      method: "Target.attachToTarget",
      parameters: { flatten: true, targetId: "root-a" },
    })) as { sessionId: string };

    await expect(
      router.send("session-a", {
        method: "Page.navigate",
        parameters: { url: "file:///etc/passwd" },
        sessionId: attached.sessionId,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      router.send("session-a", {
        method: "DOM.setFileInputFiles",
        parameters: { files: ["/etc/passwd"], nodeId: 1 },
        sessionId: attached.sessionId,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      router.send("session-a", {
        method: "Target.createTarget",
        parameters: { url: "file:///etc/passwd" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(backend.channels.get("root-a")?.commands).toEqual([]);
  });

  it("applies the browser frame allocation limit to raw attached CDP", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend);
    router.registerSession("session-a", "root-a", async () => true, "/opensteer-files/session-a");
    const attached = (await router.send("session-a", {
      method: "Target.attachToTarget",
      parameters: { flatten: true, targetId: "root-a" },
    })) as { sessionId: string };

    await expect(
      router.send("session-a", {
        method: "Emulation.setDeviceMetricsOverride",
        parameters: { deviceScaleFactor: 4, height: 4_320, mobile: false, width: 7_680 },
        sessionId: attached.sessionId,
      }),
    ).rejects.toMatchObject({ code: "bad_command" });
    await expect(
      router.send("session-a", {
        method: "Page.startScreencast",
        parameters: { maxHeight: 20_000, maxWidth: 40_000 },
        sessionId: attached.sessionId,
      }),
    ).rejects.toMatchObject({ code: "bad_command" });
    await expect(
      router.send("session-a", {
        method: "Emulation.setDeviceMetricsOverride",
        parameters: { deviceScaleFactor: 1, height: 600, mobile: false, width: 800 },
        sessionId: attached.sessionId,
      }),
    ).resolves.toEqual({ method: "Emulation.setDeviceMetricsOverride" });
    expect(backend.channels.get("root-a")?.commands.map((command) => command.method)).toEqual([
      "Emulation.setDeviceMetricsOverride",
    ]);
  });

  it("owns target 129 including a popup and registers session 65", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend);
    try {
      router.registerSession("session-0", "root-0", async () => true, "/files/0");
      backend.targetInfos.push({ targetId: "root-0", type: "page", url: "about:blank" });
      for (let index = 1; index < 128; index++)
        await router.send("session-0", { method: "Target.createTarget" });
      backend.targetInfos.push({
        targetId: "popup-129",
        type: "page",
        url: "about:blank",
        openerId: "root-0",
      });
      backend.emit("Target.targetCreated", { targetInfo: backend.targetInfos.at(-1)! });
      await expect(
        router.send("session-0", {
          method: "Target.attachToTarget",
          parameters: { targetId: "popup-129" },
        }),
      ).resolves.toMatchObject({ sessionId: expect.any(String) });
      for (let index = 1; index < 65; index++)
        router.registerSession(
          `session-${index}`,
          `root-${index}`,
          async () => true,
          `/files/${index}`,
        );
      await expect(
        router.send("session-64", {
          method: "Target.attachToTarget",
          parameters: { targetId: "popup-129" },
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      const targets = (await router.send("session-0", { method: "Target.getTargets" })) as {
        targetInfos: unknown[];
      };
      expect(targets.targetInfos).toHaveLength(129);
    } finally {
      await router.close();
    }
  });

  it("bounds command, result and event bytes", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend, {
      maxCommandBytes: 200,
      maxEventBytes: 300,
      maxResultBytes: 200,
    });
    router.registerSession("session-a", "root-a", async () => true, "/opensteer-files/session-a");
    const events: import("./session-cdp-router.js").CdpEvent[] = [];
    router.onEvent("session-a", (event) => events.push(event));
    backend.emit("Target.targetInfoChanged", {
      targetInfo: { targetId: "root-a", title: "one" },
    });
    backend.emit("Target.targetInfoChanged", {
      targetInfo: { targetId: "root-a", title: "two" },
    });
    backend.emit("Target.targetInfoChanged", {
      targetInfo: { targetId: "root-a", title: "three" },
    });
    expect(events).toHaveLength(3);
    backend.emit("Target.targetInfoChanged", {
      targetInfo: { targetId: "root-a", title: "x".repeat(500) },
    });
    expect(events).toHaveLength(3);
    await expect(
      router.send("session-a", {
        method: "Runtime.evaluate",
        parameters: { expression: "x".repeat(500) },
      }),
    ).rejects.toMatchObject({ code: "too_large" });
  });
});

describe("full page CDP with routing isolation", () => {
  async function fixture() {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "root-a", async () => true, "/files/a");
    router.registerSession("b", "root-b", async () => true, "/files/b");
    const { sessionId } = (await router.send("a", {
      method: "Target.attachToTarget",
      parameters: { targetId: "root-a" },
    })) as { sessionId: string };
    const channel = backend.channels.get("root-a")!;
    const events: import("./session-cdp-router.js").CdpEvent[] = [];
    router.onEvent("a", (event) => events.push(event));
    const send = (method: string, parameters?: CdpParameters) =>
      router.send("a", { method, ...(parameters ? { parameters } : {}), sessionId });
    return { backend, router, sessionId, channel, events, send };
  }
  it("forwards Network, Log, cookies, storage, isolated worlds and new domains without a policy inventory", async () => {
    const f = await fixture();
    f.channel.contexts.push(isolatedWorld(2));
    for (const [method, parameters] of [
      ["Network.enable", {}],
      ["Network.getAllCookies", {}],
      ["Storage.getCookies", {}],
      ["Log.enable", {}],
      ["Runtime.enable", {}],
      ["Runtime.evaluate", { contextId: 2, expression: "42" }],
      ["Page.createIsolatedWorld", { frameId: "frame", worldName: "agent-world" }],
      ["FutureDomain.doSomething", { futureParameter: true }],
    ] as const)
      await f.send(method, parameters);
    for (const method of [
      "Network.requestWillBeSent",
      "Log.entryAdded",
      "Runtime.consoleAPICalled",
      "FutureDomain.created",
    ])
      f.channel.emit(method, { executionContextId: 2, object: { objectId: "1.2.3" } });
    expect(f.events.some((event) => asContext(event)?.id === 2)).toBe(true);
    expect(f.events.slice(-4).map((event) => event.method)).toEqual([
      "Network.requestWillBeSent",
      "Log.entryAdded",
      "Runtime.consoleAPICalled",
      "FutureDomain.created",
    ]);
    await f.router.close();
  });
  it("uses command classification only for attribution, with unknown commands treated as effects", async () => {
    const f = await fixture();
    const activity = vi.fn();
    await f.router.send("a", { method: "Network.getAllCookies", sessionId: f.sessionId }, activity);
    expect(activity).not.toHaveBeenCalled();
    await f.router.send("a", { method: "FutureDomain.effect", sessionId: f.sessionId }, activity);
    expect(activity).toHaveBeenCalledWith("root-a");
    expect(f.channel.commands.map((command) => command.method)).toEqual([
      "Network.getAllCookies",
      "FutureDomain.effect",
    ]);
    await f.router.close();
  });
  it("virtualizes OOPIF and worker attachments under the admitted page and closes all channels on Stop", async () => {
    const f = await fixture();
    await f.send("Target.setAutoAttach", {
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: false,
    });
    expect(f.channel.commands.at(-1)?.parameters?.flatten).toBe(false);
    f.channel.emit("Target.attachedToTarget", {
      sessionId: "physical-child",
      targetInfo: { type: "iframe", targetId: "child" },
    });
    const childId = String(f.events.at(-1)?.parameters.sessionId);
    expect(childId).toMatch(/^cdp_/);
    const sent = f.router.send("a", { method: "Network.enable", sessionId: childId });
    const nested = f.channel.commands.at(-1)!;
    expect(nested.method).toBe("Target.sendMessageToTarget");
    const message = JSON.parse(String(nested.parameters?.message)) as { id: number };
    f.channel.emit("Target.receivedMessageFromTarget", {
      sessionId: "physical-child",
      message: JSON.stringify({ id: message.id, result: {} }),
    });
    await expect(sent).resolves.toEqual({});
    f.channel.emit("Target.receivedMessageFromTarget", {
      sessionId: "physical-child",
      message: JSON.stringify({
        method: "Network.loadingFinished",
        params: { requestId: "child-request" },
      }),
    });
    expect(f.events.at(-1)).toMatchObject({
      method: "Network.loadingFinished",
      sessionId: childId,
    });
    await expect(
      f.router.send("b", { method: "Runtime.evaluate", sessionId: childId }),
    ).rejects.toMatchObject({ code: "not_found" });
    const pending = f.router.send("a", { method: "Runtime.evaluate", sessionId: childId });
    const rejection = expect(pending).rejects.toMatchObject({ code: "not_found" });
    await f.router.unregisterSession("a");
    await rejection;
    expect(f.channel.closed).toBe(true);
    await expect(f.send("Network.enable")).rejects.toMatchObject({ code: "not_found" });
    await f.router.close();
  });
  it("rejects foreign targets, sessions and shared-engine control regardless of the command's domain", async () => {
    const f = await fixture();
    for (const method of ["Target.attachToTarget", "Target.closeTarget", "FutureDomain.inspect"])
      await expect(f.send(method, { targetId: "root-b" })).rejects.toMatchObject({
        code: "forbidden",
      });
    await expect(f.send("Browser.close")).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.router.send("a", {
        method: "Target.sendMessageToTarget",
        parameters: {
          sessionId: f.sessionId,
          message: JSON.stringify({
            id: 1,
            method: "Target.exposeDevToolsProtocol",
            params: { targetId: "root-a" },
          }),
        },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      f.send("Target.exposeDevToolsProtocol", { targetId: "root-a" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(f.send("Target.attachToBrowserTarget")).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(f.channel.commands).toEqual([]);
    await f.router.close();
  });

  it("allows Page.screencastFrameAck with a numeric screencast sessionId while still rejecting foreign target sessionIds", async () => {
    const f = await fixture();
    await expect(f.send("Page.screencastFrameAck", { sessionId: 49 })).resolves.toEqual({
      method: "Page.screencastFrameAck",
    });
    expect(f.channel.commands).toEqual([
      { method: "Page.screencastFrameAck", parameters: { sessionId: 49 } },
    ]);
    await expect(
      f.send("Page.screencastFrameAck", { sessionId: "foreign-session" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(f.send("Target.sendMessageToTarget", { sessionId: 49 })).rejects.toMatchObject({
      code: "forbidden",
    });
    await f.router.close();
  });
});
function asContext(event: import("./session-cdp-router.js").CdpEvent) {
  return event.method === "Runtime.executionContextCreated"
    ? (event.parameters.context as { id: number })
    : null;
}
