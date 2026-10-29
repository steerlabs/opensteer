import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  agentCdpAllowlist,
  type AgentCdpFields,
  type AgentCdpValue,
} from "./agent-cdp-allowlist.js";
import {
  SessionCdpRouter,
  SessionCdpRouterError,
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
    expect(backend.channels.get("root-a")?.commands).toEqual([{ method: "Runtime.enable" }]);
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
    expect(backend.channels.get("root-a")?.commands).toEqual([{ method: "Runtime.enable" }]);
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
      "Runtime.enable",
      "Emulation.setDeviceMetricsOverride",
    ]);
  });

  it("denies unknown browser-scope commands by default", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend);
    router.registerSession("session-a", "root-a", async () => true, "/opensteer-files/session-a");

    await expect(
      router.send("session-a", { method: "Browser.getHistograms" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(router.send("session-a", { method: "Browser.getVersion" })).resolves.toEqual({
      ok: true,
    });
    expect(backend.commands).toEqual([{ method: "Browser.getVersion" }]);
  });

  it("exposes only the Profile context and rejects browser-window commands", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend);
    router.registerSession("session-a", "root-a", async () => true, "/opensteer-files/session-a");
    router.registerSession("session-b", "root-b", async () => true, "/opensteer-files/session-b");

    await expect(
      router.send("session-a", { method: "Target.getBrowserContexts" }),
    ).resolves.toEqual({ ok: true });
    await expect(
      router.send("session-a", {
        method: "Browser.getWindowForTarget",
        parameters: { targetId: "root-a" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("bounds commands, results, streamed events, sessions, and targets", async () => {
    const backend = new FakeBackend();
    const router = new SessionCdpRouter(backend, {
      maxCommandBytes: 200,
      maxEventBytes: 300,
      maxResultBytes: 200,
      maxSessions: 1,
      maxTargetsPerSession: 2,
    });
    router.registerSession("session-a", "root-a", async () => true, "/opensteer-files/session-a");
    const events: import("./session-cdp-router.js").CdpEvent[] = [];
    router.onEvent("session-a", (event) => events.push(event));
    expect(() =>
      router.registerSession("session-b", "root-b", async () => true, "/opensteer-files/session-b"),
    ).toThrow(SessionCdpRouterError);
    await router.send("session-a", { method: "Target.createTarget" });
    await expect(router.send("session-a", { method: "Target.createTarget" })).rejects.toMatchObject(
      { code: "conflict" },
    );
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

/**
 * How the agent CDP boundary could fail, each pinned below:
 * 1. A page method outside the allowlist reaches the page: cookie reads such as
 *    Network.getAllCookies or Network.getCookies for another site, header
 *    capture through Network or Fetch, other origins' storage, debugger and
 *    tracing domains, or Target commands sent on a page session.
 * 2. Network.loadNetworkResource is still forwarded, fetching with the page's cookies.
 * 3. A page method plants or runs script outside the loaded page: new-document
 *    scripts, isolated worlds, CSP bypass, Page.reload's scriptToEvaluateOnLoad,
 *    or compiled and bound scripts.
 * 4. A browser-scope command reaches cookies or storage.
 * 5. A script runs outside a frame's main world: Runtime.evaluate with a
 *    context ID, Runtime.callFunctionOn without an object or with a context,
 *    or DOM.resolveNode into another context.
 * 6. Runtime.evaluate reaches the DevTools command-line API.
 * 7. A parameter the shipped CDP spec does not define for those methods passes,
 *    including names that look like JavaScript internals.
 * 8. Page.printToPDF opens an IO stream.
 * 9. An event outside the page-level allowlist reaches the agent, such as the
 *    Network ExtraInfo events that carry Cookie and Set-Cookie headers.
 * 10. A refused command still reaches the page, or its refusal does not name
 *     the method.
 * 11. The allowlist breaks the shipped harness or common page scripts, or the
 *     existing navigation, file, frame-size and activation checks.
 * 12. Router-generated Target events stop reaching the agent.
 *
 * How main-world provenance could fail open, each pinned below:
 * 13. A world the router never saw announced is usable: an object handle from
 *     a world created before the agent attached, or before the agent enabled
 *     Runtime, reaches the page because nothing marked it as foreign.
 * 14. The inventory depends on the agent: a command other than a dialog's
 *     answer reaches a page before the router's own Runtime.enable there has
 *     reported every context, a subscription that fails or races target
 *     release leaves a session behind, or the agent's Runtime.disable stops
 *     the inventory from tracking.
 * 15. A handle that Chromium parses leniently (strtoll) but is not canonical
 *     `<isolate>.<context>.<object>` passes: leading zeros, a plus sign,
 *     whitespace, extra or missing segments, out-of-range numbers, or a value
 *     that is not a string.
 * 16. A handle outside the first parameter escapes the check:
 *     Runtime.callFunctionOn arguments[].objectId, DOM and Accessibility
 *     objectIds, Runtime.awaitPromise promiseObjectId, or a nested position.
 * 17. A handle is admitted for a context that is not a frame's main world:
 *     isDefault false, type isolated, missing auxData or frameId, never
 *     reported, destroyed, cleared, or an ID a replacement renderer reused
 *     for another world.
 * 18. A late destruction report for an older context removes the current
 *     context that reuses its ID, or a context is matched by ID alone when
 *     Chromium named its unique ID.
 * 19. A non-main world's events reach the agent: its contexts' creation and
 *     destruction, console messages, exceptions (including ones that name no
 *     context), or any event or result that carries one of its handles,
 *     such as Log.entryAdded arguments.
 * 20. The agent's own Runtime.enable stops reporting the main worlds that
 *     already exist, reports a non-main world, or Runtime events reach an
 *     agent that has not enabled Runtime or has disabled it.
 * 21. A command result carries a handle outside a known main world.
 * 22. By-value data that only looks like a handle, such as a returned
 *     object's `objectId` property or a deep serialization's reference IDs,
 *     makes a legitimate result fail.
 * 23. Two page sessions on one target share or overwrite each other's
 *     inventory or Runtime subscription.
 * 24. Chromium's own diagnostics reach the agent: a Log domain command is
 *     forwarded, or a Log.entryAdded event is relayed, such as a CORS failure
 *     that quotes response headers with `source: "javascript"`; or an
 *     Audits or Security event carries what the page's scripts cannot read.
 * 25. An agent releases an object group the platform holds on the same
 *     debugger session, invalidating the platform's handles in other worlds.
 *
 * How the exact allowlist could fail, each pinned below:
 * 26. A domain-wide allowance forwards an event nobody reviewed: one Chromium
 *     adds to DOM or Accessibility later, or one there already that carries
 *     browser internals (adopted style sheet IDs, ad-tagging verdicts, style
 *     engine flags), or an unknown event in any domain.
 * 27. An allowed method passes a parameter, nested field, or enum value the
 *     reviewed spec does not define for it, or one left out on purpose
 *     (Page.navigate referrer, device-metrics scale and viewport), at any
 *     depth, including inside arrays.
 * 28. A key named like an inherited property (`toString`, `constructor`,
 *     `__proto__`, `hasOwnProperty`) passes because the schema reads inherited
 *     properties, or a method with no parameters accepts some.
 * 29. A missing required value or a mistyped one reaches the page, so the
 *     schema is not the whole contract.
 * 30. A method the router answers itself, such as Page.bringToFront, skips
 *     the parameter check.
 * 31. The exact schema breaks what the shipped Browser Harness sends.
 * 32. The reviewed spec moves without a review: the pinned devtools-protocol
 *     changes while the allowlist names the old release, or an allowlisted
 *     method, parameter, enum value or event is not in the shipped spec
 *     (`apps/browser-runtime/src/browser/agent-cdp-allowlist.test.ts`).
 */
describe("agent CDP boundary", () => {
  async function attachedPage(contexts?: Record<string, unknown>[], machineClipboardShared = true) {
    const backend = new FakeBackend();
    if (contexts) {
      backend.prepareChannel = (channel) => {
        channel.contexts = contexts;
      };
    }
    const router = new SessionCdpRouter(backend, {}, machineClipboardShared);
    router.registerSession("session-a", "root-a", async () => true, "/opensteer-files/session-a");
    const events: import("./session-cdp-router.js").CdpEvent[] = [];
    router.onEvent("session-a", (event) => events.push(event));
    const { sessionId } = (await router.send("session-a", {
      method: "Target.attachToTarget",
      parameters: { flatten: true, targetId: "root-a" },
    })) as { sessionId: string };
    const channel = backend.channels.get("root-a");
    if (!channel) throw new Error("Expected an attached page channel.");
    // The router's own Runtime subscription; what follows is the agent's.
    expect(channel.commands).toEqual([{ method: "Runtime.enable" }]);
    channel.commands.length = 0;
    const send = (method: string, parameters?: CdpParameters) =>
      router.send("session-a", { method, ...(parameters ? { parameters } : {}), sessionId });
    return { backend, channel, events, router, send, sessionId };
  }

  it("refuses cookie, network, storage, script-planting and browser-internal page methods", async () => {
    const { channel, send } = await attachedPage();
    const refused: [string, CdpParameters?][] = [
      ["Network.enable"],
      ["Network.getAllCookies"],
      ["Network.getCookies", { urls: ["https://other.example/"] }],
      ["Network.getResponseBody", { requestId: "1" }],
      ["Network.getRequestPostData", { requestId: "1" }],
      ["Network.loadNetworkResource", { options: {}, url: "https://other.example/" }],
      ["Network.setExtraHTTPHeaders", { headers: {} }],
      ["Fetch.enable", { patterns: [{ urlPattern: "*" }] }],
      ["Storage.getCookies"],
      ["Storage.getUsageAndQuota", { origin: "https://other.example" }],
      ["ServiceWorker.enable"],
      ["CacheStorage.requestCacheNames", { securityOrigin: "https://other.example" }],
      ["IndexedDB.requestDatabaseNames", { securityOrigin: "https://other.example" }],
      [
        "DOMStorage.getDOMStorageItems",
        { storageId: { isLocalStorage: true, securityOrigin: "https://other.example" } },
      ],
      ["Security.setIgnoreCertificateErrors", { ignore: true }],
      ["Debugger.enable"],
      ["HeapProfiler.takeHeapSnapshot"],
      ["Profiler.start"],
      ["Tracing.start"],
      ["Memory.getDOMCounters"],
      ["IO.read", { handle: "1" }],
      ["SystemInfo.getInfo"],
      ["Audits.enable"],
      ["Inspector.enable"],
      ["WebAuthn.enable"],
      ["CSS.enable"],
      ["Overlay.setShowFPSCounter", { show: true }],
      ["Browser.getVersion"],
      ["Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "/tmp" }],
      ["Page.addScriptToEvaluateOnNewDocument", { source: "1" }],
      ["Page.createIsolatedWorld", { frameId: "frame" }],
      ["Page.setBypassCSP", { enabled: true }],
      ["Page.setDownloadBehavior", { behavior: "allow", downloadPath: "/tmp" }],
      ["Page.handleFileChooser", { action: "accept", files: [] }],
      ["Page.getResourceContent", { frameId: "frame", url: "https://other.example/" }],
      ["Page.close"],
      ["Runtime.addBinding", { name: "leak" }],
      ["Runtime.compileScript", { expression: "1", persistScript: true, sourceURL: "x" }],
      ["Runtime.runScript", { scriptId: "1" }],
      ["Runtime.queryObjects", { prototypeObjectId: "1.1.1" }],
      ["Opensteer.stageFile", { data: "", fileId: "f", name: "f", offset: 0, size: 0 }],
      ["network.getAllCookies"],
      ["Log.enable"],
      ["Log.disable"],
      ["Log.clear"],
      ["Log.startViolationsReport", { config: [] }],
    ];
    for (const [method, parameters] of refused) {
      const error = await send(method, parameters).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error, method).toBeInstanceOf(SessionCdpRouterError);
      expect(error, method).toMatchObject({ code: "forbidden" });
      expect((error as Error).message, method).toContain(method);
      expect((error as Error).message, method).toMatch(/agents operate pages/u);
    }
    // Target commands on a page session are the router's own, never the page's.
    await expect(
      send("Target.setAutoAttach", {
        autoAttach: true,
        flatten: true,
        waitForDebuggerOnStart: false,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(send("Target.getTargets")).resolves.toEqual({
      rootTargetId: "root-a",
      targetInfos: [],
    });
    expect(channel.commands).toEqual([]);
  });

  it("keeps cookies and storage out of browser-scope commands", async () => {
    const { backend } = await attachedPage();
    const router = new SessionCdpRouter(backend);
    router.registerSession("session-b", "root-b", async () => true, "/opensteer-files/session-b");
    for (const method of [
      "Network.getAllCookies",
      "Storage.getCookies",
      "Storage.clearDataForOrigin",
      "Target.createBrowserContext",
      "Target.exposeDevToolsProtocol",
      "Target.setAutoAttach",
      "Browser.grantPermissions",
    ]) {
      await expect(router.send("session-b", { method }), method).rejects.toMatchObject({
        code: "forbidden",
        message: expect.stringContaining(
          method.startsWith("Target.") ? method : `${method} is not available to agents`,
        ),
      });
    }
    expect(backend.commands).toEqual([]);
  });

  it("forwards what the shipped harness and common page scripts send", async () => {
    const { channel, send, sessionId } = await attachedPage();
    const staged = "/opensteer-files/session-a/photo.png";
    const allowed: [string, CdpParameters?][] = [
      ["Page.enable"],
      ["Page.disable"],
      ["Page.navigate", { url: "https://example.test/a" }],
      ["Page.reload", { ignoreCache: true }],
      ["Page.stopLoading"],
      ["Page.getNavigationHistory"],
      ["Page.navigateToHistoryEntry", { entryId: 1 }],
      ["Page.getFrameTree"],
      ["Page.getLayoutMetrics"],
      ["Page.captureScreenshot", { captureBeyondViewport: true, format: "png" }],
      ["Page.printToPDF", { printBackground: true }],
      ["Page.printToPDF", { transferMode: "ReturnAsBase64" }],
      ["Page.handleJavaScriptDialog", { accept: true }],
      ["Page.setLifecycleEventsEnabled", { enabled: true }],
      ["Page.setInterceptFileChooserDialog", { enabled: true }],
      ["Page.startScreencast", { format: "jpeg", maxHeight: 600, maxWidth: 800 }],
      ["Page.screencastFrameAck", { sessionId: 1 }],
      ["Page.stopScreencast"],
      ["Runtime.enable"],
      ["Runtime.disable"],
      [
        "Runtime.evaluate",
        { awaitPromise: true, expression: "document.title", returnByValue: true },
      ],
      ["Runtime.evaluate", { expression: "1", includeCommandLineAPI: false, objectGroup: "g" }],
      [
        "Runtime.callFunctionOn",
        {
          arguments: [{ value: 1 }],
          functionDeclaration: "function(){return this.files}",
          objectId: "-1.1.1",
          returnByValue: true,
        },
      ],
      ["Runtime.getProperties", { objectId: "-1.1.1", ownProperties: true }],
      ["Runtime.awaitPromise", { promiseObjectId: "-1.1.2", returnByValue: true }],
      ["Runtime.releaseObject", { objectId: "-1.1.1" }],
      ["Runtime.releaseObjectGroup", { objectGroup: "g" }],
      ["DOM.enable"],
      ["DOM.disable"],
      ["DOM.getDocument", { depth: -1, pierce: true }],
      ["DOM.querySelector", { nodeId: 1, selector: "input" }],
      ["DOM.querySelectorAll", { nodeId: 1, selector: "input" }],
      ["DOM.describeNode", { backendNodeId: 4 }],
      ["DOM.resolveNode", { backendNodeId: 4 }],
      ["DOM.resolveNode", { nodeId: 4, objectGroup: "g" }],
      ["DOM.requestNode", { objectId: "-1.1.1" }],
      ["DOM.getBoxModel", { nodeId: 4 }],
      ["DOM.getContentQuads", { nodeId: 4 }],
      ["DOM.getNodeForLocation", { x: 1, y: 1 }],
      ["DOM.getOuterHTML", { nodeId: 4 }],
      ["DOM.getAttributes", { nodeId: 4 }],
      ["DOM.scrollIntoViewIfNeeded", { nodeId: 4 }],
      ["DOM.focus", { nodeId: 4 }],
      ["DOM.setFileInputFiles", { files: [staged], objectId: "-1.1.1" }],
      ["DOM.setFileInputFiles", { backendNodeId: 4, files: [staged] }],
      ["DOM.setAttributeValue", { name: "value", nodeId: 4, value: "x" }],
      ["DOM.removeAttribute", { name: "value", nodeId: 4 }],
      ["DOM.setOuterHTML", { nodeId: 4, outerHTML: "<b></b>" }],
      ["DOM.removeNode", { nodeId: 4 }],
      [
        "Input.dispatchMouseEvent",
        { button: "left", clickCount: 1, type: "mousePressed", x: 1, y: 1 },
      ],
      ["Input.dispatchKeyEvent", { key: "a", text: "a", type: "keyDown" }],
      ["Input.insertText", { text: "hello" }],
      ["Input.dispatchTouchEvent", { touchPoints: [{ x: 1, y: 1 }], type: "touchStart" }],
      [
        "Input.dispatchDragEvent",
        { data: { dragOperationsMask: 1, files: [staged], items: [] }, type: "drop", x: 1, y: 1 },
      ],
      [
        "Emulation.setDeviceMetricsOverride",
        { deviceScaleFactor: 1, height: 600, mobile: false, width: 800 },
      ],
      ["Emulation.clearDeviceMetricsOverride"],
      ["Emulation.setTouchEmulationEnabled", { enabled: true }],
      ["Emulation.setEmulatedMedia", { media: "print" }],
      ["Accessibility.enable"],
      ["Accessibility.disable"],
      ["Accessibility.getFullAXTree", { depth: 4 }],
      ["Accessibility.getPartialAXTree", { backendNodeId: 4 }],
      ["Accessibility.queryAXTree", { accessibleName: "Submit", backendNodeId: 1 }],
      ["DOMSnapshot.captureSnapshot", { computedStyles: [] }],
    ];
    // The agent's Runtime subscription is the router's to answer.
    const answered = new Set(["Runtime.enable", "Runtime.disable"]);
    for (const [method, parameters] of allowed) {
      await expect(send(method, parameters), method).resolves.toEqual(
        answered.has(method) ? {} : { method },
      );
    }
    // Object groups arrive under the agent's own prefix (failure 25).
    const forwarded = (parameters: CdpParameters | undefined) =>
      typeof parameters?.objectGroup === "string"
        ? { ...parameters, objectGroup: `opensteer-agent:${sessionId}:${parameters.objectGroup}` }
        : parameters;
    expect(channel.commands).toEqual(
      allowed
        .filter(([method]) => !answered.has(method))
        .map(([method, parameters]) => ({
          method,
          ...(parameters ? { parameters: forwarded(parameters) } : {}),
        })),
    );
  });

  it("keeps Page.bringToFront as session selection and the existing page checks", async () => {
    const { channel, send } = await attachedPage();
    await expect(send("Page.bringToFront")).resolves.toEqual({});
    await expect(send("Page.navigate", { url: "file:///etc/passwd" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      send("Input.dispatchDragEvent", {
        data: { dragOperationsMask: 1, files: ["/etc/passwd"], items: [] },
        type: "drop",
        x: 1,
        y: 1,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      send("Page.startScreencast", { maxHeight: 20_000, maxWidth: 40_000 }),
    ).rejects.toMatchObject({ code: "bad_command" });
    expect(channel.commands).toEqual([]);
  });

  it("keeps page scripts in the page's main world", async () => {
    const { channel, send } = await attachedPage();
    const refused: [string, CdpParameters][] = [
      ["Runtime.evaluate", { contextId: 2, expression: "1" }],
      ["Runtime.evaluate", { expression: "1", uniqueContextId: "-1.-2" }],
      ["Runtime.evaluate", { contextId: 0, expression: "1" }],
      ["Runtime.evaluate", { contextId: null, expression: "1" }],
      ["Runtime.evaluate", { expression: "copy(document.cookie)", includeCommandLineAPI: true }],
      ["Runtime.evaluate", { expression: "1", includeCommandLineAPI: "true" }],
      ["Runtime.evaluate", { expression: "1", includeCommandLineAPI: 1 }],
      ["Runtime.callFunctionOn", { executionContextId: 2, functionDeclaration: "() => 1" }],
      [
        "Runtime.callFunctionOn",
        { executionContextId: 2, functionDeclaration: "() => 1", objectId: "-1.1.1" },
      ],
      ["Runtime.callFunctionOn", { functionDeclaration: "() => 1", uniqueContextId: "-1.-2" }],
      ["Runtime.callFunctionOn", { functionDeclaration: "() => 1" }],
      ["Runtime.callFunctionOn", { functionDeclaration: "() => 1", objectId: 7 }],
      ["DOM.resolveNode", { backendNodeId: 4, executionContextId: 2 }],
    ];
    for (const [method, parameters] of refused) {
      const label = `${method} ${JSON.stringify(parameters)}`;
      const error = await send(method, parameters).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error, label).toMatchObject({ code: "forbidden" });
      expect((error as Error).message, label).toContain(method);
    }
    expect(channel.commands).toEqual([]);
  });

  it("refuses parameters the shipped CDP spec does not define for script methods", async () => {
    const { channel, send } = await attachedPage();
    const refused: [string, CdpParameters][] = [
      ["Runtime.evaluate", { expression: "1", generateWebDriverValue: true }],
      ["Runtime.evaluate", { expression: "1", worldName: "opensteer" }],
      ["Runtime.evaluate", JSON.parse('{"expression":"1","__proto__":{"contextId":2}}')],
      ["Runtime.evaluate", { constructor: 1, expression: "1" }],
      [
        "Runtime.callFunctionOn",
        { functionDeclaration: "() => 1", objectId: "-1.1.1", worldName: "x" },
      ],
      ["DOM.resolveNode", { contextId: 2, nodeId: 4 }],
    ];
    for (const [method, parameters] of refused) {
      await expect(
        send(method, parameters),
        `${method} ${JSON.stringify(parameters)}`,
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(channel.commands).toEqual([]);
  });

  it("refuses PDF streams and scripts injected on reload", async () => {
    const { channel, send } = await attachedPage();
    await expect(send("Page.printToPDF", { transferMode: "ReturnAsStream" })).rejects.toMatchObject(
      { code: "forbidden", message: expect.stringContaining("Page.printToPDF") },
    );
    await expect(
      send("Page.reload", { scriptToEvaluateOnLoad: "document.cookie" }),
    ).rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining("Page.reload") });
    expect(channel.commands).toEqual([]);
  });

  it("refuses keys that would paste the browser computer's clipboard", async () => {
    const { channel, send } = await attachedPage();
    for (const parameters of [
      { commands: ["copy"], key: "c", type: "keyDown" },
      { commands: ["cut"], key: "x", type: "keyDown" },
      { key: "c", modifiers: 4, type: "rawKeyDown" },
      { key: "x", modifiers: 2, type: "rawKeyDown" },
      { key: "Insert", modifiers: 2, type: "keyDown" },
      { key: "Delete", modifiers: 8, type: "keyDown" },
      { commands: ["paste"], key: "v", type: "keyDown" },
      { commands: ["pasteAndMatchStyle"], type: "rawKeyDown" },
      { key: "v", modifiers: 4, type: "keyDown" },
      { code: "KeyV", modifiers: 2, type: "rawKeyDown" },
      { modifiers: 2, type: "keyDown", windowsVirtualKeyCode: 86 },
      { key: "Insert", modifiers: 8, type: "keyDown" },
      { key: "Paste", type: "keyDown" },
    ]) {
      await expect(send("Input.dispatchKeyEvent", parameters)).rejects.toMatchObject({
        code: "forbidden",
        message: expect.stringContaining("clipboard"),
      });
    }
    expect(channel.commands).toEqual([]);
    await send("Input.dispatchKeyEvent", { key: "v", text: "v", type: "keyDown" });
    await send("Input.dispatchKeyEvent", { key: "v", modifiers: 4, type: "keyUp" });
    await send("Input.dispatchKeyEvent", { commands: ["selectAll"], key: "a", type: "keyDown" });
    expect(channel.commands.map((command) => command.method)).toEqual([
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
    ]);
  });

  it("forwards only page-level events from attached pages", async () => {
    const { backend, channel, events, send, sessionId } = await attachedPage();
    await send("Runtime.enable");
    events.length = 0;
    const cookieHeaders = {
      headers: { cookie: "session=secret" },
      requestId: "1",
    };
    const emitted: [string, CdpParameters, boolean][] = [
      ["Network.requestWillBeSentExtraInfo", cookieHeaders, false],
      ["Network.responseReceivedExtraInfo", { headers: { "set-cookie": "a=b" } }, false],
      ["Network.requestWillBeSent", { request: { headers: { Cookie: "a=b" } } }, false],
      ["Fetch.requestPaused", { request: { headers: { Cookie: "a=b" } } }, false],
      ["Storage.indexedDBContentUpdated", { origin: "https://other.example" }, false],
      ["DOMStorage.domStorageItemAdded", { key: "token", newValue: "secret" }, false],
      ["Security.visibleSecurityStateChanged", {}, false],
      ["ServiceWorker.workerRegistrationUpdated", { registrations: [] }, false],
      ["Debugger.scriptParsed", { scriptId: "1" }, false],
      ["Target.attachedToTarget", { sessionId: "physical", targetInfo: {} }, false],
      ["Target.receivedMessageFromTarget", { message: "{}" }, false],
      ["Runtime.bindingCalled", { name: "binding", payload: "x" }, false],
      ["Runtime.inspectRequested", { object: { objectId: "-1.1.1" } }, false],
      ["Page.downloadWillBegin", { url: "https://example.test/file" }, false],
      ["Page.compilationCacheProduced", { data: "", url: "https://example.test/" }, false],
      ["Inspector.targetReloadedAfterCrash", {}, false],
      ["Input.dragIntercepted", { data: {} }, false],
      // Chromium's own diagnostics: a CORS failure quotes the response headers.
      [
        "Log.entryAdded",
        {
          entry: {
            category: "cors",
            level: "error",
            source: "javascript",
            text: "The 'Access-Control-Allow-Origin' header has a value 'secret-header-value'",
          },
        },
        false,
      ],
      ["Audits.issueAdded", { issue: { code: "CorsIssue", details: {} } }, false],
      ["Security.securityStateChanged", { securityState: "secure" }, false],
      ["Page.loadEventFired", { timestamp: 1 }, true],
      ["Page.frameNavigated", { frame: { id: "frame" } }, true],
      ["Page.lifecycleEvent", { name: "load" }, true],
      ["Page.javascriptDialogOpening", { message: "ok?", type: "confirm" }, true],
      ["Page.fileChooserOpened", { backendNodeId: 4, mode: "selectSingle" }, true],
      ["Page.windowOpen", { url: "https://example.test/popup" }, true],
      ["Page.screencastFrame", { data: "", sessionId: 1 }, true],
      ["Runtime.consoleAPICalled", { args: [], executionContextId: 1, type: "log" }, true],
      ["Runtime.exceptionThrown", { exceptionDetails: { executionContextId: 1 } }, true],
      ["Runtime.exceptionRevoked", { exceptionId: 1, reason: "handled" }, true],
      ["DOM.documentUpdated", {}, true],
      ["DOM.setChildNodes", { nodes: [], parentId: 1 }, true],
      ["Accessibility.loadComplete", { root: {} }, true],
      ["Log.entryAdded", { entry: { level: "info", source: "other", text: "x" } }, false],
      ["Inspector.detached", { reason: "target_closed" }, true],
      ["Inspector.targetCrashed", {}, true],
    ];
    for (const [method, parameters] of emitted) channel.emit(method, parameters);
    expect(events.map((event) => event.method)).toEqual(
      emitted.filter(([, , forwarded]) => forwarded).map(([method]) => method),
    );
    expect(events.every((event) => event.sessionId === sessionId)).toBe(true);

    backend.emit("Target.targetInfoChanged", { targetInfo: { targetId: "root-a", title: "a" } });
    expect(events.at(-1)).toMatchObject({ method: "Target.targetInfoChanged" });
    expect(events.at(-1)).not.toHaveProperty("sessionId");
  });

  it("refuses a world that existed before the agent attached, before and after Runtime.enable", async () => {
    const { channel, events, send } = await attachedPage([
      frameWorld(1),
      isolatedWorld(2, "existing-private-world"),
      isolatedWorld(3, "Electron Isolated Context"),
    ]);
    const handleIn = (contextId: number) => `-77.${contextId}.1`;
    const attempts = () =>
      [2, 3].flatMap((contextId) => [
        send("Runtime.callFunctionOn", {
          functionDeclaration: "function(){return globalThis.privateSecret}",
          objectId: handleIn(contextId),
          returnByValue: true,
        }),
        send("Runtime.getProperties", { objectId: handleIn(contextId), ownProperties: true }),
      ]);
    for (const attempt of attempts()) {
      await expect(attempt).rejects.toMatchObject({
        code: "forbidden",
        message: expect.stringMatching(/main world/u),
      });
    }
    await send("Runtime.enable");
    for (const attempt of attempts()) {
      await expect(attempt).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(channel.commands).toEqual([]);
    await expect(
      send("Runtime.callFunctionOn", { functionDeclaration: "() => 1", objectId: handleIn(1) }),
    ).resolves.toEqual({ method: "Runtime.callFunctionOn" });
    // The agent's Runtime.enable reports the main world that already existed, and only it.
    expect(events.map((event) => [event.method, event.parameters])).toEqual([
      ["Runtime.executionContextCreated", { context: frameWorld(1) }],
    ]);
  });

  it("refuses handles Chromium would parse leniently and contexts never reported", async () => {
    const { channel, send } = await attachedPage([frameWorld(1), frameWorld(5)]);
    const refused: unknown[] = [
      "1.9.1",
      "01.1.1",
      "1.01.1",
      "1.1.01",
      "+1.1.1",
      "1.+1.1",
      " 1.1.1",
      "1.1.1 ",
      "1.1.1\n",
      "1. 1.1",
      "-0.1.1",
      "1.-1.1",
      "1.1.-1",
      "1.0.1",
      "1.1.0",
      "1.1",
      "1.1.1.1",
      "1..1",
      ".1.1",
      "1.1.",
      "1.2147483648.1",
      "1.1.2147483648",
      "9223372036854775808.1.1",
      "-9223372036854775809.1.1",
      "99999999999999999999.1.1",
      "1.0x1.1",
      "1.1e0.1",
      "1.١.1",
      "",
      7,
      null,
      true,
      ["1.1.1"],
      { objectId: "1.1.1" },
    ];
    for (const objectId of refused) {
      await expect(
        send("Runtime.getProperties", { objectId }),
        JSON.stringify(objectId),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(channel.commands).toEqual([]);
    for (const objectId of [
      "1.1.1",
      "0.5.2147483647",
      "-9223372036854775808.1.1",
      "9223372036854775807.5.1",
    ]) {
      await expect(send("Runtime.getProperties", { objectId }), objectId).resolves.toEqual({
        method: "Runtime.getProperties",
      });
    }
  });

  it("checks every object handle a command names, wherever it is", async () => {
    const { channel, send } = await attachedPage([frameWorld(1), isolatedWorld(2)]);
    const main = "-77.1.1";
    const isolated = "-77.2.1";
    const staged = "/opensteer-files/session-a/photo.png";
    const refused: [string, CdpParameters][] = [
      [
        "Runtime.callFunctionOn",
        {
          arguments: [{ value: 1 }, { objectId: isolated }],
          functionDeclaration: "(a, b) => b",
          objectId: main,
        },
      ],
      [
        "Runtime.callFunctionOn",
        {
          arguments: [{ value: { objectId: isolated } }],
          functionDeclaration: "(a) => a",
          objectId: main,
        },
      ],
      ["Runtime.awaitPromise", { promiseObjectId: isolated }],
      ["Runtime.releaseObject", { objectId: isolated }],
      ["DOM.describeNode", { objectId: isolated }],
      ["DOM.requestNode", { objectId: isolated }],
      ["DOM.getBoxModel", { objectId: isolated }],
      ["DOM.getContentQuads", { objectId: isolated }],
      ["DOM.getOuterHTML", { objectId: isolated }],
      ["DOM.scrollIntoViewIfNeeded", { objectId: isolated }],
      ["DOM.focus", { objectId: isolated }],
      ["DOM.setFileInputFiles", { files: [staged], objectId: isolated }],
      ["Accessibility.getPartialAXTree", { objectId: isolated }],
      ["Accessibility.queryAXTree", { accessibleName: "Submit", objectId: isolated }],
    ];
    for (const [method, parameters] of refused) {
      const error = await send(method, parameters).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error, method).toMatchObject({ code: "forbidden" });
      expect((error as Error).message, method).toContain(method);
    }
    expect(channel.commands).toEqual([]);
    await expect(
      send("Runtime.callFunctionOn", {
        arguments: [{ value: 1 }, { objectId: "-77.1.2" }],
        functionDeclaration: "(a, b) => b",
        objectId: main,
      }),
    ).resolves.toEqual({ method: "Runtime.callFunctionOn" });
    await expect(
      send("DOM.setFileInputFiles", { files: [staged], objectId: main }),
    ).resolves.toEqual({
      method: "DOM.setFileInputFiles",
    });
  });

  it("admits only a frame's default world as a main world", async () => {
    const worlds = [
      frameWorld(1),
      frameWorld(2, { frameId: "child", isDefault: true, type: "default" }),
      frameWorld(3, { frameId: "main", isDefault: true, type: "isolated" }),
      frameWorld(4, { frameId: "main", isDefault: false, type: "default" }),
      frameWorld(5, { isDefault: true, type: "default" }),
      frameWorld(6, { frameId: "", isDefault: true, type: "default" }),
      frameWorld(7, { frameId: "main", isDefault: "true", type: "default" }),
      frameWorld(8, { isDefault: true }),
      { id: 9, name: "", origin: "", uniqueId: "unique-9" },
      frameWorld(10, { frameId: "main", isDefault: false, type: "worker" }),
    ];
    const { channel, events, send } = await attachedPage(worlds);
    await send("Runtime.enable");
    for (const world of worlds) {
      const id = world.id as number;
      const outcome = await send("Runtime.getProperties", { objectId: `5.${id}.1` }).then(
        () => "forwarded",
        (error: unknown) => (error as { code?: string }).code,
      );
      expect(outcome, `context ${id}`).toBe(id <= 2 ? "forwarded" : "forbidden");
    }
    expect(channel.commands).toHaveLength(2);
    expect(
      events.map((event) => (event.parameters.context as { id: number } | undefined)?.id),
    ).toEqual([1, 2]);
  });

  it("forgets destroyed, cleared and replaced contexts", async () => {
    const { channel, events, send } = await attachedPage([frameWorld(1), frameWorld(2)]);
    await send("Runtime.enable");
    events.length = 0;
    const allowed = (contextId: number) =>
      send("Runtime.getProperties", { objectId: `3.${contextId}.1` }).then(
        () => true,
        () => false,
      );
    expect([await allowed(1), await allowed(2)]).toEqual([true, true]);

    channel.emit("Runtime.executionContextDestroyed", {
      executionContextId: 1,
      executionContextUniqueId: "unique-1",
    });
    channel.emit("Runtime.executionContextDestroyed", { executionContextId: 2 });
    expect([await allowed(1), await allowed(2)]).toEqual([false, false]);

    channel.emit("Runtime.executionContextCreated", { context: frameWorld(4) });
    channel.emit("Runtime.executionContextsCleared", {});
    expect(await allowed(4)).toBe(false);

    // A replacement renderer numbers its contexts afresh: the same ID is now another world.
    channel.emit("Runtime.executionContextCreated", { context: frameWorld(5) });
    channel.emit("Runtime.executionContextCreated", {
      context: { ...isolatedWorld(5), uniqueId: "unique-5-isolated" },
    });
    expect(await allowed(5)).toBe(false);

    // A late report about the old renderer's context 6 leaves the new one alone.
    channel.emit("Runtime.executionContextCreated", {
      context: { ...frameWorld(6), uniqueId: "unique-6-new" },
    });
    channel.emit("Runtime.executionContextDestroyed", {
      executionContextId: 6,
      executionContextUniqueId: "unique-6-old",
    });
    expect(await allowed(6)).toBe(true);

    expect(events.map((event) => event.method)).toEqual([
      "Runtime.executionContextDestroyed",
      "Runtime.executionContextDestroyed",
      "Runtime.executionContextCreated",
      "Runtime.executionContextsCleared",
      "Runtime.executionContextCreated",
      "Runtime.executionContextCreated",
    ]);
  });

  it("forwards context-bearing events only from frames' main worlds", async () => {
    const { channel, events, send } = await attachedPage([frameWorld(1), isolatedWorld(2)]);
    await send("Runtime.enable");
    events.length = 0;
    const secret = "FAKE_PRIVATE_WORLD";
    const emitted: [string, CdpParameters, boolean][] = [
      [
        "Runtime.consoleAPICalled",
        {
          args: [{ objectId: "-4.2.3", preview: { properties: [{ name: "s", value: secret }] } }],
          executionContextId: 2,
          type: "log",
        },
        false,
      ],
      [
        "Runtime.consoleAPICalled",
        { args: [{ type: "string", value: secret }], type: "log" },
        false,
      ],
      [
        "Runtime.consoleAPICalled",
        { args: [{ objectId: "-4.2.4", type: "object" }], executionContextId: 1, type: "log" },
        false,
      ],
      [
        "Runtime.exceptionThrown",
        {
          exceptionDetails: {
            exception: { objectId: "-4.2.5" },
            executionContextId: 2,
            text: secret,
          },
        },
        false,
      ],
      ["Runtime.exceptionThrown", { exceptionDetails: { exceptionId: 9, text: secret } }, false],
      [
        "Runtime.exceptionThrown",
        { exceptionDetails: { exception: { objectId: "-4.2.6" }, executionContextId: 1 } },
        false,
      ],
      ["Runtime.executionContextCreated", { context: isolatedWorld(3) }, false],
      [
        "Runtime.executionContextDestroyed",
        { executionContextId: 2, executionContextUniqueId: "unique-2" },
        false,
      ],
      ["Runtime.executionContextDestroyed", { executionContextId: 3 }, false],
      ["Runtime.executionContextCreated", { context: frameWorld(7) }, true],
      [
        "Runtime.consoleAPICalled",
        {
          args: [
            { type: "string", value: "page" },
            { objectId: "-4.1.8", type: "object" },
            { type: "object", value: { objectId: "-4.2.9" } },
          ],
          executionContextId: 1,
          type: "log",
        },
        true,
      ],
      [
        "Runtime.exceptionThrown",
        { exceptionDetails: { exception: { objectId: "-4.7.1" }, executionContextId: 7 } },
        true,
      ],
      ["Runtime.exceptionRevoked", { exceptionId: 9, reason: "handled" }, true],
      [
        "Runtime.executionContextDestroyed",
        { executionContextId: 7, executionContextUniqueId: "unique-7" },
        true,
      ],
      ["Runtime.executionContextsCleared", {}, true],
      ["Runtime.bindingCalled", { executionContextId: 1, name: "b", payload: secret }, false],
      [
        "Runtime.inspectRequested",
        { executionContextId: 1, object: { objectId: "-4.1.1" } },
        false,
      ],
    ];
    for (const [method, parameters] of emitted) channel.emit(method, parameters);
    expect(events.map((event) => [event.method, event.parameters])).toEqual(
      emitted
        .filter(([, , forwarded]) => forwarded)
        .map(([method, parameters]) => [method, parameters]),
    );
  });

  it("keeps Runtime events behind the agent's own subscription without losing contexts", async () => {
    const { channel, events, send } = await attachedPage([frameWorld(1), isolatedWorld(2)]);
    const console = (executionContextId: number) =>
      channel.emit("Runtime.consoleAPICalled", { args: [], executionContextId, type: "log" });
    console(1);
    channel.emit("Runtime.executionContextCreated", { context: frameWorld(3) });
    expect(events).toEqual([]);
    await send("Runtime.enable");
    await send("Runtime.enable");
    console(1);
    expect(
      events.map((event) => [event.method, event.parameters.context ?? event.parameters]),
    ).toEqual([
      ["Runtime.executionContextCreated", frameWorld(1)],
      ["Runtime.executionContextCreated", frameWorld(3)],
      ["Runtime.consoleAPICalled", { args: [], executionContextId: 1, type: "log" }],
    ]);
    await send("Runtime.disable");
    events.length = 0;
    channel.emit("Runtime.executionContextCreated", { context: frameWorld(4) });
    channel.emit("Runtime.executionContextDestroyed", { executionContextId: 3 });
    console(4);
    expect(events).toEqual([]);
    // The router kept tracking while the agent was unsubscribed.
    await expect(send("Runtime.getProperties", { objectId: "1.4.1" })).resolves.toEqual({
      method: "Runtime.getProperties",
    });
    await expect(send("Runtime.getProperties", { objectId: "1.3.1" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await send("Runtime.enable");
    expect(events.map((event) => (event.parameters.context as { id: number }).id)).toEqual([1, 4]);
    expect(channel.commands.map((command) => command.method)).toEqual(["Runtime.getProperties"]);
  });

  it("refuses results that carry a handle from outside a main world, not page data like one", async () => {
    const { channel, send } = await attachedPage([frameWorld(1), isolatedWorld(2)]);
    channel.results.set("Runtime.evaluate", { result: { objectId: "-6.2.1", type: "object" } });
    await expect(send("Runtime.evaluate", { expression: "1" })).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("Runtime.evaluate"),
    });
    channel.results.set("DOM.resolveNode", { object: { objectId: "-6.2.2", type: "object" } });
    await expect(send("DOM.resolveNode", { nodeId: 4 })).rejects.toMatchObject({
      code: "forbidden",
    });
    channel.results.set("Runtime.getProperties", {
      result: [{ name: "x", value: { objectId: "-6.2.3", type: "object" } }],
    });
    await expect(send("Runtime.getProperties", { objectId: "-6.1.1" })).rejects.toMatchObject({
      code: "forbidden",
    });
    channel.results.set("Runtime.awaitPromise", {
      exceptionDetails: { exception: { objectId: "-6.9.1", type: "object" }, exceptionId: 1 },
      result: { type: "undefined" },
    });
    await expect(send("Runtime.awaitPromise", { promiseObjectId: "-6.1.2" })).rejects.toMatchObject(
      {
        code: "forbidden",
      },
    );

    const pageData = {
      result: {
        deepSerializedValue: { objectId: "a8f2-reference", type: "object", value: [] },
        objectId: "-6.1.4",
        type: "object",
        value: { nested: [{ objectId: "-6.2.7" }], objectId: "-6.2.7" },
      },
    };
    channel.results.set("Runtime.evaluate", pageData);
    await expect(send("Runtime.evaluate", { expression: "data" })).resolves.toEqual(pageData);
  });

  it("keeps an agent's object groups its own", async () => {
    const { channel, send, sessionId } = await attachedPage();
    channel.emit("Runtime.executionContextCreated", { context: frameWorld(7) });
    await send("Runtime.evaluate", { expression: "1", objectGroup: "platform-storage" });
    await send("Runtime.releaseObjectGroup", { objectGroup: "platform-storage" });
    const groups = channel.commands
      .filter(
        (command) =>
          command.method === "Runtime.evaluate" || command.method === "Runtime.releaseObjectGroup",
      )
      .map((command) => command.parameters?.objectGroup);
    expect(groups).toEqual([
      `opensteer-agent:${sessionId}:platform-storage`,
      `opensteer-agent:${sessionId}:platform-storage`,
    ]);
  });

  it("keeps each page session's inventory and Runtime subscription its own", async () => {
    const { backend, channel, events, router, send } = await attachedPage();
    const { sessionId: second } = (await router.send("session-a", {
      method: "Target.attachToTarget",
      parameters: { targetId: "root-a" },
    })) as { sessionId: string };
    const secondChannel = backend.channels.get("root-a");
    expect(secondChannel).not.toBe(channel);
    channel.emit("Runtime.executionContextCreated", { context: frameWorld(7) });
    await send("Runtime.enable");
    secondChannel?.emit("Runtime.consoleAPICalled", {
      args: [],
      executionContextId: 1,
      type: "log",
    });
    expect(events.every((event) => event.sessionId !== second)).toBe(true);
    await expect(send("Runtime.getProperties", { objectId: "1.7.1" })).resolves.toBeDefined();
    await expect(
      router.send("session-a", {
        method: "Runtime.getProperties",
        parameters: { objectId: "1.7.1" },
        sessionId: second,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("keeps a page session's commands from the page until the router's own Runtime.enable reported its contexts", async () => {
    const backend = new FakeBackend();
    const gate = Promise.withResolvers<void>();
    backend.prepareChannel = (channel) => {
      channel.enableGate = gate.promise;
    };
    const router = new SessionCdpRouter(backend);
    router.registerSession("session-a", "root-a", async () => true, "/opensteer-files/session-a");
    const attach = async () =>
      (
        (await router.send("session-a", {
          method: "Target.attachToTarget",
          parameters: { targetId: "root-a" },
        })) as { sessionId: string }
      ).sessionId;
    const read = (sessionId: string) =>
      router.send("session-a", {
        method: "Runtime.getProperties",
        parameters: { objectId: "1.1.1" },
        sessionId,
      });
    // The session is the agent's once its channel opens, as an attach is in Chromium.
    const sessionId = await attach();
    let settled = false;
    const reading = read(sessionId).finally(() => {
      settled = true;
    });
    // A page under a dialog reports no context until the dialog is answered.
    await expect(
      router.send("session-a", {
        method: "Page.handleJavaScriptDialog",
        parameters: { accept: true },
        sessionId,
      }),
    ).resolves.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(backend.channels.get("root-a")?.commands.map((command) => command.method)).toEqual([
      "Runtime.enable",
      "Page.handleJavaScriptDialog",
    ]);
    gate.resolve();
    await expect(reading).resolves.toBeDefined();

    // A failed subscription leaves no session, and its channel is closed.
    backend.prepareChannel = (channel) => {
      channel.enableGate = Promise.reject(new Error("target crashed"));
    };
    const failed = await attach();
    await expect(read(failed)).rejects.toMatchObject({ code: "not_found" });
    expect(backend.channels.get("root-a")?.closed).toBe(true);

    // A target released while the router subscribed leaves no session.
    const late = Promise.withResolvers<void>();
    backend.prepareChannel = (channel) => {
      channel.enableGate = late.promise;
    };
    const released = await attach();
    const pending = read(released);
    backend.emit("Target.targetDestroyed", { targetId: "root-a" });
    late.resolve();
    await expect(pending).rejects.toMatchObject({ code: "not_found" });
    expect(backend.channels.get("root-a")?.closed).toBe(true);
  });

  it("forwards only the events reviewed by name, in every domain", async () => {
    const { channel, events, send } = await attachedPage();
    await send("Runtime.enable");
    events.length = 0;
    const emitted: [string, CdpParameters, boolean][] = [
      ["DOM.attributeModified", { name: "class", nodeId: 4, value: "on" }, true],
      ["DOM.attributeRemoved", { name: "class", nodeId: 4 }, true],
      ["DOM.characterDataModified", { characterData: "x", nodeId: 5 }, true],
      ["DOM.childNodeCountUpdated", { childNodeCount: 2, nodeId: 4 }, true],
      ["DOM.childNodeInserted", { node: {}, parentNodeId: 4, previousNodeId: 0 }, true],
      ["DOM.childNodeRemoved", { nodeId: 6, parentNodeId: 4 }, true],
      ["DOM.documentUpdated", {}, true],
      ["DOM.inlineStyleInvalidated", { nodeIds: [4] }, true],
      ["DOM.pseudoElementAdded", { parentId: 4, pseudoElement: {} }, true],
      ["DOM.pseudoElementRemoved", { parentId: 4, pseudoElementId: 7 }, true],
      ["DOM.scrollableFlagUpdated", { isScrollable: true, nodeId: 4 }, true],
      ["DOM.setChildNodes", { nodes: [], parentId: 1 }, true],
      ["DOM.shadowRootPopped", { hostId: 4, rootId: 8 }, true],
      ["DOM.shadowRootPushed", { hostId: 4, root: {} }, true],
      ["DOM.topLayerElementsUpdated", {}, true],
      ["Accessibility.loadComplete", { root: {} }, true],
      ["Accessibility.nodesUpdated", { nodes: [] }, true],
      ["Inspector.detached", { reason: "target_closed" }, true],
      ["DOM.adoptedStyleSheetsModified", { adoptedStyleSheets: ["sheet"], nodeId: 4 }, false],
      ["DOM.adRelatedStateUpdated", { adProvenance: { filterlistRule: "x" }, nodeId: 4 }, false],
      [
        "DOM.affectedByStartingStylesFlagUpdated",
        { affectedByStartingStyles: true, nodeId: 4 },
        false,
      ],
      ["DOM.distributedNodesUpdated", { distributedNodes: [], insertionPointId: 4 }, false],
      ["DOM.futureEvent", { secret: "unreviewed" }, false],
      ["Accessibility.futureEvent", { secret: "unreviewed" }, false],
      ["Page.futureEvent", { secret: "unreviewed" }, false],
      ["Runtime.futureEvent", { executionContextId: 1 }, false],
      ["Page.interstitialShown", {}, false],
      ["Page.backForwardCacheNotUsed", { notRestoredExplanations: [] }, false],
      ["Page.downloadProgress", { guid: "g", receivedBytes: 1, state: "x", totalBytes: 1 }, false],
      ["Inspector.workerScriptLoaded", {}, false],
      ["Emulation.virtualTimeBudgetExpired", {}, false],
      ["Emulation.screenOrientationLockChanged", { locked: true }, false],
    ];
    for (const [method, parameters] of emitted) channel.emit(method, parameters);
    expect(events.map((event) => event.method)).toEqual(
      emitted.filter(([, , forwarded]) => forwarded).map(([method]) => method),
    );
    for (const method of agentCdpAllowlist.events) {
      expect(method, method).toMatch(/^(Page|Runtime|DOM|Accessibility|Inspector)\.[a-z]/u);
    }
  });

  it("refuses parameters, nested fields and enum values the reviewed spec leaves out", async () => {
    const { channel, send } = await attachedPage();
    const url = "https://example.test/";
    const metrics = { deviceScaleFactor: 1, height: 600, mobile: false, width: 800 };
    const refused: [string, CdpParameters][] = [
      ["Page.navigate", { referrer: "https://trusted.example/", url }],
      ["Page.navigate", { referrerPolicy: "unsafeUrl", url }],
      ["Page.navigate", { transitionType: "teleport", url }],
      ["Page.enable", { futureFlag: true }],
      ["Page.getFrameTree", { frameId: "main" }],
      ["Page.bringToFront", { force: true }],
      ["Emulation.setDeviceMetricsOverride", { ...metrics, scale: 8 }],
      [
        "Emulation.setDeviceMetricsOverride",
        { ...metrics, viewport: { height: 600, scale: 8, width: 800, x: 0, y: 0 } },
      ],
      ["Emulation.setDeviceMetricsOverride", { ...metrics, devicePosture: { type: "folded" } }],
      [
        "Emulation.setDeviceMetricsOverride",
        { ...metrics, screenOrientation: { angle: 0, type: "tilted" } },
      ],
      ["Page.captureScreenshot", { format: "bmp" }],
      [
        "Page.captureScreenshot",
        { clip: { future: 1, height: 1, scale: 1, width: 1, x: 0, y: 0 } },
      ],
      [
        "Input.dispatchDragEvent",
        {
          data: {
            dragOperationsMask: 1,
            items: [{ data: "x", future: "y", mimeType: "text/plain" }],
          },
          type: "drop",
          x: 1,
          y: 1,
        },
      ],
      [
        "Input.dispatchDragEvent",
        { data: { dragOperationsMask: 1, filesystemId: "x", items: [] }, type: "drop", x: 1, y: 1 },
      ],
      ["Input.dispatchMouseEvent", { button: "sixth", type: "mouseMoved", x: 1, y: 1 }],
      ["Input.dispatchMouseEvent", { type: "mouseTeleported", x: 1, y: 1 }],
      [
        "Runtime.evaluate",
        { expression: "1", serializationOptions: { future: 1, serialization: "deep" } },
      ],
      [
        "Runtime.evaluate",
        { expression: "1", serializationOptions: { serialization: "everything" } },
      ],
      [
        "Runtime.callFunctionOn",
        {
          arguments: [{ future: 2, value: 1 }],
          functionDeclaration: "(a) => a",
          objectId: "-1.1.1",
        },
      ],
      [
        "Emulation.setEmulatedMedia",
        { features: [{ name: "prefers-color-scheme", origin: "x", value: "dark" }] },
      ],
      ["DOM.getDocument", { toString: 1 }],
      ["DOM.getDocument", { hasOwnProperty: true }],
      ["DOM.getDocument", { valueOf: 1 }],
      ["DOM.getDocument", JSON.parse('{"__proto__":{"pierce":true}}')],
      ["DOM.getDocument", { constructor: { name: "x" } }],
    ];
    for (const [method, parameters] of refused) {
      const label = `${method} ${JSON.stringify(parameters)}`;
      const error = await send(method, parameters).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error, label).toMatchObject({ code: "forbidden" });
      expect((error as Error).message, label).toContain(method);
    }
    expect(channel.commands).toEqual([]);
  });

  it("refuses missing and mistyped values before they reach the page", async () => {
    const { channel, send } = await attachedPage();
    const refused: [string, CdpParameters][] = [
      ["Page.navigate", {}],
      ["Page.navigate", { url: 7 }],
      ["Page.setLifecycleEventsEnabled", { enabled: "true" }],
      ["Page.screencastFrameAck", {}],
      ["Page.captureScreenshot", { quality: 50.5 }],
      ["Input.dispatchMouseEvent", { type: "mousePressed", x: "1", y: 1 }],
      ["Input.dispatchMouseEvent", { type: "mousePressed", x: 1 }],
      ["Input.dispatchTouchEvent", { touchPoints: { x: 1, y: 1 }, type: "touchStart" }],
      ["Input.dispatchTouchEvent", { touchPoints: [{ x: 1 }], type: "touchStart" }],
      ["Input.dispatchDragEvent", { type: "drop", x: 1, y: 1 }],
      ["DOM.querySelector", { nodeId: 1.5, selector: "a" }],
      ["DOM.querySelector", { nodeId: 1 }],
      ["DOM.setFileInputFiles", { files: "/opensteer-files/session-a/a.png", nodeId: 4 }],
      ["Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 1, height: 600, width: 800 }],
      [
        "Runtime.evaluate",
        {
          expression: "1",
          serializationOptions: { additionalParameters: [], serialization: "deep" },
        },
      ],
      ["Runtime.evaluate", { expression: ["1"] }],
      ["DOMSnapshot.captureSnapshot", {}],
    ];
    for (const [method, parameters] of refused) {
      const label = `${method} ${JSON.stringify(parameters)}`;
      const error = await send(method, parameters).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error, label).toMatchObject({ code: "forbidden" });
      expect((error as Error).message, label).toContain(method);
    }
    expect(channel.commands).toEqual([]);
  });

  it("gives every allowed method an exact schema", async () => {
    const { channel, send } = await attachedPage();
    // The smallest parameters each schema accepts, so the extra name is the only fault.
    const smallest = (value: AgentCdpValue): unknown => {
      switch (value.kind) {
        case "array":
          return [];
        case "boolean":
          return false;
        case "enum":
          return value.values[0];
        case "object":
          return required(value.fields);
        case "record":
          return {};
        case "string":
          return "x";
        default:
          return 1;
      }
    };
    const required = (fields: AgentCdpFields): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(fields)
          .filter(([, field]) => !field.optional)
          .map(([name, field]) => [name, smallest(field)]),
      );
    for (const [method, fields] of agentCdpAllowlist.methods) {
      for (const parameters of [
        { ...required(fields), unreviewedParameter: true },
        ...Object.entries(fields)
          .filter(([, field]) => field.kind === "object")
          .map(([name, field]) => ({
            ...required(fields),
            [name]: { ...(smallest(field) as object), unreviewedField: true },
          })),
      ]) {
        const label = `${method} ${JSON.stringify(parameters)}`;
        await expect(send(method, parameters), label).rejects.toMatchObject({
          code: "forbidden",
          message: expect.stringMatching(/does not accept (\w+\.)?unreviewed(Parameter|Field)/u),
        });
      }
    }
    expect(channel.commands).toEqual([]);
  });

  it("infers the same Meta editing commands as the standalone harness's Playwright table", () => {
    const [core, harness] = [
      new URL("./session-cdp-router.ts", import.meta.url),
      new URL("../../../apps/runner/browser-harness/keyboard-layout.mjs", import.meta.url),
    ].map((url) => {
      const source = readFileSync(url, "utf8");
      const literal = /const macEditingCommands[^=]*=\s*(\{[\s\S]*?\n\})/u.exec(source)?.[1];
      expect(literal).toBeDefined();
      return runInNewContext(`(${literal})`) as Record<string, string | string[]>;
    });
    const metaChords = Object.entries(harness!).flatMap(([shortcut, command]) => {
      const chord = /^(Shift\+)?Meta\+(\w+)$/u.exec(shortcut);
      return chord ? [[`${chord[1] ? 12 : 4}:${chord[2]}`, command] as const] : [];
    });
    // The harness sends Playwright's commands without Cocoa colons.
    expect(
      Object.fromEntries(
        metaChords
          .filter(([chord]) => Object.hasOwn(core!, chord))
          .map(([chord, command]) => [chord, String(command).replace(/:$/u, "")]),
      ),
    ).toEqual(core);
    // The router infers every Meta chord except the numpad cancel ones.
    expect(
      metaChords.filter(([chord]) => !Object.hasOwn(core!, chord)).map(([chord]) => chord),
    ).toEqual(["4:NumpadSubtract", "12:NumpadSubtract"]);
  });

  it("preserves Meta editing behavior on the virtual clipboard without native browser dispatch", async () => {
    const { channel, send } = await attachedPage(undefined, false);
    for (const type of ["keyDown", "rawKeyDown"]) {
      for (const [fields, command] of [
        [{ key: "a", code: "KeyA", modifiers: 4 }, "selectAll"],
        [
          { key: "c", text: "c", nativeVirtualKeyCode: 8, windowsVirtualKeyCode: 67, modifiers: 4 },
          "copy",
        ],
        [{ code: "KeyX", modifiers: 4 }, "cut"],
        [{ code: "KeyZ", modifiers: 4 }, "undo"],
        [{ code: "KeyZ", modifiers: 12 }, "redo"],
        [{ code: "ArrowLeft", modifiers: 4 }, "moveToLeftEndOfLine"],
        [{ code: "ArrowRight", modifiers: 12 }, "moveToRightEndOfLineAndModifySelection"],
        [{ code: "Backspace", modifiers: 4 }, "deleteToBeginningOfLine"],
      ] satisfies [CdpParameters, string][]) {
        await send("Input.dispatchKeyEvent", { ...fields, type });
        expect(channel.commands.at(-1)?.parameters).toMatchObject({ type, commands: [command] });
        expect(channel.commands.at(-1)?.parameters).not.toHaveProperty("nativeVirtualKeyCode");
      }
    }
    for (const commands of [[], ["deleteBackward"], ["copy"]]) {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "c", modifiers: 4, commands });
      expect(channel.commands.at(-1)?.parameters?.commands).toEqual(commands);
    }
    for (const type of ["keyUp", "char"]) {
      await send("Input.dispatchKeyEvent", { type, key: "c", modifiers: 4 });
      expect(channel.commands.at(-1)?.parameters).not.toHaveProperty("commands");
    }
  });

  it("runs the existing clipboard refusal on inferred Meta paste commands", async () => {
    const { channel, send } = await attachedPage();
    await expect(
      send("Input.dispatchKeyEvent", {
        type: "keyDown",
        code: "v",
        modifiers: 4,
        nativeVirtualKeyCode: 9,
      }),
    ).rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining("clipboard") });
    expect(channel.commands).toEqual([]);
  });

  it("keeps legacy native key codes out of every agent key event", async () => {
    const { channel, send } = await attachedPage();
    for (const type of ["keyDown", "rawKeyDown", "keyUp", "char"]) {
      for (const key of [
        { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0 },
        { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37, modifiers: 8 },
        { key: "l", code: "KeyL", windowsVirtualKeyCode: 76, modifiers: 4 },
        { key: "x", code: "KeyX", windowsVirtualKeyCode: 88, modifiers: 0 },
      ]) {
        const parameters = { ...key, type, ...(type === "char" ? { text: key.key } : {}) };
        const legacy = { ...parameters, nativeVirtualKeyCode: 13 };
        await expect(send("Input.dispatchKeyEvent", legacy)).resolves.toEqual({
          method: "Input.dispatchKeyEvent",
        });
        expect(legacy.nativeVirtualKeyCode).toBe(13);
        expect(channel.commands.at(-1)).toEqual({ method: "Input.dispatchKeyEvent", parameters });
      }
    }
  });

  it("forwards every command the shipped Browser Harness sends, as it sends them", async () => {
    const { channel, send } = await attachedPage();
    const staged = "/opensteer-files/session-a/upload.png";
    const key = {
      code: "a",
      key: "a",
      modifiers: 0,
      windowsVirtualKeyCode: 97,
    };
    // apps/runner/browser-harness/browser-harness.mjs
    const harness: [string, CdpParameters?][] = [
      ["Page.navigate", { url: "https://example.test/" }],
      [
        "Runtime.evaluate",
        { awaitPromise: true, expression: "document.title", returnByValue: true },
      ],
      [
        "Input.dispatchMouseEvent",
        { button: "left", clickCount: 1, type: "mousePressed", x: 10.5, y: 20 },
      ],
      [
        "Input.dispatchMouseEvent",
        { button: "left", clickCount: 1, type: "mouseReleased", x: 10.5, y: 20 },
      ],
      ["Input.insertText", { text: "hello" }],
      ["Input.dispatchKeyEvent", { ...key, type: "keyDown" }],
      ["Input.dispatchKeyEvent", { ...key, text: "a", type: "char" }],
      ["Input.dispatchKeyEvent", { ...key, type: "keyUp" }],
      ["Input.dispatchMouseEvent", { deltaX: 0, deltaY: -300, type: "mouseWheel", x: 1, y: 1 }],
      ["Page.captureScreenshot", { captureBeyondViewport: false, format: "png" }],
      [
        "Runtime.callFunctionOn",
        {
          functionDeclaration: "function(){return this.files}",
          objectId: "-1.1.1",
          returnByValue: true,
        },
      ],
      ["Runtime.evaluate", { expression: "document.querySelector('input')" }],
      ["DOM.setFileInputFiles", { files: [staged], objectId: "-1.1.1" }],
      ["Page.enable"],
      ["Page.setInterceptFileChooserDialog", { enabled: true }],
      ["DOM.setFileInputFiles", { backendNodeId: 9, files: [staged] }],
      ["DOM.resolveNode", { backendNodeId: 9 }],
      ["Page.setInterceptFileChooserDialog", { enabled: false }],
    ];
    for (const [method, parameters] of harness) {
      await expect(send(method, parameters), method).resolves.toEqual({ method });
    }
    expect(channel.commands.map((command) => command.method)).toEqual(
      harness.map(([method]) => method),
    );
  });
});
