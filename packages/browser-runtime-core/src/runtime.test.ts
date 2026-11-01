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
    const snapshot = sink.messages.find((message) => message.type === "browser.snapshot");
    const rootSurface =
      snapshot?.type === "browser.snapshot"
        ? snapshot.surfaces.find((surface) => surface.title === "Root")
        : undefined;
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

  it("counts fresh hosts against the runtime host capacity", async () => {
    const verifier = new FakeTicketVerifier(freshClaims());
    verifier.setClaims(
      "second-fresh",
      freshClaims({
        nonce: "nonce_1123456789abcdef",
        sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000003"),
      }),
    );
    const runtime = new BrowserRuntime({
      launcher: new FakeIsolatingLauncher(),
      maxProfileHosts: 1,
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: verifier,
    });

    await runtime.attach("fresh-ticket", new FakeSink());
    await expect(runtime.attach("second-fresh", new FakeSink())).rejects.toMatchObject({
      code: "conflict",
    });
    await runtime.shutdown();
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
