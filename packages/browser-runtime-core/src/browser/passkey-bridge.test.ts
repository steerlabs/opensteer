import { readFileSync } from "node:fs";
import { z } from "zod";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ExecutionContextInventory } from "@opensteer/browser-core";
import type { CdpSession } from "./backend.js";
import { PasskeyBridge } from "./passkey-bridge.js";
import type { PasskeyAuthenticatorInput, PasskeyAuthenticatorOutcome } from "../passkeys/index.js";

const prerenderActivation = z
  .object({
    capture: z.object({
      chromium: z.string(),
      verified: z.object({
        prerenderedAtStart: z.literal(true),
        prerenderingAfterActivation: z.literal(false),
      }),
    }),
    initial: z.object({
      frame: z.object({
        id: z.string(),
        loaderId: z.string(),
        url: z.string(),
        securityOrigin: z.string(),
      }),
    }),
    events: z.array(
      z.object({
        session: z.enum(["source", "prerender", "tab"]),
        method: z.string(),
        parameters: z.record(z.string(), z.unknown()),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL("./fixtures/passkey-prerender-activation.json", import.meta.url),
        "utf8",
      ),
    ),
  );

const options = { challenge: "AQID", rpId: "example.test" };
function fixture(
  initial: {
    committed?: boolean;
    tls?: "secure" | "insecure" | "unknown";
    lateBootstrap?: boolean;
  } = {},
) {
  const events = new EventEmitter();
  const contexts = new ExecutionContextInventory();
  const context = (
    id = 1,
    frameId = "top",
    origin = "https://example.test",
    mainWorld = true,
    uniqueId = `unique-${id}`,
  ) => {
    const event = {
      context: {
        id,
        uniqueId,
        origin,
        auxData: { frameId, isDefault: mainWorld, type: mainWorld ? "default" : "isolated" },
      },
    };
    contexts.observe("Runtime.executionContextCreated", event);
    events.emit("Runtime.executionContextCreated", event);
  };
  let tree: unknown = {
    frame: {
      id: "top",
      loaderId: "loader-top",
      url: "https://example.test/",
      securityOrigin: "https://example.test",
    },
  };
  let committedUrl = "https://example.test/";
  let policies: unknown = {
    states: [
      { feature: "publickey-credentials-get", allowed: true },
      { feature: "publickey-credentials-create", allowed: true },
    ],
  };
  const replies: { uniqueContextId: string; expression: string }[] = [];
  const send = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "Page.getFrameTree") return { frameTree: tree };
    if (method === "Page.getPermissionsPolicyState") return policies;
    if (method === "Page.getNavigationHistory")
      return { currentIndex: 0, entries: [{ id: 1, url: committedUrl }] };
    if (method === "Runtime.evaluate") replies.push(params as (typeof replies)[number]);
    return {};
  });
  const cdp = {
    send,
    on: events.on.bind(events),
    off: events.off.bind(events),
  } as unknown as CdpSession;
  const ceremony = vi
    .fn<(input: PasskeyAuthenticatorInput) => Promise<PasskeyAuthenticatorOutcome>>()
    .mockResolvedValue({ kind: "refused", error: "InvalidStateError" });
  const bridge = new PasskeyBridge(
    cdp,
    { ceremony },
    { contexts, lateBootstrap: initial.lateBootstrap },
  );
  const commit = (
    frameId = "top",
    loaderId = `loader-${frameId}`,
    url = "https://example.test/",
  ) => {
    events.emit("Page.frameNavigated", {
      frame: {
        id: frameId,
        loaderId,
        url,
        securityOrigin: new URL(url).origin,
        ...(frameId === "top" ? {} : { parentId: "top" }),
      },
    });
  };
  const tls = (state = "secure", frameId = "top", loaderId = `loader-${frameId}`) =>
    events.emit("Network.responseReceived", {
      type: "Document",
      frameId,
      loaderId,
      response: {
        url: "https://example.test/",
        securityState: state,
        securityDetails: { protocol: "TLS 1.3" },
      },
    });
  if (initial.committed !== false) commit();
  const security = (state = "secure") =>
    events.emit("Security.visibleSecurityStateChanged", {
      visibleSecurityState: {
        securityState: state,
        certificateSecurityState: {
          protocol: "TLS 1.3",
          certificate: ["synthetic-certificate"],
          ...(state === "secure"
            ? {}
            : { certificateNetworkError: "net::ERR_CERT_AUTHORITY_INVALID" }),
        },
      },
    });
  if (initial.tls !== "unknown") {
    tls(initial.tls ?? "secure");
    security(initial.tls ?? "secure");
  }
  context();
  const call = (id = "request", contextId = 1, publicKey: unknown = options, op = "get") =>
    events.emit("Runtime.bindingCalled", {
      name: bridge.bindingName,
      executionContextId: contextId,
      payload: JSON.stringify({ op, id, reply: "reply-slot", options: publicKey }),
    });
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return {
    commit,
    tls,
    security,
    history: (url: string) => {
      committedUrl = url;
    },
    bridge,
    call,
    ceremony,
    context,
    contexts,
    events,
    replies,
    send,
    flush,
    tree: (value: unknown) => {
      tree = value;
    },
    policy: (value: unknown) => {
      policies = value;
    },
  };
}

