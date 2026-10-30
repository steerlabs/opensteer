import { gate } from "@opensteer/shared/test-support/observation";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { describe, expect, it, vi } from "vitest";
import { defaultBrowserViewport } from "@opensteer/browser-core";
import { BrowserSessionIdSchema, browserStateImportRuntimeTimeoutMs } from "@opensteer/protocol";
import { EmptyBrowserProfileSnapshot } from "@opensteer/browser-profile/snapshot";
import type { BrowserLauncher } from "./browser/backend.js";
import { BrowserRuntimeError } from "./errors.js";
import type { BrowserProfileStateClient } from "./profile-state-client.js";
import { BrowserRuntime } from "./runtime.js";
import {
  FakeContext,
  FakeIsolatingLauncher,
  FakeLaunchedBrowser,
  FakeLauncher,
  FakePage,
  FakeProfileStateClient,
  FakeSink,
  FakeTicketVerifier,
  flushMicrotasks,
  freshClaims,
  testSessionFilesRoot,
  validClaims,
} from "./test-support/fakes.js";

/** Any profile-state traffic at all is a failure for a fresh session. */
const forbiddenProfileState: BrowserProfileStateClient = {
  commit: () => {
    throw new Error("A fresh Browser Session must never commit profile state.");
  },
  load: () => {
    throw new Error("A fresh Browser Session must never load profile state.");
  },
};

