import { createId } from "@opensteer/core";
import type { RunnerAuxiliaryStream, RunnerStreamLossReason } from "@opensteer/orchestration";
import { RunnerAuxiliaryFrameFenceSchema, RunnerBootIdSchema } from "@opensteer/protocol";
import {
  BrowserRelayFrameHeaderSchema,
  encodeBrowserRelayFrame,
  type RoutedHostToBrowserRelayMessage,
} from "@opensteer/protocol/browser-relay";
import { afterEach, expect, it, vi } from "vitest";
import type { BrowserRuntimeConnection } from "./browser-service.js";
import {
  RunnerBrowserHub,
  type BrowserRelayEvent,
  type RunnerBrowserHooks,
  type RunnerBrowserPeer,
  type RunnerBrowserRegistry,
} from "./runner-browser-hub.js";
import {
  RunnerBrowserRuntimeRouter,
  type BrowserRuntimeRelayRequest,
} from "./runner-browser-runtime.js";

afterEach(() => vi.useRealTimers());

async function maintenanceFixture() {
  const runnerId = createId("runner");
  const storageInstanceId = crypto.randomUUID();
  let stream = {
    fence: { runnerId, connectionId: "maintenance", connectionGeneration: 1 },
    identity: {
      runnerId,
      bootId: RunnerBootIdSchema.parse("rbt_" + crypto.randomUUID()),
      modules: {
        browser: {
          runtimeId: "browser",
          wireVersion: 2,
          localProfileStorage: { storageInstanceId, engine: "chromium" },
        },
      },
    },
    streamLeaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
  } as unknown as RunnerAuxiliaryStream;
  const binding = {
    version: 1 as const,
    deploymentId: createId("deployment"),
    runnerId,
    storageInstanceId,
    engine: "chromium" as const,
    profileId: createId("browserProfile"),
    bindingId: crypto.randomUUID(),
  };
  const jobs = [] as Array<{
    binding: typeof binding;
    deletionId: string;
    state: "pending-computer";
  }>;
  let hooks: RunnerBrowserHooks = {};
  const sent: BrowserRuntimeRelayRequest[] = [];
  const acknowledgeDeletion = vi.fn(async () => {});
  const fixture = {
    intercept: undefined as undefined | ((message: BrowserRuntimeRelayRequest) => boolean),
    binding,
    jobs,
    stream,
    sent,
    acknowledgeDeletion,
  };
  const reply = async (message: Parameters<NonNullable<RunnerBrowserHooks["onMessage"]>>[1]) =>
    hooks.onMessage?.(stream, message);
  const router = new RunnerBrowserRuntimeRouter({
    localProfiles: {
      reconcileInventory: async () => {},
      jobs: async () => [...jobs],
      acknowledgeDeletion,
    },
    registry: {
      browserStreams: () => [stream],
      stream: () => stream,
      subscribe: (value) => {
        hooks = value;
        return () => {};
      },
      send: async (_id, message) => {
        sent.push(message);
        if (fixture.intercept?.(message)) return;
        if (message.type === "capability.grant")
          await reply({
            ...stream.fence,
            type: "capability.accepted",
            requestId: message.requestId,
            capability: {
              capabilityGeneration: message.lease.capabilityGeneration,
              capabilityLeaseId: message.lease.capabilityLeaseId,
              runtimeId: message.lease.runtimeId,
            },
          });
        if (message.type === "capability.revoke")
          await reply({ ...message, type: "capability.revoked" });
        if (message.type === "browser.attach")
          await reply({ ...message, type: "browser.attached" });
        if (message.type === "browser.profile.delete")
          await reply({ ...message, type: "browser.profile.delete.result", state: "deleted" });
      },
    },
  });
  const inventory = () =>
    reply({
      ...stream.fence,
      type: "browser.profile.inventory",
      module: "browser",
      storageInstanceId,
      engine: "chromium",
      profiles: [],
      complete: true,
    });
  await inventory();
  await router.resumeDeletions(runnerId);
  return {
    ...fixture,
    router,
    reply,
    fixture,
    target: router.resolve({ kind: "runner", runnerId })!,
  };
}

/**
 * A Runner's browser stream as the real hub carries it: a loss removes the
 * Runner's entry before observers hear of it, a replacement attaches later as
 * its own boot, and a heartbeat swaps the entry's object for a new one with
 * the same fence (`server.ts` → `RunnerBrowserHub.renew`).
 */
interface Boot {
  readonly generation: number;
  readonly held: BrowserRuntimeRelayRequest[];
  readonly peer: RunnerBrowserPeer;
  stream: RunnerAuxiliaryStream;
}

interface BootOptions {
  /** Messages the Runner receives but does not answer yet. */
  readonly hold?: (message: BrowserRuntimeRelayRequest) => boolean;
  /** The Runner refuses every browser attach with this error. */
  readonly refuseAttach?: { code: string; message: string; retryable: boolean };
  readonly runtimeId?: string;
  /**
   * Booted by "Stop everything on this Mac": answers as `BrowserModuleRelay`
   * does in stopped mode (`packages/runner-client/src/browser-relay.ts`, the
   * `browser.attach` and `browser.client-message` cases).
   */
  readonly stopped?: boolean;
}

const stoppedError = {
  code: "forbidden",
  message: "Agents are stopped on this computer. Resume them on this computer to continue.",
  reason: "device-stopped",
  retryable: false,
};