// A page's bridge sees its own session, not the prerender or parent tab's events.
function replayPrerenderSource(f: ReturnType<typeof fixture>): void {
  for (const event of prerenderActivation.events) {
    if (event.session !== "source") continue;
    f.contexts.observe(event.method, event.parameters);
    f.events.emit(event.method, event.parameters);
  }
}

describe("PasskeyBridge", () => {
  it("uses the browser context's identity and the authenticator's error name", async () => {
    const f = fixture();
    await f.bridge.start();
    f.call();
    await f.flush();
    expect(f.ceremony).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "https://example.test", rpId: "example.test", op: "get" }),
    );
    expect(f.replies[0]).toMatchObject({ uniqueContextId: "unique-1" });
    expect(f.replies[0]?.expression).toContain("InvalidStateError");
    f.bridge.close();
  });
  it.each([
    "isolated",
    "insecure",
    "opaque",
    "popup",
    "written-popup",
    "cross-origin",
    "ancestor",
    "unknown-policy",
    "denied-policy",
    "stale-context",
  ])("refuses %s before calling the authenticator", async (reason) => {
    const f = fixture({ committed: reason !== "written-popup" && reason !== "popup" });
    if (reason === "isolated") f.context(1, "top", "https://example.test", false);
    if (reason === "insecure") f.context(1, "top", "http://example.test");
    if (reason === "opaque") f.context(1, "top", "null");
    if (reason === "popup")
      f.tree({ frame: { id: "top", url: "about:blank", securityOrigin: "https://example.test" } });
    if (reason === "written-popup") f.history("about:blank#initial");
    if (reason === "cross-origin") {
      f.context(1, "child");
      f.tree({
        frame: { id: "top", url: "https://other.test/", securityOrigin: "https://other.test" },
        childFrames: [
          {
            frame: {
              id: "child",
              url: "https://example.test/",
              securityOrigin: "https://example.test",
            },
          },
        ],
      });
    }
    if (reason === "ancestor") {
      f.context(1, "child");
      f.tree({
        frame: { id: "top", url: "https://example.test/", securityOrigin: "https://example.test" },
        childFrames: [
          {
            frame: {
              id: "middle",
              url: "https://other.test/",
              securityOrigin: "https://other.test",
            },
            childFrames: [
              {
                frame: {
                  id: "child",
                  url: "https://example.test/",
                  securityOrigin: "https://example.test",
                },
              },
            ],
          },
        ],
      });
    }
    if (reason === "unknown-policy") f.policy({ states: [] });
    if (reason === "denied-policy")
      f.policy({ states: [{ feature: "publickey-credentials-get", allowed: false }] });
    if (reason === "stale-context") f.contexts.clear();
    await f.bridge.start();
    f.call();
    await f.flush();
    expect(f.ceremony).not.toHaveBeenCalled();
    if (reason !== "stale-context") expect(f.replies[0]?.expression).toContain("NotAllowedError");
    f.bridge.close();
  });
  it("accepts a same-origin frame and checks the operation's policy", async () => {
    const f = fixture();
    f.commit("child");
    f.tls("secure", "child");
    f.context(2, "child");
    f.tree({
      frame: { id: "top", url: "https://example.test/", securityOrigin: "https://example.test" },
      childFrames: [
        { frame: { id: "child", url: "about:srcdoc", securityOrigin: "https://example.test" } },
      ],
    });
    await f.bridge.start();
    f.call("request", 2);
    await f.flush();
    expect(f.ceremony).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledWith("Page.getPermissionsPolicyState", { frameId: "child" });
    f.bridge.close();
  });
  it.each([
    [{ ...options, rpId: "other.test" }, "SecurityError"],
    [{ challenge: "!" }, "TypeError"],
  ])("rejects invalid options with %s", async (input, error) => {
    const f = fixture();
    await f.bridge.start();
    f.call("request", 1, input);
    await f.flush();
    expect(f.ceremony).not.toHaveBeenCalled();
    expect(f.replies[0]?.expression).toContain(error);
    f.bridge.close();
  });
  it.each(["cancel", "navigation", "close", "detach", "timeout"])(
    "aborts on %s, even when the authenticator ignores its signal",
    async (reason) => {
      vi.useFakeTimers();
      const f = fixture();
      f.ceremony.mockImplementation(() => new Promise(() => undefined));
      try {
        await f.bridge.start();
        f.call();
        await f.flush();
        const signal = f.ceremony.mock.calls[0]![0].signal;
        f.call("second");
        await f.flush();
        expect(f.replies[0]?.expression).toContain("A request is already pending.");
        if (reason === "cancel")
          f.events.emit("Runtime.bindingCalled", {
            name: f.bridge.bindingName,
            executionContextId: 1,
            payload: JSON.stringify({ op: "cancel", id: "request" }),
          });
        if (reason === "navigation") {
          f.contexts.clear();
          f.events.emit("Runtime.executionContextDestroyed", {
            executionContextId: 1,
            executionContextUniqueId: "unique-1",
          });
          f.context(1, "top", "https://example.test", true, "replacement");
        }
        if (reason === "close") f.bridge.close();
        if (reason === "detach") f.events.emit("Inspector.detached", {});
        if (reason === "timeout") await vi.advanceTimersByTimeAsync(300_000);
        await f.flush();
        expect(signal.aborted).toBe(true);
        expect(f.replies.every((r) => r.uniqueContextId === "unique-1")).toBe(true);
      } finally {
        f.bridge.close();
        vi.useRealTimers();
      }
    },
  );
  it.each([
    [1, 30_000],
    [999_999, 600_000],
    [undefined, 300_000],
  ])("clamps timeout %s to %s", async (timeout, expected) => {
    vi.useFakeTimers();
    const f = fixture();
    f.ceremony.mockImplementation(() => new Promise(() => undefined));
    try {
      await f.bridge.start();
      f.call("request", 1, { ...options, timeout });
      await f.flush();
      const signal = f.ceremony.mock.calls[0]![0].signal;
      await vi.advanceTimersByTimeAsync(expected - 1);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal.aborted).toBe(true);
    } finally {
      f.bridge.close();
      vi.useRealTimers();
    }
  });
  it("never copies an authenticator exception's message to the page", async () => {
    const f = fixture();
    f.ceremony.mockRejectedValue(new Error("synthetic-sensitive-value"));
    await f.bridge.start();
    f.call();
    await f.flush();
    expect(f.replies[0]?.expression).toContain("UnknownError");
    expect(f.replies[0]?.expression).not.toContain("synthetic-sensitive-value");
    f.bridge.close();
  });
});

