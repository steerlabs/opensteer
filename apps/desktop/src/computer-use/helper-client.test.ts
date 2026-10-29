import { spawn } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  computerUseHelperProtocolVersion,
  computerUseOutOfTimeSentence,
} from "@opensteer/protocol";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComputerUseHelperClient,
  ComputerUseHelperDeadlineFailure,
  ComputerUseHelperFailure,
  computerUseHelperUpdatingSentence,
  computerUseUpdateSentence,
} from "./helper-client.js";
import { computerUseFrameReader, encodeComputerUseFrame } from "./helper-frames.js";
import {
  ComputerUseLifecycleLockBusy,
  withComputerUseHelperLifecycleLock,
  type ComputerUseHelperProcess,
} from "./helper-install.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("computer use framing", () => {
  it("round-trips a frame split across arbitrary chunks", () => {
    const frame = encodeComputerUseFrame({ id: 4, method: "permissions.get", params: {} });
    const reader = computerUseFrameReader();

    // Nothing is parsed before a whole body has arrived.
    expect(reader.push(frame.subarray(0, 2))).toEqual([]);
    expect(reader.push(frame.subarray(2, 7))).toEqual([]);
    expect(reader.push(frame.subarray(7))).toEqual([
      { id: 4, method: "permissions.get", params: {} },
    ]);
  });

  it("reads several frames out of one chunk, in order", () => {
    const reader = computerUseFrameReader();
    const chunk = Buffer.concat([
      encodeComputerUseFrame({ id: 0, result: {} }),
      encodeComputerUseFrame({ id: 1, result: { ok: true } }),
    ]);

    expect(reader.push(chunk)).toEqual([
      { id: 0, result: {} },
      { id: 1, result: { ok: true } },
    ]);
  });

  it("refuses a header that claims more than the frame budget", () => {
    const reader = computerUseFrameReader();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(0xff_ff_ff_ff, 0);

    expect(() => reader.push(header)).toThrow(/exceeds/u);
  });
});

