import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { expect, it, vi } from "vitest";
import { PlaywrightChromiumLauncher } from "../apps/browser-runtime/src/browser/playwright-launcher.js";
import { PublicBrowserEgressProxy } from "../apps/browser-runtime/src/egress-proxy.js";
import {
  startPersonalRuntime,
  type PersonalRuntime,
} from "../apps/host/src/runtime/personal-startup.test-support.js";
import {
  BrowserRuntime,
  BrowserRuntimeServer,
  Ed25519AttachTicketVerifier,
} from "../packages/browser-runtime-core/src/index.js";
import { startAccountSignIn } from "../packages/client/src/host/harness-authentication.js";
import {
  HttpHostClient,
  type WebSocketClient,
} from "../packages/client/src/host/host-session-client.js";
import { createId, type TabId } from "../packages/core/src/index.js";
import { AgentConnectionStore } from "../packages/database/src/agent-connection-store.js";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "../packages/database/src/test-database.test-support.js";
import {
  HarnessRegistry,
  type HarnessAuthenticationResult,
  type HarnessAuthenticationSelection,
  type HarnessAuthenticationStart,
  type HarnessInspectionResult,
  type HarnessInspectionContext,
} from "../packages/harness/src/index.js";
import { CodexHarnessDriver } from "../packages/harness-codex/src/index.js";
import {
  hostApiVersion,
  hostApiVersionHeader,
} from "../packages/deployment-authority/src/index.js";
import { waitForBrowserFrame } from "./browser-sessions.test-support.js";

const loopbackSignIn = "fixture-loopback";
const replacementSignIn = "fixture-replacement";
const externalSignIn = "fixture-external";
const setupMethods = [loopbackSignIn, replacementSignIn, externalSignIn].map((methodId) => ({
  kind: "browser-code" as const,
  label: methodId,
  methodId,
}));

// Keep the Runner suite's fake Codex app-server for engine preparation. Only
// the authentication methods differ so the fixture can exercise a browser callback.
class LoopbackSignInEngine extends CodexHarnessDriver {
  readonly callbacks: URL[] = [];
  readonly #listeners = new Set<Server>();
  readonly #provider: URL;
  #ready = false;

  constructor(provider: URL) {
    super({
      launch: {
        executable: process.execPath,
        arguments: [resolve("packages/harness-codex/src/test-fixtures/fake-codex-app-server.mjs")],
      },
    });
    this.#provider = provider;
  }

