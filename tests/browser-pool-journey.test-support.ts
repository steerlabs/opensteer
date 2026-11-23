import { readBrowserPoolSlot, TabStore } from "../packages/database/src/index.js";
import {
  createStoreFixture,
  personalBrowserRepository,
} from "../packages/database/src/store.integration.test-support.js";
import {
  BrowserClientMessageSchema,
  BrowserSessionIdSchema,
  decodeBrowserFrameEnvelope,
  type InitialPageReady,
} from "../packages/protocol/src/browser.js";
import { BrowserChannelIdSchema } from "../packages/protocol/src/browser-relay.js";
import { LocalBrowserRuntimeBridge } from "../packages/runner-client/src/browser-bridge.js";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { expect, vi, onTestFinished } from "vitest";
import { createId } from "../packages/core/src/index.js";
import { chromium } from "playwright-core";
import { PlaywrightChromiumLauncher } from "../apps/browser-runtime/src/browser/playwright-launcher.js";
import {
  BrowserPoolCoordinator,
  loopbackPoolChannel,
  type BrowserPoolRuntimeChannel,
} from "../apps/host/src/browser/browser-pool-coordinator.js";
import { FakeBrowserPoolController } from "../apps/host/src/browser/browser-pool-controller.test-support.js";
import {
  BrowserService,
  type BrowserRuntimeConnection,
  type BrowserRuntimeTarget,
} from "../apps/host/src/browser/browser-service.js";
import { BrowserAttachTicketSigner } from "../apps/host/src/browser/browser-ticket.js";
import { BrowserLocalProfiles } from "../apps/host/src/browser/browser-local-profiles.js";
import {
  BrowserRuntime,
  BrowserRuntimeServer,
  Ed25519AttachTicketVerifier,
  type LaunchedBrowser,
} from "../packages/browser-runtime-core/src/index.js";
import { FakeIsolatingLauncher } from "../packages/browser-runtime-core/src/test-support/fakes.js";

/** Decodes a frame to raw pixels with the Host's own image library. */
const sharp = createRequire(new URL("../apps/host/package.json", import.meta.url))("sharp") as (
  input: Buffer,
) => {
  raw(): {
    toBuffer(options: { resolveWithObject: true }): Promise<{
      data: Buffer;
      info: { width: number; height: number; channels: number };
    }>;
  };
};

export class TestRuntimeConnection extends EventEmitter implements BrowserRuntimeConnection {
  readyState = 0;
  initialPage: InitialPageReady | undefined;
  private readonly channel = BrowserChannelIdSchema.parse(`bch_${randomUUID()}`);
  private readonly bridge: LocalBrowserRuntimeBridge;

  constructor(bridge: LocalBrowserRuntimeBridge, ticket: string) {
    super();
    this.bridge = bridge;
    const pending: [Buffer, boolean][] = [];
    const frame = (data: Buffer, binary: boolean) => {
      if (this.readyState === 0) pending.push([data, binary]);
      // As a WebSocket does, frames that arrive while its close is under way are still received.
      else if (this.readyState === 1 || this.readyState === 2) this.emit("message", data, binary);
    };
    void bridge
      .attach(this.channel, ticket, {
        onFrame: (_channel, value) => frame(value, true),
        onServerMessage: (_channel, value) => frame(Buffer.from(JSON.stringify(value)), false),
        onClosed: (_channel, code, reason) => this.end(code, reason),
      })
      .then((attached) => {
        if (this.readyState === 3) return;
        this.initialPage = attached.initialPage;
        this.readyState = 1;
        for (const [data, binary] of pending) frame(data, binary);
        pending.length = 0;
      })
      .catch((error: unknown) => {
        // A refused attach closes the channel whether or not anyone listens for the error.
        if (this.listenerCount("error")) this.emit("error", error);
        this.end(1011, "attach failed");
      });
  }

  send(data: string, _options: { binary: false }, callback: (error?: Error) => void): void {
    void this.bridge.send(this.channel, BrowserClientMessageSchema.parse(JSON.parse(data))).then(
      () => callback(),
      (error) => callback(error),
    );
  }

  /** The Runner carrying this channel went away: the Home sees the channel drop. */
  lose(code: number, reason: string): void {
    this.end(code, reason);
  }

  private end(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", code, Buffer.from(reason)));
  }