// The lifecycle lock is the kernel's, so this runs in the macOS CI job.
describe.runIf(process.platform === "darwin")("ComputerUseHelperClient", () => {
  it("says hello first and answers requests by id", async () => {
    const harness = await helperHarness();
    harness.reply("permissions.get", () => ({
      permissions: { accessibility: "granted", screenRecording: "denied" },
    }));

    await expect(harness.client.request("permissions.get", {})).resolves.toEqual({
      permissions: { accessibility: "granted", screenRecording: "denied" },
    });
    expect(harness.received[0]).toMatchObject({
      method: "hello",
      params: { clientVersion: "9.9.9", protocolVersion: computerUseHelperProtocolVersion },
    });
    expect(harness.received[1]).toMatchObject({ method: "permissions.get" });
    // A request whose caller named no deadline still carries one, which the
    // helper holds it to.
    expect(harness.received[1]).toMatchObject({ timeoutMs: 2_000 });
    // The socket was already there, so nothing was launched.
    expect(harness.commands()).not.toContain("/usr/bin/open");
  });

  it("surfaces incompatible-version with the update sentence", async () => {
    const harness = await helperHarness({
      hello: {
        helperVersion: "9",
        minProtocolVersion: computerUseHelperProtocolVersion + 1,
        routes: { windowLocation: true, windowGroups: true },
        permissions: { accessibility: "denied", screenRecording: "denied" },
        protocolVersion: computerUseHelperProtocolVersion + 2,
      },
    });

    const failure = await harness.client.request("permissions.get", {}).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ComputerUseHelperFailure);
    expect((failure as ComputerUseHelperFailure).code).toBe("incompatible-version");
    expect((failure as ComputerUseHelperFailure).message).toBe(computerUseUpdateSentence);
  });

  it("says Computer use is updating when the helper is older than this app", async () => {
    const harness = await helperHarness({
      hello: {
        helperVersion: "9",
        minProtocolVersion: 10,
        routes: { windowLocation: true, windowGroups: true },
        permissions: { accessibility: "denied", screenRecording: "denied" },
        protocolVersion: computerUseHelperProtocolVersion - 1,
      },
    });

    const failure = await harness.client.request("permissions.get", {}).catch((e: unknown) => e);

    // Updating Opensteer cannot help: this app already ships the newer helper,
    // and the next request installs it.
    expect(failure).toBeInstanceOf(ComputerUseHelperFailure);
    expect((failure as ComputerUseHelperFailure).code).toBe("incompatible-version");
    expect((failure as ComputerUseHelperFailure).message).toBe(computerUseHelperUpdatingSentence);
  });

  it("reads a helper's refusal of this app's hello by the protocol its bundle declares", async () => {
    // What every released helper answers whichever side is older.
    const refusal = {
      code: "incompatible-version",
      message: "This Mac's Opensteer Computer Use speaks protocol 3–7; update Opensteer.",
    };
    const undeclared = await helperHarness({ helperProtocolVersion: null });
    undeclared.fail("hello", refusal);
    const newer = await helperHarness({
      helperProtocolVersion: computerUseHelperProtocolVersion + 1,
    });
    newer.fail("hello", refusal);

    // A helper that declares no protocol predates this app's.
    await expect(undeclared.client.request("permissions.get", {})).rejects.toMatchObject({
      code: "incompatible-version",
      message: computerUseHelperUpdatingSentence,
    });
    await expect(newer.client.request("permissions.get", {})).rejects.toMatchObject({
      code: "incompatible-version",
      message: computerUseUpdateSentence,
    });
  });

  it("accepts a helper whose range still contains our version", async () => {
    const harness = await helperHarness({
      hello: {
        helperVersion: "42",
        minProtocolVersion: 10,
        routes: { windowLocation: true, windowGroups: true },
        permissions: { accessibility: "granted", screenRecording: "granted" },
        protocolVersion: computerUseHelperProtocolVersion + 3,
      },
    });

    await expect(harness.client.handshake()).resolves.toEqual({
      helperVersion: "42",
      permissions: { accessibility: "granted", screenRecording: "granted" },
    });
  });

  it("returns the helper's own refusal code", async () => {
    const harness = await helperHarness();
    harness.fail("app.resolve", { code: "app-not-allowed", message: "Terminal is not allowed." });

    const failure = await harness.client
      .request("app.resolve", { app: "Terminal" })
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ComputerUseHelperFailure);
    expect((failure as ComputerUseHelperFailure).code).toBe("app-not-allowed");
  });

  it("delivers events to every listener", async () => {
    const harness = await helperHarness();
    const seen: unknown[] = [];
    harness.client.onEvent((event) => seen.push(event));
    await harness.client.handshake();

    harness.emit({
      event: "session.stopped",
      params: {
        reason: "user",
        sessionId: "cus_3f1a2b4c-5d6e-4f80-9a1b-2c3d4e5f6071",
      },
    });
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(seen[0]).toMatchObject({ event: "session.stopped" });
  });

  it("reconnects transparently after the helper exits once", async () => {
    const harness = await helperHarness();
    harness.reply("permissions.get", () => ({
      permissions: { accessibility: "granted", screenRecording: "granted" },
    }));
    await harness.client.handshake();
    const disconnected = vi.fn();
    harness.client.onDisconnect(disconnected);

    // This is what granting Screen Recording does: the helper quits itself so
    // ScreenCaptureKit reads the new grant at process start.
    harness.dropConnections();
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalled());

    await expect(harness.client.request("permissions.get", {})).resolves.toMatchObject({
      permissions: { accessibility: "granted", screenRecording: "granted" },
    });
    expect(harness.helloCount).toBe(2);
  });

  it("announces an explicit disconnect synchronously and only once", async () => {
    const harness = await helperHarness();
    await harness.client.handshake();
    const disconnected = vi.fn();
    harness.client.onDisconnect(disconnected);

    const ending = harness.client.disconnect();
    expect(disconnected).toHaveBeenCalledOnce();
    await ending;
    expect(disconnected).toHaveBeenCalledOnce();

    await expect(harness.client.handshake()).resolves.toMatchObject({ helperVersion: "1" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it("refuses a result the helper's own schema does not accept", async () => {
    const harness = await helperHarness();
    harness.reply("permissions.get", () => ({ permissions: { accessibility: "maybe" } }));

    await expect(harness.client.request("permissions.get", {})).rejects.toThrow(/could not read/u);
  });

  it("reports an unreadable action result as outcome unknown", async () => {
    const harness = await helperHarness();
    harness.reply("session.act", () => ({}));

    const failure = await harness.client
      .request("session.act", {})
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ComputerUseHelperFailure);
    expect((failure as ComputerUseHelperFailure).code).toBe("outcome-unknown");
  });

  it("gives up a late action alone and keeps the connection for everything else", async () => {
    const harness = await helperHarness();
    harness.silence("session.act");
    const disconnected = vi.fn();
    harness.client.onDisconnect(disconnected);
    await harness.client.handshake();
    harness.clock.at = 5_000;

    const failure = await harness.client
      .request("session.act", {}, { deadline: 5_020 })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ComputerUseHelperDeadlineFailure);
    expect((failure as ComputerUseHelperFailure).code).toBe("outcome-unknown");
    // The deadline reached the helper in the frame, so it could refuse the
    // work had it still been queued.
    expect(harness.received).toContainEqual(
      expect.objectContaining({ method: "session.act", timeoutMs: 20 }),
    );
    // Every other session shares this connection; one late answer ends none.
    expect(disconnected).not.toHaveBeenCalled();
    expect(harness.client.connected).toBe(true);
    harness.reply("permissions.get", () => ({
      permissions: { accessibility: "granted", screenRecording: "granted" },
    }));
    await expect(harness.client.request("permissions.get", {})).resolves.toMatchObject({
      permissions: { accessibility: "granted" },
    });
    expect(harness.helloCount).toBe(1);
  });

  it("abandons an aborted action without dropping the connection", async () => {
    const harness = await helperHarness();
    harness.silence("session.act");
    const disconnected = vi.fn();
    harness.client.onDisconnect(disconnected);
    const controller = new AbortController();
    const pending = harness.client
      .request("session.act", {}, { signal: controller.signal })
      .catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(harness.received).toContainEqual(expect.objectContaining({ method: "session.act" })),
    );

    controller.abort();
    const failure = await pending;

    expect(failure).toBeInstanceOf(ComputerUseHelperFailure);
    expect((failure as ComputerUseHelperFailure).code).toBe("outcome-unknown");
    expect(disconnected).not.toHaveBeenCalled();
    expect(harness.client.pendingRequests).toBe(0);
  });

  it("launches the helper through open -g when the socket is absent", async () => {
    const harness = await helperHarness({ startListening: false });

    // Nothing is listening, so the first request must start the helper. The
    // fake `open` brings the listener up, as LaunchServices would.
    await expect(harness.client.handshake()).resolves.toMatchObject({ helperVersion: "1" });
    expect(harness.commands()).toContain(`/usr/bin/open -g -a ${harness.helperAppPath}`);
    // The signature is checked before anything is launched.
    expect(harness.commands().indexOf("/usr/bin/codesign")).toBeLessThan(
      harness.commands().indexOf("/usr/bin/open"),
    );
    await expect(harness.lifecycleLockHeldAtSocketReadiness).resolves.toBe(true);
  });

  it("waits for a helper replacement to finish before launching", async () => {
    const harness = await helperHarness({ startListening: false });
    const installer = holdLock(harness.helperLockPath);
    await installer.held;

    const connecting = harness.client.handshake();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    expect(harness.commands()).not.toContain("/usr/bin/open");

    installer.release();
    await expect(connecting).resolves.toMatchObject({ helperVersion: "1" });
    expect(harness.commands()).toContain("/usr/bin/open");
  });

  it("refuses to launch a helper signed by somebody else", async () => {
    const harness = await helperHarness({ startListening: false, teamId: "OTHERTEAM" });

    await expect(harness.client.handshake()).rejects.toThrow(/not signed by Opensteer/u);
    expect(harness.commands()).not.toContain("/usr/bin/open");
  });

  it("verifies the connected socket peer before sending hello", async () => {
    const verifyPeer = vi.fn(async () => {
      throw new Error("wrong peer");
    });
    const harness = await helperHarness({ verifyPeer });

    await expect(harness.client.handshake()).rejects.toThrow(/socket is not owned/u);
    // The verifier is the copy sealed inside this app, never the installed
    // one in a folder anything running as this user could rewrite.
    expect(verifyPeer).toHaveBeenCalledWith(
      path.join(harness.verifierAppPath, "Contents", "MacOS", "Opensteer Computer Use"),
      expect.anything(),
    );
    expect(harness.received).toEqual([]);
  });

  it("launches a fresh instance rather than trusting the socket an unverifiable helper holds", async () => {
    const harness = await helperHarness({ launchFreshInstance: true });

    await expect(harness.client.handshake()).resolves.toMatchObject({ helperVersion: "1" });

    expect(harness.commands()).toContain(`/usr/bin/open -n -g -a ${harness.helperAppPath}`);
    // The listener that held the socket at launch was never spoken to: the
    // new instance's was, once it had bound the path again.
    expect(harness.connectionsPerServer()).toEqual([0, 1]);

    // Once is enough: later connections trust the socket as usual.
    harness.dropConnections();
    await vi.waitFor(() => expect(harness.client.connected).toBe(false));
    await expect(harness.client.handshake()).resolves.toMatchObject({ helperVersion: "1" });
    expect(harness.commands().match(/\/usr\/bin\/open/gu)).toHaveLength(1);
  });

  it("resumes replies after lending the connected socket to a peer-verifier process", async () => {
    const verifyPeer = async (_executable: string, socket: Socket): Promise<void> =>
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
          stdio: ["ignore", "ignore", "ignore", socket],
        });
        child.once("error", rejectPromise);
        child.once("exit", (code, signal) => {
          if (code === 0) resolvePromise();
          else rejectPromise(new Error(`peer verifier exited with ${signal ?? String(code)}`));
        });
      });
    const harness = await helperHarness({ verifyPeer });

    await expect(harness.client.handshake()).resolves.toMatchObject({ helperVersion: "1" });
    expect(harness.received[0]).toMatchObject({ method: "hello" });
  });

  it("fences a delayed establishment before a replacement connection starts", async () => {
    let releaseFirst: () => void = () => undefined;
    let verifierCalls = 0;
    const verifyPeer = vi.fn(async () => {
      verifierCalls += 1;
      if (verifierCalls !== 1) return;
      await new Promise<void>((resolvePromise) => {
        releaseFirst = resolvePromise;
      });
    });
    const harness = await helperHarness({ verifyPeer });
    const first = harness.client.handshake().catch((error: unknown) => error);
    await vi.waitFor(() => expect(verifyPeer).toHaveBeenCalledOnce());

    await harness.client.disconnect();
    await expect(harness.client.handshake()).resolves.toMatchObject({ helperVersion: "1" });
    releaseFirst();
    await expect(first).resolves.toBeInstanceOf(ComputerUseHelperFailure);

    harness.reply("permissions.get", () => ({
      permissions: { accessibility: "granted", screenRecording: "granted" },
    }));
    await expect(harness.client.request("permissions.get", {})).resolves.toMatchObject({
      permissions: { accessibility: "granted", screenRecording: "granted" },
    });
    expect(harness.helloCount).toBe(1);
  });

  it("bounds a peer verifier that never returns", async () => {
    const harness = await helperHarness({
      peerVerificationTimeoutMs: 5,
      verifyPeer: async () => await new Promise<void>(() => undefined),
    });

    await expect(harness.client.handshake()).rejects.toThrow(/socket is not owned/u);
    expect(harness.received).toEqual([]);
  });
});