it("preserves the authenticator's signed client data and pins the reply callback", async () => {
  const f = fixture();
  f.ceremony.mockResolvedValue({
    kind: "asserted",
    credentialId: new Uint8Array([1]),
    clientDataJSON: new Uint8Array([9, 8]),
    authenticatorData: new Uint8Array([2]),
    signature: new Uint8Array([3]),
    userHandle: null,
    authenticatorAttachment: "platform",
  });
  await f.bridge.start();
  f.call();
  await f.flush();
  const expression = f.replies[0]!.expression;
  expect(expression).toMatch(/^this\["opensteerReply_[a-f0-9]{64}"\]/u);
  expect(expression).not.toContain("reply-slot");
  expect(expression).toContain('"clientDataJSON":"CQg"');
  f.bridge.close();
});
it("treats unreadable policy as a refusal and keeps exception details private", async () => {
  const f = fixture();
  const send = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (method, parameters) => {
    if (method === "Page.getPermissionsPolicyState") throw new Error("synthetic-sensitive-value");
    return send(method, parameters);
  });
  await f.bridge.start();
  f.call();
  await f.flush();
  expect(f.replies[0]?.expression).toContain("NotAllowedError");
  expect(f.replies[0]?.expression).not.toContain("synthetic-sensitive-value");
  f.bridge.close();
});
it("does not let another context cancel a ceremony", async () => {
  const f = fixture();
  f.context(2);
  f.ceremony.mockImplementation(() => new Promise(() => undefined));
  await f.bridge.start();
  f.call();
  await f.flush();
  f.events.emit("Runtime.bindingCalled", {
    name: f.bridge.bindingName,
    executionContextId: 2,
    payload: JSON.stringify({ op: "cancel", id: "request" }),
  });
  expect(f.ceremony.mock.calls[0]![0].signal.aborted).toBe(false);
  f.bridge.close();
});

