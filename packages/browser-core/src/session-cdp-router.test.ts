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
  extensions = false;
  /** The newest channel opened on each target. */
  readonly channels = new Map<string, FakeChannel>();
  readonly commands: { method: string; parameters?: CdpParameters }[] = [];
  readonly listeners = new Set<(method: string, parameters: CdpParameters) => void>();
  /** Shapes each channel before the router sees it. */
  prepareChannel: (channel: FakeChannel, targetId: string) => void = () => undefined;
  setConnectionControlled?: (targetId: string, controlled: boolean) => void;
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
  it("refuses an answer over its limit naming the answer's size, the limit and how to ask for less", () => {
    const router = new SessionCdpRouter(new FakeBackend());
    const refusal = (() => {
      try {
        router.admitPageResult({ value: "x".repeat(600 * 1_024) });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(refusal).toMatchObject({
      code: "too_large",
      // The command ran: a failure of it, never an unknown outcome.
      answerTooLarge: true,
      message:
        "The page ran the command, but its answer is 601 KiB, over the 432 KiB limit for one answer, so it exceeds the bounded agent transport and was dropped. Ask the page for less: a slice of the text, an element by selector, or innerText instead of the HTML. If the command changed the page, do not run it again.",
    });
    // An answer too deep to measure says so instead of a size.
    let deep: unknown = "end";
    for (let level = 0; level < 40; level++) deep = [deep];
    expect(() =>
      router.admitPageResult(deep, { maxBytes: Infinity, maxDepth: 32, maxEntries: 16_384 }),
    ).toThrow(
      "The page ran the command, but its answer is too deeply nested or has too many entries, so it exceeds the bounded agent transport and was dropped.",
    );
    expect(() => router.admitPageResult({ value: "x".repeat(1_024) })).not.toThrow();
  });

  it("puts a tab the runtime woke in the place its slept target held in each lineage, only when the tab itself woke, and never after a close (run 12)", async () => {
    const backend = new FakeBackend();
    backend.dedicatedContext = true;
    backend.targetInfos = ["person", "seed", "sibling"].map((targetId) => ({
      targetId,
      type: "page",
    }));
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "person", async () => true, "/files/a");
    router.claimTarget("a", "seed");
    router.claimTarget("a", "sibling");
    const client = router.openStandardClient("a", {
      wholeContext: false,
      connection: true,
      lineage: { attachmentId: "first", seedTargetId: "seed" },
    });
    const other = router.openStandardClient("a", {
      wholeContext: false,
      connection: true,
      lineage: { attachmentId: "second", seedTargetId: "sibling" },
    });
    const reach = (attachment: typeof client, targetId: string) =>
      attachment
        .send({ method: "Target.attachToTarget", parameters: { targetId, flatten: true } })
        .then(
          () => true,
          (error: unknown) => (error as { code?: string }).code ?? error,
        );
    const page = (targetId: string) => backend.targetInfos.push({ targetId, type: "page" });
    expect(await reach(client, "seed")).toBe(true);

    // The runtime puts the seed to sleep and wakes the tab itself: the woken target is in its place.
    router.releaseTarget("a", "seed", true);
    page("seed-woken");
    router.claimTarget("a", "seed-woken", undefined, { from: "seed", itself: true });
    expect(await reach(client, "seed-woken")).toBe(true);
    expect(await reach(other, "seed-woken")).toBe("forbidden");
    expect(await reach(other, "sibling")).toBe(true);
    // The place is taken once: a second claim naming the same slept target gains nothing.
    page("seed-dup");
    router.claimTarget("a", "seed-dup", undefined, { from: "seed", itself: true });
    expect(await reach(client, "seed-dup")).toBe("forbidden");

    // A page claimed with no wake, or naming a target that never slept in this lineage, gains nothing.
    page("stranger");
    router.claimTarget("a", "stranger", undefined, { from: "person", itself: true });
    expect(await reach(client, "stranger")).toBe("forbidden");

    // A wake that ends at the address is a new page: the slept place goes, nothing takes it.
    router.releaseTarget("a", "seed-woken", true);
    page("seed-fresh");
    router.claimTarget("a", "seed-fresh", undefined, { from: "seed-woken", itself: false });
    expect(await reach(client, "seed-fresh")).toBe("forbidden");
    page("seed-late");
    router.claimTarget("a", "seed-late", undefined, { from: "seed-woken", itself: true });
    expect(await reach(client, "seed-late")).toBe("forbidden");

    // An id reused by another page clears a place kept under it: that page sleeping and waking
    // gives the lineage nothing.
    page("kept");
    router.claimTarget("a", "kept");
    const third = router.openStandardClient("a", {
      wholeContext: false,
      connection: true,
      lineage: { attachmentId: "third", seedTargetId: "kept" },
    });
    router.releaseTarget("a", "kept", true);
    router.claimTarget("a", "kept");
    router.releaseTarget("a", "kept", true);
    page("kept-woken");
    router.claimTarget("a", "kept-woken", undefined, { from: "kept", itself: true });
    expect(await reach(third, "kept-woken")).toBe("forbidden");

    // A sleeping tab closed: its place ends, and no later page takes it.
    router.releaseTarget("a", "sibling", true);
    router.releaseTarget("a", "sibling");
    page("sibling-after");
    router.claimTarget("a", "sibling-after", undefined, { from: "sibling", itself: true });
    expect(await reach(other, "sibling-after")).toBe("forbidden");
  });

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

  it("sends the Extensions domain to the profile's browser, from a page session too", async () => {
    const backend = new FakeBackend();
    backend.extensions = true;
    const router = new SessionCdpRouter(backend);
    router.registerSession("session-a", "root-a", async () => true, "/opensteer-files/session-a");
    const attached = (await router.send("session-a", {
      method: "Target.attachToTarget",
      parameters: { flatten: true, targetId: "root-a" },
    })) as { sessionId: string };

    await router.send("session-a", {
      method: "Extensions.loadUnpacked",
      parameters: { path: "/work/extension" },
      sessionId: attached.sessionId,
      manageExtensions: true,
    });
    await router.send("session-a", {
      method: "Extensions.triggerAction",
      parameters: { id: "abcdefghijklmnopabcdefghijklmnop" },
      sessionId: attached.sessionId,
    });
    // Browser-scope Extensions.triggerAction defaults to this session's root target, never another session's active tab.
    await router.send("session-a", {
      method: "Extensions.triggerAction",
      parameters: { id: "abcdefghijklmnopabcdefghijklmnop" },
    });
    await router.send("session-a", { method: "Extensions.getExtensions" });

    expect(backend.commands).toEqual([
      { method: "Extensions.loadUnpacked", parameters: { path: "/work/extension" } },
      {
        method: "Extensions.triggerAction",
        parameters: { id: "abcdefghijklmnopabcdefghijklmnop", targetId: "root-a" },
      },
      {
        method: "Extensions.triggerAction",
        parameters: { id: "abcdefghijklmnopabcdefghijklmnop", targetId: "root-a" },
      },
      { method: "Extensions.getExtensions", parameters: undefined },
    ]);
    expect(backend.channels.get("root-a")?.commands).toEqual([]);
  });

  it("refuses the Extensions domain for a foreign attachment, foreign targetId, or a browser without extensions", async () => {
    const backend = new FakeBackend();
    backend.extensions = true;
    const router = new SessionCdpRouter(backend);
    router.registerSession("session-a", "root-a", async () => true, "/opensteer-files/session-a");
    await expect(
      router.send("session-a", { method: "Extensions.getExtensions", sessionId: "foreign" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      router.send("session-a", {
        method: "Extensions.triggerAction",
        parameters: { id: "abcdefghijklmnopabcdefghijklmnop", targetId: "foreign-target" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      router.send("session-a", {
        method: "Extensions.triggerAction",
        parameters: { id: "abcdefghijklmnopabcdefghijklmnop", targetId: 123 },
      }),
    ).rejects.toMatchObject({ code: "bad_command" });
    backend.extensions = false;
    await expect(
      router.send("session-a", { method: "Extensions.getExtensions" }),
    ).rejects.toMatchObject({
      code: "bad_command",
    });
    expect(backend.commands).toEqual([]);
  });

  it("lets a page navigate to extension pages", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend);
    router.registerSession("session-a", "root-a", async () => true, "/opensteer-files/session-a");
    const attached = (await router.send("session-a", {
      method: "Target.attachToTarget",
      parameters: { flatten: true, targetId: "root-a" },
    })) as { sessionId: string };

    await router.send("session-a", {
      method: "Page.navigate",
      parameters: { url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html" },
      sessionId: attached.sessionId,
    });

    expect(backend.channels.get("root-a")?.commands).toContainEqual(
      expect.objectContaining({ method: "Page.navigate" }),
    );
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

describe("SessionCdpRouter clipboard and browser permissions", () => {
  const sentence =
    "The clipboard is not available to a connected agent. Use Input.insertText to enter text.";
  const permissionSentence = "Browser permissions cannot be changed by a connected agent.";
  const clipboardGrantSentence =
    "Clipboard permissions cannot be granted to a page. Paste with a key chord, or use Input.insertText to enter text.";
  const cmdV = {
    type: "rawKeyDown",
    modifiers: 4,
    key: "v",
    code: "KeyV",
    windowsVirtualKeyCode: 86,
  };
  const refused = [
    ["Cmd+V stated", { ...cmdV, commands: ["paste"] }],
    ["Cmd+V inferred", { ...cmdV, nativeVirtualKeyCode: 9 }],
    [
      "pasteAndMatchStyle",
      { type: "keyDown", key: "v", code: "KeyV", commands: ["pasteAndMatchStyle"] },
    ],
    ["Cmd+C inferred", { type: "rawKeyDown", modifiers: 4, key: "c", code: "KeyC" }],
    ["Cmd+X inferred", { type: "rawKeyDown", modifiers: 4, key: "x", code: "KeyX" }],
    ["Ctrl+V, Blink's own binding", { type: "keyDown", modifiers: 2, key: "v", code: "KeyV" }],
    ["Ctrl+Shift+V", { type: "keyDown", modifiers: 10, key: "V", code: "KeyV" }],
    ["Shift+Insert", { type: "rawKeyDown", modifiers: 8, key: "Insert", code: "Insert" }],
    ["Ctrl+Insert", { type: "rawKeyDown", modifiers: 2, windowsVirtualKeyCode: 45 }],
    ["Shift+Delete", { type: "rawKeyDown", modifiers: 8, key: "Delete", code: "Delete" }],
    [
      "a paste key code behind another key",
      { type: "rawKeyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 86 },
    ],
    ["a Cocoa selector", { type: "keyDown", key: "c", commands: ["Copy:"] }],
  ] as const;
  /** Grants of a clipboard permission: nobody sends them. */
  const clipboardGrants = [
    ["Browser.grantPermissions", { permissions: ["geolocation", "clipboardReadWrite"] }],
    ["Browser.grantPermissions", { permissions: ["clipboardSanitizedWrite"] }],
    ["Browser.setPermission", { permission: { name: "clipboard-read" }, setting: "granted" }],
    ["Browser.setPermission", { permission: { name: "clipboard-write" }, setting: "prompt" }],
  ] as const;
  /** Every other permission change: a person's own agent keeps them, a connection does not. */
  const otherPermissions = [
    ["Browser.grantPermissions", { permissions: ["audioCapture"] }],
    ["Browser.grantPermissions", { permissions: ["videoCapture"] }],
    ["Browser.grantPermissions", { permissions: ["geolocation"] }],
    ["Browser.setPermission", { permission: { name: "geolocation" }, setting: "granted" }],
    ["Browser.setPermission", { permission: { name: "clipboard-read" }, setting: "denied" }],
    ["Browser.resetPermissions", {}],
  ] as const;

  async function attached(connection: boolean, kind: "standard" | "script") {
    const backend = new FakeBackend();
    backend.dedicatedContext = true;
    backend.targetInfos = [{ targetId: "seed", type: "page" }];
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "seed", async () => true, "/files/a");
    let send: (command: CdpCommand) => Promise<unknown>;
    if (kind === "standard") {
      const client = router.openStandardClient("a", {
        wholeContext: true,
        ...(connection
          ? { connection, lineage: { attachmentId: "agent", seedTargetId: "seed" } }
          : {}),
      });
      send = (command) => client.send(command);
    } else {
      const budget = { maxBytes: 64 * 1024, maxDepth: 16, maxEntries: 1024 };
      router.openScriptAttachment(
        "a",
        "script",
        "seed",
        budget,
        () => undefined,
        connection ? { connection } : {},
      );
      send = (command) => router.send("a", { ...command, scriptAttachmentId: "script" });
    }
    const { sessionId } = (await send({
      method: "Target.attachToTarget",
      parameters: { targetId: "seed", flatten: true },
    })) as { sessionId: string };
    const channel = backend.channels.get("seed")!;
    const key = (parameters: CdpParameters) =>
      send({ method: "Input.dispatchKeyEvent", parameters, sessionId });
    return { backend, router, channel, send, key, sessionId };
  }

  for (const kind of ["standard", "script"] as const)
    it(`refuses a ${kind} connection's copy, cut and paste before anything reaches the page`, async () => {
      const f = await attached(true, kind);
      for (const [name, parameters] of refused) {
        const error = await f.key(parameters).catch((caught: unknown) => caught);
        expect(error, name).toBeInstanceOf(SessionCdpRouterError);
        expect(error, name).toMatchObject({ code: "forbidden", message: sentence });
      }
      // A nested message is read as the same command.
      await expect(
        f.send({
          method: "Target.sendMessageToTarget",
          parameters: {
            sessionId: f.sessionId,
            message: JSON.stringify({
              id: 1,
              method: "Input.dispatchKeyEvent",
              params: { ...cmdV, commands: ["paste"] },
            }),
          },
        }),
      ).rejects.toMatchObject({ message: sentence });
      for (const [method, parameters] of [...clipboardGrants, ...otherPermissions]) {
        for (const scope of [{}, { sessionId: f.sessionId }])
          await expect(f.send({ method, parameters, ...scope }), method).rejects.toMatchObject({
            code: "forbidden",
            message: permissionSentence,
          });
        await expect(
          f.send({
            method: "Target.sendMessageToTarget",
            parameters: {
              sessionId: f.sessionId,
              message: JSON.stringify({ id: 2, method, params: parameters }),
            },
          }),
          `nested ${method}`,
        ).rejects.toMatchObject({ message: permissionSentence });
      }
      expect(f.channel.commands.filter(({ method }) => method.startsWith("Input."))).toEqual([]);
      expect(f.backend.commands.filter(({ method }) => method.startsWith("Browser."))).toEqual([]);

      // A chord that maps to no clipboard command, and text, are untouched.
      await f.key({ type: "rawKeyDown", modifiers: 4, key: "a", code: "KeyA" });
      await f.key({ type: "keyDown", key: "v", code: "KeyV", text: "v" });
      await f.key({ type: "keyUp", modifiers: 4, key: "v", code: "KeyV" });
      await f.send({
        method: "Input.insertText",
        parameters: { text: "typed" },
        sessionId: f.sessionId,
      });
      expect(f.channel.commands.filter(({ method }) => method.startsWith("Input."))).toEqual([
        {
          method: "Input.dispatchKeyEvent",
          parameters: {
            type: "rawKeyDown",
            modifiers: 4,
            key: "a",
            code: "KeyA",
            commands: ["selectAll"],
          },
        },
        {
          method: "Input.dispatchKeyEvent",
          parameters: { type: "keyDown", key: "v", code: "KeyV", text: "v" },
        },
        {
          method: "Input.dispatchKeyEvent",
          parameters: { type: "keyUp", modifiers: 4, key: "v", code: "KeyV" },
        },
        { method: "Input.insertText", parameters: { text: "typed" } },
      ]);
      await f.router.close();
    });

  for (const kind of ["standard", "script"] as const)
    it(`forwards the person's own agent's ${kind} copy, cut, paste and permissions, but no clipboard grant`, async () => {
      const f = await attached(false, kind);
      for (const [, parameters] of refused) await f.key(parameters);
      for (const [method, parameters] of clipboardGrants)
        for (const scope of [{}, { sessionId: f.sessionId }])
          await expect(f.send({ method, parameters, ...scope }), method).rejects.toMatchObject({
            code: "forbidden",
            message: clipboardGrantSentence,
          });
      for (const [method, parameters] of otherPermissions) await f.send({ method, parameters });
      const { nativeVirtualKeyCode: _native, ...inferredPaste } = refused[1][1];
      expect(f.channel.commands.map(({ parameters }) => parameters)).toEqual([
        refused[0][1],
        { ...inferredPaste, commands: ["paste"] },
        refused[2][1],
        { ...refused[3][1], commands: ["copy"] },
        { ...refused[4][1], commands: ["cut"] },
        ...refused.slice(5).map(([, parameters]) => parameters),
      ]);
      expect(f.backend.commands.filter(({ method }) => method.startsWith("Browser."))).toEqual(
        otherPermissions.map(([method]) => expect.objectContaining({ method })),
      );
      expect(
        f.backend.commands
          .filter(({ method }) => method.startsWith("Browser."))
          .map(({ parameters }) => parameters),
      ).toEqual(otherPermissions.map(([, parameters]) => expect.objectContaining(parameters)));
      await f.router.close();
    });
});

describe("SessionCdpRouter under a connection: the standard lists, one tab's cookies, history and children", () => {
  async function standard(connection: boolean, cookieReads = false, wholeContext = false) {
    const backend = new FakeBackend();
    backend.dedicatedContext = true;
    Object.assign(backend, { allowsProfileCookieReads: cookieReads });
    backend.targetInfos = [{ targetId: "seed", type: "page" }];
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "seed", async () => true, "/files/a");
    const client = router.openStandardClient("a", {
      wholeContext,
      ...(connection
        ? { connection, lineage: { attachmentId: "agent", seedTargetId: "seed" } }
        : {}),
    });
    const { sessionId } = (await client.send({
      method: "Target.attachToTarget",
      parameters: { targetId: "seed", flatten: true },
    })) as { sessionId: string };
    const channel = backend.channels.get("seed")!;
    const page = (method: string, parameters: CdpParameters = {}) =>
      client.send({ method, parameters, sessionId }).catch((error: unknown) => error);
    return { router, channel, page, sessionId, client };
  }
  const outside = (method: string) =>
    `${method} is not available to a connected agent. Its CDP acts on its own pages through the Accessibility, Console, CSS, Debugger, DOM, DOMSnapshot, Emulation, Fetch, Input, Log, Network, Page, Performance, Runtime, Target domains, and at the browser root only through Target and Browser.getVersion.`;

  it("names the refused method and the page domains to a connection, and keeps the person's own wording", async () => {
    const connected = await standard(true);
    await expect(
      connected.page("Storage.clearDataForOrigin", {
        origin: "https://a.test",
        storageTypes: "all",
      }),
    ).resolves.toMatchObject({
      code: "forbidden",
      message: outside("Storage.clearDataForOrigin"),
    });
    const own = await standard(false);
    await expect(own.page("Storage.clearDataForOrigin", {})).resolves.toMatchObject({
      message: "Storage.clearDataForOrigin cannot be scoped to this CDP attachment.",
    });
    await connected.router.close();
    await own.router.close();
  });

  it("gives a connection on a shared tab only that page's own cookies; a person's own agent as before", async () => {
    const connected = await standard(true, true);
    for (const [method, parameters] of [
      ["Network.getAllCookies", {}],
      ["Storage.getCookies", {}],
      ["Network.getCookies", { urls: ["https://other.test/"] }],
    ] as const)
      await expect(connected.page(method, parameters), method).resolves.toMatchObject({
        code: "forbidden",
      });
    await expect(connected.page("Network.getCookies")).resolves.toEqual({
      method: "Network.getCookies",
    });
    expect(connected.channel.commands.map(({ method }) => method)).toEqual(["Network.getCookies"]);
    const own = await standard(false, true);
    for (const method of ["Network.getAllCookies", "Network.getCookies"])
      await expect(own.page(method, {}), method).resolves.toEqual({ method });
    await connected.router.close();
    await own.router.close();
  });

  it("keeps a granted profile's cookies through the whole-context branch only", async () => {
    const whole = await standard(true, false, true);
    for (const scope of [{}, { sessionId: whole.sessionId }])
      await expect(whole.client.send({ method: "Storage.getCookies", ...scope })).resolves.toEqual({
        ok: true,
      });
    for (const method of ["Network.getAllCookies", "Network.getCookies"])
      await expect(whole.page(method), method).resolves.toMatchObject({ code: "forbidden" });
    const confined = await standard(true);
    await expect(confined.page("Storage.getCookies")).resolves.toMatchObject({
      code: "forbidden",
      message: outside("Storage.getCookies"),
    });
    await whole.router.close();
    await confined.router.close();
  });

  it("traverses history only to an entry whose address passes the navigation rule", async () => {
    const f = await standard(false);
    f.channel.results.set("Page.getNavigationHistory", {
      currentIndex: 1,
      entries: [
        { id: 1, url: "file:///etc/hosts" },
        { id: 2, url: "https://example.test/" },
        { id: 3, url: "javascript:alert(1)" },
      ],
    });
    for (const entryId of [1, 3])
      await expect(f.page("Page.navigateToHistoryEntry", { entryId })).resolves.toMatchObject({
        code: "forbidden",
        message:
          "CDP navigation is limited to HTTP(S) and extension pages, without embedded credentials.",
      });
    await expect(f.page("Page.navigateToHistoryEntry", { entryId: 9 })).resolves.toMatchObject({
      code: "not_found",
    });
    await f.page("Page.navigateToHistoryEntry", { entryId: 2 });
    expect(
      f.channel.commands.filter(({ method }) => method === "Page.navigateToHistoryEntry"),
    ).toEqual([{ method: "Page.navigateToHistoryEntry", parameters: { entryId: 2 } }]);
    await f.router.close();
  });

  it("limits a connection's page auto-attach to iframes and workers, unpaused; the person's own as before", async () => {
    const connected = await standard(true);
    for (const parameters of [
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: "iframe", exclude: true }, {}],
      },
      { autoAttach: true, waitForDebuggerOnStart: false, filter: [{ type: "service_worker" }] },
    ])
      await connected.page("Target.setAutoAttach", parameters);
    expect(
      connected.channel.commands
        .filter(({ method }) => method === "Target.setAutoAttach")
        .map(({ parameters }) => parameters),
    ).toEqual([
      {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: false,
        filter: [{ type: "iframe" }, { type: "worker" }, { exclude: true }],
      },
      {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: false,
        filter: [{ type: "worker" }, { exclude: true }],
      },
      {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: false,
        filter: [{ exclude: true }],
      },
    ]);
    const own = await standard(false);
    await own.page("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    expect(
      own.channel.commands.find(({ method }) => method === "Target.setAutoAttach")?.parameters,
    ).toEqual({ autoAttach: true, waitForDebuggerOnStart: true, flatten: false });
    await connected.router.close();
    await own.router.close();
  });
});

describe("SessionCdpRouter nested messages: one decoder, and the rules where they are unpacked", () => {
  const malformed = {
    array: ['{"id":1,"method":"Page.crash","params":{}}'],
    object: { id: 1, method: "Page.crash", params: {} },
    unparsable: '{"id":1,"method":',
    "non-string method": '{"id":1,"method":["Page.crash"]}',
    "array params": '{"id":1,"method":"Page.crash","params":[]}',
  } as const;

  /** A script attachment (browser_use) or the session root (a Run's relay), attached to a page. */
  async function relay(kind: "script" | "root", connection = false) {
    const backend = new FakeBackend();
    backend.targetInfos = [{ targetId: "seed", type: "page" }];
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "seed", async () => true, "/files/a");
    if (kind === "script")
      router.openScriptAttachment(
        "a",
        "script",
        "seed",
        { maxBytes: 64 * 1024, maxDepth: 16, maxEntries: 1024 },
        () => undefined,
        connection ? { connection: true } : {},
      );
    const send = (command: CdpCommand) =>
      router
        .send("a", { ...command, ...(kind === "script" ? { scriptAttachmentId: "script" } : {}) })
        .catch((error: unknown) => error);
    const { sessionId } = (await send({
      method: "Target.attachToTarget",
      parameters: { targetId: "seed", flatten: true },
      ...(connection ? { connection: true } : {}),
    })) as { sessionId: string };
    // A child of the page, so that a page-level nested message has somewhere to go.
    backend.channels.get("seed")!.results.set("Target.attachToTarget", { sessionId: "child-1" });
    return { router, backend, send, sessionId, channel: backend.channels.get("seed")! };
  }

  for (const kind of ["script", "root"] as const)
    it(`refuses a nested message that is not a JSON string of one command, for everyone (${kind})`, async () => {
      for (const connection of [true, false]) {
        const f = await relay(kind, connection);
        for (const [shape, message] of Object.entries(malformed)) {
          const refused = await f.send({
            method: "Target.sendMessageToTarget",
            parameters: { sessionId: f.sessionId, message },
            ...(connection ? { connection: true } : {}),
          });
          expect(refused, `${shape} ${connection}`).toMatchObject({
            message: "Invalid nested CDP message.",
          });
        }
        expect(f.channel.commands.map(({ method }) => method)).not.toContain("Page.crash");
        await f.router.close();
      }
    });

  for (const kind of ["script", "root"] as const)
    it(`holds the standard lists itself for a command marked as a connection's (${kind})`, async () => {
      const connected = await relay(kind, true);
      const outside = expect.stringMatching(
        /^(Tracing\.start|Storage\.clearDataForOrigin|Page\.crash) is not available to a connected agent\./u,
      );
      for (const command of [
        { method: "Tracing.start", parameters: {} },
        { method: "Storage.clearDataForOrigin", parameters: {}, sessionId: connected.sessionId },
        { method: "Page.crash", parameters: {}, sessionId: connected.sessionId },
      ])
        expect(
          await connected.send({ ...command, connection: true }),
          command.method,
        ).toMatchObject({
          code: "forbidden",
          message: outside,
        });
      // The same command nested in a well-formed message is refused where it is unpacked.
      expect(
        await connected.send({
          method: "Target.sendMessageToTarget",
          parameters: {
            sessionId: connected.sessionId,
            message: JSON.stringify({ id: 9, method: "Page.crash", params: {} }),
          },
          connection: true,
        }),
      ).toMatchObject({ code: "forbidden", message: outside });
      expect(connected.channel.commands.map(({ method }) => method)).not.toContain("Page.crash");
      // The page auto-attach the runtime receives is limited, and unpaused.
      await connected.send({
        method: "Target.setAutoAttach",
        parameters: { autoAttach: true, waitForDebuggerOnStart: true },
        sessionId: connected.sessionId,
        connection: true,
      });
      expect(
        connected.channel.commands.find(({ method }) => method === "Target.setAutoAttach")
          ?.parameters,
      ).toEqual({
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: false,
        filter: [{ type: "iframe" }, { type: "worker" }, { exclude: true }],
      });
      await connected.router.close();

      // The person's own agent (its own non-connection attachment): the same commands go out as before.
      const own = await relay(kind, false);
      await own.send({ method: "Page.crash", parameters: {}, sessionId: own.sessionId });
      expect(own.channel.commands.map(({ method }) => method)).toContain("Page.crash");
      await own.router.close();
    });
});

describe("SessionCdpRouter under a connection: cookies in events, one sentence, workers, history", () => {
  const sentence = (method: string) =>
    `${method} is not available to a connected agent. Its CDP acts on its own pages through the Accessibility, Console, CSS, Debugger, DOM, DOMSnapshot, Emulation, Fetch, Input, Log, Network, Page, Performance, Runtime, Target domains, and at the browser root only through Target and Browser.getVersion.`;
  async function standard(options: {
    connection: boolean;
    cookieReads?: boolean;
    wholeContext?: boolean;
  }) {
    const backend = new FakeBackend();
    backend.dedicatedContext = true;
    Object.assign(backend, { allowsProfileCookieReads: options.cookieReads === true });
    backend.targetInfos = [{ targetId: "seed", type: "page" }];
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "seed", async () => true, "/files/a");
    const client = router.openStandardClient("a", {
      wholeContext: options.wholeContext === true,
      ...(options.connection
        ? { connection: true, lineage: { attachmentId: "agent", seedTargetId: "seed" } }
        : {}),
    });
    const events: CdpEvent[] = [];
    client.onEvent((event) => events.push(event));
    const { sessionId } = (await client.send({
      method: "Target.attachToTarget",
      parameters: { targetId: "seed", flatten: true },
    })) as { sessionId: string };
    const channel = backend.channels.get("seed")!;
    const send = (method: string, parameters: CdpParameters = {}, page = true) =>
      client
        .send({ method, parameters, ...(page ? { sessionId } : {}) })
        .catch((error: unknown) => error);
    return { router, backend, client, channel, events, send, sessionId };
  }

  it("gives a connection on a shared tab no cookie in any Network or Fetch event; a person's own agent as before", async () => {
    const cookie = "sentinel-elsewhere";
    const raise = (channel: FakeChannel) => {
      channel.emit("Network.requestWillBeSentExtraInfo", {
        requestId: "1",
        associatedCookies: [{ cookie: { name: "s", value: cookie } }],
        headers: { Cookie: `s=${cookie}` },
      });
      channel.emit("Network.responseReceivedExtraInfo", {
        requestId: "1",
        headers: { "set-cookie": `t=${cookie}` },
        headersText: `Set-Cookie: t=${cookie}`,
      });
      channel.emit("Network.requestWillBeSent", {
        requestId: "1",
        request: {
          url: "https://elsewhere.test/",
          headers: { Cookie: `s=${cookie}`, Accept: "*/*" },
        },
      });
      channel.emit("Network.responseReceived", {
        requestId: "1",
        response: {
          headers: { "Set-Cookie": `t=${cookie}`, "Content-Type": "text/html" },
          requestHeadersText: `Cookie: s=${cookie}`,
        },
      });
      channel.emit("Fetch.requestPaused", {
        requestId: "f",
        request: { url: "https://elsewhere.test/", headers: { cookie: `s=${cookie}` } },
        responseHeaders: [
          { name: "set-cookie", value: `t=${cookie}` },
          { name: "content-type", value: "text/html" },
        ],
      });
    };
    const shared = await standard({ connection: true, cookieReads: true });
    raise(shared.channel);
    const delivered = shared.events.filter(({ method }) => /^(Network|Fetch)\./u.test(method));
    expect(delivered.map(({ method }) => method)).toEqual([
      "Network.requestWillBeSent",
      "Network.responseReceived",
      "Fetch.requestPaused",
    ]);
    expect(JSON.stringify(delivered)).not.toContain(cookie);
    expect(JSON.stringify(delivered)).toContain("text/html");
    const own = await standard({ connection: false, cookieReads: true });
    raise(own.channel);
    expect(own.events.filter(({ method }) => /^(Network|Fetch)\./u.test(method))).toHaveLength(5);
    await shared.router.close();
    await own.router.close();
  });

  it("answers a connection the same method sentence whichever check refuses it", async () => {
    const f = await standard({ connection: true, cookieReads: true });
    for (const [method, page] of [
      ["Browser.crash", false],
      ["Opensteer.fillLogin", true],
      ["Storage.getCookies", true],
      ["Storage.clearDataForOrigin", true],
      ["Tracing.start", false],
    ] as const)
      expect(await f.send(method, {}, page), method).toMatchObject({
        code: "forbidden",
        message: sentence(method),
      });
    await f.router.close();
  });

  it("refuses a shared or service worker announced to a whole-context connection", async () => {
    const f = await standard({ connection: true, wholeContext: true });
    await f.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false });
    for (const type of ["service_worker", "shared_worker"])
      f.channel.emit("Target.attachedToTarget", {
        sessionId: `physical-${type}`,
        targetInfo: { targetId: `worker-${type}`, type, url: "https://a.test/sw.js" },
        waitingForDebugger: false,
      });
    expect(
      f.events
        .filter(({ method }) => method === "Target.attachedToTarget")
        .map(({ parameters }) => (parameters.targetInfo as { type: string }).type),
    ).not.toEqual(expect.arrayContaining(["service_worker"]));
    expect(
      f.events.some(
        ({ method, parameters }) =>
          method === "Target.attachedToTarget" &&
          ["service_worker", "shared_worker"].includes(
            (parameters.targetInfo as { type: string }).type,
          ),
      ),
    ).toBe(false);
    await f.router.close();
  });

  it("re-checks the session and its target after reading the history, before the traversal", async () => {
    const f = await standard({ connection: false });
    const send = f.channel.send.bind(f.channel);
    vi.spyOn(f.channel, "send").mockImplementation(async (method, parameters) => {
      if (method === "Page.getNavigationHistory") {
        // The caller's connection ends while the read is in flight.
        f.client.close();
        return { currentIndex: 0, entries: [{ id: 1, url: "https://example.test/" }] };
      }
      return send(method, parameters);
    });
    expect(await f.send("Page.navigateToHistoryEntry", { entryId: 1 })).toBeInstanceOf(Error);
    expect(f.channel.commands.map(({ method }) => method)).not.toContain(
      "Page.navigateToHistoryEntry",
    );
    await f.router.close();
  });
});

