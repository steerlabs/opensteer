import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HarnessAuthenticationEnvelope } from "@opensteer/client/host";
import {
  HarnessAuthenticationBody,
  harnessAuthenticationEnsureDue,
  harnessAuthenticationEnsureIntervalMs,
  harnessAuthenticationSettled,
  nextHarnessAuthenticationSession,
  releaseHarnessAuthentication,
  startHarnessAuthentication,
  type HarnessAuthenticationClient,
  type HarnessAuthenticationSession,
  type HarnessAuthenticationView,
} from "./harness-authentication-dialog.js";

function envelope(
  environmentStatus: HarnessAuthenticationEnvelope["environmentStatus"],
  authentication: HarnessAuthenticationEnvelope["authentication"],
): HarnessAuthenticationEnvelope {
  return { authentication, environmentStatus };
}

function pending(userCode: string): HarnessAuthenticationEnvelope {
  return envelope("connected", {
    challenge: { kind: "device-code", userCode, verificationUrl: "https://chatgpt.com/device" },
    status: "pending",
  });
}

function fold(...envelopes: readonly HarnessAuthenticationEnvelope[]) {
  let session: HarnessAuthenticationSession | null = null;
  for (const next of envelopes) session = nextHarnessAuthenticationSession(session, next);
  return session as HarnessAuthenticationSession;
}

function render(view: HarnessAuthenticationView | null, error: string | null = null): string {
  return renderToStaticMarkup(<HarnessAuthenticationBody error={error} view={view} />);
}

describe("harness authentication state matrix", () => {
  it("reports a disconnected Runner as requiring the person", () => {
    expect(fold(envelope("disconnected", { status: "not-started" })).view).toEqual({
      kind: "disconnected",
    });
  });

  it("treats connected-but-not-started as the Host about to start the flow", () => {
    expect(fold(envelope("connected", { status: "not-started" })).view).toEqual({
      kind: "starting",
    });
  });

  it("surfaces the device code, the outcome, and the failure detail", () => {
    expect(fold(pending("ABCD-1234")).view).toEqual({
      codeReplaced: false,
      inputKind: "code",
      kind: "pending",
      userCode: "ABCD-1234",
      verificationUrl: "https://chatgpt.com/device",
    });
    expect(fold(envelope("connected", { status: "ready" })).view).toEqual({ kind: "ready" });
    expect(fold(envelope("connected", { detail: "denied", status: "failed" })).view).toEqual({
      detail: "denied",
      kind: "failed",
    });
  });

  it("lets a durable sign-in outcome outrank a stale environment status", () => {
    expect(fold(envelope("disconnected", { status: "ready" })).view).toEqual({ kind: "ready" });
  });

  it("polls every state that is still moving and stops on the ones that need a person", () => {
    const moving: HarnessAuthenticationView[] = [
      { kind: "starting" },
      { codeReplaced: false, kind: "pending", userCode: "A", verificationUrl: "https://x" },
    ];
    const settled: HarnessAuthenticationView[] = [
      { kind: "ready" },
      { detail: "denied", kind: "failed" },
      { kind: "disconnected" },
    ];
    for (const view of moving) expect(harnessAuthenticationSettled(view)).toBe(false);
    for (const view of settled) expect(harnessAuthenticationSettled(view)).toBe(true);
  });
});

describe("device code replacement", () => {
  it("flags a replacement code even across a not-started dip", () => {
    const direct = fold(pending("ABCD-1234"), pending("WXYZ-9876"));
    expect(direct.view).toMatchObject({ codeReplaced: true, userCode: "WXYZ-9876" });

    const viaRestart = fold(
      pending("ABCD-1234"),
      envelope("connected", { status: "not-started" }),
      pending("WXYZ-9876"),
    );
    expect(viaRestart.view).toMatchObject({ codeReplaced: true, userCode: "WXYZ-9876" });
  });

  it("keeps the replacement notice up while the new code is still on screen", () => {
    const session = fold(pending("ABCD-1234"), pending("WXYZ-9876"), pending("WXYZ-9876"));
    expect(session.view).toMatchObject({ codeReplaced: true });
  });

  it("does not flag the first code, nor a code that never changed", () => {
    expect(fold(pending("ABCD-1234")).view).toMatchObject({ codeReplaced: false });
    expect(fold(pending("ABCD-1234"), pending("ABCD-1234")).view).toMatchObject({
      codeReplaced: false,
    });
  });
});

