import { DisplayStreams } from "@opensteer/client/integrations";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { on, once } from "node:events";
import { createConnection } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { createId, OpensteerError } from "@opensteer/core";
import type { RunnerAuxiliaryStream } from "@opensteer/orchestration";
import {
  decodeDisplayViewerFrame,
  decodeDisplayMediaFrame,
  encodeDisplayMediaFrame,
  mintComputerUseSessionId,
  DisplayStreamIdSchema,
  type DisplayStreamReason,
  RunnerAuxiliaryFrameFenceSchema,
  type HostIntegrationsOperation,
  type HostIntegrationsDisplayStart,
} from "@opensteer/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import WebSocket from "ws";
import { normalizeHostError } from "../server/http-errors.js";
import { RunnerAuthenticator } from "../agents/runner-authenticator.js";
import { ComputerAppHub } from "../computer-apps/computer-app-hub.js";
import { DisplayStreamHub } from "./display-stream-hub.js";
import { ComputerUseError } from "./computer-use-service.js";
import { registerComputerUseDisplayRoutes } from "./computer-use-display-routes.js";

// Failure cases: replay/expiry/fence loss, owner/login revocation, malformed media,
// demand races, missing keys, independent credits, stale control/input and teardown.
// Cache failures: missing initial key, stale generation/protected replay, partial GOP
// after overflow, changed bytes, credit overrun/replay loops, rollover during replay,
// and slow-viewer recovery replaying old frames instead of requesting a live key.
// Review failures: unordered control/media generations; drained static viewers;
// oversize keys; unbounded cache scans/frame counts/viewers; stuck control transitions;
// premature refresh; same-nonce fence mismatch and stale stream incarnations.
// Round 5 failures: decoder loss replays without state/tail metadata, stale queued
// deltas survive a reset, old acks credit a repeated sequence, request floods reset
// the encoder or replay repeatedly, replay pays live frame credit or stalls despite
// progress, and transient fence/transport loss is mistaken for terminal access loss.
// Live-display failures: late starting erases media/cache, data loss becomes terminal or
// flashes failed, outstanding motion suppresses later decoder resets, and timeout lies
// about connection loss. Early starting must still fence old media and clear replay.
// Real sockets exercise admission, framing and independent decoder credit; the
// integrations peer records the exact fenced commands a phone would receive.
// Socket synchronization failures: phone acks precede viewer delivery, and advancing
// the test clock before Host ack handling manufactures a stalled decoder.
const serverDataSockets = new Map<string, WebSocket>();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try {
    for (const close of cleanups.splice(0).reverse()) await close();
  } finally {
    serverDataSockets.clear();
    vi.useRealTimers();
  }
});

