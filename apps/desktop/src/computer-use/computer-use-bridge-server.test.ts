import {
  MacOwnerSourceSchema,
  DisplayControlIdSchema,
  DisplayStreamIdSchema,
} from "@opensteer/protocol";
import type {
  ComputerUseHelperEvent,
  ComputerUseHelperMethod,
  ComputerUseSessionId,
} from "@opensteer/protocol";
import {
  allClosed,
  connectionRefused,
  holdHttpConnections,
  holdRefusedConnection,
  holdUpgradedConnection,
  observeClose,
  settleWithin,
  webSocketUpgradeRequest,
  writeTransportCloseReport,
} from "@opensteer/shared/test-support/httpServer";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  ComputerUseBridgeServer,
  ComputerUseSessionOwnership,
  type ComputerUseBridgeHelperPort,
} from "./computer-use-bridge-server.js";
import {
  ComputerUseHelperDeadlineFailure,
  ComputerUseHelperFailure,
  type ComputerUseHelperRequestOptions,
} from "./helper-client.js";

const sessionA = "cus_3f1a2b4c-5d6e-4f80-9a1b-2c3d4e5f6071" as ComputerUseSessionId;
const sessionB = "cus_4a2b3c5d-6e7f-4801-8b2c-3d4e5f607182" as ComputerUseSessionId;
const notes = {
  access: "read" as const,
  identity: { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null },
};
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("ComputerUseBridgeServer", () => {
  it.each(["display.control", "display.input"] as const)(
    "refuses %s before the helper when the connection did not opt in",
    async (method) => {
      const h = await bridgeHarness({ ownerInputVersion: 1 });
      const socket = await h.connect(h.token);
      const response = await socket.call(1, method, {
        streamId: "dsp_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        source: {
          kind: "owner-view",
          viewId: "cvw_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          generation: 1,
        },
        controlId: "dcl_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ...(method === "display.control"
          ? { action: "acquire", access: "read-write" }
          : { sequence: 0, geometry: 1, events: [{ kind: "copy" }] }),
      });
      expect(response).toMatchObject({ error: { code: "unsupported" } });
      expect(h.calls).toEqual([]);
    },
  );

  it.each([undefined, 1] as const)(
    "forwards owner input events only to opted-in video owners (%s)",
    async (offer) => {
      const h = await bridgeHarness({ ownerInputVersion: 1 });
      const socket = await h.connect(h.token, offer);
      const source = MacOwnerSourceSchema.parse({
        kind: "owner-view",
        viewId: "cvw_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        generation: 1,
      });
      const streamId = DisplayStreamIdSchema.parse("dsp_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      h.reply("view.open", () => ({
        viewId: source.viewId,
        generation: 1,
        state: "ready",
        captureTargetId: source.viewId,
      }));
      h.reply("display.start", () => ({ attachmentToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));
      await socket.call(1, "view.open", {
        viewId: source.viewId,
        generation: 1,
        leaseDurationMs: 30_000,
        target: { kind: "app", app: notes.identity },
      });
      await socket.call(2, "display.start", {
        streamId,
        target: { kind: "mac-window", bindingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        sources: [source],
        maxLongSide: 1280,
        maxFps: 30,
      });
      const event = {
        event: "display.owner-input" as const,
        params: {
          streamId,
          source,
          controlId: DisplayControlIdSchema.parse("dcl_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
          message: {
            type: "display.input.result" as const,
            sequence: 0,
            outcome: "refused" as const,
            reason: "unsupported" as const,
          },
        },
      };
      h.emit(event);
      await socket.call(3, "permissions.get", {});
      expect(socket.events).toEqual(offer === 1 ? [{ ...event, kind: "event" }] : []);
    },
  );

  it("does not let a late old stream start tear down a reconnect's reused ID", async () => {
    const h = await bridgeHarness();
    h.reply("view.open", (raw) => {
      const p = raw as { viewId: string; generation: number };
      return {
        viewId: p.viewId,
        generation: p.generation,
        state: "ready",
        captureTargetId: p.viewId,
      };
    });
    h.reply("display.start", () => ({ attachmentToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));
    const streamId = "dsp_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const view = (suffix: string) =>
      `cvw_${suffix.repeat(8)}-${suffix.repeat(4)}-4${suffix.repeat(3)}-8${suffix.repeat(3)}-${suffix.repeat(12)}`;
    const open = async (socket: Awaited<ReturnType<typeof h.connect>>, viewId: string) => {
      await socket.call(1, "view.open", {
        viewId,
        generation: 1,
        leaseDurationMs: 30_000,
        target: { kind: "app", app: notes.identity },
      });
    };
    const start = (viewId: string) => ({
      streamId,
      target: { kind: "mac-window", bindingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      sources: [{ kind: "owner-view", viewId, generation: 1 }],
      maxLongSide: 1280,
      maxFps: 30,
    });
    const a = await h.connect(h.token);
    await open(a, view("a"));
    const release = h.hold("display.start");
    void a.call(2, "display.start", start(view("a")));
    await vi.waitFor(() => expect(h.calls.filter(([m]) => m === "display.start")).toHaveLength(1));
    a.close();
    await vi.waitFor(() => expect(h.closedSockets()).toBe(1));
    const b = await h.connect(h.token);
    await open(b, view("b"));
    const next = b.call(2, "display.start", start(view("b")));
    await vi.waitFor(() => expect(h.calls.filter(([m]) => m === "display.start")).toHaveLength(2));
    const stops = h.calls.filter(([m]) => m === "display.stop").length;
    release();
    expect(await next).toMatchObject({
      result: { attachmentToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });
    expect(h.calls.filter(([m]) => m === "display.stop")).toHaveLength(stops);
  });

  it("fences duplicate native stream IDs across slots before they can receive another source's clipboard", async () => {
    const h = await bridgeHarness();
    const a = await h.connect(h.token);
    const second = await h.startBridge();
    const b = await second.connect(second.token);
    const firstView = "cvw_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const otherView = "cvw_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const streamId = "dsp_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    h.reply("view.open", (raw) => {
      const params = raw as { viewId: string; generation: number };
      return {
        viewId: params.viewId,
        generation: params.generation,
        state: "ready",
        captureTargetId: params.viewId,
      };
    });
    for (const [socket, viewId] of [
      [a, firstView],
      [b, otherView],
    ] as const)
      await socket.call(1, "view.open", {
        viewId,
        generation: 1,
        leaseDurationMs: 30_000,
        target: { kind: "app", app: notes.identity },
      });
    const source = (viewId: string) => ({ kind: "owner-view" as const, viewId, generation: 1 });
    const release = h.hold("display.start");
    h.reply("display.start", () => ({ attachmentToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));
    const start = (viewId: string) => ({
      streamId,
      target: { kind: "mac-window", bindingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      sources: [source(viewId)],
      maxLongSide: 1280,
      maxFps: 30,
    });
    const first = a.call(2, "display.start", start(firstView));
    await vi.waitFor(() =>
      expect(h.calls.filter(([method]) => method === "display.start")).toHaveLength(1),
    );
    const duplicate = b.call(2, "display.start", start(otherView));
    try {
      // A later response on this socket follows its synchronous stream admission.
      await b.call(3, "permissions.get", {});
      h.emit({
        event: "display.owner-input",
        params: {
          streamId: streamId as never,
          source: source(firstView),
          controlId: "dcl_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as never,
          message: {
            type: "display.clipboard",
            sequence: 0,
            outcome: "copied",
            text: "fixture-secret-selection",
          },
        },
      });
      await b.call(4, "permissions.get", {});
      expect(b.events).toEqual([]);
      expect(h.calls.filter(([method]) => method === "display.start")).toHaveLength(1);
    } finally {
      release();
      await Promise.all([first, duplicate]);
    }
    expect(await duplicate).toMatchObject({ error: { code: "busy" } });
  });

  it("forwards owner window inventories without acquiring a view lease", async () => {
    const harness = await bridgeHarness();
    const socket = await harness.connect(harness.token);
    harness.reply("view.windows", () => ({ windows: [] }));
    expect(await socket.call(1, "view.windows", { app: notes.identity })).toEqual({
      id: 1,
      kind: "response",
      result: { windows: [] },
    });
    expect(harness.calls).toEqual([["view.windows", { app: notes.identity }]]);
  });

  it("discovers without starting a helper and refuses authority on an ordinary slot", async () => {
    const harness = await bridgeHarness();
    const client = await harness.connect(harness.token);
    expect(await client.call(1, "passwords.capabilities", {})).toMatchObject({
      result: { authority: null, receiver: null },
    });
    expect(
      await client.call(2, "passwords.control", {
        type: "signin.probe",
        site: "https://example.com",
      }),
    ).toMatchObject({ result: { type: "unavailable" } });
    expect(harness.calls).toEqual([]);
  });

  it("refuses an upgrade with no token or the wrong one", async () => {
    const harness = await bridgeHarness();

    await expect(harness.connect(null)).rejects.toThrow(/401/u);
    await expect(harness.connect(`${harness.token}x`)).rejects.toThrow(/401/u);
  });

  it("takes one live connection per slot, and a reconnect once it has closed", async () => {
    const harness = await bridgeHarness();
    const first = await harness.connect(harness.token);

    // Somebody else holding the token while the Runner is connected is not
    // given a second socket onto the slot's sessions.
    await expect(harness.connect(harness.token)).rejects.toThrow(/409/u);

    first.close();
    await vi.waitFor(() => expect(harness.closedSockets()).toBe(1));
    await expect(harness.connect(harness.token)).resolves.toBeDefined();
  });

  it("forwards a request with what is left of its deadline and answers with the helper's result", async () => {
    const harness = await bridgeHarness();
    harness.reply("app.resolve", () => ({
      app: {
        allowed: true,
        identity: notes.identity,
        path: "/System/Applications/Notes.app",
        reason: null,
        risk: "standard",
        running: false,
      },
    }));
    const socket = await harness.connect(harness.token);

    const response = await socket.call(1, "app.resolve", { app: "Notes" }, 9_000);

    expect(response).toMatchObject({ id: 1, kind: "response" });
    expect(harness.calls).toContainEqual(["app.resolve", { app: "Notes" }]);
    // One instant, fixed as the frame arrived; installing and connecting
    // spend from it rather than starting a count of their own.
    expect(harness.options("app.resolve")?.deadline).toBe(harness.clock.at + 9_000);
  });

  it("holds a status probe to the deadline its frame arrived with", async () => {
    const harness = await bridgeHarness();
    const socket = await harness.connect(harness.token);

    await socket.call(1, "permissions.get", {}, 5_000);

    expect(harness.readinessOptions()).toEqual([{ deadline: harness.clock.at + 5_000 }]);
  });

  it("answers a status probe from the readiness path, which never installs the helper", async () => {
    const harness = await bridgeHarness();
    const socket = await harness.connect(harness.token);

    const response = await socket.call(1, "permissions.get", {}, 5_000);

    expect(response).toEqual({
      id: 1,
      kind: "response",
      result: { permissions: { accessibility: "denied", screenRecording: "denied" } },
    });
    expect(harness.readinessProbes()).toBe(1);
    expect(harness.calls).toHaveLength(0);
  });

  it.each([undefined, 1] as const)(
    "advertises only the helper's negotiated owner input version (%s)",
    async (ownerInputVersion) => {
      const harness = await bridgeHarness({ ownerInputVersion });
      const socket = await harness.connect(harness.token, 1);
      const response = await socket.call(1, "permissions.get", {}, 5_000);
      expect(response).toEqual({
        id: 1,
        kind: "response",
        result: {
          permissions: { accessibility: "denied", screenRecording: "denied" },
          ...(ownerInputVersion === 1 ? { ownerInputVersion: 1 } : {}),
        },
      });
      expect(harness.calls).toHaveLength(0);
    },
  );

  it.each([undefined, 2])("keeps baseline readiness for a Runner offering %s", async (offer) => {
    const harness = await bridgeHarness({ ownerInputVersion: 1 });
    const socket = await harness.connect(harness.token, offer);
    const response = await socket.call(1, "permissions.get", {}, 5_000);
    expect(response).toEqual({
      id: 1,
      kind: "response",
      result: {
        permissions: { accessibility: "denied", screenRecording: "denied" },
      },
    });
  });

  it("never forwards permissions.request from a Runner", async () => {
    const harness = await bridgeHarness();
    const socket = await harness.connect(harness.token);

    const response = await socket.call(2, "permissions.request", {});

    expect(response).toMatchObject({
      error: { code: "unsupported" },
      id: 2,
      kind: "response",
    });
    expect(harness.calls).toHaveLength(0);
  });

  it("takes the Runner's approval lists and outcomes itself, never to the helper", async () => {
    const harness = await bridgeHarness();
    const socket = await harness.connect(harness.token);

    const list = { approvalKeyId: null, approvals: [] };
    const outcome = {
      outcome: { kind: "declined" },
      setupRequestId: "7c1a2b4c-5d6e-4f80-9a1b-2c3d4e5f6071",
    };
    expect(await socket.call(4, "approvals.list", list)).toEqual({
      id: 4,
      kind: "response",
      result: {},
    });
    expect(await socket.call(5, "approvals.outcome", outcome)).toEqual({
      id: 5,
      kind: "response",
      result: {},
    });
    expect(harness.approvals.list).toHaveBeenCalledWith(list);
    expect(harness.approvals.outcome).toHaveBeenCalledWith(outcome);
    // Desktop main answers them; the helper holds no approvals.
    expect(harness.calls).toHaveLength(0);
    expect(socket.events).toEqual([]);
  });

  it("refuses an unreadable approval list without taking it", async () => {
    const harness = await bridgeHarness();
    const socket = await harness.connect(harness.token);

    const response = await socket.call(5, "approvals.list", { approvals: "nope" });

    expect(response).toMatchObject({ error: { code: "failed" }, id: 5, kind: "response" });
    expect(harness.approvals.list).not.toHaveBeenCalled();
  });

  it("sends the person's answer to the connected Runner, and says when none is connected", async () => {
    const harness = await bridgeHarness();
    const answer = {
      answer: {
        approval: {
          expiresAt: "2026-09-22T00:00:00.000Z",
          requestId: "7c1a2b4c-5d6e-4f80-9a1b-2c3d4e5f6071",
          signature: "s".repeat(86),
        },
        kind: "deny" as const,
      },
      setupRequestId: "7c1a2b4c-5d6e-4f80-9a1b-2c3d4e5f6071",
    };
    expect(harness.server.sendApprovalAnswer(answer, null)).toBe(false);
    const socket = await harness.connect(harness.token);
    expect(harness.server.sendApprovalAnswer(answer, null)).toBe(true);
    await vi.waitFor(() =>
      expect(socket.events).toEqual([
        { event: "approval.answer", kind: "event", params: answer, server: null },
      ]),
    );
  });

  it("answers a malformed request rather than forwarding it", async () => {
    const harness = await bridgeHarness();
    const socket = await harness.connect(harness.token);

    const response = await socket.call(3, "session.observe", { sessionId: "not-a-session" });

    expect(response).toMatchObject({ error: { code: "failed" }, id: 3 });
    expect(harness.calls).toHaveLength(0);
  });

  it("carries the helper's own refusal code back", async () => {
    const harness = await bridgeHarness();
    harness.fail("apps.installed", new ComputerUseHelperFailure("permission-required", "Nope."));
    const socket = await harness.connect(harness.token);

    await expect(socket.call(4, "apps.installed", {})).resolves.toMatchObject({
      error: { code: "permission-required", message: "Nope." },
    });
  });

  /**
   * The Host forwards an agent's call whatever the Mac's readiness says, so a
   * refused grant comes back through here: the one place on this Mac that
   * learns an agent needs it right now. The Runner still gets the refusal.
   */
  it("offers setup on this Mac when a Runner's app call finds a grant missing", async () => {
    const harness = await bridgeHarness();
    harness.fail(
      "data.invoke",
      new ComputerUseHelperFailure("permission-required", "Reading Messages needs it."),
    );
    const socket = await harness.connect(harness.token);

    await expect(
      socket.call(4, "data.invoke", dataInvoke("apple-messages", "read-write")),
    ).resolves.toMatchObject({ error: { code: "permission-required" } });
    expect(harness.permissionRequired.mock.calls).toEqual([
      [{ access: "read-write", definitionId: "apple-messages" }],
    ]);
  });

  it("offers nothing for other refusals, other methods, or apps the helper does not serve", async () => {
    const harness = await bridgeHarness();
    const socket = await harness.connect(harness.token);
    harness.fail("data.invoke", new ComputerUseHelperFailure("failed", "No."));
    await socket.call(4, "data.invoke", dataInvoke("apple-messages", "read"));
    harness.fail("data.invoke", new ComputerUseHelperFailure("permission-required", "No."));
    await socket.call(5, "data.invoke", dataInvoke("some-other-app", "read"));
    harness.fail("imessage.poll", new ComputerUseHelperFailure("permission-required", "No."));
    await socket.call(6, "imessage.poll", {
      accountId: "a",
      after: null,
      limit: 10,
      owner: "o",
    });
    expect(harness.permissionRequired).not.toHaveBeenCalled();
  });

  it("refuses a session another slot's Runner opened", async () => {
    const harness = await bridgeHarness();
    harness.reply("session.open", openAnswer);
    const otherSlot = await harness.startBridge();
    const first = await harness.connect(harness.token);
    const second = await otherSlot.connect(otherSlot.token);
    await first.call(1, "session.open", { sessionId: sessionA, threadTitle: null });

    const response = await second.call(2, "session.observe", {
      app: notes,
      includeScreenshot: true,
      window: "window-1",
      sessionId: sessionA,
    });

    expect(response).toMatchObject({ error: { code: "no-session" }, id: 2 });
    // The helper never heard about the second Runner's attempt.
    expect(harness.calls.filter(([method]) => method === "session.observe")).toHaveLength(0);
  });

  it("closes the sessions a dropped socket held", async () => {
    const harness = await bridgeHarness();
    harness.reply("session.open", openAnswer);
    const socket = await harness.connect(harness.token);
    await socket.call(1, "session.open", { sessionId: sessionA, threadTitle: null });

    socket.close();

    await vi.waitFor(() =>
      expect(harness.calls).toContainEqual(["session.close", { sessionId: sessionA }]),
    );
  });

  it("releases a close the helper refused, without dropping anybody's connection", async () => {
    const harness = await bridgeHarness();
    harness.reply("session.open", openAnswer);
    const otherSlot = await harness.startBridge();
    const first = await harness.connect(harness.token);
    const second = await otherSlot.connect(otherSlot.token);
    await first.call(1, "session.open", { sessionId: sessionA, threadTitle: null });
    await second.call(2, "session.open", { sessionId: sessionB, threadTitle: null });
    harness.fail("session.close", new ComputerUseHelperFailure("no-session", "Already closed."));

    await expect(first.call(3, "session.close", { sessionId: sessionA })).resolves.toMatchObject({
      error: { code: "no-session", message: "Already closed." },
    });

    // The other slot's session is untouched and still its own.
    expect(second.events).toEqual([]);
    harness.fail("session.close", null);
    await expect(
      second.call(4, "session.observe", {
        app: notes,
        includeScreenshot: true,
        window: "window-1",
        sessionId: sessionB,
      }),
    ).resolves.toMatchObject({ id: 4, kind: "response", result: {} });
    // The closed session's claim is gone, so the Run can open it again.
    await expect(
      first.call(5, "session.open", { sessionId: sessionA, threadTitle: null }),
    ).resolves.toMatchObject({ id: 5, result: { sessionId: sessionA } });
  });

  it("sends a close the helper did not confirm again, and gives the claim back", async () => {
    const harness = await bridgeHarness();
    harness.reply("session.open", openAnswer);
    const socket = await harness.connect(harness.token);
    await socket.call(1, "session.open", { sessionId: sessionA, threadTitle: null });
    harness.fail(
      "session.close",
      new ComputerUseHelperFailure("failed", "The Mac did not answer."),
    );
    await expect(socket.call(2, "session.close", { sessionId: sessionA })).resolves.toMatchObject({
      error: { code: "failed" },
    });
    harness.fail("session.close", null);
    const closes = () => harness.calls.filter(([method]) => method === "session.close").length;
    const tried = closes();

    // Nothing waits on the Host or the Runner: the bridge says it again.
    await vi.waitFor(() => expect(closes()).toBe(tried + 1), { timeout: 3_000 });
    // The claim went back at once, so it never keeps the helper connection up.
    await expect(
      socket.call(3, "session.open", { sessionId: sessionB, threadTitle: null }),
    ).resolves.toMatchObject({ id: 3, result: { sessionId: sessionB } });
  });

  it("sends no close again once the bridge has shut down", async () => {
    const harness = await bridgeHarness();
    harness.reply("session.open", openAnswer);
    const socket = await harness.connect(harness.token);
    await socket.call(1, "session.open", { sessionId: sessionA, threadTitle: null });
    harness.fail(
      "session.close",
      new ComputerUseHelperFailure("failed", "The Mac did not answer."),
    );
    // The close is still with the helper when the bridge shuts down, and
    // fails only afterwards.
    const release = harness.hold("session.close");
    void socket.call(2, "session.close", { sessionId: sessionA });
    const closes = () => harness.calls.filter(([method]) => method === "session.close").length;
    await vi.waitFor(() => expect(closes()).toBe(1));

    await harness.server.close();
    // Shutting down ends the Runner's socket, and its cleanup closes the
    // session it still held; nothing is sent once shutdown has finished.
    const closesAtShutdown = closes();
    release();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_500));

    expect(closes()).toBe(closesAtShutdown);
  });

  it("ends only the late request's session, across slots, and keeps both sockets", async () => {
    const harness = await bridgeHarness();
    harness.reply("session.open", openAnswer);
    const otherSlot = await harness.startBridge();
    const first = await harness.connect(harness.token);
    const second = await otherSlot.connect(otherSlot.token);
    await first.call(1, "session.open", { sessionId: sessionA, threadTitle: null });
    await second.call(2, "session.open", { sessionId: sessionB, threadTitle: null });
    // The helper client's verdict that no answer is coming for this one act.
    harness.fail("session.act", new ComputerUseHelperDeadlineFailure("session.act"));

    const late = await first.call(3, "session.act", {
      actions: [{ text: "Hello", type: "type" }],
      app: { ...notes, access: "read-write" },
      snapshot: "obs-1",
      window: "window-1",
      sessionId: sessionA,
    });

    expect(late).toMatchObject({ error: { code: "outcome-unknown" }, id: 3 });
    await vi.waitFor(() =>
      expect(harness.calls).toContainEqual(["session.close", { sessionId: sessionA }]),
    );
    // The Runner that asked hears its session ended, after the answer.
    await vi.waitFor(() =>
      expect(first.events).toEqual([
        {
          event: "session.stopped",
          kind: "event",
          params: { reason: "app-quit", sessionId: sessionA },
        },
      ]),
    );
    // The other slot's Run never notices.
    expect(second.events).toEqual([]);
    expect(harness.calls).not.toContainEqual(["session.close", { sessionId: sessionB }]);
    await expect(
      second.call(4, "session.observe", {
        app: notes,
        includeScreenshot: true,
        window: "window-1",
        sessionId: sessionB,
      }),
    ).resolves.toMatchObject({ id: 4, result: {} });
    expect(harness.closedSockets()).toBe(0);
  });

  it("stops waiting at the deadline and grace even when the helper never answers", async () => {
    const harness = await bridgeHarness({ graceMs: 20 });
    harness.reply("session.open", openAnswer);
    const socket = await harness.connect(harness.token);
    await socket.call(1, "session.open", { sessionId: sessionA, threadTitle: null });
    harness.hold("session.observe");

    const late = await socket.call(
      2,
      "session.observe",
      { app: notes, includeScreenshot: true, window: "window-1", sessionId: sessionA },
      30,
    );

    expect(late).toEqual({
      error: { code: "failed", message: "The Mac did not answer in time." },
      id: 2,
      kind: "response",
    });
    await vi.waitFor(() =>
      expect(harness.calls).toContainEqual(["session.close", { sessionId: sessionA }]),
    );
  });

  it("abandons a late read on its own, ending no session", async () => {
    const harness = await bridgeHarness({ graceMs: 20 });
    harness.reply("session.open", openAnswer);
    const socket = await harness.connect(harness.token);
    await socket.call(1, "session.open", { sessionId: sessionA, threadTitle: null });
    harness.hold("apps.installed");

    const late = await socket.call(2, "apps.installed", {}, 30);

    expect(late).toMatchObject({ error: { code: "failed" }, id: 2 });
    expect(harness.calls.filter(([method]) => method === "session.close")).toHaveLength(0);
    expect(socket.events).toEqual([]);
  });

  it("keeps a live session when a repeated open of it is refused", async () => {
    const harness = await bridgeHarness();
    harness.reply("session.open", openAnswer);
    const otherSlot = await harness.startBridge();
    const first = await harness.connect(harness.token);
    const second = await otherSlot.connect(otherSlot.token);
    await first.call(1, "session.open", { sessionId: sessionA, threadTitle: null });
    harness.fail("session.open", new ComputerUseHelperFailure("failed", "Try again."));

    await expect(
      first.call(2, "session.open", { sessionId: sessionA, threadTitle: "Renamed" }),
    ).resolves.toMatchObject({ error: { code: "failed" } });

    // Only an open that created the claim may give it back.
    await expect(
      second.call(3, "session.observe", {
        app: notes,
        includeScreenshot: true,
        window: "window-1",
        sessionId: sessionA,
      }),
    ).resolves.toMatchObject({ error: { code: "no-session" }, id: 3 });
  });

  it("announces every bridge session when the shared helper connection is lost", async () => {
    const harness = await bridgeHarness();
    harness.reply("session.open", openAnswer);
    const otherSlot = await harness.startBridge();
    const first = await harness.connect(harness.token);
    const second = await otherSlot.connect(otherSlot.token);
    await first.call(1, "session.open", { sessionId: sessionA, threadTitle: null });
    await second.call(2, "session.open", { sessionId: sessionB, threadTitle: null });

    harness.loseHelper();

    await vi.waitFor(() =>
      expect(second.events).toContainEqual({
        event: "session.stopped",
        kind: "event",
        params: { reason: "app-quit", sessionId: sessionB },
      }),
    );
    expect(first.events).toContainEqual({
      event: "session.stopped",
      kind: "event",
      params: { reason: "app-quit", sessionId: sessionA },
    });
  });

  it("forwards only the events of sessions this socket opened", async () => {
    const harness = await bridgeHarness();
    harness.reply("session.open", openAnswer);
    const otherSlot = await harness.startBridge();
    const first = await harness.connect(harness.token);
    const second = await otherSlot.connect(otherSlot.token);
    await first.call(1, "session.open", { sessionId: sessionA, threadTitle: null });

    harness.emit({ event: "session.stopped", params: { reason: "user", sessionId: sessionA } });
    harness.emit({ event: "session.stopped", params: { reason: "user", sessionId: sessionB } });

    await vi.waitFor(() => expect(first.events).toHaveLength(1));
    expect(first.events[0]).toMatchObject({
      event: "session.stopped",
      kind: "event",
      params: { sessionId: sessionA },
    });
    expect(second.events).toHaveLength(0);
  });

  it("closes a session whose Runner left while the open was in flight", async () => {
    const harness = await bridgeHarness();
    harness.reply("session.open", openAnswer);
    const release = harness.hold("session.open");
    const socket = await harness.connect(harness.token);

    // The open is in flight when the Runner's socket dies.
    void socket.call(1, "session.open", { sessionId: sessionA, threadTitle: null });
    await vi.waitFor(() =>
      expect(harness.calls.some(([method]) => method === "session.open")).toBe(true),
    );
    socket.close();
    await vi.waitFor(() => expect(harness.closedSockets()).toBe(1));
    // Nothing is closed yet: the helper has not opened it.
    expect(harness.calls.filter(([method]) => method === "session.close")).toHaveLength(0);

    release();

    // The answer arrives for a dead socket, so the Mac gets its session back
    // instead of staying busy for a Run nobody can reach.
    await vi.waitFor(() =>
      expect(harness.calls).toContainEqual(["session.close", { sessionId: sessionA }]),
    );
  });

  it("refuses a second Runner opening the same session while the first is in flight", async () => {
    const harness = await bridgeHarness();
    harness.reply("session.open", openAnswer);
    const release = harness.hold("session.open");
    const otherSlot = await harness.startBridge();
    const first = await harness.connect(harness.token);
    const second = await otherSlot.connect(otherSlot.token);

    const firstOpen = first.call(1, "session.open", { sessionId: sessionA, threadTitle: null });
    await vi.waitFor(() =>
      expect(harness.calls.filter(([method]) => method === "session.open")).toHaveLength(1),
    );
    // The reservation is already held, so the second Runner is refused here
    // rather than both believing they hold the Mac.
    const refused = await second.call(2, "session.open", {
      sessionId: sessionA,
      threadTitle: null,
    });

    expect(refused).toMatchObject({ error: { code: "no-session" }, id: 2 });
    expect(harness.calls.filter(([method]) => method === "session.open")).toHaveLength(1);

    release();
    await expect(firstOpen).resolves.toMatchObject({ id: 1, kind: "response" });
  });

  it("gives the reservation back when the helper refuses the open that made it", async () => {
    const harness = await bridgeHarness();
    harness.fail(
      "session.open",
      new ComputerUseHelperFailure("permission-required", "Turn on macOS Screen Recording."),
    );
    const otherSlot = await harness.startBridge();
    const first = await harness.connect(harness.token);
    const second = await otherSlot.connect(otherSlot.token);

    await expect(
      first.call(1, "session.open", { sessionId: sessionA, threadTitle: null }),
    ).resolves.toMatchObject({ error: { code: "permission-required" } });

    // A refused open reserved nothing, so the next Runner is not told the
    // session belongs to somebody else.
    const retried = await second.call(2, "session.open", {
      sessionId: sessionA,
      threadTitle: null,
    });
    expect(retried).toMatchObject({ error: { code: "permission-required" }, id: 2 });
  });
});