describe("Opensteer's own methods for a connection", () => {
  it("admits the listed ones at the top level only, and no other", async () => {
    const { connectionCdpRefusal } = await import("./cdp-command-refusals.js");
    for (const method of [
      "Opensteer.listTabs",
      "Opensteer.resumeTab",
      "Opensteer.stageFile",
      "Opensteer.fillLogin",
      "Opensteer.fillCard",
    ])
      expect(connectionCdpRefusal(method, {}, true), method).toBeUndefined();
    expect(connectionCdpRefusal("Opensteer.testDiagnostics", {}, true)).toMatch(
      /^Opensteer\.testDiagnostics is not available to a connected agent\./u,
    );
    expect(
      connectionCdpRefusal(
        "Target.sendMessageToTarget",
        {
          sessionId: "child",
          message: JSON.stringify({ id: 1, method: "Opensteer.stageFile", params: {} }),
        },
        true,
      ),
    ).toMatch(/^Opensteer\.stageFile is not available to a connected agent\./u);
  });
});

describe("SessionCdpRouter: a connection's list comes before every other check", () => {
  const sentence = (method: string) =>
    `${method} is not available to a connected agent. Its CDP acts on its own pages through the Accessibility, Console, CSS, Debugger, DOM, DOMSnapshot, Emulation, Fetch, Input, Log, Network, Page, Performance, Runtime, Target domains, and at the browser root only through Target and Browser.getVersion.`;
  async function client(connection: boolean) {
    const backend = new FakeBackend();
    backend.targetInfos = [{ targetId: "seed", type: "page" }];
    // A backend's own scope check, as the Mac's and shared Chrome's word theirs.
    Object.assign(backend, {
      assertScope: (method: string) => {
        if (method.startsWith("SystemInfo.") || method === "Browser.getBrowserCommandLine")
          throw new Error(
            `${method} describes the Opensteer process, outside browser page ownership.`,
          );
        if (["Page.close", "DOM.setFileInputFiles"].includes(method))
          throw new SessionCdpRouterError(
            "forbidden",
            `${method} is unavailable on a shared Chrome tab.`,
          );
      },
    });
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "seed", async () => true, "/files/a");
    const standard = router.openStandardClient("a", {
      wholeContext: false,
      ...(connection
        ? { connection, lineage: { attachmentId: "agent", seedTargetId: "seed" } }
        : {}),
    });
    const { sessionId } = (await standard.send({
      method: "Target.attachToTarget",
      parameters: { targetId: "seed", flatten: true },
    })) as { sessionId: string };
    const send = (method: string, parameters: CdpParameters = {}, scope?: string) =>
      standard.send({ method, parameters, ...(scope ? { sessionId: scope } : {}) }).then(
        () => "sent",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    return { router, send, sessionId, standard };
  }

  it("answers the one sentence for a command outside the list, whichever check would have refused it", async () => {
    const f = await client(true);
    for (const [method, page] of [
      ["SystemInfo.getProcessInfo", false],
      ["Browser.getBrowserCommandLine", false],
      ["Page.close", true],
      ["Target.attachToBrowserTarget", true],
    ] as const)
      expect(await f.send(method, {}, page ? f.sessionId : undefined), method).toBe(
        sentence(method),
      );
    // A listed command still meets the backend's own check, and the alias root's rule.
    expect(await f.send("DOM.setFileInputFiles", { files: [] }, f.sessionId)).toBe(
      "DOM.setFileInputFiles is unavailable on a shared Chrome tab.",
    );
    const { sessionId: alias } = (await f.standard.send({
      method: "Target.attachToBrowserTarget",
    })) as { sessionId: string };
    expect(await f.send("Target.attachToBrowserTarget", {}, alias)).toBe(
      "Open a browser CDP session from the connection root.",
    );
    await f.router.close();
  });

  it("leaves the person's own agent the backend's and the router's own sentences", async () => {
    const f = await client(false);
    expect(await f.send("SystemInfo.getProcessInfo")).toBe(
      "SystemInfo.getProcessInfo describes the Opensteer process, outside browser page ownership.",
    );
    expect(await f.send("Page.close", {}, f.sessionId)).toBe(
      "Page.close is unavailable on a shared Chrome tab.",
    );
    expect(await f.send("Target.attachToBrowserTarget", {}, f.sessionId)).toBe(
      "Open a browser CDP session from the connection root.",
    );
    await f.router.close();
  });
});

