import { defaultBrowserViewport } from "@opensteer/browser-core";
import { BrowserSessionIdSchema } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import type { BrowserLauncher } from "./browser/backend.js";
import { BrowserRuntimeError } from "./errors.js";
import { BrowserRuntime } from "./runtime.js";
import {
  FakeContext,
  FakeIsolatingLauncher,
  FakeLaunchedBrowser,
  FakeLauncher,
  FakePage,
  FakeSink,
  FakeTicketVerifier,
  flushMicrotasks,
  freshClaims,
  testSessionFilesRoot,
} from "./test-support/fakes.js";

describe("BrowserRuntime", () => {
  it("retires an idle Guest process with a reason and preserves suspended tab records", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "availableMemory").mockReturnValue(0);
    const context = new FakeContext([new FakePage()]);
    const browser = new FakeLaunchedBrowser(context);
    const runtime = new BrowserRuntime({
      launcher: Object.assign(new FakeLauncher(browser), { hostCost: "process" as const }),
      memoryBudgetBytes: 100 * 1024 ** 2,
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: new FakeTicketVerifier(
        freshClaims({ workspaceTabRestoreVersion: 1, surfaceState: 1 }),
      ),
    });
    const sink = new FakeSink();
    try {
      const attachment = await runtime.attach("fresh-ticket", sink);
      await attachment.handle(
        JSON.stringify({ type: "session.state", runs: 0, viewed: [], pinned: [] }),
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(
        () => expect(runtime.health().sessionCount, "Idle Guest never retired").toBe(0),
        { timeout: 1000 },
      );
      expect(sink.messages).toContainEqual({
        type: "browser.status",
        state: "closed",
        reason: "retired",
      });
      expect([...sink.tabs.rows.values()].map((row) => row.state)).toEqual(["suspended"]);
    } finally {
      await runtime.shutdown();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
  it("receives Host session state before releasing an agent's page and drops its timer on detach", async () => {
    vi.useFakeTimers();
    const context = new FakeContext([new FakePage()]);
    const claims = freshClaims({ workspaceTabRestoreVersion: 1, surfaceState: 1 });
    const runtime = new BrowserRuntime({
      launcher: new FakeLauncher(new FakeLaunchedBrowser(context)),
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: new FakeTicketVerifier(claims),
    });
    const sink = new FakeSink();
    try {
      const attachment = await runtime.attach("fresh-ticket", sink);
      expect(sink.messages.find((message) => message.type === "browser.snapshot")).toMatchObject({
        surfaceState: 1,
      });
      await attachment.handle(
        JSON.stringify({
          type: "cdp.command",
          requestId: crypto.randomUUID(),
          command: { method: "Target.createTarget", parameters: { url: "https://leftover.test/" } },
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      const tab = [...sink.tabs.rows.values()].find((row) => row.order === 1)!;
      expect(tab).toBeDefined();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sink.tabs.rows.get(tab.id)?.state).toBe("live");
      await attachment.handle(
        JSON.stringify({ type: "session.state", runs: 1, viewed: [], pinned: [] }),
      );
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sink.tabs.rows.get(tab.id)?.state).toBe("live");
      await attachment.handle(
        JSON.stringify({ type: "session.state", runs: 0, viewed: [], pinned: [] }),
      );
      await vi.advanceTimersByTimeAsync(59_999);
      expect(sink.tabs.rows.get(tab.id)?.state).toBe("live");
      await vi.advanceTimersByTimeAsync(1);
      expect(sink.tabs.rows.get(tab.id)?.state).toBe("suspended");
      await attachment.close();
      expect(runtime.health().sessionCount).toBe(0);
    } finally {
      await runtime.shutdown();
      vi.useRealTimers();
    }
  });
  it("sizes only the page a Fit names and leaves the session's other pages alone", async () => {
    const root = new FakePage({ title: "Root" });
    const context = new FakeContext([root]);
    const launcher = new FakeLauncher(new FakeLaunchedBrowser(context));
    const runtime = new BrowserRuntime({
      launcher,
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: new FakeTicketVerifier(freshClaims()),
    });
    const sink = new FakeSink();
    const attachment = await runtime.attach("fresh-ticket", sink);
    const popup = new FakePage({ opener: root, title: "Popup" });
    context.addPage(popup);
    await flushMicrotasks();
    popup.cdpSession.responses.set("Emulation.setDeviceMetricsOverride", () => {
      throw new Error("a write that reached the popup");
    });
    const rootSurface = [...sink.tabs.rows.values()].find((surface) => surface.title === "Root");
    if (!rootSurface) throw new Error("Missing root surface");

    await attachment.handle(
      JSON.stringify({ height: 600, surfaceId: rootSurface.id, type: "viewport.set", width: 900 }),
    );
    await flushMicrotasks();

    expect(sink.messages.filter((message) => message.type === "browser.error")).toHaveLength(0);
    expect(popup.closeCount).toBe(0);
    expect(root.closeCount).toBe(0);
    expect(
      root.cdpSession.sent
        .filter((command) => command.method === "Emulation.setDeviceMetricsOverride")
        .at(-1)?.parameters,
    ).toMatchObject({ height: 600, width: 900 });
    expect(
      popup.cdpSession.sent
        .filter((command) => command.method === "Emulation.setDeviceMetricsOverride")
        .map((command) => command.parameters),
    ).toEqual([expect.objectContaining(defaultBrowserViewport)]);
    expect(runtime.health()).toMatchObject({ sessionCount: 1, state: "ready" });

    await attachment.close();
    await runtime.shutdown();
  });

  it("cleans up an unexpected browser process exit", async () => {
    const browser = new FakeLaunchedBrowser(new FakeContext([new FakePage()]));
    const runtime = new BrowserRuntime({
      launcher: new FakeLauncher(browser),
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: new FakeTicketVerifier(),
    });
    await runtime.attach("signed-ticket", new FakeSink());

    browser.crash();
    await vi.waitFor(() =>
      expect(runtime.health()).toMatchObject({
        profileHostCount: 0,
        sessionCount: 0,
        state: "idle",
      }),
    );
    await runtime.shutdown();
  });

  it("returns to idle with a sanitized error after launch failure", async () => {
    const launcher: BrowserLauncher = {
      launch: async () => {
        throw new Error("private executable detail");
      },
    };
    const runtime = new BrowserRuntime({
      launcher,
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: new FakeTicketVerifier(),
    });
    await expect(runtime.attach("signed-ticket", new FakeSink())).rejects.toMatchObject({
      code: "internal",
      message: expect.stringContaining("context-launch"),
      reason: "session-start.context-launch",
    });
    expect(runtime.health().state).toBe("idle");
  });

  it("does not launch when attach-ticket verification fails", async () => {
    const launcher = new FakeLauncher();
    const runtime = new BrowserRuntime({
      launcher,
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: {
        verify: async () => {
          throw new BrowserRuntimeError("forbidden", "Ticket rejected.");
        },
      },
    });
    await expect(runtime.attach("bad-ticket", new FakeSink())).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(launcher.launchCount).toBe(0);
    expect(runtime.health().state).toBe("idle");
  });

  it("leaves lifecycle state usable even when process cleanup reports failure", async () => {
    const context = new FakeContext([new FakePage()]);
    const browser = new FakeLaunchedBrowser(context, new Error("close failed"));
    const runtime = new BrowserRuntime({
      launcher: { launch: async () => browser },
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: new FakeTicketVerifier(),
    });
    const attachment = await runtime.attach("signed-ticket", new FakeSink());

    await expect(attachment.close()).rejects.toThrow(/cleanup/i);
    expect(runtime.health().state).toBe("idle");
    await runtime.shutdown();
    expect(runtime.health().state).toBe("closed");
  });

  it("discards fresh state on an idle close and on shutdown", async () => {
    vi.useFakeTimers();
    try {
      const launcher = new FakeIsolatingLauncher();
      const verifier = new FakeTicketVerifier(freshClaims());
      verifier.setClaims(
        "second-ticket",
        freshClaims({
          nonce: "nonce_1123456789abcdef",
          sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000003"),
        }),
      );
      const runtime = new BrowserRuntime({
        launcher,
        runtimeId: "runtime_test",
        sessionFilesRoot: testSessionFilesRoot(),
        ticketVerifier: verifier,
      });

      const idle = await runtime.attach("fresh-ticket", new FakeSink());
      await idle.close();
      await vi.advanceTimersByTimeAsync(5);
      expect(runtime.health()).toMatchObject({ profileHostCount: 0 });

      await runtime.attach("second-ticket", new FakeSink());
      await runtime.shutdown();
      expect(runtime.health().state).toBe("closed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("attaches Guest host 9", async () => {
    const verifier = new FakeTicketVerifier(freshClaims());
    const runtime = new BrowserRuntime({
      launcher: new FakeIsolatingLauncher(),
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: verifier,
    });
    try {
      for (let index = 1; index <= 9; index++) {
        const ticket = `guest-${index}`;
        verifier.setClaims(
          ticket,
          freshClaims({
            nonce: `nonce_${String(index).padStart(16, "0")}`,
            sessionId: BrowserSessionIdSchema.parse(
              `bsn_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            ),
          }),
        );
        await runtime.attach(ticket, new FakeSink());
      }
      expect(runtime.health()).toMatchObject({ profileHostCount: 9, sessionCount: 9 });
    } finally {
      await runtime.shutdown();
    }
  });
});

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
] as const)(
  "requires the Host welcome and signed passkey claim before provider launch (welcome=%s, claim=%s)",
  async (enabled, signed) => {
    const launcher = new FakeLauncher();
    const runtime = new BrowserRuntime({
      launcher,
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: new FakeTicketVerifier(freshClaims(signed ? { passkeys: 1 } : {})),
    });
    try {
      await runtime.attach("ticket", new FakeSink(), { passkeys: enabled });
      expect(launcher.lastRequest?.authenticator !== undefined).toBe(enabled && signed);
    } finally {
      await runtime.shutdown();
    }
  },
);

it.each(["live", "released", "ambiguous", "other-consumer"] as const)(
  "binds native autofill presence to a live, unambiguous presentation (%s)",
  async (state) => {
    const root = new FakePage({ url: "https://example.test" });
    const cdp = root.cdpSession;
    const targetId = await root.targetId();
    const claims = freshClaims({ personFillVersion: 1, editingVersion: 2, clipboard: false });
    const account = {
      id: crypto.randomUUID(),
      revision: 1,
      username: "fixture",
      label: null,
      ready: false,
    };
    const fill = vi.fn(async () => "filled" as const);
    const runtime = new BrowserRuntime({
      launcher: new FakeLauncher(new FakeLaunchedBrowser(new FakeContext([root]))),
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: new FakeTicketVerifier(claims),
      loginAuthority: {
        probe: async () => "unavailable",
        authorize: async () => ({ kind: "ended", outcome: { kind: "declined" } }),
        fill: async () => "unavailable",
        end: async () => {},
        personFillAccounts: async () => [account],
        personFill: fill,
      },
    });
    const sink = new FakeSink();
    const attachment = await runtime.attach("fresh-ticket", sink);
    try {
      await flushMicrotasks();
      const surfaceId = sink.tabs.rows.values().next().value?.id;
      if (!surfaceId) throw new Error("Missing browser surface");
      const presentation = runtime.presentSurface(
        BrowserSessionIdSchema.parse(claims.sessionId),
        surfaceId,
      );
      if (!presentation) throw new Error("Missing native presentation");
      const consumerToken = crypto.randomUUID();
      presentation.viewerInput?.(consumerToken);
      cdp.responses.set("Page.getFrameTree", {
        frameTree: { frame: { id: targetId, securityOrigin: "https://example.test" } },
      });
      const world = cdp.sent.find(
        (entry) =>
          entry.method === "Runtime.addBinding" &&
          String(entry.parameters?.executionContextName).startsWith("opensteer-editing-"),
      )!.parameters!;
      cdp.emit("Runtime.executionContextCreated", {
        context: {
          id: 7,
          uniqueId: crypto.randomUUID(),
          name: world.executionContextName,
          origin: "https://example.test",
          auxData: { frameId: targetId, isDefault: false },
        },
      });
      cdp.emit("Runtime.bindingCalled", {
        name: world.name,
        executionContextId: 7,
        payload: JSON.stringify({
          kind: "person-fill",
          activated: true,
          bindingId: crypto.randomUUID(),
          role: "password",
          box: { x: 10, y: 20, width: 120, height: 30 },
          slots: { partner: false, group: false },
        }),
      });
      await vi.waitFor(() =>
        expect(
          sink.messages.some((message) => message.type === "browser.autofill.offer"),
          "Native activation never offered accounts",
        ).toBe(true),
      );
      const offer = sink.messages.find((message) => message.type === "browser.autofill.offer")!;
      if (offer.type !== "browser.autofill.offer") throw new Error("Missing autofill offer");
      if (state === "released") presentation.release();
      if (state === "ambiguous")
        runtime.presentSurface(BrowserSessionIdSchema.parse(claims.sessionId), surfaceId);
      if (state === "other-consumer") presentation.viewerInput?.(crypto.randomUUID());
      await attachment.handle(
        JSON.stringify({
          type: "autofill.fill",
          surfaceId,
          offerId: offer.offerId,
          loginId: account.id,
          revision: 1,
          producerId: consumerToken,
        }),
      );
      expect(fill).toHaveBeenCalledTimes(state === "live" ? 1 : 0);
      expect(sink.messages).toContainEqual({
        type: "browser.autofill.result",
        surfaceId,
        offerId: offer.offerId,
        consumerToken,
        status: state === "live" ? "filled" : "unavailable",
      });
    } finally {
      await attachment.close();
      await runtime.shutdown();
    }
  },
);