  override async inspect(context: HarnessInspectionContext): Promise<HarnessInspectionResult> {
    if (!this.#ready)
      return { status: "authentication-required", detail: "Sign in to the fixture", setupMethods };
    const signedIn = await super.inspect(context);
    return signedIn.status === "ready" ? { ...signedIn, setupMethods } : signedIn;
  }

  override async authenticate(
    _context: Parameters<CodexHarnessDriver["authenticate"]>[0],
    selection: HarnessAuthenticationSelection,
  ): Promise<HarnessAuthenticationStart> {
    this.#ready = false;
    const state = randomUUID();
    const result = Promise.withResolvers<HarnessAuthenticationResult>();
    const listener = createServer((request, response) => {
      const callback = new URL(request.url ?? "/", "http://127.0.0.1");
      if (
        callback.pathname !== "/oauth-callback" ||
        callback.searchParams.get("state") !== state ||
        callback.searchParams.get("code") !== "fixture-code"
      ) {
        response.writeHead(400).end();
        return;
      }
      this.callbacks.push(callback);
      this.#ready = true;
      response.end("Signed in");
      result.resolve({ status: "ready" });
    });
    this.#listeners.add(listener);
    listener.once("close", () => this.#listeners.delete(listener));
    const origin = await listen(listener);
    const redirect = new URL(
      "/oauth-callback",
      selection.methodId === externalSignIn ? "https://client.invalid" : origin,
    );
    redirect.searchParams.set("state", state);
    const authorization = new URL("/authorize", this.#provider);
    authorization.searchParams.set("redirect_uri", redirect.href);
    return {
      status: "pending",
      challenge: {
        kind: "browser-code",
        authorizationUrl: authorization.href,
        inputPrompt: "Finish the fixture sign-in",
      },
      result: result.promise,
      cancel: async () => {
        result.resolve({ status: "failed", detail: "Fixture sign-in cancelled" });
        await closeServer(listener);
      },
    };
  }

  async close(): Promise<void> {
    await Promise.all([...this.#listeners].map(closeServer));
  }
}

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "finishes an engine loopback sign-in from a remote Home client and retires its browser tab",
  async () => {
    const { client, engine, stack, runnerId, runtimeId, runtime } = await startSignInHome(true);
    const browserRuntime = required(runtime);
    const target = {
      environmentId: stack.environmentId,
      harnessInstanceId: stack.harnessInstanceId,
    };
    const ownerId = client.getSnapshot().user?.id;
    if (!ownerId) throw new Error("Home did not authenticate the viewer");
    expect(
      client.getSnapshot().environments.find(({ id }) => id === target.environmentId),
    ).toMatchObject({
      runnerId,
      harnessAuthenticationAllowed: true,
    });
    expect(stack.host.browser.resourcePlacements([runnerId])).toEqual([
      expect.objectContaining({ runnerId, available: true }),
    ]);
    const tabs = async () => successful(await stack.api["tabs.state"]({})).tabs;
    expect(await tabs()).toEqual([]);
    const personalProfile = await stack.host.browser.createProfile({
      homeRunnerId: runnerId,
      ownerId,
      name: "AI engine sign-in",
      idempotencyKey: randomUUID(),
    });

    const flow = startAccountSignIn({
      client,
      target: { kind: "existing", ...target },
      localRunnerId: createId("runner"),
      errorMessage: (error) => String(error),
      selectMethod: () => loopbackSignIn,
    });
    await expect
      .poll(() => flow.getState())
      .toMatchObject({
        kind: "signing-in",
        session: { view: { kind: "pending", returnsToComputer: true } },
        homeBrowser: { tabId: null, opening: false },
      });
    const tabId = required(await flow.openHomeBrowser());
    expect(await browse(stack)).toBe(tabId);
    const opened = await tabs();
    expect(opened).toEqual([
      expect.objectContaining({
        tabId,
        kind: "page",
        state: "open",
        openedBy: "person",
        profile: expect.objectContaining({ name: "AI engine sign-in" }),
      }),
    ]);
    const profileId = required(opened[0]?.profile?.profileId);
    expect(profileId).not.toBe(personalProfile.id);
    expect(await stack.host.browser.listProfiles(ownerId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: profileId,
          name: "AI engine sign-in",
          purpose: "engine-sign-in",
          home: expect.objectContaining({ runnerId }),
        }),
      ]),
    );
    await expect(
      new AgentConnectionStore(stack.host.store.database).create({
        userId: ownerId,
        label: "Fixture connected agent",
        clientName: "Fixture client",
        resource: stack.hostOrigin.href,
        accessMode: "auto",
        expiresAt: new Date(Date.now() + 60_000),
        grant: {
          scope: "selected",
          tasks: false,
          resources: [{ kind: "browser-profile", profileId }],
        },
      }),
    ).rejects.toMatchObject({ reason: "engine-sign-in-profile" });

    const activate = async (id: TabId) => {
      const viewer = await client.activateTab(id);
      if (viewer.kind !== "page") throw new Error("The sign-in tab has no browser viewer");
      const surface = required(browserRuntime.presentSurface(viewer.sessionId, viewer.surfaceId));
      surface.release();
      expect(surface.page.isClosed()).toBe(false);
      return { ...viewer, page: surface.page };
    };
    const viewer = await activate(tabId);
    expect(
      await stack.host.store.getBrowserSessionForOwner(viewer.sessionId, ownerId),
    ).toMatchObject({
      profileId,
      runnerId,
      runtimeId,
    });
    await clickFromViewer(stack, viewer, () =>
      expect
        .poll(() => engine.callbacks.map((url) => url.pathname), { timeout: 5_000 })
        .toEqual(["/oauth-callback"]),
    );
    await expect
      .poll(
        async () =>
          successful(await stack.api["harness.authentication.get"](target)).authentication.status,
      )
      .toBe("ready");
    await expect.poll(() => flow.getState(), { timeout: 5_000 }).toMatchObject({ kind: "done" });
    const closed = (viewer: Awaited<ReturnType<typeof activate>>) =>
      expect.poll(() => viewer.page.isClosed()).toBe(true);
    await expect.poll(tabs).toEqual([]);
    await closed(viewer);

    await begin(stack, loopbackSignIn);
    const cancelled = await activate(await browse(stack));
    await cancel(stack);
    await expect.poll(tabs).toEqual([]);
    await closed(cancelled);

    await begin(stack, loopbackSignIn);
    const replaced = await activate(await browse(stack));
    await begin(stack, replacementSignIn);
    const replacement = await activate(await browse(stack));
    expect(replacement.surfaceId).not.toBe(replaced.surfaceId);
    await expect
      .poll(async () => (await tabs()).map((tab) => tab.tabId))
      .toEqual([replacement.surfaceId]);
    await closed(replaced);
    await cancel(stack);
    await expect.poll(tabs).toEqual([]);
    await closed(replacement);

    await begin(stack, loopbackSignIn);
    const nativeSetTimeout = globalThis.setTimeout;
    const signInExpiryTimers: (() => void)[] = [];
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: (...args: unknown[]) => void,
      timeout?: number,
      ...args: unknown[]
    ) => {
      const timer = nativeSetTimeout(handler, timeout, ...args);
      if (typeof timeout === "number" && timeout >= 14 * 60_000 && timeout <= 15 * 60_000) {
        signInExpiryTimers.push(() => {
          clearTimeout(timer);
          handler(...args);
        });
      }
      return timer;
    }) as typeof setTimeout);
    let expiringTabId: TabId;
    try {
      expiringTabId = await browse(stack);
    } finally {
      setTimeoutSpy.mockRestore();
    }
    expect(signInExpiryTimers).toHaveLength(1);
    const expiring = await activate(expiringTabId);
    expect((await tabs()).map((tab) => tab.tabId)).toEqual([expiring.surfaceId]);
    // Fire only the sign-in tab's deadline timer so real Runner and browser lease timers stay intact.
    signInExpiryTimers[0]!();
    await expect.poll(tabs).toEqual([]);
    await closed(expiring);
    await cancel(stack);

    await begin(stack, externalSignIn);
    expect(await browseCommand(stack)).toMatchObject({
      ok: false,
      error: { code: "conflict", message: expect.stringContaining("finishes on your own device") },
    });
    expect(await tabs()).toEqual([]);
    await cancel(stack);
  },
);