it.each(["insecure", "unknown"] as const)(
  "refuses a raw binding call when document TLS is %s",
  async (tls) => {
    const f = fixture({ tls });
    await f.bridge.start();
    f.call();
    await f.flush();
    expect(f.ceremony).not.toHaveBeenCalled();
    expect(f.replies[0]?.expression).toContain("NotAllowedError");
    f.bridge.close();
  },
);
it("never authorizes a rewritten initial popup from its current URL or history", async () => {
  const f = fixture({ committed: false });
  f.history("https://example.test/rewritten");
  f.events.emit("Page.navigatedWithinDocument", {
    frameId: "top",
    url: "https://example.test/rewritten",
    navigationType: "historyApi",
  });
  await f.bridge.start();
  f.call();
  await f.flush();
  expect(f.ceremony).not.toHaveBeenCalled();
  expect(f.replies[0]?.expression).toContain("NotAllowedError");
  f.bridge.close();
});
it("refuses a retained context until the committed document has pinned TLS", async () => {
  const f = fixture({ committed: false, tls: "unknown" });
  await f.bridge.start();
  f.commit();
  f.call();
  await f.flush();
  expect(f.ceremony).not.toHaveBeenCalled();
  expect(f.replies[0]?.expression).toContain("NotAllowedError");
  f.bridge.close();
});

it("does not carry a previous document's TLS status across a new commit", async () => {
  const f = fixture();
  await f.bridge.start();
  f.commit("top", "replacement-loader");
  f.context(1, "top", "https://example.test", true, "replacement-context");
  f.call();
  await f.flush();
  expect(f.ceremony).not.toHaveBeenCalled();
  expect(f.replies[0]?.expression).toContain("NotAllowedError");
  f.bridge.close();
});
it("retains a document response reported before Chromium clears the old contexts", async () => {
  const f = fixture();
  await f.bridge.start();
  f.tls("secure", "top", "replacement-loader");
  f.contexts.clear();
  f.events.emit("Runtime.executionContextsCleared", {});
  f.commit("top", "replacement-loader");
  f.security();
  f.context(1, "top", "https://example.test", true, "replacement-context");
  f.call();
  await f.flush();
  expect(f.ceremony).toHaveBeenCalledOnce();
  f.bridge.close();
});
it("cancels and discards a late authenticator outcome after TLS becomes unacceptable", async () => {
  const f = fixture();
  let resolve: (value: PasskeyAuthenticatorOutcome) => void = () => undefined;
  f.ceremony.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await f.bridge.start();
  f.call();
  await f.flush();
  const signal = f.ceremony.mock.calls[0]![0].signal;
  f.security("insecure-broken");
  expect(signal.aborted).toBe(true);
  resolve({
    kind: "asserted",
    credentialId: new Uint8Array([1]),
    clientDataJSON: new Uint8Array([2]),
    authenticatorData: new Uint8Array([3]),
    signature: new Uint8Array([4]),
    userHandle: null,
    authenticatorAttachment: null,
  });
  await f.flush();
  expect(f.replies[0]?.expression).toContain("NotAllowedError");
  expect(f.replies[0]?.expression).not.toContain('"credential"');
  f.bridge.close();
});