/*
 * Ways a stopping bridge can keep the desktop app from quitting, or quit
 * without cleaning up:
 * - a Runner that never answers a WebSocket close keeps the close waiting;
 * - an idle, half-sent or never-used connection keeps it waiting too;
 * - ending the Runner's socket skips its cleanup, so its sessions stay open
 *   on the Mac's helper with nobody to close them;
 * - a connected Runner is cut off without being told the bridge is stopping;
 * - a refused upgrade is answered and left for its peer to end, and a peer
 *   that never does keeps the close waiting;
 * - a close while the bridge is starting leaves it listening.
 */
describe("ComputerUseBridgeServer shutdown", () => {
  const cases: Record<string, unknown>[] = [];

  afterAll(async () => {
    await writeTransportCloseReport("computer-use-bridge", cases);
  });

  it("ends a Runner that never answers at once, and still closes its sessions on the helper", async () => {
    const harness = await bridgeHarness();
    harness.reply("session.open", openAnswer);
    const port = Number(harness.server.url.port);
    const runner = await holdUpgradedConnection(port, harness.server.url.pathname, {
      authorization: `Bearer ${harness.token}`,
    });
    runner.sendText(
      JSON.stringify({
        id: 1,
        kind: "request",
        method: "session.open",
        params: { sessionId: sessionA, threadTitle: null },
      }),
    );
    await vi.waitFor(() => expect(runner.received.length).toBeGreaterThan(0));
    const held = await holdHttpConnections(port);

    const closed = await observeClose(harness.server.close());
    const connections = [runner, ...held];
    const everyConnectionClosed = await allClosed(connections);
    const listenerRefused = await connectionRefused(port);
    const sessionClosed = harness.calls.some(
      ([method, params]) =>
        method === "session.close" &&
        (params as { readonly sessionId?: unknown }).sessionId === sessionA,
    );
    cases.push({
      name: "a silent Runner is ended at once and its session closed on the helper",
      close: closed,
      connections: connections.map((connection) => connection.report()),
      helperCalls: harness.calls.map(([method]) => method),
      sessionClosedOnHelper: sessionClosed,
      approvalsToldDisconnected: harness.approvals.disconnected.mock.calls.length,
      listenerRefused,
    });

    expect(closed.settled).toBe("closed");
    expect(everyConnectionClosed).toBe(true);
    expect(sessionClosed).toBe(true);
    expect(harness.approvals.disconnected).toHaveBeenCalledTimes(1);
    expect(listenerRefused).toBe(true);
  }, 30_000);

  it("tells a connected Runner that the bridge is stopping as it ends the socket", async () => {
    const harness = await bridgeHarness();
    const runner = new WebSocket(harness.server.url, {
      headers: { authorization: `Bearer ${harness.token}` },
    });
    await new Promise((resolvePromise) => runner.once("open", resolvePromise));
    const ended = new Promise<{ code: number; reason: string }>((resolvePromise) =>
      runner.once("close", (code, reason) => resolvePromise({ code, reason: reason.toString() })),
    );

    const closed = await observeClose(harness.server.close());
    const runnerClose = await ended;
    cases.push({ name: "a connected Runner is told why", close: closed, runnerClose });

    expect(closed.settled).toBe("closed");
    expect(runnerClose).toEqual({ code: 1001, reason: "stopping" });
  }, 30_000);

  it("refuses an upgrade it will not serve without waiting on the peer that sent it", async () => {
    const harness = await bridgeHarness();
    const port = Number(harness.server.url.port);
    const path = harness.server.url.pathname;
    const token = { authorization: `Bearer ${harness.token}` };
    const refused = [
      {
        name: "unknown path",
        ...(await holdRefusedConnection(port, webSocketUpgradeRequest(port, "/v1/other", token))),
      },
      {
        name: "no token",
        ...(await holdRefusedConnection(port, webSocketUpgradeRequest(port, path))),
      },
      {
        name: "malformed handshake",
        ...(await holdRefusedConnection(
          port,
          webSocketUpgradeRequest(port, path, token, { key: false }),
        )),
      },
    ];
    try {
      const closed = await observeClose(harness.server.close());
      const peersStillHolding = refused.every(({ connection }) => !connection.isClosed());
      cases.push({
        name: "refused upgrades whose peers never end the connection",
        refusals: refused.map(({ connection, name, status }) => ({
          name,
          status,
          ...connection.report(),
        })),
        close: closed,
        peersStillHolding,
      });

      expect(refused.map(({ status }) => status)).toEqual([
        "HTTP/1.1 404 Not Found",
        "HTTP/1.1 401 Unauthorized",
        "HTTP/1.1 400 Bad Request",
      ]);
      expect(closed.settled).toBe("closed");
      expect(peersStillHolding).toBe(true);
    } finally {
      for (const { connection } of refused) connection.destroy();
    }
  }, 30_000);

  it("stops listening when it is closed while still starting", async () => {
    const harness = await bridgeHarness();
    const server = harness.createBridge();
    const starting = settleWithin(server.start());
    const closing = observeClose(server.close());
    const [started, observed] = await Promise.all([starting, closing]);
    const listenerRefused =
      started.settled !== "fulfilled" || (await connectionRefused(Number(started.value.port)));
    cases.push({
      name: "close during startup",
      started: started.settled === "fulfilled" ? started.value.href : started,
      close: observed,
      listenerRefused,
    });

    expect(started.settled).not.toBe("still waiting");
    expect(observed.settled).toBe("closed");
    expect(listenerRefused).toBe(true);
  }, 30_000);
});