  /**
   * As the Runner's relay does for a pool guest: the close goes to the runtime, and the code the
   * Home sees is the runtime's own answer (1006 when none comes), never one made up here.
   */
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 2;
    void this.bridge
      .closeWithReceipt(this.channel, 5_000)
      .then((code) => this.end(code, code === 1000 ? "closed" : "runtime did not answer"));
  }

  terminate(): void {
    this.bridge.close(this.channel);
    this.end(1006, "terminated");
  }
}

export type Home = { service: BrowserService; coordinator: BrowserPoolCoordinator };

/** Hangs every runtime control from the named one on, as a Home that died just after it. */
export function dyingAfter(runtime: BrowserRuntime, kind: string): BrowserPoolRuntimeChannel {
  let dead = false;
  return {
    poolState: async () => runtime.poolState() ?? null,
    controlPool: async (control, signature) => {
      if (dead) return new Promise(() => {});
      const state = await runtime.controlPool(control, signature);
      if (control.kind === kind) {
        dead = true;
        return new Promise(() => {});
      }
      return state;
    },
    endSession: (ticket) => (dead ? new Promise(() => {}) : runtime.endPoolSession(ticket)),
  };
}

export async function journey(
  key: string,
  options: {
    readonly chromium?: boolean;
    readonly profile?: boolean;
    readonly runtimeFault?: ConstructorParameters<typeof BrowserPoolCoordinator>[0]["runtimeFault"];
    readonly channelDeadlineMs?: number;
    /** How often a running guest's status is read (60 s by default). */
    readonly statusEveryMs?: number;
    /** The guest's page probe during a retire; a retire waits for it. */
    readonly probePage?: (page: unknown, phase: "active" | "frozen") => Promise<readonly string[]>;
  } = {},
) {
  const real = options.chromium !== false;
  const fixture = await createStoreFixture();
  const root = await mkdtemp(join(tmpdir(), "opensteer-pool-route-"));
  const task = await fixture.startRunFixture(key);
  const { database, store } = fixture;
  await database
    .updateTable("runners")
    .set({ allowedModules: sql`'["agents","browser"]'::jsonb` })
    .where("id", "=", task.runnerId)
    .execute();
  const slotId = `slot-${key}`;
  // The loopback runtime outlives a start: the controller sees what it holds.
  const controller = new FakeBrowserPoolController({
    slotId,
    term: 1,
    guest: () => guest.poolState()?.fence ?? null,
  });
  const tickets = generateKeyPairSync("ed25519");
  let launched: LaunchedBrowser | undefined;
  const launcher = real
    ? new PlaywrightChromiumLauncher({
        chromiumSandbox: false,
        executablePath: chromium.executablePath(),
        headless: true,
      })
    : new FakeIsolatingLauncher();
  if (real) {
    const launch = launcher.launch.bind(launcher);
    vi.spyOn(launcher, "launch").mockImplementation(async (request) => {
      const browser = await launch(request);
      launched = browser;
      return browser;
    });
  }
  const guest = new BrowserRuntime({
    runtimeId: "pool-runtime",
    launcher,
    sessionFilesRoot: join(root, "sessions"),
    ...(options.profile ? { localProfiles: { root: join(root, "profiles") } } : {}),
    ticketVerifier: await Ed25519AttachTicketVerifier.create({
      pooled: true,
      replayLedgerPath: join(root, "private", "tickets.json"),
      resolvePublicKey: (id) => (id === "test" ? tickets.publicKey : null),
    }),
    pool: {
      controllerKey: controller.publicKey,
      probePage: options.probePage ?? (async () => []),
      ...(options.channelDeadlineMs ? { channelDeadlineMs: options.channelDeadlineMs } : {}),
    },
  });
  const bridgeToken = randomUUID();
  const runtimeServer = new BrowserRuntimeServer({
    runtime: guest,
    port: 0,
    relayBridge: {
      token: bridgeToken,
      updateAttachKeys: () => {
        throw new Error("The loopback data bridge cannot replace the pooled ticket key.");
      },
    },
  });
  const address = await runtimeServer.start();
  const bridge = new LocalBrowserRuntimeBridge({
    bridgeToken,
    runtimeId: "pool-runtime",
    url: new URL(`http://${address.host}:${address.port}`),
  });
  bridge.setAttachPublicKeys([
    {
      keyId: "test",
      publicKeyPem: tickets.publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
  ]);
  const signer = new BrowserAttachTicketSigner({ keyId: "test", privateKey: tickets.privateKey });
  const issued: string[] = [];
  // A ticket the Home issued that never reached the runtime, as if its delivery were lost.
  const withheld: string[] = [];
  let withholdNext = false;
  let runnerDown = false;
  const connections: TestRuntimeConnection[] = [];
  let onTicket: ((ticket: string) => void) | undefined;
  const connect = (ticket: string) => {
    issued.push(ticket);
    const hook = onTicket;
    onTicket = undefined;
    hook?.(ticket);
    if (withholdNext) {
      withholdNext = false;
      withheld.push(ticket);
      return new TestRuntimeConnection(bridge, "withheld");
    }
    const connection = new TestRuntimeConnection(bridge, ticket);
    connections.push(connection);
    return connection;
  };
  const placement = {
    kind: "runner" as const,
    runnerId: task.runnerId,
    label: "Pooled test browser",
    runtimeId: "pool-runtime",
    environmentIds: [task.environmentId],
    available: true,
  };
  const tabs = new TabStore(database);
  const profile = options.profile
    ? await store.createBrowserProfile({
        name: "Saved browser",
        ownerId: task.userId,
        homeRunnerId: task.runnerId,
        idempotencyKey: "saved-profile",
      })
    : null;
  const homes: Home[] = [];
  // The journey's Runner stands for the whole way to the guest: while it is away the runtime's
  // end request is not answered either.
  const reachableGuest: BrowserPoolRuntimeChannel = {
    ...loopbackPoolChannel(guest),
    endSession: (ticket) =>
      runnerDown
        ? Promise.reject(new Error("The guest cannot be reached."))
        : guest.endPoolSession(ticket),
  };
  const startHome = async (channel: BrowserPoolRuntimeChannel = reachableGuest): Promise<Home> => {
    const coordinator = new BrowserPoolCoordinator({
      database,
      runnerId: task.runnerId,
      runtimeId: "pool-runtime",
      slotId,
      term: 1,
      runtime: channel,
      controller,
      retryMs: 20,
      onError: (error) => {
        if (process.env.POOL_DEBUG) console.log("COORDERR", error);
      },
      ...(options.runtimeFault ? { runtimeFault: options.runtimeFault } : {}),
      ...(options.channelDeadlineMs ? { channelDeadlineMs: options.channelDeadlineMs } : {}),
      ...(options.statusEveryMs ? { statusEveryMs: options.statusEveryMs } : {}),
    });
    const service = new BrowserService({
      deploymentId: task.deploymentId,
      hostOrigin: new URL("http://127.0.0.1"),
      personal: true,
      pools: new Map([[task.runnerId, coordinator]]),
      tabs,
      tabPlaces: { write: async () => false, notice: () => {} },
      repository: personalBrowserRepository(store),
      ...(profile
        ? {
            localProfiles: new BrowserLocalProfiles({
              deploymentId: task.deploymentId,
              repository: store,
              baseUrl: new URL("http://127.0.0.1"),
            }),
          }
        : {}),
      signer,
      onError: (error) => {
        if (process.env.POOL_DEBUG) console.log("HOSTERR", error);
      },
      onSessionsChanged: () => {},
      targetResolver: {
        placements: () => [placement],
        // While the Runner is away its browser target does not resolve.
        resolve: () => (runnerDown ? undefined : target()),
      },
    });
    const home = { service, coordinator };
    homes.push(home);
    await service.initialize();
    // initialize does not wait for the pool's recovery; these journeys start from a recovered one.
    await coordinator.recover();
    return home;
    function target() {
      return {
        runtimeId: "pool-runtime",
        placementKey: "pool-test",
        main: true,
        surfaceState: 1,
        tabRestoreVersion: true,
        sharedControl: true,
        cdpBoundary: true,
        ...(guest.localProfileStorage ? { localProfileStorage: guest.localProfileStorage } : {}),
        connect,
        // Standard CDP straight into the in-process runtime, with its recovery probe.
        standardCdpLineage: true,
        // As a current runtime advertises: it holds a connection's rules itself.
        connectionCommands: true,
        standardRuntime: guest,
        standardCdpRecovery: {
          relayId: "pool-loopback",
          boot: async () => guest.standardCdpBootId,
          assertCurrent: () => {},
        },
        reconcileStandardCdpAttempt: (attempt) =>
          guest.reconcileStandardCdpAttempt(attempt).then(({ runtimeBootId }) => runtimeBootId),
        wholeContextCdp: true,
        // The loopback runtime follows a target without pictures too.
        targetControl: true,
      } satisfies BrowserRuntimeTarget;
    }
  };
  const restartHome = async (home: Home, channel?: BrowserPoolRuntimeChannel) => {
    await home.service.close();
    home.coordinator.close();
    // The Home's link to the Runner ends with it: the Runner closes what it carried for the Home
    // (1001), as it does when its stream to the Home goes.
    bridge.closeAll(1001, "browser stream closed");
    for (const connection of connections.splice(0)) connection.lose(1006, "home gone");
    return startHome(channel);
  };
  /** The Home process dies: nothing is closed gracefully, every channel drops, and it starts. */
  const crashHome = async (home: Home) => {
    home.coordinator.close();
    bridge.closeAll(1011, "home gone");
    for (const connection of connections.splice(0)) connection.lose(1006, "home gone");
    return startHome();
  };
  const command = (idempotencyKey: string) => ({
    type: "browser.tab.open" as const,
    identity: { kind: "guest" as const },
    placement: { kind: "runner" as const, runnerId: task.runnerId },
    idempotencyKey,
  });
  /** Types an unsent draft into the newest page; a key "x" later turns the page green. */
  const draft = async (index = -1) => {
    const page = launched?.context.pages().at(index);
    if (!page) throw new Error("The test runtime did not launch a page.");
    const cdp = await page.cdp();
    await cdp.send("Runtime.evaluate", {
      expression: `
        document.body.innerHTML = '<input style="font-size:32px;width:90%">';
        document.body.style.backgroundColor = '#ffffff';
        document.body.style.minHeight = '100vh';
        const input = document.querySelector('input');
        input.addEventListener('input', () => {
          document.body.style.backgroundColor = input.value.endsWith('x') ? '#147443' : '#ffffff';
        });
        input.focus();
        window.marker = 99;
      `,
    });
    await cdp.send("Input.insertText", { text: "unsent draft" });
    const value = async () =>
      (
        await cdp.send<{ result: { value: string } }>("Runtime.evaluate", {
          expression: "JSON.stringify([document.querySelector('input').value, window.marker])",
          returnByValue: true,
        })
      ).result.value;
    const rendered = () =>
      cdp.send("Runtime.evaluate", {
        expression:
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        awaitPromise: true,
      });
    return { page, cdp, targetId: await page.targetId(), value, rendered };
  };
  const viewer = (
    home: Home,
    sessionId: string,
    mode: "control" | "watch" = "control",
    onFrame?: () => void,
  ) => {
    let open = true;
    const frames: Buffer[] = [];
    /** Every text message the viewer was sent, parsed. */
    const messages: Record<string, unknown>[] = [];
    const waiting: { count: number; resolve: () => void }[] = [];
    /** Resolves once a frame arrives after the first `count`: on the stream, not on a clock. */
    const next = (count: number) =>
      frames.length > count
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiting.push({ count, resolve }));
    const attaching = home.service.attach(
      task.userId,
      BrowserSessionIdSchema.parse(sessionId),
      {
        id: `viewer-${randomUUID()}`,
        isOpen: () => open,
        close: () => {
          open = false;
        },
        send: async (data, binary) => {
          if (!binary && typeof data === "string")
            messages.push(JSON.parse(data) as Record<string, unknown>);
          else if (!binary && Buffer.isBuffer(data))
            messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
          if (binary && Buffer.isBuffer(data)) {
            if (!frames.length) onFrame?.();
            frames.push(data);
            for (const waiter of waiting.splice(0))
              if (frames.length > waiter.count) waiter.resolve();
              else waiting.push(waiter);
          }
        },
      },
      { authSessionId: createId("authSession"), mode, signedIn: async () => true },
    );
    void attaching.catch(() => undefined);
    return { attaching, frames, next, messages };
  };
  const close = async () => {
    try {
      for (const home of homes) {
        home.coordinator.close();
        await home.service.close().catch(() => undefined);
      }
      await runtimeServer.close();
    } finally {
      await rm(root, { recursive: true, force: true });
      await fixture.close();
    }
  };
  return {
    fixture,
    task,
    database,
    store,
    controller,
    guest,
    tabs,
    profile,
    issued,
    connect,
    withheld,
    withholdNextTicket: () => {
      withholdNext = true;
    },
    /** Runs once, as the next ticket leaves the Home for the runtime. */
    onNextTicket: (hook: (ticket: string) => void) => {
      onTicket = hook;
    },
    /**
     * The Runner restarts: every channel drops, the guest keeps running. `homeCode` is the close
     * code the Home sees; the runtime always sees the Runner's own 1011 (a 1000 reaches it only
     * as the relay of the Home's own close).
     */
    /**
     * The tunnel from the Runner to the guest breaks: the runtime sees every channel drop (1011)
     * and keeps its sessions, while the Home's channels are left as they are.
     */
    tunnelBreaks: () => bridge.closeAll(1011, "pool tunnel broke"),
    runnerDown: (homeCode = 1011) => {
      runnerDown = true;
      bridge.closeAll(1011, "runner restarting");
      for (const connection of connections.splice(0))
        connection.lose(homeCode, "runner restarting");
    },
    runnerUp: () => {
      runnerDown = false;
    },
    signer,
    startHome,
    restartHome,
    crashHome,
    command,
    /** The real browser the guest launched, for a page no session's agent holds. */
    launched: () => launched,
    draft,
    viewer,
    slot: () => readBrowserPoolSlot(database, task.runnerId),
    row: (sessionId: string) =>
      store.getBrowserSessionForOwner(BrowserSessionIdSchema.parse(sessionId), task.userId),
    close,
  };
}