it("keeps the committed top document's TLS evidence while a child frame keeps reloading", async () => {
  const f = fixture();
  await f.bridge.start();
  for (let index = 0; index < 80; index++) {
    f.tls("secure", "child", `loader-child-${index}`);
    f.commit("child", `loader-child-${index}`, "https://example.test/frame");
  }
  f.call();
  await f.flush();
  expect(f.ceremony).toHaveBeenCalledOnce();
  f.bridge.close();
});
it("accepts pinned document TLS in an engine without a visible Security event", async () => {
  const f = fixture({ tls: "unknown" });
  await f.bridge.start();
  f.tls("secure");
  f.call();
  await f.flush();
  expect(f.ceremony).toHaveBeenCalledOnce();
  f.bridge.close();
});

function late() {
  const f = fixture({ committed: false, tls: "unknown", lateBootstrap: true });
  const send = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (method, parameters) => {
    if (method === "Security.enable") f.security();
    return send(method, parameters);
  });
  return f;
}
describe("late main-world bootstrap", () => {
  it("accepts only fresh secure evidence between matching ordered snapshots", async () => {
    const f = late();
    await f.bridge.start();
    f.call();
    await f.flush();
    expect(f.ceremony).toHaveBeenCalledOnce();
    const methods = f.send.mock.calls.map(([method]) => method);
    const sample = methods.indexOf("Security.enable");
    expect(methods.slice(0, sample)).toContain("Page.getNavigationHistory");
    expect(methods.slice(sample + 1)).toContain("Page.getNavigationHistory");
    f.bridge.close();
  });
  it.each([
    "Page.frameStartedNavigating",
    "Page.navigatedWithinDocument",
    "Runtime.executionContextsCleared",
    "Page.frameNavigated",
    "Page.lifecycleEvent",
  ])("refuses an epoch invalidated by %s during sampling", async (method) => {
    const f = late();
    const send = f.send.getMockImplementation()!;
    f.send.mockImplementation(async (name, parameters) => {
      if (name === "Security.enable") {
        f.events.emit(method, {
          frameId: "top",
          name: "init",
          loaderId: "loader-top",
          frame: {
            id: "top",
            loaderId: "loader-top",
            url: "https://example.test/",
            securityOrigin: "https://example.test",
          },
          type: "BackForwardCacheRestore",
        });
      }
      return send(name, parameters);
    });
    await f.bridge.start();
    f.call();
    await f.flush();
    expect(f.ceremony).not.toHaveBeenCalled();
    expect(f.replies[0]?.expression).toContain("NotAllowedError");
    f.bridge.close();
  });
  it.each(["loader", "history", "context", "prerender"])(
    "refuses changed %s identity even with secure evidence",
    async (reason) => {
      const f = late();
      const send = f.send.getMockImplementation()!;
      let sampled = false;
      f.send.mockImplementation(async (method, parameters) => {
        if (method === "Security.enable") {
          sampled = true;
          if (reason === "context")
            f.context(1, "top", "https://example.test", true, "new-context");
          if (reason === "prerender") replayPrerenderSource(f);
        }
        if (sampled && reason === "loader" && method === "Page.getFrameTree")
          return {
            frameTree: {
              frame: {
                id: "top",
                loaderId: "other-loader",
                url: "https://example.test/",
                securityOrigin: "https://example.test",
              },
            },
          };
        if (sampled && reason === "history" && method === "Page.getNavigationHistory")
          return { currentIndex: 0, entries: [{ id: 2, url: "https://example.test/" }] };
        return send(method, parameters);
      });
      await f.bridge.start();
      f.call();
      await f.flush();
      expect(f.ceremony).not.toHaveBeenCalled();
      f.bridge.close();
    },
  );
  it("does not reuse sampled TLS after BFCache restoration", async () => {
    const f = late();
    try {
      await f.bridge.start();
      f.commit();
      f.context(2);
      f.call("restored", 2);
      await f.flush();
      expect(f.ceremony).not.toHaveBeenCalled();
    } finally {
      f.bridge.close();
    }
  });
  it("revokes sampled evidence on the captured Chromium prerender activation sequence", async () => {
    const f = late();
    try {
      f.tree({ frame: prerenderActivation.initial.frame });
      f.history(prerenderActivation.initial.frame.url);
      await f.bridge.start();
      f.call("before-activation");
      await f.flush();
      expect(f.ceremony).toHaveBeenCalledOnce();
      f.ceremony.mockImplementation(() => new Promise(() => undefined));
      f.call("pending-activation");
      await f.flush();
      const signal = f.ceremony.mock.calls.at(-1)![0].signal;
      f.ceremony.mockClear();
      replayPrerenderSource(f);
      expect(signal.aborted).toBe(true);
      await f.flush();
      // The real source navigation revokes evidence before that session is
      // detached, even while its execution context is still inventoried.
      expect(f.contexts.entries()[0]?.uniqueId).toBe("unique-1");
      f.call("activation");
      await f.flush();
      expect(f.ceremony).not.toHaveBeenCalled();
      expect(f.replies.at(-1)?.expression).toContain("NotAllowedError");
      const navigation = prerenderActivation.events.findIndex(
        (event) => event.method === "Page.frameStartedNavigating",
      );
      const detached = prerenderActivation.events.findIndex(
        (event) => event.method === "Target.detachedFromTarget",
      );
      expect(navigation).toBeGreaterThanOrEqual(0);
      expect(detached).toBeGreaterThan(navigation);
    } finally {
      f.bridge.close();
    }
  });
  it.each(["Page.getFrameTree", "Security.enable"])(
    "bounds sampling when %s stalls and never accepts late evidence",
    async (held) => {
      vi.useFakeTimers();
      const f = late();
      const send = f.send.getMockImplementation()!;
      let release: (value: unknown) => void = () => undefined;
      f.send.mockImplementation(async (method, parameters) =>
        method === held
          ? new Promise((resolve) => {
              release = resolve;
            })
          : send(method, parameters),
      );
      try {
        const started = f.bridge.start();
        await vi.advanceTimersByTimeAsync(1500);
        await started;
        f.security();
        release({});
        await f.flush();
        f.call();
        await f.flush();
        expect(f.ceremony).not.toHaveBeenCalled();
      } finally {
        f.bridge.close();
        vi.useRealTimers();
      }
    },
  );
  it("never promotes cached or later unassociated evidence, including a duplicate start", async () => {
    const f = fixture({ committed: false, tls: "unknown", lateBootstrap: true });
    f.security();
    await f.bridge.start();
    f.security();
    await f.bridge.start();
    f.call();
    await f.flush();
    expect(f.ceremony).not.toHaveBeenCalled();
    expect(f.send.mock.calls.filter(([m]) => m === "Security.enable")).toHaveLength(1);
    f.bridge.close();
  });
  it.each(["neutral", "insecure-broken", "missing-chain", "missing-tls"])(
    "refuses %s evidence",
    async (reason) => {
      const f = late();
      const send = f.send.getMockImplementation()!;
      f.send.mockImplementation(async (method, parameters) => {
        const result = await send(method, parameters);
        if (method === "Security.enable")
          f.events.emit("Security.visibleSecurityStateChanged", {
            visibleSecurityState: {
              securityState:
                reason === "neutral"
                  ? "neutral"
                  : reason === "insecure-broken"
                    ? "insecure-broken"
                    : "secure",
              certificateSecurityState: {
                protocol: reason === "missing-tls" ? "" : "TLS 1.3",
                certificate: reason === "missing-chain" ? [] : ["synthetic-certificate"],
              },
            },
          });
        return result;
      });
      await f.bridge.start();
      f.call();
      await f.flush();
      expect(f.ceremony).not.toHaveBeenCalled();
      f.bridge.close();
    },
  );
});
it("keeps late-sampled evidence through documentOpened and init with the same document identity", async () => {
  const f = late();
  try {
    await f.bridge.start();
    f.call("before-write");
    await f.flush();
    expect(f.ceremony).toHaveBeenCalledOnce();
    const originalContext = f.contexts.entries()[0]!;
    f.events.emit("Page.documentOpened", {
      frame: {
        id: "top",
        loaderId: "loader-top",
        url: "https://example.test/",
        securityOrigin: "https://example.test",
      },
    });
    f.events.emit("Page.lifecycleEvent", { frameId: "top", loaderId: "loader-top", name: "init" });
    expect(f.contexts.entries()[0]?.uniqueId).toBe(originalContext.uniqueId);
    f.call("after-write");
    await f.flush();
    expect(f.ceremony).toHaveBeenCalledTimes(2);
  } finally {
    f.bridge.close();
  }
});
it("keeps an eligible written document eligible when its main world is recreated", async () => {
  const f = fixture();
  try {
    await f.bridge.start();
    f.contexts.clear();
    f.events.emit("Runtime.executionContextsCleared", {});
    f.events.emit("Page.documentOpened", {
      frame: {
        id: "top",
        loaderId: "loader-top",
        url: "https://example.test/",
        securityOrigin: "https://example.test",
      },
    });
    f.context(2);
    f.events.emit("Page.lifecycleEvent", { frameId: "top", loaderId: "loader-top", name: "init" });
    f.call("written", 2);
    await f.flush();
    expect(f.ceremony).toHaveBeenCalledOnce();
  } finally {
    f.bridge.close();
  }
});
it("never grants a blank-derived popup eligibility after documentOpened and init", async () => {
  const f = fixture({ committed: false, tls: "unknown", lateBootstrap: true });
  try {
    await f.bridge.start();
    f.events.emit("Page.documentOpened", {
      frame: {
        id: "top",
        loaderId: "loader-top",
        url: "https://example.test/rewritten",
        securityOrigin: "https://example.test",
      },
    });
    f.events.emit("Page.lifecycleEvent", { frameId: "top", loaderId: "loader-top", name: "init" });
    f.security();
    f.call();
    await f.flush();
    expect(f.ceremony).not.toHaveBeenCalled();
    expect(f.replies[0]?.expression).toContain("NotAllowedError");
  } finally {
    f.bridge.close();
  }
});