describe("ensure throttle", () => {
  it("re-issues the idempotent ensure at most once every five seconds while not started", () => {
    const view: HarnessAuthenticationView = { kind: "starting" };
    expect(harnessAuthenticationEnsureDue(view, 1_000, 1_000)).toBe(false);
    expect(harnessAuthenticationEnsureDue(view, 1_000, 1_000 + 4_999)).toBe(false);
    expect(
      harnessAuthenticationEnsureDue(view, 1_000, 1_000 + harnessAuthenticationEnsureIntervalMs),
    ).toBe(true);
  });

  it("never re-ensures from any other state", () => {
    const others: HarnessAuthenticationView[] = [
      { codeReplaced: false, kind: "pending", userCode: "A", verificationUrl: "https://x" },
      { kind: "disconnected" },
      { kind: "ready" },
    ];
    for (const view of others) {
      expect(harnessAuthenticationEnsureDue(view, 0, 60_000)).toBe(false);
    }
  });
});

describe("startHarnessAuthentication", () => {
  it("re-ensures a connected work location whose flow has not started, once per interval", async () => {
    const starting = envelope("connected", { status: "not-started" });
    // One ensure, then reads at 1.5 / 3 / 4.5 / 6 s; only the last crosses 5 s.
    const harness = runHarness([starting, starting, starting, starting, starting, starting]);

    await harness.settle();

    expect(harness.get).toHaveBeenCalledTimes(4);
    expect(harness.begin).toHaveBeenCalledTimes(2);
  });

  it("refreshes the Host snapshot exactly once when the sign-in lands", async () => {
    const harness = runHarness([
      envelope("connected", { status: "not-started" }),
      envelope("connected", { status: "ready" }),
    ]);

    await harness.settle();

    expect(harness.refresh).toHaveBeenCalledTimes(1);
    expect(harness.ready).toHaveBeenCalledTimes(1);
    expect(harness.get).toHaveBeenCalledTimes(1);
  });

  it("reports a transport failure instead of polling into it forever", async () => {
    const starting = envelope("connected", { status: "not-started" });
    const harness = runHarness([starting, starting], { getError: new Error("Host unreachable") });

    await harness.settle();

    expect(harness.error).toHaveBeenCalledWith(expect.stringContaining("Host unreachable"));
  });

  it("goes quiet after stop, so a closed dialog stops touching the Host", async () => {
    const harness = runHarness([
      envelope("connected", { status: "not-started" }),
      envelope("connected", { status: "not-started" }),
      envelope("connected", { status: "not-started" }),
    ]);

    await harness.tick();
    harness.run.stop();
    await harness.settle();

    expect(harness.get).toHaveBeenCalledTimes(1);
  });
});

describe("releaseHarnessAuthentication", () => {
  it("holds the cancel until the ensure that was in flight at close has landed", async () => {
    const attempt = deferredEnsure({ sleep: () => new Promise<void>(() => undefined) });

    // The person closes the dialog while the ensure POST is still on the wire.
    const released = releaseHarnessAuthentication({
      client: attempt.client,
      environmentId: "environment_1",
      harnessInstanceId: "harnessInstance_1",
      run: attempt.run,
    });
    await attempt.flush();
    expect(attempt.calls).toEqual(["ensure:sent"]);

    attempt.settleEnsure();
    await released;

    expect(attempt.calls).toEqual(["ensure:sent", "ensure:landed", "cancel"]);
  });

  it("stops re-ensuring the moment the dialog closes, so the cancel is the last word", async () => {
    const attempt = deferredEnsure({ sleep: () => new Promise<void>(() => undefined) });

    const released = releaseHarnessAuthentication({
      client: attempt.client,
      environmentId: "environment_1",
      harnessInstanceId: "harnessInstance_1",
      run: attempt.run,
    });
    attempt.settleEnsure();
    await released;
    await attempt.flush();

    expect(attempt.begin).toHaveBeenCalledTimes(1);
    expect(attempt.get).not.toHaveBeenCalled();
  });

  it("cancels anyway once the wait bound elapses, so closing never hangs on a stuck POST", async () => {
    // The bound is the injected sleep; it fires while the ensure never settles.
    const attempt = deferredEnsure({ sleep: async () => undefined });

    await releaseHarnessAuthentication({
      client: attempt.client,
      environmentId: "environment_1",
      harnessInstanceId: "harnessInstance_1",
      run: attempt.run,
    });

    expect(attempt.calls).toEqual(["ensure:sent", "cancel"]);
  });

  it("cancels straight away when no attempt was ever started", async () => {
    const attempt = deferredEnsure({ sleep: () => new Promise<void>(() => undefined) });

    await releaseHarnessAuthentication({
      client: attempt.client,
      environmentId: "environment_1",
      harnessInstanceId: "harnessInstance_1",
      run: null,
    });

    expect(attempt.calls).toEqual(["ensure:sent", "cancel"]);
  });
});