function dataInvoke(definitionId: string, access: "read" | "read-write"): unknown {
  return {
    access,
    arguments: {},
    contract: "c".repeat(43),
    definitionId,
    effect: "read",
    operation: "list_conversations",
  };
}

function openAnswer(params: unknown): unknown {
  return { sessionId: (params as { readonly sessionId: unknown }).sessionId };
}

async function bridgeHarness(
  options: { readonly graceMs?: number; readonly ownerInputVersion?: 1 | undefined } = {},
) {
  const calls: [string, unknown][] = [];
  const requestOptions = new Map<string, ComputerUseHelperRequestOptions | undefined>();
  const handlers = new Map<string, (params: unknown) => unknown>();
  const failures = new Map<string, unknown>();
  /** Methods held open until the test releases them, to drive the races. */
  const gates = new Map<string, { release: () => void; waiting: Promise<void> }>();
  const eventListeners = new Set<(event: ComputerUseHelperEvent) => void>();
  const disconnectListeners = new Set<() => void>();
  let readinessProbes = 0;
  const readinessOptions: ComputerUseHelperRequestOptions[] = [];
  // Desktop main's clock, still unless a test moves it, so deadlines are exact.
  const clock = { at: 1_000 };
  const approvals = {
    disconnected: vi.fn(),
    list: vi.fn(),
    outcome: vi.fn(),
    proveKeyChallenge: vi.fn(async (challenge: { challengeId: string }) => ({
      challengeId: challenge.challengeId,
      signature: "s".repeat(86),
    })),
  };
  const helper: ComputerUseBridgeHelperPort = {
    ...(options.ownerInputVersion === 1 ? { ownerInputVersion: () => 1 as const } : {}),
    onDisconnect: (listener) => {
      disconnectListeners.add(listener);
      return () => disconnectListeners.delete(listener);
    },
    onEvent: (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    readinessDataGrants: async (options) => {
      readinessProbes += 1;
      readinessOptions.push(options);
      return {
        automation: "unknown",
        calendars: "requestable",
        contacts: "granted",
        "full-disk-access": "denied",
        reminders: "denied",
      };
    },
    readinessPermissions: async (options) => {
      readinessProbes += 1;
      readinessOptions.push(options);
      return { accessibility: "denied", screenRecording: "denied" };
    },
    request: async (method: ComputerUseHelperMethod, params: unknown, options) => {
      calls.push([method, params]);
      requestOptions.set(method, options);
      await gates.get(method)?.waiting;
      const failure = failures.get(method);
      if (failure) throw failure;
      return (handlers.get(method)?.(params) ?? {}) as never;
    },
  };
  const ownership = new ComputerUseSessionOwnership();
  const permissionRequired = vi.fn();
  const servers: ComputerUseBridgeServer[] = [];
  const clients: WebSocket[] = [];
  let closedSockets = 0;
  const createBridge = () => {
    const server = new ComputerUseBridgeServer({
      ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
      helper,
      now: () => clock.at,
      onDataPermissionRequired: permissionRequired,
      ownership,
      approvals,
    });
    servers.push(server);
    return server;
  };
  const startBridge = async () => {
    const server = createBridge();
    const url = await server.start();
    return { server, url };
  };
  const firstBridge = await startBridge();
  cleanups.push(async () => {
    for (const gate of gates.values()) gate.release();
    for (const client of clients) client.close();
    for (const server of servers.reverse()) await server.close();
  });
  const connect = async (url: URL, token: string | null, ownerInputVersion?: number) => {
    const socket = new WebSocket(url, {
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(ownerInputVersion === undefined
          ? {}
          : { "x-opensteer-mac-owner-input": String(ownerInputVersion) }),
      },
    });
    clients.push(socket);
    const events: unknown[] = [];
    const pending = new Map<number, (frame: unknown) => void>();
    socket.on("message", (data: Buffer) => {
      const frame: unknown = JSON.parse(data.toString("utf8"));
      const { id, kind } = frame as { id?: number; kind?: string };
      if (kind === "event") {
        events.push(frame);
        return;
      }
      if (typeof id === "number") pending.get(id)?.(frame);
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      socket.once("open", resolvePromise);
      socket.once("unexpected-response", (_request, response) =>
        rejectPromise(new Error(`upgrade refused: ${response.statusCode}`)),
      );
      socket.once("error", rejectPromise);
    });
    socket.once("close", () => {
      closedSockets += 1;
    });
    return {
      call: async (id: number, method: string, params: unknown, timeoutMs?: number) =>
        new Promise<unknown>((resolvePromise) => {
          pending.set(id, resolvePromise);
          socket.send(
            JSON.stringify({
              id,
              kind: "request",
              method,
              params,
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            }),
          );
        }),
      close: () => socket.close(),
      events,
    };
  };
  return {
    calls,
    closedSockets: () => closedSockets,
    connect: async (token: string | null, ownerInputVersion?: number) =>
      await connect(firstBridge.url, token, ownerInputVersion),
    /** A bridge on the same helper that has not started. */
    createBridge,
    emit: (event: ComputerUseHelperEvent) => {
      for (const listener of eventListeners) listener(event);
    },
    fail: (method: string, error: unknown) => {
      if (error === null) failures.delete(method);
      else failures.set(method, error);
    },
    /** Holds every later call to `method` until the returned function runs. */
    hold: (method: string) => {
      let release = (): void => undefined;
      const waiting = new Promise<void>((resolvePromise) => {
        release = resolvePromise;
      });
      gates.set(method, { release, waiting });
      return () => {
        gates.delete(method);
        release();
      };
    },
    /** The shared helper connection drops, as a transport failure would. */
    loseHelper: () => {
      for (const listener of Array.from(disconnectListeners)) listener();
    },
    clock,
    options: (method: string) => requestOptions.get(method),
    permissionRequired,
    readinessOptions: () => [...readinessOptions],
    readinessProbes: () => readinessProbes,
    reply: (method: string, handler: (params: unknown) => unknown) => handlers.set(method, handler),
    approvals,
    server: firstBridge.server,
    startBridge: async () => {
      const bridge = await startBridge();
      return {
        connect: async (token: string | null) => await connect(bridge.url, token),
        token: bridge.server.token,
      };
    },
    token: firstBridge.server.token,
  };
}
