import { describe, expect, it, vi } from "vitest";
import {
  SessionCdpRouter,
  type BrowserCdpBackend,
  type CdpChannel,
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
});
function asContext(event: import("./session-cdp-router.js").CdpEvent) {
  return event.method === "Runtime.executionContextCreated"
    ? (event.parameters.context as { id: number })
    : null;
}