describe("HarnessAuthenticationBody", () => {
  it("renders secret setup as a password field without browser or code instructions", () => {
    const html = render({
      codeReplaced: false,
      inputKind: "secret",
      inputPrompt: "OpenRouter API key",
      kind: "pending",
      userCode: "",
    });
    expect(html).toContain('type="password"');
    expect(html).toContain("OpenRouter API key");
    expect(html).toContain("Save credential");
    expect(html).not.toContain("one-time code");
    expect(html).not.toContain("Continue in browser");
  });
});

/**
 * Starts one attempt whose ensure POST hangs until the test lets it land, and
 * records the order the Host sees requests in. That order is the behavior under
 * test: a cancel that overtakes an in-flight ensure is undone by it.
 */
function deferredEnsure({ sleep }: { readonly sleep: (ms: number) => Promise<void> }) {
  const calls: string[] = [];
  let land: (() => void) | null = null;

  const begin = vi.fn(
    () =>
      new Promise<HarnessAuthenticationEnvelope>((resolve) => {
        calls.push("ensure:sent");
        land = () => {
          calls.push("ensure:landed");
          resolve(envelope("connected", { status: "not-started" }));
        };
      }),
  );
  const get = vi.fn(async () => ({
    data: envelope("connected", { status: "not-started" }),
    ok: true as const,
  }));
  const cancel = vi.fn(async () => {
    calls.push("cancel");
    return envelope("connected", { status: "not-started" });
  });
  const client: HarnessAuthenticationClient = {
    dispatch: async (command) => {
      if (command.type === "harness.authentication.begin") {
        return { ...(await begin()), type: command.type };
      }
      if (command.type === "harness.authentication.cancel") {
        return { ...(await cancel()), type: command.type };
      }
      throw new Error(`Unexpected command ${command.type}`);
    },
    refresh: vi.fn(async () => undefined),
    rpc: { "harness.authentication.get": get },
  };

  const run = startHarnessAuthentication({
    client,
    environmentId: "environment_1",
    harnessInstanceId: "harnessInstance_1",
    methodId: "device-code",
    now: () => 0,
    onError: vi.fn(),
    onReady: vi.fn(),
    onSession: vi.fn(),
    sleep,
  });

  return {
    begin,
    calls,
    cancel,
    client,
    get,
    run,
    async flush() {
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    },
    settleEnsure() {
      if (land === null) throw new Error("the ensure POST was never sent");
      land();
    },
  };
}

/**
 * Drives the loop over a scripted response sequence: entries are handed out in
 * call order across the ensure POST and the read GET, and the clock only moves
 * when the loop sleeps, so the ensure interval is exercised without real time.
 */
function runHarness(
  script: readonly HarnessAuthenticationEnvelope[],
  options: { readonly getError?: Error } = {},
) {
  const queue = [...script];
  const sessions: HarnessAuthenticationSession[] = [];
  const waiters: Array<() => void> = [];
  let clock = 0;

  const take = () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("harness script exhausted");
    return next;
  };
  const begin = vi.fn(async () => take());
  const get = vi.fn(async () => {
    if (options.getError) throw options.getError;
    return { data: take(), ok: true as const };
  });
  const refresh = vi.fn(async () => undefined);
  const error = vi.fn();
  const ready = vi.fn();

  const run = startHarnessAuthentication({
    client: {
      dispatch: async (command) => {
        if (command.type === "harness.authentication.begin") {
          return { ...(await begin()), type: command.type };
        }
        throw new Error(`Unexpected command ${command.type}`);
      },
      refresh,
      rpc: { "harness.authentication.get": get },
    },
    environmentId: "environment_1",
    harnessInstanceId: "harnessInstance_1",
    methodId: "device-code",
    now: () => clock,
    onError: error,
    onReady: ready,
    onSession: (session) => sessions.push(session),
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        clock += ms;
        waiters.push(resolve);
      }),
  });

  const flush = async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  };
  const release = () => {
    for (const resolve of waiters.splice(0)) resolve();
  };
  const tick = async () => {
    await flush();
    release();
    await flush();
  };

  return {
    begin,
    error,
    get,
    ready,
    refresh,
    run,
    tick,
    views: () => sessions.map((session) => session.view),
    async settle() {
      for (let index = 0; index < script.length + 4; index += 1) {
        await flush();
        if (waiters.length === 0) return;
        // The script is the test's clock: once it is drained, the dialog closes.
        if (queue.length === 0) run.stop();
        release();
      }
      await flush();
    },
  };
}