// The lifecycle lock is the kernel's, so this runs in the macOS CI job.
describe.runIf(process.platform === "darwin")(
  "one deadline through connecting to the helper",
  () => {
    it("forwards only what is left after waiting for the lifecycle lock", async () => {
      const harness = await helperHarness();
      const installer = holdLock(harness.helperLockPath);
      await installer.held;

      const answer = harness.client.request("permissions.get", {}, { deadline: 3_000 });
      // Another Opensteer holds the lock for 700 ms of this request's time.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
      harness.clock.at += 700;
      installer.release();

      await expect(answer).resolves.toBeDefined();
      expect(methodFrames(harness.received, "hello")).toEqual([
        expect.objectContaining({ timeoutMs: 1_300 }),
      ]);
      expect(methodFrames(harness.received, "permissions.get")).toEqual([
        expect.objectContaining({ timeoutMs: 1_300 }),
      ]);
    });

    it("writes nothing when the lifecycle lock outlasts the deadline", async () => {
      const harness = await helperHarness();
      const installer = holdLock(harness.helperLockPath);
      await installer.held;

      const answer = harness.client
        .request("session.act", {}, { deadline: 3_000 })
        .catch((error: unknown) => error);
      harness.clock.at += 2_500;

      await expect(answer).resolves.toBeInstanceOf(ComputerUseLifecycleLockBusy);
      installer.release();
      expect(harness.received).toEqual([]);
    });

    it("does not delay reconnecting after only the caller's deadline expired", async () => {
      const harness = await helperHarness();
      const installer = holdLock(harness.helperLockPath);
      await installer.held;
      const expired = harness.client
        .request("permissions.get", {}, { deadline: 3_000 })
        .catch((error: unknown) => error);
      harness.clock.at = 3_500;
      await expect(expired).resolves.toBeInstanceOf(ComputerUseLifecycleLockBusy);
      installer.release();
      await installer.done;

      const timers = vi.spyOn(globalThis, "setTimeout");
      try {
        await expect(harness.client.request("permissions.get", {})).resolves.toBeDefined();
        // The deadline was a caller budget, not a failed helper: no retry backoff.
        expect(timers.mock.calls.some(([, milliseconds]) => milliseconds === 250)).toBe(false);
      } finally {
        timers.mockRestore();
      }
    });

    it("forwards only what is left after a slow handshake", async () => {
      const harness = await helperHarness();
      harness.holdHellos();

      const answer = harness.client.request("permissions.get", {}, { deadline: 3_000 });
      await vi.waitFor(() => expect(harness.helloCount).toBe(1));
      harness.clock.at += 600;
      harness.answerHellos();

      await expect(answer).resolves.toBeDefined();
      expect(methodFrames(harness.received, "hello")).toEqual([
        expect.objectContaining({ timeoutMs: 2_000 }),
      ]);
      expect(methodFrames(harness.received, "permissions.get")).toEqual([
        expect.objectContaining({ timeoutMs: 1_400 }),
      ]);
    });

    it("writes no request whose deadline passed during the handshake", async () => {
      const harness = await helperHarness();
      harness.holdHellos();

      const answer = harness.client
        .request("session.act", {}, { deadline: 3_000 })
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(harness.helloCount).toBe(1));
      harness.clock.at += 2_500;
      harness.answerHellos();

      const failure = await answer;
      // Not done, rather than unknown: nothing about this request left the Mac's app.
      expect(failure).toBeInstanceOf(ComputerUseHelperFailure);
      expect(failure).toMatchObject({ code: "failed", message: computerUseOutOfTimeSentence });
      expect(failure).not.toBeInstanceOf(ComputerUseHelperDeadlineFailure);
      expect(methodFrames(harness.received, "session.act")).toEqual([]);
    });

    it("establishes to the latest deadline of the requests waiting on it", async () => {
      const harness = await helperHarness();
      const installer = holdLock(harness.helperLockPath);
      await installer.held;

      const short = harness.client
        .request("permissions.get", {}, { deadline: 1_500 })
        .catch((error: unknown) => error);
      const long = harness.client.request("permissions.get", {}, { deadline: 5_000 });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
      // Past the first request's deadline but not the second's: the connection
      // they share keeps waiting for the lock on the second one's behalf.
      harness.clock.at += 1_000;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
      installer.release();

      await expect(long).resolves.toBeDefined();
      await expect(short).resolves.toMatchObject({ message: computerUseOutOfTimeSentence });
      // Only the second request reached the helper, with what it had left.
      expect(methodFrames(harness.received, "permissions.get")).toEqual([
        expect.objectContaining({ timeoutMs: 3_000 }),
      ]);
    });
  },
);