/** Holds the next resume until `allow` resolves; `seen` resolves when it arrives. */
export function holdResume(controller: FakeBrowserPoolController) {
  const seen = Promise.withResolvers<void>();
  const allow = Promise.withResolvers<void>();
  controller.hold("resume", async () => {
    seen.resolve();
    await allow.promise;
  });
  return { seen: seen.promise, allow: () => allow.resolve(), release: allow };
}

export async function before<T>(gate: Promise<void>, work: Promise<T>, what: string) {
  await Promise.race([
    gate,
    work.then(() => {
      throw new Error(`${what} completed before the browser resumed.`);
    }),
  ]);
}

export async function greenAt(frame: Buffer, tabId: string): Promise<boolean | undefined> {
  const decoded = decodeBrowserFrameEnvelope(frame);
  if (decoded.header.surfaceId !== tabId) return undefined;
  const { data, info } = await sharp(Buffer.from(decoded.data))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const offset = (Math.floor(info.height * 0.75) * info.width + (info.width >> 1)) * info.channels;
  const [red, green, blue] = [data[offset]!, data[offset + 1]!, data[offset + 2]!];
  return green > 90 && red < 70 && blue < 110;
}

/** The edit is visible only if a frame shows the page's own colour change, not a caret. */
/**
 * Waits on a condition, not on a window of real time: `check` is tried again after each turn of
 * the event loop (which lets the Home under test run its own work) until it passes. Its only
 * bound is the test's own timeout; once the test has ended it stops.
 */