describe("BrowserRuntime", () => {
  it("sizes only the page a Fit names and leaves the session's other pages alone", async () => {
    const root = new FakePage({ title: "Root" });
    const context = new FakeContext([root]);
    const launcher = new FakeLauncher(new FakeLaunchedBrowser(context));
    const runtime = new BrowserRuntime({
      launcher,
      profileStateClient: forbiddenProfileState,
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

  it("queues the next attachment behind an in-flight final commit", async () => {
    const held = gate({ label: "final host commit", deadlineMs: 2_000 });
    const state = new FakeProfileStateClient();
    const verifier = new FakeTicketVerifier();
    verifier.setClaims(
      "next",
      validClaims({
        sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000003"),
      }),
    );
    const runtime = new BrowserRuntime({
      launcher: new FakeLauncher(),
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: verifier,
      profileStateClient: {
        load: () => state.load(),
        commit: async (...args) => {
          await held.enter();
          return state.commit(...args);
        },
      },
    });
    let stopping: Promise<void> | undefined;
    let next: ReturnType<typeof runtime.attach> | undefined;
    try {
      const first = await runtime.attach("signed-ticket", new FakeSink());
      stopping = first.close();
      await held.entered;
      next = runtime.attach("next", new FakeSink());
      held.release();
      await withTimeout(stopping, 2_000, { timeoutError: () => new Error("final close stalled") });
      const attachment = await withTimeout(next, 2_000, {
        timeoutError: () => new Error("next attach stalled"),
      });
      expect(runtime.health().sessionCount).toBe(1);
      expect(state.revision).toBe(1);
      await attachment.close();
    } finally {
      held.release();
      await stopping?.catch(() => undefined);
      await next?.catch(() => undefined);
      await runtime.shutdown();
    }
  });

  it.each(["profile-state.lease-rejected", "profile-state.transport-failed"])(
    "disposes a failed final save (%s) and admits a new session",
    async (reason) => {
      const launcher = new FakeLauncher();
      const state = new FakeProfileStateClient();
      const transport = reason === "profile-state.transport-failed";
      const failure = new BrowserRuntimeError(transport ? "internal" : "forbidden", "save failed", {
        reason,
        retryable: transport,
      });
      let fail = true;
      const verifier = new FakeTicketVerifier();
      verifier.setClaims(
        "next",
        validClaims({
          sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000003"),
        }),
      );
      const runtime = new BrowserRuntime({
        launcher,
        runtimeId: "runtime_test",
        sessionFilesRoot: testSessionFilesRoot(),
        ticketVerifier: verifier,
        profileStateClient: {
          load: () => state.load(),
          commit: (...args) => {
            if (fail) {
              fail = false;
              throw failure;
            }
            return state.commit(...args);
          },
        },
      });
      try {
        const first = await runtime.attach("signed-ticket", new FakeSink());
        await expect(first.close()).rejects.toMatchObject({ errors: [failure] });
        expect(runtime.health().profileHostCount).toBe(0);
        const next = await runtime.attach("next", new FakeSink());
        expect(launcher.launchCount).toBe(2);
        expect(launcher.lastRequest?.snapshot).toEqual(state.snapshot);
        await next.close();
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it("keeps a refused final save as the error when releasing its browser also fails", async () => {
    const closeError = new Error("browser close failed");
    const launcher = new FakeLauncher(
      new FakeLaunchedBrowser(new FakeContext([new FakePage()]), closeError),
    );
    const refused = new BrowserRuntimeError("forbidden", "save refused", {
      reason: "profile-state.lease-rejected",
      retryable: false,
    });
    const diagnostics: { stage: string; error: BrowserRuntimeError }[] = [];
    const runtime = new BrowserRuntime({
      launcher,
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: new FakeTicketVerifier(),
      onCheckpointFailure: ({ stage, error }) => diagnostics.push({ stage, error }),
      profileStateClient: {
        load: () => new FakeProfileStateClient().load(),
        commit: () => Promise.reject(refused),
      },
    });
    try {
      const session = await runtime.attach("signed-ticket", new FakeSink());
      await expect(session.close()).rejects.toMatchObject({ errors: [refused] });
      expect(diagnostics).toEqual([
        {
          stage: "browser-close",
          error: expect.objectContaining({
            reason: "profile-checkpoint.browser-close-failed",
            cause: expect.objectContaining({ errors: [closeError] }),
          }),
        },
        { stage: "host-commit", error: refused },
      ]);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  it("restores the Host-owned profile once and checkpoints it when the Profile Host closes", async () => {
    const launcher = new FakeLauncher();
    const profileStateClient = new FakeProfileStateClient();
    profileStateClient.revision = 4;
    profileStateClient.snapshot = {
      cookies: [
        {
          domain: "example.test",
          expires: -1,
          httpOnly: true,
          name: "session",
          path: "/",
          sameSite: "Lax",
          secure: true,
          value: "opaque-cookie",
        },
      ],
      origins: [],
    };
    launcher.browser.snapshot = {
      cookies: [],
      origins: [
        {
          localStorage: [{ name: "theme", value: "dark" }],
          origin: "https://example.test/",
        },
      ],
    };
    const runtime = new BrowserRuntime({
      launcher,
      profileStateClient,
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: new FakeTicketVerifier(),
    });

    const attachment = await runtime.attach("signed-ticket", new FakeSink());
    expect(launcher.lastRequest?.snapshot).toEqual(profileStateClient.snapshot);
    await attachment.close();

    expect(profileStateClient.commits).toEqual([
      { expectedRevision: 4, snapshot: launcher.browser.snapshot },
    ]);
    expect(profileStateClient.revision).toBe(5);
    await runtime.shutdown();
  });

  it("runs many isolated sessions in one browser process for the same profile", async () => {
    const launcher = new FakeLauncher();
    const verifier = new FakeTicketVerifier();
    const secondClaims = validClaims({
      nonce: "nonce_1123456789abcdef",
      sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000003"),
    });
    verifier.setClaims("second-ticket", secondClaims);
    const profileState = new FakeProfileStateClient();
    const committedSessionIds: string[] = [];
    const runtime = new BrowserRuntime({
      idleProfileHostTimeoutMs: 0,
      launcher,
      profileStateClient: {
        load: () => profileState.load(),
        commit: (claims, ...parameters) => {
          committedSessionIds.push(claims.sessionId);
          return profileState.commit(claims, ...parameters);
        },
      },
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: verifier,
    });
    const sink = new FakeSink();

    const attachment = await runtime.attach("signed-ticket", sink);
    expect(runtime.health()).toEqual({
      checkpointFailures: 0,
      profileHostCount: 1,
      runtimeId: "runtime_test",
      sessionCount: 1,
      state: "ready",
    });
    expect(launcher.launchCount).toBe(1);
    expect(launcher.lastRequest).toMatchObject({
      partitionKey: "profile:bpr_00000000-0000-4000-8000-000000000001",
      sessionId: verifier.claims.sessionId,
    });
    const secondAttachment = await runtime.attach("second-ticket", new FakeSink());
    expect(runtime.health()).toMatchObject({ profileHostCount: 1, sessionCount: 2 });
    expect(launcher.launchCount).toBe(1);
    expect(launcher.browser.context.pages()).toHaveLength(2);

    await expect(runtime.attach("second-ticket", new FakeSink())).rejects.toMatchObject({
      code: "conflict",
    });

    await attachment.close();
    await attachment.close();
    expect(runtime.health()).toMatchObject({
      profileHostCount: 1,
      sessionCount: 1,
      state: "ready",
    });
    expect(launcher.browser.closeCount).toBe(0);

    await secondAttachment.close();
    expect(committedSessionIds).toEqual([secondClaims.sessionId]);
    expect(runtime.health()).toMatchObject({ profileHostCount: 0, sessionCount: 0, state: "idle" });
    expect(launcher.browser.closeCount).toBe(1);
    await runtime.shutdown();
    await runtime.shutdown();
    expect(runtime.health().state).toBe("closed");
  });

  it("relaunches an idle profile with the requested passkey mode after the old browser exits", async () => {
    let releaseClose: () => void = () => {};
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let closeStarted = false;
    class DelayedCloseBrowser extends FakeLaunchedBrowser {
      override async close(): Promise<void> {
        closeStarted = true;
        await closeGate;
        await super.close();
      }
    }
    const browsers: FakeLaunchedBrowser[] = [];
    const requests: Parameters<BrowserLauncher["launch"]>[0][] = [];
    const launcher: BrowserLauncher = {
      launch: async (request) => {
        requests.push(request);
        const context = new FakeContext([new FakePage()]);
        const browser =
          browsers.length === 0
            ? new DelayedCloseBrowser(context)
            : new FakeLaunchedBrowser(context);
        browsers.push(browser);
        return browser;
      },
    };
    const verifier = new FakeTicketVerifier();
    verifier.setClaims(
      "enabled",
      validClaims({
        sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000003"),
        passkeys: 1,
      }),
    );
    const runtime = new BrowserRuntime({
      idleProfileHostTimeoutMs: 30_000,
      launcher,
      profileStateClient: new FakeProfileStateClient(),
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: verifier,
    });
    try {
      const first = await runtime.attach("disabled", new FakeSink(), { passkeys: true });
      await first.close();
      const pending = runtime.attach("enabled", new FakeSink(), { passkeys: true });
      await vi.waitFor(() => expect(closeStarted).toBe(true));
      expect(requests).toHaveLength(1);
      releaseClose();
      const second = await pending;
      expect(browsers[0]?.closeCount).toBe(1);
      expect(requests).toHaveLength(2);
      expect(requests[1]?.authenticator).toBeDefined();
      await second.close();
    } finally {
      releaseClose();
      await runtime.shutdown();
    }
  });

  it("keeps the profile locked if the close event precedes process exit and shutdown times out", async () => {
    let releaseClose: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let closing = false;
    class SlowExitBrowser extends FakeLaunchedBrowser {
      override async close(): Promise<void> {
        this.crash();
        closing = true;
        await gate;
        await super.close();
      }
    }
    const launcher = new FakeIsolatingLauncher();
    const slow = new SlowExitBrowser(new FakeContext([new FakePage()]));
    const launch: BrowserLauncher = {
      launch: async (request) => {
        if (launcher.launchCount === 0) {
          launcher.launchCount++;
          launcher.requests.push(request);
          return slow;
        }
        return launcher.launch(request);
      },
    };
    const verifier = new FakeTicketVerifier();
    verifier.setClaims(
      "enabled",
      validClaims({
        sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000003"),
        passkeys: 1,
      }),
    );
    const runtime = new BrowserRuntime({
      idleProfileHostTimeoutMs: 30_000,
      launcher: launch,
      onCheckpointFailure: () => {},
      profileStateClient: new FakeProfileStateClient(),
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: verifier,
    });
    try {
      const first = await runtime.attach("first", new FakeSink(), { passkeys: true });
      await first.close();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = runtime.attach("enabled", new FakeSink(), { passkeys: true });
      const failed = expect(pending).rejects.toMatchObject({ code: "conflict", retryable: true });
      await flushMicrotasks();
      expect(closing).toBe(true);
      await vi.advanceTimersByTimeAsync(browserStateImportRuntimeTimeoutMs + 15_001);
      await failed;
      await expect(
        runtime.attach("enabled", new FakeSink(), { passkeys: true }),
      ).rejects.toMatchObject({
        code: "conflict",
        retryable: true,
      });
      expect(launcher.launchCount).toBe(1);
    } finally {
      releaseClose();
      await flushMicrotasks();
      vi.useRealTimers();
      await runtime.shutdown();
    }
  });

  it.each([
    [false, true],
    [true, false],
  ] as const)(
    "refuses a passkey mode change while another session holds the profile (old=%s, new=%s)",
    async (oldMode, newMode) => {
      const launcher = new FakeIsolatingLauncher();
      const verifier = new FakeTicketVerifier(validClaims(oldMode ? { passkeys: 1 } : {}));
      verifier.setClaims(
        "second",
        validClaims({
          sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000003"),
          ...(newMode ? { passkeys: 1 } : {}),
        }),
      );
      const runtime = new BrowserRuntime({
        launcher,
        profileStateClient: new FakeProfileStateClient(),
        runtimeId: "runtime_test",
        sessionFilesRoot: testSessionFilesRoot(),
        ticketVerifier: verifier,
      });
      try {
        const first = await runtime.attach("first", new FakeSink(), { passkeys: true });
        await expect(
          runtime.attach("second", new FakeSink(), { passkeys: true }),
        ).rejects.toMatchObject({
          code: "conflict",
          retryable: true,
          message: expect.stringMatching(/passkey/i),
        });
        expect(launcher.launchCount).toBe(1);
        expect(runtime.health().sessionCount).toBe(1);
        await first.close();
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it.each([false, true])(
    "reuses a profile when passkey mode matches (enabled=%s)",
    async (enabled) => {
      const launcher = new FakeIsolatingLauncher();
      const verifier = new FakeTicketVerifier(validClaims(enabled ? { passkeys: 1 } : {}));
      verifier.setClaims(
        "second",
        validClaims({
          sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000003"),
          ...(enabled ? { passkeys: 1 } : {}),
        }),
      );
      const runtime = new BrowserRuntime({
        launcher,
        profileStateClient: new FakeProfileStateClient(),
        runtimeId: "runtime_test",
        sessionFilesRoot: testSessionFilesRoot(),
        ticketVerifier: verifier,
      });
      try {
        const first = await runtime.attach("first", new FakeSink(), { passkeys: true });
        const second = await runtime.attach("second", new FakeSink(), { passkeys: true });
        expect(launcher.launchCount).toBe(1);
        expect(Boolean(launcher.requests[0]?.authenticator)).toBe(enabled);
        expect(runtime.health().sessionCount).toBe(2);
        await first.close();
        await second.close();
      } finally {
        await runtime.shutdown();
      }
    },
  );

  it("keeps a Profile Host and retries after an idle checkpoint failure", async () => {
    vi.useFakeTimers();
    try {
      const delegate = new FakeProfileStateClient();
      let attempts = 0;
      const runtime = new BrowserRuntime({
        checkpointRetryMs: 1_000,
        idleProfileHostTimeoutMs: 1,
        launcher: new FakeLauncher(),
        profileStateClient: {
          load: () => delegate.load(),
          commit: async (...parameters) => {
            attempts += 1;
            if (attempts === 1) throw new Error("temporary profile vault failure");
            return delegate.commit(...parameters);
          },
        },
        runtimeId: "runtime_test",
        sessionFilesRoot: testSessionFilesRoot(),
        ticketVerifier: new FakeTicketVerifier(),
      });
      const attachment = await runtime.attach("signed-ticket", new FakeSink());
      await attachment.close();

      await vi.advanceTimersByTimeAsync(1);
      expect(runtime.health()).toMatchObject({
        checkpointFailures: 1,
        profileHostCount: 1,
        sessionCount: 0,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(attempts).toBe(2);
      expect(runtime.health()).toMatchObject({
        checkpointFailures: 1,
        profileHostCount: 0,
      });
      await runtime.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a failed immediate checkpoint without losing the Profile Host", async () => {
    vi.useFakeTimers();
    try {
      const delegate = new FakeProfileStateClient();
      let attempts = 0;
      const runtime = new BrowserRuntime({
        checkpointRetryMs: 1_000,
        launcher: new FakeLauncher(),
        profileStateClient: {
          load: () => delegate.load(),
          commit: async (...parameters) => {
            attempts += 1;
            if (attempts === 1) throw new Error("temporary profile vault failure");
            return delegate.commit(...parameters);
          },
        },
        runtimeId: "runtime_test",
        sessionFilesRoot: testSessionFilesRoot(),
        ticketVerifier: new FakeTicketVerifier(),
      });
      const attachment = await runtime.attach("signed-ticket", new FakeSink());

      await expect(attachment.close()).rejects.toThrow(/cleanup/i);
      expect(runtime.health()).toMatchObject({
        checkpointFailures: 1,
        profileHostCount: 1,
        sessionCount: 0,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(attempts).toBe(2);
      expect(runtime.health()).toMatchObject({ profileHostCount: 0, state: "idle" });
      await runtime.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("quiesces live pages before shutdown checkpointing and retries without losing the host", async () => {
    const page = new FakePage();
    const browser = new FakeLaunchedBrowser(new FakeContext([page]));
    const delegate = new FakeProfileStateClient();
    let attempts = 0;
    const runtime = new BrowserRuntime({
      launcher: new FakeLauncher(browser),
      profileStateClient: {
        load: () => delegate.load(),
        commit: async (...parameters) => {
          attempts += 1;
          expect(page.isClosed()).toBe(true);
          if (attempts === 1) throw new Error("temporary checkpoint failure");
          return delegate.commit(...parameters);
        },
      },
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: new FakeTicketVerifier(),
    });
    await runtime.attach("signed-ticket", new FakeSink());

    await expect(runtime.shutdown()).rejects.toThrow(/checkpointed/i);
    expect(page.closeCount).toBe(1);
    expect(browser.closeCount).toBe(0);
    expect(runtime.health()).toMatchObject({ profileHostCount: 1, sessionCount: 0 });

    await runtime.shutdown();
    expect(attempts).toBe(2);
    expect(browser.closeCount).toBe(1);
    expect(runtime.health().state).toBe("closed");
  });

  it.each(
    ["complete", "deadline"].flatMap((outcome) =>
      [false, true].flatMap((periodicWaiting) =>
        ["shutdown", "session-close"].map((closePath) => ({ outcome, periodicWaiting, closePath })),
      ),
    ),
  )(
    "drains an admitted cookie import ($outcome, periodic: $periodicWaiting, $closePath)",
    async ({ outcome, periodicWaiting, closePath }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const timeouts = vi.spyOn(globalThis, "setTimeout");
      const browser = new FakeLaunchedBrowser(new FakeContext([new FakePage()]));
      const profileState = new FakeProfileStateClient();
      const exported = vi.spyOn(browser, "exportSnapshot");
      const started = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const cookie = {
        name: "session",
        value: "imported",
        domain: "example.test",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax" as const,
      };
      const writes = vi
        .spyOn(browser, "replaceSiteCookies")
        .mockImplementation(async (_site, _cookies, deadline) => {
          started.resolve();
          await released.promise;
          deadline.throwIfAborted();
          browser.snapshot = { cookies: [cookie], origins: [] };
        });
      const runtime = new BrowserRuntime({
        checkpointIntervalMs: periodicWaiting ? 1_000 : 120_000,
        checkpointRetryMs: 1_000,
        launcher: new FakeLauncher(browser),
        profileStateClient: profileState,
        runtimeId: "runtime_test",
        sessionFilesRoot: testSessionFilesRoot(),
        ticketVerifier: new FakeTicketVerifier(),
      });
      let stopping: Promise<void> | undefined;
      try {
        const attachment = await runtime.attach("signed-ticket", new FakeSink());
        const importing = attachment.handle(
          JSON.stringify({
            type: "state.import",
            site: "https://example.test",
            cookies: [cookie],
            operationId: "00000000-0000-4000-8000-0000000000b1",
          }),
        );
        await started.promise;
        if (periodicWaiting) await vi.advanceTimersByTimeAsync(1_100);
        // Ignore the import's own deadline; the next one belongs to the drain.
        timeouts.mockClear();
        stopping = closePath === "shutdown" ? runtime.shutdown() : attachment.close();
        let settled = false;
        let stopError: unknown;
        void stopping.then(
          () => {
            settled = true;
          },
          (error: unknown) => {
            settled = true;
            stopError = error;
          },
        );
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(2_100);
        // Session removal can precede real filesystem cleanup and the drain timer.
        await vi.waitFor(() =>
          expect(timeouts).toHaveBeenCalledWith(
            expect.any(Function),
            browserStateImportRuntimeTimeoutMs,
          ),
        );
        expect(runtime.health().sessionCount).toBe(0);
        expect(settled).toBe(false);
        expect(exported).not.toHaveBeenCalled();
        expect(profileState.commits).toEqual([]);
        expect(browser.closeCount).toBe(0);
        await attachment.handle(
          JSON.stringify({
            type: "state.import",
            site: "https://example.test",
            cookies: [],
            operationId: "00000000-0000-4000-8000-0000000000b2",
          }),
        );
        expect(writes).toHaveBeenCalledOnce();
        if (outcome === "complete") released.resolve();
        else {
          await vi.advanceTimersByTimeAsync(browserStateImportRuntimeTimeoutMs);
          expect(settled).toBe(true);
          expect(stopError).toBeInstanceOf(AggregateError);
          const saveError = stopError instanceof AggregateError ? stopError.errors[0] : undefined;
          expect(saveError).toBeInstanceOf(BrowserRuntimeError);
          expect(saveError).toMatchObject({
            code: "conflict",
            retryable: true,
            cause: { name: "AbortError" },
            message:
              "Could not save this browser profile because a sign-in import is still pending. Unsaved state remains in memory, and " +
              (closePath === "shutdown"
                ? "shutdown did not complete."
                : "Opensteer will retry saving it automatically."),
          });
          expect(exported).not.toHaveBeenCalled();
          expect(profileState.commits).toEqual([]);
          expect(browser.closeCount).toBe(0);
          expect(runtime.health()).toMatchObject({ profileHostCount: 1, sessionCount: 0 });
          released.resolve();
        }
        await importing;
        await stopping.catch(() => undefined);
        if (closePath === "session-close" && outcome === "deadline") {
          await vi.advanceTimersByTimeAsync(1_000);
          expect(browser.closeCount).toBe(1);
        }
        await runtime.shutdown();
        expect(profileState.commits.at(-1)?.snapshot.cookies).toEqual(
          outcome === "complete" ? [cookie] : [],
        );
        expect(browser.closeCount).toBe(1);
      } finally {
        released.resolve();
        await vi.advanceTimersByTimeAsync(browserStateImportRuntimeTimeoutMs);
        await stopping?.catch(() => undefined);
        await runtime.shutdown();
        timeouts.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("cleans up an unexpected browser process exit", async () => {
    const browser = new FakeLaunchedBrowser(new FakeContext([new FakePage()]));
    const runtime = new BrowserRuntime({
      launcher: new FakeLauncher(browser),
      profileStateClient: new FakeProfileStateClient(),
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
      profileStateClient: new FakeProfileStateClient(),
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
      profileStateClient: new FakeProfileStateClient(),
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
      idleProfileHostTimeoutMs: 0,
      launcher: { launch: async () => browser },
      profileStateClient: new FakeProfileStateClient(),
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

  it("launches a fresh session from empty state and never checkpoints it", async () => {
    const launcher = new FakeLauncher();
    launcher.browser.snapshot = {
      cookies: [],
      origins: [
        { localStorage: [{ name: "theme", value: "dark" }], origin: "https://example.test/" },
      ],
    };
    const runtime = new BrowserRuntime({
      launcher,
      profileStateClient: forbiddenProfileState,
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: new FakeTicketVerifier(freshClaims()),
    });

    const attachment = await runtime.attach("fresh-ticket", new FakeSink());
    expect(launcher.lastRequest).toMatchObject({
      partitionKey: "session:bsn_00000000-0000-4000-8000-000000000002",
      sessionId: "bsn_00000000-0000-4000-8000-000000000002",
      snapshot: EmptyBrowserProfileSnapshot,
    });

    await attachment.close();
    expect(runtime.health()).toMatchObject({ profileHostCount: 0, sessionCount: 0, state: "idle" });
    expect(launcher.browser.closeCount).toBe(1);
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
        idleProfileHostTimeoutMs: 5,
        launcher,
        profileStateClient: forbiddenProfileState,
        runtimeId: "runtime_test",
        sessionFilesRoot: testSessionFilesRoot(),
        ticketVerifier: verifier,
      });

      const idle = await runtime.attach("fresh-ticket", new FakeSink());
      await idle.close();
      await vi.advanceTimersByTimeAsync(5);
      expect(runtime.health()).toMatchObject({ checkpointFailures: 0, profileHostCount: 0 });

      await runtime.attach("second-ticket", new FakeSink());
      await runtime.shutdown();
      expect(runtime.health().state).toBe("closed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates every fresh session in its own host while profile sessions share one", async () => {
    const launcher = new FakeIsolatingLauncher();
    const verifier = new FakeTicketVerifier(freshClaims());
    verifier.setClaims(
      "second-fresh",
      freshClaims({
        nonce: "nonce_1123456789abcdef",
        sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000003"),
      }),
    );
    verifier.setClaims(
      "profile",
      validClaims({
        nonce: "nonce_2123456789abcdef",
        sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000004"),
      }),
    );
    verifier.setClaims(
      "same-profile",
      validClaims({
        nonce: "nonce_3123456789abcdef",
        sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000005"),
      }),
    );
    const profileState = new FakeProfileStateClient();
    const runtime = new BrowserRuntime({
      launcher,
      profileStateClient: profileState,
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: verifier,
    });

    await runtime.attach("first-fresh", new FakeSink());
    await runtime.attach("second-fresh", new FakeSink());
    await runtime.attach("profile", new FakeSink());
    await runtime.attach("same-profile", new FakeSink());

    expect(launcher.requests.map((request) => request.partitionKey)).toEqual([
      "session:bsn_00000000-0000-4000-8000-000000000002",
      "session:bsn_00000000-0000-4000-8000-000000000003",
      "profile:bpr_00000000-0000-4000-8000-000000000001",
    ]);
    expect(runtime.health()).toMatchObject({ profileHostCount: 3, sessionCount: 4 });
    // The one profile host loaded once; neither fresh host went near the vault.
    expect(profileState.loads).toBe(1);

    await runtime.shutdown();
    expect(profileState.commits).toHaveLength(1);
  });

  it("serves state.export from the host browser for either identity", async () => {
    const launcher = new FakeIsolatingLauncher();
    const verifier = new FakeTicketVerifier(freshClaims());
    verifier.setClaims(
      "profile",
      validClaims({
        nonce: "nonce_2123456789abcdef",
        sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000003"),
      }),
    );
    const runtime = new BrowserRuntime({
      launcher,
      profileStateClient: new FakeProfileStateClient(),
      runtimeId: "runtime_test",
      sessionFilesRoot: testSessionFilesRoot(),
      ticketVerifier: verifier,
    });

    const freshSink = new FakeSink();
    const fresh = await runtime.attach("fresh-ticket", freshSink);
    const freshBrowser = launcher.browsersByPartition.get(
      "session:bsn_00000000-0000-4000-8000-000000000002",
    );
    if (!freshBrowser) throw new Error("Expected a fresh host browser.");
    freshBrowser.snapshot = {
      cookies: [],
      origins: [{ localStorage: [{ name: "seen", value: "yes" }], origin: "https://fresh.test/" }],
    };
    await fresh.handle(JSON.stringify({ type: "state.export" }));
    expect(freshSink.messages.filter((message) => message.type === "state.exported")).toEqual([
      { snapshot: freshBrowser.snapshot, type: "state.exported" },
    ]);

    const profileSink = new FakeSink();
    const profile = await runtime.attach("profile", profileSink);
    await profile.handle(JSON.stringify({ type: "state.export" }));
    expect(profileSink.messages.filter((message) => message.type === "state.exported")).toEqual([
      {
        snapshot: launcher.browsersByPartition.get(
          "profile:bpr_00000000-0000-4000-8000-000000000001",
        )?.snapshot,
        type: "state.exported",
      },
    ]);

    await runtime.shutdown();
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
      profileStateClient: forbiddenProfileState,
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
      profileStateClient: forbiddenProfileState,
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