function collect(socket: WebSocket) {
  const frames: { bytes: Buffer; binary: boolean }[] = [];
  const closed = new Promise<number>((resolve) => socket.once("close", resolve));
  socket.on("message", (data, binary) =>
    frames.push({ bytes: Buffer.from(data as Buffer), binary }),
  );
  socket.on("error", () => undefined);
  return {
    socket,
    frames,
    closed,
    json: () => frames.filter((f) => !f.binary).map((f) => JSON.parse(f.bytes.toString())),
    media: () => frames.filter((f) => f.binary).map((f) => decodeDisplayViewerFrame(f.bytes)),
    send: (value: unknown) => socket.send(JSON.stringify(value)),
    received: async (check: () => boolean) => {
      const messages = on(socket, "message", {
        close: ["close"],
        signal: AbortSignal.timeout(3_000),
      });
      try {
        while (!check()) {
          if ((await messages.next()).done)
            throw new Error("Display socket closed before expected frames arrived");
        }
      } catch (cause) {
        throw new Error("Display socket did not deliver the expected frames", { cause });
      } finally {
        await messages.return?.();
      }
    },
    roundTrip: async () => {
      const pongs = on(socket, "pong", {
        close: ["close"],
        signal: AbortSignal.timeout(3_000),
      });
      try {
        // Host message handlers are synchronous after admission. A pong follows
        // their processing and all preceding Host writes on this same socket.
        socket.ping();
        if ((await pongs.next()).done)
          throw new Error("Display socket closed before the Host round trip completed");
      } catch (cause) {
        throw new Error("Display socket did not complete the Host round trip", { cause });
      } finally {
        await pongs.return?.();
      }
    },
  };
}
async function until(check: () => boolean) {
  const end = performance.now() + 3_000;
  while (!check()) {
    if (performance.now() > end) throw new Error("Display socket condition did not become true");
    await delay(5);
  }
}
async function fixture(
  supported = true,
  kind: {
    sharedInput?: boolean;
    editing?: boolean;
    displayCut?: boolean;
    mac?: boolean;
    macOwnerInput?: boolean;
    macHelperInput?: boolean;
  } = {},
) {
  const { editing = false, displayCut = false, mac = false, macOwnerInput = true } = kind;
  let macHelperInput = kind.macHelperInput ?? true;
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const normalized = normalizeHostError(error);
    return reply.status(normalized.status).send({ error: normalized.error });
  });
  await app.register(websocket);
  const owner = createId("user");
  const runnerId = createId("runner");
  const sessionId = mintComputerUseSessionId();
  const macSource = { kind: "owner-view" as const, viewId: `cvw_${randomUUID()}`, generation: 1 };
  const macTarget = {
    kind: "mac-window" as const,
    bindingId: randomUUID(),
    editingVersion: 1 as const,
  };
  let now = Date.now();
  let live = true;
  let authorized = true;
  let inputAuthorized = true;
  let signedIn = true;
  let loginExpiresAt = now + 60_000;
  let activities = 0;
  let authorizationGate: Promise<void> | undefined;
  let authorizationChecks = 0;
  let authorizationFailure: Error | undefined;
  const fence = RunnerAuxiliaryFrameFenceSchema.extend({ module: z.literal("integrations") }).parse(
    {
      auxiliaryStreamId: `rax_${randomUUID()}`,
      bootId: `rbt_${randomUUID()}`,
      connectionGeneration: 1,
      connectionId: `rcn_${randomUUID()}`,
      connectionLeaseId: `rls_${randomUUID()}`,
      module: "integrations",
      runnerId,
    },
  );
  const stream: RunnerAuxiliaryStream = {
    auxiliaryStreamId: fence.auxiliaryStreamId,
    fence,
    identity: {
      runnerId,
      modules: {
        integrations: {
          platform: mac ? "darwin" : "android",
          protocolVersion: mac ? 5 : 4,
          ...(!mac && kind.sharedInput !== false ? { sharedInput: 1 } : {}),
          ...(editing ? { editing: 1 } : {}),
          ...(displayCut ? { displayCut: 1 } : {}),
          ...(mac
            ? {
                computerUseVersion: 2,
                ownerViewVersion: 3,
                macWindowVideoVersion: 1,
                ...(macOwnerInput ? { macOwnerInputVersion: 2 } : {}),
              }
            : {}),
        },
      },
    } as unknown as RunnerAuxiliaryStream["identity"],
    streamLeaseExpiresAt: new Date(now + 120_000).toISOString(),
  };
  const sent: HostIntegrationsOperation[] = [];
  const peer = {
    id: "fake-phone",
    close: () => undefined,
    send: async (message: HostIntegrationsOperation) => {
      sent.push(message);
      if (mac && message.type === "host.integrations.display.resolve")
        queueMicrotask(() => {
          void apps.handleMessage(peer, stream, {
            ...fence,
            type: "runner.integrations.display.resolved",
            requestId: message.requestId,
            target:
              message.ownerInputVersion === 2 && macHelperInput
                ? macTarget
                : { kind: "mac-window", bindingId: macTarget.bindingId },
          });
        });
    },
  };
  const keys = generateKeyPairSync("ed25519");
  const authenticator = new RunnerAuthenticator({
    issuancePrivateKey: keys.privateKey,
    now: () => now,
    store: {} as never,
  });
  const apps = new ComputerAppHub({
    knownDefinitionIds: () => new Set(),
    onChanged: () => undefined,
    onRunnerDetached: (id, reason) => hub.forgetRunner(id, reason),
    onDisplayEvent: (id, event) => hub.handlePhoneEvent(id, event),
  });
  const service = {
    authorizeDisplay: async (id: typeof sessionId, actor: typeof owner) => {
      authorizationChecks += 1;
      await authorizationGate;
      if (authorizationFailure) throw authorizationFailure;
      if (id !== sessionId || !live || !authorized || actor !== owner)
        throw new OpensteerError({ code: "forbidden", message: "Display access ended" });
      return runnerId;
    },
    isDisplaySessionLive: (id: typeof sessionId, runner: typeof runnerId) =>
      live && id === sessionId && runner === runnerId,
    noteOwnerActivity: (id: typeof sessionId) => {
      if (!live || id !== sessionId) throw new Error("Session ended");
      activities += 1;
    },
  };
  const hub = new DisplayStreamHub({
    authenticator,
    computerApps: apps,
    computerUse: service,
    computerViews: {
      authorizeDisplay: async () => {
        if (mac && authorized) return runnerId;
        throw new Error("No owner lease in this task fixture");
      },
      authorizeInput: async () => {
        await authorizationGate;
        if (!mac || !inputAuthorized)
          throw new OpensteerError({ code: "forbidden", message: "Read-write approval required" });
        return runnerId;
      },
      isDisplayLive: () => mac && live && authorized,
      endDisplaySource: () => undefined,
    },
    now: () => now,
  });
  const serverViewers: WebSocket[] = [];
  const attachViewer = hub.attachViewer.bind(hub);
  vi.spyOn(hub, "attachViewer").mockImplementation((session, actor, socket, options) => {
    serverViewers.push(socket);
    return attachViewer(session, actor, socket, options);
  });
  const attachData = hub.attachDataSocket.bind(hub);
  vi.spyOn(hub, "attachDataSocket").mockImplementation((claims, socket) => {
    serverDataSockets.set(claims.streamId, socket);
    attachData(claims, socket);
  });
  apps.attach(peer, stream);
  await apps.handleMessage(peer, stream, {
    ...fence,
    type: "runner.integrations.status",
    apps: [],
    displayAvailable: supported,
    ...(mac ? { ownerViewVersion: 3 } : {}),
  });
  registerComputerUseDisplayRoutes(app, {
    hub,
    authenticator: {
      authenticateSession: async (headers: { authorization?: string }) => {
        if (!signedIn || !headers.authorization)
          throw new OpensteerError({ code: "unauthorized", message: "Login ended" });
        return {
          id: "login",
          user: { id: headers.authorization === "Bearer owner" ? owner : createId("user") },
          expiresAt: new Date(loginExpiresAt).toISOString(),
          absoluteExpiresAt: new Date(loginExpiresAt).toISOString(),
        };
      },
    } as never,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("No test listener");
  const base = `ws://127.0.0.1:${address.port}`;
  const sockets: WebSocket[] = [];
  async function connect(path: string, token: string) {
    const socket = new WebSocket(base + path, { headers: { Authorization: `Bearer ${token}` } });
    sockets.push(socket);
    const result = collect(socket);
    await once(socket, "open");
    return result;
  }
  const viewer = (editing = false, displayCut = false) =>
    connect(
      `/v1/computer-use/sessions/${sessionId}/display?sharedInput=1${editing ? "&editing=1" : ""}${displayCut ? "&displayCut=1" : ""}`,
      "owner",
    );
  const start = () =>
    sent.findLast(
      (f): f is HostIntegrationsDisplayStart => f.type === "host.integrations.display.start",
    )!;
  const phone = async () => {
    await until(() => Boolean(start()));
    return connect("/internal/v1/computer-use/display", start().dataTicket);
  };
  async function state(
    state: "starting" | "live" | "protected" | "screen-off" | "failed" | "stopped" = "live",
    generation = 1,
    reason?: DisplayStreamReason,
  ) {
    await apps.handleMessage(peer, stream, {
      ...fence,
      type: "runner.integrations.display.state",
      display: "main",
      streamId: start().streamId,
      state,
      generation,
      width: 360,
      height: 640,
      rotation: 0,
      ...(reason === undefined ? {} : { reason }),
    });
  }
  function frame(
    sequence: number,
    key = false,
    generation = 1,
    payload = new Uint8Array([0, 0, 0, 1, 101, 255]),
  ) {
    return encodeDisplayMediaFrame(
      {
        streamId: start().streamId,
        generation,
        sequence,
        ptsUs: sequence * 33_333,
        key,
        ...(key ? { codec: "avc1.42E01E" } : {}),
        width: 360,
        height: 640,
      },
      payload,
    );
  }
  cleanups.push(async () => {
    hub.close();
    for (const socket of sockets) socket.terminate();
    await app.close();
  });
  return {
    setMacHelperInput: (supported: boolean) => {
      macHelperInput = supported;
    },
    app,
    base,
    macSource,
    macViewer: (editing = false) =>
      connect(
        `/v1/computer-use/views/${macSource.viewId}/1/display?sharedInput=1${editing ? "&editing=1" : ""}`,
        "owner",
      ),
    serverViewers,
    hub,
    inputAuthorization: (value: boolean) => {
      inputAuthorized = value;
    },
    apps,
    peer,
    stream,
    fence,
    sessionId,
    owner,
    runnerId,
    sent,
    authenticator,
    viewer,
    phone,
    start,
    state,
    frame,
    connect,
    advance: (ms: number) => {
      now += ms;
    },
    end: () => {
      live = false;
      hub.endSession(sessionId);
    },
    failAuthorization: (error: Error) => {
      authorizationFailure = error;
    },
    expireSession: () => {
      live = false;
    },
    revoke: () => {
      authorized = false;
    },
    logout: () => {
      signedIn = false;
    },
    expireSoon: () => {
      loginExpiresAt = Date.now() + 100;
    },
    activity: () => activities,
    authorizationChecks: () => authorizationChecks,
    pauseAuthorization: () => {
      let resume: () => void = () => undefined;
      authorizationGate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      return () => {
        authorizationGate = undefined;
        resume();
      };
    },
  };
}

describe("phone display Host sockets", () => {
  it("frees the lane when the phone refuses a press from a viewer without editing", async () => {
    const f = await fixture(true, { editing: true });
    const a = await f.viewer(false);
    const b = await f.viewer(false);
    await f.state();
    const down = (viewer: typeof a, sequence: number) =>
      viewer.send({
        type: "display.input",
        geometry: 1,
        sequence,
        events: [{ kind: "pointer", phase: "down", x: 0.5, y: 0.5, t: sequence }],
      });
    down(a, 1);
    await a.roundTrip();
    await f.apps.handleMessage(f.peer, f.stream, {
      ...f.fence,
      type: "runner.integrations.display.input-result",
      streamId: f.start().streamId,
      sessionId: f.sessionId,
      geometry: 1,
      sequence: 0,
      outcome: "refused",
      reason: "unavailable",
    });
    await a.roundTrip();
    expect(f.sent.filter((m) => m.type === "host.integrations.display.input-reset")).toHaveLength(
      1,
    );
    down(b, 1);
    await b.roundTrip();
    expect(b.json().some((m) => m.reason === "contended")).toBe(false);
  });

  it("spends replies owed while a Mac viewer had no approval, so they never use up its room", async () => {
    const f = await fixture(true, { mac: true });
    const viewer = await f.macViewer(true);
    await f.state();
    await viewer.roundTrip();
    const projected = () =>
      viewer
        .json()
        .filter((m) => m.type === "display.state")
        .at(-1)?.sharedInput;
    expect(projected()).toBe(1);
    for (let sequence = 1; sequence <= 128; sequence++)
      viewer.send({
        type: "display.input",
        geometry: 1,
        sequence,
        events: [{ kind: "text", insert: "x" }],
      });
    await viewer.roundTrip();
    f.inputAuthorization(false);
    f.advance(5001);
    f.hub.sweep();
    await until(() => projected() === undefined);
    for (let sequence = 0; sequence < 128; sequence++)
      await f.apps.handleMessage(f.peer, f.stream, {
        ...f.fence,
        type: "runner.integrations.mac-owner.event",
        streamId: f.start().streamId,
        source: f.macSource,
        message: { type: "display.input.result", sequence, outcome: "dispatched" },
      });
    f.inputAuthorization(true);
    f.advance(5001);
    f.hub.sweep();
    await until(() => projected() === 1);
    viewer.send({
      type: "display.input",
      geometry: 1,
      sequence: 129,
      events: [{ kind: "text", insert: "y" }],
    });
    await viewer.roundTrip();
    expect(viewer.json().some((m) => m.reason === "too-large")).toBe(false);
    expect(f.sent.filter((m) => m.type === "host.integrations.mac-owner.input")).toHaveLength(129);
  });

  it("keeps room for a release when the lane's queue is full", async () => {
    const f = await fixture(true, { editing: true });
    const a = await f.viewer(true);
    await f.state();
    const send = (sequence: number, phase: string) =>
      a.send({
        type: "display.input",
        geometry: 1,
        sequence,
        events: [{ kind: "pointer", phase, x: 0.5, y: 0.5, t: sequence }],
      });
    send(1, "down");
    for (let sequence = 2; sequence <= 128; sequence++) send(sequence, "move");
    await a.roundTrip();
    send(129, "move");
    send(130, "up");
    await a.roundTrip();
    expect(a.json()).toContainEqual({
      type: "display.input.result",
      sequence: 129,
      outcome: "refused",
      reason: "too-large",
    });
    expect(a.json().some((m) => m.sequence === 130 && m.outcome === "refused")).toBe(false);
    const relayed = f.sent.filter((m) => m.type === "host.integrations.display.input");
    expect(relayed.at(-1)?.events).toEqual([
      { kind: "pointer", phase: "up", x: 0.5, y: 0.5, t: 130 },
    ]);
  });

  it("frees the lane when the phone refuses the press holding it, never a later one", async () => {
    const f = await fixture(true, { editing: true });
    const a = await f.viewer(true);
    const b = await f.viewer(true);
    await f.state();
    const send = (viewer: typeof a, sequence: number, phase: string) =>
      viewer.send({
        type: "display.input",
        geometry: 1,
        sequence,
        events: [{ kind: "pointer", phase, x: 0.5, y: 0.5, t: sequence }],
      });
    const refuse = (sequence: number) =>
      f.apps.handleMessage(f.peer, f.stream, {
        ...f.fence,
        type: "runner.integrations.display.input-result",
        streamId: f.start().streamId,
        sessionId: f.sessionId,
        geometry: 1,
        sequence,
        outcome: "refused",
        reason: "unavailable",
      });
    const resets = () =>
      f.sent.filter((m) => m.type === "host.integrations.display.input-reset").length;
    send(a, 1, "down");
    await a.roundTrip();
    send(a, 2, "move");
    await a.roundTrip();
    // A refusal of an earlier batch must not end the press a later batch continues.
    await refuse(0);
    await a.roundTrip();
    expect(resets()).toBe(0);
    await refuse(1);
    await a.roundTrip();
    expect(resets()).toBe(1);
    // The phone has no finger down, so another viewer is not told the lane is taken.
    send(b, 1, "down");
    await b.roundTrip();
    expect(b.json().some((m) => m.reason === "contended")).toBe(false);
    expect(
      f.sent.filter((m) => m.type === "host.integrations.display.input").map((m) => m.sequence),
    ).toEqual([0, 1, 2]);
  });

  it("arbitrates held gestures, honors only holder resets and cleans up departed holders", async () => {
    const f = await fixture(true, { editing: true });
    const a = await f.viewer(true);
    const b = await f.viewer(true);
    await f.state();
    const send = (viewer: typeof a, sequence: number, phase: string) =>
      viewer.send({
        type: "display.input",
        geometry: 1,
        sequence,
        events: [{ kind: "pointer", phase, x: 0.5, y: 0.5, t: sequence }],
      });
    send(a, 10, "down");
    await a.roundTrip();
    send(b, 20, "down");
    await b.roundTrip();
    expect(b.json()).toContainEqual({
      type: "display.input.result",
      sequence: 20,
      outcome: "refused",
      reason: "contended",
    });
    b.send({ type: "display.input-reset" });
    await b.roundTrip();
    expect(f.sent.filter((m) => m.type === "host.integrations.display.input-reset")).toHaveLength(
      0,
    );
    a.send({ type: "display.input-reset" });
    await a.roundTrip();
    send(b, 21, "down");
    await b.roundTrip();
    b.socket.close();
    await b.closed;
    await until(
      () => f.sent.filter((m) => m.type === "host.integrations.display.input-reset").length === 2,
    );
    send(a, 11, "down");
    await a.roundTrip();
    await f.state("live", 2);
    await a.roundTrip();
    expect(f.sent.filter((m) => m.type === "host.integrations.display.input-reset")).toHaveLength(
      3,
    );
    expect(
      f.sent.filter((m) => m.type === "host.integrations.display.input").map((m) => m.sequence),
    ).toEqual([0, 1, 2]);
  });

  it("ends a gesture on its own releases without a reset and drops replies for departed viewers", async () => {
    const f = await fixture(true, { editing: true });
    const a = await f.viewer(true);
    const b = await f.viewer(true);
    await f.state();
    for (const [sequence, phase] of [
      [0, "down"],
      [1, "up"],
    ] as const) {
      a.send({
        type: "display.input",
        geometry: 1,
        sequence,
        events: [{ kind: "pointer", phase, x: 0.5, y: 0.5, t: sequence }],
      });
      await a.roundTrip();
    }
    b.send({ type: "display.input", geometry: 1, sequence: 0, events: [{ kind: "copy" }] });
    await b.roundTrip();
    a.socket.close();
    await a.closed;
    await f.apps.handleMessage(f.peer, f.stream, {
      ...f.fence,
      type: "runner.integrations.display.input-result",
      streamId: f.start().streamId,
      sessionId: f.sessionId,
      geometry: 1,
      sequence: 0,
      outcome: "dispatched",
    });
    await b.roundTrip();
    expect(f.sent.filter((m) => m.type === "host.integrations.display.input-reset")).toEqual([]);
    expect(b.json().filter((m) => m.type === "display.input.result")).toEqual([]);
    expect(f.sent.filter((m) => m.type === "host.integrations.display.input")).toHaveLength(3);
  });

  it("bounds outstanding receipts and keeps keys held after a pointer cancels", async () => {
    const f = await fixture(true, { editing: true });
    const a = await f.viewer(true);
    const b = await f.viewer(true);
    await f.state();
    a.send({
      type: "display.input",
      geometry: 1,
      sequence: 0,
      events: [
        {
          kind: "key",
          action: "down",
          key: "Shift",
          code: "ShiftLeft",
          modifiers: [],
          location: 1,
          repeat: false,
        },
        { kind: "pointer", phase: "down", x: 0.5, y: 0.5, t: 0 },
        { kind: "pointer", phase: "cancel", x: 0.5, y: 0.5, t: 1 },
      ],
    });
    await a.roundTrip();
    b.send({ type: "display.input", geometry: 1, sequence: 0, events: [{ kind: "copy" }] });
    await b.roundTrip();
    expect(b.json()).toContainEqual({
      type: "display.input.result",
      sequence: 0,
      outcome: "refused",
      reason: "contended",
    });
    a.send({
      type: "display.input",
      geometry: 1,
      sequence: 1,
      events: [
        {
          kind: "key",
          action: "up",
          key: "Shift",
          code: "ShiftLeft",
          modifiers: [],
          location: 1,
          repeat: false,
        },
      ],
    });
    await a.roundTrip();
    for (let sequence = 2; sequence <= 128; sequence++)
      a.send({ type: "display.input", geometry: 1, sequence, events: [{ kind: "copy" }] });
    await a.roundTrip();
    expect(f.sent.filter((m) => m.type === "host.integrations.display.input")).toHaveLength(128);
    expect(a.json()).toContainEqual({
      type: "display.input.result",
      sequence: 128,
      outcome: "refused",
      reason: "too-large",
    });
  });

  it("routes receipts and clipboard privately while broadcasting editing, and refuses legacy acquire", async () => {
    const f = await fixture(true, { editing: true });
    const a = await f.viewer(true);
    const b = await f.viewer(true);
    const baseline = await f.connect(`/v1/computer-use/sessions/${f.sessionId}/display`, "owner");
    await f.state();
    a.send({ type: "display.input", geometry: 1, sequence: 40, events: [{ kind: "copy" }] });
    await a.roundTrip();
    const base = { ...f.fence, streamId: f.start().streamId, sessionId: f.sessionId, geometry: 1 };
    for (const event of [
      {
        ...base,
        type: "runner.integrations.display.input-result",
        sequence: 0,
        outcome: "dispatched",
      },
      {
        ...base,
        type: "runner.integrations.display.clipboard",
        sequence: 0,
        outcome: "copied",
        text: "private",
      },
      {
        ...base,
        type: "runner.integrations.display.editing",
        context: { contextId: randomUUID(), field: null, caret: null },
      },
    ])
      await f.apps.handleMessage(f.peer, f.stream, event as never);
    await Promise.all([a.roundTrip(), b.roundTrip(), baseline.roundTrip()]);
    expect(a.json()).toContainEqual({
      type: "display.clipboard",
      sequence: 40,
      outcome: "copied",
      text: "private",
    });
    expect(
      b.json().filter((m) => m.type === "display.clipboard" || m.type === "display.input.result"),
    ).toEqual([]);
    expect(
      [a, b].every((v) => v.json().some((m) => m.type === "display.editing" && m.generation === 1)),
    ).toBe(true);
    expect(
      baseline.json().every((m) => m.sharedInput === undefined && m.type !== "display.editing"),
    ).toBe(true);
    baseline.send({ type: "display.control", action: "acquire" });
    baseline.send({ type: "display.control", action: "release" });
    baseline.send({
      type: "display.input",
      controlId: `dcl_${randomUUID()}`,
      geometry: 1,
      sequence: 50,
      events: [{ kind: "copy" }],
    });
    await baseline.roundTrip();
    expect(baseline.json()).toContainEqual({
      type: "display.control",
      state: "refused",
      reason: "released-by-owner",
    });
    expect(baseline.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("leaves phones without shared input view-only", async () => {
    const f = await fixture(true, { sharedInput: false });
    const viewer = await f.viewer();
    await f.state();
    viewer.send({
      type: "display.input",
      geometry: 1,
      sequence: 0,
      events: [{ kind: "text", insert: "hello" }],
    });
    await viewer.roundTrip();
    expect(f.start().sharedInput).toBeUndefined();
    expect(viewer.json().every((m) => m.sharedInput === undefined)).toBe(true);
    expect(f.sent.filter((m) => m.type === "host.integrations.display.input")).toEqual([]);
  });

  // Editing failure cases are recorded before implementation in the builder evidence.
  it.each([false, true])(
    "negotiates phone editing without changing baseline viewers (phone=%s)",
    async (editing) => {
      const f = await fixture(true, { editing });
      const baseline = await f.viewer();
      const opted = await f.viewer(true);
      await f.state();
      await Promise.all([baseline.roundTrip(), opted.roundTrip()]);
      expect(f.start().editingVersion).toBe(editing ? 1 : undefined);
      expect(baseline.json().every((m) => m.editingVersion === undefined)).toBe(true);
      expect(opted.json().at(-1).editingVersion).toBe(editing ? 1 : undefined);
      opted.send({
        type: "display.input",

        geometry: 1,
        sequence: 1,
        events: [{ kind: "paste", text: "hello" }],
      });
      await opted.roundTrip();
      expect(f.sent.filter((m) => m.type === "host.integrations.display.input")).toHaveLength(
        editing ? 1 : 0,
      );
      opted.send({
        type: "display.input",

        geometry: 1,
        sequence: 2,
        events: [{ kind: "mouse", phase: "down", button: "left", modifiers: [], x: 0.5, y: 0.5 }],
      });
      await opted.roundTrip();
      expect(f.sent.filter((m) => m.type === "host.integrations.display.input")).toHaveLength(
        editing ? 1 : 0,
      );
      const directory = process.env.OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR;
      if (directory) {
        await mkdir(directory, { recursive: true });
        await writeFile(
          path.join(directory, `phone-editing-${editing}.json`),
          JSON.stringify({ editing, baseline: baseline.json(), opted: opted.json() }, null, 2),
        );
      }
    },
  );

  it("carries escaped input through the real Host without a 1009 close", async () => {
    const f = await fixture(true, { editing: true });
    const sockets: WebSocket[] = [];
    const streams = new DisplayStreams({
      connect: () => {
        const socket = new WebSocket(
          `${f.base}/v1/computer-use/sessions/${f.sessionId}/display?sharedInput=1`,
          {
            headers: { authorization: "Bearer owner" },
          },
        );
        sockets.push(socket);
        return socket as never;
      },
    });
    cleanups.push(async () => {
      streams.dispose();
      for (const socket of sockets) socket.terminate();
    });
    const lease = streams.retain({
      scope: "byte-batching",
      source: { kind: "task-session", sessionId: f.sessionId },
    });
    await until(() => Boolean(f.start()));
    await f.state();
    await until(() => lease.getSnapshot().connection === "open");
    await until(() => lease.getSnapshot().input === "available");
    const events = Array.from({ length: 64 }, () => ({
      kind: "text" as const,
      insert: "\u0001".repeat(1000),
    }));
    expect(lease.input(1, events)).toBe(true);
    await until(
      () => f.sent.filter((m) => m.type === "host.integrations.display.input").length === 2,
    );
    const input = f.sent.filter((m) => m.type === "host.integrations.display.input");
    expect(input.flatMap((m) => m.events)).toEqual(events);
    expect(sockets[0]!.readyState).toBe(WebSocket.OPEN);
    const directory = process.env.OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR;
    if (directory) {
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "phone-byte-batching.json"),
        JSON.stringify(
          {
            events: events.length,
            batches: input.map((m) => ({
              sequence: m.sequence,
              events: m.events.length,
              relayBytes: Buffer.byteLength(JSON.stringify(m)),
            })),
            socketOpen: true,
          },
          null,
          2,
        ),
      );
    }
  });

  it("settles stale picture input and pending batches when phone geometry changes", async () => {
    const f = await fixture(true, { editing: true });
    const viewer = await f.viewer(true);
    await f.state();
    viewer.send({
      type: "display.input",

      geometry: 1,
      sequence: 0,
      events: [{ kind: "paste", text: "hello" }],
    });
    await viewer.roundTrip();
    await f.state("live", 2);
    await viewer.roundTrip();
    expect(viewer.json()).toContainEqual({
      type: "display.input.result",
      sequence: 0,
      outcome: "stale",
      reason: "stale",
    });
    viewer.send({
      type: "display.input",

      geometry: 1,
      sequence: 1,
      events: [{ kind: "copy" }],
    });
    await viewer.roundTrip();
    expect(viewer.json()).toContainEqual({
      type: "display.input.result",
      sequence: 1,
      outcome: "stale",
      reason: "stale",
    });
    expect(f.sent.filter((m) => m.type === "host.integrations.display.input")).toHaveLength(1);
    viewer.send({
      type: "display.input",

      geometry: 2,
      sequence: 2,
      events: [{ kind: "copy" }],
    });
    await viewer.roundTrip();
    await f.apps.handleMessage(f.peer, f.stream, {
      ...f.fence,
      type: "runner.integrations.display.input-result",
      streamId: f.start().streamId,
      sessionId: f.sessionId,

      geometry: 2,
      sequence: 1,
      outcome: "dispatched",
    });
    await f.state("live", 3);
    await viewer.roundTrip();
    expect(
      viewer.json().filter((m) => m.type === "display.input.result" && m.sequence === 2),
    ).toEqual([{ type: "display.input.result", sequence: 2, outcome: "dispatched" }]);
    expect(viewer.json()).toContainEqual({
      type: "display.clipboard",
      sequence: 2,
      outcome: "refused",
    });
  });

  it("refuses image and file paste explicitly without closing a negotiated phone socket", async () => {
    const f = await fixture(true, { editing: true });
    const viewer = await f.viewer(true);
    await f.state();
    for (const [sequence, type] of ["image/png", "application/octet-stream"].entries()) {
      viewer.send({
        type: "display.input",

        geometry: 1,
        sequence,
        events: [{ kind: "paste", items: [{ type, size: 10 }] }],
      });
      await viewer.roundTrip();
      expect(viewer.json()).toContainEqual({
        type: "display.input.result",
        sequence,
        outcome: "refused",
        reason: "unsupported",
      });
    }
    expect(viewer.socket.readyState).toBe(WebSocket.OPEN);
    expect(f.sent.filter((m) => m.type === "host.integrations.display.input")).toEqual([]);
  });

  it.each([false, true])(
    "negotiates Cut separately and keeps old editing viewers on their wire (phone=%s)",
    async (displayCut) => {
      const f = await fixture(true, { editing: true, displayCut });
      const old = await f.viewer(true);
      const viewer = await f.viewer(true, true);
      await f.state();
      await old.roundTrip();
      await viewer.roundTrip();
      expect(f.start().displayCut).toBe(displayCut ? 1 : undefined);
      expect(old.json().every((m) => m.displayCut === undefined)).toBe(true);
      expect(viewer.json().at(-1).displayCut).toBe(displayCut ? 1 : undefined);
      viewer.send({
        type: "display.input",

        geometry: 1,
        sequence: 0,
        events: [{ kind: "cut", contextId: randomUUID() }],
      });
      await viewer.roundTrip();
      expect(f.sent.filter((m) => m.type === "host.integrations.display.input")).toHaveLength(
        displayCut ? 1 : 0,
      );
      if (displayCut) {
        await f.apps.handleMessage(f.peer, f.stream, {
          ...f.fence,
          streamId: f.start().streamId,
          sessionId: f.sessionId,

          geometry: 1,
          type: "runner.integrations.display.clipboard",
          sequence: 0,
          outcome: "cut",
          text: "selected",
        });
        await viewer.roundTrip();
        expect(viewer.json().filter((m) => m.type === "display.clipboard")).toEqual([
          { type: "display.clipboard", sequence: 0, outcome: "cut", text: "selected" },
        ]);
        await old.roundTrip();
        expect(old.json().some((m) => m.type === "display.clipboard")).toBe(false);
      } else
        expect(viewer.json()).toContainEqual({
          type: "display.input.result",
          sequence: 0,
          outcome: "refused",
          reason: "unsupported",
        });
    },
  );

  it("binds one-use tickets to integrations, session and stream, with a 60-second expiry", async () => {
    const f = await fixture();
    const streamId = DisplayStreamIdSchema.parse(`dsp_${randomUUID()}`);
    const issue = () =>
      f.authenticator.issueDisplayDataTicket({ fence: f.fence, display: "main", streamId });
    const first = issue();
    expect(Date.parse(first.claims.expiresAt) - Date.parse(first.claims.issuedAt)).toBe(60_000);
    expect(f.authenticator.verifyDisplayDataTicket(first.ticket)).toEqual(first.claims);
    expect(() => f.authenticator.verifyDisplayDataTicket(first.ticket)).toThrow(/already used/);
    const expired = issue();
    f.advance(60_000);
    expect(() => f.authenticator.verifyDisplayDataTicket(expired.ticket)).toThrow();
    expect(() =>
      f.authenticator.issueDisplayDataTicket({
        fence: { ...f.fence, module: "shell" },
        display: "main",
        streamId,
      }),
    ).toThrow();
    const ticket = issue().ticket;
    expect(() => f.authenticator.verifyDisplayDataTicket(ticket.slice(0, -5))).toThrow();
  });
  it("claims the bearer data route once and refuses mismatched live fences", async () => {
    const f = await fixture();
    await f.viewer();
    await f.phone();
    await expect(
      f.connect("/internal/v1/computer-use/display", f.start().dataTicket),
    ).rejects.toThrow(/403/);
  });
  it("checks the claims fence even with the waiting stream's exact nonce lineage", async () => {
    const f = await fixture();
    await f.viewer();
    const claims = f.authenticator.verifyDisplayDataTicket(f.start().dataTicket);
    const verify = vi.spyOn(f.authenticator, "verifyDisplayDataTicket");
    verify.mockReturnValueOnce({ ...claims, connectionGeneration: 9 });
    expect(() => f.hub.claimDataSocket("same-nonce-wrong-fence")).toThrow(
      "That display ticket names no waiting live stream",
    );
    verify.mockReturnValueOnce(claims);
    expect(f.hub.claimDataSocket("same-nonce-right-fence")).toEqual(claims);
  });
  it("isolates a restarted stream from old tickets, data sockets and control state", async () => {
    const f = await fixture();
    const a = await f.viewer();
    const oldStart = f.start();
    const oldClaims = f.authenticator.verifyDisplayDataTicket(oldStart.dataTicket);
    const verify = vi.spyOn(f.authenticator, "verifyDisplayDataTicket");
    verify.mockReturnValueOnce(oldClaims);
    const oldPhone = await f.phone();
    const oldServer = serverDataSockets.get(oldClaims.streamId)!;
    await f.state();
    const oldFrame = f.frame(1, true);
    f.hub.endSession(f.sessionId);
    await a.closed;
    const b = await f.viewer();
    expect(f.start().streamId).not.toBe(oldStart.streamId);
    verify.mockReturnValueOnce(oldClaims);
    expect(() => f.hub.claimDataSocket("old-lineage")).toThrow(/no waiting live stream/);
    const lateSocket = new WebSocket("ws://127.0.0.1:1");
    lateSocket.on("error", () => undefined);
    const closed = vi.spyOn(lateSocket, "close").mockImplementation(() => undefined);
    f.hub.attachDataSocket(oldClaims, lateSocket);
    expect(closed).toHaveBeenCalledWith(4003, "Display stream ended");
    lateSocket.terminate();
    const phone = await f.phone();
    f.hub.failDataSocket(oldClaims);
    await f.apps.handleMessage(f.peer, f.stream, {
      ...f.fence,
      type: "runner.integrations.display.state",
      display: "main",
      streamId: oldStart.streamId,
      generation: 99,
      rotation: 0,
      state: "failed",
      width: 360,
      height: 640,
    });
    // Exercise the old server-side message callback even after its socket closed.
    oldServer.emit("message", Buffer.from(oldFrame), true);
    await f.state();
    phone.socket.send(f.frame(1, true));
    await until(() => b.media().length === 1);
    expect(b.json().some((m) => m.type === "display.control" || m.state === "failed")).toBe(false);
    expect(oldPhone.socket.readyState).not.toBe(WebSocket.OPEN);
  });
  // Socket failures: credits cannot bound queued socket bytes; claimed tickets
  // fail before upgrade; reassembly uses the Host-wide limit instead of this route's.
  it.each(["phone", "viewer"] as const)(
    "bounds %s socket buffering independently of acknowledgements",
    async (side) => {
      const f = await fixture();
      const viewer = await f.viewer();
      const phone = await f.phone();
      await f.state();
      const server =
        side === "phone" ? serverDataSockets.get(f.start().streamId)! : f.serverViewers[0]!;
      Object.defineProperty(server, "bufferedAmount", {
        configurable: true,
        get: () => 8 * 1_024 * 1_024,
      });
      // A dishonest viewer returns credit even though previous writes are still queued.
      viewer.send({ type: "display.ack", sequence: 99 });
      phone.socket.send(f.frame(1, true));
      expect(await (side === "phone" ? phone.closed : viewer.closed)).toBe(1013);
      expect(f.apps.attached(f.runnerId)).toBe(true);
    },
  );
  it("closes an unread viewer even when it acknowledges every queued frame", async () => {
    const f = await fixture();
    const viewer = await f.viewer();
    const phone = await f.phone();
    await f.state();
    let buffered = 0;
    const server = f.serverViewers[0]!;
    Object.defineProperty(server, "bufferedAmount", { configurable: true, get: () => buffered });
    server.on("message", () => {
      buffered += 3 * 1_024 * 1_024;
    });
    for (let sequence = 1; sequence <= 3; sequence++) {
      phone.socket.send(f.frame(sequence, sequence === 1));
      await until(() => viewer.media().length === sequence);
      viewer.send({ type: "display.ack", sequence });
      await delay(10);
    }
    phone.socket.send(f.frame(4));
    expect(await viewer.closed).toBe(1013);
  });
  it.each(["viewer", "data"] as const)(
    "rejects oversized fragmented %s messages before final reassembly",
    async (side) => {
      const f = await fixture();
      const viewer = await f.viewer();
      const phone = side === "data" ? await f.phone() : undefined;
      const client = phone ?? viewer;
      client.socket.send(
        new Uint8Array(side === "data" ? 4 * 1_024 * 1_024 + 16 * 1_024 + 5 : 256 * 1_024 + 1),
        { binary: true, fin: false },
      );
      // No final fragment is sent: a message-handler length check cannot pass this.
      expect(await client.closed).toBe(1009);
    },
  );
  it("retries without a failed state when a claimed upgrade fails", async () => {
    const f = await fixture();
    const viewer = await f.viewer();
    const port = Number(new URL(f.base).port);
    const raw = createConnection({ host: "127.0.0.1", port });
    raw.on("error", () => undefined);
    const chunks: Buffer[] = [];
    raw.on("data", (chunk: Buffer) => chunks.push(chunk));
    await once(raw, "connect");
    raw.end(
      `GET /internal/v1/computer-use/display HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 12\r\nAuthorization: Bearer ${f.start().dataTicket}\r\n\r\n`,
    );
    await once(raw, "close");
    expect(Buffer.concat(chunks).toString()).toContain("400");
    expect(await viewer.closed).toBe(1013);
    expect(viewer.json().some((m) => m.state === "failed")).toBe(false);
    await expect(
      f.connect("/internal/v1/computer-use/display", f.start().dataTicket),
    ).rejects.toThrow(/403/);
    expect(f.apps.attached(f.runnerId)).toBe(true);
  });
  it.each(["data-socket-failed", "encoder-failed"] as const)(
    "handles phone-reported %s with the matching retry policy",
    async (reason) => {
      const f = await fixture();
      const viewer = await f.viewer();
      const phone = await f.phone();
      phone.socket.send(f.frame(1, true));
      await until(() => viewer.media().length === 1);
      await f.state("failed", 1, reason);
      expect(await viewer.closed).toBe(reason === "data-socket-failed" ? 1013 : 1000);
      await phone.closed;
      const failures = viewer.json().filter((m) => m.state === "failed");
      if (reason === "data-socket-failed") {
        expect(failures).toEqual([]);
        expect(viewer.json().at(-1)).toMatchObject({ state: "live" });
      } else expect(failures).toEqual([expect.objectContaining({ state: "failed", reason })]);
      expect(f.apps.attached(f.runnerId)).toBe(true);
    },
  );
  it("refuses non-owners and closes on revocation and login expiry", async () => {
    const f = await fixture();
    await expect(
      f.connect(`/v1/computer-use/sessions/${f.sessionId}/display?sharedInput=1`, "other"),
    ).rejects.toThrow(/403/);
    const viewer = await f.viewer();
    f.revoke();
    expect(await viewer.closed).toBe(4003);
    const g = await fixture();
    g.expireSoon();
    const expiring = await g.viewer();
    expect(await expiring.closed).toBe(1008);
  }, 10_000);
  it("rechecks login revocation", async () => {
    const f = await fixture();
    const viewer = await f.viewer();
    f.logout();
    expect(await viewer.closed).toBe(1008);
  }, 10_000);
  it("reports unsupported and sends no display frames to an older phone", async () => {
    const f = await fixture(false);
    const viewer = await f.viewer();
    expect(await viewer.closed).toBe(1000);
    expect(viewer.json()[0]).toMatchObject({ type: "display.state", state: "unsupported" });
    expect(f.sent).toEqual([]);
  });
  it("serves static-screen late joins from the byte-identical GOP without a phone command", async () => {
    const f = await fixture();
    const a = await f.viewer();
    const phone = await f.phone();
    await f.state();
    phone.socket.send(f.frame(1, true));
    phone.socket.send(f.frame(2));
    await until(() => a.media().length === 2);
    const commands = f.sent.length;
    const b = await f.viewer();
    const c = await f.viewer();
    await until(() => c.media().length === 2);
    expect(b.json()[0]).toMatchObject({ type: "display.state", state: "live", replayThrough: 2 });
    expect(a.json().every((state) => !("replayThrough" in state))).toBe(true);
    expect(b.frames[0]?.binary).toBe(false);
    expect(c.frames[0]?.binary).toBe(false);
    expect(b.frames.filter((frame) => frame.binary)).toEqual(
      a.frames.filter((frame) => frame.binary),
    );
    expect(c.media()).toEqual(a.media());
    expect(f.sent).toHaveLength(commands);
    phone.socket.send(f.frame(3));
    await until(() => c.media().length === 3);
    expect(b.media().map(({ header }) => header.sequence)).toEqual([1, 2, 3]);
    expect(Array.from(a.media()[0]!.payload)).toEqual([0, 0, 0, 1, 101, 255]);
    expect(phone.json()).toEqual([1, 2, 3].map((sequence) => ({ type: "display.ack", sequence })));
    expect(f.sent.filter((m) => m.type === "host.integrations.display.start")).toHaveLength(1);
    const directory = process.env.OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR;
    if (directory) {
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "phone-display-fanout.json"),
        JSON.stringify(
          {
            phoneAcks: phone.json(),
            viewerStates: [a.json(), b.json(), c.json()],
            viewerFrames: [a, b, c].map((viewer) =>
              viewer.media().map(({ header, payload }) => ({
                header,
                payloadBase64: Buffer.from(payload).toString("base64"),
              })),
            ),
            commands: f.sent.map(({ type }) => type),
          },
          null,
          2,
        ),
      );
    }
  });
  it("replays a decoder reset with a fixed tail and rate-limits completed requests", async () => {
    const f = await fixture();
    const viewer = await f.viewer();
    const phone = await f.phone();
    await f.state();
    for (let sequence = 1; sequence <= 3; sequence++)
      phone.socket.send(f.frame(sequence, sequence === 1));
    await until(() => viewer.media().length === 3);
    for (let sequence = 1; sequence <= 3; sequence++)
      viewer.send({ type: "display.ack", sequence });
    const commands = f.sent.length;
    viewer.send({ type: "display.keyframe" });
    await until(() => viewer.media().length === 6);
    expect(viewer.json().at(-1)).toMatchObject({ state: "live", replayThrough: 3 });
    expect(
      viewer
        .media()
        .slice(3)
        .map((frame) => frame.header.sequence),
    ).toEqual([1, 2, 3]);
    for (let sequence = 1; sequence <= 3; sequence++)
      viewer.send({ type: "display.ack", sequence });
    for (let index = 0; index < 100; index++) viewer.send({ type: "display.keyframe" });
    await delay(20);
    expect(viewer.media()).toHaveLength(6);
    f.advance(500);
    viewer.send({ type: "display.keyframe" });
    await until(() => viewer.media().length === 9);
    expect(f.sent).toHaveLength(commands);
  });
  it.each(["replay", "live-key"] as const)(
    "serves a second decoder reset during motion after a %s start",
    async (start) => {
      const f = await fixture();
      const viewer = await f.viewer();
      const phone = await f.phone();
      await f.state();
      if (start === "replay") {
        phone.socket.send(f.frame(1, true));
        await until(() => viewer.media().length === 1);
      }
      viewer.send({ type: "display.keyframe" });
      if (start === "live-key") {
        await until(() => f.sent.some((m) => m.type === "host.integrations.display.refresh"));
        phone.socket.send(f.frame(1, true));
      }
      const initial = start === "replay" ? 2 : 1;
      await until(() => viewer.media().length === initial);
      if (start === "replay") viewer.send({ type: "display.ack", sequence: 1 });
      // Every current-decoder ack leaves a newer frame outstanding.
      for (let sequence = 2; sequence <= 4; sequence++) {
        phone.socket.send(f.frame(sequence));
        await until(() => viewer.media().length === initial + sequence - 1);
        viewer.send({ type: "display.ack", sequence: sequence - 1 });
      }
      f.advance(501);
      viewer.send({ type: "display.keyframe" });
      await until(() => viewer.media().length === initial + 7);
      expect(viewer.json().at(-1)).toMatchObject({ state: "live", replayThrough: 4 });
      expect(
        viewer
          .media()
          .slice(-4)
          .map((m) => m.header.sequence),
      ).toEqual([1, 2, 3, 4]);
    },
  );
  it("drops an unfinished replay on reset and consumes old acks before repeated sequences", async () => {
    const f = await fixture();
    const first = await f.viewer();
    const phone = await f.phone();
    await f.state();
    for (let sequence = 1; sequence <= 3; sequence++) {
      phone.socket.send(f.frame(sequence, sequence === 1, 1, new Uint8Array(700_000)));
      await until(() => first.media().length === sequence);
      first.send({ type: "display.ack", sequence });
      await delay(5);
    }
    const viewer = await f.viewer();
    await until(() => viewer.media().length === 1);
    viewer.send({ type: "display.keyframe" });
    await until(() => viewer.media().length === 2);
    expect(viewer.json().at(-1)).toMatchObject({ replayThrough: 3 });
    viewer.send({ type: "display.ack", sequence: 1 });
    await delay(20);
    expect(viewer.media().map((m) => m.header.sequence)).toEqual([1, 1]);
    f.advance(499);
    for (let index = 0; index < 100; index++) viewer.send({ type: "display.keyframe" });
    viewer.send({ type: "display.ack", sequence: 1 });
    await until(() => viewer.media().length === 3);
    viewer.send({ type: "display.ack", sequence: 2 });
    await until(() => viewer.media().length === 4);
    viewer.send({ type: "display.ack", sequence: 3 });
    phone.socket.send(f.frame(4));
    await until(() => viewer.media().length === 5);
    expect(viewer.media().map((m) => m.header.sequence)).toEqual([1, 1, 2, 3, 4]);
    expect(viewer.json().filter((m) => "replayThrough" in m)).toHaveLength(2);
  });
  it("coalesces missing-cache reset floods until the next live keyframe", async () => {
    const f = await fixture();
    const viewer = await f.viewer();
    const phone = await f.phone();
    await f.state();
    const refreshes = () => f.sent.filter((m) => m.type === "host.integrations.display.refresh");
    viewer.send({ type: "display.keyframe" });
    await until(() => refreshes().length === 1);
    f.advance(500);
    for (let index = 0; index < 100; index++) viewer.send({ type: "display.keyframe" });
    await delay(20);
    f.hub.sweep();
    expect(refreshes()).toHaveLength(1);
    phone.socket.send(f.frame(1));
    phone.socket.send(f.frame(2, true));
    await until(() => viewer.media().length === 1);
    expect(viewer.media()[0]?.header.sequence).toBe(2);
    expect(viewer.json().every((state) => !("replayThrough" in state))).toBe(true);
  });
  it.each(["starting", "protected", "screen-off"] as const)(
    "defers a missing-cache reset while %s",
    async (state) => {
      const f = await fixture();
      const viewer = await f.viewer();
      const phone = await f.phone();
      if (state !== "starting") await f.state(state);
      viewer.send({ type: "display.keyframe" });
      await delay(20);
      expect(f.sent.filter((m) => m.type === "host.integrations.display.refresh")).toHaveLength(0);
      // A protected phone resumes only in a new generation.
      const resumed = state === "protected" || state === "screen-off" ? 2 : 1;
      await f.state("live", resumed);
      await until(() => f.sent.some((m) => m.type === "host.integrations.display.refresh"));
      phone.socket.send(f.frame(1, true, resumed));
      await until(() => viewer.media().length === 1);
    },
  );
  it.each([6, 30_000])(
    "replays 60 frames with byte credit alone and stays live while acking (%i bytes)",
    async (size) => {
      const f = await fixture();
      const first = await f.viewer();
      const phone = await f.phone();
      await f.state();
      for (let sequence = 1; sequence <= 60; sequence++) {
        phone.socket.send(f.frame(sequence, sequence === 1, 1, new Uint8Array(size)));
        await first.received(() => first.media().length >= sequence);
        first.send({ type: "display.ack", sequence });
        await first.roundTrip();
      }
      const joined = await f.viewer();
      const window = size === 6 ? 60 : 34;
      await joined.received(() => joined.media().length >= window);
      expect(joined.media()).toHaveLength(window);
      expect(joined.json()[0]).toMatchObject({ replayThrough: 60 });
      for (let sequence = 1; sequence <= 60; sequence++) {
        joined.send({ type: "display.ack", sequence });
        await joined.roundTrip();
        f.advance(9_000);
        f.hub.sweep();
      }
      expect(joined.media()).toHaveLength(60);
      phone.socket.send(f.frame(61));
      await joined.received(() => joined.media().length >= 61);
      expect(joined.media().map((m) => m.header.sequence)).toEqual(
        Array.from({ length: 61 }, (_, i) => i + 1),
      );
      expect(joined.socket.readyState).toBe(WebSocket.OPEN);
      expect(f.sent.filter((m) => m.type === "host.integrations.display.refresh")).toHaveLength(0);
    },
  );
  it.each(["detach", "expired", "command-failed", "data-lost", "start-timeout"] as const)(
    "uses try-again when the phone is unavailable: %s",
    async (cause) => {
      const f = await fixture();
      const viewer = await f.viewer();
      if (cause === "detach") f.apps.detach(f.peer, "transport-disconnected");
      if (cause === "expired") {
        f.apps.renew(f.peer, {
          ...f.stream,
          streamLeaseExpiresAt: new Date(Date.now() - 1).toISOString(),
        });
        f.hub.sweep();
      }
      if (cause === "command-failed") {
        vi.spyOn(f.apps, "sendDisplay").mockResolvedValue(false);
        await f.state();
        viewer.send({
          type: "display.input",
          geometry: 1,
          sequence: 0,
          events: [{ kind: "text", insert: "hello" }],
        });
      }
      if (cause === "data-lost") (await f.phone()).socket.close();
      if (cause === "start-timeout") {
        f.advance(60_000);
        f.hub.sweep();
      }
      expect(await viewer.closed).toBe(cause === "detach" ? 1000 : 1013);
    },
  );
  it("distinguishes an unavailable phone from an unsupported phone on admission", async () => {
    const f = await fixture();
    f.apps.detach(f.peer, "transport-disconnected");
    const viewer = await f.viewer();
    expect(await viewer.closed).toBe(1013);
    expect(viewer.json().some((m) => m.state === "unsupported")).toBe(false);
  });
  it.each(["attach", "claim", "media", "event", "sweep"] as const)(
    "uses try-again on a fence change observed by %s",
    async (site) => {
      const f = await fixture();
      const viewer = await f.viewer();
      const phone = site === "claim" ? undefined : await f.phone();
      f.apps.renew(f.peer, { ...f.stream, fence: { ...f.fence, connectionGeneration: 2 } });
      if (site === "attach") await f.viewer();
      if (site === "claim")
        await expect(
          f.connect("/internal/v1/computer-use/display", f.start().dataTicket),
        ).rejects.toThrow(/403/);
      if (site === "media") phone!.socket.send(f.frame(1, true));
      if (site === "event")
        f.hub.handlePhoneEvent(f.runnerId, {
          ...f.fence,
          type: "runner.integrations.display.state",
          display: "main",
          streamId: f.start().streamId,
          state: "live",
          generation: 1,
          width: 360,
          height: 640,
          rotation: 0,
        });
      if (site === "sweep") f.hub.sweep();
      expect(await viewer.closed).toBe(1013);
    },
  );
  it("uses ended when a sweep observes a terminated session", async () => {
    const f = await fixture();
    const viewer = await f.viewer();
    await f.phone();
    f.expireSession();
    f.hub.sweep();
    expect(await viewer.closed).toBe(1000);
  });
  it("uses access-ended when the integrations authorization is revoked", async () => {
    const f = await fixture();
    const viewer = await f.viewer();
    await f.phone();
    f.apps.detach(f.peer, "revoked");
    expect(await viewer.closed).toBe(4003);
  });
  it.each(["retryable", "access", "unknown", "blocked"] as const)(
    "classifies %s periodic authorization failures",
    async (kind) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const f = await fixture();
      const viewer = await f.viewer();
      const resume = kind === "blocked" ? f.pauseAuthorization() : () => undefined;
      if (kind === "retryable")
        f.failAuthorization(new ComputerUseError("failed", "Authority unavailable", true));
      if (kind === "access")
        f.failAuthorization(new ComputerUseError("unsupported", "Owner changed"));
      if (kind === "unknown") f.failAuthorization(new Error("Authority unavailable"));
      try {
        await vi.advanceTimersByTimeAsync(kind === "blocked" ? 10_000 : 5_000);
        expect(await viewer.closed).toBe(kind === "access" ? 4003 : 1013);
      } finally {
        resume();
      }
    },
  );
  it("bounds commands queued during admission with try-again", async () => {
    const f = await fixture();
    const attach = f.hub.attachViewer.bind(f.hub);
    let resume: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    vi.spyOn(f.hub, "attachViewer").mockImplementationOnce(async (...args) => {
      await gate;
      return attach(...args);
    });
    const viewer = await f.viewer();
    try {
      for (let index = 0; index < 65; index++) viewer.send({ type: "display.keyframe" });
      expect(await viewer.closed).toBe(1013);
    } finally {
      resume();
    }
  });
  it.each(["json", "binary"] as const)(
    "uses try-again for a failed viewer %s send",
    async (kind) => {
      const f = await fixture();
      const viewer = await f.viewer();
      const phone = await f.phone();
      await f.state();
      await until(() => viewer.json().some((m) => m.state === "live"));
      vi.spyOn(f.serverViewers[0]!, "send").mockImplementationOnce(
        (_data, optionsOrCallback, callback) => {
          const done = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
          done?.(new Error("Socket write failed"));
        },
      );
      if (kind === "json") await f.state("protected");
      else phone.socket.send(f.frame(1, true));
      expect(await viewer.closed).toBe(1013);
    },
  );
  it("withholds media overtaken by control state and still publishes the new key", async () => {
    const f = await fixture();
    const viewer = await f.viewer();
    const phone = await f.phone();
    await f.state();
    phone.socket.send(f.frame(1, true));
    await until(() => viewer.media().length === 1);
    await f.state("live", 2);
    phone.socket.send(f.frame(2, false, 1));
    phone.socket.send(f.frame(3, true, 2));
    await until(() => phone.json().length === 3);
    expect(viewer.socket.readyState).toBe(WebSocket.OPEN);
    await until(() => viewer.media().length === 2);
    expect(viewer.media().map((m) => m.header.sequence)).toEqual([1, 3]);
    phone.socket.send(f.frame(4, false, 1));
    expect(await phone.closed).toBe(4002);
  });
  it("admits a 2 MiB keyframe into an empty frame window", async () => {
    const f = await fixture();
    const viewer = await f.viewer();
    const phone = await f.phone();
    await f.state();
    phone.socket.send(f.frame(1, true, 1, new Uint8Array(2 * 1_024 * 1_024)));
    await until(() => viewer.media().length === 1);
    expect(viewer.media()[0]?.payload.byteLength).toBe(2 * 1_024 * 1_024);
    const joined = await f.viewer();
    await until(() => joined.media().length === 1);
  });
  it.each(["static", "protected", "screen-off"] as const)(
    "clears a drained viewer's stall timer on a %s screen",
    async (state) => {
      const f = await fixture();
      const viewer = await f.viewer();
      const phone = await f.phone();
      await f.state();
      for (let sequence = 1; sequence <= 5; sequence++)
        phone.socket.send(f.frame(sequence, sequence === 1));
      await until(() => phone.json().length === 5);
      expect(viewer.media()).toHaveLength(4);
      if (state !== "static") await f.state(state);
      viewer.send({ type: "display.ack", sequence: 4 });
      if (state === "static") {
        await until(() => viewer.media().length === 9);
        expect(
          viewer
            .media()
            .slice(4)
            .map((m) => m.header.sequence),
        ).toEqual([1, 2, 3, 4, 5]);
        expect(viewer.json().at(-1)).toMatchObject({ replayThrough: 5 });
        viewer.send({ type: "display.ack", sequence: 5 });
      }
      await delay(20);
      f.advance(10_001);
      f.hub.sweep();
      await delay(20);
      expect(viewer.socket.readyState).toBe(WebSocket.OPEN);
    },
  );
  it("bounds cached replay work linearly as acknowledgements return credit", async () => {
    const f = await fixture();
    await f.viewer();
    const phone = await f.phone();
    await f.state();
    for (let sequence = 1; sequence <= 80; sequence++)
      phone.socket.send(f.frame(sequence, sequence === 1));
    await until(() => phone.json().length === 80);
    // Count actual cache-array visits, not wall time: repeated prefix scans must
    // fail deterministically even on a fast machine. Other arrays are untouched.
    let visits = 0;
    const iterate = Array.prototype[Symbol.iterator];
    Array.prototype[Symbol.iterator] = function (this: unknown[]) {
      const cursor = iterate.call(this);
      const first = this[0];
      if (
        typeof first === "object" &&
        first !== null &&
        "sequence" in first &&
        "bytes" in first &&
        first.bytes instanceof Uint8Array
      ) {
        const next = cursor.next.bind(cursor);
        cursor.next = () => {
          visits++;
          return next();
        };
      }
      return cursor;
    };
    try {
      const joined = await f.viewer();
      await until(() => joined.media().length === 80);
      expect(joined.media().map((m) => m.header.sequence)).toEqual(
        Array.from({ length: 80 }, (_, i) => i + 1),
      );
      expect(visits).toBeLessThanOrEqual(160);
    } finally {
      Array.prototype[Symbol.iterator] = iterate;
    }
  });
  it("bounds the GOP to 600 frames even when its bytes are tiny", async () => {
    const f = await fixture();
    await f.viewer();
    const phone = await f.phone();
    await f.state();
    for (let sequence = 1; sequence <= 600; sequence++)
      phone.socket.send(f.frame(sequence, sequence === 1));
    await until(() => phone.json().length === 600);
    const before = await f.viewer();
    await until(() => before.media().length === 600);
    phone.socket.send(f.frame(601));
    await until(() => phone.json().length === 601);
    const after = await f.viewer();
    await delay(20);
    expect(after.media()).toEqual([]);
    phone.socket.send(f.frame(602, true));
    await until(() => after.media().length === 1);
    expect(after.media()[0]?.header.sequence).toBe(602);
  });
  it("allows eight viewers per session and refuses the ninth with try-again", async () => {
    const f = await fixture();
    const viewers = [];
    for (let index = 0; index < 8; index++) viewers.push(await f.viewer());
    const extra = await f.viewer();
    expect(await extra.closed).toBe(1013);
    expect(viewers.every((viewer) => viewer.socket.readyState === WebSocket.OPEN)).toBe(true);
    viewers[0]!.socket.close();
    await viewers[0]!.closed;
    const replacement = await f.viewer();
    await until(() => replacement.json().length === 1);
    expect(replacement.socket.readyState).toBe(WebSocket.OPEN);
  });
  it.each(["starting", "protected"] as const)(
    "does not spend a join refresh while %s",
    async (state) => {
      const f = await fixture();
      await f.viewer();
      await f.phone();
      if (state === "protected") await f.state(state);
      await f.viewer();
      expect(f.sent.filter((m) => m.type === "host.integrations.display.refresh")).toEqual([]);
      await f.state();
      await f.viewer();
      expect(f.sent.filter((m) => m.type === "host.integrations.display.refresh")).toHaveLength(1);
    },
  );
  it("restarts the cached GOP at each keyframe", async () => {
    const f = await fixture();
    await f.viewer();
    const phone = await f.phone();
    await f.state();
    for (let sequence = 1; sequence <= 4; sequence++)
      phone.socket.send(f.frame(sequence, sequence === 1 || sequence === 3));
    await until(() => phone.json().length === 4);
    const joined = await f.viewer();
    await until(() => joined.media().length === 2);
    expect(joined.media().map(({ header }) => header.sequence)).toEqual([3, 4]);
    expect(joined.media()[0]?.header.key).toBe(true);
    expect(f.sent.filter((m) => m.type === "host.integrations.display.refresh")).toEqual([]);
  });
  it.each(["state", "media"])("empties the GOP on a %s generation change", async (source) => {
    const f = await fixture();
    await f.viewer();
    const phone = await f.phone();
    await f.state();
    phone.socket.send(f.frame(1, true));
    await until(() => phone.json().length === 1);
    if (source === "state") await f.state("live", 2);
    else {
      phone.socket.send(f.frame(2, false, 2));
      await until(() => phone.json().length === 2);
    }
    const joined = await f.viewer();
    await until(() => joined.json().length === 1);
    expect(joined.media()).toEqual([]);
    expect(f.sent.filter((m) => m.type === "host.integrations.display.refresh")).toHaveLength(1);
    await f.state("live", 2);
    phone.socket.send(f.frame(3, true, 2));
    await until(() => joined.media().length === 1);
    expect(joined.media()[0]?.header.sequence).toBe(3);
  });
  it("invalidates an overflowing GOP until a key and coalesces joins needing refresh", async () => {
    const f = await fixture();
    const viewer = await f.viewer();
    const phone = await f.phone();
    await f.state();
    for (let sequence = 1; sequence <= 6; sequence++) {
      phone.socket.send(f.frame(sequence, sequence === 1, 1, new Uint8Array(800_000)));
      await until(() => viewer.media().length === sequence);
      viewer.send({ type: "display.ack", sequence });
      await delay(5);
      if (sequence === 5) {
        const before = await f.viewer();
        await until(() => before.media().length === 1);
        before.socket.close();
        await before.closed;
      }
    }
    const b = await f.viewer();
    const c = await f.viewer();
    expect(b.media()).toEqual([]);
    expect(c.media()).toEqual([]);
    expect(f.sent.filter((m) => m.type === "host.integrations.display.refresh")).toHaveLength(1);
    phone.socket.send(f.frame(7));
    await until(() => phone.json().length === 7);
    const d = await f.viewer();
    expect(d.media()).toEqual([]);
    phone.socket.send(f.frame(8, true));
    await until(() => d.media().length === 1);
    f.advance(500);
    f.hub.sweep();
    expect(f.sent.filter((m) => m.type === "host.integrations.display.refresh")).toHaveLength(1);
    const recovered = await f.viewer();
    await until(() => recovered.media().length === 1);
    expect(recovered.media()[0]?.header.sequence).toBe(8);
  });
  it.each([6, 700_000])(
    "paces cached frames and concurrent live frames by credits (%i payload bytes)",
    async (size) => {
      const f = await fixture();
      const viewer = await f.viewer();
      const phone = await f.phone();
      await f.state();
      const count = size === 6 ? 7 : 4;
      const credit = size === 6 ? count : 1;
      for (let sequence = 1; sequence <= count; sequence++) {
        phone.socket.send(f.frame(sequence, sequence === 1, 1, new Uint8Array(size)));
        await until(() => viewer.media().length === sequence);
        viewer.send({ type: "display.ack", sequence });
        await delay(5);
      }
      const joined = await f.viewer();
      await until(() => joined.media().length === credit);
      phone.socket.send(f.frame(count + 1, false, 1, new Uint8Array(size)));
      await until(() => phone.json().length === count + 1);
      expect(joined.media()).toHaveLength(credit);
      for (let sequence = 1; sequence <= count; sequence++) {
        joined.send({ type: "display.ack", sequence });
        await until(
          () =>
            joined.media().length ===
            (size === 6 ? (sequence >= 4 ? count + 1 : count) : sequence + 1),
        );
      }
      expect(joined.media().map(({ header }) => header.sequence)).toEqual(
        Array.from({ length: count + 1 }, (_, index) => index + 1),
      );
      expect(f.sent.filter((m) => m.type === "host.integrations.display.refresh")).toEqual([]);
    },
  );
  it.each(["key", "generation", "overflow"])(
    "abandons an unfinished replay on %s without replaying it again",
    async (cause) => {
      const f = await fixture();
      const viewer = await f.viewer();
      const phone = await f.phone();
      await f.state();
      for (let sequence = 1; sequence <= 5; sequence++) {
        phone.socket.send(f.frame(sequence, sequence === 1, 1, new Uint8Array(700_000)));
        await until(() => viewer.media().length === sequence);
        viewer.send({ type: "display.ack", sequence });
        await delay(5);
      }
      const joined = await f.viewer();
      await until(() => joined.media().length === 1);
      if (cause === "generation") await f.state("live", 2);
      if (cause === "overflow") {
        phone.socket.send(f.frame(6, false, 1, new Uint8Array(4 * 1_024 * 1_024)));
        await until(() => phone.json().length === 6);
      }
      if (cause === "key") {
        phone.socket.send(f.frame(6, true));
        await until(() => phone.json().length === 6);
      }
      joined.send({ type: "display.ack", sequence: 1 });
      await delay(20);
      expect(joined.media().map(({ header }) => header.sequence)).toEqual(
        cause === "key" ? [1, 6] : [1],
      );
      phone.socket.send(f.frame(7, true, cause === "generation" ? 2 : 1));
      await until(() => joined.media().some((m) => m.header.sequence === 7));
      expect(joined.media().at(-1)?.header.sequence).toBe(7);
    },
  );
  it("clears the GOP on sleep and resumes only with a fresh-generation keyframe", async () => {
    const f = await fixture();
    const viewer = await f.viewer();
    const phone = await f.phone();
    await f.state();
    phone.socket.send(f.frame(1, true));
    await until(() => viewer.media().length === 1);
    await f.state("screen-off");
    const joined = await f.viewer();
    await delay(20);
    expect(joined.media()).toEqual([]);
    expect(joined.json()[0]).toMatchObject({ state: "screen-off", generation: 1 });
    await f.state("live", 2);
    phone.socket.send(f.frame(2, true, 2));
    await until(() => joined.media().length === 1);
    expect(viewer.media().map(({ header }) => header.sequence)).toEqual([1, 2]);
    expect(f.sent.filter((m) => m.type === "host.integrations.display.refresh")).toHaveLength(1);
  });
  it("does not replay protected cached frames to a joining viewer", async () => {
    const f = await fixture();
    await f.viewer();
    const phone = await f.phone();
    await f.state();
    phone.socket.send(f.frame(1, true));
    await until(() => phone.json().length === 1);
    await f.state("protected");
    const joined = await f.viewer();
    expect(joined.media()).toEqual([]);
    await f.state();
    phone.socket.send(f.frame(2));
    await until(() => phone.json().length === 2);
    expect(joined.media()).toEqual([]);
  });
  it("enforces independent frame credit and closes viewers that stay over budget", async () => {
    const f = await fixture();
    const slow = await f.viewer();
    const fast = await f.viewer();
    const phone = await f.phone();
    await f.state();
    f.advance(500);
    for (let sequence = 1; sequence <= 5; sequence++) {
      phone.socket.send(f.frame(sequence, sequence === 1));
      await until(() => phone.json().length === sequence);
      fast.send({ type: "display.ack", sequence });
      await delay(5);
    }
    expect(slow.media()).toHaveLength(4);
    expect(fast.media()).toHaveLength(5);
    expect(f.sent.filter((m) => m.type === "host.integrations.display.refresh")).toHaveLength(0);
    slow.send({ type: "display.ack", sequence: 4 });
    phone.socket.send(f.frame(6));
    await until(() => phone.json().length === 6);
    await until(() => slow.media().length === 9);
    phone.socket.send(f.frame(7, true));
    for (let sequence = 8; sequence <= 11; sequence++) phone.socket.send(f.frame(sequence));
    await until(() => phone.json().length === 11);
    f.advance(10_001);
    f.hub.sweep();
    expect(await slow.closed).toBe(1013);
  });
  it("refreshes an expensive recovery without replaying old motion or holding back a fast viewer", async () => {
    const f = await fixture();
    const slow = await f.viewer();
    const fast = await f.viewer();
    const phone = await f.phone();
    await f.state();
    const payload = new Uint8Array(100_000);
    for (let sequence = 1; sequence <= 5; sequence++) {
      phone.socket.send(f.frame(sequence, sequence === 1, 1, payload));
      await fast.received(() => fast.media().length === sequence);
      fast.send({ type: "display.ack", sequence });
      await fast.roundTrip();
    }
    await slow.roundTrip();
    expect(slow.media()).toHaveLength(4);
    f.advance(800);
    // Four delivered frames took 800ms. Replaying the five-frame GOP would
    // consume another second before showing the current picture.
    for (let sequence = 1; sequence <= 4; sequence++) slow.send({ type: "display.ack", sequence });
    await slow.roundTrip();
    expect(slow.media()).toHaveLength(4);
    expect(f.sent.filter((m) => m.type === "host.integrations.display.refresh")).toHaveLength(1);
    phone.socket.send(f.frame(6, false, 1, payload));
    await fast.received(() => fast.media().length === 6);
    await slow.roundTrip();
    expect(slow.media()).toHaveLength(4);
    phone.socket.send(f.frame(7, true, 1, payload));
    await slow.received(() => slow.media().length === 5);
    await fast.received(() => fast.media().length === 7);
    expect(slow.media().at(-1)?.header).toMatchObject({ sequence: 7, key: true });
    expect(fast.media().map((frame) => frame.header.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("keeps a complete static keyframe usable even after slow recovery", async () => {
    const f = await fixture();
    const viewer = await f.viewer();
    const phone = await f.phone();
    await f.state();
    for (let sequence = 1; sequence <= 5; sequence++)
      phone.socket.send(f.frame(sequence, sequence === 1, 1, new Uint8Array(100_000)));
    await phone.received(() => phone.json().length === 5);
    await viewer.roundTrip();
    f.advance(800);
    viewer.send({ type: "display.ack", sequence: 4 });
    await viewer.roundTrip();
    expect(viewer.media()).toHaveLength(4);
    phone.socket.send(f.frame(6, true, 1, new Uint8Array(400_000)));
    await viewer.received(() => viewer.media().length === 5);
    viewer.send({ type: "display.ack", sequence: 6 });
    await viewer.roundTrip();
    // Its capture time is old, but a static picture is still current. A decoder
    // reset must reuse it instead of continually requesting the same large key.
    f.advance(1_000);
    viewer.send({ type: "display.keyframe" });
    await viewer.received(() => viewer.media().length === 6);
    expect(viewer.media().at(-1)?.header).toMatchObject({ sequence: 6, key: true });
    expect(f.sent.filter((m) => m.type === "host.integrations.display.refresh")).toHaveLength(1);
  });
  it("coalesces expensive recoveries across viewers without delaying a decoder reset", async () => {
    const f = await fixture();
    const a = await f.viewer();
    const b = await f.viewer();
    const phone = await f.phone();
    await f.state();
    for (let sequence = 1; sequence <= 5; sequence++)
      phone.socket.send(f.frame(sequence, sequence === 1, 1, new Uint8Array(100_000)));
    await phone.received(() => phone.json().length === 5);
    await a.roundTrip();
    await b.roundTrip();
    const refreshes = () => f.sent.filter((m) => m.type === "host.integrations.display.refresh");
    f.advance(800);
    a.send({ type: "display.ack", sequence: 4 });
    await a.roundTrip();
    expect(refreshes()).toHaveLength(1);
    f.advance(800);
    b.send({ type: "display.ack", sequence: 4 });
    await b.roundTrip();
    f.hub.sweep();
    expect(refreshes()).toHaveLength(1);
    // A decoder error has its existing shorter recovery deadline; congestion
    // recovery must not hold that urgent request behind the two-second budget.
    b.send({ type: "display.keyframe" });
    await b.roundTrip();
    expect(refreshes()).toHaveLength(2);
    phone.socket.send(f.frame(6, true));
    await a.received(() => a.media().length === 5);
    await b.received(() => b.media().length === 5);
    f.advance(2_000);
    f.hub.sweep();
    expect(refreshes()).toHaveLength(2);
  });
  it("enforces byte credit and ignores unknown or duplicate acknowledgements", async () => {
    const f = await fixture();
    const viewer = await f.viewer();
    const phone = await f.phone();
    await f.state();
    phone.socket.send(f.frame(1, true, 1, new Uint8Array(700_000)));
    phone.socket.send(f.frame(2, false, 1, new Uint8Array(700_000)));
    await phone.received(() => phone.json().length >= 2);
    await viewer.roundTrip();
    expect(viewer.media()).toHaveLength(1);
    viewer.send({ type: "display.ack", sequence: 999 });
    viewer.send({ type: "display.ack", sequence: 2 });
    await viewer.roundTrip();
    expect(viewer.socket.readyState).toBe(WebSocket.OPEN);
    expect(viewer.media()).toHaveLength(1);
    viewer.send({ type: "display.ack", sequence: 1 });
    await viewer.received(() => viewer.media().length >= 2);
    viewer.send({ type: "display.ack", sequence: 1 });
    await viewer.received(() => viewer.media().length >= 3);
    // Replay sent 1 then 2; another ack for 1 is now a duplicate.
    viewer.send({ type: "display.ack", sequence: 1 });
    phone.socket.send(f.frame(3, false, 1, new Uint8Array(700_000)));
    await phone.received(() => phone.json().length >= 3);
    await viewer.roundTrip();
    expect(viewer.media()).toHaveLength(3);
  });
  it("waits for a new generation key and drops protected frames", async () => {
    const f = await fixture();
    const viewer = await f.viewer();
    const phone = await f.phone();
    await f.state();
    phone.socket.send(f.frame(1, true));
    await until(() => viewer.media().length === 1);
    await f.state("protected");
    phone.socket.send(f.frame(2));
    await until(() => phone.json().length === 2);
    await f.state("live", 2);
    phone.socket.send(f.frame(3, false, 2));
    phone.socket.send(f.frame(4, true, 2));
    await until(() => viewer.media().length === 2);
    expect(viewer.media().map((m) => m.header.sequence)).toEqual([1, 4]);
  });
  it("cancels demand grace on rejoin and stops at the grace boundary", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const viewer = await f.viewer();
    const phone = await f.phone();
    const advance = async (ms: number) => {
      f.advance(ms);
      await vi.advanceTimersByTimeAsync(ms);
    };
    const stops = () => f.sent.filter((m) => m.type === "host.integrations.display.stop");
    viewer.socket.close();
    await viewer.closed;
    await until(() => f.serverViewers.every((socket) => socket.readyState === WebSocket.CLOSED));
    await advance(4_000);
    expect(stops()).toHaveLength(0);
    const joined = await f.viewer();
    await advance(2_000);
    expect(stops()).toHaveLength(0);
    joined.socket.close();
    await joined.closed;
    await until(() => f.serverViewers.every((socket) => socket.readyState === WebSocket.CLOSED));
    await advance(4_999);
    expect(stops()).toHaveLength(0);
    await advance(1);
    expect(stops()).toHaveLength(1);
    expect(await phone.closed).toBe(1000);
  });
  it.each(["protected", "generation", "session"] as const)(
    "does not renew dropped input after %s",
    async (cause) => {
      const f = await fixture();
      const viewer = await f.viewer();
      await f.phone();
      await f.state();
      if (cause === "session") f.end();
      if (cause === "protected" || cause === "generation")
        await f.state(cause === "protected" ? "protected" : "live", cause === "generation" ? 2 : 1);
      if (viewer.socket.readyState === WebSocket.OPEN)
        viewer.send({
          type: "display.input",
          geometry: 1,
          sequence: 1,
          events: [{ kind: "nav", to: "home" }],
        });
      await delay(30);
      expect(f.activity()).toBe(0);
      expect(f.sent.filter((m) => m.type === "host.integrations.display.input")).toEqual([]);
    },
  );
  it("forwards 160 ordered inputs with interleaved acks while authorization is blocked", async () => {
    const f = await fixture();
    const viewer = await f.viewer();
    const phone = await f.phone();
    await f.state();
    for (let sequence = 1; sequence <= 4; sequence++)
      phone.socket.send(f.frame(sequence, sequence === 1));
    await until(() => viewer.media().length === 4);
    const checks = f.authorizationChecks();
    const resume = f.pauseAuthorization();
    try {
      for (let sequence = 1; sequence <= 160; sequence++) {
        viewer.send({
          type: "display.input",
          geometry: 1,
          sequence,
          events: [{ kind: "pointer", phase: "move", x: 0.5, y: 0.5, t: sequence }],
        });
        if (sequence % 40 === 0) viewer.send({ type: "display.ack", sequence: sequence / 40 });
      }
      await until(
        () => f.sent.filter((m) => m.type === "host.integrations.display.input").length === 160,
      );
      phone.socket.send(f.frame(5));
      await until(() => viewer.media().length === 5);
      expect(
        f.sent.filter((m) => m.type === "host.integrations.display.input").map((m) => m.sequence),
      ).toEqual(Array.from({ length: 160 }, (_, index) => index));
      expect(f.activity()).toBe(160);
      expect(f.authorizationChecks()).toBe(checks);
      expect(viewer.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      resume();
    }
  });
  it("tells viewers a session ended before closing them for good", async () => {
    const f = await fixture();
    const viewer = await f.viewer();
    const phone = await f.phone();
    await f.state();
    phone.socket.send(f.frame(1, true));
    await until(() => viewer.media().length === 1);
    // Pause's session end can reach the Host before the phone's own final state.
    f.hub.endSession(f.sessionId);
    expect(await viewer.closed).toBe(1000);
    expect(viewer.json().at(-1)).toMatchObject({
      type: "display.state",
      state: "stopped",
      reason: "session-ended",
      generation: 1,
    });
  });
  it("publishes a generation's key that arrives before its control-socket state", async () => {
    const f = await fixture();
    const viewer = await f.viewer();
    const phone = await f.phone();
    phone.socket.send(f.frame(1, true));
    await until(() => viewer.media().length === 1);
    expect(viewer.json().at(-1)).toMatchObject({ state: "live", generation: 1 });
    const states = viewer.json().length;
    // The phone's own announcement arrives later and changes nothing.
    await f.state("live", 1);
    await delay(20);
    expect(viewer.json()).toHaveLength(states);
    expect(f.sent.filter((m) => m.type === "host.integrations.display.refresh")).toHaveLength(0);
  });
  it("ignores late starting after media without losing deltas or cached late joins", async () => {
    const f = await fixture();
    const viewer = await f.viewer();
    const phone = await f.phone();
    phone.socket.send(f.frame(1, true));
    await until(() => viewer.media().length === 1);
    const states = viewer.json().length;
    await f.state("starting", 1);
    phone.socket.send(f.frame(2));
    await until(() => phone.json().length === 2);
    await delay(20);
    expect(viewer.json()).toHaveLength(states);
    expect(viewer.json().at(-1)).toMatchObject({ state: "live", generation: 1 });
    expect(viewer.media().map((m) => m.header.sequence)).toEqual([1, 2]);
    const joined = await f.viewer();
    await until(() => joined.media().length === 2);
    expect(joined.json()[0]).toMatchObject({ state: "live", generation: 1, replayThrough: 2 });
    expect(joined.media()).toEqual(viewer.media());
  });
  it("honors starting before the first media and before the next generation's media", async () => {
    const f = await fixture();
    const viewer = await f.viewer();
    const phone = await f.phone();
    await f.state("starting", 1);
    await until(() => viewer.json().some((m) => m.state === "starting" && m.generation === 1));
    phone.socket.send(f.frame(1, true));
    await until(() => viewer.media().length === 1);
    await f.state("starting", 2);
    const joined = await f.viewer();
    await until(() => joined.json().length === 1);
    expect(joined.json()[0]).toMatchObject({ state: "starting", generation: 2 });
    expect(joined.media()).toEqual([]);
    phone.socket.send(f.frame(2));
    phone.socket.send(f.frame(3, false, 2));
    await until(() => phone.json().length === 3);
    expect(viewer.media()).toHaveLength(1);
    expect(joined.media()).toEqual([]);
    phone.socket.send(f.frame(4, true, 2));
    await until(() => joined.media().length === 1 && viewer.media().length === 2);
    expect(joined.media()[0]?.header).toMatchObject({ generation: 2, sequence: 4, key: true });
  });
  it("withholds a protected generation's media that arrives after its protected state", async () => {
    const f = await fixture();
    const viewer = await f.viewer();
    const phone = await f.phone();
    await f.state();
    phone.socket.send(f.frame(1, true));
    await until(() => viewer.media().length === 1);
    await f.state("protected", 1);
    phone.socket.send(f.frame(2));
    phone.socket.send(f.frame(3, true));
    await until(() => phone.json().length === 3);
    expect(viewer.media()).toHaveLength(1);
    // The lift resumes in a new generation, whose key needs no announcement.
    phone.socket.send(f.frame(4, true, 2));
    await until(() => viewer.media().length === 2);
    expect(viewer.media()[1]?.header).toMatchObject({ generation: 2, key: true });
  });
  it("coalesces deferred refresh and cancels it when a key satisfies every waiter", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    await f.viewer();
    const phone = await f.phone();
    await f.state();
    const b = await f.viewer();
    await f.viewer();
    const refreshes = () => f.sent.filter((m) => m.type === "host.integrations.display.refresh");
    expect(refreshes()).toHaveLength(1);
    f.advance(499);
    await vi.advanceTimersByTimeAsync(499);
    expect(refreshes()).toHaveLength(1);
    f.advance(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshes()).toHaveLength(2);
    await f.viewer();
    phone.socket.send(f.frame(1, true));
    await until(() => b.media().length === 1);
    f.advance(500);
    await vi.advanceTimersByTimeAsync(500);
    expect(refreshes()).toHaveLength(2);
  });
  it.each(["fence", "lease"] as const)(
    "closes sockets and refuses commands after %s loss",
    async (cause) => {
      const f = await fixture();
      const viewer = await f.viewer();
      const phone = await f.phone();
      const changed = {
        ...f.stream,
        ...(cause === "fence"
          ? { fence: { ...f.fence, connectionGeneration: 2 } }
          : { streamLeaseExpiresAt: new Date(Date.now() - 1).toISOString() }),
      };
      f.apps.renew(f.peer, changed);
      const count = f.sent.length;
      const sent = await f.apps.sendDisplay(f.fence, {
        ...f.fence,
        type: "host.integrations.display.refresh",
        display: "main",
        streamId: f.start().streamId,
      });
      expect(sent).toBe(false);
      f.hub.sweep();
      expect(await viewer.closed).toBe(1013);
      await phone.closed;
      expect(f.sent).toHaveLength(count);
    },
  );
  it("burns a stale ticket even when claim fails and refuses expired data upgrades", async () => {
    const f = await fixture();
    await f.viewer();
    f.apps.renew(f.peer, { ...f.stream, fence: { ...f.fence, connectionGeneration: 2 } });
    await expect(
      f.connect("/internal/v1/computer-use/display", f.start().dataTicket),
    ).rejects.toThrow(/403/);
    expect(() => f.authenticator.verifyDisplayDataTicket(f.start().dataTicket)).toThrow(
      /already used/,
    );
    const g = await fixture();
    await g.viewer();
    g.advance(60_000);
    await expect(
      g.connect("/internal/v1/computer-use/display", g.start().dataTicket),
    ).rejects.toThrow(/401/);
  });
  it.each(["invalid-json", "unknown-field", "binary", "oversize"])(
    "rejects %s viewer commands",
    async (kind) => {
      const f = await fixture();
      const viewer = await f.viewer();
      if (kind === "invalid-json") viewer.socket.send("{");
      if (kind === "unknown-field")
        viewer.send({ type: "display.control", action: "acquire", extra: true });
      if (kind === "binary") viewer.socket.send(new Uint8Array([1]));
      if (kind === "oversize") viewer.socket.send("x".repeat(256 * 1_024 + 1));
      expect(await viewer.closed).toBe(kind === "oversize" ? 1009 : 4002);
      expect(f.sent.filter((m) => m.type === "host.integrations.display.input")).toEqual([]);
    },
  );
  it("refuses an upgrade whose owner authorization resolves after Host shutdown", async () => {
    const f = await fixture();
    const resume = f.pauseAuthorization();
    const connecting = f.viewer();
    const refused = expect(connecting).rejects.toThrow(/403/);
    await until(() => f.authorizationChecks() === 1);
    f.hub.close();
    resume();
    await refused;
    expect(f.sent).toEqual([]);
  });
  it.each(["session", "detach", "shutdown", "failed", "stopped"] as const)(
    "tears down viewers and data on %s",
    async (cause) => {
      const f = await fixture();
      const viewer = await f.viewer();
      const phone = await f.phone();
      await f.state();
      viewer.send({
        type: "display.input",
        geometry: 1,
        sequence: 0,
        events: [{ kind: "pointer", phase: "down", x: 0.5, y: 0.5, t: 0 }],
      });
      await viewer.roundTrip();
      if (cause === "session") f.end();
      if (cause === "detach") f.apps.detach(f.peer, "transport-disconnected");
      if (cause === "shutdown") await f.app.close();
      if (cause === "failed" || cause === "stopped") await f.state(cause);
      expect(await viewer.closed).toBe(cause === "shutdown" ? 1001 : 1000);
      await phone.closed;
      if (cause !== "detach") {
        expect(f.sent.slice(-2)).toMatchObject([
          {
            type: "host.integrations.display.input-reset",
          },
          { type: "host.integrations.display.stop" },
        ]);
      }
    },
  );
  it.each(["text", "malformed", "wrong-stream", "sequence", "oversize"])(
    "rejects %s media without affecting the integrations peer",
    async (kind) => {
      const f = await fixture();
      const viewer = await f.viewer();
      const phone = await f.phone();
      await f.state();
      if (kind === "text") phone.socket.send("{}");
      if (kind === "malformed") phone.socket.send(new Uint8Array([0, 0, 255, 255, 1]));
      if (kind === "wrong-stream")
        phone.socket.send(
          encodeDisplayMediaFrame(
            {
              streamId: DisplayStreamIdSchema.parse(`dsp_${randomUUID()}`),
              generation: 1,
              sequence: 1,
              key: true,
              codec: "avc1.42E01E",
              ptsUs: 0,
              width: 360,
              height: 640,
            },
            new Uint8Array([1]),
          ),
        );
      if (kind === "sequence") {
        phone.socket.send(f.frame(1, true));
        phone.socket.send(f.frame(1));
      }
      if (kind === "oversize")
        phone.socket.send(new Uint8Array(4 * 1_024 * 1_024 + 16 * 1_024 + 5));
      expect(await phone.closed).toBe(kind === "oversize" ? 1009 : 4002);
      expect(await viewer.closed).toBe(1013);
      expect(f.apps.attached(f.runnerId)).toBe(true);
    },
  );
});

describe("Mac owner input over authenticated display sockets", () => {
  it("re-resolves the same binding after readiness loss and ignores a legacy Take over", async () => {
    const negotiation = { mac: true, macOwnerInput: true, macHelperInput: true };
    const f = await fixture(true, negotiation);
    const viewer = await f.macViewer(true);
    const data = await f.phone();
    data.socket.send(f.frame(1, true));
    await viewer.received(() => viewer.media().length === 1);
    expect(viewer.json().some((message) => message.editingVersion === 1)).toBe(true);
    f.setMacHelperInput(false);
    await f.apps.handleMessage(f.peer, f.stream, {
      ...f.fence,
      type: "runner.integrations.display.source-changed",
      streamId: f.start().streamId,
      source: f.macSource,
    });
    await viewer.closed;
    const passive = await f.macViewer(true);
    await passive.roundTrip();
    expect(passive.json().every((message) => message.editingVersion === undefined)).toBe(true);
    passive.send({ type: "display.control", action: "acquire" });
    await passive.roundTrip();
    expect(
      f.sent.filter((message) => message.type === "host.integrations.mac-owner.input"),
    ).toHaveLength(0);
  });

  it("projects shared input per viewer and rechecks read-write approval without ending viewing", async () => {
    const f = await fixture(true, { mac: true });
    const a = await f.macViewer(true);
    const b = await f.macViewer(true);
    const baseline = await f.connect(
      `/v1/computer-use/views/${f.macSource.viewId}/1/display`,
      "owner",
    );
    await f.state();
    await Promise.all([a.roundTrip(), b.roundTrip(), baseline.roundTrip()]);
    expect(
      a
        .json()
        .filter((m) => m.type === "display.state")
        .at(-1).sharedInput,
    ).toBe(1);
    expect(baseline.json().at(-1).sharedInput).toBeUndefined();
    a.send({
      type: "display.input",
      geometry: 1,
      sequence: 7,
      events: [{ kind: "mouse", phase: "down", button: "left", modifiers: [], x: 0.5, y: 0.5 }],
    });
    await a.roundTrip();
    const input = f.sent.findLast((m) => m.type === "host.integrations.mac-owner.input")!;
    expect(input.sequence).toBe(0);
    await f.apps.handleMessage(f.peer, f.stream, {
      ...f.fence,
      type: "runner.integrations.mac-owner.event",
      streamId: f.start().streamId,
      source: f.macSource,
      message: { type: "display.input.result", sequence: 0, outcome: "dispatched" },
    });
    await Promise.all([a.roundTrip(), b.roundTrip()]);
    expect(a.json()).toContainEqual({
      type: "display.input.result",
      sequence: 7,
      outcome: "dispatched",
    });
    expect(b.json().every((m) => m.type !== "display.input.result")).toBe(true);
    f.inputAuthorization(false);
    f.advance(5001);
    f.hub.sweep();
    await until(
      () =>
        a
          .json()
          .filter((m) => m.type === "display.state")
          .at(-1).sharedInput === undefined,
    );
    expect(a.socket.readyState).toBe(WebSocket.OPEN);
    expect(f.sent.filter((m) => m.type === "host.integrations.mac-owner.input-reset")).toHaveLength(
      1,
    );
    f.inputAuthorization(true);
    f.advance(5001);
    f.hub.sweep();
    await until(
      () =>
        a
          .json()
          .filter((m) => m.type === "display.state")
          .at(-1).sharedInput === 1,
    );
  });

  it("tells an idle Mac viewer when its approval is granted or removed", async () => {
    const f = await fixture(true, { mac: true });
    f.inputAuthorization(false);
    const idle = await f.macViewer(true);
    await f.state();
    await idle.roundTrip();
    const projected = () =>
      idle
        .json()
        .filter((m) => m.type === "display.state")
        .at(-1)?.sharedInput;
    expect(projected()).toBeUndefined();
    // The viewer never sent input: approval alone must make it usable.
    f.inputAuthorization(true);
    f.advance(5001);
    f.hub.sweep();
    await until(() => projected() === 1);
    f.inputAuthorization(false);
    f.advance(5001);
    f.hub.sweep();
    await until(() => projected() === undefined);
    expect(idle.socket.readyState).toBe(WebSocket.OPEN);
  });

  it.each([
    { macOwnerInput: false, macHelperInput: false },
    { macOwnerInput: false, macHelperInput: true },
    { macOwnerInput: true, macHelperInput: false },
  ])("keeps viewing passive when a Mac hop has not negotiated input: %j", async (negotiation) => {
    const f = await fixture(true, { mac: true, ...negotiation });
    const viewer = await f.macViewer(true);
    const data = await f.phone();
    const binary = f.frame(1, true);
    data.socket.send(binary);
    await viewer.received(() => viewer.media().length === 1);
    const original = decodeDisplayMediaFrame(binary);
    const { streamId: _streamId, ...header } = original.header;
    expect(viewer.media()[0]!.header).toEqual(header);
    expect(Array.from(viewer.media()[0]!.payload)).toEqual(Array.from(original.payload));
    expect(viewer.json().every((message) => message.editingVersion === undefined)).toBe(true);
    viewer.send({ type: "display.control", action: "acquire" });
    await viewer.roundTrip();
    expect(
      f.sent.filter((message) => message.type === "host.integrations.mac-owner.input"),
    ).toHaveLength(0);
    viewer.send({
      type: "display.input",

      geometry: 1,
      sequence: 0,
      events: [{ kind: "copy" }],
    });
    await viewer.roundTrip();
    expect(
      f.sent.filter((message) => message.type === "host.integrations.mac-owner.input"),
    ).toHaveLength(0);
    const resolves = f.sent.filter(
      (message) => message.type === "host.integrations.display.resolve",
    );
    expect(resolves.length).toBeGreaterThan(0);
    expect(
      resolves.every((message) => (message.ownerInputVersion === 2) === negotiation.macOwnerInput),
    ).toBe(true);
    const out = process.env.OPENSTEER_MAC_INPUT_ARTIFACT_DIR;
    if (out) {
      await mkdir(out, { recursive: true });
      await writeFile(
        path.join(
          out,
          `host-display-negotiation-${Number(negotiation.macOwnerInput)}-${Number(negotiation.macHelperInput)}.json`,
        ),
        JSON.stringify(
          {
            passed: true,
            boundary: "real Host sockets with scripted Mac peer",
            negotiation,
            frames: viewer.json(),
            commands: f.sent,
            mediaHeader: viewer.media()[0]!.header,
            payloadHex: Buffer.from(viewer.media()[0]!.payload).toString("hex"),
          },
          null,
          2,
        ),
      );
    }
  });
});