/** Another Opensteer holding the lifecycle lock until `release`. */
/** A helper writes only to a client still connected to read it. */
function writeToClient(socket: Socket, frame: unknown): void {
  if (socket.writable) socket.write(encodeComputerUseFrame(frame));
}

/** The client closed its end, so the helper's write or read on it failed. */
function clientHungUp(error: Error): boolean {
  const code = nodeErrorCode(error);
  return code === "EPIPE" || code === "ECONNRESET";
}

function holdLock(lockPath: string) {
  let release: () => void = () => undefined;
  let held: () => void = () => undefined;
  const heldPromise = new Promise<void>((resolvePromise) => {
    held = resolvePromise;
  });
  const done = withComputerUseHelperLifecycleLock(
    { deadline: { at: Date.now() + 5_000 }, lockPath },
    async () => {
      held();
      await new Promise<void>((resolvePromise) => {
        release = resolvePromise;
      });
    },
  );
  cleanups.push(async () => {
    release();
    await done;
  });
  return { done, held: heldPromise, release: () => release() };
}

function methodFrames(received: readonly unknown[], method: string): readonly unknown[] {
  return received.filter((frame) => (frame as { readonly method?: unknown }).method === method);
}

async function helperHarness(
  options: {
    readonly hello?: Record<string, unknown>;
    readonly helperProtocolVersion?: number | null;
    readonly launchFreshInstance?: boolean;
    readonly startListening?: boolean;
    readonly teamId?: string | null;
    readonly peerVerificationTimeoutMs?: number;
    readonly verifyPeer?: (executable: string, socket: Socket) => Promise<void>;
  } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), "opensteer-cu-client-"));
  const socketPath = path.join(directory, "ipc.sock");
  const helperAppPath = path.join(directory, "Opensteer Computer Use.app");
  const verifierAppPath = path.join(directory, "Opensteer.app", "Opensteer Computer Use.app");
  const helperLockPath = path.join(directory, "install.lock");
  const received: unknown[] = [];
  const handlers = new Map<string, (params: unknown) => unknown>([
    [
      "permissions.get",
      () => ({ permissions: { accessibility: "denied", screenRecording: "denied" } }),
    ],
  ]);
  const failures = new Map<string, { code: string; message: string }>();
  const silentMethods = new Set<string>();
  const sockets = new Set<Socket>();
  // The client's clock, which moves only when a test moves it: every
  // `timeoutMs` a frame carries is then exact.
  const clock = { at: 1_000 };
  let helloCount = 0;
  let heldHellos: (() => void)[] | null = null;
  let lifecycleLockHeldAtSocketReadiness = Promise.resolve(false);
  const hello = options.hello ?? {
    helperVersion: "1",
    minProtocolVersion: 10,
    routes: { windowLocation: true, windowGroups: true },
    permissions: { accessibility: "denied", screenRecording: "denied" },
    protocolVersion: computerUseHelperProtocolVersion,
  };
  const servers: Server[] = [];
  const connections: number[] = [];
  const createHelperServer = (): Server => {
    const index = servers.length;
    connections.push(0);
    const created = createServer((socket) => serve(index, socket));
    servers.push(created);
    return created;
  };
  const serve = (index: number, socket: Socket): void => {
    connections[index] = (connections[index] ?? 0) + 1;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    // A client that hangs up before its answer ends the connection, as it
    // would a real helper's; any other socket fault still fails the run.
    socket.on("error", (error) => {
      if (!clientHungUp(error)) throw error;
      socket.destroy();
    });
    const reader = computerUseFrameReader();
    socket.on("data", (chunk: Buffer) => {
      for (const frame of reader.push(chunk)) {
        received.push(frame);
        const { id, method, params } = frame as { id: number; method: string; params: unknown };
        if (method === "hello") {
          helloCount += 1;
          const refusal = failures.get(method);
          if (refusal) {
            writeToClient(socket, { error: refusal, id });
            continue;
          }
          const answer = (): void => {
            writeToClient(socket, { id, result: hello });
          };
          if (heldHellos) heldHellos.push(answer);
          else answer();
          continue;
        }
        const failure = failures.get(method);
        if (failure) {
          writeToClient(socket, { error: failure, id });
          continue;
        }
        if (silentMethods.has(method)) continue;
        writeToClient(socket, { id, result: handlers.get(method)?.(params) ?? {} });
      }
    });
  };
  // A launch is a new process binding the path, as the helper does on start,
  // while an older listener that lost the path keeps running.
  const listen = async () => {
    const server = createHelperServer();
    await new Promise<void>((resolvePromise) => server.listen(socketPath, resolvePromise));
  };
  if (options.startListening !== false) await listen();
  const calls: string[][] = [];
  const run: ComputerUseHelperProcess = async (file, arguments_) => {
    calls.push([file, ...arguments_]);
    if (file === "/usr/bin/codesign") {
      // The fake helper is signed by Opensteer's team, so only a requirement
      // naming that team is satisfied.
      const requirement = arguments_.find((argument) => argument.startsWith("-R="));
      if (requirement && !requirement.includes('"ABCDE12345"')) {
        throw new Error("test-requirement: code failed to satisfy specified code requirement(s)");
      }
      return "Identifier=com.opensteer.computer-use\nAuthority=Developer ID Application: Example\nTeamIdentifier=ABCDE12345\nCDHash=abc123\n";
    }
    if (file === "/usr/bin/open") {
      // Asked the instant before the socket becomes ready, with no time to
      // wait: refused only while somebody holds the lock.
      lifecycleLockHeldAtSocketReadiness = withComputerUseHelperLifecycleLock(
        { deadline: { at: 0 }, lockPath: helperLockPath },
        async () => false,
      ).catch(() => true);
      await lifecycleLockHeldAtSocketReadiness;
      await listen();
      return "";
    }
    throw new Error(`unexpected command ${file}`);
  };
  const client = new ComputerUseHelperClient({
    ...(options.launchFreshInstance ? { launchFreshInstance: true } : {}),
    appBundleId: "com.opensteer.opensteer",
    appVersion: "9.9.9",
    helperAppPath,
    helperLockPath,
    ...(options.helperProtocolVersion === undefined
      ? {}
      : { helperProtocolVersion: options.helperProtocolVersion }),
    launchTimeoutMs: 2_000,
    now: () => clock.at,
    requestTimeoutMs: 2_000,
    ...(options.peerVerificationTimeoutMs === undefined
      ? {}
      : { peerVerificationTimeoutMs: options.peerVerificationTimeoutMs }),
    run,
    socketPath,
    teamId: options.teamId === undefined ? "ABCDE12345" : options.teamId,
    verifierAppPath,
    verifyPeer: options.verifyPeer ?? (async () => undefined),
  });
  cleanups.push(async () => {
    await client.close();
    for (const socket of sockets) socket.destroy();
    for (const server of servers) {
      if (server.listening) {
        await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      }
    }
    await rm(directory, { force: true, recursive: true });
  });
  return {
    client,
    clock,
    commands: () => calls.map((call) => call.join(" ")).join("\n"),
    connectionsPerServer: () => [...connections],
    /** Keeps every hello unanswered until `answerHellos`. */
    holdHellos: () => {
      heldHellos = [];
    },
    answerHellos: () => {
      const held = heldHellos ?? [];
      heldHellos = null;
      for (const answer of held) answer();
    },
    dropConnections: () => {
      for (const socket of sockets) socket.destroy();
    },
    emit: (event: unknown) => {
      for (const socket of sockets) writeToClient(socket, event);
    },
    fail: (method: string, error: { code: string; message: string }) => failures.set(method, error),
    helperAppPath,
    helperLockPath,
    get lifecycleLockHeldAtSocketReadiness() {
      return lifecycleLockHeldAtSocketReadiness;
    },
    get helloCount() {
      return helloCount;
    },
    received,
    reply: (method: string, handler: (params: unknown) => unknown) => handlers.set(method, handler),
    silence: (method: string) => silentMethods.add(method),
    verifierAppPath,
  };
}