function restartFixture(options: { readonly copyOnRead?: boolean } = {}) {
  const runnerId = createId("runner");
  const hub = new RunnerBrowserHub();
  const sent: { generation: number; message: BrowserRuntimeRelayRequest }[] = [];
  const relayFailures: unknown[] = [];
  let generation = 0;
  // A registry that never hands out the same object twice, as one whose
  // snapshots are rebuilt on every read would.
  const registry: RunnerBrowserRegistry = options.copyOnRead
    ? {
        browserStreams: () => hub.browserStreams().map((stream) => ({ ...stream })),
        stream: (id) => {
          const stream = hub.stream(id);
          return stream ? { ...stream } : null;
        },
        send: (id, message) => hub.send(id, message),
        subscribe: (hooks) => hub.subscribe(hooks),
      }
    : hub;
  const router = new RunnerBrowserRuntimeRouter({ registry });
  const later = (boot: Boot, event: Record<string, unknown>) =>
    setImmediate(() => {
      hub.handleMessage(boot.peer, event as BrowserRelayEvent).catch((error: unknown) => {
        relayFailures.push(error);
      });
    });
  const answer = (boot: Boot, bootOptions: BootOptions, message: BrowserRuntimeRelayRequest) => {
    const fence = boot.stream.fence;
    switch (message.type) {
      case "capability.grant":
        return later(boot, {
          ...fence,
          type: "capability.accepted",
          requestId: message.requestId,
          capability: {
            capabilityGeneration: message.lease.capabilityGeneration,
            capabilityLeaseId: message.lease.capabilityLeaseId,
            runtimeId: message.lease.runtimeId,
          },
        });
      case "capability.revoke":
        return later(boot, { ...message, type: "capability.revoked" });
      case "browser.close":
        return later(boot, {
          ...fence,
          capability: message.capability,
          channelId: message.channelId,
          code: 1000,
          reason: "closed",
          requestId: message.requestId,
          type: "browser.closed",
        });
      case "browser.attach": {
        const refusal =
          bootOptions.refuseAttach ??
          (bootOptions.stopped &&
          (message.standardCdp || !String(message.attachTicket).startsWith("person:"))
            ? stoppedError
            : undefined);
        if (refusal)
          return later(boot, {
            ...fence,
            channelId: message.channelId,
            error: refusal,
            requestId: message.requestId,
            type: "browser.command-error",
          });
        return later(boot, {
          ...fence,
          capability: message.capability,
          channelId: message.channelId,
          requestId: message.requestId,
          type: "browser.attached",
        });
      }
      case "browser.client-message": {
        const frame = message.message as {
          type?: unknown;
          requestId?: unknown;
          actorToken?: unknown;
        };
        if (bootOptions.stopped && frame.type === "cdp.command" && frame.actorToken)
          return later(boot, {
            ...fence,
            capability: message.capability,
            channelId: message.channelId,
            message: { type: "cdp.error", requestId: frame.requestId, error: stoppedError },
            type: "browser.server-message",
          });
        return;
      }
      default:
        return;
    }
  };
  const fixture = {
    hub,
    router,
    runnerId,
    sent,
    relayFailures,
    boot(bootOptions: BootOptions = {}): Boot {
      generation += 1;
      const bootId = `rbt_${crypto.randomUUID()}`;
      const fence = RunnerAuxiliaryFrameFenceSchema.parse({
        auxiliaryStreamId: `rax_${crypto.randomUUID()}`,
        bootId,
        connectionGeneration: generation,
        connectionId: `rcn_${crypto.randomUUID()}`,
        connectionLeaseId: `rls_${crypto.randomUUID()}`,
        module: "browser",
        runnerId,
      });
      const boot: Boot = {
        generation,
        held: [],
        peer: {
          id: crypto.randomUUID(),
          close: () => {},
          send: async (message) => {
            sent.push({ generation: boot.generation, message });
            if (bootOptions.hold?.(message)) boot.held.push(message);
            else answer(boot, bootOptions, message);
          },
        },
        stream: {
          auxiliaryStreamId: fence.auxiliaryStreamId,
          fence,
          identity: {
            runnerId,
            bootId,
            environmentIds: [],
            name: "This Mac",
            runnerKind: "main",
            modules: {
              browser: { runtimeId: bootOptions.runtimeId ?? "browser", wireVersion: 2 },
            },
          },
          streamLeaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        } as unknown as RunnerAuxiliaryStream,
      };
      hub.attach(boot.peer, boot.stream);
      return boot;
    },
    /** Answers what this boot was holding, as if its Runner had been slow. */
    release(boot: Boot, bootOptions: BootOptions = {}) {
      for (const message of boot.held.splice(0)) answer(boot, bootOptions, message);
    },
    heartbeat(boot: Boot) {
      boot.stream = {
        ...boot.stream,
        streamLeaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
      hub.renew(boot.peer, boot.stream);
    },
    restart: (boot: Boot) => hub.detach(boot.peer, "device-restarting"),
    lose: (boot: Boot, reason: RunnerStreamLossReason) => hub.detach(boot.peer, reason),
    /** Sends a runtime message on a channel this boot is still attaching. */
    serverMessage(boot: Boot, attach: BrowserRuntimeRelayRequest, message: unknown) {
      if (attach.type !== "browser.attach") throw new Error("expected an attach");
      later(boot, {
        ...boot.stream.fence,
        capability: attach.capability,
        channelId: attach.channelId,
        message,
        type: "browser.server-message",
      });
    },
    frame(boot: Boot, attach: BrowserRuntimeRelayRequest, sequence: number) {
      if (attach.type !== "browser.attach") throw new Error("expected an attach");
      const frame = encodeBrowserRelayFrame(
        BrowserRelayFrameHeaderSchema.parse({
          ...boot.stream.fence,
          capability: attach.capability,
          channelId: attach.channelId,
          sequence,
          type: "browser.frame",
        }),
        browserFrame(),
      );
      setImmediate(() => {
        hub.handleBinary(boot.peer, frame).catch((error: unknown) => relayFailures.push(error));
      });
    },
    target: () => router.resolve({ kind: "runner", runnerId })!,
    /** A person's own tab, with the reconnect only a person's tab is given. */
    person(ticket = "person:old-person-ticket") {
      let issued = 0;
      const prepare = vi.fn(async () => {});
      const reissue = vi.fn(() => `person:fresh-person-ticket-${++issued}`);
      const connection = fixture.target().connect(ticket, { prepare, ticket: reissue });
      return { connection, prepare, ticket: reissue, ...observe(connection) };
    },
    agent(ticket = "agent:old-agent-ticket") {
      const connection = fixture.target().connect(ticket);
      return { connection, ...observe(connection) };
    },
    of: (boot: Boot, type: BrowserRuntimeRelayRequest["type"]) =>
      sent
        .filter((entry) => entry.generation === boot.generation && entry.message.type === type)
        .map((entry) => entry.message),
    attaches: () =>
      sent.filter((entry) => entry.message.type === "browser.attach").map((entry) => entry.message),
    close() {
      router.close();
      hub.close();
    },
  };
  return fixture;
}

function observe(connection: BrowserRuntimeConnection) {
  const errors: string[] = [];
  const closes: [number, string][] = [];
  const messages: unknown[] = [];
  connection.on("error", (error) => errors.push(error.message));
  connection.once("close", (code, reason) => closes.push([code, reason.toString()]));
  connection.on("message", (data, isBinary) =>
    messages.push(isBinary ? "frame" : JSON.parse(String(data))),
  );
  return { errors, closes, messages };
}

function browserFrame(): Buffer {
  const header = Buffer.from(
    JSON.stringify({
      encoding: "jpeg",
      geometryRevision: 0,
      frameId: 1,
      rasterHeight: 1,
      rasterWidth: 1,
      surfaceId: "page-1",
      viewportHeight: 720,
      viewportWidth: 1_280,
    }),
  );
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const frame = Buffer.alloc(4 + header.byteLength + image.byteLength);
  frame.writeUInt32BE(header.byteLength, 0);
  header.copy(frame, 4);
  image.copy(frame, 4 + header.byteLength);
  return frame;
}

function sendOn(connection: BrowserRuntimeConnection, message: unknown): Promise<void> {
  return new Promise((resolve, reject) =>
    connection.send(JSON.stringify(message), { binary: false }, (error) =>
      error ? reject(error) : resolve(),
    ),
  );
}

/** Lets every reply already sent arrive, as the next turns of the event loop would. */
async function turns(count = 5): Promise<void> {
  for (let index = 0; index < count; index++)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

const couldNotReconnect = "The browser computer could not reconnect the page.";

/** Fakes only the clock the reconnect deadline runs on; the Runner's replies still arrive. */
function useDeadlineClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
}

async function elapse(ms: number): Promise<void> {
  await turns();
  await vi.advanceTimersByTimeAsync(ms);
  await turns();
}

it("reattaches only the person's channel on the replacement boot, with fresh authority", async () => {
  const f = restartFixture();
  try {
    const first = f.boot();
    const person = f.person();
    const agent = f.agent();
    await vi.waitFor(() => {
      expect(person.connection.readyState).toBe(1);
      expect(agent.connection.readyState).toBe(1);
    });
    f.restart(first);
    expect(agent.connection.readyState).toBe(3);
    expect(agent.errors).toEqual(["The computer's browser stream went away."]);
    await turns();
    f.boot();
    await vi.waitFor(() => expect(person.connection.readyState).toBe(1));
    expect(person.closes).toEqual([]);
    expect(person.errors).toEqual([]);
    expect(person.prepare).toHaveBeenCalledOnce();
    expect(person.ticket).toHaveBeenCalledOnce();
    expect(f.attaches()).toMatchObject([
      { attachTicket: "person:old-person-ticket", connectionGeneration: 1 },
      { attachTicket: "agent:old-agent-ticket", connectionGeneration: 1 },
      { attachTicket: "person:fresh-person-ticket-1", connectionGeneration: 2 },
    ]);
  } finally {
    f.close();
  }
});

it.each([
  ["capability.grant", "the same object"],
  ["browser.attach", "the same object"],
  ["capability.grant", "a copy on every read"],
  ["browser.attach", "a copy on every read"],
  ["capability.grant", "a heartbeat's new object"],
  ["browser.attach", "a heartbeat's new object"],
] as const)(
  "keeps the person's tab when its replacement restarts mid-%s and the registry hands out %s",
  async (phase, registry) => {
    const f = restartFixture({ copyOnRead: registry === "a copy on every read" });
    try {
      const first = f.boot();
      const person = f.person();
      await vi.waitFor(() => expect(person.connection.readyState).toBe(1));
      f.restart(first);
      await turns();
      const second = f.boot({ hold: (message) => message.type === phase });
      await vi.waitFor(() => expect(second.held.map((message) => message.type)).toEqual([phase]));
      // The replacement's heartbeat lands after the router read it and before it restarts.
      if (registry === "a heartbeat's new object") f.heartbeat(second);
      f.restart(second);
      await turns();
      f.boot();
      await vi.waitFor(() => expect(person.connection.readyState).toBe(1));
      expect(person.closes).toEqual([]);
      expect(person.errors).toEqual([]);
      expect(person.prepare).toHaveBeenCalledOnce();
      expect(person.ticket).toHaveBeenCalledTimes(2);
      expect(f.attaches()).toMatchObject(
        phase === "browser.attach"
          ? [
              { attachTicket: "person:old-person-ticket", connectionGeneration: 1 },
              { attachTicket: "person:fresh-person-ticket-1", connectionGeneration: 2 },
              { attachTicket: "person:fresh-person-ticket-2", connectionGeneration: 3 },
            ]
          : [
              { attachTicket: "person:old-person-ticket", connectionGeneration: 1 },
              { attachTicket: "person:fresh-person-ticket-2", connectionGeneration: 3 },
            ],
      );
    } finally {
      f.close();
    }
  },
);

it("waits quietly for a replacement that boots seconds later", async () => {
  useDeadlineClock();
  const f = restartFixture();
  try {
    const first = f.boot();
    const person = f.person();
    await elapse(0);
    expect(person.connection.readyState).toBe(1);
    f.restart(first);
    await elapse(10_000);
    expect(person.connection.readyState).toBe(0);
    expect(person.errors).toEqual([]);
    expect(person.closes).toEqual([]);
    expect(f.attaches()).toHaveLength(1);
    f.boot();
    await elapse(0);
    expect(person.connection.readyState).toBe(1);
    expect(person.errors).toEqual([]);
    expect(f.attaches()).toMatchObject([
      { connectionGeneration: 1 },
      { attachTicket: "person:fresh-person-ticket-1", connectionGeneration: 2 },
    ]);
  } finally {
    f.close();
  }
});

it.each(["device-restarting", "transport-disconnected"] as const)(
  "handles a replacement lost (%s) before the reconnect could read it",
  async (reason) => {
    const f = restartFixture();
    try {
      const first = f.boot();
      const person = f.person();
      await vi.waitFor(() => expect(person.connection.readyState).toBe(1));
      f.restart(first);
      await turns();
      // It attaches and is gone in the same turn: the wait ends, the stream is already gone.
      f.lose(f.boot(), reason);
      await turns();
      if (reason === "transport-disconnected") {
        expect(person.errors).toEqual([couldNotReconnect]);
        expect(person.closes).toEqual([[1011, "Browser stream could not reconnect"]]);
        expect(f.attaches()).toHaveLength(1);
        return;
      }
      expect(person.connection.readyState).toBe(0);
      f.boot();
      await vi.waitFor(() => expect(person.connection.readyState).toBe(1));
      expect(person.errors).toEqual([]);
      expect(f.attaches()).toMatchObject([
        { connectionGeneration: 1 },
        { attachTicket: "person:fresh-person-ticket-1", connectionGeneration: 3 },
      ]);
    } finally {
      f.close();
    }
  },
);

it.each([
  [
    "refuses the reattach",
    {
      refuseAttach: {
        code: "not_found",
        message: "The browser session has ended.",
        retryable: false,
      },
    },
    "The browser session has ended.",
    "Browser Runtime attach failed",
  ],
  ["serves another browser", { runtimeId: "another-browser" }, couldNotReconnect, undefined],
] as const)(
  "closes the person's tab at once when the replacement %s",
  async (_case, bootOptions, message, closeReason) => {
    const f = restartFixture();
    try {
      const first = f.boot();
      const person = f.person();
      await vi.waitFor(() => expect(person.connection.readyState).toBe(1));
      f.restart(first);
      await turns();
      f.boot(bootOptions);
      await vi.waitFor(() => expect(person.connection.readyState).toBe(3));
      expect(person.errors).toEqual([message]);
      expect(person.closes).toEqual([[1011, closeReason ?? "Browser stream could not reconnect"]]);
      // A refusal is the answer: nothing is tried again on a later boot.
      const attempts = f.attaches().length;
      f.boot();
      await turns();
      expect(f.attaches()).toHaveLength(attempts);
    } finally {
      f.close();
    }
  },
);

it("closes the person's tab with the reason when its Runner does not return within the deadline", async () => {
  useDeadlineClock();
  const f = restartFixture();
  try {
    const first = f.boot();
    const person = f.person();
    await elapse(0);
    f.restart(first);
    await elapse(14_999);
    expect(person.connection.readyState).toBe(0);
    expect(person.errors).toEqual([]);
    expect(person.closes).toEqual([]);
    await elapse(1);
    expect(person.errors).toEqual([couldNotReconnect]);
    expect(person.closes).toEqual([[1011, "Browser stream could not reconnect"]]);
    f.boot();
    await elapse(0);
    expect(f.attaches()).toHaveLength(1);
  } finally {
    f.close();
  }
});

it("reopens the person's tab after three restarts in a row inside one deadline", async () => {
  useDeadlineClock();
  const f = restartFixture();
  try {
    const first = f.boot();
    const person = f.person();
    await elapse(0);
    f.restart(first);
    for (const phase of ["browser.attach", "capability.grant", "browser.attach"] as const) {
      await elapse(3_000);
      const replacement = f.boot({ hold: (message) => message.type === phase });
      await elapse(0);
      expect(replacement.held.map((message) => message.type)).toEqual([phase]);
      f.restart(replacement);
    }
    await elapse(3_000);
    f.boot();
    await elapse(0);
    expect(person.connection.readyState).toBe(1);
    expect(person.errors).toEqual([]);
    expect(person.closes).toEqual([]);
    expect(person.prepare).toHaveBeenCalledOnce();
    expect(f.attaches()).toMatchObject([
      { attachTicket: "person:old-person-ticket", connectionGeneration: 1 },
      { attachTicket: "person:fresh-person-ticket-1", connectionGeneration: 2 },
      { attachTicket: "person:fresh-person-ticket-3", connectionGeneration: 4 },
      { attachTicket: "person:fresh-person-ticket-4", connectionGeneration: 5 },
    ]);
  } finally {
    f.close();
  }
});

it("closes the person's tab at the deadline from the first loss, though restarts keep coming", async () => {
  useDeadlineClock();
  const f = restartFixture();
  try {
    const first = f.boot();
    const person = f.person();
    await elapse(0);
    f.restart(first);
    let replacement = first;
    for (let index = 0; index < 3; index++) {
      await elapse(4_000);
      replacement = f.boot({ hold: (message) => message.type === "browser.attach" });
      await elapse(0);
      if (index < 2) f.restart(replacement);
    }
    // 12 s after the first loss the last replacement is still attaching.
    expect(replacement.held.map((message) => message.type)).toEqual(["browser.attach"]);
    await elapse(2_999);
    expect(person.connection.readyState).toBe(0);
    expect(person.errors).toEqual([]);
    await elapse(1);
    expect(person.errors).toEqual([couldNotReconnect]);
    expect(person.closes).toEqual([[1011, "Browser stream could not reconnect"]]);
    // The attach that arrives late is closed on the runtime and its capability given back.
    const [attach] = replacement.held;
    f.release(replacement);
    await elapse(0);
    expect(person.connection.readyState).toBe(3);
    expect(f.of(replacement, "browser.close")).toMatchObject([
      { channelId: attach!.type === "browser.attach" ? attach!.channelId : "" },
    ]);
    expect(f.of(replacement, "capability.revoke")).toHaveLength(1);
  } finally {
    f.close();
  }
});

it("never hands the person what a boot that restarted had queued for them", async () => {
  const f = restartFixture();
  try {
    const first = f.boot();
    const person = f.person();
    await vi.waitFor(() => expect(person.connection.readyState).toBe(1));
    f.restart(first);
    await turns();
    const second = f.boot({ hold: (message) => message.type === "browser.attach" });
    await vi.waitFor(() => expect(second.held).toHaveLength(1));
    // The dying boot's runtime speaks on the channel before it acknowledges it.
    f.serverMessage(second, second.held[0]!, { type: "tabs.snapshot", from: "dead boot" });
    f.frame(second, second.held[0]!, 1);
    await turns();
    f.restart(second);
    await turns();
    const third = f.boot();
    await vi.waitFor(() => expect(person.connection.readyState).toBe(1));
    await turns();
    expect(person.messages).toEqual([]);
    const [attach] = f.of(third, "browser.attach");
    f.serverMessage(third, attach!, { type: "tabs.snapshot", from: "live boot" });
    await vi.waitFor(() =>
      expect(person.messages).toEqual([{ type: "tabs.snapshot", from: "live boot" }]),
    );
    expect(person.errors).toEqual([]);
    expect(f.relayFailures).toEqual([]);
  } finally {
    f.close();
  }
});

it("keeps a newer stream's restart and lease through late losses of older streams", async () => {
  const f = restartFixture();
  try {
    // A stream whose socket closes only much later: the registry admitted a newer one first.
    const stale = f.boot();
    const first = f.boot();
    const person = f.person();
    await vi.waitFor(() => expect(person.connection.readyState).toBe(1));
    f.restart(first);
    await turns();
    const older = f.boot();
    const newer = f.boot({ hold: (message) => message.type === "capability.grant" });
    await vi.waitFor(() => expect(newer.held).toHaveLength(1));
    // The newer stream restarts, and in the same turn the older socket's loss arrives late.
    f.restart(newer);
    f.lose(older, "transport-disconnected");
    await turns();
    expect(person.errors).toEqual([]);
    expect(person.connection.readyState).toBe(0);
    const live = f.boot();
    await vi.waitFor(() => expect(person.connection.readyState).toBe(1));
    // The stalest stream's loss arrives last, as a restart: the live lease stays.
    f.lose(stale, "device-restarting");
    await turns();
    expect(person.connection.readyState).toBe(1);
    await sendOn(person.connection, { type: "tabs.resync" });
    const tab = f.person("person:another-tab");
    await vi.waitFor(() => expect(tab.connection.readyState).toBe(1));
    expect(f.of(live, "capability.grant")).toHaveLength(1);
    expect(f.of(live, "browser.client-message")).toHaveLength(1);
    expect([...person.errors, ...tab.errors]).toEqual([]);
    // And the live stream's own restart is still recognised as one.
    f.restart(live);
    await turns();
    f.boot();
    await vi.waitFor(() => {
      expect(person.connection.readyState).toBe(1);
      expect(tab.connection.readyState).toBe(1);
    });
    expect([...person.errors, ...tab.errors]).toEqual([]);
  } finally {
    f.close();
  }
});

it("shares one capability lease per placement between person tabs across restarts", async () => {
  const f = restartFixture();
  try {
    const first = f.boot();
    const one = f.person("person:one");
    const two = f.person("person:two");
    await vi.waitFor(() => {
      expect(one.connection.readyState).toBe(1);
      expect(two.connection.readyState).toBe(1);
    });
    expect(f.of(first, "capability.grant")).toHaveLength(1);
    f.restart(first);
    await turns();
    // Both tabs restart in the middle of acquiring the replacement's lease.
    const second = f.boot({ hold: (message) => message.type === "capability.grant" });
    await vi.waitFor(() => expect(second.held).toHaveLength(1));
    f.restart(second);
    await turns();
    const third = f.boot();
    await vi.waitFor(() => {
      expect(one.connection.readyState).toBe(1);
      expect(two.connection.readyState).toBe(1);
    });
    const grants = f.of(third, "capability.grant");
    expect(grants).toHaveLength(1);
    const attaches = f.of(third, "browser.attach");
    expect(attaches).toHaveLength(2);
    const [lease] = grants;
    if (lease?.type !== "capability.grant") throw new Error("expected a grant");
    for (const attach of attaches)
      expect(attach).toMatchObject({
        capability: { capabilityLeaseId: lease.lease.capabilityLeaseId },
      });
    expect(
      new Set(attaches.map((attach) => attach.type === "browser.attach" && attach.channelId)).size,
    ).toBe(2);
    await sendOn(one.connection, { type: "tabs.resync" });
    await sendOn(two.connection, { type: "tabs.resync" });
    expect(f.of(third, "browser.client-message")).toHaveLength(2);
    expect([...one.errors, ...two.errors]).toEqual([]);
  } finally {
    f.close();
  }
});

it("keeps only the person's own tab across a restart into Stop, and relays the stopped Runner's refusals", async () => {
  const f = restartFixture();
  try {
    const first = f.boot();
    const person = f.person();
    const agent = f.agent();
    await vi.waitFor(() => {
      expect(person.connection.readyState).toBe(1);
      expect(agent.connection.readyState).toBe(1);
    });
    // An agent's command through the person's tab, in flight when the Mac stops.
    await sendOn(person.connection, {
      type: "cdp.command",
      requestId: "before-stop",
      actorToken: "agent-token",
      command: { method: "Runtime.evaluate", parameters: { expression: "1" } },
    });
    f.restart(first);
    expect(agent.connection.readyState).toBe(3);
    await turns();
    const stopped = f.boot({ stopped: true });
    await vi.waitFor(() => expect(person.connection.readyState).toBe(1));
    // Only the person's channel came back, with a person ticket, and nothing was sent again.
    expect(f.of(stopped, "browser.attach")).toMatchObject([
      { attachTicket: "person:fresh-person-ticket-1" },
    ]);
    expect(f.of(stopped, "browser.client-message")).toEqual([]);

    // A new agent attach on the stopped boot is refused, once, and not tried again.
    const late = f.agent("agent:after-stop");
    await vi.waitFor(() => expect(late.connection.readyState).toBe(3));
    expect(late.errors).toEqual([stoppedError.message]);
    expect(f.of(stopped, "browser.attach")).toHaveLength(2);

    // An agent's command on the kept channel comes back refused to the person's broker.
    await sendOn(person.connection, {
      type: "cdp.command",
      requestId: "after-stop",
      actorToken: "agent-token",
      command: { method: "Runtime.evaluate", parameters: { expression: "1" } },
    });
    await vi.waitFor(() =>
      expect(person.messages).toContainEqual({
        type: "cdp.error",
        requestId: "after-stop",
        error: stoppedError,
      }),
    );
    expect(person.connection.readyState).toBe(1);
    expect(person.errors).toEqual([]);
    expect(
      f
        .attaches()
        .filter(
          (attach) => attach.type === "browser.attach" && attach.attachTicket.startsWith("agent:"),
        ),
    ).toMatchObject([
      { attachTicket: "agent:old-agent-ticket", connectionGeneration: 1 },
      { attachTicket: "agent:after-stop", connectionGeneration: 2 },
    ]);
  } finally {
    f.close();
  }
});

it("opens Host relay channel 33 on one runtime", async () => {
  const f = await maintenanceFixture();
  try {
    for (let index = 0; index < 33; index++) {
      const connection = f.target.connect(`ticket-${index}`);
      const errors: Error[] = [];
      connection.on("error", (error) => errors.push(error));
      await vi.waitFor(() => {
        expect(errors).toEqual([]);
        expect(connection.readyState).toBe(1);
      });
    }
    expect(f.sent.filter((message) => message.type === "browser.attach")).toHaveLength(33);
  } finally {
    f.router.close();
  }
});

it("waits for a pending renewal before sending an open", async () => {
  vi.useFakeTimers();
  const f = await maintenanceFixture();
  try {
    const first = f.target.connect("first");
    first.on("error", () => {});
    await vi.advanceTimersByTimeAsync(0);
    f.fixture.intercept = (message) => message.type === "capability.grant";
    await vi.advanceTimersByTimeAsync(300_000);
    const renewal = f.sent.at(-1)!;
    expect(renewal.type).toBe("capability.grant");
    if (renewal.type !== "capability.grant") throw Error("expected renewal");
    const second = f.target.connect("second");
    second.on("error", () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sent.at(-1)).toBe(renewal);
    const capability = {
      capabilityGeneration: renewal.lease.capabilityGeneration,
      capabilityLeaseId: renewal.lease.capabilityLeaseId,
      runtimeId: renewal.lease.runtimeId,
    };
    await f.reply({
      ...f.stream.fence,
      type: "capability.accepted",
      requestId: renewal.requestId,
      capability,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sent.at(-1)).toMatchObject({
      type: "browser.attach",
      capability,
    });
    expect(second.readyState).toBe(1);
    expect(first.readyState).toBe(1);
  } finally {
    f.router.close();
  }
});

it.each(["result", "error"] as const)(
  "correlates a late erasure %s without disconnecting its sibling and drains the next job",
  async (terminal) => {
    vi.useFakeTimers();
    const f = await maintenanceFixture();
    try {
      const sibling = f.target.connect("sibling");
      const siblingError = vi.fn();
      sibling.on("error", siblingError);
      await vi.advanceTimersByTimeAsync(0);
      const deletionId = crypto.randomUUID();
      const secondId = crypto.randomUUID();
      f.jobs.push(
        { binding: f.binding, deletionId, state: "pending-computer" },
        {
          binding: {
            ...f.binding,
            profileId: createId("browserProfile"),
            bindingId: crypto.randomUUID(),
          },
          deletionId: secondId,
          state: "pending-computer",
        },
      );
      f.fixture.intercept = (message) =>
        message.type === "browser.profile.delete" && message.deletionId === deletionId;
      const erasing = f.router.resumeDeletions(f.binding.runnerId);
      const timedOut = expect(erasing).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(6000);
      expect(f.acknowledgeDeletion).not.toHaveBeenCalled();
      expect(sibling.readyState).toBe(1);
      const deletion = f.sent.find((message) => message.type === "browser.profile.delete")!;
      if (deletion.type !== "browser.profile.delete") throw Error("expected deletion");
      await vi.advanceTimersByTimeAsync(114_000);
      await timedOut;
      await vi.advanceTimersByTimeAsync(300_001);
      expect(f.acknowledgeDeletion).toHaveBeenCalledWith(
        expect.objectContaining({ deletionId: secondId }),
      );
      if (terminal === "result") {
        await expect(
          f.reply({
            ...deletion,
            type: "browser.profile.delete.result",
            state: "deleted",
            deletionId: crypto.randomUUID(),
          }),
        ).rejects.toThrow(/correlat|mismatch/);
        await expect(
          f.reply({ ...deletion, type: "browser.profile.delete.result", state: "deleted" }),
        ).resolves.toBeUndefined();
        expect(f.acknowledgeDeletion).toHaveBeenCalledWith({
          binding: f.binding,
          deletionId,
          state: "deleted",
        });
      } else
        await expect(
          f.reply({
            ...f.stream.fence,
            type: "browser.command-error",
            requestId: deletion.requestId,
            channelId: null,
            error: { code: "conflict", message: "Capability ended", retryable: false },
          }),
        ).resolves.toBeUndefined();
      expect(sibling.readyState).toBe(1);
      expect(siblingError).not.toHaveBeenCalled();
    } finally {
      f.router.close();
    }
  },
);

it("bounds unfinished maintenance without forgetting the oldest admitted erasure", async () => {
  vi.useFakeTimers();
  const f = await maintenanceFixture();
  Object.assign(f.stream, {
    streamLeaseExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  try {
    const sibling = f.target.connect("sibling");
    sibling.on("error", () => {});
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 65; index++)
      f.jobs.push({
        binding: {
          ...f.binding,
          profileId: createId("browserProfile"),
          bindingId: crypto.randomUUID(),
        },
        deletionId: crypto.randomUUID(),
        state: "pending-computer",
      });
    f.fixture.intercept = (message) => message.type === "browser.profile.delete";
    const refused = expect(f.router.resumeDeletions(f.binding.runnerId)).rejects.toThrow(
      /Too many browser profile erasures/,
    );
    await vi.advanceTimersByTimeAsync(120_000 * 64);
    await refused;
    const erasures = f.sent.filter((message) => message.type === "browser.profile.delete");
    expect(erasures).toHaveLength(64);
    const first = erasures[0]!;
    await f.reply({ ...first, type: "browser.profile.delete.result", state: "deleted" });
    expect(f.acknowledgeDeletion).toHaveBeenCalledWith({
      binding: first.binding,
      deletionId: first.deletionId,
      state: "deleted",
    });
    f.jobs.splice(0, 64);
    f.fixture.intercept = undefined;
    await f.router.resumeDeletions(f.binding.runnerId);
    expect(f.sent.filter((message) => message.type === "browser.profile.delete")).toHaveLength(65);
    expect(sibling.readyState).toBe(1);
  } finally {
    f.router.close();
  }
});

it.each(
  (["targetControl", "navigationAttributionVersion"] as const).flatMap((capability) =>
    ([undefined, 1] as const).map((version) => ({ capability, version })),
  ),
)("reads $capability=$version from the advertised browser module", ({ capability, version }) => {
  const runnerId = createId("runner");
  const stream = {
    identity: {
      runnerId,
      modules: {
        browser: { wireVersion: 2, runtimeId: "browser", [capability]: version },
      },
    },
  } as unknown as RunnerAuxiliaryStream;
  const registry: RunnerBrowserRegistry = {
    browserStreams: () => [stream],
    stream: () => stream,
    send: async () => undefined,
    subscribe: () => () => undefined,
  };
  const router = new RunnerBrowserRuntimeRouter({ registry });
  try {
    expect(router.resolve({ kind: "runner", runnerId })).toMatchObject({
      [capability]: version === 1,
    });
  } finally {
    router.close();
  }
});

it.each([
  [undefined, undefined],
  [1, undefined],
  [2, false],
  [2, true],
] as const)("keeps editing %s and explicit clipboard %s distinct", (editing, clipboard) => {
  const runnerId = createId("runner");
  const stream = {
    identity: {
      runnerId,
      modules: { browser: { wireVersion: 2, runtimeId: "browser", editing, clipboard } },
    },
  } as RunnerAuxiliaryStream;
  const registry: RunnerBrowserRegistry = {
    browserStreams: () => [stream],
    stream: () => stream,
    send: async () => undefined,
    subscribe: () => () => undefined,
  };
  const router = new RunnerBrowserRuntimeRouter({ registry });
  try {
    expect(router.resolve({ kind: "runner", runnerId })).toMatchObject({
      editing,
      clipboard: editing === 1 || clipboard === true,
    });
  } finally {
    router.close();
  }
});

it("lists an older browser as update-required and refuses direct placement", () => {
  const runnerId = createId("runner");
  const stream = {
    identity: {
      environmentIds: [createId("environment")],
      modules: { browser: { runtimeId: "older-browser" } },
      name: "Older computer",
      runnerId,
    },
  } as unknown as RunnerAuxiliaryStream;
  const registry: RunnerBrowserRegistry = {
    browserStreams: () => [stream],
    stream: () => stream,
    send: async () => undefined,
    subscribe: () => () => undefined,
  };
  const router = new RunnerBrowserRuntimeRouter({ registry });
  try {
    expect(router.placements()).toEqual([
      expect.objectContaining({
        available: false,
        label: "Older computer",
        runnerId,
        unavailableReason: expect.stringMatching(
          /Update the Browser Runtime.*current native browser runtime contract/u,
        ),
      }),
    ]);
    expect(() => router.resolve({ kind: "runner", runnerId })).toThrow(
      /current native browser runtime contract/u,
    );
  } finally {
    router.close();
  }
});

it("refuses a different browser wire contract with an explicit update message", () => {
  const runnerId = createId("runner");
  const stream = {
    identity: {
      environmentIds: [],
      modules: { browser: { wireVersion: 3, runtimeId: "newer-browser" } },
      name: "Newer computer",
      runnerId,
    },
  } as unknown as RunnerAuxiliaryStream;
  const registry: RunnerBrowserRegistry = {
    browserStreams: () => [stream],
    stream: () => stream,
    send: async () => undefined,
    subscribe: () => () => undefined,
  };
  const router = new RunnerBrowserRuntimeRouter({ registry });
  try {
    expect(router.placements()).toEqual([
      expect.objectContaining({
        available: false,
        unavailableReason: expect.stringMatching(
          /Update the Browser Runtime.*current native browser runtime contract/u,
        ),
      }),
    ]);
    expect(() => router.resolve({ kind: "runner", runnerId })).toThrow(
      /Update the Browser Runtime/u,
    );
  } finally {
    router.close();
  }
});

it("closes a browser whose background renewal times out without an unhandled rejection", async () => {
  vi.useFakeTimers();
  const runnerId = createId("runner");
  const stream = {
    fence: { runnerId, connectionId: "connection", connectionGeneration: 1 },
    identity: {
      runnerId,
      modules: { browser: { wireVersion: 2, runtimeId: "browser" } },
    },
    streamLeaseExpiresAt: new Date(Date.now() + 10_000).toISOString(),
  } as RunnerAuxiliaryStream;
  let hooks: RunnerBrowserHooks = {};
  let grants = 0;
  const send = async (_runnerId: unknown, message: RoutedHostToBrowserRelayMessage) => {
    if (message.type === "capability.grant") {
      grants++;
      if (grants > 1) return; // Initial attach works; renewal receives no reply.
      await hooks.onMessage?.(stream, {
        ...stream.fence,
        type: "capability.accepted",
        requestId: message.requestId,
        capability: {
          capabilityGeneration: message.lease.capabilityGeneration,
          capabilityLeaseId: message.lease.capabilityLeaseId,
          runtimeId: message.lease.runtimeId,
        },
      });
    } else if (message.type === "browser.attach") {
      await hooks.onMessage?.(stream, {
        ...stream.fence,
        type: "browser.attached",
        requestId: message.requestId,
        channelId: message.channelId,
        capability: message.capability,
      });
    }
  };
  const registry: RunnerBrowserRegistry = {
    browserStreams: () => [stream],
    stream: () => stream,
    send,
    subscribe: (value) => {
      hooks = value;
      return () => undefined;
    },
  };
  const router = new RunnerBrowserRuntimeRouter({ registry, requestTimeoutMs: 100 });
  try {
    const connection = router.resolve({ kind: "runner", runnerId })!.connect("ticket");
    const onError = vi.fn();
    const onClose = vi.fn();
    connection.on("error", onError);
    connection.on("close", onClose);
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.readyState).toBe(1);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(grants).toBe(2);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "The browser relay request timed out." }),
    );
    expect(onClose).toHaveBeenCalledWith(1011, expect.any(Buffer));
    expect(connection.readyState).toBe(3);
    // Vitest fails this test run if the timer produces an unhandled rejection.
  } finally {
    router.close();
  }
});