function readId(parameters: unknown): unknown {
  const record = parameters as { targetId?: unknown; targetInfo?: { targetId?: unknown } };
  return record.targetInfo?.targetId ?? record.targetId;
}

describe("SessionCdpRouter: Chrome extension boundaries (2a and 2b)", () => {
  it("tells a connection's script of a target's end only for a target it was shown (M1)", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend);
    router.registerSession("session", "root", async () => true, "/files/a");
    const extensionPage = `chrome-extension://${"a".repeat(32)}/page.html`;
    // Claimed under the root before the script attachment opened, so never projected to it.
    backend.emit("Target.targetCreated", {
      targetInfo: { targetId: "ext-popup", type: "page", openerId: "root", url: extensionPage },
    });
    backend.emit("Target.targetCreated", {
      targetInfo: { targetId: "web-early", type: "page", openerId: "root", url: "https://a.test/" },
    });
    backend.targetInfos.push({ targetId: "web-early", type: "page", url: "https://a.test/" });
    const events: CdpEvent[] = [];
    const budget = { maxBytes: 64_000, maxDepth: 16, maxEntries: 1_024 };
    router.openScriptAttachment("session", "script", "root", budget, (e) => events.push(e), {
      connection: true,
    });
    try {
      backend.emit("Target.targetCreated", {
        targetInfo: { targetId: "ext-popup-2", type: "page", openerId: "root", url: extensionPage },
      });
      backend.emit("Target.targetCreated", {
        targetInfo: {
          targetId: "web-late",
          type: "page",
          openerId: "root",
          url: "https://b.test/",
        },
      });
      backend.emit("Target.targetCrashed", {
        targetId: "ext-popup",
        status: "crashed",
        errorCode: 1,
      });
      backend.emit("Target.targetDestroyed", { targetId: "ext-popup" });
      backend.emit("Target.targetDestroyed", { targetId: "ext-popup-2" });
      backend.emit("Target.targetDestroyed", { targetId: "web-late" });
      // Shown in a reply: its end is this connection's to hear.
      const { targetInfos } = (await router.send("session", {
        method: "Target.getTargets",
        scriptAttachmentId: "script",
      })) as { targetInfos: { targetId: string }[] };
      expect(targetInfos.map(({ targetId }) => targetId)).toEqual(["web-early"]);
      backend.emit("Target.targetDestroyed", { targetId: "web-early" });
      backend.emit("Target.targetCrashed", { targetId: "root", status: "crashed", errorCode: 1 });
      backend.emit("Target.targetDestroyed", { targetId: "root" });
      expect(JSON.stringify(events)).not.toContain("ext-popup");
      expect(events.map(({ method, parameters }) => [method, readId(parameters)])).toEqual([
        ["Target.targetCreated", "web-late"],
        ["Target.targetDestroyed", "web-late"],
        ["Target.targetDestroyed", "web-early"],
        ["Target.targetCrashed", "root"],
        ["Target.targetDestroyed", "root"],
      ]);
    } finally {
      await router.close();
    }
  });

  it("tells a connection again of a tab that was shown, hidden and shown again (G1)", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend);
    router.registerSession("session", "root", async () => true, "/files/a");
    const events: CdpEvent[] = [];
    const budget = { maxBytes: 64_000, maxDepth: 16, maxEntries: 1_024 };
    router.openScriptAttachment("session", "script", "root", budget, (e) => events.push(e), {
      connection: true,
    });
    try {
      const web = (url: string) => ({ targetId: "tab-1", type: "page", openerId: "root", url });
      backend.targetInfos.push(web("https://a.test/"));
      backend.emit("Target.targetCreated", { targetInfo: web("https://a.test/") });
      const { sessionId } = (await router.send("session", {
        method: "Target.attachToTarget",
        parameters: { targetId: "tab-1", flatten: true },
        scriptAttachmentId: "script",
      })) as { sessionId: string };
      backend.emit("Target.targetInfoChanged", {
        targetInfo: web(`chrome-extension://${"a".repeat(32)}/page.html`),
      });
      backend.emit("Target.targetInfoChanged", { targetInfo: web("https://b.test/") });
      backend.emit("Target.targetCrashed", { targetId: "tab-1", status: "crashed", errorCode: 1 });
      backend.emit("Target.targetDestroyed", { targetId: "tab-1" });
      expect(JSON.stringify(events)).not.toContain("chrome-extension:");
      expect(
        events.map(({ method, parameters }) => [method, readId(parameters), parameters.sessionId]),
      ).toEqual([
        ["Target.targetCreated", "tab-1", undefined],
        ["Target.targetInfoChanged", "tab-1", undefined],
        ["Target.targetCrashed", "tab-1", undefined],
        ["Target.targetDestroyed", "tab-1", undefined],
        ["Target.detachedFromTarget", "tab-1", sessionId],
      ]);
    } finally {
      await router.close();
    }
  });

  it("names a hidden target in no browser-level event and in no related field (G2)", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend);
    router.registerSession("session", "root", async () => true, "/files/a");
    const extensionPage = `chrome-extension://${"a".repeat(32)}/page.html`;
    const scriptEvents: CdpEvent[] = [];
    const budget = { maxBytes: 64_000, maxDepth: 16, maxEntries: 1_024 };
    router.openScriptAttachment("session", "script", "root", budget, (e) => scriptEvents.push(e), {
      connection: true,
    });
    const standard = router.openStandardClient("session", {
      wholeContext: false,
      connection: true,
      lineage: { attachmentId: "lineage", seedTargetId: "root" },
    });
    const standardEvents: CdpEvent[] = [];
    standard.onEvent((event) => standardEvents.push(event));
    try {
      backend.targetInfos.push({ targetId: "root", type: "page", url: "https://root.test/" });
      await standard.send({ method: "Target.setDiscoverTargets", parameters: { discover: true } });
      backend.emit("Target.targetCreated", {
        targetInfo: { targetId: "ext-popup", type: "page", openerId: "root", url: extensionPage },
      });
      backend.emit("Browser.downloadWillBegin", {
        frameId: "ext-popup",
        guid: "g-1",
        url: extensionPage,
        suggestedFilename: "secret.txt",
      });
      backend.emit("Browser.someEvent", { targetId: "ext-popup" });
      backend.emit("Target.targetCreated", {
        targetInfo: {
          targetId: "web-from-ext",
          type: "page",
          openerId: "ext-popup",
          openerFrameId: "ext-popup",
          canAccessOpener: true,
          url: "https://c.test/",
        },
      });
      backend.emit("Target.targetCreated", {
        targetInfo: {
          targetId: "frame-in-ext",
          type: "iframe",
          parentId: "ext-popup",
          parentFrameId: "ext-popup",
          url: "https://d.test/",
        },
      });
      // A shown web target's own download, at a web address, still reaches both.
      backend.emit("Browser.downloadWillBegin", {
        frameId: "root",
        guid: "g-2",
        url: "https://root.test/file.txt",
        suggestedFilename: "file.txt",
      });
      backend.emit("Browser.someEvent", { targetId: "root" });
      for (const events of [scriptEvents, standardEvents]) {
        expect(JSON.stringify(events)).not.toContain("ext-popup");
        expect(JSON.stringify(events)).not.toContain("chrome-extension:");
        expect(JSON.stringify(events)).not.toContain("secret.txt");
        expect(events).toContainEqual(
          expect.objectContaining({
            method: "Browser.someEvent",
            parameters: { targetId: "root" },
          }),
        );
      }
      // A script hears browser-level events by target ID only, as before; a standard client also
      // by frame ID.
      expect(standardEvents).toContainEqual(
        expect.objectContaining({
          method: "Browser.downloadWillBegin",
          parameters: expect.objectContaining({ guid: "g-2" }),
        }),
      );
      const webFromExt = scriptEvents.find(
        ({ parameters }) => readId(parameters) === "web-from-ext",
      );
      expect(webFromExt?.parameters.targetInfo).toMatchObject({ canAccessOpener: false });
    } finally {
      standard.close();
      await router.close();
    }
  });

  it("names no hidden iframe as the frame a shown page's popup or child came from (N4)", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend);
    router.registerSession("session", "root", async () => true, "/files/a");
    const events: CdpEvent[] = [];
    const budget = { maxBytes: 64_000, maxDepth: 16, maxEntries: 1_024 };
    router.openScriptAttachment("session", "script", "root", budget, (e) => events.push(e), {
      connection: true,
    });
    try {
      // An extension's iframe inside the shown root page (hidden), and one created before the
      // script opened, so never projected to it at all.
      backend.emit("Target.targetCreated", {
        targetInfo: {
          targetId: "ext-frame",
          type: "iframe",
          parentId: "root",
          url: `chrome-extension://${"a".repeat(32)}/frame.html`,
        },
      });
      for (const [targetId, info] of [
        [
          "popup",
          { type: "page", openerId: "root", openerFrameId: "ext-frame", canAccessOpener: true },
        ],
        ["child", { type: "iframe", parentId: "root", parentFrameId: "ext-frame" }],
        ["own-frame", { type: "iframe", parentId: "root", parentFrameId: "root" }],
      ] as const)
        backend.emit("Target.targetCreated", {
          targetInfo: { targetId, url: `https://${targetId}.test/`, ...info },
        });
      expect(JSON.stringify(events)).not.toContain("ext-frame");
      expect(events.map(({ parameters }) => parameters.targetInfo)).toEqual([
        {
          targetId: "popup",
          url: "https://popup.test/",
          type: "page",
          openerId: "root",
          canAccessOpener: true,
        },
        { targetId: "child", url: "https://child.test/", type: "iframe", parentId: "root" },
        {
          targetId: "own-frame",
          url: "https://own-frame.test/",
          type: "iframe",
          parentId: "root",
          parentFrameId: "root",
        },
      ]);
    } finally {
      await router.close();
    }
  });

  it("never tells a connection's script of another session's or another tab's target ending", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "root-a", async () => true, "/files/a");
    router.registerSession("b", "root-b", async () => true, "/files/b");
    router.claimTarget("a", "other-tab-a");
    const events: CdpEvent[] = [];
    const budget = { maxBytes: 64_000, maxDepth: 16, maxEntries: 1_024 };
    router.openScriptAttachment("a", "script", "root-a", budget, (e) => events.push(e), {
      connection: true,
    });
    try {
      for (const targetId of ["root-b", "other-tab-a", "unclaimed"]) {
        backend.emit("Target.targetCrashed", { targetId, status: "crashed", errorCode: 1 });
        backend.emit("Target.targetDestroyed", { targetId });
      }
      expect(events).toEqual([]);
    } finally {
      await router.close();
    }
  });

  const extId = "abcdefghijklmnopabcdefghijklmnop";
  const extOrigin = `chrome-extension://${extId}`;
  const extPopupUrl = `${extOrigin}/popup.html`;
  const extScriptUrl = `${extOrigin}/content.js`;

  it("refuses Extensions.loadUnpacked and Extensions.uninstall without admitted manageExtensions standing (2b)", async () => {
    const backend = new FakeBackend();
    backend.extensions = true;
    const router = new SessionCdpRouter(backend);
    router.registerSession("session-a", "root-a", async () => true, "/opensteer-files/session-a");
    const attached = (await router.send("session-a", {
      method: "Target.attachToTarget",
      parameters: { flatten: true, targetId: "root-a" },
    })) as { sessionId: string };

    // Without manageExtensions (Auto, Supervised, or missing standing): refused at root, page, and nested.
    for (const [method, parameters] of [
      ["Extensions.loadUnpacked", { path: "/work/extension" }],
      ["Extensions.uninstall", { id: extId }],
    ] as const) {
      await expect(router.send("session-a", { method, parameters })).rejects.toMatchObject({
        code: "forbidden",
        message: expect.stringContaining("Full access"),
      });
      await expect(
        router.send("session-a", { method, parameters, sessionId: attached.sessionId }),
      ).rejects.toMatchObject({
        code: "forbidden",
        message: expect.stringContaining("Full access"),
      });
    }
    expect(backend.commands).toEqual([]);

    // Non-mutating Extensions.getExtensions and Extensions.triggerAction still work for a Run.
    await router.send("session-a", { method: "Extensions.getExtensions" });
    await router.send("session-a", {
      method: "Extensions.triggerAction",
      parameters: { id: extId },
      sessionId: attached.sessionId,
    });
    // With admitted manageExtensions standing (Full access on the person's own lineage): allowed.
    await router.send("session-a", {
      method: "Extensions.loadUnpacked",
      parameters: { path: "/work/extension" },
      manageExtensions: true,
    });
    await router.send("session-a", {
      method: "Extensions.uninstall",
      parameters: { id: extId },
      manageExtensions: true,
    });
    expect(backend.commands.map(({ method }) => method)).toEqual([
      "Extensions.getExtensions",
      "Extensions.triggerAction",
      "Extensions.loadUnpacked",
      "Extensions.uninstall",
    ]);
    await router.close();
  });

  it("refuses the entire Extensions domain and CDP chrome-extension: navigations for a connected agent (2a)", async () => {
    const backend = new FakeBackend();
    backend.extensions = true;
    backend.dedicatedContext = true;
    backend.targetInfos = [
      { targetId: "seed", type: "page", url: "https://example.test/" },
      { targetId: "ext-sw", type: "service_worker", url: `${extOrigin}/sw.js` },
      { targetId: "ext-bg", type: "background_page", url: `${extOrigin}/bg.html` },
      { targetId: "ext-popup", type: "page", url: extPopupUrl },
      { targetId: "cws-win", type: "page", url: "https://chromewebstore.google.com/" },
    ];
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "seed", async () => true, "/files/a");
    const client = router.openStandardClient("a", {
      wholeContext: false,
      connection: true,
      lineage: { attachmentId: "conn", seedTargetId: "seed" },
    });
    const { sessionId } = (await client.send({
      method: "Target.attachToTarget",
      parameters: { targetId: "seed", flatten: true },
    })) as { sessionId: string };
    const { sessionId: alias } = (await client.send({
      method: "Target.attachToBrowserTarget",
    })) as { sessionId: string };

    // Target enumeration sees only the owned web page, never extension workers, popups, or Web Store.
    for (const root of [{}, { sessionId: alias }]) {
      await expect(client.send({ method: "Target.getTargets", ...root })).resolves.toEqual({
        targetInfos: [expect.objectContaining({ targetId: "seed" })],
      });
      await expect(client.send({ method: "Target.getBrowserContexts", ...root })).resolves.toEqual({
        browserContextIds: [],
      });
      for (const foreignId of ["ext-sw", "ext-bg", "ext-popup", "cws-win"]) {
        const missing = await client
          .send({ method: "Target.attachToTarget", parameters: { targetId: "missing" }, ...root })
          .catch((error: unknown) => error);
        await expect(
          client.send({
            method: "Target.attachToTarget",
            parameters: { targetId: foreignId },
            ...root,
          }),
        ).rejects.toMatchObject(missing as SessionCdpRouterError);
      }
    }

    // All Extensions.* methods get the same unlisted-method refusal (Rule 5), even with manageExtensions.
    const unknownRefusal = await client
      .send({ method: "Unknown.domain" })
      .catch((error: unknown) => (error as Error).message);
    for (const method of [
      "Extensions.getExtensions",
      "Extensions.loadUnpacked",
      "Extensions.uninstall",
      "Extensions.triggerAction",
    ]) {
      for (const scope of [{}, { sessionId }, { sessionId: alias }]) {
        const error = await client
          .send({
            method,
            parameters: { id: extId, path: "/work/extension" },
            manageExtensions: true,
            ...scope,
          })
          .catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(SessionCdpRouterError);
        expect((error as SessionCdpRouterError).code).toBe("forbidden");
        expect((error as Error).message).toBe(
          String(unknownRefusal).replace("Unknown.domain", method),
        );
      }
    }

    // Script attachment with connection: true also refuses Extensions.* (even with manageExtensions).
    router.openScriptAttachment(
      "a",
      "script-conn",
      "seed",
      { maxBytes: 64_000, maxDepth: 16, maxEntries: 1_024 },
      () => undefined,
      { connection: true },
    );
    await expect(
      router.send("a", {
        scriptAttachmentId: "script-conn",
        method: "Extensions.getExtensions",
        manageExtensions: true,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    // Connected agent cannot navigate, createTarget, or traverse history to chrome-extension: URLs.
    await expect(
      client.send({
        method: "Page.navigate",
        parameters: { url: extPopupUrl },
        sessionId,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "CDP navigation is limited to HTTP and HTTPS URLs without embedded credentials.",
    });
    await expect(
      client.send({
        method: "Target.createTarget",
        parameters: { url: extPopupUrl },
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "CDP navigation is limited to HTTP and HTTPS URLs without embedded credentials.",
    });
    const channel = backend.channels.get("seed")!;
    channel.results.set("Page.getNavigationHistory", {
      currentIndex: 1,
      entries: [
        { id: 1, url: extPopupUrl },
        { id: 2, url: "https://example.test/" },
      ],
    });
    await expect(
      client.send({
        method: "Page.navigateToHistoryEntry",
        parameters: { entryId: 1 },
        sessionId,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "CDP navigation is limited to HTTP and HTTPS URLs without embedded credentials.",
    });
    // Page.getNavigationHistory itself strips extension entries for a connected agent.
    await expect(client.send({ method: "Page.getNavigationHistory", sessionId })).resolves.toEqual({
      currentIndex: 1,
      entries: [{ id: 2, url: "https://example.test/" }],
    });
    await router.close();
  });

  it("never attaches extension child iframes or workers to a connected agent, and hides extension targets from discovery (2a)", async () => {
    const backend = new FakeBackend();
    backend.dedicatedContext = true;
    backend.targetInfos = [{ targetId: "seed", type: "page", url: "https://example.test/" }];
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "seed", async () => true, "/files/a");
    const client = router.openStandardClient("a", {
      wholeContext: false,
      connection: true,
      lineage: { attachmentId: "conn", seedTargetId: "seed" },
    });
    const events: CdpEvent[] = [];
    client.onEvent((event) => events.push(event));
    await client.send({ method: "Target.setDiscoverTargets", parameters: { discover: true } });
    const { sessionId } = (await client.send({
      method: "Target.attachToTarget",
      parameters: { targetId: "seed", flatten: true },
    })) as { sessionId: string };
    const channel = backend.channels.get("seed")!;

    // Extension OOPIF iframe, dedicated worker, and service worker arriving on page channel are detached and dropped.
    channel.emit("Target.attachedToTarget", {
      sessionId: "phys-ext-iframe",
      targetInfo: { targetId: "ext-iframe", type: "iframe", url: `${extOrigin}/widget.html` },
    });
    channel.emit("Target.attachedToTarget", {
      sessionId: "phys-ext-worker",
      targetInfo: { targetId: "ext-worker", type: "worker", url: `${extOrigin}/worker.js` },
    });
    channel.emit("Target.attachedToTarget", {
      sessionId: "phys-ext-sw",
      targetInfo: { targetId: "ext-sw", type: "service_worker", url: `${extOrigin}/sw.js` },
    });
    // Ordinary web iframe still attaches.
    channel.emit("Target.attachedToTarget", {
      sessionId: "phys-web-iframe",
      targetInfo: { targetId: "web-iframe", type: "iframe", url: "https://child.example.test/" },
    });

    expect(channel.commands).toEqual(
      expect.arrayContaining([
        { method: "Target.detachFromTarget", parameters: { sessionId: "phys-ext-iframe" } },
        { method: "Target.detachFromTarget", parameters: { sessionId: "phys-ext-worker" } },
        { method: "Target.detachFromTarget", parameters: { sessionId: "phys-ext-sw" } },
      ]),
    );
    const attached = events.filter(({ method }) => method === "Target.attachedToTarget");
    expect(attached.map((e) => (e.parameters.targetInfo as { targetId: string }).targetId)).toEqual(
      ["seed", "web-iframe"],
    );

    // An extension popup target claiming seed as opener must not leak in discovery or getTargets.
    const extChild = {
      targetId: "ext-child-page",
      type: "page",
      url: extPopupUrl,
      openerId: "seed",
    };
    backend.targetInfos.push(extChild);
    backend.emit("Target.targetCreated", { targetInfo: extChild });
    expect(events.some((event) => JSON.stringify(event).includes(extId))).toBe(false);
    await expect(client.send({ method: "Target.getTargets" })).resolves.toEqual({
      targetInfos: [expect.objectContaining({ targetId: "seed" })],
    });
    // Still attached only to seed and web-iframe.
    expect(sessionId).toBeTruthy();
    await router.close();
  });

  it("filters extension content-script worlds, scripts, console/exceptions, stacks, frame trees, and history on a connection channel while keeping Runs intact (2a-i)", async () => {
    const backend = new FakeBackend();
    backend.dedicatedContext = true;
    backend.targetInfos = [{ targetId: "seed", type: "page", url: "https://example.test/" }];
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "seed", async () => true, "/files/a");

    const connClient = router.openStandardClient("a", {
      wholeContext: false,
      connection: true,
      lineage: { attachmentId: "conn", seedTargetId: "seed" },
    });
    const runClient = router.openStandardClient("a", { wholeContext: false });

    const connEvents: CdpEvent[] = [];
    const runEvents: CdpEvent[] = [];
    connClient.onEvent((event) => connEvents.push(event));
    runClient.onEvent((event) => runEvents.push(event));

    backend.prepareChannel = (ch) => {
      ch.contexts = [];
    };
    const { sessionId: connSession } = (await connClient.send({
      method: "Target.attachToTarget",
      parameters: { targetId: "seed", flatten: true },
    })) as { sessionId: string };
    const connChannel = backend.channels.get("seed")!;

    const { sessionId: runSession } = (await runClient.send({
      method: "Target.attachToTarget",
      parameters: { targetId: "seed", flatten: true },
    })) as { sessionId: string };
    const runChannel = backend.channels.get("seed")!;

    const extContext = {
      id: 77,
      origin: extOrigin,
      name: "Secret Password Manager",
      uniqueId: "ext-unique-77",
      auxData: { frameId: "main", isDefault: false, type: "isolated" },
    };
    const pageContext = frameWorld(1);
    await connClient.send({ method: "Runtime.enable", sessionId: connSession });
    await runClient.send({ method: "Runtime.enable", sessionId: runSession });

    for (const ch of [connChannel, runChannel]) {
      ch.emit("Runtime.executionContextCreated", { context: pageContext });
      ch.emit("Runtime.executionContextCreated", { context: extContext });
      ch.emit("Debugger.scriptParsed", {
        scriptId: "script-ext-1",
        url: extScriptUrl,
        executionContextId: 77,
      });
      ch.emit("Debugger.scriptParsed", {
        scriptId: "script-page-1",
        url: "https://example.test/app.js",
        executionContextId: 1,
      });
      // Extension-originated console & exception events.
      ch.emit("Runtime.consoleAPICalled", {
        type: "log",
        executionContextId: 77,
        args: [{ type: "string", value: "from extension" }],
      });
      ch.emit("Runtime.exceptionThrown", {
        exceptionDetails: {
          text: "Uncaught",
          executionContextId: 77,
          url: extScriptUrl,
          scriptId: "script-ext-1",
          exception: {
            type: "object",
            description: `Error: ext\n    at ${extScriptUrl}:1:1`,
            objectId: "ext.77.1",
          },
        },
      });
      // Page-originated console event with mixed stack trace containing an extension frame.
      ch.emit("Runtime.consoleAPICalled", {
        type: "log",
        executionContextId: 1,
        args: [{ type: "string", value: "page log" }],
        stackTrace: {
          callFrames: [
            {
              functionName: "appFn",
              scriptId: "script-page-1",
              url: "https://example.test/app.js",
            },
            { functionName: "extHook", scriptId: "script-ext-1", url: extScriptUrl },
          ],
        },
      });
      // Page-originated exception with stack trace & formatted description referencing extension URL.
      ch.emit("Runtime.exceptionThrown", {
        exceptionDetails: {
          text: "Uncaught",
          executionContextId: 1,
          stackTrace: {
            callFrames: [
              {
                functionName: "pageFn",
                scriptId: "script-page-1",
                url: "https://example.test/app.js",
              },
              { functionName: "extWrap", scriptId: "script-ext-1", url: extScriptUrl },
            ],
          },
          exception: {
            type: "object",
            description: `Error: boom\n    at pageFn (https://example.test/app.js:2:1)\n    at extWrap (${extScriptUrl}:9:3)`,
          },
        },
      });
    }

    // Connected agent never sees extension id, name, context, script, or extension stack frames.
    const serializedConn = JSON.stringify(connEvents);
    expect(serializedConn).not.toContain(extId);
    expect(serializedConn).not.toContain("Secret Password Manager");
    expect(serializedConn).not.toContain("script-ext-1");
    expect(serializedConn).not.toContain("from extension");
    // Connected agent still receives the page's own context, script, and scrubbed page log/exception.
    expect(
      connEvents.filter(({ method }) => method === "Runtime.executionContextCreated"),
    ).toHaveLength(1);
    expect(connEvents.filter(({ method }) => method === "Debugger.scriptParsed")).toHaveLength(1);
    const pageConsole = connEvents.find(({ method }) => method === "Runtime.consoleAPICalled")!;
    expect(
      (pageConsole.parameters.stackTrace as { callFrames: { url: string }[] }).callFrames,
    ).toEqual([
      { functionName: "appFn", scriptId: "script-page-1", url: "https://example.test/app.js" },
    ]);
    const pageException = connEvents.find(({ method }) => method === "Runtime.exceptionThrown")!;
    expect(
      (pageException.parameters.exceptionDetails as { exception: { description: string } })
        .exception.description,
    ).not.toContain("chrome-extension:");

    // Connected agent cannot evaluate in the extension context by id, uniqueContextId, or objectId,
    // nor read its script source, nor add an unscoped binding that enters it.
    for (const [method, parameters] of [
      ["Runtime.evaluate", { contextId: 77, expression: "chrome.storage" }],
      ["Runtime.evaluate", { uniqueContextId: "ext-unique-77", expression: "chrome.storage" }],
      ["Runtime.callFunctionOn", { executionContextId: 77, functionDeclaration: "() => 1" }],
      ["Runtime.callFunctionOn", { objectId: "-12345.77.1", functionDeclaration: "() => 1" }],
      ["Debugger.getScriptSource", { scriptId: "script-ext-1" }],
      ["Debugger.setBreakpointByUrl", { url: extScriptUrl, lineNumber: 1 }],
    ] as const) {
      await expect(
        connClient.send({ method, parameters, sessionId: connSession }),
      ).rejects.toBeInstanceOf(SessionCdpRouterError);
    }
    await connClient.send({
      method: "Runtime.addBinding",
      parameters: { name: "pageHook" },
      sessionId: connSession,
    });
    expect(connChannel.commands.at(-1)).toEqual({
      method: "Runtime.addBinding",
      parameters: { name: "pageHook", executionContextName: "" },
    });

    // Page.getResourceTree is already refused to connected agents; Page.getFrameTree and
    // Page.getNavigationHistory prune extension subframes and history entries.
    await expect(
      connClient.send({ method: "Page.getResourceTree", sessionId: connSession }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining(
        "Page.getResourceTree is not available to a connected agent.",
      ),
    });
    connChannel.results.set("Page.getFrameTree", {
      frameTree: {
        frame: { id: "main", url: "https://example.test/", securityOrigin: "https://example.test" },
        childFrames: [
          {
            frame: { id: "ext-frame-1", url: extPopupUrl, securityOrigin: extOrigin },
          },
          {
            frame: {
              id: "web-frame-1",
              url: "https://sub.example.test/",
              securityOrigin: "https://sub.example.test",
            },
          },
        ],
      },
    });
    const frameTree = await connClient.send({
      method: "Page.getFrameTree",
      sessionId: connSession,
    });
    expect(JSON.stringify(frameTree)).not.toContain(extId);
    expect(JSON.stringify(frameTree)).toContain("web-frame-1");

    connChannel.results.set("Page.getNavigationHistory", {
      currentIndex: 1,
      entries: [
        { id: 1, url: extPopupUrl, title: "Secret Extension" },
        { id: 2, url: "https://example.test/", title: "App" },
      ],
    });
    const history = await connClient.send({
      method: "Page.getNavigationHistory",
      sessionId: connSession,
    });
    expect(JSON.stringify(history)).not.toContain(extId);
    expect(JSON.stringify(history)).toContain("https://example.test/");

    // A Run's connection keeps #745's full visibility of extension contexts and scripts.
    const serializedRun = JSON.stringify(runEvents);
    expect(serializedRun).toContain(extId);
    expect(serializedRun).toContain("Secret Password Manager");
    expect(serializedRun).toContain("script-ext-1");
    await expect(
      runClient.send({
        method: "Runtime.evaluate",
        parameters: { contextId: 77, expression: "1" },
        sessionId: runSession,
      }),
    ).resolves.toBeDefined();

    await router.close();
  });

  it("refuses unseen guessed context, object, and script IDs when Runtime/Debugger was never enabled, while admitting learned page worlds silently (M2, S5)", async () => {
    const backend = new FakeBackend();
    backend.extensions = true;
    backend.dedicatedContext = true;
    backend.targetInfos = [{ targetId: "seed", type: "page", url: "https://example.test/" }];
    backend.prepareChannel = (channel) => {
      channel.contexts = [
        frameWorld(1),
        {
          id: 77,
          origin: extOrigin,
          name: "Secret Password Manager",
          uniqueId: "ext-unique-77",
          auxData: { frameId: "main", isDefault: false, type: "isolated" },
        },
        // Even if an extension content-script world reported the page origin (isolated non-agent world):
        {
          id: 78,
          origin: "https://example.test",
          name: "Another Extension",
          uniqueId: "ext-unique-78",
          auxData: { frameId: "main", isDefault: false, type: "isolated" },
        },
      ];
    };
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "seed", async () => true, "/files/a");
    const client = router.openStandardClient("a", {
      wholeContext: false,
      connection: true,
      lineage: { attachmentId: "conn-m2", seedTargetId: "seed" },
    });
    const events: CdpEvent[] = [];
    client.onEvent((event) => events.push(event));
    const { sessionId } = (await client.send({
      method: "Target.attachToTarget",
      parameters: { targetId: "seed", flatten: true },
    })) as { sessionId: string };
    const channel = backend.channels.get("seed")!;

    // Agent NEVER calls Runtime.enable or Debugger.enable; guessed extension / unseen IDs must fail.
    for (const [method, parameters] of [
      ["Runtime.evaluate", { contextId: 77, expression: "chrome.runtime.id", returnByValue: true }],
      ["Runtime.evaluate", { contextId: 78, expression: "chrome.runtime.id", returnByValue: true }],
      ["Runtime.evaluate", { contextId: 99, expression: "1", returnByValue: true }],
      ["Runtime.evaluate", { uniqueContextId: "ext-unique-77", expression: "1" }],
      ["DOM.resolveNode", { nodeId: 1, executionContextId: 77 }],
      ["Runtime.callFunctionOn", { executionContextId: 77, functionDeclaration: "() => 1" }],
      ["Runtime.callFunctionOn", { objectId: "-12345.77.1", functionDeclaration: "() => 1" }],
      ["Runtime.globalLexicalScopeNames", { executionContextId: 77 }],
      ["Runtime.addBinding", { name: "leak", executionContextId: 77 }],
      ["Debugger.getScriptSource", { scriptId: "99" }],
    ] as const) {
      await expect(
        client.send({ method, parameters, sessionId }),
        `${method} ${JSON.stringify(parameters)}`,
      ).rejects.toMatchObject({ code: "not_found" });
    }
    expect(
      channel.commands.some(
        (c) =>
          (c.method === "Runtime.evaluate" && c.parameters?.contextId !== 1) ||
          c.method === "DOM.resolveNode" ||
          c.method === "Debugger.getScriptSource",
      ),
    ).toBe(false);
    // Internal Runtime.enable must NOT leak Runtime.executionContextCreated to an agent that did not enable Runtime.
    expect(events.some((e) => e.method === "Runtime.executionContextCreated")).toBe(false);

    // Real learned page main world (id 1) succeeds even though the agent never called Runtime.enable.
    await expect(
      client.send({
        method: "Runtime.evaluate",
        sessionId,
        parameters: { contextId: 1, expression: "document.title", returnByValue: true },
      }),
    ).resolves.toBeDefined();
    await expect(
      client.send({
        method: "DOM.resolveNode",
        sessionId,
        parameters: { nodeId: 1, executionContextId: 1 },
      }),
    ).resolves.toBeDefined();

    // If the agent later calls Runtime.enable, it receives only the page world, never 77 or 78.
    await client.send({ method: "Runtime.enable", sessionId });
    const createdIds = events
      .filter((e) => e.method === "Runtime.executionContextCreated")
      .map((e) => (e.parameters.context as { id: number }).id);
    expect(createdIds).toEqual([1]);

    await router.close();
  });

  it("ends a connection channel immediately if its main frame or child frame navigates to chrome-extension: (M1b)", async () => {
    const backend = new FakeBackend();
    backend.extensions = true;
    backend.dedicatedContext = true;
    backend.targetInfos = [{ targetId: "seed", type: "page", url: "https://example.test/" }];
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "seed", async () => true, "/files/a");
    const client = router.openStandardClient("a", {
      wholeContext: false,
      connection: true,
      lineage: { attachmentId: "conn-m1b", seedTargetId: "seed" },
    });
    const events: CdpEvent[] = [];
    client.onEvent((event) => events.push(event));
    const { sessionId } = (await client.send({
      method: "Target.attachToTarget",
      parameters: { targetId: "seed", flatten: true },
    })) as { sessionId: string };
    const channel = backend.channels.get("seed")!;

    // Main frame commits an extension page (e.g., via page JS or redirect): channel must end at once.
    channel.emit("Page.frameNavigated", {
      frame: { id: "main", url: `${extOrigin}/popup.html`, securityOrigin: extOrigin },
    });
    channel.emit("Runtime.executionContextCreated", {
      context: {
        id: 9,
        origin: extOrigin,
        name: "",
        auxData: { frameId: "main", isDefault: true, type: "default" },
      },
    });
    expect(events.some((e) => e.method === "Page.frameNavigated")).toBe(false);
    expect(
      events.some(
        (e) => e.method === "Target.detachedFromTarget" && e.parameters.sessionId === sessionId,
      ),
    ).toBe(true);
    await expect(
      client.send({
        method: "Runtime.evaluate",
        sessionId,
        parameters: {
          expression: "chrome.tabs.query({})",
          returnByValue: true,
          awaitPromise: true,
        },
      }),
    ).rejects.toMatchObject({ code: "not_found", message: "CDP session is not attached here." });
    expect(channel.commands.some((c) => c.method === "Runtime.evaluate")).toBe(false);

    await router.close();
  });

  it("namespaces connection-chosen world names so extension names are never an oracle or reachable (M5)", async () => {
    const backend = new FakeBackend();
    backend.extensions = true;
    backend.dedicatedContext = true;
    backend.targetInfos = [{ targetId: "seed", type: "page", url: "https://example.test/" }];
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "seed", async () => true, "/files/a");
    const client = router.openStandardClient("a", {
      wholeContext: false,
      connection: true,
      lineage: { attachmentId: "conn-m5", seedTargetId: "seed" },
    });
    const events: CdpEvent[] = [];
    client.onEvent((event) => events.push(event));
    const { sessionId } = (await client.send({
      method: "Target.attachToTarget",
      parameters: { targetId: "seed", flatten: true },
    })) as { sessionId: string };
    const channel = backend.channels.get("seed")!;
    await client.send({ method: "Runtime.enable", sessionId });
    channel.emit("Runtime.executionContextCreated", {
      context: {
        id: 77,
        origin: extOrigin,
        name: "Secret Password Manager",
        uniqueId: "u77",
        auxData: { frameId: "main", isDefault: false, type: "isolated" },
      },
    });
    channel.results.set("Page.createIsolatedWorld", { executionContextId: 88 });

    // Choosing the exact installed extension name succeeds identically to any random name.
    const randomRes = await client.send({
      method: "Page.createIsolatedWorld",
      sessionId,
      parameters: { frameId: "main", worldName: "Some Random Name" },
    });
    const extNameRes = await client.send({
      method: "Page.createIsolatedWorld",
      sessionId,
      parameters: { frameId: "main", worldName: "Secret Password Manager" },
    });
    expect(extNameRes).toEqual(randomRes);
    const createdCmd = channel.commands.find(
      (c) =>
        c.method === "Page.createIsolatedWorld" &&
        String(c.parameters?.worldName).endsWith("Secret Password Manager"),
    )!;
    const rewrittenWorld = String(createdCmd.parameters?.worldName);
    expect(rewrittenWorld).not.toBe("Secret Password Manager");
    expect(rewrittenWorld.startsWith("opensteer-")).toBe(false);

    // Event for the agent's own namespaced world is delivered with the prefix stripped, and id 88 is usable.
    channel.emit("Runtime.executionContextCreated", {
      context: {
        id: 88,
        origin: "https://example.test",
        name: rewrittenWorld,
        uniqueId: "u88",
        auxData: { frameId: "main", isDefault: false, type: "isolated" },
      },
    });
    expect(
      events.some(
        (e) =>
          e.method === "Runtime.executionContextCreated" &&
          (e.parameters.context as { id: number; name: string }).id === 88 &&
          (e.parameters.context as { id: number; name: string }).name === "Secret Password Manager",
      ),
    ).toBe(true);
    await expect(
      client.send({
        method: "Runtime.evaluate",
        sessionId,
        parameters: { contextId: 88, expression: "1" },
      }),
    ).resolves.toBeDefined();

    // Runtime.addBinding and Page.addScriptToEvaluateOnNewDocument also namespace non-empty world names.
    await client.send({
      method: "Runtime.addBinding",
      sessionId,
      parameters: { name: "poke", executionContextName: "Secret Password Manager" },
    });
    const bindingCmd = channel.commands.find((c) => c.method === "Runtime.addBinding")!;
    expect(bindingCmd.parameters?.executionContextName).toBe(rewrittenWorld);

    await client.send({
      method: "Page.addScriptToEvaluateOnNewDocument",
      sessionId,
      parameters: { source: "1", worldName: "Secret Password Manager" },
    });
    const scriptCmd = channel.commands.find(
      (c) => c.method === "Page.addScriptToEvaluateOnNewDocument",
    )!;
    expect(scriptCmd.parameters?.worldName).toBe(rewrittenWorld);

    await router.close();
  });

  it("isolates connection-flagged commands sent on a Run's root session without a script attachment (M3)", async () => {
    const backend = new FakeBackend();
    backend.extensions = true;
    backend.targetInfos = [
      { targetId: "seed", type: "page", url: "https://example.test/" },
      { targetId: "ext-bg", type: "service_worker", url: `${extOrigin}/worker.js` },
    ];
    backend.prepareChannel = (channel) => {
      channel.contexts = [
        frameWorld(1),
        {
          id: 77,
          origin: extOrigin,
          name: "Secret Password Manager",
          uniqueId: "u77",
          auxData: { frameId: "main", isDefault: false, type: "isolated" },
        },
      ];
    };
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "seed", async () => true, "/files/a");
    router.claimTarget("a", "ext-bg", "seed");
    const events: CdpEvent[] = [];
    router.onEvent("a", (event) => events.push(event));

    // Target discovery with connection: true hides extension targets.
    const targets = (await router.send("a", {
      method: "Target.getTargets",
      connection: true,
    })) as { targetInfos: { targetId: string }[] };
    expect(targets.targetInfos.map((t) => t.targetId)).toEqual(["seed"]);

    // Attaching with connection: true on the root session creates an isolated connection channel.
    const { sessionId } = (await router.send("a", {
      method: "Target.attachToTarget",
      parameters: { targetId: "seed", flatten: true },
      connection: true,
    })) as { sessionId: string };
    const channel = backend.channels.get("seed")!;
    channel.emit("Runtime.executionContextCreated", {
      context: {
        id: 77,
        origin: extOrigin,
        name: "Secret Password Manager",
        auxData: { frameId: "main", isDefault: false, type: "isolated" },
      },
    });
    expect(events.some((e) => e.method === "Runtime.executionContextCreated")).toBe(false);
    await expect(
      router.send("a", {
        method: "Runtime.evaluate",
        sessionId,
        connection: true,
        parameters: { contextId: 77, expression: "1" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      channel.commands.some(
        (c) => c.method === "Runtime.evaluate" && c.parameters?.contextId === 77,
      ),
    ).toBe(false);

    // Extension child iframe announced on that connection-attached channel is detached and dropped.
    channel.emit("Target.attachedToTarget", {
      sessionId: "phys-ext-child",
      targetInfo: { targetId: "ext-frame", type: "iframe", url: extPopupUrl },
      waitingForDebugger: false,
    });
    expect(
      channel.commands.some(
        (c) =>
          c.method === "Target.detachFromTarget" && c.parameters?.sessionId === "phys-ext-child",
      ),
    ).toBe(true);
    expect(events.some((e) => e.method === "Target.attachedToTarget")).toBe(false);

    await router.close();
  });

  it("refuses Debugger.setBreakpointByUrl urlRegex/scriptHash/non-http URLs and strips disallowed locations without throwing (N1)", async () => {
    const backend = new FakeBackend();
    backend.extensions = true;
    backend.dedicatedContext = true;
    backend.targetInfos = [{ targetId: "seed", type: "page", url: "https://example.test/" }];
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "seed", async () => true, "/files/a");
    const client = router.openStandardClient("a", {
      wholeContext: false,
      connection: true,
      lineage: { attachmentId: "conn-n1", seedTargetId: "seed" },
    });
    const { sessionId } = (await client.send({
      method: "Target.attachToTarget",
      parameters: { targetId: "seed", flatten: true },
    })) as { sessionId: string };
    const channel = backend.channels.get("seed")!;
    await client.send({ method: "Runtime.enable", sessionId });
    await client.send({ method: "Debugger.enable", sessionId });
    channel.emit("Debugger.scriptParsed", {
      scriptId: "10",
      url: "https://example.test/app.js",
      executionContextId: 1,
    });

    for (const parameters of [
      {
        urlRegex: ".*",
        lineNumber: 0,
        condition: "document.body.dataset.x = chrome.runtime.id, false",
      },
      { urlRegex: "abcdefghijklmnop.*", lineNumber: 0 },
      { scriptHash: "abc123", lineNumber: 0 },
      { url: `${extOrigin}/content.js`, lineNumber: 0 },
      { url: `blob:${extOrigin}/0b1c`, lineNumber: 0 },
      { url: "file:///etc/passwd", lineNumber: 0 },
      { lineNumber: 0 },
    ]) {
      await expect(
        client.send({ method: "Debugger.setBreakpointByUrl", sessionId, parameters }),
        JSON.stringify(parameters),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(channel.commands.some((c) => c.method === "Debugger.setBreakpointByUrl")).toBe(false);

    // Explicit https:// URL succeeds; disallowed locations are stripped rather than throwing an oracle.
    channel.results.set("Debugger.setBreakpointByUrl", {
      breakpointId: "bp-1",
      locations: [
        { scriptId: "10", lineNumber: 0 },
        { scriptId: "55", lineNumber: 0 },
      ],
    });
    await expect(
      client.send({
        method: "Debugger.setBreakpointByUrl",
        sessionId,
        parameters: { url: "https://example.test/app.js", lineNumber: 0 },
      }),
    ).resolves.toEqual({
      breakpointId: "bp-1",
      locations: [{ scriptId: "10", lineNumber: 0 }],
    });

    await router.close();
  });

  it("subscribes connection channels at attach and ends EVERY connection channel on the target upon main-frame extension commit without agent enables (N2)", async () => {
    const backend = new FakeBackend();
    backend.extensions = true;
    backend.dedicatedContext = true;
    backend.targetInfos = [{ targetId: "seed", type: "page", url: "https://example.test/" }];
    const channels: FakeChannel[] = [];
    backend.prepareChannel = (ch) => {
      channels.push(ch);
      ch.contexts = [frameWorld(1, { frameId: "seed", isDefault: true, type: "default" })];
    };
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "seed", async () => true, "/files/a");

    const client1 = router.openStandardClient("a", {
      wholeContext: false,
      connection: true,
      lineage: { attachmentId: "conn-n2-1", seedTargetId: "seed" },
    });
    const client2 = router.openStandardClient("a", {
      wholeContext: false,
      connection: true,
      lineage: { attachmentId: "conn-n2-2", seedTargetId: "seed" },
    });
    const events1: CdpEvent[] = [];
    const events2: CdpEvent[] = [];
    client1.onEvent((e) => events1.push(e));
    client2.onEvent((e) => events2.push(e));

    // Neither client sends Page.enable, Runtime.enable, or any ID-carrying command.
    const { sessionId: session1 } = (await client1.send({
      method: "Target.attachToTarget",
      parameters: { targetId: "seed", flatten: true },
    })) as { sessionId: string };
    const { sessionId: session2 } = (await client2.send({
      method: "Target.attachToTarget",
      parameters: { targetId: "seed", flatten: true },
    })) as { sessionId: string };
    expect(channels).toHaveLength(2);
    expect(channels[0]!.commands.some((c) => c.method === "Runtime.enable")).toBe(true);
    expect(channels[1]!.commands.some((c) => c.method === "Runtime.enable")).toBe(true);
    expect(events1.some((e) => e.method.startsWith("Runtime."))).toBe(false);
    expect(events2.some((e) => e.method.startsWith("Runtime."))).toBe(false);

    // Main frame commits chrome-extension: on channel 0 ONLY — BOTH connection channels must end at once.
    channels[0]!.emit("Runtime.executionContextCreated", {
      context: {
        id: 9,
        origin: extOrigin,
        name: "",
        auxData: { frameId: "seed", isDefault: true, type: "default" },
      },
    });
    expect(
      events1.some(
        (e) => e.method === "Target.detachedFromTarget" && e.parameters.sessionId === session1,
      ),
    ).toBe(true);
    expect(
      events2.some(
        (e) => e.method === "Target.detachedFromTarget" && e.parameters.sessionId === session2,
      ),
    ).toBe(true);
    for (const [client, sid] of [
      [client1, session1],
      [client2, session2],
    ] as const) {
      await expect(
        client.send({
          method: "Runtime.evaluate",
          sessionId: sid,
          parameters: { expression: "chrome.tabs.query({})", returnByValue: true },
        }),
      ).rejects.toMatchObject({ code: "not_found", message: "CDP session is not attached here." });
    }

    await router.close();
  });

  it("drops allowed script IDs when their context is destroyed or contexts are cleared (N3)", async () => {
    const backend = new FakeBackend();
    backend.extensions = true;
    backend.dedicatedContext = true;
    backend.targetInfos = [{ targetId: "seed", type: "page", url: "https://example.test/" }];
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "seed", async () => true, "/files/a");
    const client = router.openStandardClient("a", {
      wholeContext: false,
      connection: true,
      lineage: { attachmentId: "conn-n3", seedTargetId: "seed" },
    });
    const events: CdpEvent[] = [];
    client.onEvent((e) => events.push(e));
    const { sessionId } = (await client.send({
      method: "Target.attachToTarget",
      parameters: { targetId: "seed", flatten: true },
    })) as { sessionId: string };
    const channel = backend.channels.get("seed")!;
    await client.send({ method: "Runtime.enable", sessionId });
    await client.send({ method: "Debugger.enable", sessionId });

    channel.emit("Debugger.scriptParsed", {
      scriptId: "25",
      url: "https://a.test/app.js",
      executionContextId: 1,
    });
    await expect(
      client.send({
        method: "Debugger.getScriptSource",
        sessionId,
        parameters: { scriptId: "25" },
      }),
    ).resolves.toBeDefined();

    // Cross-process clear: script 25 is reused by an extension content script in new context 2.
    channel.emit("Runtime.executionContextsCleared", {});
    channel.emit("Runtime.executionContextCreated", {
      context: {
        id: 1,
        origin: "https://b.test",
        name: "",
        uniqueId: "b1",
        auxData: { frameId: "seed", isDefault: true, type: "default" },
      },
    });
    channel.emit("Runtime.executionContextCreated", {
      context: {
        id: 2,
        origin: extOrigin,
        name: "Secret Password Manager",
        uniqueId: "b2",
        auxData: { frameId: "seed", isDefault: false, type: "isolated" },
      },
    });
    channel.emit("Debugger.scriptParsed", {
      scriptId: "25",
      url: extScriptUrl,
      executionContextId: 2,
    });
    await expect(
      client.send({
        method: "Debugger.getScriptSource",
        sessionId,
        parameters: { scriptId: "25" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    channel.emit("Debugger.paused", {
      callFrames: [{ callFrameId: "cf-1", location: { scriptId: "25", lineNumber: 0 }, url: "" }],
    });
    expect(events.some((e) => e.method === "Debugger.paused")).toBe(false);

    // Individual executionContextDestroyed also drops scripts bound to that context.
    channel.emit("Debugger.scriptParsed", {
      scriptId: "30",
      url: "https://b.test/sub.js",
      executionContextId: 1,
    });
    channel.emit("Runtime.executionContextDestroyed", { executionContextId: 1 });
    await expect(
      client.send({
        method: "Debugger.getScriptSource",
        sessionId,
        parameters: { scriptId: "30" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    await router.close();
  });

  it("gates all Runtime.* events on agentRuntimeEnabled, ignores extension subframes without false compromise, handles blob:/filesystem: extension URLs, and does not leak connection control on failed attach (S-b, S-d, S-e, S-g)", async () => {
    const backend = new FakeBackend();
    backend.extensions = true;
    backend.dedicatedContext = true;
    const controlledHistory: [string, boolean][] = [];
    backend.setConnectionControlled = (targetId, controlled) => {
      controlledHistory.push([targetId, controlled]);
    };
    backend.targetInfos = [
      { targetId: "seed", type: "page", url: "https://example.test/" },
      { targetId: "ext-blob", type: "page", url: `blob:${extOrigin}/0b1c` },
      { targetId: "ext-fs", type: "page", url: `filesystem:${extOrigin}/temporary/x` },
    ];
    backend.prepareChannel = (ch) => {
      ch.contexts = [frameWorld(1, { frameId: "seed", isDefault: true, type: "default" })];
    };
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "seed", async () => true, "/files/a");
    router.claimTarget("a", "ext-blob");
    router.claimTarget("a", "ext-fs");

    const client = router.openStandardClient("a", {
      wholeContext: false,
      connection: true,
      lineage: { attachmentId: "conn-sb", seedTargetId: "seed" },
    });
    const events: CdpEvent[] = [];
    client.onEvent((e) => events.push(e));

    // S-d: blob:chrome-extension: and filesystem:chrome-extension: targets are hidden and refused.
    const targets = (await client.send({ method: "Target.getTargets" })) as {
      targetInfos: { targetId: string }[];
    };
    expect(targets.targetInfos.map((t) => t.targetId)).toEqual(["seed"]);

    const { sessionId } = (await client.send({
      method: "Target.attachToTarget",
      parameters: { targetId: "seed", flatten: true },
    })) as { sessionId: string };
    const channel = backend.channels.get("seed")!;

    // S-b: without Runtime.enable, Runtime.consoleAPICalled / exceptionThrown / bindingCalled never leak.
    channel.emit("Runtime.consoleAPICalled", { type: "log", args: [], executionContextId: 1 });
    channel.emit("Runtime.exceptionThrown", {
      exceptionDetails: { text: "oops", executionContextId: 1 },
    });
    channel.emit("Runtime.bindingCalled", { name: "h", payload: "1", executionContextId: 1 });
    expect(events.some((e) => e.method.startsWith("Runtime."))).toBe(false);

    // After Runtime.enable then Runtime.disable, Runtime.* events stop again.
    await client.send({ method: "Runtime.enable", sessionId });
    await client.send({ method: "Runtime.disable", sessionId });
    events.length = 0;
    channel.emit("Runtime.consoleAPICalled", { type: "log", args: [], executionContextId: 1 });
    expect(events.some((e) => e.method.startsWith("Runtime."))).toBe(false);

    // S-g: default-world extension-origin context in an unseen SUBFRAME must NOT falsely compromise main page.
    channel.emit("Runtime.executionContextCreated", {
      context: {
        id: 88,
        origin: extOrigin,
        name: "",
        auxData: { frameId: "subframe-99", isDefault: true, type: "default" },
      },
    });
    await expect(
      client.send({
        method: "Runtime.evaluate",
        sessionId,
        parameters: { contextId: 1, expression: "1", returnByValue: true },
      }),
    ).resolves.toBeDefined();

    // A non-default content script running inside an ordinary web subframe must NOT mark that web
    // subframe as an extension frame.
    channel.emit("Runtime.executionContextCreated", {
      context: {
        id: 89,
        origin: extOrigin,
        name: "Content Script",
        auxData: { frameId: "web-subframe-1", isDefault: false, type: "isolated" },
      },
    });
    await expect(
      client.send({
        method: "Page.createIsolatedWorld",
        sessionId,
        parameters: { frameId: "web-subframe-1", worldName: "helper" },
      }),
    ).resolves.toBeDefined();

    client.close();
    expect(controlledHistory.at(-1)).toEqual(["seed", false]);

    // S-e: failed attach (claim released during pending attach) never calls setConnectionControlled(true).
    controlledHistory.length = 0;
    const gate = Promise.withResolvers<void>();
    const origAttach = backend.attach.bind(backend);
    backend.attach = async (targetId) => {
      await gate.promise;
      return origAttach(targetId);
    };
    const failingAttach = router.send("a", {
      method: "Target.attachToTarget",
      parameters: { targetId: "seed", flatten: true },
      connection: true,
    });
    await Promise.resolve();
    router.releaseTarget("a", "seed");
    gate.resolve();
    await expect(failingAttach).rejects.toMatchObject({ code: "not_found" });
    expect(controlledHistory).toEqual([]);

    await router.close();
  });

  it("returns connection attach on a dialog-blocked page without waiting, lets Page.handleJavaScriptDialog through, bounds script/id commands with a retryable refusal without ending the channel, and preserves specific crash errors (S9, S6)", async () => {
    vi.useFakeTimers();
    try {
      const backend = new FakeBackend();
      backend.extensions = true;
      backend.dedicatedContext = true;
      const controlledHistory: [string, boolean][] = [];
      backend.setConnectionControlled = (targetId, controlled) => {
        controlledHistory.push([targetId, controlled]);
      };
      backend.targetInfos = [
        { targetId: "seed", type: "page", url: "https://example.test/" },
        { targetId: "next", type: "page", url: "https://example.test/next" },
      ];
      let dialogGate = Promise.withResolvers<void>();
      backend.prepareChannel = (channel, targetId) => {
        if (targetId === "seed") {
          channel.contexts = [
            frameWorld(1, { frameId: "seed", isDefault: true, type: "default" }),
            {
              id: 77,
              origin: extOrigin,
              name: "Secret Password Manager",
              auxData: { frameId: "seed", isDefault: false, type: "isolated" },
            },
          ];
          channel.enableGate = dialogGate.promise;
        }
      };
      const router = new SessionCdpRouter(backend, { internalRuntimeEnableTimeoutMs: 25 });
      router.registerSession("a", "seed", async () => true, "/files/a");

      const client = router.openStandardClient("a", {
        wholeContext: false,
        connection: true,
        lineage: { attachmentId: "conn-s9", seedTargetId: "seed" },
      });
      router.claimTarget("a", "next", "seed");
      const events: CdpEvent[] = [];
      client.onEvent((e) => events.push(e));

      // S6 + S9: Target.setAutoAttach attaches BOTH the dialog-blocked seed and next without
      // stalling, skipping seed, or emitting any stray Target.detachedFromTarget.
      await client.send({
        method: "Target.setAutoAttach",
        parameters: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      });
      const attachedEvents = events.filter((e) => e.method === "Target.attachedToTarget");
      expect(
        attachedEvents.map((e) => (e.parameters.targetInfo as { targetId: string }).targetId),
      ).toEqual(["seed", "next"]);
      expect(events.filter((e) => e.method === "Target.detachedFromTarget")).toHaveLength(0);
      const seedSession = attachedEvents.find(
        (e) => (e.parameters.targetInfo as { targetId: string }).targetId === "seed",
      )!.parameters.sessionId as string;
      const seedChannel = backend.channels.get("seed")!;

      // While the dialog holds Runtime.enable, Runtime.evaluate (and any id-bearing command) waits
      // and refuses with the retryable page sentence on timeout WITHOUT ending the channel.
      const heldEval = client
        .send({
          method: "Runtime.evaluate",
          sessionId: seedSession,
          parameters: { expression: "1 + 1", returnByValue: true },
        })
        .then(
          () => "resolved" as const,
          (error: unknown) => error,
        );
      const heldId = client
        .send({
          method: "Runtime.evaluate",
          sessionId: seedSession,
          parameters: { contextId: 77, expression: "chrome.runtime.id" },
        })
        .then(
          () => "resolved" as const,
          (error: unknown) => error,
        );
      await vi.advanceTimersByTimeAsync(25);
      expect(await heldEval).toMatchObject({
        code: "conflict",
        message: "The page is not answering; try again.",
      });
      expect(await heldId).toMatchObject({
        code: "conflict",
        message: "The page is not answering; try again.",
      });
      expect(seedChannel.commands.some((c) => c.method === "Runtime.evaluate")).toBe(false);
      expect(seedChannel.closed).toBe(false);

      // Page.handleJavaScriptDialog ALWAYS goes straight through without waiting for inventory!
      await expect(
        client.send({
          method: "Page.handleJavaScriptDialog",
          sessionId: seedSession,
          parameters: { accept: true },
        }),
      ).resolves.toBeDefined();
      expect(seedChannel.commands.some((c) => c.method === "Page.handleJavaScriptDialog")).toBe(
        true,
      );

      // Dismissing the dialog unblocks the pending Runtime.enable: page eval now succeeds,
      // extension context 77 is still refused, and a later main-frame extension commit ends the channel.
      const evalAfterDialog = client.send({
        method: "Runtime.evaluate",
        sessionId: seedSession,
        parameters: { expression: "1 + 1", returnByValue: true },
      });
      dialogGate.resolve();
      await expect(evalAfterDialog).resolves.toBeDefined();
      await expect(
        client.send({
          method: "Runtime.evaluate",
          sessionId: seedSession,
          parameters: { contextId: 77, expression: "chrome.runtime.id" },
        }),
      ).rejects.toMatchObject({ code: "not_found" });

      seedChannel.emit("Runtime.executionContextCreated", {
        context: {
          id: 99,
          origin: extOrigin,
          name: "",
          auxData: { frameId: "seed", isDefault: true, type: "default" },
        },
      });
      expect(
        events.some(
          (e) => e.method === "Target.detachedFromTarget" && e.parameters.sessionId === seedSession,
        ),
      ).toBe(true);

      client.close();
      await client.settled;
      expect(controlledHistory).toContainEqual(["seed", false]);
      expect(controlledHistory).toContainEqual(["next", false]);

      // Specific backend errors (e.g., renderer crash) keep their own sentence for waiting commands
      // AND end the channel (Q1).
      const crashGate = Promise.withResolvers<void>();
      backend.prepareChannel = (channel) => {
        const origSend = channel.send.bind(channel);
        channel.send = async (method, parameters) => {
          if (method === "Runtime.enable") {
            await crashGate.promise;
            throw new Error(
              "Electron browser page crashed (crashed); reload the page to continue.",
            );
          }
          return origSend(method, parameters);
        };
      };
      const crashClient = router.openStandardClient("a", {
        wholeContext: false,
        connection: true,
        lineage: { attachmentId: "conn-crash", seedTargetId: "seed" },
      });
      const { sessionId: crashSession } = (await crashClient.send({
        method: "Target.attachToTarget",
        parameters: { targetId: "seed", flatten: true },
      })) as { sessionId: string };
      const waitingEval = crashClient.send({
        method: "Runtime.evaluate",
        sessionId: crashSession,
        parameters: { expression: "1" },
      });
      crashGate.resolve();
      await expect(waitingEval).rejects.toThrow(
        "Electron browser page crashed (crashed); reload the page to continue.",
      );
      crashClient.close();
      await crashClient.settled;

      await router.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses connection:true on a non-connection channel (S1, S3, S-b), drops no-URL Target events for hidden extension targets (S4), and uses one sentence with no stray detach on compromised attach (S6)", async () => {
    const backend = new FakeBackend();
    backend.extensions = true;
    backend.dedicatedContext = true;
    backend.targetInfos = [
      { targetId: "seed", type: "page", url: "https://example.test/" },
      { targetId: "ext-hidden", type: "page", url: `${extOrigin}/options.html` },
    ];
    const router = new SessionCdpRouter(backend);
    router.registerSession("a", "seed", async () => true, "/files/a");

    // S1 + S3 + S-b (ZZ4 inverted): sending connection:true on a channel attached without
    // connection answers identically to an unknown session (`not_found: CDP session is not
    // attached here.`) and never mutates the person's own channel.
    const { sessionId: ownSession } = (await router.send("a", {
      method: "Target.attachToTarget",
      parameters: { targetId: "seed", flatten: true },
    })) as { sessionId: string };
    await expect(
      router.send("a", {
        method: "Runtime.evaluate",
        sessionId: ownSession,
        connection: true,
        parameters: { expression: "1" },
      }),
    ).rejects.toMatchObject({ code: "not_found", message: "CDP session is not attached here." });
    await expect(
      router.send("a", {
        method: "DOM.getDocument",
        sessionId: "cdp_nope",
        connection: true,
        parameters: {},
      }),
    ).rejects.toMatchObject({ code: "not_found", message: "CDP session is not attached here." });
    await expect(
      router.send("a", {
        method: "Debugger.setBreakpointByUrl",
        sessionId: ownSession,
        parameters: { urlRegex: ".*", lineNumber: 0 },
      }),
    ).resolves.toBeDefined();

    // S4: standard connection client and script connection attachment never see Target.targetDestroyed
    // or Target.detachedFromTarget for an extension target whose Target.targetCreated was hidden.
    const connClient = router.openStandardClient("a", {
      wholeContext: false,
      connection: true,
      lineage: { attachmentId: "conn-s4", seedTargetId: "seed" },
    });
    const stdEvents: CdpEvent[] = [];
    connClient.onEvent((e) => stdEvents.push(e));
    await connClient.send({ method: "Target.setDiscoverTargets", parameters: { discover: true } });

    const scriptEvents: CdpEvent[] = [];
    router.openScriptAttachment(
      "a",
      "script-s4",
      "seed",
      { maxBytes: 64 * 1024, maxDepth: 16, maxEntries: 1024 },
      (e) => scriptEvents.push(e),
      { connection: true },
    );
    backend.emit("Target.targetCreated", {
      targetInfo: {
        targetId: "ext-popup",
        openerId: "seed",
        type: "page",
        url: `${extOrigin}/popup.html`,
      },
    });
    backend.emit("Target.targetDestroyed", { targetId: "ext-popup" });
    expect(JSON.stringify(stdEvents)).not.toContain("ext-popup");
    expect(JSON.stringify(scriptEvents)).not.toContain("ext-popup");

    // S6: a synchronous compromise during attach throws "The target is no longer available."
    // and emits NO Target.attachedToTarget and NO stray Target.detachedFromTarget.
    backend.prepareChannel = (channel) => {
      const origSend = channel.send.bind(channel);
      channel.send = (method, parameters) => {
        if (method === "Runtime.enable") {
          channel.emit("Runtime.executionContextCreated", {
            context: {
              id: 5,
              origin: extOrigin,
              name: "",
              auxData: { frameId: "seed", isDefault: true, type: "default" },
            },
          });
          return Promise.resolve({});
        }
        return origSend(method, parameters);
      };
    };
    stdEvents.length = 0;
    await expect(
      connClient.send({
        method: "Target.attachToTarget",
        parameters: { targetId: "seed", flatten: true },
      }),
    ).rejects.toMatchObject({ code: "not_found", message: "The target is no longer available." });
    expect(stdEvents.filter((e) => e.method === "Target.attachedToTarget")).toHaveLength(0);
    expect(stdEvents.filter((e) => e.method === "Target.detachedFromTarget")).toHaveLength(0);

    await router.closeScriptAttachment("a", "script-s4", Promise.resolve());
    connClient.close();
    await router.close();
  });

  it("ends the connection channel when attach-time Runtime.enable rejects (Q1 / ZZ1 inverted) and holds Page.reload with scriptToEvaluateOnLoad behind inventory (S-a / ZZ2 inverted)", async () => {
    // Q1 (ZZ1 inverted): when attach-time Runtime.enable rejects (e.g. crashed renderer), the
    // channel is ended immediately so no later un-held commands can run without inventory.
    const backend = new FakeBackend();
    backend.dedicatedContext = true;
    backend.targetInfos = [{ targetId: "seed", type: "page", url: "https://example.test/" }];
    let crashed = true;
    backend.prepareChannel = (channel) => {
      const orig = channel.send.bind(channel);
      channel.send = async (method, parameters) => {
        if (method === "Runtime.enable" && crashed) {
          channel.commands.push({ method });
          throw new Error("Electron browser page crashed; reload the page to continue.");
        }
        return orig(method, parameters);
      };
    };
    const router = new SessionCdpRouter(backend, { internalRuntimeEnableTimeoutMs: 25 });
    router.registerSession("a", "seed", async () => true, "/files/a");
    const client = router.openStandardClient("a", {
      wholeContext: false,
      connection: true,
      lineage: { attachmentId: "q1-client", seedTargetId: "seed" },
    });
    const events: CdpEvent[] = [];
    client.onEvent((event) => events.push(event));
    const { sessionId } = (await client.send({
      method: "Target.attachToTarget",
      parameters: { targetId: "seed", flatten: true },
    })) as { sessionId: string };
    const ch = backend.channels.get("seed")!;
    await vi.waitFor(() => expect(ch.closed).toBe(true));
    expect(
      events.some(
        (e) => e.method === "Target.detachedFromTarget" && e.parameters.sessionId === sessionId,
      ),
    ).toBe(true);
    crashed = false;
    for (const [method, parameters] of [
      ["Page.reload", { scriptToEvaluateOnLoad: "window.x = chrome?.runtime?.id" }],
      ["DOM.getDocument", { depth: -1 }],
      ["DOM.getOuterHTML", { nodeId: 1 }],
      [
        "Input.dispatchMouseEvent",
        { type: "mousePressed", x: 1, y: 1, button: "left", clickCount: 1 },
      ],
      ["Page.captureScreenshot", {}],
    ] as const) {
      await expect(
        client.send({ method, sessionId, parameters: parameters as CdpParameters }),
        method,
      ).rejects.toMatchObject({ code: "not_found", message: "CDP session is not attached here." });
    }
    client.close();
    await client.settled;

    // S-a (ZZ2 inverted): Page.reload with scriptToEvaluateOnLoad is held behind inventory while
    // Runtime.enable is pending and refuses with retryable conflict without forwarding Page.reload.
    backend.prepareChannel = (channel) => {
      channel.enableGate = new Promise<void>(() => undefined);
    };
    const heldClient = router.openStandardClient("a", {
      wholeContext: false,
      connection: true,
      lineage: { attachmentId: "sa-client", seedTargetId: "seed" },
    });
    const { sessionId: heldSession } = (await heldClient.send({
      method: "Target.attachToTarget",
      parameters: { targetId: "seed", flatten: true },
    })) as { sessionId: string };
    await expect(
      heldClient.send({
        method: "Page.reload",
        sessionId: heldSession,
        parameters: { scriptToEvaluateOnLoad: "1" },
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "The page is not answering; try again.",
    });
    expect(backend.channels.get("seed")!.commands.some((c) => c.method === "Page.reload")).toBe(
      false,
    );
    // S-a fifth-look: Page.removeScriptToEvaluateOnNewDocument is also held behind inventory.
    await expect(
      heldClient.send({
        method: "Page.removeScriptToEvaluateOnNewDocument",
        sessionId: heldSession,
        parameters: { identifier: "1" },
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "The page is not answering; try again.",
    });
    expect(
      backend.channels
        .get("seed")!
        .commands.some((c) => c.method === "Page.removeScriptToEvaluateOnNewDocument"),
    ).toBe(false);
    heldClient.close();
    await heldClient.settled;
    await router.close();
  });
});