export async function until<T>(check: () => T | Promise<T>): Promise<T> {
  let ended = false;
  onTestFinished(() => {
    ended = true;
  });
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (ended) throw error;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

export async function editVisibly(
  attached: { handle(data: Buffer, binary: boolean): Promise<void> },
  watching: { readonly frames: Buffer[]; next(count: number): Promise<void> },
  tabId: string,
  value: () => Promise<string>,
  rendered: () => Promise<unknown>,
) {
  // Every wait here is on the stream or the page itself, never on a window of real time, so a
  // slow machine takes longer and still sees what a fast one does.
  const { frames } = watching;
  const subscribe = (type: "stream.subscribe" | "stream.unsubscribe") =>
    attached.handle(Buffer.from(JSON.stringify({ type, surfaceId: tabId })), false);
  await subscribe("stream.subscribe");
  await watching.next(0);
  expect(await greenAt(frames[0]!, tabId)).toBe(false);
  const key = {
    type: "input.key",
    surfaceId: tabId,
    key: "x",
    code: "KeyX",
    modifiers: [],
    text: "x",
  };
  await attached.handle(Buffer.from(JSON.stringify({ ...key, action: "down" })), false);
  await attached.handle(Buffer.from(JSON.stringify({ ...key, action: "up" })), false);
  // The key lands when the page has handled it: read again after each of its own frames.
  while ((await value()) !== '["unsent draftx",99]') await rendered();
  expect(await value()).toBe('["unsent draftx",99]');
  // A fresh frame is asked for until one shows the page's own colour change: on a slow machine
  // the first may have been taken before the compositor had it.
  let green = false;
  while (!green) {
    await rendered();
    await subscribe("stream.unsubscribe");
    const count = frames.length;
    await subscribe("stream.subscribe");
    await watching.next(count);
    const results = await Promise.all(frames.slice(count).map((frame) => greenAt(frame, tabId)));
    green = results.includes(true);
  }
  expect(green).toBe(true);
}