it("keeps native execution unavailable until the exact stream completes reconciliation", async () => {
  const runnerId = createId("runner");
  const storageInstanceId = crypto.randomUUID();
  const stream = {
    fence: { runnerId, connectionId: "connection-native" },
    identity: {
      runnerId,
      name: "Native",
      environmentIds: [],
      modules: {
        browser: {
          runtimeId: "native",
          wireVersion: 2,
          localProfileStorage: { storageInstanceId, engine: "electron" },
        },
      },
    },
  } as unknown as RunnerAuxiliaryStream;
  let hooks!: RunnerBrowserHooks;
  const registry: RunnerBrowserRegistry = {
    browserStreams: () => [stream],
    stream: () => stream,
    send: async () => undefined,
    subscribe: (value) => {
      hooks = value;
      return () => undefined;
    },
  };
  const reconcile = vi.fn(async () => undefined);
  const router = new RunnerBrowserRuntimeRouter({
    registry,
    localProfiles: {
      reconcileInventory: reconcile,
      jobs: async () => [],
      acknowledgeDeletion: async () => undefined,
    },
  });
  try {
    expect(router.placements()[0]?.available).toBe(false);
    expect(() => router.resolve({ kind: "runner", runnerId })).toThrow("reconcil");
    await hooks.onMessage!(stream, {
      ...stream.fence,
      module: "browser" as const,
      type: "browser.profile.inventory",
      storageInstanceId,
      engine: "electron",
      profiles: [],
      complete: false,
    } as never);
    expect(router.placements()[0]?.available).toBe(false);
    await hooks.onMessage!(stream, {
      ...stream.fence,
      module: "browser" as const,
      type: "browser.profile.inventory",
      storageInstanceId,
      engine: "electron",
      profiles: [],
      complete: true,
    } as never);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(router.placements()[0]?.available).toBe(true);
    expect(router.resolve({ kind: "runner", runnerId })).toMatchObject({
      localProfileStorage: { storageInstanceId, engine: "electron" },
    });
    hooks.onLost!(stream, "host-shutdown");
    expect(router.placements()[0]?.available).toBe(false);
  } finally {
    router.close();
  }
});