it.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL)(
  "refuses to browse a loopback challenge when the engine Runner offers no browser",
  async () => {
    const { stack, runnerId } = await startSignInHome(false);
    expect(stack.host.browser.resourcePlacements([runnerId])).toEqual([]);
    await begin(stack, loopbackSignIn);
    expect(await browseCommand(stack)).toMatchObject({
      ok: false,
      error: { code: "conflict", reason: "harness-sign-in-browser-unavailable" },
    });
    expect(successful(await stack.api["tabs.state"]({})).tabs).toEqual([]);
    await cancel(stack);
  },
);

async function startSignInHome(withBrowser: boolean) {
  const database = await cloneTestDatabase("host");
  const scratch = await mkdtemp(join(tmpdir(), "opensteer-engine-sign-in-"));
  const provider = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const redirect = url.searchParams.get("redirect_uri");
    if (!redirect) {
      response.writeHead(400).end();
    } else if (url.pathname === "/approve") {
      const callback = new URL(redirect);
      callback.searchParams.set("code", "fixture-code");
      response.writeHead(302, { location: callback.href }).end();
    } else {
      const approve = `/approve?redirect_uri=${encodeURIComponent(redirect)}`;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`
        <title>Fixture authorization</title>
        <style>body { height: 100vh; margin: 0; display: grid; place-items: center }</style>
        <button onclick="location.href='${approve}'">Approve engine sign-in</button>
      `);
    }
  });
  const runnerId = createId("runner");
  const runtimeId = "engine-runner-browser";
  const bridgeToken = randomBytes(32).toString("base64url");
  return ownTestDatabaseProducer(database.url, async () => {
    let engine: LoopbackSignInEngine | undefined;
    let stack: PersonalRuntime | undefined;
    let client: HttpHostClient | undefined;
    let runtime: BrowserRuntime | undefined;
    let browserServer: BrowserRuntimeServer | undefined;
    let proxy: PublicBrowserEgressProxy | undefined;
    const close = async () => {
      client?.dispose();
      try {
        await Promise.all([
          stack?.close(),
          engine?.close(),
          browserServer?.close(),
          closeServer(provider),
        ]);
      } finally {
        await proxy?.close();
        await rm(scratch, { recursive: true, force: true });
      }
    };
    try {
      engine = new LoopbackSignInEngine(await listen(provider));
      let browser: { bridgeToken: string; runtimeId: string; url: URL } | undefined;
      if (withBrowser) {
        // Mirror the Linux Home's bridge-only Chromium, including its public-network
        // proxy and local bypass. Chromium and the engine share the Runner's loopback.
        proxy = new PublicBrowserEgressProxy({ port: 0 });
        const proxyAddress = await proxy.start();
        let keys: readonly { keyId: string; publicKeyPem: string }[] = [];
        runtime = new BrowserRuntime({
          launcher: new PlaywrightChromiumLauncher({
            headless: true,
            chromiumSandbox: false,
            executablePath: chromium.executablePath(),
            proxyUrl: `http://${proxyAddress.host}:${proxyAddress.port}`,
            preserveLoopbackBypass: true,
          }),
          localProfiles: { root: join(scratch, "profiles") },
          runtimeId,
          sessionFilesRoot: join(scratch, "files"),
          ticketVerifier: await Ed25519AttachTicketVerifier.create({
            replayLedgerPath: join(scratch, "private", "replay.json"),
            resolvePublicKey: (id) => keys.find((key) => key.keyId === id)?.publicKeyPem ?? null,
          }),
        });
        browserServer = new BrowserRuntimeServer({
          port: 0,
          relayBridge: {
            token: bridgeToken,
            updateAttachKeys: (next) => {
              keys = next;
            },
          },
          runtime,
        });
        const address = await browserServer.start();
        browser = {
          bridgeToken,
          runtimeId,
          url: new URL(`http://${address.host}:${address.port}`),
        };
      }
      const harnesses = new HarnessRegistry();
      harnesses.registerDriver(engine);
      const active = await startPersonalRuntime({
        databaseUrl: database.url,
        agentHome: { computerId: runnerId, path: join(scratch, "workspace") },
        ...(browser ? { browser } : {}),
        vertical: {
          databaseUrl: database.url,
          harnesses,
          harnessInstance: {
            config: {},
            driverKind: "codex",
            sourceId: "openai",
            stateKind: "isolated",
          },
          catalogTimeoutMs: 10_000,
          runTimeoutMs: 15_000,
        },
      });
      stack = active;
      client = new HttpHostClient({
        baseUrl: active.hostOrigin,
        fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("cookie", active.sessionCookie);
          headers.set("origin", active.hostOrigin.origin);
          return fetch(input, { ...init, headers });
        },
        webSocketFactory: (url) =>
          new WebSocket(url, { headers: viewerHeaders(active) }) as unknown as WebSocketClient,
      });
      client.watchPersonalResource("harness-catalog", () => {});
      await client.load();
      await expect
        .poll(() => client?.getSnapshot().session, { timeout: 5_000 })
        .toBe("authenticated");
      await expect
        .poll(
          () =>
            client?.getSnapshot().environments.find(({ id }) => id === active.environmentId)
              ?.harnessCatalogs,
        )
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              harnessInstanceId: active.harnessInstanceId,
              status: "authentication-required",
            }),
          ]),
        );
      return { stack, client, engine, runnerId, runtimeId, runtime, close };
    } catch (error) {
      await close();
      throw error;
    }
  });
}