it.each([
  ["tls", "commit", "context"],
  ["context", "tls", "commit"],
  ["context", "commit", "tls"],
  ["commit", "context", "tls"],
] as const)("serves a committed document with browser event order %s/%s/%s", async (...order) => {
  const f = fixture({ committed: false, tls: "unknown" });
  await f.bridge.start();
  for (const event of order) {
    if (event === "tls") f.tls();
    if (event === "commit") f.commit();
    if (event === "context") f.context();
  }
  f.call();
  await f.flush();
  expect(f.ceremony).toHaveBeenCalledOnce();
  f.bridge.close();
});

it.each(["loader", "frame", "context"])(
  "revokes accepted sampled evidence when rewrite %s identity changes",
  async (changed) => {
    const f = late();
    try {
      await f.bridge.start();
      if (changed === "context")
        f.context(1, "top", "https://example.test", true, "replacement-context");
      f.events.emit("Page.documentOpened", {
        frame: {
          id: changed === "frame" ? "replacement-frame" : "top",
          loaderId: changed === "loader" ? "replacement-loader" : "loader-top",
          url: "https://example.test/",
          securityOrigin: "https://example.test",
        },
      });
      f.call();
      await f.flush();
      expect(f.ceremony).not.toHaveBeenCalled();
      expect(f.replies[0]?.expression).toContain("NotAllowedError");
    } finally {
      f.bridge.close();
    }
  },
);