it.each(["pending-restart", "deleted", "failed"] as const)(
  "drains overlapping native deletions once per job after a %s result",
  async (outcome) => {
    const state = outcome === "failed" ? "deleted" : outcome;
    const runnerId = createId("runner"),
      storageInstanceId = crypto.randomUUID();
    const binding = {
      version: 1 as const,
      deploymentId: createId("deployment"),
      profileId: createId("browserProfile"),
      runnerId,
      storageInstanceId,
      bindingId: crypto.randomUUID(),
      engine: "electron" as const,
    };
    const deletionId = crypto.randomUUID();
    const secondBinding = {
      ...binding,
      profileId: createId("browserProfile"),
      bindingId: crypto.randomUUID(),
    };
    const secondDeletionId = crypto.randomUUID();
    const jobs = [{ binding, deletionId, state: "pending-computer" as const }];
    let joined: Promise<void> | undefined;
    const stream = {
      fence: { runnerId, connectionId: "native-erasure", connectionGeneration: 1 },
      identity: {
        runnerId,
        modules: {
          browser: {
            runtimeId: "browser",
            wireVersion: 2,
            localProfileStorage: { storageInstanceId, engine: "electron" },
          },
        },
      },
      streamLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as unknown as RunnerAuxiliaryStream;
    let hooks: RunnerBrowserHooks = {};
    const acknowledgeDeletion = vi.fn(async () => undefined);
    const sent: string[] = [];
    const registry: RunnerBrowserRegistry = {
      browserStreams: () => [stream],
      stream: () => stream,
      subscribe: (value) => {
        hooks = value;
        return () => undefined;
      },
      send: async (_id, message) => {
        sent.push(message.type);
        if (message.type === "capability.grant")
          await hooks.onMessage?.(stream, {
            ...stream.fence,
            type: "capability.accepted",
            requestId: message.requestId,
            capability: {
              capabilityGeneration: message.lease.capabilityGeneration,
              capabilityLeaseId: message.lease.capabilityLeaseId,
              runtimeId: message.lease.runtimeId,
            },
          });
        if (message.type === "browser.profile.delete") {
          if (message.deletionId === deletionId) {
            jobs.push({
              binding: secondBinding,
              deletionId: secondDeletionId,
              state: "pending-computer",
            });
            joined = router.resumeDeletions(runnerId);
          }
          await hooks.onMessage?.(stream, {
            ...message,
            type: "browser.profile.delete.result",
            deletionId:
              outcome === "failed" && message.deletionId === deletionId
                ? crypto.randomUUID()
                : message.deletionId,
            state,
          });
        }
        if (message.type === "capability.revoke")
          await hooks.onMessage?.(stream, {
            ...stream.fence,
            requestId: message.requestId,
            capability: message.capability,
            type: "capability.revoked",
          });
      },
    };
    const router = new RunnerBrowserRuntimeRouter({
      registry,
      localProfiles: {
        reconcileInventory: async () => undefined,
        jobs: async () => [...jobs],
        acknowledgeDeletion,
      },
    });
    try {
      await router.resumeDeletions(runnerId);
      expect(sent).toEqual([]);
      await hooks.onMessage?.(stream, {
        ...stream.fence,
        module: "browser" as const,
        type: "browser.profile.inventory",
        storageInstanceId,
        engine: "electron",
        profiles: [],
        complete: true,
      });
      const drained = router.resumeDeletions(runnerId);
      if (outcome === "failed") {
        await expect(drained).rejects.toThrow("mismatched profile erasure readiness");
        await expect(joined).rejects.toThrow("mismatched profile erasure readiness");
      } else {
        await drained;
        await joined;
      }
      expect(acknowledgeDeletion.mock.calls).toEqual([
        ...(outcome === "failed" ? [] : [[{ binding, deletionId, state }]]),
        [{ binding: secondBinding, deletionId: secondDeletionId, state }],
      ]);
      expect(sent).toEqual([
        "capability.grant",
        "browser.profile.delete",
        "capability.revoke",
        "capability.grant",
        "browser.profile.delete",
        "capability.revoke",
      ]);
    } finally {
      router.close();
    }
  },
);

it("never admits a failed or truncated inventory as an empty complete inventory", async () => {
  const runnerId = createId("runner"),
    storageInstanceId = crypto.randomUUID();
  const stream = {
    fence: { runnerId, connectionId: "broken-inventory" },
    identity: {
      runnerId,
      environmentIds: [],
      name: "Broken",
      modules: {
        browser: {
          runtimeId: "browser",
          wireVersion: 2,
          localProfileStorage: { storageInstanceId, engine: "electron" },
        },
      },
    },
  } as unknown as RunnerAuxiliaryStream;
  let hooks: RunnerBrowserHooks = {};
  const router = new RunnerBrowserRuntimeRouter({
    registry: {
      browserStreams: () => [stream],
      stream: () => stream,
      send: async () => undefined,
      subscribe: (value) => {
        hooks = value;
        return () => undefined;
      },
    },
    localProfiles: {
      reconcileInventory: async () => {
        throw new Error("unreadable inventory");
      },
      jobs: async () => [],
      acknowledgeDeletion: async () => undefined,
    },
  });
  const inventory = {
    ...stream.fence,
    module: "browser" as const,
    type: "browser.profile.inventory" as const,
    storageInstanceId,
    engine: "electron" as const,
    profiles: [],
    complete: true,
  };
  try {
    await expect(hooks.onMessage!(stream, inventory)).rejects.toThrow("unreadable inventory");
    expect(router.placements()[0]?.available).toBe(false);
    await expect(hooks.onMessage!(stream, inventory)).rejects.toThrow("already complete");
    expect(router.placements()[0]?.available).toBe(false);
  } finally {
    router.close();
  }
});

it("retries the same erasure after a lost acknowledgement on a replacement auxiliary stream", async () => {
  vi.useFakeTimers();
  const runnerId = createId("runner"),
    storageInstanceId = crypto.randomUUID(),
    deletionId = crypto.randomUUID();
  const binding = {
    version: 1 as const,
    deploymentId: createId("deployment"),
    profileId: createId("browserProfile"),
    runnerId,
    storageInstanceId,
    bindingId: crypto.randomUUID(),
    engine: "electron" as const,
  };
  let stream = {
    fence: {
      runnerId,
      connectionId: "same-primary",
      auxiliaryStreamId: "first-stream",
      connectionGeneration: 1,
    },
    identity: {
      runnerId,
      environmentIds: [],
      name: "Owner",
      modules: {
        browser: {
          runtimeId: "browser",
          wireVersion: 2,
          localProfileStorage: { storageInstanceId, engine: "electron" },
        },
      },
    },
    streamLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  } as unknown as RunnerAuxiliaryStream;
  let hooks: RunnerBrowserHooks = {};
  let attempts = 0;
  const acknowledgeDeletion = vi.fn(async () => undefined);
  const registry: RunnerBrowserRegistry = {
    browserStreams: () => [stream],
    stream: () => stream,
    subscribe: (value) => {
      hooks = value;
      return () => undefined;
    },
    send: async (_runnerId, message) => {
      if (message.type === "capability.grant")
        await hooks.onMessage?.(stream, {
          ...stream.fence,
          type: "capability.accepted",
          requestId: message.requestId,
          capability: {
            capabilityGeneration: message.lease.capabilityGeneration,
            capabilityLeaseId: message.lease.capabilityLeaseId,
            runtimeId: message.lease.runtimeId,
          },
        });
      if (message.type === "browser.profile.delete") {
        expect(message).toMatchObject({ deletionId, binding });
        if (++attempts > 1)
          await hooks.onMessage?.(stream, {
            ...message,
            type: "browser.profile.delete.result",
            state: "deleted",
          });
      }
      if (message.type === "capability.revoke")
        await hooks.onMessage?.(stream, {
          ...stream.fence,
          type: "capability.revoked",
          requestId: message.requestId,
          capability: message.capability,
        });
    },
  };
  const router = new RunnerBrowserRuntimeRouter({
    registry,
    requestTimeoutMs: 100,
    localProfiles: {
      reconcileInventory: async () => undefined,
      jobs: async () => [{ binding, deletionId, state: "pending-computer" }],
      acknowledgeDeletion,
    },
  });
  const inventory = () => ({
    ...stream.fence,
    module: "browser" as const,
    type: "browser.profile.inventory" as const,
    storageInstanceId,
    engine: "electron" as const,
    profiles: [],
    complete: true,
  });
  try {
    await hooks.onMessage!(stream, inventory());
    const lostAck = expect(router.resumeDeletions(runnerId)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(120_000);
    await lostAck;
    expect(acknowledgeDeletion).not.toHaveBeenCalled();
    hooks.onLost?.(stream, "host-shutdown");
    stream = {
      ...stream,
      streamLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      fence: {
        ...stream.fence,
        auxiliaryStreamId: "second-stream" as RunnerAuxiliaryStream["fence"]["auxiliaryStreamId"],
      },
    };
    expect(router.placements()[0]?.available).toBe(false);
    await hooks.onMessage!(stream, inventory());
    await router.resumeDeletions(runnerId);
    expect(attempts).toBe(2);
    expect(acknowledgeDeletion).toHaveBeenCalledExactlyOnceWith({
      binding,
      deletionId,
      state: "deleted",
    });
  } finally {
    router.close();
  }
});

it("shares capability acquisition when one of two concurrent attachments is cancelled", async () => {
  const runnerId = createId("runner");
  const stream = {
    fence: { runnerId, connectionId: "concurrent", connectionGeneration: 1 },
    identity: {
      runnerId,
      modules: { browser: { runtimeId: "browser", wireVersion: 2 } },
    },
    streamLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  } as RunnerAuxiliaryStream;
  let hooks: RunnerBrowserHooks = {};
  let grant: Extract<RoutedHostToBrowserRelayMessage, { type: "capability.grant" }> | undefined;
  let grants = 0,
    revokes = 0;
  const router = new RunnerBrowserRuntimeRouter({
    registry: {
      browserStreams: () => [stream],
      stream: () => stream,
      subscribe: (value) => {
        hooks = value;
        return () => undefined;
      },
      send: async (_runnerId, message) => {
        if (message.type === "capability.grant") {
          grants++;
          grant = message;
        }
        if (message.type === "browser.attach")
          await hooks.onMessage?.(stream, {
            ...stream.fence,
            type: "browser.attached",
            requestId: message.requestId,
            channelId: message.channelId,
            capability: message.capability,
          });
        if (message.type === "capability.revoke") {
          revokes++;
          await hooks.onMessage?.(stream, {
            ...stream.fence,
            type: "capability.revoked",
            requestId: message.requestId,
            capability: message.capability,
          });
        }
      },
    },
  });
  try {
    const target = router.resolve({ kind: "runner", runnerId })!;
    const first = target.connect("first"),
      second = target.connect("second");
    first.on("error", () => undefined);
    second.on("error", () => undefined);
    await vi.waitFor(() => expect(grants, "capability acquisition did not begin").toBe(1));
    first.close();
    await hooks.onMessage!(stream, {
      ...stream.fence,
      type: "capability.accepted",
      requestId: grant!.requestId,
      capability: {
        capabilityGeneration: grant!.lease.capabilityGeneration,
        capabilityLeaseId: grant!.lease.capabilityLeaseId,
        runtimeId: grant!.lease.runtimeId,
      },
    });
    await vi.waitFor(() =>
      expect(second.readyState, "remaining attachment lost its capability").toBe(1),
    );
    expect(grants).toBe(1);
    expect(revokes).toBe(0);
  } finally {
    router.close();
  }
});

it("requires the profile home's inventory, not Personal's Main inventory", async () => {
  const mainRunnerId = createId("runner"),
    otherRunnerId = createId("runner");
  const makeStream = (runnerId: typeof mainRunnerId, runnerKind: "main" | "managed") =>
    ({
      fence: { runnerId, connectionId: runnerId },
      identity: {
        runnerId,
        runnerKind,
        modules: {
          browser: {
            runtimeId: "browser",
            wireVersion: 2,
            localProfileStorage: { storageInstanceId: crypto.randomUUID(), engine: "electron" },
          },
        },
      },
    }) as unknown as RunnerAuxiliaryStream;
  const main = makeStream(mainRunnerId, "main"),
    other = makeStream(otherRunnerId, "managed");
  let hooks: RunnerBrowserHooks = {};
  const streams = [main, other];
  const router = new RunnerBrowserRuntimeRouter({
    registry: {
      browserStreams: () => streams,
      stream: (id) => streams.find((stream) => stream.identity.runnerId === id) ?? null,
      send: async () => undefined,
      subscribe: (value) => {
        hooks = value;
        return () => undefined;
      },
    },
    localProfiles: {
      reconcileInventory: async () => undefined,
      jobs: async () => [],
      acknowledgeDeletion: async () => undefined,
    },
  });
  const inventory = (stream: RunnerAuxiliaryStream) => ({
    ...stream.fence,
    module: "browser" as const,
    type: "browser.profile.inventory" as const,
    ...stream.identity.modules.browser!.localProfileStorage!,
    profiles: [],
    complete: true,
  });
  try {
    expect(() => router.requirePersonalProfileInventory(otherRunnerId)).toThrow("home computer");
    await hooks.onMessage!(other, inventory(other));
    expect(() => router.requirePersonalProfileInventory(otherRunnerId)).not.toThrow();
    expect(() => router.requirePersonalProfileInventory(mainRunnerId)).toThrow("home computer");
    await hooks.onMessage!(main, inventory(main));
    expect(() => router.requirePersonalProfileInventory(mainRunnerId)).not.toThrow();
    hooks.onLost?.(main, "host-shutdown");
    expect(() => router.requirePersonalProfileInventory(mainRunnerId)).toThrow("home computer");
    expect(() => router.requirePersonalProfileInventory(otherRunnerId)).not.toThrow();
  } finally {
    router.close();
  }
});

it("reports a rejected attachment's reason before closing its channel", async () => {
  const runnerId = createId("runner");
  const stream = {
    fence: { runnerId, connectionId: "connection", connectionGeneration: 1 },
    identity: {
      runnerId,
      modules: { browser: { wireVersion: 2, runtimeId: "browser" } },
    },
    streamLeaseExpiresAt: new Date(Date.now() + 10_000).toISOString(),
  } as RunnerAuxiliaryStream;
  let hooks: RunnerBrowserHooks = {};
  const router = new RunnerBrowserRuntimeRouter({
    registry: {
      browserStreams: () => [stream],
      stream: () => stream,
      subscribe: (value) => {
        hooks = value;
        return () => {};
      },
      send: async (_runnerId, message) => {
        if (message.type === "capability.grant")
          await hooks.onMessage?.(stream, {
            ...stream.fence,
            type: "capability.accepted",
            requestId: message.requestId,
            capability: {
              capabilityGeneration: message.lease.capabilityGeneration,
              capabilityLeaseId: message.lease.capabilityLeaseId,
              runtimeId: message.lease.runtimeId,
            },
          });
        if (message.type === "browser.attach")
          await hooks.onMessage?.(stream, {
            ...stream.fence,
            type: "browser.command-error",
            channelId: message.channelId,
            requestId: message.requestId,
            error: {
              code: "conflict",
              message: "Profile initialization was refused",
              retryable: false,
            },
          });
        if (message.type === "capability.revoke")
          await hooks.onMessage?.(stream, {
            ...stream.fence,
            type: "capability.revoked",
            requestId: message.requestId,
            capability: message.capability,
          });
      },
    },
    requestTimeoutMs: 1000,
  });
  try {
    const connection = router.resolve({ kind: "runner", runnerId })!.connect("ticket");
    const errors: string[] = [];
    connection.on("error", (error: Error) => errors.push(error.message));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Rejected browser attachment never closed")),
        1000,
      );
      connection.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    expect(errors).toEqual(["Profile initialization was refused"]);
  } finally {
    router.close();
  }
});

it("gives attachment the startup budget", async () => {
  vi.useFakeTimers();
  const runnerId = createId("runner");
  const stream = {
    fence: { runnerId, connectionId: "connection", connectionGeneration: 1 },
    identity: {
      runnerId,
      modules: {
        browser: {
          wireVersion: 2,
          runtimeId: "browser",
          localProfileStorage: {
            storageInstanceId: "00000000-0000-4000-8000-000000000001",
            engine: "chromium",
          },
        },
      },
    },
    streamLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  } as unknown as RunnerAuxiliaryStream;
  let hooks: RunnerBrowserHooks = {};
  const router = new RunnerBrowserRuntimeRouter({
    localProfiles: {
      reconcileInventory: async () => {},
      jobs: async () => [],
      acknowledgeDeletion: async () => {},
    },
    registry: {
      browserStreams: () => [stream],
      stream: () => stream,
      subscribe: (value) => {
        hooks = value;
        return () => {};
      },
      send: async (_runnerId, message) => {
        if (message.type === "capability.grant")
          await hooks.onMessage?.(stream, {
            ...stream.fence,
            type: "capability.accepted",
            requestId: message.requestId,
            capability: {
              capabilityGeneration: message.lease.capabilityGeneration,
              capabilityLeaseId: message.lease.capabilityLeaseId,
              runtimeId: message.lease.runtimeId,
            },
          });
        if (message.type === "browser.attach")
          setTimeout(() => {
            void hooks.onMessage?.(stream, {
              ...stream.fence,
              type: "browser.attached",
              requestId: message.requestId,
              channelId: message.channelId,
              capability: message.capability,
            });
          }, 6000);
      },
    },
  });
  try {
    await hooks.onMessage?.(stream, {
      ...stream.fence,
      module: "browser",
      type: "browser.profile.inventory",
      storageInstanceId: "00000000-0000-4000-8000-000000000001",
      engine: "chromium",
      profiles: [],
      complete: true,
    });
    const target = router.resolve({ kind: "runner", runnerId })!;
    const connection = target.connect("ticket");
    const error = vi.fn();
    connection.on("error", error);
    await vi.advanceTimersByTimeAsync(6000);
    expect(error).not.toHaveBeenCalled();
    expect(connection.readyState).toBe(WebSocket.OPEN);
  } finally {
    router.close();
  }
});

it.each(["timeout", "cancel"] as const)(
  "closes only the pending runtime attachment on Host %s with a live sibling",
  async (cause) => {
    vi.useFakeTimers();
    const runnerId = createId("runner");
    const stream = {
      fence: { runnerId, connectionId: "connection", connectionGeneration: 1 },
      identity: {
        runnerId,
        modules: { browser: { wireVersion: 2, runtimeId: "browser" } },
      },
      streamLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as RunnerAuxiliaryStream;
    let hooks: RunnerBrowserHooks = {};
    const sent: BrowserRuntimeRelayRequest[] = [];
    const responseErrors: unknown[] = [];
    let siblingId: string | undefined;
    const router = new RunnerBrowserRuntimeRouter({
      requestTimeoutMs: 1000,
      registry: {
        browserStreams: () => [stream],
        stream: () => stream,
        subscribe: (value) => {
          hooks = value;
          return () => {};
        },
        send: async (_runnerId, message) => {
          sent.push(message);
          if (message.type === "capability.grant")
            await hooks.onMessage?.(stream, {
              ...stream.fence,
              type: "capability.accepted",
              requestId: message.requestId,
              capability: {
                capabilityGeneration: message.lease.capabilityGeneration,
                capabilityLeaseId: message.lease.capabilityLeaseId,
                runtimeId: message.lease.runtimeId,
              },
            });
          if (message.type === "browser.attach" && !siblingId) {
            siblingId = message.channelId;
            await hooks.onMessage?.(stream, {
              ...stream.fence,
              type: "browser.attached",
              channelId: message.channelId,
              capability: message.capability,
              requestId: message.requestId,
            });
          }
          if (message.type === "browser.close")
            await hooks
              .onMessage?.(stream, {
                ...stream.fence,
                ...message,
                type: "browser.closed",
                code: 1000,
                reason: "cancelled",
              })
              .catch((error: unknown) => {
                responseErrors.push(error);
              });
        },
      },
    });
    try {
      const target = router.resolve({ kind: "runner", runnerId })!;
      const sibling = target.connect("ticket");
      sibling.on("error", () => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(sibling.readyState).toBe(WebSocket.OPEN);
      const pending = target.connect("ticket");
      pending.on("error", () => {});
      await vi.advanceTimersByTimeAsync(0);
      const attach = sent.filter((message) => message.type === "browser.attach").at(-1)!;
      if (cause === "cancel") pending.close();
      await vi.advanceTimersByTimeAsync(cause === "timeout" ? 20_000 : 0);
      expect(sent.filter((message) => message.type === "browser.close")).toEqual([
        expect.objectContaining({
          channelId: "channelId" in attach ? attach.channelId : undefined,
        }),
      ]);
      expect(responseErrors).toEqual([]);
      if (cause === "timeout" && attach.type === "browser.attach") {
        await expect(
          hooks.onMessage!(stream, {
            ...stream.fence,
            type: "browser.attached",
            requestId: attach.requestId,
            channelId: attach.channelId,
            capability: attach.capability,
          }),
        ).resolves.toBeUndefined();
        await expect(
          hooks.onMessage!(stream, {
            ...stream.fence,
            type: "browser.command-error",
            requestId: attach.requestId,
            channelId: attach.channelId,
            error: { code: "conflict", message: "attach cancelled", retryable: false },
          }),
        ).resolves.toBeUndefined();
      }
      expect(sibling.readyState).toBe(WebSocket.OPEN);
      expect(sent.some((message) => message.type === "capability.revoke")).toBe(false);
    } finally {
      router.close();
    }
  },
);

it("waits for stream admission and complete inventory, independently cancels waiters and closes them", async () => {
  const { RunnerBrowserHub } = await import("./runner-browser-hub.js");
  const hub = new RunnerBrowserHub();
  const runnerId = createId("runner");
  const stream = {
    fence: { runnerId, connectionId: "startup", connectionGeneration: 1 },
    identity: {
      runnerId,
      modules: {
        browser: {
          runtimeId: "startup-browser",
          wireVersion: 2,
          localProfileStorage: { storageInstanceId: "startup-storage", engine: "chromium" },
        },
      },
    },
  } as unknown as RunnerAuxiliaryStream;
  const router = new RunnerBrowserRuntimeRouter({
    registry: hub,
    localProfiles: {
      reconcileInventory: async () => {},
      jobs: async () => [],
      acknowledgeDeletion: async () => {},
    },
  });
  const peer = { id: "startup", close: () => {}, send: async () => {} };
  const abort = new AbortController();
  const cancelled = router.waitForTarget(runnerId, abort.signal);
  const cancellation = expect(cancelled).rejects.toThrow("cancelled");
  const first = router.waitForTarget(runnerId, new AbortController().signal);
  const second = router.waitForTarget(runnerId, new AbortController().signal);
  abort.abort(new Error("cancelled"));
  await cancellation;
  hub.attach(peer, stream);
  expect(router.pendingAdmission(runnerId)).toBe(true);
  let ready = false;
  void first.then(() => {
    ready = true;
  });
  await hub.handleMessage(peer, {
    ...stream.fence,
    type: "browser.profile.inventory",
    module: "browser",
    storageInstanceId: "startup-storage",
    engine: "chromium",
    profiles: [],
    complete: false,
  });
  expect(ready).toBe(false);
  await hub.handleMessage(peer, {
    ...stream.fence,
    type: "browser.profile.inventory",
    module: "browser",
    storageInstanceId: "startup-storage",
    engine: "chromium",
    profiles: [],
    complete: true,
  });
  await Promise.all([first, second]);
  expect(router.pendingAdmission(runnerId)).toBe(false);
  const closing = expect(
    router.waitForTarget(createId("runner"), new AbortController().signal),
  ).rejects.toThrow("closed");
  router.close();
  await closing;
  hub.close();
});