async function clickFromViewer(
  stack: PersonalRuntime,
  { sessionId, surfaceId }: { readonly sessionId: string; readonly surfaceId: string },
  waitForCallback: () => Promise<void>,
) {
  const socket = new WebSocket(
    new URL(`/v1/browser-sessions/${sessionId}/connect`, stack.hostOrigin),
    { headers: viewerHeaders(stack) },
  );
  try {
    await once(socket, "open", { signal: AbortSignal.timeout(5_000) });
    const frame = waitForBrowserFrame(socket, true);
    socket.send(JSON.stringify({ type: "stream.subscribe", surfaceId }));
    const { header } = await frame;
    expect(header.surfaceId).toBe(surfaceId);
    for (const action of ["down", "up"] as const) {
      socket.send(
        JSON.stringify({
          action,
          button: "left",
          clickCount: 1,
          surfaceId,
          type: "input.pointer",
          viewportHeight: header.viewportHeight,
          viewportWidth: header.viewportWidth,
          x: 0.5,
          y: 0.5,
        }),
      );
    }
    await waitForCallback();
  } finally {
    socket.close();
  }
}

function viewerHeaders(stack: PersonalRuntime) {
  return {
    cookie: stack.sessionCookie,
    origin: stack.hostOrigin.origin,
    [hostApiVersionHeader]: String(hostApiVersion),
  };
}

function dispatchBase(stack: PersonalRuntime) {
  return {
    environmentId: stack.environmentId,
    harnessInstanceId: stack.harnessInstanceId,
    idempotencyKey: randomUUID(),
  };
}

async function begin(stack: PersonalRuntime, methodId: string) {
  expect(
    successful(
      await stack.api["commands.dispatch"]({
        ...dispatchBase(stack),
        methodId,
        type: "harness.authentication.begin",
      }),
    ),
  ).toMatchObject({ authentication: { status: "pending" } });
}

function browseCommand(stack: PersonalRuntime) {
  return stack.api["commands.dispatch"]({
    ...dispatchBase(stack),
    type: "harness.authentication.browse",
  });
}

async function browse(stack: PersonalRuntime): Promise<TabId> {
  const result = successful(await browseCommand(stack));
  if (result.type !== "harness.authentication.browse") throw new Error("Browse command mismatch");
  return result.tabId;
}

async function cancel(stack: PersonalRuntime) {
  successful(
    await stack.api["commands.dispatch"]({
      ...dispatchBase(stack),
      type: "harness.authentication.cancel",
    }),
  );
}

function successful<T>(result: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data;
}

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected a value from the Home");
  return value;
}

async function listen(server: Server): Promise<URL> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
