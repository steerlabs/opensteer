import { createId, type RunId, type RunnerId } from "@opensteer/core";
import {
  machineAccessMaxActiveSessions,
  machineAccessMaxRunSessions,
  shellAuditEventCap,
  ShellSessionIdSchema,
  type ShellSessionId,
} from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import type { AgentControlRunScope } from "../agents/agent-control-service.js";
import { ShellConnectRejection } from "./shell-connect-error.js";
import { ShellHub } from "./shell-hub.js";
import {
  auxiliaryStream,
  byteSocket,
  controlPeer,
  fakeShellStore,
  fakeTicketAuthenticator,
  recordingNotifier,
  runScope,
} from "./shell-hub.test-support.js";

function harness(options: { readonly openTimeoutMs?: number; readonly stallSends?: boolean } = {}) {
  const owner = createId("user");
  const target = createId("runner");
  const callerRunnerId = createId("runner");
  const store = fakeShellStore(owner);
  const authenticator = fakeTicketAuthenticator();
  const notifier = recordingNotifier();
  const onAuditError = vi.fn();
  const onControlError = vi.fn();
  // A clock the test moves, so "the ticket ran out while this waited its turn"
  // is a fact rather than a sleep.
  const clock = { value: Date.now() };
  let scope = runScope({ requestedBy: owner, runnerId: callerRunnerId });
  const tokens = {
    authenticate: vi.fn(async () => scope),
    reauthorize: vi.fn(async () => scope),
  };
  const hub = new ShellHub({
    authenticator,
    callerTokens: tokens as never,
    notifier,
    now: () => clock.value,
    onAuditError,
    onControlError,
    ...(options.openTimeoutMs === undefined ? {} : { openTimeoutMs: options.openTimeoutMs }),
    runners: { identityForRunner: () => ({ name: "cloud-1" }) } as never,
    store,
    terminationDeadlineMs: 5,
  });
  const peer = controlPeer(options.stallSends ? { stall: true } : {});
  const stream = auxiliaryStream({ runnerId: target });
  hub.attach(peer, stream);
  return {
    authenticator,
    callerRunnerId,
    clock,
    hub,
    notifier,
    onAuditError,
    onControlError,
    owner,
    peer,
    setScope: (next: AgentControlRunScope) => {
      scope = next;
    },
    get scope() {
      return scope;
    },
    store,
    stream,
    target,
    tokens,
  };
}

interface Machine {
  readonly peer: ReturnType<typeof controlPeer>;
  readonly stream: ReturnType<typeof auxiliaryStream>;
  readonly target: RunnerId;
}

/** A second computer on the same Host, with a control stream of its own. */
function attachMachine(context: ReturnType<typeof harness>): Machine {
  const target = createId("runner");
  const peer = controlPeer();
  const stream = auxiliaryStream({ runnerId: target });
  context.hub.attach(peer, stream);
  return { peer, stream, target };
}

/**
 * Drives one session from a reservation to an active pipe, the way the target
 * and the routes do: the data socket pairs on its ticket, the Runner reports
 * `opened`, and only then does the caller's promise resolve.
 */
async function openSession(
  context: ReturnType<typeof harness>,
  input: { readonly machine?: Machine; readonly signal?: AbortSignal } = {},
) {
  const machine = input.machine ?? context;
  const controller = new AbortController();
  const already = machine.peer.sent.length;
  const connecting = context.hub.connect({
    signal: input.signal ?? controller.signal,
    target: machine.target,
    token: "caller-token",
  });
  const open = await vi.waitFor(() => {
    const message = machine.peer.sent
      .slice(already)
      .find((sent) => sent.type === "host.shell.session.open");
    if (!message) throw new Error("no open yet");
    return message;
  });
  // A reservation that is ended rather than activated rejects; the test that
  // cares asserts on it, and the ones that do not must not see it as unhandled.
  void connecting.catch(() => undefined);
  return { connecting, controller, open };
}

async function activate(
  context: ReturnType<typeof harness>,
  session: Awaited<ReturnType<typeof openSession>>,
  machineInput?: Machine,
) {
  const machine = machineInput ?? context;
  if (session.open.type !== "host.shell.session.open") throw new Error("unreachable");
  const data = byteSocket();
  const sessionId = await context.hub.claimDataSocket(session.open.dataTicket);
  context.hub.attachDataSocket(sessionId, data);
  await context.hub.handleMessage(machine.peer, machine.stream, {
    ...machine.stream.fence,
    sessionId,
    type: "runner.shell.session.opened",
  });
  await session.connecting;
  const caller = byteSocket();
  context.hub.attachCaller(sessionId, caller);
  return { caller, data, sessionId };
}

describe("ShellHub admission", () => {
  it("refuses every rejection with its own sentence, naming the computer", async () => {
    const context = harness();
    const controller = new AbortController();
    const connect = () =>
      context.hub.connect({
        signal: controller.signal,
        target: context.target,
        token: "caller-token",
      });

    context.tokens.authenticate.mockRejectedValueOnce(new Error("binding gone"));
    await expect(connect()).rejects.toMatchObject({
      code: "run_invalid",
      message: "This Run has ended.",
    });

    context.store.state.present = false;
    await expect(connect()).rejects.toMatchObject({
      code: "target_unknown",
      message: `No computer ${context.target} is enrolled in this Deployment.`,
    });
    context.store.state.present = true;

    context.store.state.machine.shell = null;
    await expect(connect()).rejects.toMatchObject({
      code: "module_unavailable",
      message:
        "example-mac cannot accept connections from other computers yet; update Opensteer on it.",
    });
    context.store.state.machine.shell = { hostPublicKey: "ssh-ed25519 AAAA", platform: "darwin" };

    context.store.state.machine.policy = {
      ...context.store.state.machine.policy,
      reach: "nobody",
    };
    await expect(connect()).rejects.toMatchObject({
      code: "reach_denied",
      message: "example-mac does not allow access from other computers.",
    });
    context.store.state.machine.policy = {
      ...context.store.state.machine.policy,
      reach: "owner",
    };

    context.store.state.owner = createId("user");
    await expect(connect()).rejects.toMatchObject({ code: "reach_denied" });
  });

  it("reports an offline computer with how long ago it was heard from", async () => {
    const context = harness();
    context.hub.detach(context.peer, "transport-disconnected");
    // Well inside the two-hour bucket: the hub reads its own clock, which can
    // trail this one by a few milliseconds.
    context.store.state.machine.lastSeenAt = new Date(Date.now() - (2 * 60 * 60 + 30) * 1_000);

    await expect(
      context.hub.connect({
        signal: new AbortController().signal,
        target: context.target,
        token: "caller-token",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      const rejection = error as { code?: string; message?: string };
      expect(rejection.code).toBe("target_offline");
      expect(rejection.message).toBe("example-mac is offline (last seen 2 hours ago).");
      return true;
    });

    context.store.state.machine.lastSeenAt = null;
    await expect(
      context.hub.connect({
        signal: new AbortController().signal,
        target: context.target,
        token: "caller-token",
      }),
    ).rejects.toMatchObject({ message: "example-mac is offline (never seen)." });
  });

  it("never lets a Run reach the computer it is already running on", async () => {
    const context = harness();
    context.setScope(runScope({ requestedBy: context.owner, runnerId: context.target }));

    await expect(
      context.hub.connect({
        signal: new AbortController().signal,
        target: context.target,
        token: "caller-token",
      }),
    ).rejects.toMatchObject({ code: "reach_denied" });
  });

  it("counts pending reservations against both caps and frees them when they end", async () => {
    const context = harness({ openTimeoutMs: 60_000 });
    const pending: ShellSessionId[] = [];
    for (let index = 0; index < machineAccessMaxRunSessions; index += 1) {
      const opened = await openSession(context);
      if (opened.open.type !== "host.shell.session.open") throw new Error("unreachable");
      pending.push(opened.open.sessionId);
    }

    // Nothing activated: every one of these is a reservation, and a reservation
    // holds a slot exactly like a live session does.
    await expect(
      context.hub.connect({
        signal: new AbortController().signal,
        target: context.target,
        token: "caller-token",
      }),
    ).rejects.toMatchObject({
      code: "too_many_sessions",
      message: `This Run already has ${machineAccessMaxRunSessions} open connections.`,
    });

    const [first] = pending;
    if (!first) throw new Error("unreachable");
    await context.hub.end(first, "open-failed");
    const after = await openSession(context);
    expect(after.open.type).toBe("host.shell.session.open");
  });

  it("reports the machine cap before the Run cap, with the machine's own number", async () => {
    const context = harness({ openTimeoutMs: 60_000 });
    // Each reservation comes from a different Run, so only the machine's cap
    // can be the one that refuses.
    for (let index = 0; index < machineAccessMaxActiveSessions; index += 1) {
      context.setScope(runScope({ requestedBy: context.owner, runnerId: context.callerRunnerId }));
      await openSession(context);
    }
    context.setScope(runScope({ requestedBy: context.owner, runnerId: context.callerRunnerId }));

    await expect(
      context.hub.connect({
        signal: new AbortController().signal,
        target: context.target,
        token: "caller-token",
      }),
    ).rejects.toMatchObject({
      code: "too_many_sessions",
      message: `example-mac already has ${machineAccessMaxActiveSessions} open connections.`,
    });
  });
});

describe("ShellHub activation", () => {
  it("activates only once both endpoints exist, and forwards only after that", async () => {
    const context = harness();
    const session = await openSession(context);
    if (session.open.type !== "host.shell.session.open") throw new Error("unreachable");
    const data = byteSocket();
    const sessionId = await context.hub.claimDataSocket(session.open.dataTicket);

    context.hub.attachDataSocket(sessionId, data);
    // Paired but not `opened`: the caller is still waiting and the target's
    // socket is held silent.
    expect(data.state.paused).toBe(true);
    expect(context.store.state.activated).toEqual([]);

    await context.hub.handleMessage(context.peer, context.stream, {
      ...context.stream.fence,
      sessionId,
      type: "runner.shell.session.opened",
    });
    await session.connecting;

    expect(context.store.state.activated).toEqual([sessionId]);
    expect(context.notifier.startedCalls).toHaveLength(1);
    expect(context.notifier.startedCalls[0]?.session.callerMachineName).toBe("cloud-1");
    // The target is told the name the Deployment knows it by, which its helper
    // puts in the sentences it refuses with.
    expect(session.open.machineName).toBe("example-mac");
    // Active, but still silent: forwarding starts with the caller's socket,
    // which is what makes "no byte before activation" true in both directions.
    expect(data.state.paused).toBe(true);

    const caller = byteSocket();
    context.hub.attachCaller(sessionId, caller);
    expect(data.state.paused).toBe(false);
    caller.deliver(512);
    data.deliver(128);

    expect(data.sent).toEqual([512]);
    expect(caller.sent).toEqual([128]);
  });

  it("refuses a second data socket on the same ticket and a ticket for a foreign fence", async () => {
    const context = harness();
    const session = await openSession(context);
    if (session.open.type !== "host.shell.session.open") throw new Error("unreachable");

    const sessionId = await context.hub.claimDataSocket(session.open.dataTicket);
    await expect(context.hub.claimDataSocket(session.open.dataTicket)).rejects.toThrow(
      /already used/u,
    );

    // A ticket whose fence names another stream pairs with nothing, even though
    // the Host itself signed it.
    const other = harness();
    const foreign = await openSession(other);
    if (foreign.open.type !== "host.shell.session.open") throw new Error("unreachable");
    const claims = other.authenticator.issued.get(foreign.open.dataTicket);
    if (!claims) throw new Error("unreachable");
    context.authenticator.issued.set("forged", {
      ...claims,
      sessionId,
    });
    await expect(context.hub.claimDataSocket("forged")).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("ends a session whose policy revision moved while the target was starting", async () => {
    const context = harness();
    const session = await openSession(context);
    if (session.open.type !== "host.shell.session.open") throw new Error("unreachable");
    const sessionId = await context.hub.claimDataSocket(session.open.dataTicket);
    context.hub.attachDataSocket(sessionId, byteSocket());
    context.store.state.machine.revision += 1;

    await context.hub.handleMessage(context.peer, context.stream, {
      ...context.stream.fence,
      sessionId,
      type: "runner.shell.session.opened",
    });

    await expect(session.connecting).rejects.toBeInstanceOf(ShellConnectRejection);
    expect(context.store.state.activated).toEqual([]);
    expect(context.store.state.ended).toMatchObject([{ reason: "policy-changed", sessionId }]);
    expect(context.notifier.startedCalls).toEqual([]);
  });

  it("cannot activate after the session ended, and says so to a late opened", async () => {
    const context = harness();
    const session = await openSession(context);
    if (session.open.type !== "host.shell.session.open") throw new Error("unreachable");
    const sessionId = await context.hub.claimDataSocket(session.open.dataTicket);
    context.hub.attachDataSocket(sessionId, byteSocket());

    await context.hub.end(sessionId, "stopped-by-owner");
    await expect(session.connecting).rejects.toBeInstanceOf(ShellConnectRejection);

    await context.hub.handleMessage(context.peer, context.stream, {
      ...context.stream.fence,
      sessionId,
      type: "runner.shell.session.opened",
    });

    expect(context.store.state.activated).toEqual([]);
    // Both closes are sent outside the dispatcher, so the target is told in its
    // own time rather than while the stream waits.
    await vi.waitFor(() =>
      expect(
        context.peer.sent
          .filter((sent) => sent.type === "host.shell.session.close")
          .map((close) => close.reason),
      ).toEqual(["stopped-by-owner", "open-failed"]),
    );
  });

  it("gives up on a target that never pairs", async () => {
    vi.useFakeTimers();
    try {
      const context = harness({ openTimeoutMs: 10_000 });
      const session = await openSession(context);

      await vi.advanceTimersByTimeAsync(10_000);

      await expect(session.connecting).rejects.toMatchObject({
        message: "example-mac did not accept the connection.",
      });
      expect(context.store.state.ended.map((entry) => entry.reason)).toEqual(["open-timeout"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ShellHub ending", () => {
  it("ends once, keeps the first reason, and closes both endpoints", async () => {
    const context = harness();
    const session = await activate(context, await openSession(context));

    const first = await context.hub.end(session.sessionId, "client-closed");
    const second = await context.hub.end(session.sessionId, "stopped-by-owner");

    expect(first).toEqual({ ended: true });
    expect(second).toEqual({ ended: false });
    expect(context.store.state.ended).toMatchObject([
      { reason: "client-closed", sessionId: session.sessionId },
    ]);
    expect(session.caller.closes).toHaveLength(1);
    expect(session.data.closes).toHaveLength(1);
    expect(context.notifier.endedCalls.map((entry) => entry.endReason)).toEqual(["client-closed"]);
  });

  it("stops forwarding the moment it ends, before any socket has closed", async () => {
    const context = harness();
    const session = await activate(context, await openSession(context));
    session.caller.deliver(64);

    await context.hub.end(session.sessionId, "stopped-by-owner");
    session.caller.deliver(64);
    session.data.deliver(64);

    expect(session.data.sent).toEqual([64]);
    expect(session.caller.sent).toEqual([]);
  });

  it("honours the reason the target gave over the generic socket close", async () => {
    const context = harness();
    const session = await activate(context, await openSession(context));

    await context.hub.handleMessage(context.peer, context.stream, {
      ...context.stream.fence,
      reason: "idle-timeout",
      sessionId: session.sessionId,
      type: "runner.shell.session.closed",
    });
    await context.hub.end(session.sessionId, "target-closed");

    expect(context.store.state.ended).toMatchObject([
      { reason: "idle-timeout", sessionId: session.sessionId },
    ]);
  });

  it("ends every session of one Run, one machine, and the whole Host", async () => {
    const context = harness();
    const mine = await activate(context, await openSession(context));
    const runId: RunId = context.scope.runId;

    await context.hub.endRunSessions(runId, "run-ended");
    expect(context.store.state.ended).toMatchObject([
      { reason: "run-ended", sessionId: mine.sessionId },
    ]);

    const second = await activate(context, await openSession(context));
    await context.hub.endMachineSessions(context.target, "machine-revoked");
    expect(context.store.state.ended.at(-1)).toMatchObject({
      reason: "machine-revoked",
      sessionId: second.sessionId,
    });

    const third = await activate(context, await openSession(context));
    await context.hub.close();
    expect(context.store.state.ended.at(-1)).toMatchObject({
      reason: "host-shutdown",
      sessionId: third.sessionId,
    });
  });

  it("ends a machine's sessions when its control stream detaches", async () => {
    const context = harness();
    const session = await activate(context, await openSession(context));

    context.hub.detach(context.peer, "transport-disconnected");

    await vi.waitFor(() =>
      expect(context.store.state.ended).toMatchObject([
        { reason: "machine-disconnected", sessionId: session.sessionId },
      ]),
    );
    expect(session.data.closes).toHaveLength(1);
  });

  it("says a revoked machine's sessions ended in the revocation", async () => {
    const context = harness();
    const session = await activate(context, await openSession(context));

    // Tearing the stream down is how a revocation reaches work in flight, so it
    // arrives here first and must not claim the generic disconnection.
    context.hub.detachRunner(context.stream.identity.runnerId, "revoked");

    await vi.waitFor(() =>
      expect(context.store.state.ended).toMatchObject([
        { reason: "machine-revoked", sessionId: session.sessionId },
      ]),
    );
  });

  it("still writes the durable end for a session this Host never held", async () => {
    const context = harness();
    const session = await activate(context, await openSession(context));
    await context.hub.end(session.sessionId, "client-closed");
    context.store.state.rows.set(session.sessionId, { endedAt: null, state: "active" });

    // A Stop on a row from an earlier Host epoch: nothing in memory, but the
    // row is still owed its ending.
    await expect(context.hub.end(session.sessionId, "stopped-by-owner")).resolves.toEqual({
      ended: true,
    });
  });
});

/*
 * A revoked grant ends what it admitted. How that can go wrong in the hub:
 * - a notice about one grant ends a session a later grant of the same Run
 *   admitted, because it arrived after that session opened or arrived twice;
 * - it ends another Run's session that holds the same binding generation;
 * - a session still opening under the revoked grant goes on to activate;
 * - bytes keep moving until the ending has been written.
 */
describe("ShellHub grant revocation", () => {
  it("ends exactly what one grant admitted, however late or often the notice comes", async () => {
    const context = harness();
    const runId: RunId = context.scope.runId;
    const firstGrant = await activate(context, await openSession(context));
    context.setScope({ ...context.scope, bindingGeneration: 2 });
    const secondGrant = await activate(context, await openSession(context));
    context.setScope({
      ...runScope({ requestedBy: context.owner, runnerId: context.callerRunnerId }),
      bindingGeneration: 1,
    });
    const otherRun = await activate(context, await openSession(context));
    firstGrant.caller.deliver(64);

    await context.hub.endGrantSessions([{ bindingGeneration: 1, runId }], "run-ended");
    firstGrant.caller.deliver(64);
    firstGrant.data.deliver(64);
    expect(firstGrant.data.sent).toEqual([64]);
    expect(firstGrant.caller.sent).toEqual([]);

    await context.hub.endGrantSessions([{ bindingGeneration: 1, runId }], "run-ended");
    expect(context.store.state.ended.map((entry) => [entry.sessionId, entry.reason])).toEqual([
      [firstGrant.sessionId, "run-ended"],
    ]);
    secondGrant.caller.deliver(32);
    otherRun.caller.deliver(16);
    expect(secondGrant.data.sent).toEqual([32]);
    expect(otherRun.data.sent).toEqual([16]);

    await context.hub.endGrantSessions([{ bindingGeneration: 2, runId }], "run-ended");
    expect(context.store.state.ended.map((entry) => entry.sessionId)).toEqual([
      firstGrant.sessionId,
      secondGrant.sessionId,
    ]);
  });

  it("ends a session still opening under the revoked grant", async () => {
    const context = harness();
    const opening = await openSession(context);

    await context.hub.endGrantSessions(
      [{ bindingGeneration: context.scope.bindingGeneration, runId: context.scope.runId }],
      "run-ended",
    );

    await expect(opening.connecting).rejects.toThrow("This Run has ended.");
    if (opening.open.type !== "host.shell.session.open") throw new Error("unreachable");
    await expect(context.hub.claimDataSocket(opening.open.dataTicket)).rejects.toThrow();
    expect(context.store.state.activated).toEqual([]);
  });
});

describe("ShellHub audit", () => {
  it("persists reported requests outside the dispatcher and caps them with one marker", async () => {
    const context = harness();
    const session = await activate(context, await openSession(context));

    for (let index = 0; index <= shellAuditEventCap; index += 1) {
      await context.hub.handleMessage(context.peer, context.stream, {
        ...context.stream.fence,
        event: { channel: 0, command: `echo ${index}`, kind: "exec" },
        sessionId: session.sessionId,
        type: "runner.shell.event",
      });
    }
    await vi.waitFor(() =>
      expect(context.store.state.events.get(session.sessionId)).toHaveLength(
        shellAuditEventCap + 1,
      ),
    );

    const stored = context.store.state.events.get(session.sessionId) ?? [];
    expect(stored.at(-1)).toEqual({ kind: "truncated" });
    expect(stored.filter((event) => event.kind === "truncated")).toHaveLength(1);
  });

  it("bounds a command the target reported over the wire cap", async () => {
    const context = harness();
    const session = await activate(context, await openSession(context));

    await context.hub.handleMessage(context.peer, context.stream, {
      ...context.stream.fence,
      event: { channel: 1, command: "x".repeat(4_096), kind: "exec" },
      sessionId: session.sessionId,
      type: "runner.shell.event",
    });

    await vi.waitFor(() => expect(context.store.state.events.get(session.sessionId)).toBeDefined());
    const [stored] = context.store.state.events.get(session.sessionId) ?? [];
    expect(stored?.kind === "exec" && stored.command.length).toBe(4_096);
  });
});

describe("ShellHub isolation", () => {
  it("lets a Stop and an open timeout finish while every control send is stalled", async () => {
    const context = harness({ openTimeoutMs: 60, stallSends: true });
    // Two reservations on the same computer; both `open` sends stall forever.
    const stopped = await activate(context, await openSession(context));
    const abandoned = await openSession(context);
    expect(context.peer.stalled.value).toBe(true);

    // The Stop takes the sockets away and writes the row without ever waiting
    // on the send that is asking the target to let go.
    await expect(context.hub.end(stopped.sessionId, "stopped-by-owner")).resolves.toEqual({
      ended: true,
    });
    // And the stalled session's own deadline still arrives.
    await expect(abandoned.connecting).rejects.toMatchObject({
      message: "example-mac did not accept the connection.",
    });

    expect(context.store.state.ended).toMatchObject([
      { reason: "stopped-by-owner", sessionId: stopped.sessionId },
      { reason: "open-timeout" },
    ]);
  });

  it("returns from the control dispatcher without waiting for an ending", async () => {
    const context = harness({ stallSends: true });
    const session = await activate(context, await openSession(context));

    // The auxiliary dispatcher is serial: if this awaited the ending, every
    // other message on this machine's stream — heartbeats included — would wait
    // behind a database write and a send to a computer that stopped reading.
    await context.hub.handleMessage(context.peer, context.stream, {
      ...context.stream.fence,
      reason: "idle-timeout",
      sessionId: session.sessionId,
      type: "runner.shell.session.closed",
    });

    await vi.waitFor(() =>
      expect(context.store.state.ended).toMatchObject([
        { reason: "idle-timeout", sessionId: session.sessionId },
      ]),
    );
  });

  it("keeps one machine's stalled admission out of another machine's way", async () => {
    const context = harness({ stallSends: true });
    const other = createId("runner");
    const otherPeer = controlPeer();
    context.hub.attach(otherPeer, auxiliaryStream({ runnerId: other }));

    await openSession(context);
    const second = context.hub.connect({
      signal: new AbortController().signal,
      target: other,
      token: "caller-token",
    });
    void second.catch(() => undefined);

    // The second machine's `open` went out even though the first machine's send
    // is still hanging: admission turns are per computer.
    await vi.waitFor(() => expect(otherPeer.sent).toHaveLength(1));
  });
});

describe("ShellHub admission coordination", () => {
  it("never activates against a policy revision a write is committing", async () => {
    const context = harness();
    const session = await openSession(context);
    if (session.open.type !== "host.shell.session.open") throw new Error("unreachable");
    const sessionId = await context.hub.claimDataSocket(session.open.dataTicket);
    context.hub.attachDataSocket(sessionId, byteSocket());

    // Activation is now inside its awaited policy read.
    let release = () => undefined as void;
    const reading = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    let entered = false;
    context.store.state.gateTarget = async () => {
      if (entered) return;
      entered = true;
      await reading;
    };
    void context.hub.handleMessage(context.peer, context.stream, {
      ...context.stream.fence,
      sessionId,
      type: "runner.shell.session.opened",
    });
    await vi.waitFor(() => expect(entered).toBe(true));

    // The RPC commits a new policy while that read is in flight. It must wait
    // for the machine's admission turn rather than land underneath it.
    const committed: string[] = [];
    const write = context.hub.withMachineAdmission(context.target, () => {
      context.store.state.machine.revision += 1;
      committed.push("policy");
      return Promise.resolve();
    });
    await Promise.resolve();
    expect(committed).toEqual([]);

    release();
    await session.connecting;
    // The session activated under the revision it was admitted with, and the
    // write landed only afterwards.
    expect(context.store.state.activated).toEqual([sessionId]);
    await write;
    expect(committed).toEqual(["policy"]);

    await context.hub.endMachineSessions(context.target, "policy-changed");
    expect(context.store.state.ended).toMatchObject([{ reason: "policy-changed", sessionId }]);
  });

  it("refuses a queued data claim whose ticket expired while it waited", async () => {
    // A generous open window, so only the ticket's own 30 s can run out.
    const context = harness({ openTimeoutMs: 10 * 60_000 });
    const session = await openSession(context);
    if (session.open.type !== "host.shell.session.open") throw new Error("unreachable");
    const claims = context.authenticator.issued.get(session.open.dataTicket);
    if (!claims) throw new Error("unreachable");

    // The machine's turn is held; the claim queues behind it, and the ticket
    // runs out before the turn comes round.
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const held = context.hub.withMachineAdmission(context.target, () => gate);
    const claiming = context.hub.claimDataSocket(session.open.dataTicket);
    context.clock.value = Date.parse(claims.expiresAt) + 1;
    release();
    await held;

    await expect(claiming).rejects.toMatchObject({
      code: "forbidden",
      message: "That shell data ticket is no longer valid",
    });
  });

  it("does not activate for a caller that gave up during the open window", async () => {
    const context = harness();
    const controller = new AbortController();
    const session = await openSession(context, { signal: controller.signal });
    if (session.open.type !== "host.shell.session.open") throw new Error("unreachable");
    const sessionId = await context.hub.claimDataSocket(session.open.dataTicket);
    context.hub.attachDataSocket(sessionId, byteSocket());

    let release = () => undefined as void;
    const reading = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    let entered = false;
    context.store.state.gateTarget = async () => {
      if (entered) return;
      entered = true;
      await reading;
    };
    void context.hub.handleMessage(context.peer, context.stream, {
      ...context.stream.fence,
      sessionId,
      type: "runner.shell.session.opened",
    });
    await vi.waitFor(() => expect(entered).toBe(true));
    // The ssh proxy hung up while the Host was still checking.
    controller.abort();
    release();

    await expect(session.connecting).rejects.toBeInstanceOf(ShellConnectRejection);
    expect(context.store.state.ended.map((entry) => entry.reason)).toEqual(["open-failed"]);
    expect(context.notifier.startedCalls).toEqual([]);
  });
});

describe("ShellHub terminal persistence", () => {
  it("retries the first reason and its counters when the ending could not be written", async () => {
    const context = harness();
    const session = await activate(context, await openSession(context));
    session.caller.deliver(64);
    session.data.deliver(16);
    context.store.state.failEndWrites = 1;

    await expect(context.hub.end(session.sessionId, "client-closed")).resolves.toEqual({
      ended: false,
    });
    expect(context.store.state.ended).toEqual([]);
    expect(context.notifier.endedCalls).toEqual([]);

    // A later terminal call must not invent a second story with no counters.
    await expect(context.hub.end(session.sessionId, "stopped-by-owner")).resolves.toEqual({
      ended: true,
    });

    expect(context.store.state.ended).toEqual([
      { bytesIn: 64, bytesOut: 16, reason: "client-closed", sessionId: session.sessionId },
    ]);
    expect(context.notifier.endedCalls.map((entry) => entry.endReason)).toEqual(["client-closed"]);
  });
});

describe("ShellHub reporting", () => {
  it("reports what a live session has moved, which its row does not yet know", async () => {
    const context = harness();
    const session = await activate(context, await openSession(context));
    session.caller.deliver(512);
    session.data.deliver(128);

    expect(context.hub.liveSessionBytes(context.target).get(session.sessionId)).toEqual({
      bytesIn: 512,
      bytesOut: 128,
    });
    expect(context.hub.liveSessionBytes(createId("runner")).size).toBe(0);

    await context.hub.end(session.sessionId, "client-closed");
    // Once it has ended the row holds the final numbers, so the hub holds none.
    expect(context.hub.liveSessionBytes(context.target).size).toBe(0);
  });
});

describe("ShellHub revocation", () => {
  it("records a revoked machine's sessions as revoked, and says so to the caller", async () => {
    const context = harness();
    const active = await activate(context, await openSession(context));
    const pending = await openSession(context);

    context.hub.detachRunner(context.target, "revoked");

    await vi.waitFor(() =>
      expect(context.store.state.ended.map((entry) => entry.reason)).toEqual([
        "machine-revoked",
        "machine-revoked",
      ]),
    );
    expect(context.store.state.ended.map((entry) => entry.sessionId)).toContain(active.sessionId);
    // A reservation that never opened is told the computer went away, not that
    // it happened to be offline.
    await expect(pending.connecting).rejects.toMatchObject({
      code: "target_unknown",
      message: "example-mac was removed from this Deployment.",
    });
  });

  it("still records a plain disconnection as one", async () => {
    const context = harness();
    const session = await activate(context, await openSession(context));

    context.hub.detach(context.peer, "transport-disconnected");

    await vi.waitFor(() =>
      expect(context.store.state.ended).toMatchObject([
        { reason: "machine-disconnected", sessionId: session.sessionId },
      ]),
    );
  });
});

describe("ShellHub audit truthfulness", () => {
  it("marks a history the target could not deliver in full as incomplete", async () => {
    const context = harness();
    const session = await activate(context, await openSession(context));

    await context.hub.handleMessage(context.peer, context.stream, {
      ...context.stream.fence,
      event: { channel: 0, command: "echo one", kind: "exec" },
      sessionId: session.sessionId,
      type: "runner.shell.event",
    });
    await context.hub.handleMessage(context.peer, context.stream, {
      ...context.stream.fence,
      auditDropped: 3,
      reason: "target-closed",
      sessionId: session.sessionId,
      type: "runner.shell.session.closed",
    });

    await vi.waitFor(() =>
      expect(context.store.state.events.get(session.sessionId)).toEqual([
        { channel: 0, command: "echo one", kind: "exec" },
        { kind: "truncated" },
      ]),
    );
  });
});

describe("ShellHub shutdown", () => {
  it("waits for terminal audit persistence after finalization was acknowledged", async () => {
    const context = harness();
    const session = await activate(context, await openSession(context));
    let release: (() => void) | undefined;
    context.store.state.gateEvents = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    await context.hub.handleMessage(context.peer, context.stream, {
      ...context.stream.fence,
      event: { channel: 2, exitStatus: 0, kind: "channel.closed" },
      sessionId: session.sessionId,
      type: "runner.shell.event",
    });
    await context.hub.handleMessage(context.peer, context.stream, {
      ...context.stream.fence,
      reason: "target-closed",
      sessionId: session.sessionId,
      type: "runner.shell.session.closed",
    });
    await vi.waitFor(() => expect(context.store.state.ended).toHaveLength(1));

    let closed = false;
    const closing = context.hub.close().then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(closed).toBe(false);
    context.store.state.gateEvents = null;
    release?.();
    await closing;

    expect(context.store.state.events.get(session.sessionId)).toEqual([
      { channel: 2, exitStatus: 0, kind: "channel.closed" },
    ]);
  });

  it("does not finish shutdown before an unterminated audit history is marked", async () => {
    const context = harness();
    const session = await activate(context, await openSession(context));
    await context.hub.end(session.sessionId, "stopped-by-owner");
    let release: (() => void) | undefined;
    context.store.state.gateEvents = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });

    let closed = false;
    const closing = context.hub.close().then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(closed).toBe(false);
    context.store.state.gateEvents = null;
    release?.();
    await closing;

    expect(context.store.state.events.get(session.sessionId)).toEqual([{ kind: "truncated" }]);
  });

  it("tells a caller that arrives after shutdown that Opensteer is going away", async () => {
    const context = harness();
    await context.hub.close();

    await expect(
      context.hub.connect({
        signal: new AbortController().signal,
        target: context.target,
        token: "caller-token",
      }),
    ).rejects.toMatchObject({
      code: "target_offline",
      message: "Opensteer is shutting down.",
    });
  });
});

describe("ShellHub stream fencing", () => {
  it("refuses a message from a peer that is not attached", async () => {
    const context = harness();
    context.hub.detach(context.peer, "transport-disconnected");

    await expect(
      context.hub.handleMessage(context.peer, context.stream, {
        ...context.stream.fence,
        sessionId: ShellSessionIdSchema.parse(`shs_${globalThis.crypto.randomUUID()}`),
        type: "runner.shell.session.opened",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("tells a stream about a session it was never asked to serve", async () => {
    const context = harness();
    const stranger = ShellSessionIdSchema.parse(`shs_${globalThis.crypto.randomUUID()}`);

    await context.hub.handleMessage(context.peer, context.stream, {
      ...context.stream.fence,
      reason: "idle-timeout",
      sessionId: stranger,
      type: "runner.shell.session.closed",
    });

    await vi.waitFor(() =>
      expect(context.peer.sent).toEqual([
        {
          ...context.stream.fence,
          reason: "open-failed",
          sessionId: stranger,
          type: "host.shell.session.close",
        },
      ]),
    );
  });
});

describe("ShellHub termination independence", () => {
  it("lets a Stop finish while activation's own row write is stalled", async () => {
    const context = harness();
    const session = await openSession(context);
    if (session.open.type !== "host.shell.session.open") throw new Error("unreachable");
    const sessionId = await context.hub.claimDataSocket(session.open.dataTicket);
    const data = byteSocket();
    context.hub.attachDataSocket(sessionId, data);
    // The promotion is in the database and never comes back.
    let promoting = false;
    context.store.state.gateActivate = async () => {
      promoting = true;
      await new Promise<void>(() => undefined);
    };
    void context.hub.handleMessage(context.peer, context.stream, {
      ...context.stream.fence,
      sessionId,
      type: "runner.shell.session.opened",
    });
    await vi.waitFor(() => expect(promoting).toBe(true));

    // The owner's Stop is a synchronous claim: it does not queue behind the
    // write, and the target's socket is taken away at once.
    await expect(context.hub.end(sessionId, "stopped-by-owner")).resolves.toEqual({ ended: true });

    expect(context.store.state.ended).toMatchObject([{ reason: "stopped-by-owner", sessionId }]);
    expect(data.closes).toHaveLength(1);
    await expect(session.connecting).rejects.toBeInstanceOf(ShellConnectRejection);
  });

  it("gives up on the open deadline while the promotion is stalled", async () => {
    vi.useFakeTimers();
    try {
      const context = harness({ openTimeoutMs: 10_000 });
      const session = await openSession(context);
      if (session.open.type !== "host.shell.session.open") throw new Error("unreachable");
      const sessionId = await context.hub.claimDataSocket(session.open.dataTicket);
      context.hub.attachDataSocket(sessionId, byteSocket());
      let promoting = false;
      context.store.state.gateActivate = async () => {
        promoting = true;
        await new Promise<void>(() => undefined);
      };
      void context.hub.handleMessage(context.peer, context.stream, {
        ...context.stream.fence,
        sessionId,
        type: "runner.shell.session.opened",
      });
      await vi.waitFor(() => expect(promoting).toBe(true));

      await vi.advanceTimersByTimeAsync(10_000);

      await expect(session.connecting).rejects.toMatchObject({
        message: "example-mac did not accept the connection.",
      });
      expect(context.store.state.ended.map((entry) => entry.reason)).toEqual(["open-timeout"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops every machine's sessions at once when one machine's write is stalled", async () => {
    const context = harness();
    const other = attachMachine(context);
    const stuck = await activate(context, await openSession(context));
    const free = await activate(context, await openSession(context, { machine: other }), other);
    context.store.state.gateEnd = async (sessionId) => {
      if (sessionId === stuck.sessionId) await new Promise<void>(() => undefined);
    };

    // Host shutdown: one computer's row write never finishes.
    void context.hub.close();

    await vi.waitFor(() =>
      expect(context.store.state.ended).toMatchObject([
        { reason: "host-shutdown", sessionId: free.sessionId },
      ]),
    );
    // Both sessions stopped moving bytes before either write was attempted.
    expect(stuck.data.closes).toHaveLength(1);
    expect(free.data.closes).toHaveLength(1);
  });
});

describe("ShellHub activation fencing", () => {
  it("does not commit an activation whose stream lease ran out mid-write", async () => {
    // A generous open window, so only the stream's own lease can run out.
    const context = harness({ openTimeoutMs: 10 * 60_000 });
    const session = await openSession(context);
    if (session.open.type !== "host.shell.session.open") throw new Error("unreachable");
    const sessionId = await context.hub.claimDataSocket(session.open.dataTicket);
    context.hub.attachDataSocket(sessionId, byteSocket());
    let release = () => undefined as void;
    const writing = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    let promoting = false;
    context.store.state.gateActivate = async () => {
      promoting = true;
      await writing;
    };
    void context.hub.handleMessage(context.peer, context.stream, {
      ...context.stream.fence,
      sessionId,
      type: "runner.shell.session.opened",
    });
    await vi.waitFor(() => expect(promoting).toBe(true));

    // The stream this session is bound to stopped serving the machine while
    // the promotion was being written.
    context.clock.value = Date.parse(context.stream.streamLeaseExpiresAt) + 1;
    release();

    await expect(session.connecting).rejects.toBeInstanceOf(ShellConnectRejection);
    expect(context.notifier.startedCalls).toEqual([]);
    await vi.waitFor(() =>
      expect(context.store.state.ended).toMatchObject([
        { reason: "machine-disconnected", sessionId },
      ]),
    );
  });

  it("does not commit an activation whose stream detached mid-write", async () => {
    const context = harness();
    const session = await openSession(context);
    if (session.open.type !== "host.shell.session.open") throw new Error("unreachable");
    const sessionId = await context.hub.claimDataSocket(session.open.dataTicket);
    context.hub.attachDataSocket(sessionId, byteSocket());
    let release = () => undefined as void;
    const writing = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    let promoting = false;
    context.store.state.gateActivate = async () => {
      promoting = true;
      await writing;
    };
    void context.hub.handleMessage(context.peer, context.stream, {
      ...context.stream.fence,
      sessionId,
      type: "runner.shell.session.opened",
    });
    await vi.waitFor(() => expect(promoting).toBe(true));

    context.hub.detach(context.peer, "transport-disconnected");
    release();

    await expect(session.connecting).rejects.toBeInstanceOf(ShellConnectRejection);
    // Nothing was announced as started, and the caller was never told the
    // session was open on a stream that had already gone.
    expect(context.notifier.startedCalls).toEqual([]);
    await vi.waitFor(() =>
      expect(context.store.state.ended).toMatchObject([
        { reason: "machine-disconnected", sessionId },
      ]),
    );
  });
});

describe("ShellHub reservation ordering", () => {
  it("writes the ending of a session that ended while its row was being inserted", async () => {
    const context = harness();
    const reserving: ShellSessionId[] = [];
    let release = () => undefined as void;
    const inserting = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    context.store.state.gateReserve = async (sessionId) => {
      reserving.push(sessionId);
      await inserting;
    };
    const connecting = context.hub.connect({
      signal: new AbortController().signal,
      target: context.target,
      token: "caller-token",
    });
    void connecting.catch(() => undefined);
    await vi.waitFor(() => expect(reserving).toHaveLength(1));
    const sessionId = reserving[0];
    if (!sessionId) throw new Error("unreachable");

    // The owner stops it while the row is still being written.
    const stopping = context.hub.end(sessionId, "stopped-by-owner");
    release();

    await expect(stopping).resolves.toEqual({ ended: true });
    await expect(connecting).rejects.toBeInstanceOf(ShellConnectRejection);
    // The row exists and is ended, rather than a durable `pending` nothing is
    // serving, and the target is never asked to open a session that has gone.
    expect(context.store.state.ended).toMatchObject([{ reason: "stopped-by-owner", sessionId }]);
    expect(context.store.state.rows.get(sessionId)?.endedAt).not.toBeNull();
    expect(context.peer.sent.filter((sent) => sent.type === "host.shell.session.open")).toEqual([]);
  });

  it("refuses a connect that was still being admitted when shutdown began", async () => {
    const context = harness();
    let release = () => undefined as void;
    const reading = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    let entered = false;
    context.store.state.gateTarget = async () => {
      if (entered) return;
      entered = true;
      await reading;
    };
    const connecting = context.hub.connect({
      signal: new AbortController().signal,
      target: context.target,
      token: "caller-token",
    });
    void connecting.catch(() => undefined);
    await vi.waitFor(() => expect(entered).toBe(true));

    const closing = context.hub.close();
    release();
    await closing;

    await expect(connecting).rejects.toMatchObject({
      code: "target_offline",
      message: "Opensteer is shutting down.",
    });
    expect(context.store.state.reserved).toEqual([]);
  });
});

describe("ShellHub audit loss", () => {
  it("does not mark a routine pre-open rejection incomplete after its terminal close", async () => {
    const context = harness();
    const session = await openSession(context);
    await context.hub.handleMessage(context.peer, context.stream, {
      ...context.stream.fence,
      error: { code: "open-failed", message: "The helper could not start." },
      sessionId: session.open.sessionId,
      type: "runner.shell.session.rejected",
    });
    await expect(session.connecting).rejects.toBeInstanceOf(ShellConnectRejection);
    await vi.waitFor(() => expect(context.store.state.ended).toHaveLength(1));
    await context.hub.handleMessage(context.peer, context.stream, {
      ...context.stream.fence,
      reason: "open-failed",
      sessionId: session.open.sessionId,
      type: "runner.shell.session.closed",
    });

    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(context.store.state.events.get(session.open.sessionId)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a missing Runner terminal report without needing another session", async () => {
    const context = harness();
    const session = await activate(context, await openSession(context));
    vi.useFakeTimers();
    try {
      await context.hub.end(session.sessionId, "stopped-by-owner");
      await vi.advanceTimersByTimeAsync(60_000);

      expect(context.store.state.events.get(session.sessionId)).toEqual([{ kind: "truncated" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts audit after byte teardown until the Runner closes the session", async () => {
    const context = harness();
    const session = await activate(context, await openSession(context));
    await context.hub.end(session.sessionId, "stopped-by-owner");

    await context.hub.handleMessage(context.peer, context.stream, {
      ...context.stream.fence,
      event: { channel: 3, command: "echo finished", kind: "exec" },
      sessionId: session.sessionId,
      type: "runner.shell.event",
    });
    await context.hub.handleMessage(context.peer, context.stream, {
      ...context.stream.fence,
      event: { channel: 3, exitStatus: 0, kind: "channel.closed" },
      sessionId: session.sessionId,
      type: "runner.shell.event",
    });
    await context.hub.handleMessage(context.peer, context.stream, {
      ...context.stream.fence,
      reason: "stopped-by-owner",
      sessionId: session.sessionId,
      type: "runner.shell.session.closed",
    });

    await vi.waitFor(() =>
      expect(context.store.state.events.get(session.sessionId)).toEqual([
        { channel: 3, command: "echo finished", kind: "exec" },
        { channel: 3, exitStatus: 0, kind: "channel.closed" },
      ]),
    );
  });

  it("accepts a loss report that arrives after the session was removed", async () => {
    const context = harness();
    const session = await activate(context, await openSession(context));
    await context.hub.end(session.sessionId, "target-closed");

    // The Runner closes its data socket first and reports what it dropped
    // afterwards, so this is the ordinary order rather than a stray message.
    await context.hub.handleMessage(context.peer, context.stream, {
      ...context.stream.fence,
      auditDropped: 4,
      reason: "target-closed",
      sessionId: session.sessionId,
      type: "runner.shell.session.closed",
    });

    await vi.waitFor(() =>
      expect(context.store.state.events.get(session.sessionId)).toEqual([{ kind: "truncated" }]),
    );
  });

  it("marks the history incomplete when a batch of requests could not be written", async () => {
    const context = harness();
    const session = await activate(context, await openSession(context));
    context.store.state.failEventWrites = 1;

    await context.hub.handleMessage(context.peer, context.stream, {
      ...context.stream.fence,
      event: { channel: 0, command: "echo one", kind: "exec" },
      sessionId: session.sessionId,
      type: "runner.shell.event",
    });

    // The batch is unrecoverable, so the one thing the history can still be is
    // honest about it.
    await vi.waitFor(() =>
      expect(context.store.state.events.get(session.sessionId)).toEqual([{ kind: "truncated" }]),
    );
    expect(context.onAuditError).toHaveBeenCalled();
  });
});

describe("ShellHub terminal retries", () => {
  it("retries a terminal write that failed until it lands, with no second ending", async () => {
    vi.useFakeTimers();
    try {
      const context = harness();
      const session = await activate(context, await openSession(context));
      session.caller.deliver(32);
      context.store.state.failEndWrites = 2;

      await expect(context.hub.end(session.sessionId, "client-closed")).resolves.toEqual({
        ended: false,
      });
      expect(context.store.state.ended).toEqual([]);

      // Nothing else is coming to end this session; the retry is the hub's own.
      await vi.advanceTimersByTimeAsync(1_000);

      expect(context.store.state.ended).toEqual([
        { bytesIn: 32, bytesOut: 0, reason: "client-closed", sessionId: session.sessionId },
      ]);
      expect(context.notifier.endedCalls.map((entry) => entry.endReason)).toEqual([
        "client-closed",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives an unwritten ending one more attempt when the Host shuts down", async () => {
    const context = harness();
    const session = await activate(context, await openSession(context));
    context.store.state.failEndWrites = 1;
    await context.hub.end(session.sessionId, "client-closed");
    expect(context.store.state.ended).toEqual([]);

    await context.hub.close();

    expect(context.store.state.ended).toMatchObject([
      { reason: "client-closed", sessionId: session.sessionId },
    ]);
  });
});
